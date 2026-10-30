/**
 * Subscription CLI routing RPCs — onboarding "AI brain" step + Setup › Coders.
 *
 *   cliRouting.status  (read)   on/off, fallback order, per-CLI installed /
 *                               signed-in / model, per-agent routing, CLIs we
 *                               can't drive (Antigravity) and why.
 *   cliRouting.set     (write)  { enabled?, providers?, models?, fallbackToApi?,
 *                               tools?, allTraffic?, agentId?,
 *                               agentEnabled?: true|false|null }
 *   cliRouting.login   (write)  { provider } → opens the CLI's own sign-in in
 *                               an InfiniBot terminal ({ terminalId, command }).
 *
 * Routing itself lives in src/agents/cli-routing.ts; the CLIs are model
 * providers (claude-cli, codex-cli, gemini-cli, grok-cli, opencode-cli).
 */

import {
  loadConfig,
  parseConfigJson5,
  readConfigFileSnapshot,
  validateConfigObjectWithPlugins,
  writeConfigFile,
} from "../../config/config.js";
import type { InfinibotConfig } from "../../config/types.infinibot.js";
import { listAgentIds, resolveAgentCliRouting } from "../../agents/agent-scope.js";
import { resolveCliBackendConfig } from "../../agents/cli-backends.js";
import {
  CLI_ROUTING_PROVIDERS,
  CLI_ROUTING_UNSUPPORTED,
  getCliProviderInfo,
  isCliRoutingAllTraffic,
  resolveCliRoutingAvailability,
  resolveCliRoutingModel,
  resolveCliRoutingOrder,
} from "../../agents/cli-routing.js";
import { getCoderEntry, type CoderId } from "../../agents/coder-install/catalog.js";
import { coderStatus, invalidateCoderStatus } from "../../agents/coder-install/status.js";
import { resolveBin } from "../../agents/coder-backend/bin-detect.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { getTerminalManager } from "./terminal.js";
import { startLogin } from "../../agents/coder-install/login.js";
import {
  applyCliRoutingSet,
  cliRoutingAvailable,
  testCliProvider,
  type CliRoutingSetParams,
} from "../../agents/cli-routing-setup.js";

export { applyCliRoutingSet, cliRoutingAvailable, testCliProvider };
import type { GatewayRequestHandlers } from "./types.js";

export const CLI_ROUTING_READ_METHODS = ["cliRouting.status"] as const;
export const CLI_ROUTING_WRITE_METHODS = [
  "cliRouting.set",
  "cliRouting.login",
  "cliRouting.connect",
] as const;

type Auth = "signed-in" | "signed-out" | "api-key" | "env" | "unknown" | "n/a";

export type CliRoutingBackendView = {
  id: string;
  label: string;
  vendor: string;
  plan: string;
  command: string;
  installed: boolean;
  version?: string;
  binPath?: string;
  auth: Auth;
  ready: boolean;
  localOnly: boolean;
  model: string;
  inOrder: boolean;
  installUrl: string;
  coderId: string | null;
  /** Beginner card title ("ChatGPT") and button ("Sign in with ChatGPT"). */
  account: string;
  signInLabel: string;
  free: boolean;
  /** The default pick for people who have none of the paid plans. */
  recommended: boolean;
  /** "browser": cliRouting.login returns a sign-in URL; "terminal": opens a terminal. */
  loginMode: "browser" | "terminal";
};

async function backendView(cfg: InfinibotConfig, id: string, order: string[]) {
  const info = getCliProviderInfo(id)!;
  const backend = resolveCliBackendConfig(id, cfg)?.config;
  const command = backend?.command ?? info.command;
  const entry = info.coderId ? getCoderEntry(info.coderId) : undefined;
  let installed = false;
  let version: string | undefined;
  let binPath: string | undefined;
  let auth: Auth = "unknown";
  if (entry && command === entry.bin) {
    const st = await coderStatus(entry).catch(() => null);
    installed = Boolean(st?.installed);
    version = st?.version;
    binPath = st?.binPath;
    auth = (st?.auth as Auth | undefined) ?? "unknown";
  } else {
    binPath = resolveBin(command);
    installed = Boolean(binPath);
  }
  const view: CliRoutingBackendView = {
    id,
    label: info.label,
    vendor: info.vendor,
    plan: info.plan,
    command,
    installed,
    version,
    binPath,
    auth,
    ready: installed && (auth === "signed-in" || auth === "unknown"),
    localOnly: backend?.localOnly === true,
    model: resolveCliRoutingModel(cfg, id),
    inOrder: order.includes(id),
    installUrl: info.installUrl,
    coderId: info.coderId,
    account: info.account,
    signInLabel: info.signInLabel,
    free: info.free,
    recommended: info.free,
    loginMode: entry?.auth.some((a) => a.kind === "oauth-login" && a.loginArgs?.length)
      ? "browser"
      : "terminal",
  };
  return view;
}

export async function buildCliRoutingStatus(cfg: InfinibotConfig = loadConfig()) {
  const order = resolveCliRoutingOrder(cfg);
  const backends = await Promise.all(
    CLI_ROUTING_PROVIDERS.map((p) => backendView(cfg, p.id, order)),
  );
  // Order-first so the UI can render the fallback list as-is.
  backends.sort((a, b) => {
    const ai = order.indexOf(a.id);
    const bi = order.indexOf(b.id);
    return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
  });
  const active = order.find((id) => backends.find((b) => b.id === id)?.ready) ?? null;
  const list = Array.isArray(cfg.agents?.list) ? cfg.agents.list : [];
  const agents = listAgentIds(cfg).map((agentId) => {
    const entry = list.find((a) => a && normalizeAgentId(a.id) === agentId);
    return {
      id: agentId,
      name: entry?.name,
      routed: resolveAgentCliRouting(cfg, agentId) !== null,
      override: typeof entry?.cliRouting === "boolean" ? entry.cliRouting : null,
    };
  });
  const availability = resolveCliRoutingAvailability();
  return {
    // A shared multi-tenant cloud gateway can't keep sign-ins apart: the UI
    // shows `unavailableReason` instead of the cards. Tenant Machines can.
    available: availability.available,
    where: availability.where,
    ...(availability.reason ? { unavailableReason: availability.reason } : {}),
    enabled: cfg.cliRoutingEnabled === true,
    allTraffic: isCliRoutingAllTraffic(cfg),
    providers: order,
    fallbackToApi: cfg.cliRouting?.fallbackToApi === true,
    tools: cfg.cliRouting?.tools !== false,
    active,
    backends,
    unsupported: CLI_ROUTING_UNSUPPORTED,
    agents,
  };
}

function shellQuote(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

export const cliRoutingHandlers: GatewayRequestHandlers = {
  "cliRouting.status": async ({ respond }) => {
    try {
      respond(true, await buildCliRoutingStatus());
    } catch (err) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(err) });
    }
  },

  "cliRouting.set": async ({ params, respond }) => {
    try {
      const snapshot = await readConfigFileSnapshot();
      const parsed = parseConfigJson5(snapshot.raw ?? "{}");
      const raw: InfinibotConfig =
        parsed.ok && parsed.parsed && typeof parsed.parsed === "object"
          ? (parsed.parsed as InfinibotConfig)
          : ({} as InfinibotConfig);
      const req = (params ?? {}) as CliRoutingSetParams;
      const availability = resolveCliRoutingAvailability();
      if (!availability.available && (req.enabled === true || req.allTraffic === true)) {
        respond(false, undefined, {
          code: "UNAVAILABLE",
          message: availability.reason ?? "Not available here.",
        });
        return;
      }
      let next: InfinibotConfig;
      try {
        next = applyCliRoutingSet(raw, req);
      } catch (err) {
        respond(false, undefined, { code: "INVALID_REQUEST", message: (err as Error).message });
        return;
      }
      const validation = validateConfigObjectWithPlugins(next);
      if (!validation.ok) {
        respond(false, undefined, {
          code: "INVALID_REQUEST",
          message: `Invalid config: ${validation.issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`,
        });
        return;
      }
      await writeConfigFile(next);
      respond(true, await buildCliRoutingStatus(loadConfig()));
    } catch (err) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(err) });
    }
  },

  "cliRouting.login": async ({ params, respond }) => {
    const id = String((params as { provider?: unknown })?.provider ?? "")
      .trim()
      .toLowerCase();
    const info = getCliProviderInfo(id);
    if (!info) {
      respond(false, undefined, { code: "NOT_FOUND", message: `Unknown CLI provider: ${id}` });
      return;
    }
    const availability = resolveCliRoutingAvailability();
    if (!availability.available) {
      respond(false, undefined, {
        code: "UNAVAILABLE",
        message: availability.reason ?? "Not available here.",
      });
      return;
    }
    const cfg = loadConfig();
    const view = await backendView(cfg, id, resolveCliRoutingOrder(cfg));
    if (!view.installed) {
      respond(false, undefined, {
        code: "NOT_INSTALLED",
        message: `${info.label} isn't installed yet. Install it first.`,
      });
      return;
    }
    const wanted =
      (params as { mode?: unknown })?.mode === "terminal" ? "terminal" : view.loginMode;
    if (wanted === "browser" && info.coderId) {
      // The CLI's own sign-in runs in a PTY; the UI opens session.url in the
      // browser and polls coders.login.poll { sessionId } until it succeeds.
      const res = await startLogin(info.coderId as CoderId);
      if (res.ok) {
        invalidateCoderStatus();
        respond(true, { mode: "browser", session: res.session });
        return;
      }
      if (res.code !== "UNSUPPORTED") {
        respond(false, undefined, { code: res.code, message: res.message });
        return;
      }
    }
    const manager = getTerminalManager();
    if (!manager) {
      respond(false, undefined, { code: "UNAVAILABLE", message: "Terminals are not available." });
      return;
    }
    const command = [view.binPath ?? view.command, ...info.loginArgs].map(shellQuote).join(" ");
    const created = await manager.create({
      title: `Sign in: ${info.label}`,
      skipOAuthToken: true,
    });
    if (!created.success || !created.terminalId) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: created.error ?? "Could not open a terminal.",
      });
      return;
    }
    const terminalId = created.terminalId;
    // Let the shell print its prompt before typing the command.
    setTimeout(() => manager.write(terminalId, `${command}\r`), 600).unref?.();
    // The next status read re-probes sign-in.
    invalidateCoderStatus();
    respond(true, { mode: "terminal", terminalId, command });
  },

  /**
   * { provider } → one tiny test turn through that CLI; on success routing is
   * switched on with it first in the order. Nothing changes on failure.
   */
  "cliRouting.connect": async ({ params, respond }) => {
    const id = String((params as { provider?: unknown })?.provider ?? "")
      .trim()
      .toLowerCase();
    if (!getCliProviderInfo(id)) {
      respond(false, undefined, { code: "NOT_FOUND", message: `Unknown CLI provider: ${id}` });
      return;
    }
    const availability = resolveCliRoutingAvailability();
    if (!availability.available) {
      respond(false, undefined, {
        code: "UNAVAILABLE",
        message: availability.reason ?? "Not available here.",
      });
      return;
    }
    try {
      const cfg = loadConfig();
      const test = await testCliProvider(cfg, id);
      if (!test.ok) {
        respond(true, { ok: false, code: test.code, message: test.message, ms: test.ms });
        return;
      }
      const snapshot = await readConfigFileSnapshot();
      const parsed = parseConfigJson5(snapshot.raw ?? "{}");
      const raw: InfinibotConfig =
        parsed.ok && parsed.parsed && typeof parsed.parsed === "object"
          ? (parsed.parsed as InfinibotConfig)
          : ({} as InfinibotConfig);
      const order = resolveCliRoutingOrder(raw).filter((p) => p !== id);
      const next = applyCliRoutingSet(raw, { enabled: true, providers: [id, ...order] });
      const validation = validateConfigObjectWithPlugins(next);
      if (!validation.ok) {
        respond(false, undefined, {
          code: "INVALID_REQUEST",
          message: `Invalid config: ${validation.issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`,
        });
        return;
      }
      await writeConfigFile(next);
      respond(true, {
        ok: true,
        reply: test.reply,
        ms: test.ms,
        status: await buildCliRoutingStatus(loadConfig()),
      });
    } catch (err) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(err) });
    }
  },
};

/** Exported for tests: coder ids routing relies on exist in the catalog. */
export function cliRoutingCoderIds(): CoderId[] {
  return CLI_ROUTING_PROVIDERS.map((p) => p.coderId).filter(Boolean) as CoderId[];
}
