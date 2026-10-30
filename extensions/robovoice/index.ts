import fs from "node:fs";
import path from "node:path";
import type { GatewayRequestHandler, InfiniBotPluginApi } from "infinibot/plugin-sdk";
import {
  decryptInstallSecret,
  encryptInstallSecret,
  listAgentPersonas,
  resolveSelfCallAuthHeaders,
} from "infinibot/plugin-sdk";

import { handleAgentMcpHttp } from "./src/agent-mcp.js";
import { registerRobovoiceCli } from "./src/cli.js";
import { MCP_ROUTE, RobovoiceLinkService } from "./src/link.js";
import { handleMcpHttp } from "./src/mcp.js";
import {
  assertOrgCharacter,
  clearIssuesPatch,
  configIssues,
  linkState,
  linkedCharacterFor,
  OrgRoster,
  requireLinked,
  type LinkedContext,
} from "./src/link-guard.js";
import { agentForRequest, clientFor, createRobovoiceProvider, probeClient, relevantPipelines } from "./src/provider.js";
import { RobovoiceEdgeApi } from "./src/edge-api.js";
import { assessRobovoiceSafety } from "./src/safety.js";
import {
  DEFAULT_MCP_TOOLS,
  RobovoiceSettingsStore,
  robovoiceDataDir,
  type RobovoiceSettings,
  type SecretCipher,
} from "./src/settings.js";
import { createRobovoiceCallTool, ROBOVOICE_TOOL_NAME } from "./src/tool.js";
import { registerSpeechRpcs } from "./src/speech-rpc.js";
import { registerVoicePipelineRpcs } from "./src/voice-pipeline-rpc.js";
import { cleanSessionKey, handleVoiceLlmHttp, OperatorCalls, VOICE_LLM_ROUTE, VoiceLlmStats } from "./src/voice-llm.js";

function isRecord(v: unknown): v is Record<string, unknown> {
  return Boolean(v && typeof v === "object" && !Array.isArray(v));
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Settings the UI / RPC may write. The device, location and org come from the
 * Robovoice link only (login → link), never from a settings patch.
 */
const SETTINGS_KEYS: ReadonlyArray<keyof RobovoiceSettings> = [
  "deployment",
  "baseUrl",
  "expressive",
  "defaultCharacterId",
  "characterMap",
  "wakeWord",
  "mcpTools",
  "mcpPublicUrl",
  "pipelineLocationId",
  "ownerCallerEmails",
];

/** Install-key encryption (the host's shared secret store); null when unavailable. */
const installCipher: SecretCipher = {
  encrypt: (plain) => encryptInstallSecret(plain),
  decrypt: (blob) => decryptInstallSecret(blob),
};

/**
 * Install-wide plugin data dir `<sharedDir>/plugin-data/robovoice` (the host's
 * per-plugin data dir, so Setup › Plugins › Data sizes/exports/clears it).
 * Older builds used `<sharedDir|stateDir>/plugins/robovoice` or the per-profile
 * `<stateDir>/plugin-data/robovoice`; the first one found is carried over once.
 */
function pluginDir(api: InfiniBotPluginApi): string {
  const state = api.runtime.state;
  const sharedRoot = (state.resolveSharedDir ?? state.resolveStateDir)();
  const dir = robovoiceDataDir(sharedRoot);
  const profileDir = path.join(state.resolveStateDir(), "plugin-data", "robovoice");
  const legacy = [path.join(state.resolveStateDir(), "plugins", "robovoice"), profileDir].filter(
    (d) => d !== dir,
  );
  if (!fs.existsSync(dir)) {
    const from = legacy.find((d) => fs.existsSync(d));
    if (from) {
      try {
        fs.cpSync(from, dir, { recursive: true });
      } catch {
        // keep going with an empty dir
      }
    }
  }
  return dir;
}

const plugin = {
  id: "robovoice",
  name: "Robovoice",
  description:
    "Robovoice voice provider: characters, pipelines and LiveKit sessions from a self-hosted Robovoice stack or Robovoice cloud.",
  register(api: InfiniBotPluginApi) {
    const legacyUrl =
      process.env.ROBOVOICE_URL?.trim() ||
      ((api.config as { voice?: { robovoiceUrl?: string } }).voice?.robovoiceUrl ?? "").trim() ||
      undefined;
    const dataDir = pluginDir(api);
    const store = new RobovoiceSettingsStore(
      dataDir,
      isRecord(api.pluginConfig) ? api.pluginConfig : {},
      legacyUrl,
      process.env,
      installCipher,
    );
    // Calls the operator started from this install (owner trust for their
    // turns). Persisted so a gateway restart mid-call does not demote the owner.
    const operatorCallsFile = path.join(dataDir, "operator-calls.json");
    const operatorCalls = new OperatorCalls(undefined, undefined, {
      load: () => (fs.existsSync(operatorCallsFile) ? JSON.parse(fs.readFileSync(operatorCallsFile, "utf8")) : []),
      save: (calls) => {
        fs.mkdirSync(dataDir, { recursive: true });
        fs.writeFileSync(operatorCallsFile, JSON.stringify(calls), { mode: 0o600 });
      },
    });
    // One cache of the linked org's agents: sessions, the mapping UI and config
    // validation all check characters against the same roster.
    const orgRoster = new OrgRoster();
    const edgeApiFor = (ctx: LinkedContext) => new RobovoiceEdgeApi(ctx.apiBase, ctx.edgeToken, { version: api.version });
    const rosterFor = (ctx: LinkedContext) => orgRoster.get(ctx, edgeApiFor(ctx));
    const baseProvider = createRobovoiceProvider(store, { roster: orgRoster, edgeApi: edgeApiFor });
    // Every LiveKit session this provider mints goes to an authenticated
    // operator (gateway voice RPCs, /plugins/robovoice/connection-details behind
    // the auth gate): the room it names is an operator call.
    const provider: typeof baseProvider = {
      ...baseProvider,
      createRealtimeSession: async (req) => {
        const session = await baseProvider.createRealtimeSession!(req);
        operatorCalls.joined(session.room, { agentId: req.agentId, characterId: session.characterId });
        return session;
      },
    };
    api.registerVoiceProvider(provider);

    const personas = () => {
      try {
        return listAgentPersonas(api.config);
      } catch {
        // No invented agents: an unreadable agent config lists none.
        return [];
      }
    };
    let linkService: RobovoiceLinkService | null = null;
    const service = () =>
      (linkService ??= new RobovoiceLinkService({ store, personas, version: api.version }));

    const settingsView = () => {
      const settings = store.get();
      return {
        settings,
        secrets: store.secretState(),
        secretsEncrypted: store.secretsEncrypted(),
        legacyUrl: legacyUrl ?? null,
      };
    };

    const status: GatewayRequestHandler = async ({ respond }) => {
      respond(true, { ...settingsView(), provider: await provider.status() });
    };

    const settingsGet: GatewayRequestHandler = ({ respond }) => respond(true, settingsView());

    const settingsSet: GatewayRequestHandler = async ({ params, respond }) => {
      if (!isRecord(params)) {
        respond(false, undefined, { code: "bad_request", message: "expected a settings patch" });
        return;
      }
      const patch: Record<string, unknown> = {};
      for (const k of SETTINGS_KEYS) if (k in params) patch[k] = params[k];
      if (typeof patch.baseUrl === "string" && patch.baseUrl.trim()) {
        try {
          const u = new URL(patch.baseUrl.trim());
          if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("scheme");
        } catch {
          respond(false, undefined, { code: "bad_request", message: "baseUrl must be an http(s) URL" });
          return;
        }
      }
      const st = linkState(store);
      // While linked, the deployment IS the link's: a different URL would show
      // one Robovoice here while calls run on another.
      const nextBase = typeof patch.baseUrl === "string" ? patch.baseUrl.trim().replace(/\/+$/, "") : "";
      if (st.linked && nextBase && nextBase !== st.ctx.apiBase) {
        respond(false, undefined, {
          code: "linked",
          message: `This install is linked to ${st.ctx.link.orgName} on ${st.ctx.apiBase} — disconnect Robovoice before pointing it elsewhere.`,
        });
        return;
      }
      // Character choices must be the linked org's own agents.
      const wantsDefault = typeof patch.defaultCharacterId === "string" && patch.defaultCharacterId.trim() !== "";
      const wantsMap = isRecord(patch.characterMap) && Object.keys(patch.characterMap).length > 0;
      if (wantsDefault || wantsMap) {
        if (!st.linked) {
          respond(false, undefined, { code: "robovoice_not_linked", message: st.message });
          return;
        }
        try {
          const roster = await rosterFor(st.ctx);
          if (wantsDefault) assertOrgCharacter(String(patch.defaultCharacterId).trim(), roster, st.ctx.link.orgName);
          if (wantsMap) {
            for (const cid of Object.values(patch.characterMap as Record<string, unknown>)) {
              if (typeof cid === "string" && cid.trim()) assertOrgCharacter(cid.trim(), roster, st.ctx.link.orgName);
            }
          }
        } catch (err) {
          respond(false, undefined, { code: (err as { code?: string }).code ?? "robovoice_error", message: errMsg(err) });
          return;
        }
      }
      const hadMcpUrl = Boolean(store.get().mcpPublicUrl);
      store.update(patch as Partial<RobovoiceSettings>);
      // Turning agent tools off rotates every per-agent token.
      if (hadMcpUrl && !store.get().mcpPublicUrl) store.revokeMcpTokens();
      respond(true, settingsView());
    };

    const secretsSet: GatewayRequestHandler = ({ params, respond }) => {
      const p = isRecord(params) ? params : {};
      const pick = (k: string) =>
        p[k] === null ? null : typeof p[k] === "string" ? (p[k] as string) : undefined;
      store.setSecrets({ deviceKey: pick("deviceKey"), edgeToken: pick("edgeToken") });
      respond(true, settingsView());
    };

    const testConnection: GatewayRequestHandler = async ({ params, respond }) => {
      // Health only (optionally of an unsaved URL). Never reads the deployment's
      // public roster (that lists the deployment owner's agents) and never calls
      // connection-details (that places a billing hold).
      const p = isRecord(params) ? params : {};
      const st = linkState(store);
      const url =
        typeof p.baseUrl === "string" && p.baseUrl.trim()
          ? p.baseUrl.trim()
          : st.linked
            ? st.ctx.apiBase
            : store.get().baseUrl;
      if (!url) {
        respond(true, { ok: false, error: "No Robovoice URL set." });
        return;
      }
      try {
        const health = await probeClient(url).health();
        const sameDeployment = st.linked && url.replace(/\/+$/, "") === st.ctx.apiBase;
        const roster = sameDeployment && st.linked ? await rosterFor(st.ctx).catch(() => null) : null;
        respond(true, { ok: health.ok, health: health.status, linked: st.linked, ...(roster ? { characters: roster.length } : {}) });
      } catch (err) {
        respond(true, { ok: false, error: errMsg(err) });
      }
    };

    const charactersList: GatewayRequestHandler = async ({ respond }) => {
      // The linked org's agents at its location — never the deployment's public roster.
      const s = store.get();
      const st = linkState(store);
      if (!st.linked) {
        respond(true, {
          characters: [],
          characterMap: s.characterMap,
          defaultCharacterId: s.defaultCharacterId ?? null,
          linked: false,
          code: "robovoice_not_linked",
          error: st.message,
        });
        return;
      }
      try {
        const roster = await rosterFor(st.ctx);
        respond(true, {
          characters: roster.map((c) => ({ id: c.id, name: c.name, infinibotAgentId: c.infinibotAgentId ?? null })),
          org: { id: st.ctx.orgId, name: st.ctx.link.orgName },
          locationId: st.ctx.locationId,
          characterMap: s.characterMap,
          defaultCharacterId: s.defaultCharacterId ?? null,
          linked: true,
          issues: configIssues(s, roster),
        });
      } catch (err) {
        respond(true, { characters: [], characterMap: s.characterMap, linked: true, error: errMsg(err) });
      }
    };

    const mappingSet: GatewayRequestHandler = async ({ params, respond }) => {
      const p = isRecord(params) ? params : {};
      const agentId = typeof p.agentId === "string" ? p.agentId.trim() : "";
      if (!agentId) {
        respond(false, undefined, { code: "bad_request", message: "expected { agentId, characterId | null }" });
        return;
      }
      const map = { ...store.get().characterMap };
      const characterId = typeof p.characterId === "string" ? p.characterId.trim() : "";
      if (characterId) {
        try {
          const ctx = requireLinked(store);
          assertOrgCharacter(characterId, await rosterFor(ctx), ctx.link.orgName);
        } catch (err) {
          respond(false, undefined, { code: (err as { code?: string }).code ?? "robovoice_error", message: errMsg(err) });
          return;
        }
        map[agentId] = characterId;
      } else delete map[agentId];
      store.update({ characterMap: map });
      respond(true, { characterMap: store.get().characterMap });
    };

    const mappingResolve: GatewayRequestHandler = ({ params, respond }) => {
      const p = isRecord(params) ? params : {};
      const s = store.get();
      const agentId = agentForRequest(s, {
        agentId: typeof p.agentId === "string" ? p.agentId : undefined,
        room: typeof p.room === "string" ? p.room : undefined,
      });
      const choice = linkState(store).linked ? linkedCharacterFor(s, agentId) : null;
      // No choice = the call is refused (never "let Robovoice pick").
      respond(true, choice ? { ...choice } : { agentId, characterId: null, source: "none" });
    };

    /**
     * Org-scoped config vs the linked org: mappings / default / synced
     * characters outside its roster, a pipeline location outside the org.
     * `fix: true` clears every flagged id. Unlinked: anything org-scoped left
     * over is flagged (and cleared on fix).
     */
    const configValidate: GatewayRequestHandler = async ({ params, respond }) => {
      const p = isRecord(params) ? params : {};
      const s = store.get();
      const st = linkState(store);
      try {
        let roster = null;
        let locations: string[] | null = null;
        if (st.linked) {
          roster = await rosterFor(st.ctx);
          if (s.pipelineLocationId && s.pipelineLocationId !== st.ctx.locationId) {
            const me = await service().api().meFull().catch(() => null);
            locations = Array.isArray(me?.locations) ? me.locations.map((l) => l.id) : null;
          }
        }
        const issues = configIssues(s, roster, locations);
        let cleared = false;
        if (p.fix === true && issues.length) {
          store.update(clearIssuesPatch(s, issues));
          orgRoster.invalidate();
          cleared = true;
        }
        respond(true, {
          linked: st.linked,
          org: st.linked ? { id: st.ctx.orgId, name: st.ctx.link.orgName } : null,
          locationId: st.linked ? st.ctx.locationId : null,
          characters: roster?.length ?? null,
          issues,
          cleared,
        });
      } catch (err) {
        respond(false, undefined, { code: (err as { code?: string }).code ?? "robovoice_error", message: errMsg(err) });
      }
    };

    const pipelineGet: GatewayRequestHandler = async ({ params, respond }) => {
      const client = clientFor(store);
      if (!client) {
        respond(true, { pipelines: [], safety: { flags: [], cloudViolation: false }, linked: false, code: "robovoice_not_linked", error: "Connect Robovoice to see your organization's pipeline." });
        return;
      }
      const p = isRecord(params) ? params : {};
      try {
        const pipelines =
          typeof p.characterId === "string" && p.characterId
            ? [await client.pipeline(p.characterId, store.get().link?.locationId)]
            : await relevantPipelines(client, store);
        respond(true, { pipelines, safety: assessRobovoiceSafety(store.get(), pipelines) });
      } catch (err) {
        respond(true, { pipelines: [], safety: { flags: [], cloudViolation: false }, error: errMsg(err) });
      }
    };

    const creditsGet: GatewayRequestHandler = async ({ respond }) => {
      const st = linkState(store);
      const client = clientFor(store);
      if (!st.linked || !client) {
        respond(true, { available: false, reason: "Connect Robovoice to see your organization's credits.", code: "robovoice_not_linked" });
        return;
      }
      const credits = await client.credits();
      respond(true, { ...credits, org: st.ctx.link.orgName });
    };

    api.registerGatewayMethod("robovoice.status", status);
    api.registerGatewayMethod("robovoice.settings.get", settingsGet);
    api.registerGatewayMethod("robovoice.settings.set", settingsSet);
    api.registerGatewayMethod("robovoice.secrets.set", secretsSet);
    api.registerGatewayMethod("robovoice.test", testConnection);
    api.registerGatewayMethod("robovoice.characters.list", charactersList);
    api.registerGatewayMethod("robovoice.mapping.set", mappingSet);
    api.registerGatewayMethod("robovoice.mapping.resolve", mappingResolve);
    api.registerGatewayMethod("robovoice.pipeline.get", pipelineGet);
    api.registerGatewayMethod("robovoice.credits.get", creditsGet);
    api.registerGatewayMethod("robovoice.config.validate", configValidate);

    // Plugin-owned connection endpoint (replaces the legacy /api/connection-details
    // proxy for external clients): same session the voice UI gets when
    // Robovoice is the active provider. Behind the gateway HTTP auth gate.
    api.registerHttpRoute({
      path: "/plugins/robovoice/connection-details",
      handler: async (req, res) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        try {
          const agentId = url.searchParams.get("agent") ?? undefined;
          const session = await provider.createRealtimeSession!({
            agentId,
            room: url.searchParams.get("room") ?? undefined,
          });
          // Started from a chat session: that call's turns run on (and reply into) it.
          const sessionKey = cleanSessionKey(url.searchParams.get("sessionKey"), agentId ?? "main");
          if (sessionKey) {
            operatorCalls.joined(session.room, { agentId: agentId ?? "main", characterId: session.characterId, sessionKey });
          }
          res.writeHead(200, { "content-type": "application/json" }).end(
            JSON.stringify({
              serverUrl: session.url,
              participantToken: session.token,
              roomName: session.room,
              participantName: session.participant,
              characterId: session.characterId ?? null,
            }),
          );
        } catch (err) {
          const status = typeof (err as { status?: unknown }).status === "number" ? (err as { status: number }).status : 502;
          res.writeHead(status, { "content-type": "application/json" }).end(
            JSON.stringify({ error: errMsg(err), code: (err as { code?: string }).code ?? "robovoice_error" }),
          );
        }
      },
    });

    api.registerHttpRoute({
      path: "/plugins/robovoice/mcp",
      handler: async (req, res) => {
        await handleMcpHttp(req, res, store.get().mcpTools ?? DEFAULT_MCP_TOOLS);
      },
    });

    // Per-agent MCP for Robovoice characters: self-authenticating scoped token
    // (manifest contributes.selfAuthHttp → served before the shared-secret gate).
    api.registerHttpRoute({
      path: MCP_ROUTE,
      handler: async (req, res) => {
        if (req.method !== "POST") {
          res.writeHead(405, { allow: "POST" }).end();
          return;
        }
        await handleAgentMcpHttp(req, res, store, resolveSelfCallAuthHeaders);
      },
    });

    // ── SaaS link (device-code login → location + device + agents) ──────────
    const rpc =
      (fn: (p: Record<string, unknown>) => Promise<unknown> | unknown): GatewayRequestHandler =>
      async ({ params, respond }) => {
        try {
          respond(true, await fn(isRecord(params) ? params : {}));
        } catch (err) {
          const code = (err as { code?: unknown }).code;
          respond(false, undefined, {
            code: typeof code === "string" && code ? code : "robovoice_error",
            message: errMsg(err),
          });
        }
      };
    const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);

    api.registerGatewayMethod(
      "robovoice.link.status",
      // InfiniBot Cloud too: the REAL link (no synthetic "InfiniBot Cloud" org) —
      // an unlinked workspace sees Connect Robovoice, its calls are refused.
      rpc(async (p) => ({
        ...(await service().status({ remote: p.remote !== false })),
        pending: service().pendingLogin(),
        desktop: service().desktop(),
      })),
    );
    api.registerGatewayMethod(
      "robovoice.link.start",
      rpc((p) => service().beginLogin(str(p.apiBase))),
    );
    api.registerGatewayMethod(
      "robovoice.link.cancel",
      rpc(() => {
        service().cancelLogin();
        return { ok: true };
      }),
    );
    api.registerGatewayMethod("robovoice.link.sync", rpc(() => service().sync()));
    api.registerGatewayMethod("robovoice.unlink", rpc(() => service().unlink()));
    api.registerGatewayMethod(
      "robovoice.logout",
      rpc((p) => service().logout({ keepDevice: p.keepDevice === true })),
    );
    api.registerGatewayMethod(
      "robovoice.agents.list",
      rpc(() => {
        const s = store.get();
        const linked = new Set(s.linkedAgents ?? (s.link ? ["main"] : []));
        return {
          agents: personas().map((a) => ({
            ...a,
            linked: linked.has(a.id),
            characterId: s.linkedCharacters[a.id]?.characterId ?? s.characterMap[a.id] ?? null,
            managed: s.linkedCharacters[a.id]?.managed ?? null,
            error: s.linkedCharacters[a.id]?.error ?? null,
            override: s.agentOverrides[a.id] ?? null,
          })),
        };
      }),
    );
    api.registerGatewayMethod(
      "robovoice.agents.link",
      rpc((p) => {
        const agentId = str(p.agentId);
        if (!agentId) throw new Error("expected { agentId }");
        return service().linkAgent(agentId, {
          characterId: str(p.characterId),
          create: p.create === true,
          override: {
            voice: str(p.voice),
            ttsProvider: str(p.ttsProvider),
            language: str(p.language),
            name: str(p.name),
          },
        });
      }),
    );
    api.registerGatewayMethod(
      "robovoice.agents.unlink",
      rpc((p) => {
        const agentId = str(p.agentId);
        if (!agentId) throw new Error("expected { agentId }");
        return service().unlinkAgent(agentId);
      }),
    );
    api.registerGatewayMethod(
      "robovoice.call.start",
      rpc(async (p) => {
        // A chat surface may name only its session (`agent:<id>:…`): the agent comes from it.
        const fromSession = typeof p.sessionKey === "string" ? /^agent:([^:]+):/.exec(p.sessionKey)?.[1] : undefined;
        const agentId = str(p.agentId) ?? fromSession ?? "main";
        const mode = p.mode === "cloud" || p.mode === "local" ? p.mode : "auto";
        const sessionKey = cleanSessionKey(p.sessionKey, agentId);
        const call = await service().startCall(agentId, { mode });
        // Started by the operator of this install. Cloud: the page joins its own
        // room via connection-details (recorded there); local: the Desktop's room.
        operatorCalls.start(call.room, { agentId, characterId: call.character_id, mode: call.mode, sessionKey });
        return { ...call, ...(sessionKey ? { sessionKey } : {}) };
      }),
    );
    api.registerGatewayMethod(
      "robovoice.call.status",
      rpc((p) => {
        const room = str(p.room);
        if (!room) throw new Error("expected { room }");
        return service().callStatus(room, str(p.since));
      }),
    );
    api.registerGatewayMethod(
      "robovoice.call.end",
      rpc((p) => {
        const room = str(p.room);
        if (!room) throw new Error("expected { room }");
        operatorCalls.end(room);
        return service().endCall(room);
      }),
    );

    // ── Voice pipeline: location pipeline editor, voice agents, InfiniBot LLM ──
    const voiceLlmStats = new VoiceLlmStats();
    const log = api.runtime.logging.getChildLogger({ plugin: "robovoice" });
    registerVoicePipelineRpcs({
      register: (m, h) => api.registerGatewayMethod(m, h),
      store,
      service,
      personas,
      stats: voiceLlmStats,
      voiceTurn: (req) => api.runtime.host.voiceTurn(req),
      log: { info: (m) => log.info(m), warn: (m) => log.warn(m) },
      // InfiniBot Cloud: the linked org's location pipeline, like everywhere else
      // (the hosted broker pipeline is no longer what customer calls run).
      cloudBrokerUrl: null,
    });
    // Cloud read-aloud (TTS) + talk (STT) for the chat sidebar when cloud voice is chosen (free).
    registerSpeechRpcs({ register: (m, h) => api.registerGatewayMethod(m, h), store, service });
    // OpenAI-compatible LLM callback for Robovoice (scoped rvllm_ token per
    // location; manifest selfAuthHttp → served before the shared-secret gate).
    api.registerHttpRoute({
      path: VOICE_LLM_ROUTE,
      handler: (req, res) =>
        handleVoiceLlmHttp(req, res, {
          store,
          stats: voiceLlmStats,
          operatorCalls,
          voiceTurn: (r) => api.runtime.host.voiceTurn(r),
          log: { info: (m) => log.info(m), warn: (m) => log.warn(m) },
        }),
    });

    api.registerTool((ctx) => createRobovoiceCallTool(service, { agentId: ctx.agentId }), {
      name: ROBOVOICE_TOOL_NAME,
    });

    api.registerCli(
      ({ program, logger }) => registerRobovoiceCli({ program, service, personas, logger }),
      { commands: ["robovoice"] },
    );
  },
};

export default plugin;
