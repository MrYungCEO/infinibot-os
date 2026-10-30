/**
 * Secure Mode RPCs — the single source of truth for the toggle (secure.status
 * / secure.set, broadcast as `secure.mode.changed`) and the only way into the
 * encrypted secure lane (kanban, documents, knowledge graph).
 *
 * These handlers are deliberately NOT wrapped in proxyMethodsToMaster: a
 * federation satellite serves its own secure lane and never forwards secure
 * data to another node.
 */

import { resolveModel } from "../../agents/pi-embedded-runner/model.js";
import { parseScopeParams, scopeSnapshotToProject } from "./graph-project-scope.js";
import {
  loadConfig,
  parseConfigJson5,
  readConfigFileSnapshot,
  validateConfigObjectWithPlugins,
  writeConfigFile,
} from "../../config/config.js";
import type { InfinibotConfig } from "../../config/types.infinibot.js";
import { listSecureModelCandidates } from "../../secure-mode/local-models.js";
import { SecureKeyUnavailableError } from "../../secure-mode/keyring.js";
import {
  broadcastSecureLaneChanged,
  broadcastSecureModeChanged,
} from "../../secure-mode/events.js";
import { SecureLaneError } from "../../secure-mode/lane-store.js";
import {
  checkSecureModelAsync,
  checkSecureTool,
  SECURE_TOOL_ALLOWLIST,
} from "../../secure-mode/policy.js";
import { getSecureModeRuntime, SecureModeLockedError } from "../../secure-mode/runtime.js";
import { localProvidersEnabled } from "../../saas/config.js";
import { newSecureSessionKey } from "../../secure-mode/session-key.js";
import {
  getResearchApprovals,
  ResearchApprovalError,
} from "../../secure-mode/research/approvals.js";
import { resolveSecureResearchConfig } from "../../secure-mode/research/service.js";
import { ResearchStore } from "../../secure-mode/research/store.js";
import { SecureVaultError } from "../../secure-mode/vault.js";
import type { GatewayRequestHandlerOptions, GatewayRequestHandlers } from "./types.js";

type Respond = GatewayRequestHandlerOptions["respond"];

function fail(respond: Respond, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  const code =
    err instanceof SecureModeLockedError
      ? "SECURE_MODE_LOCKED"
      : err instanceof SecureLaneError
        ? "INVALID_REQUEST"
        : err instanceof SecureKeyUnavailableError || err instanceof SecureVaultError
          ? "UNAVAILABLE"
          : "INTERNAL_ERROR";
  respond(false, undefined, { code, message });
}

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

function params(opts: GatewayRequestHandlerOptions): Record<string, unknown> {
  return (opts.params ?? {}) as Record<string, unknown>;
}

function lane() {
  return getSecureModeRuntime().requireLane();
}

async function modelVerdict(ref: string) {
  const cfg = loadConfig();
  const slash = ref.indexOf("/");
  if (slash <= 0)
    return { allowed: false as const, reason: `model must be "provider/model", got "${ref}"` };
  const provider = ref.slice(0, slash).trim();
  const modelId = ref.slice(slash + 1).trim();
  let baseUrl: string | undefined;
  try {
    baseUrl = (
      resolveModel(provider, modelId, undefined, cfg).model as { baseUrl?: string } | undefined
    )?.baseUrl;
  } catch {
    // fall back to the configured provider baseUrl inside checkSecureModel
  }
  return checkSecureModelAsync({ provider, modelId, baseUrl, cfg });
}

/** Secure Mode runs on local models; hosts without local providers (InfiniBot Cloud) can't offer it. */
const SECURE_UNAVAILABLE_REASON =
  "Secure Mode keeps work on local models on your own machine, so it isn't available on InfiniBot Cloud.";

export const secureModeHandlers: GatewayRequestHandlers = {
  "secure.status": async ({ respond }) => {
    try {
      respond(true, {
        ...getSecureModeRuntime().status(),
        available: localProvidersEnabled(),
        ...(localProvidersEnabled() ? {} : { unavailableReason: SECURE_UNAVAILABLE_REASON }),
        allowedTools: [...SECURE_TOOL_ALLOWLIST, ...(loadConfig().secureMode?.allowTools ?? [])],
        // This build enforces agents.list[].secureOnly (set via agents.management.update).
        agentPolicy: true,
        // Remote models auto-switch to a local one (secure.models / secure.defaultModel.set).
        modelSwitch: true,
        defaultModel: loadConfig().secureMode?.defaultModel ?? null,
        // secure_research + secure.research.* (approval card, log panel).
        research: (() => {
          const rc = resolveSecureResearchConfig(loadConfig());
          return {
            enabled: rc.enabled,
            approval: rc.approval,
            searxngUrl: rc.searxngUrl,
            proxy: Boolean(rc.proxy),
          };
        })(),
      });
    } catch (err) {
      fail(respond, err);
    }
  },

  "secure.set": async (opts) => {
    try {
      const p = params(opts);
      if (typeof p.enabled !== "boolean") {
        opts.respond(false, undefined, {
          code: "INVALID_REQUEST",
          message: "enabled (boolean) is required",
        });
        return;
      }
      if (p.enabled && !localProvidersEnabled()) {
        opts.respond(false, undefined, { code: "UNAVAILABLE", message: SECURE_UNAVAILABLE_REASON });
        return;
      }
      const status = await getSecureModeRuntime().setEnabled(p.enabled);
      // Locking drops pending research approvals: nothing can be sent while off.
      if (!p.enabled) getResearchApprovals().clear();
      broadcastSecureModeChanged(status);
      opts.respond(true, status);
    } catch (err) {
      fail(opts.respond, err);
    }
  },

  /** Mint a key for a new secure 1:1 chat (the UI may also build it itself). */
  "secure.session.new": async (opts) => {
    try {
      if (!getSecureModeRuntime().isUnlocked()) throw new SecureModeLockedError();
      const agentId = str(params(opts).agentId) || "main";
      opts.respond(true, { sessionKey: newSecureSessionKey(agentId) });
    } catch (err) {
      fail(opts.respond, err);
    }
  },

  /** Would this model / tool be allowed in a secure run? Never runs anything. */
  "secure.check": async (opts) => {
    try {
      const p = params(opts);
      const out: Record<string, unknown> = {};
      const model = str(p.model);
      const tool = str(p.tool);
      if (model) out.model = { ref: model, ...(await modelVerdict(model)) };
      if (tool) out.tool = { name: tool, ...checkSecureTool(tool, loadConfig()) };
      opts.respond(true, out);
    } catch (err) {
      fail(opts.respond, err);
    }
  },

  /**
   * Local models a secure run can use, in preference order, each with
   * local/reachable flags; `suggested` is what an unset default resolves to.
   */
  "secure.models": async (opts) => {
    try {
      const cfg = loadConfig();
      const agentId = str(params(opts).agentId) || undefined;
      const candidates = await listSecureModelCandidates({ cfg, agentId });
      const best = candidates.find((c) => c.reachable) ?? null;
      opts.respond(true, {
        defaultModel: cfg.secureMode?.defaultModel ?? null,
        suggested: best?.ref ?? null,
        candidates,
      });
    } catch (err) {
      fail(opts.respond, err);
    }
  },

  /** Set (or clear with null/"") secureMode.defaultModel. Local models only; no restart. */
  "secure.defaultModel.set": async (opts) => {
    try {
      const raw = params(opts).model;
      const ref = typeof raw === "string" ? raw.trim() : "";
      if (ref) {
        const verdict = await modelVerdict(ref);
        if (!verdict.allowed) {
          opts.respond(false, undefined, {
            code: "INVALID_REQUEST",
            message: "reason" in verdict ? verdict.reason : "model is not local",
          });
          return;
        }
      }
      const snapshot = await readConfigFileSnapshot();
      const parsed = parseConfigJson5(snapshot.raw ?? "{}");
      const config: InfinibotConfig =
        parsed.ok && parsed.parsed && typeof parsed.parsed === "object"
          ? (parsed.parsed as InfinibotConfig)
          : ({} as InfinibotConfig);
      const sm = { ...config.secureMode };
      if (ref) sm.defaultModel = ref;
      else delete sm.defaultModel;
      if (Object.keys(sm).length > 0) config.secureMode = sm;
      else delete config.secureMode;
      const validation = validateConfigObjectWithPlugins(config);
      if (!validation.ok) {
        opts.respond(false, undefined, {
          code: "INVALID_REQUEST",
          message: `Invalid config: ${validation.issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`,
        });
        return;
      }
      await writeConfigFile(config);
      opts.respond(true, { defaultModel: ref || null });
    } catch (err) {
      fail(opts.respond, err);
    }
  },

  // ── kanban ───────────────────────────────────────────────────────────────
  "secure.kanban.list": async ({ respond }) => {
    try {
      respond(true, lane().listKanban());
    } catch (err) {
      fail(respond, err);
    }
  },
  "secure.kanban.projects.create": async (opts) => {
    try {
      const project = lane().createProject(params(opts));
      broadcastSecureLaneChanged("kanban");
      opts.respond(true, { project });
    } catch (err) {
      fail(opts.respond, err);
    }
  },
  "secure.kanban.projects.delete": async (opts) => {
    try {
      const ok = lane().deleteProject(str(params(opts).id));
      broadcastSecureLaneChanged("kanban");
      opts.respond(true, { ok });
    } catch (err) {
      fail(opts.respond, err);
    }
  },
  "secure.kanban.tasks.create": async (opts) => {
    try {
      const task = lane().createTask(params(opts));
      broadcastSecureLaneChanged("kanban");
      opts.respond(true, { task });
    } catch (err) {
      fail(opts.respond, err);
    }
  },
  "secure.kanban.tasks.update": async (opts) => {
    try {
      const p = params(opts);
      const patch = (p.patch && typeof p.patch === "object" ? p.patch : p) as Record<
        string,
        unknown
      >;
      const { id: _id, ...rest } = patch;
      const task = lane().updateTask(str(p.id), rest);
      broadcastSecureLaneChanged("kanban");
      opts.respond(true, { task });
    } catch (err) {
      fail(opts.respond, err);
    }
  },
  "secure.kanban.tasks.delete": async (opts) => {
    try {
      const ok = lane().deleteTask(str(params(opts).id));
      broadcastSecureLaneChanged("kanban");
      opts.respond(true, { ok });
    } catch (err) {
      fail(opts.respond, err);
    }
  },

  // ── documents ────────────────────────────────────────────────────────────
  "secure.docs.list": async ({ respond }) => {
    try {
      respond(true, { docs: lane().listDocs() });
    } catch (err) {
      fail(respond, err);
    }
  },
  "secure.docs.get": async (opts) => {
    try {
      const doc = lane().getDoc(str(params(opts).id));
      if (!doc) {
        opts.respond(false, undefined, { code: "NOT_FOUND", message: "secure document not found" });
        return;
      }
      opts.respond(true, { doc });
    } catch (err) {
      fail(opts.respond, err);
    }
  },
  "secure.docs.create": async (opts) => {
    try {
      const doc = lane().createDoc(params(opts));
      broadcastSecureLaneChanged("docs");
      opts.respond(true, { doc });
    } catch (err) {
      fail(opts.respond, err);
    }
  },
  "secure.docs.update": async (opts) => {
    try {
      const p = params(opts);
      const doc = lane().updateDoc(str(p.id), p);
      broadcastSecureLaneChanged("docs");
      opts.respond(true, { doc });
    } catch (err) {
      fail(opts.respond, err);
    }
  },
  "secure.docs.delete": async (opts) => {
    try {
      const ok = lane().deleteDoc(str(params(opts).id));
      broadcastSecureLaneChanged("docs");
      opts.respond(true, { ok });
    } catch (err) {
      fail(opts.respond, err);
    }
  },

  // ── knowledge graph ──────────────────────────────────────────────────────
  "secure.graph.snapshot": async (opts) => {
    const { respond } = opts;
    try {
      const snap = lane().snapshot();
      // Project view inside the secure lane: same scoping, secure items kept
      // (this lane is already gated on Secure Mode being unlocked).
      const scope = parseScopeParams((opts.params ?? {}) as Record<string, unknown>);
      if (!scope) {
        respond(true, snap);
        return;
      }
      const cut = scopeSnapshotToProject(snap, { ...scope, includeSecure: true });
      const typeStats: Record<string, number> = {};
      for (const n of cut.nodes) typeStats[n.kind] = (typeStats[n.kind] ?? 0) + 1;
      respond(true, { ...snap, nodes: cut.nodes, edges: cut.edges, typeStats, scope: cut.scope });
    } catch (err) {
      fail(respond, err);
    }
  },
  "secure.graph.nodes.create": async (opts) => {
    try {
      const node = lane().createNode(params(opts));
      broadcastSecureLaneChanged("graph");
      opts.respond(true, { node });
    } catch (err) {
      fail(opts.respond, err);
    }
  },
  "secure.graph.nodes.delete": async (opts) => {
    try {
      const ok = lane().deleteNode(str(params(opts).id));
      broadcastSecureLaneChanged("graph");
      opts.respond(true, { ok });
    } catch (err) {
      fail(opts.respond, err);
    }
  },
  "secure.graph.link": async (opts) => {
    try {
      const edge = lane().link(params(opts));
      broadcastSecureLaneChanged("graph");
      opts.respond(true, { edge });
    } catch (err) {
      fail(opts.respond, err);
    }
  },
  "secure.graph.unlink": async (opts) => {
    try {
      const ok = lane().unlink(str(params(opts).id));
      broadcastSecureLaneChanged("graph");
      opts.respond(true, { ok });
    } catch (err) {
      fail(opts.respond, err);
    }
  },
  /**
   * One-time copy of the current normal graph into the secure graph. Owner
   * action (admin scope), requires `confirm: true`; refuses a second run.
   */
  "secure.graph.seed": async (opts) => {
    try {
      if (params(opts).confirm !== true) {
        opts.respond(false, undefined, {
          code: "INVALID_REQUEST",
          message: "secure.graph.seed copies the current knowledge graph once; pass confirm: true",
        });
        return;
      }
      const store = lane();
      const { buildSnapshot, parseOpts } = await import("./graph-global.js");
      const snapshot = await buildSnapshot(parseOpts({}));
      const res = store.seedFromSnapshot(snapshot);
      broadcastSecureLaneChanged("graph");
      opts.respond(true, res);
    } catch (err) {
      fail(opts.respond, err);
    }
  },
};

function researchStore(): ResearchStore {
  return new ResearchStore(getSecureModeRuntime().requireVault());
}

function failResearch(respond: Respond, err: unknown): void {
  if (err instanceof ResearchApprovalError && err.details?.sanitized) {
    // Not an error for the card: it shows the sanitized words and asks again.
    respond(true, {
      ok: false,
      needsReview: true,
      message: err.message,
      sanitized: err.details.sanitized,
    });
    return;
  }
  if (err instanceof ResearchApprovalError) {
    respond(false, undefined, { code: "INVALID_REQUEST", message: err.message });
    return;
  }
  fail(respond, err);
}

/** Secure research: approvals for the chat card + the encrypted query log. */
export const secureResearchHandlers: GatewayRequestHandlers = {
  /** Pending approval requests (optionally for one session). Queries are sanitized text. */
  "secure.research.pending": async (opts) => {
    try {
      if (!getSecureModeRuntime().isUnlocked()) throw new SecureModeLockedError();
      const sessionKey = str(params(opts).sessionKey) || undefined;
      opts.respond(true, { pending: getResearchApprovals().list(sessionKey) });
    } catch (err) {
      fail(opts.respond, err);
    }
  },

  /** Approve (optionally with edited queries) or deny a pending batch. */
  "secure.research.resolve": async (opts) => {
    try {
      if (!getSecureModeRuntime().isUnlocked()) throw new SecureModeLockedError();
      const p = params(opts);
      const id = str(p.id);
      const decision = str(p.decision);
      if (!id || (decision !== "approve" && decision !== "deny")) {
        opts.respond(false, undefined, {
          code: "INVALID_REQUEST",
          message: 'id and decision ("approve" | "deny") are required',
        });
        return;
      }
      const res = getResearchApprovals().resolve(id, decision, p.queries, "owner");
      opts.respond(true, {
        ok: true,
        decision: res.decision,
        ...(res.decision === "approve" ? { queries: res.queries, edited: res.edited } : {}),
      });
    } catch (err) {
      failResearch(opts.respond, err);
    }
  },

  /** Sanitize a draft edit of a pending batch (nothing is sent). */
  "secure.research.preview": async (opts) => {
    try {
      if (!getSecureModeRuntime().isUnlocked()) throw new SecureModeLockedError();
      const p = params(opts);
      opts.respond(true, { queries: getResearchApprovals().preview(str(p.id), p.queries) });
    } catch (err) {
      failResearch(opts.respond, err);
    }
  },

  /** The encrypted query log: which queries left the machine and when. */
  "secure.research.log": async (opts) => {
    try {
      const p = params(opts);
      const limit = typeof p.limit === "number" ? p.limit : undefined;
      opts.respond(true, {
        rows: researchStore().list({ sessionKey: str(p.sessionKey) || undefined, limit }),
      });
    } catch (err) {
      fail(opts.respond, err);
    }
  },

  /** One full research record (summary, estimates, sources, egress log). */
  "secure.research.get": async (opts) => {
    try {
      const rec = researchStore().get(str(params(opts).id));
      if (!rec) {
        opts.respond(false, undefined, { code: "NOT_FOUND", message: "no such research record" });
        return;
      }
      opts.respond(true, rec);
    } catch (err) {
      fail(opts.respond, err);
    }
  },

  /** Approval policy: "ask" (approve each batch) or "auto-sanitized". Hot-reloads. */
  "secure.research.approval.set": async (opts) => {
    try {
      const approval = str(params(opts).approval);
      if (approval !== "ask" && approval !== "auto-sanitized") {
        opts.respond(false, undefined, {
          code: "INVALID_REQUEST",
          message: 'approval must be "ask" or "auto-sanitized"',
        });
        return;
      }
      const snapshot = await readConfigFileSnapshot();
      const parsed = parseConfigJson5(snapshot.raw ?? "{}");
      const config: InfinibotConfig =
        parsed.ok && parsed.parsed && typeof parsed.parsed === "object"
          ? (parsed.parsed as InfinibotConfig)
          : ({} as InfinibotConfig);
      const research = { ...config.secureMode?.research };
      if (approval === "ask") delete research.approval;
      else research.approval = approval;
      const sm = { ...config.secureMode };
      if (Object.keys(research).length) sm.research = research;
      else delete sm.research;
      if (Object.keys(sm).length > 0) config.secureMode = sm;
      else delete config.secureMode;
      const validation = validateConfigObjectWithPlugins(config);
      if (!validation.ok) {
        opts.respond(false, undefined, {
          code: "INVALID_REQUEST",
          message: `Invalid config: ${validation.issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`,
        });
        return;
      }
      await writeConfigFile(config);
      opts.respond(true, { approval });
    } catch (err) {
      fail(opts.respond, err);
    }
  },

  "secure.research.delete": async (opts) => {
    try {
      opts.respond(true, { ok: researchStore().remove(str(params(opts).id)) });
    } catch (err) {
      fail(opts.respond, err);
    }
  },
};

export const SECURE_MODE_READ_METHODS = [
  "secure.status",
  "secure.check",
  "secure.models",
  "secure.kanban.list",
  "secure.docs.list",
  "secure.docs.get",
  "secure.graph.snapshot",
  "secure.research.pending",
  "secure.research.preview",
  "secure.research.log",
  "secure.research.get",
] as const;

export const SECURE_MODE_WRITE_METHODS = [
  "secure.set",
  "secure.session.new",
  "secure.defaultModel.set",
  "secure.kanban.projects.create",
  "secure.kanban.projects.delete",
  "secure.kanban.tasks.create",
  "secure.kanban.tasks.update",
  "secure.kanban.tasks.delete",
  "secure.docs.create",
  "secure.docs.update",
  "secure.docs.delete",
  "secure.graph.nodes.create",
  "secure.graph.nodes.delete",
  "secure.graph.link",
  "secure.graph.unlink",
  "secure.research.resolve",
  "secure.research.approval.set",
  "secure.research.delete",
] as const;

/** Admin-only (left unclassified on purpose): secure.graph.seed. */
export const SECURE_MODE_ADMIN_METHODS = ["secure.graph.seed"] as const;
