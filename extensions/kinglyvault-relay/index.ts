/**
 * kinglyvault-relay: KinglyVault Connect inside the gateway.
 *
 * The real work lives in relay-client.mjs, which also runs standalone
 * (`node extensions/kinglyvault-relay/relay-client.mjs run`) so a member can
 * link KinglyVault without restarting the gateway. Once this plugin loads it:
 *  - runs the same link as a plugin service (only when paired, autoStart != false,
 *    and only if no standalone link already holds the link lock),
 *  - serves the one-click local handshake at POST /kv-connect/pair (see
 *    local-pair.mjs): the KinglyVault page hands over a one-time code and the
 *    owner approves it in the InfiniBot UI. No secret ever goes to the page,
 *  - adds the kvconnect.* RPCs behind Settings → Connect KinglyVault and the
 *    global approval prompt (status, enter a code, approve, deny, reconnect, disconnect),
 *  - adds the `infinibot kv-connect <CODE>` CLI command (approval prompt),
 *  - registers the `kinglyvault_relay` agent tool so gateway agents can read and,
 *    with kv.write / kv.admin, change the member's KinglyVault data through kv-mcp
 *    with the credential issued at pairing.
 */
import os from "node:os";
import { Type } from "@sinclair/typebox";
import type { InfiniBotPluginApi } from "infinibot/plugin-sdk";
// @ts-ignore: plain ESM module shared with the standalone CLI.
import { BEGIN_PATH, BeginGuard, PAIR_PATH, PendingPairings, createBeginHandler, createPairHandler, normalizeCode } from "./local-pair.mjs";
import {
  DEFAULT_RELAY_URL,
  RelayLink,
  approvePairing,
  claimPairing,
  cli,
  defaultDeviceName,
  denyPairing,
  disconnectLink,
  friendlyError,
  kvMcpCall,
  kvMcpTools,
  linkHolder,
  loadHealth,
  loadState,
  retryPendingRevoke,
  revokePending,
  scopeText,
  setGatewayConnection,
  startDeviceLink,
  waitForDeviceLink,
  // @ts-ignore: plain ESM module shared with the standalone CLI.
} from "./relay-client.mjs";
// @ts-ignore: plain ESM module shared with the standalone relay link.
import { CliSessionManager, CliSessionStore } from "./cli-sessions.mjs";
// @ts-ignore: plain ESM module shared with the relay link.
import { COMMAND_OPS, PANEL_KINDS, uiHub } from "./kv-ui.mjs";

type Claim = { code: string; account: string; requested: string[]; kvOrigin: string };
type Pending = { id: string; code: string; source: string; claim: Claim | null; createdAt: number; expiresAt: number };
type Respond = (ok: boolean, payload?: unknown, error?: { code: string; message: string }) => void;
type DeviceLink = { userCode: string; verifyUrl: string; expiresAt: string };
type Linking = {
  state: "waiting" | "finishing" | "connected" | "denied" | "expired" | "error";
  userCode: string;
  verifyUrl: string;
  expiresAt: string;
  error?: string;
  abort: AbortController;
};

// The gateway's broadcaster, published on globalThis by the host
// (src/agents/coder-runtime/subagent-broadcast.ts). Not imported: packaged
// installs ship no src/ folder, and jiti would load a second module copy.
const BROADCASTER = Symbol.for("infinibot.gatewayBroadcaster");
function broadcast(event: string, payload: unknown) {
  try {
    const fn = (globalThis as Record<symbol, unknown>)[BROADCASTER] as ((e: string, p: unknown) => void) | undefined;
    fn?.(event, payload);
  } catch {
    /* the UI also polls kvconnect.status */
  }
}

let link: { run(): Promise<void>; stop(): void; restart(): boolean } | null = null;
let linking: Linking | null = null;
const pending = new PendingPairings();

function publicLinking(l: Linking | null) {
  if (!l) return null;
  return { state: l.state, userCode: l.userCode, verifyUrl: l.verifyUrl, expiresAt: l.expiresAt, error: l.error ?? null };
}

function publicPending(e: Pending) {
  return {
    id: e.id,
    code: e.code,
    source: e.source,
    account: e.claim?.account ?? null,
    kvOrigin: e.claim?.kvOrigin ?? null,
    permissions: (e.claim?.requested ?? []).map((s) => ({ scope: s, text: scopeText(s) })),
    createdAt: new Date(e.createdAt).toISOString(),
    expiresAt: new Date(e.expiresAt).toISOString(),
  };
}

// health.json is rewritten about every 30 s while the link pulls. Older than
// this and the link itself has stopped reporting, whatever it last said.
const HEALTH_STALE_MS = 150_000;
const STALE_ERROR = "The link stopped syncing with KinglyVault. Click Reconnect, or restart InfiniBot if this stays.";

function status() {
  const s = loadState();
  const h = (loadHealth() ?? {}) as { ok?: boolean; lastSyncAt?: string; lastRequestAt?: string; error?: string | null; errorAt?: string };
  const running = !!s && (!!link || linkHolder() !== null);
  const stale = running && h.ok !== false && !!h.lastSyncAt && Date.now() - Date.parse(h.lastSyncAt) > HEALTH_STALE_MS;
  return {
    pluginActive: true,
    connected: !!s,
    linking: publicLinking(linking),
    revokePending: revokePending(),
    health: s
      ? {
          online: running && h.ok !== false && !stale,
          lastSyncAt: h.lastSyncAt ?? null,
          lastRequestAt: h.lastRequestAt ?? null,
          error: running ? (stale ? STALE_ERROR : h.ok === false ? (h.error ?? null) : null) : "The link is not running. Click Reconnect, or restart InfiniBot if this stays.",
        }
      : null,
    link: s
      ? {
          account: s.account,
          kvOrigin: s.kvOrigin,
          connectionId: String(s.connectionId || "").slice(0, 8),
          deviceName: s.deviceName ?? null,
          permissions: (s.grantedScopes ?? []).map((x: string) => ({ scope: x, text: scopeText(x) })),
          paused: !!s.paused,
          pairedAt: s.pairedAt ?? null,
          running,
        }
      : null,
    pending: (pending.list() as Pending[]).map(publicPending),
  };
}

function fail(respond: Respond, e: unknown, code = "INVALID_REQUEST") {
  respond(false, undefined, { code, message: friendlyError(e) });
}

const plugin = {
  id: "kinglyvault-relay",
  name: "KinglyVault Connect",
  description: "Outbound relay link to KinglyVault: scoped, audited, revocable.",
  register(api: InfiniBotPluginApi) {
    const cfg = (api.pluginConfig ?? {}) as { autoStart?: boolean; relayUrl?: string };
    const relayUrl = cfg.relayUrl || process.env.KV_RELAY_URL || DEFAULT_RELAY_URL;

    // Talk to THIS gateway with its own resolved port + auth (JSON5 configs,
    // custom ports, desktop/cloud state dirs), not a re-read of infinibot.json.
    // Resolved when the link connects: --port/--password flags reach the env
    // after plugins register (the CLI registers them first for `kv-connect`).
    setGatewayConnection(() => {
      const gwCfg = (api.config?.gateway ?? {}) as { port?: number; auth?: { token?: string; password?: string } };
      const port = Number(process.env.INFINIBOT_GATEWAY_PORT) || gwCfg.port || 18789;
      return {
        url: process.env.INFINIBOT_GATEWAY_URL || `ws://127.0.0.1:${port}`,
        token: process.env.INFINIBOT_GATEWAY_TOKEN || gwCfg.auth?.token || undefined,
        password: process.env.INFINIBOT_GATEWAY_PASSWORD || gwCfg.auth?.password || undefined,
      };
    });

    // Idle until paired: no network traffic at all without a saved link.
    // While paired, the link reconnects by itself (RelayLink backs off up to
    // 60 s); if it ever exits while still paired, the watchdog restarts it.
    let restartTimer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;
    const startLink = () => {
      if (stopped || link || cfg.autoStart === false || !loadState() || linkHolder() !== null) return;
      const l = new RelayLink({ log: api.logger });
      link = l;
      void l
        .run()
        .catch((err: unknown) => api.logger.warn?.(`[kv-relay] stopped: ${friendlyError(err)}`))
        .finally(() => {
          if (link === l) link = null;
          if (!stopped && loadState() && !restartTimer) {
            restartTimer = setTimeout(() => {
              restartTimer = null;
              startLink();
            }, 15_000);
          }
          if (!loadState()) broadcast("kvconnect.changed", { connected: false });
        });
    };
    let watchdog: ReturnType<typeof setInterval> | null = null;

    const announce = (entry: Pending) => broadcast("kvconnect.request", publicPending(entry));

    // Claim the code right away (binds it to this InfiniBot and returns the
    // masked account to show), then wait for the owner in the UI.
    const queue = async (code: string, source: string): Promise<Pending> => {
      const claim = (await claimPairing({ code, relayUrl, name: defaultDeviceName() })) as Claim;
      const entry = pending.add({ code, source, claim }) as Pending;
      api.logger.info?.(`[kv-connect] ${source === "kinglyvault-page" ? "KinglyVault page" : "Code"} asks to connect (${claim.account}); waiting for approval in the InfiniBot UI.`);
      announce(entry);
      return entry;
    };

    api.registerService({
      id: "kinglyvault-relay-link",
      start: async () => {
        stopped = false;
        startLink();
        void retryPendingRevoke().catch(() => {});
        // Cheap local checks only (no network unless paired / a revoke is queued).
        watchdog = setInterval(() => {
          startLink();
          if (revokePending()) void retryPendingRevoke().catch(() => {});
        }, 60_000);
        watchdog.unref?.();
      },
      stop: async () => {
        stopped = true;
        if (watchdog) clearInterval(watchdog);
        if (restartTimer) clearTimeout(restartTimer);
        watchdog = null;
        restartTimer = null;
        linking?.abort.abort();
        link?.stop();
        link = null;
      },
    });

    // One-click connect: start a device link, the UI opens verifyUrl on
    // kinglyvault.com, and this finishes by itself once the member approves
    // there. The owner already consented by clicking Connect here.
    // `intent` (Agent A, zero pairing): the member's Connect click in
    // KinglyVault, handed over by the KV page (localhost), the infinibot://
    // deep link or the Cloud app URL. KV then approves the link by itself.
    const beginDeviceLink = async (intent?: string): Promise<Linking> => {
      linking?.abort.abort();
      const d = (await startDeviceLink({ relayUrl, name: defaultDeviceName(), intent })) as DeviceLink & Record<string, unknown>;
      const l: Linking = { state: "waiting", userCode: d.userCode, verifyUrl: d.verifyUrl, expiresAt: d.expiresAt, abort: new AbortController() };
      linking = l;
      api.logger.info?.(`[kv-connect] waiting for approval on KinglyVault (code ${d.userCode})`);
      void (async () => {
        try {
          const r = (await waitForDeviceLink(d, { signal: l.abort.signal })) as { status: string; claim?: Claim & Record<string, unknown> };
          if (l.abort.signal.aborted || linking !== l) return;
          if (r.status !== "approved" || !r.claim) {
            l.state = r.status === "denied" ? "denied" : "expired";
            l.error = r.status === "denied" ? "Not approved on KinglyVault. Nothing was connected." : "The link expired before it was approved. Click Connect to try again.";
          } else {
            l.state = "finishing";
            link?.stop();
            link = null;
            const state = await approvePairing(r.claim, r.claim.requested, { log: api.logger });
            l.state = "connected";
            startLink();
            api.logger.info?.(`[kv-connect] connected to KinglyVault as ${state.account}`);
          }
        } catch (e) {
          if (linking === l) {
            l.state = "error";
            l.error = friendlyError(e);
          }
        }
        broadcast("kvconnect.changed", status());
      })();
      return l;
    };

    api.registerHttpRoute({
      path: PAIR_PATH,
      handler: createPairHandler({
        pending,
        log: api.logger,
        onRequest: ({ code }: { code: string }) => queue(code, "kinglyvault-page"),
      }),
    });

    api.registerHttpRoute({
      path: BEGIN_PATH,
      handler: createBeginHandler({
        guard: new BeginGuard(),
        log: api.logger,
        onBegin: async ({ intent }: { intent: string }) => {
          const l = await beginDeviceLink(intent);
          api.logger.info?.("[kv-connect] KinglyVault page started a one-click sign-in on this computer");
          broadcast("kvconnect.changed", status());
          return l;
        },
      }),
    });

    api.registerGatewayMethod("kvconnect.status", ({ respond }) => respond(true, status()));

    api.registerGatewayMethod("kvconnect.start", async ({ params, respond }) => {
      try {
        const intent = typeof params?.intent === "string" && /^[A-Za-z0-9_-]{24,100}$/.test(params.intent) ? params.intent : undefined;
        await beginDeviceLink(intent);
        respond(true, status());
      } catch (e) {
        fail(respond, e, "UNAVAILABLE");
      }
    });

    api.registerGatewayMethod("kvconnect.cancel", async ({ respond }) => {
      linking?.abort.abort();
      linking = null;
      respond(true, status());
    });

    api.registerGatewayMethod("kvconnect.code", async ({ params, respond }) => {
      const code = normalizeCode(params?.code);
      if (!code) return respond(false, undefined, { code: "INVALID_REQUEST", message: "Enter the 8-character code from KinglyVault, like ABCD-EFGH." });
      try {
        const entry = await queue(code, "code");
        respond(true, publicPending(entry));
      } catch (e) {
        fail(respond, e);
      }
    });

    api.registerGatewayMethod("kvconnect.approve", async ({ params, respond }) => {
      const id = String(params?.id ?? "");
      const entry = pending.take(id) as Pending | null;
      if (!entry?.claim) return fail(respond, new Error("That request expired. Start again from KinglyVault."), "NOT_FOUND");
      const scopes = Array.isArray(params?.scopes) ? (params.scopes as unknown[]).map(String) : undefined;
      try {
        link?.stop();
        link = null;
        const state = await approvePairing(entry.claim, scopes, { log: api.logger });
        startLink();
        api.logger.info?.(`[kv-connect] connected to KinglyVault as ${state.account}`);
        respond(true, status());
      } catch (e) {
        fail(respond, e);
      }
    });

    api.registerGatewayMethod("kvconnect.deny", async ({ params, respond }) => {
      const entry = pending.take(String(params?.id ?? "")) as Pending | null;
      if (entry?.claim) await denyPairing(entry.claim);
      respond(true, status());
    });

    // Reconnect without restarting the gateway. Keeps the credentials and any
    // in-flight KinglyVault work; a dead link is simply started again.
    api.registerGatewayMethod("kvconnect.restart", async ({ respond }) => {
      if (!loadState()) return fail(respond, new Error("This InfiniBot is not connected to KinglyVault."), "NOT_FOUND");
      const holder = linkHolder();
      if (holder !== null) {
        return fail(respond, new Error(`The link runs in a separate program (process ${holder}). Restart that program to reconnect.`), "UNAVAILABLE");
      }
      if (!link?.restart()) {
        link = null;
        startLink();
      }
      broadcast("kvconnect.changed", status());
      respond(true, status());
    });

    api.registerGatewayMethod("kvconnect.disconnect", async ({ respond }) => {
      try {
        linking?.abort.abort();
        linking = null;
        link?.stop();
        link = null;
        const remote = await disconnectLink();
        broadcast("kvconnect.changed", { connected: false });
        respond(true, { ...status(), remote });
      } catch (e) {
        fail(respond, e);
      }
    });

    // Persistent CLI sessions for InfiniBot's own surfaces (chat CLI mode).
    // Same on-disk store as the KinglyVault relay, so both list the same
    // sessions. No folder allowlist here: the operator is local. Gateway-agent
    // sessions are driven by chat.send (sessionKey) and only listed here.
    // See docs/cli-sessions.md.
    const sessions = new CliSessionManager({ store: new CliSessionStore() });
    const sessionCall =
      (fn: (p: Record<string, unknown>) => unknown) =>
      async ({ params, respond }: { params?: Record<string, unknown>; respond: Respond }) => {
        try {
          respond(true, await fn(params ?? {}));
        } catch (e) {
          fail(respond, e);
        }
      };
    api.registerGatewayMethod("cli.sessions.list", sessionCall((p) => sessions.list({ includeArchived: !!p.includeArchived, backend: p.backend as string | undefined })));
    api.registerGatewayMethod("cli.sessions.history", sessionCall((p) => sessions.history(String(p.id), Number(p.limit) || 200)));
    api.registerGatewayMethod(
      "cli.sessions.create",
      sessionCall((p) => sessions.create({ backend: String(p.backend), folder: p.folder ? String(p.folder) : os.homedir(), title: p.title as string, agentId: p.agentId as string, origin: "infinibot" })),
    );
    api.registerGatewayMethod(
      "cli.sessions.send",
      sessionCall((p) => {
        const id = String(p.id);
        const emit = (payload: Record<string, unknown>) => {
          try {
            broadcast("cli.sessions.event", { id, ...payload });
          } catch {
            /* best effort */
          }
        };
        return sessions.send(id, String(p.message ?? ""), { onText: (text: string) => emit({ text }), onEvent: (event: string) => emit({ event }) });
      }),
    );
    api.registerGatewayMethod("cli.sessions.stop", sessionCall((p) => sessions.stop(String(p.id))));
    api.registerGatewayMethod("cli.sessions.rename", sessionCall((p) => ({ session: sessions.rename(String(p.id), String(p.title ?? "")) })));
    api.registerGatewayMethod("cli.sessions.archive", sessionCall((p) => ({ session: sessions.archive(String(p.id), p.archived !== false) })));

    api.registerCli(
      ({ program }) => {
        program
          .command("kv-connect")
          .description("Connect this InfiniBot to KinglyVault (pairing code from KinglyVault → InfiniBot → Connect)")
          .argument("[args...]", "(no args: open kinglyvault.com to approve) | connect <CODE> | status | audit | pause | resume | allow-dir <path> | disconnect")
          .allowUnknownOption(true)
          .action(async (args: string[]) => {
            const argv = !args.length ? ["link"] : /^[A-Za-z0-9]{4}-?[A-Za-z0-9]{4}$/.test(args[0]) ? ["connect", ...args] : args;
            await cli([...argv, ...process.argv.slice(process.argv.indexOf("kv-connect") + 1 + args.length)]);
          });
      },
      { commands: ["kv-connect"] },
    );

    api.registerTool({
      name: "kinglyvault_relay",
      label: "KinglyVault (as the member)",
      description:
        "The member's KinglyVault account, as them, through kv-mcp. Use it whenever the member mentions KinglyVault or their courses, lessons, projects, progress, notes, tasks, carousels, ebooks, community, funding proof, plan or leaderboard. " +
        "action=tools lists what this connection can use (pass `query` to filter, e.g. 'note', 'community', 'funding'); action=call runs one kv_* tool with `args`; action=whoami shows the account. " +
        "Start with kv_search for vault content and kv_learning_context for 'this lesson'. " +
        "Own data (kv_*_my_*) needs kv.write: on `forbidden`, tell the member to click Upgrade access in KinglyVault. Billing and funding status are read-only. " +
        "kv_admin_* (users, course authoring, moderation, funding approvals, analytics, announcement drafts) needs kv.admin on an admin account and is audit-logged. " +
        "Community posts are public: post only when the member asks. Never set confirm:true unless the human said yes to that exact action in this conversation.",
      parameters: Type.Object({
        action: Type.Union([Type.Literal("call"), Type.Literal("tools"), Type.Literal("whoami")]),
        tool: Type.Optional(Type.String({ description: "kv-mcp tool name, e.g. kv_search or kv_create_my_note" })),
        args: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
        query: Type.Optional(Type.String({ description: "action=tools: filter by a word in the tool name or description" })),
      }),
      async execute(_id: string, params: { action: string; tool?: string; args?: Record<string, unknown>; query?: string }) {
        // Fresh on every call, so an Upgrade access token applies with no restart.
        const state = loadState();
        if (!state?.kvMcp) throw new Error("KinglyVault Connect is not paired with kv.read on this InfiniBot.");
        if (params.action === "tools") {
          const tools = await kvMcpTools(state, params.query);
          return { content: [{ type: "text", text: JSON.stringify(tools).slice(0, 60_000) }], details: { count: tools.length } };
        }
        const name = params.action === "whoami" ? "kv_whoami" : String(params.tool || "");
        if (!/^kv_[a-z_]+$/.test(name)) throw new Error("tool must be a kv_* kv-mcp tool");
        const result = await kvMcpCall(state, name, params.args ?? {});
        return { content: [{ type: "text", text: JSON.stringify(result).slice(0, 60_000) }], details: result };
      },
    } as never);

    // Agent E: the page the member has open in KinglyVault. The tab enforces the
    // safety rules; a blocked control comes back as humanRequired.
    api.registerTool({
      name: "kv_ui",
      label: "KinglyVault page",
      description:
        "Drive the KinglyVault page the member has open, in front of them (needs the ui.control permission and an open KV tab; action=status checks). " +
        "read_state first: it returns the route, headings, tabs, form fields, selection and the page's controls. " +
        "Target controls with name (accessible name or visible text), testid (data-testid) or tour (data-tour). " +
        "navigate {route:'/courses'} opens a KV page (/courses, /learning-path, /library, /projects, /ai-chat, /community, /course/<id>; an unknown path is refused with the list). highlight {name, text} draws a ring and caption. click, type {name, value}, scroll {name | to:'top'|'bottom'}, select_tab {name}, open_modal {name}, close_modal. say {text} posts to the side panel. clear removes highlights. " +
        "show_panel {kind, title, ...} renders in KV's side panel: markdown {markdown}, table {columns, rows}, chart {chartType:'bar'|'line', labels, series:[{name, values}]}, form {fields:[{name,label,type,required,options}], submitLabel} (the answer arrives as the member's next message), html {html} (sandboxed), image {url, caption}, output {outputId}. close_panel {id}. " +
        "Payment, checkout, plan, delete, sign-out, connect and approve controls, and password or card fields, are human-only: the result has humanRequired:true and the member sees a 'Your turn' highlight. Tell them, never try to work around it. If the result says stopped, the member pressed Stop: stop acting on the page.",
      parameters: Type.Object({
        action: Type.Union(["status", ...COMMAND_OPS, "show_panel", "close_panel"].map((a) => Type.Literal(a as string))),
        route: Type.Optional(Type.String({ description: "navigate: a KV path like /courses" })),
        name: Type.Optional(Type.String({ description: "Accessible name or visible text of the control" })),
        testid: Type.Optional(Type.String()),
        tour: Type.Optional(Type.String()),
        role: Type.Optional(Type.String({ description: "Narrow name: button, link, tab, textbox…" })),
        value: Type.Optional(Type.String({ description: "type: the text" })),
        text: Type.Optional(Type.String({ description: "highlight: caption. say: the message." })),
        to: Type.Optional(Type.String({ description: "scroll: top | bottom" })),
        id: Type.Optional(Type.String({ description: "Panel id (replace or close it)" })),
        kind: Type.Optional(Type.Union(PANEL_KINDS.map((k: string) => Type.Literal(k)))),
        title: Type.Optional(Type.String()),
        markdown: Type.Optional(Type.String()),
        html: Type.Optional(Type.String()),
        url: Type.Optional(Type.String()),
        caption: Type.Optional(Type.String()),
        outputId: Type.Optional(Type.String()),
        columns: Type.Optional(Type.Array(Type.String())),
        rows: Type.Optional(Type.Array(Type.Unknown())),
        chartType: Type.Optional(Type.String()),
        labels: Type.Optional(Type.Array(Type.String())),
        series: Type.Optional(Type.Array(Type.Unknown())),
        fields: Type.Optional(Type.Array(Type.Unknown())),
        submitLabel: Type.Optional(Type.String()),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        const state = loadState();
        if (!state) throw new Error("KinglyVault Connect is not linked on this InfiniBot.");
        if (!(state.grantedScopes ?? []).includes("ui.control")) {
          throw new Error("This link has no page control yet. Ask the member to reconnect KinglyVault and allow it.");
        }
        const result = await uiHub.tool(params);
        return { content: [{ type: "text", text: JSON.stringify(result).slice(0, 30_000) }], details: result };
      },
    } as never);
  },
};

export default plugin;
