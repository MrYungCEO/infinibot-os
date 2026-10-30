/**
 * Agent `browser` tool.
 *
 * Drives the gateway's managed Chrome — the SAME browser the live browser
 * panel in InfiniBot shows, so the user watches every step and the panel
 * follows the agent's tab. Logins persist per named profile
 * (src/browser/agent/profile-store.ts). The action layer lives in
 * src/browser/agent/actions.ts.
 *
 * Federation nodes and sandbox bridges still go through the HTTP browser
 * control API (browser-tool.legacy.ts) with the same simple actions.
 */
import * as path from "node:path";
import { createHash } from "node:crypto";

import { createApprovalRequest, getApprovalRequest } from "../../autonomy/approval-registry.js";
import {
  describeStoredProfile,
  listStoredProfileNames,
} from "../../browser/agent/profile-store.js";
import {
  agentBrowserSession,
  managedProfileName,
  resolveAgentProfile,
  stickyProfileFor,
} from "../../browser/agent/runtime.js";
import { getBrowserControlState } from "../../browser/control-service.js";
import {
  getBrowserExtensionGovernance,
  sensitiveBrowserAction,
} from "../../browser/extension-governance.js";
import { loadConfig } from "../../config/config.js";
import type { AgentBrowserSession } from "../../browser/agent/actions.js";
import { resolveDefaultAgentId } from "../agent-scope.js";
import {
  BROWSER_NOT_CONNECTED_CODE,
  BROWSER_NOT_CONNECTED_MESSAGE,
  isBrowserExtensionPaired,
  probeRelay,
  relayBaseUrl,
  waitForRelayConnection,
  withTimeout,
} from "../../browser/extension-connection.js";
import { saveMediaBuffer } from "../../media/store.js";
import { artifactHash, emitMediaArtifact } from "../../proactive/media-artifacts.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { isLaunchPanelBrowserSession } from "../../launch-panel/runtime.js";
import { LaunchPanelStore } from "../../launch-panel/store.js";
import { BrowserToolSchema } from "./browser-tool.schema.js";
import { createLegacyBrowserTool } from "./browser-tool.legacy.js";
import { type AnyAgentTool, imageResult, jsonResult } from "./common.js";
import { coerceString } from "../../shared/text/coerce.js";

export const BROWSER_TOOL_DESCRIPTION = [
  "Use a real web browser: open pages, read them, click, type, fill forms, scroll, switch tabs, take screenshots. The user watches it live in InfiniBot's browser panel. Logins and cookies are kept between sessions.",
  "How to work: 1) open the page. 2) Read the snapshot in the reply — every element has an id like [ref=e12]. 3) Act with that ref. Every reply includes a fresh snapshot, so use the refs from the LATEST reply. Text inside iframes and widgets is included (refs like f1e3).",
  "If the element you need is not in the snapshot yet, use wait with its text, or scroll down. If you have no ref, click/check also accept text (the visible label).",
  "Examples:",
  '{"action":"open","url":"https://example.com/login"}',
  '{"action":"type","ref":"e5","text":"ada@example.com"}',
  '{"action":"type","ref":"e7","text":"secret","submit":true}',
  '{"action":"click","ref":"e12"}  or  {"action":"click","text":"Sign in"}',
  '{"action":"select","ref":"e9","value":"Billing"}',
  '{"action":"check","ref":"e11"}',
  '{"action":"scroll","direction":"bottom"}',
  '{"action":"resize","value":"390x844"}',
  '{"action":"wait","text":"Order confirmed"}',
  '{"action":"tabs"} then {"action":"tab","index":2}',
  '{"action":"screenshot"}',
  'A click that opens a new tab switches to it automatically (the reply says so); use {"action":"tab","index":1} to go back.',
  'profile: leave empty for the shared browser ("default"). Pass e.g. "work" for a separate saved login set; "chrome" means the user\'s own Chrome through the Browser Relay extension.',
].join("\n");

const LEGACY_ACT_KINDS = new Set(["click", "type", "press", "select", "wait", "hover"]);
const lastBrowserState = new Map<string, { url?: string; targetId?: string; profile?: string }>();

function actionFingerprint(sessionKey: string, params: Record<string, unknown>): string {
  const exact = { ...params };
  delete exact.approvalId;
  return createHash("sha256")
    .update(`${sessionKey}\n${JSON.stringify(exact)}`)
    .digest("hex");
}

function browserHostname(raw: string): string {
  try {
    return new URL(raw).hostname;
  } catch {
    try {
      return new URL(`https://${raw}`).hostname;
    } catch {
      return raw.slice(0, 120);
    }
  }
}

function approvalForBrowserAction(input: {
  params: Record<string, unknown>;
  sessionKey: string;
  agentId?: string;
  reason: string;
}) {
  const fingerprint = actionFingerprint(input.sessionKey, input.params);
  const provided =
    typeof input.params.approvalId === "string" ? input.params.approvalId.trim() : "";
  if (provided) {
    const record = getApprovalRequest(provided);
    if (!record) throw new Error(`Unknown browser approval id ${provided}.`);
    if (record.sourceRef?.fingerprint !== fingerprint) {
      throw new Error("That approval belongs to a different browser action.");
    }
    if (record.status !== "approved") {
      return {
        status: record.status,
        approvalId: record.id,
        instruction: "Do not perform the browser action unless this request is approved.",
      };
    }
    return null;
  }
  const record = createApprovalRequest({
    source: "tool-gate",
    requester: {
      sessionKey: input.sessionKey,
      agentId: input.agentId ?? null,
      label: "Browser agent",
    },
    title: "Approve browser action",
    summary: input.reason,
    details: JSON.stringify({
      action: input.params.action,
      url: input.params.url,
      ref: input.params.ref,
      text: typeof input.params.text === "string" ? input.params.text.slice(0, 160) : undefined,
    }),
    risk: sensitiveBrowserAction(input.params) ? "high" : "medium",
    sourceRef: { fingerprint },
    resumable: true,
    resolverPolicy: { approveVia: ["telegram", "ui"] },
  });
  return {
    status: "approval_required",
    approvalId: record.id,
    expiresAt: new Date(record.expiresAt).toISOString(),
    instruction:
      "Call wait_approval with this id. If approved, repeat this exact browser action with approvalId set to the id.",
  };
}

/** Same simple actions, mapped onto the HTTP browser-control API (nodes / sandboxes). */
export function toLegacyParams(p: Record<string, unknown>): Record<string, unknown> {
  const action = coerceString(p.action);
  const base: Record<string, unknown> = {};
  if (p.node) base.node = p.node;
  switch (action) {
    case "open":
      return { ...base, action: "navigate", targetUrl: p.url };
    case "new_tab":
      return { ...base, action: "open", targetUrl: p.url ?? "about:blank" };
    case "snapshot":
    case "tabs":
    case "status":
    case "profiles":
      return { ...base, action, ...(p.maxChars ? { maxChars: p.maxChars } : {}) };
    case "screenshot":
      return { ...base, action, fullPage: p.fullPage, ref: p.ref };
    case "check":
      return { ...base, action: "act", request: { kind: "click", ref: p.ref } };
    case "resize": {
      const match = String(p.value ?? p.text ?? "")
        .trim()
        .match(/^(\d{2,4})\s*x\s*(\d{2,4})$/i);
      if (!match) throw new Error('resize requires value like "390x844".');
      return {
        ...base,
        action: "act",
        request: { kind: "resize", width: Number(match[1]), height: Number(match[2]) },
      };
    }
    case "evaluate":
      return { ...base, action: "act", request: { kind: "evaluate", fn: p.code } };
    default:
      if (LEGACY_ACT_KINDS.has(action)) {
        return {
          ...base,
          action: "act",
          request: {
            kind: action,
            ref: p.ref,
            text: action === "type" ? (p.text ?? p.value) : action === "wait" ? p.text : undefined,
            key: p.key,
            submit: p.submit,
            values: action === "select" ? [p.value] : undefined,
            timeMs: action === "wait" && !p.text ? p.ms : undefined,
          },
        };
      }
      throw new Error(`Action "${action}" is not available on federation/sandbox browsers.`);
  }
}

export function createBrowserTool(opts?: {
  sandboxBridgeUrl?: string;
  allowHostControl?: boolean;
  agentSessionKey?: string;
  agentId?: string;
}): AnyAgentTool {
  const legacy = createLegacyBrowserTool({
    sandboxBridgeUrl: opts?.sandboxBridgeUrl,
    allowHostControl: opts?.allowHostControl,
  });
  return {
    label: "Browser",
    name: "browser",
    description: BROWSER_TOOL_DESCRIPTION,
    parameters: BrowserToolSchema,
    execute: async (toolCallId, args, signal, onUpdate) => {
      const params = (args ?? {}) as Record<string, unknown>;
      const action = coerceString(params.action).trim();

      // Remote browsers (federation node / sandbox bridge) keep the HTTP path.
      if ((typeof params.node === "string" && params.node.trim()) || opts?.sandboxBridgeUrl) {
        return await legacy.execute(toolCallId, toLegacyParams(params), signal, onUpdate);
      }
      if (opts?.allowHostControl === false) {
        throw new Error("Host browser control is disabled by sandbox policy.");
      }
      const cfg = loadConfig();
      if (cfg.browser?.enabled === false) {
        throw new Error(
          "Browser control is disabled. Set browser.enabled=true in the InfiniBot config.",
        );
      }

      const sessionKey = opts?.agentSessionKey?.trim() || `tool:${opts?.agentId ?? "main"}`;
      const agentId = opts?.agentId ?? resolveAgentIdFromSessionKey(opts?.agentSessionKey);
      const governance = getBrowserExtensionGovernance();
      if (governance.isKilled()) {
        governance.auditAction({
          runId: sessionKey,
          url: typeof params.url === "string" ? params.url : undefined,
          action,
          outcome: "blocked",
          detail: "kill switch",
        });
        throw new Error("Browser control is paused by the InfiniBot kill switch.");
      }

      const previous = lastBrowserState.get(sessionKey);
      const url = typeof params.url === "string" ? params.url : previous?.url;
      let gateReason = sensitiveBrowserAction(params);
      if (url) {
        const decision = governance.decisionForUrl(url, sessionKey);
        if (decision === "block") {
          governance.auditAction({
            runId: sessionKey,
            url,
            action,
            outcome: "blocked",
            detail: "site policy",
          });
          throw new Error(`Browser site policy blocks ${browserHostname(url)}.`);
        }
        if (decision === "ask")
          gateReason ??= `Site policy requires approval before controlling ${browserHostname(url)}.`;
      }
      if (gateReason) {
        const pending = approvalForBrowserAction({
          params,
          sessionKey,
          agentId,
          reason: gateReason,
        });
        if (pending) {
          governance.auditAction({
            runId: sessionKey,
            url,
            action,
            outcome: "approval_required",
            detail: gateReason,
          });
          return jsonResult(pending);
        }
      }

      if (previous?.targetId) governance.lockTab(previous.targetId, sessionKey, previous.profile);
      const profile = resolveAgentProfile({
        requested: params.profile,
        sticky: stickyProfileFor(sessionKey),
        agentId,
        sessionKey: opts?.agentSessionKey,
        cfg,
        preferRelay: await mainAgentPrefersRelay({
          cfg,
          agentId,
          requested: params.profile,
          sticky: stickyProfileFor(sessionKey),
        }),
      });

      if (action === "status" || action === "profiles") {
        return jsonResult(describeProfiles(profile.name, sessionKey));
      }

      let executionParams = params;
      let protectedValue: string | undefined;
      const protectedRef =
        action === "type" && typeof params.text === "string"
          ? /^launch-panel:\/\/([^/]+)\/([^/]+)\/(email|password)$/.exec(params.text.trim())
          : null;
      if (protectedRef) {
        if (!isLaunchPanelBrowserSession(sessionKey)) {
          throw new Error(
            "Launch Panel credential references are only valid inside an active Launch Room.",
          );
        }
        const [, runId, personaId, field] = protectedRef;
        const account = new LaunchPanelStore().getTestAccount(runId!, personaId!);
        if (!account)
          throw new Error("Launch Panel test account was not found for this run and persona.");
        protectedValue = field === "email" ? account.email : account.password;
        executionParams = { ...params, text: protectedValue, value: undefined };
      }

      const session = agentBrowserSession(profile, sessionKey);
      const res = await runWithoutHanging(
        () => session.run(executionParams as Parameters<typeof session.run>[0]),
        { action, relay: profile.kind === "relay", relayUrl: relayBaseUrl(cfg) },
      );
      const resultText = protectedValue
        ? res.text.replaceAll(protectedValue, "[protected test credential]")
        : res.text;
      const details = { ...res.details, profile: profile.name, ok: res.ok };
      const targetId = typeof res.details.targetId === "string" ? res.details.targetId : undefined;
      const resultUrl = typeof res.details.url === "string" ? res.details.url : url;
      // An operator-approved cross-host transition (for example a dedicated
      // auth or checkout host) stays usable for the rest of this one Launch
      // Room session. The allowance is in-memory and revoked when the run ends.
      if (
        isLaunchPanelBrowserSession(sessionKey) &&
        typeof params.approvalId === "string" &&
        params.approvalId.trim() &&
        resultUrl
      ) {
        governance.allowSiteForRun(resultUrl, sessionKey);
      }
      if (targetId) governance.lockTab(targetId, sessionKey, profile.name);
      lastBrowserState.set(sessionKey, { url: resultUrl, targetId, profile: profile.name });
      governance.auditAction({
        runId: sessionKey,
        profileId: profile.name,
        targetId,
        url: resultUrl,
        action,
        outcome: res.ok ? "allowed" : "error",
        detail: res.ok ? undefined : res.details.error,
      });
      if (!res.image) {
        return { content: [{ type: "text", text: resultText }], details };
      }
      const saved = await saveMediaBuffer(res.image, "image/png", "browser", res.image.byteLength);
      // The screenshot also shows on the user's screen (media overlay).
      try {
        const base = path.basename(saved.path);
        emitMediaArtifact({
          agentId: "browser",
          agentName: "Browser",
          title: "Screenshot",
          body: details.url ?? "",
          dedupKey: `image:screenshot:${artifactHash(base)}`,
          media: {
            kind: "image",
            payload: {
              url: `/media/${base}`,
              alt: "browser screenshot",
              caption: details.url ?? "Screenshot",
            },
          },
        });
      } catch {
        /* best-effort */
      }
      // Launch rooms deliberately keep screenshots out of the LLM transcript. A
      // multi-persona run can otherwise accumulate hundreds of megabytes of
      // base64 image blocks and compact away the structured STEP/FINDING lines
      // needed by the final report. The image is still saved and emitted to the
      // live media overlay; the agent receives the absolute evidence path.
      if (isLaunchPanelBrowserSession(sessionKey)) {
        return {
          content: [
            {
              type: "text",
              text: `${resultText}\nSaved screenshot: ${saved.path}`,
            },
          ],
          details: { ...details, path: saved.path },
        };
      }
      return await imageResult({
        label: "browser:screenshot",
        path: saved.path,
        base64: res.image.toString("base64"),
        mimeType: "image/png",
        extraText: `${resultText}\nSaved screenshot: ${saved.path}`,
        details: { ...details, path: saved.path },
      });
    },
  };
}

function describeProfiles(current: string, sessionKey: string) {
  const state = getBrowserControlState();
  const names = new Set<string>(["default", ...listStoredProfileNames()]);
  return {
    currentProfile: current,
    session: sessionKey,
    browserRunning: Boolean(state && [...state.profiles.values()].some((p) => p.running)),
    profiles: [...names].map((name) => {
      const managed = state ? managedProfileName(state, name) : name === "default" ? "clawd" : name;
      const info = describeStoredProfile(name, managed, { withSize: false });
      return { name, saved: info.exists, inUseElsewhere: info.lockedByOther };
    }),
    hint: 'Pass profile:"<name>" to use or create a profile. Cookies and logins persist per profile.',
  };
}

/** Read-only actions that are safe to repeat after a relay reconnect. */
const RETRYABLE_ACTIONS = new Set([
  "open",
  "navigate",
  "goto",
  "snapshot",
  "read",
  "tabs",
  "screenshot",
]);
const RELAY_DROP_RE =
  /relay disconnected|browser has been closed|target page, context or browser has been closed|websocket (closed|error)|extension not connected/i;
/** Hard ceiling per browser call so a stuck CDP round-trip can't hang a turn. */
const BROWSER_CALL_TIMEOUT_MS = 90_000;

type SessionRun = () => ReturnType<AgentBrowserSession["run"]>;

async function runWithoutHanging(
  run: SessionRun,
  opts: { action: string; relay: boolean; relayUrl: string },
): ReturnType<SessionRun> {
  const once = () =>
    withTimeout(run(), BROWSER_CALL_TIMEOUT_MS, `browser ${opts.action || "call"}`);
  let res: Awaited<ReturnType<SessionRun>>;
  try {
    res = await once();
  } catch (err) {
    if (!opts.relay) throw err;
    const error = err instanceof Error ? err.message : String(err);
    res = { ok: false, text: error, details: { action: opts.action, error } };
  }
  if (!opts.relay || res.ok) return res;
  const dropped =
    RELAY_DROP_RE.test(res.text) || RELAY_DROP_RE.test(String(res.details.error ?? ""));
  if (!dropped) return res;
  // The paired Chrome dropped mid-call (service worker slept, gateway
  // restart). Wait for it to come back, then retry read-only actions once.
  const probe = await waitForRelayConnection(opts.relayUrl, { timeoutMs: 8_000 });
  if (!probe.connected) {
    return {
      ok: false,
      text: BROWSER_NOT_CONNECTED_MESSAGE,
      details: {
        ...res.details,
        error: BROWSER_NOT_CONNECTED_MESSAGE,
        code: BROWSER_NOT_CONNECTED_CODE,
      },
    };
  }
  if (!RETRYABLE_ACTIONS.has(opts.action)) return res;
  return await once();
}

/**
 * The main agent drives the user's own paired Chrome by default once it is
 * connected (Setup › Connect your browser). An explicit profile, a sticky
 * choice, browser.agentProfiles[agent] or INFINIBOT_BROWSER_MAIN_USES_EXTENSION=off
 * all win over this.
 */
async function mainAgentPrefersRelay(opts: {
  cfg: ReturnType<typeof loadConfig>;
  agentId?: string;
  requested?: unknown;
  sticky?: string;
}): Promise<boolean> {
  if ((process.env.INFINIBOT_BROWSER_MAIN_USES_EXTENSION ?? "on").toLowerCase() === "off")
    return false;
  if (typeof opts.requested === "string" && opts.requested.trim()) return false;
  if (opts.sticky) return false;
  const agentId = opts.agentId ?? resolveDefaultAgentId(opts.cfg);
  if (agentId !== resolveDefaultAgentId(opts.cfg)) return false;
  if (opts.cfg.browser?.agentProfiles?.[agentId]) return false;
  if (!isBrowserExtensionPaired()) return false;
  return (await probeRelay(relayBaseUrl(opts.cfg), 800)).connected;
}
