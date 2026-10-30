/**
 * `infinibot robovoice …` — link this InfiniBot install to a Robovoice
 * organization and hold Robovoice-powered voice calls with its agents.
 *
 *   login [--api <url>] [--no-open]      device-code sign-in → location + device + agents
 *   logout [--keep-device]               unlink the device, revoke the token, forget creds
 *   status [--json] [--offline]          link, org, location, device, agents
 *   agents [--json]                      InfiniBot agents and their Robovoice characters
 *   link <agent> [--character <id> | --create] [--voice <id>] [--tts <provider>] [--language <code>] [--name <n>]
 *   unlink [agent]                       no agent: retire the device (location stays); agent: detach it
 *   call <agent> [--local | --cloud] [--open] [--no-wait] [--json]
 *   sync                                 re-sync linked agents (persona, voice, MCP binding)
 *   mcp [--url <public gateway url> | --off]   per-agent tool access for calls
 */

import type { Command } from "commander";

import type { CallStart } from "./edge-api.js";
import { MCP_ROUTE, openInBrowser, type LinkSummary, type RobovoiceLinkService } from "./link.js";

type Logger = { info: (m: string) => void; warn: (m: string) => void; error: (m: string) => void };

const out = (s = "") => process.stdout.write(`${s}\n`);
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const fmt = (n: number | undefined) => (n === undefined ? "?" : n.toLocaleString("en-US"));

export function printSummary(s: LinkSummary): void {
  out(`Robovoice      ${s.apiBase}`);
  if (!s.signedIn && !s.org) {
    out("Link           not linked — run `infinibot robovoice login`");
    return;
  }
  out(`Link           ${s.linked ? "linked" : s.unlinkedAt ? `unlinked ${s.unlinkedAt} (device retired; location kept in the org)` : s.signedIn ? "signed in, not linked" : "signed out"}`);
  if (s.org) out(`Organization   ${s.org.name}${s.userEmail ? ` (${s.userEmail})` : ""}`);
  if (s.location) out(`Location       ${s.location.name ?? s.location.id}${s.location.dashboardUrl ? `  ${s.location.dashboardUrl}` : ""}`);
  if (s.device) out(`Device         ${s.device.name ?? s.device.id} [${s.device.id}]${s.device.state ? ` · ${s.device.state}` : ""}`);
  out("Cloud voice    free (local voice stays the default)");
  if (s.agents.length) {
    out("Agents");
    for (const a of s.agents)
      out(`  ${a.agentId.padEnd(16)} ${a.name.padEnd(18)} ${a.characterId ? `→ ${a.characterId}${a.managed ? "" : " (linked)"}` : "→ (not synced)"}${a.error ? `  ! ${a.error}` : ""}`);
  }
  if (s.mcp?.status) out(`Agent tools    ${s.mcp.status}${s.mcp.url ? ` via ${s.mcp.url}` : ""}${s.mcp.error ? ` — ${s.mcp.error}` : ""}`);
  if (!s.secretsEncrypted) out("Warning        credentials are stored unencrypted (no install key)");
  if (s.remoteError) out(`Note           ${s.remoteError}`);
}

export function registerRobovoiceCli(params: {
  program: Command;
  service: () => RobovoiceLinkService;
  personas: () => Array<{ id: string; name: string; description?: string }>;
  logger: Logger;
}) {
  const { program } = params;
  const svc = params.service;
  const run =
    <A extends unknown[]>(fn: (...a: A) => Promise<unknown>) =>
    async (...a: A): Promise<void> => {
    try {
      await fn(...a);
    } catch (e) {
      params.logger.error(`robovoice: ${errMsg(e)}`);
      process.exitCode = 1;
    }
  };

  const root = program
    .command("robovoice")
    .description("Robovoice voice: link this install to a Robovoice org, call your agents");

  root
    .command("login")
    .description("Sign in to Robovoice (browser-approved code) and link this install as a location")
    .option("--api <url>", "Robovoice URL (default: https://robovoice.io or ROBOVOICE_API)")
    .option("--no-open", "Don't open the approval page in a browser")
    .option("--json", "JSON output")
    .action(
      run(async (opts: { api?: string; open?: boolean; json?: boolean }) => {
        const s = svc();
        const { apiBase, start } = await s.startLogin(opts.api);
        out(`To link this InfiniBot to Robovoice, approve this code in a signed-in browser:`);
        out(`  ${start.user_code}`);
        out(`  ${start.verification_uri_complete}`);
        if (opts.open !== false) openInBrowser(start.verification_uri_complete);
        out(`Waiting for approval (expires in ${Math.round(start.expires_in / 60)} min)…`);
        const token = await s.waitForLogin(apiBase, start);
        out(`Approved for ${token.org.name}. Linking…`);
        const summary = await s.completeLogin(apiBase, token);
        if (opts.json) return out(JSON.stringify(summary, null, 2));
        printSummary(summary);
      }),
    );

  root
    .command("logout")
    .description("Retire this install's device, revoke the Robovoice sign-in and forget local credentials")
    .option("--keep-device", "Keep the device registered (only forget the sign-in)")
    .action(
      run(async (opts: { keepDevice?: boolean }) => {
        const r = await svc().logout({ keepDevice: opts.keepDevice });
        out(`Signed out${r.unlinked ? "; device retired (location kept)" : ""}${r.tokenRevoked ? "; token revoked" : ""}.`);
        if (r.error) out(`Note: ${r.error}`);
      }),
    );

  root
    .command("status")
    .description("Link, organization, location, device and agents")
    .option("--json", "JSON output")
    .option("--offline", "Local state only (don't call Robovoice)")
    .action(
      run(async (opts: { json?: boolean; offline?: boolean }) => {
        const s = await svc().status({ remote: !opts.offline });
        if (opts.json) return out(JSON.stringify(s, null, 2));
        printSummary(s);
      }),
    );

  root
    .command("agents")
    .description("InfiniBot agents and their Robovoice characters")
    .option("--json", "JSON output")
    .action(
      run(async (opts: { json?: boolean }) => {
        const settings = svc().store.get();
        const linked = new Set(settings.linkedAgents ?? (settings.link ? ["main"] : []));
        const rows = params.personas().map((p) => ({
          agentId: p.id,
          name: settings.agentOverrides[p.id]?.name ?? p.name,
          linked: linked.has(p.id),
          characterId: settings.linkedCharacters[p.id]?.characterId ?? settings.characterMap[p.id] ?? null,
          managed: settings.linkedCharacters[p.id]?.managed ?? null,
        }));
        if (opts.json) return out(JSON.stringify(rows, null, 2));
        for (const r of rows)
          out(`${r.linked ? "●" : "○"} ${r.agentId.padEnd(18)} ${r.name.padEnd(20)} ${r.characterId ? `→ ${r.characterId}${r.managed === false ? " (linked)" : ""}` : ""}`);
        out(`\n● = in the Robovoice location. Add one: infinibot robovoice link <agent>`);
      }),
    );

  root
    .command("link <agent>")
    .description("Give an InfiniBot agent a Robovoice character at this install's location")
    .option("--character <id>", "Attach to an existing Robovoice character instead of creating one")
    .option("--create", "Create (or keep) an InfiniBot-managed character (default)")
    .option("--voice <id>", "TTS voice id (e.g. af_heart, or an ElevenLabs voice id with --tts elevenlabs)")
    .option("--tts <provider>", "TTS provider: kokoro | elevenlabs | piper | …")
    .option("--language <code>", "Language code, e.g. en, he, es")
    .option("--name <name>", "Display name for the character")
    .action(
      run(async (agent: string, opts: { character?: string; create?: boolean; voice?: string; tts?: string; language?: string; name?: string }) => {
        if (opts.character && opts.create) throw new Error("use either --character or --create");
        const r = await svc().linkAgent(agent, {
          characterId: opts.character,
          create: opts.create,
          override: { voice: opts.voice, ttsProvider: opts.tts, language: opts.language, name: opts.name },
        });
        const res = r.results.find((x) => x.agent_id === agent);
        if (!res?.ok) throw new Error(res?.error ?? "sync failed");
        out(`${agent} → Robovoice character ${res.character_id} at ${r.location.name}`);
        if (r.mcp?.status && r.mcp.status !== "off") out(`Agent tools: ${r.mcp.status}${r.mcp.error ? ` — ${r.mcp.error}` : ""}`);
      }),
    );

  root
    .command("unlink [agent]")
    .description("Without an agent: retire this install's device (the location stays). With one: detach that agent")
    .action(
      run(async (agent?: string) => {
        if (agent) {
          await svc().unlinkAgent(agent);
          out(`${agent} detached from the Robovoice location (its character stays in Robovoice).`);
          return;
        }
        const r = await svc().unlink();
        out(`Device ${r.deviceRevoked ?? ""} retired. The location stays in your Robovoice org; \`infinibot robovoice login\` relinks it.`);
      }),
    );

  root
    .command("sync")
    .description("Re-sync linked agents (persona, voice, language, MCP binding)")
    .action(
      run(async () => {
        const r = await svc().sync();
        for (const x of r.results) out(`${x.ok ? "✓" : "✗"} ${x.agent_id}${x.character_id ? ` → ${x.character_id}` : ""}${x.error ? `  ${x.error}` : ""}`);
        out(`Location: ${r.location.name} · agent tools: ${r.mcp.status}${r.mcp.error ? ` (${r.mcp.error})` : ""}`);
        if (!r.ok) process.exitCode = 1;
      }),
    );

  root
    .command("mcp")
    .description("Per-agent InfiniBot tools on calls: the public URL Robovoice reaches this gateway on")
    .option("--url <url>", `Public base URL of this gateway (Robovoice calls <url>${MCP_ROUTE})`)
    .option("--off", "Stop binding agent tools (tokens are revoked)")
    .action(
      run(async (opts: { url?: string; off?: boolean }) => {
        const s = svc();
        if (opts.off) {
          s.store.update({ mcpPublicUrl: undefined });
          s.store.revokeMcpTokens();
        } else if (opts.url) {
          const u = new URL(opts.url);
          if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("URL must be http(s)");
          s.store.update({ mcpPublicUrl: `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, "")}` });
        } else {
          const cur = s.store.get().mcpPublicUrl;
          out(cur ? `Agent tools bind to ${cur}${MCP_ROUTE}` : "Agent tools are off (set --url <public gateway url>).");
          return;
        }
        if (s.store.get().link && !s.store.get().link?.unlinkedAt) {
          const r = await s.sync();
          out(`Agent tools: ${r.mcp.status}${r.mcp.error ? ` — ${r.mcp.error}` : ""}`);
        } else out("Saved; applied on the next `infinibot robovoice login`.");
      }),
    );

  root
    .command("call <agent>")
    .description("Start a Robovoice call with an InfiniBot agent; waits for it to end and prints the minutes used")
    .option("--local", "Use Robovoice Desktop's local pipeline")
    .option("--cloud", "Use Robovoice cloud (web call link)")
    .option("--open", "Open the call page in your browser")
    .option("--no-wait", "Print the call and exit without waiting")
    .option("--json", "JSON output")
    .action(
      run(async (agent: string, opts: { local?: boolean; cloud?: boolean; open?: boolean; wait?: boolean; json?: boolean }) => {
        if (opts.local && opts.cloud) throw new Error("use either --local or --cloud");
        const s = svc();
        const mode = opts.local ? "local" : opts.cloud ? "cloud" : "auto";
        const call: CallStart & { fellBackToCloud?: boolean } = await s.startCall(agent, { mode });
        if (call.mode === "cloud") {
          out(`Call ${agent} (Robovoice cloud${call.fellBackToCloud ? "; no Robovoice Desktop online" : ""}):`);
          out(`  ${call.url}`);
          if (opts.open && call.url) openInBrowser(call.url);
        } else {
          out(`Call ${agent} on Robovoice Desktop "${call.device?.name}" (local pipeline) — the Desktop app starts the call.`);
        }
        if (opts.wait === false) {
          if (opts.json) out(JSON.stringify(call, null, 2));
          return;
        }
        out("Waiting for the call to connect… (Ctrl-C to stop watching)");
        const ctrl = new AbortController();
        const onSig = () => ctrl.abort();
        process.once("SIGINT", onSig);
        let lastPhase = "";
        const r = await s
          .waitForCall(call, {
            signal: ctrl.signal,
            onUpdate: (st, phase) => {
              if (phase !== lastPhase) {
                lastPhase = phase;
                if (phase === "live") out("Connected — call is live.");
              }
            },
          })
          .finally(() => process.off("SIGINT", onSig));
        const summary = {
          agent,
          mode: call.mode,
          room: call.room,
          connected: r.connected,
          duration_s: Math.round(r.durationMs / 1000),
          billable_seconds: r.status.usage.billable_seconds,
        };
        if (opts.json) return out(JSON.stringify(summary, null, 2));
        if (!r.connected) {
          out("The call never connected (open the link to talk).");
          return;
        }
        out(`Call ended after ${summary.duration_s}s · ${fmt(summary.billable_seconds)} s of conversation (free)`);
      }),
    );
}
