/**
 * Adapter that lets the standalone setup-ui server invoke the existing
 * `quickstart.*` and `notion.wizard.*` handlers without bringing along any
 * of the gateway's request plumbing.
 *
 * The handlers in `src/gateway/server-methods/quickstart.ts` and
 * `notion-wizard.ts` only ever read `params` and call `respond(ok, data,
 * error)` — they don't touch `context`, `client`, `req`, or
 * `isWebchatConnect`. This file passes stubs for those and reshapes the
 * `respond` callback into a `Promise<RpcResult>`, so HTTP routes can
 * `await dispatch(method, params)` and serialize the result directly.
 */
import { federationHandlers } from "../gateway/server-methods/federation.js";
import { notionSchemaHandlers } from "../gateway/server-methods/notion-schema.js";
import { notionWizardHandlers } from "../gateway/server-methods/notion-wizard.js";
import { notionImportHandlers } from "../gateway/server-methods/notion-import.js";
import { notionConflictsHandlers } from "../gateway/server-methods/notion-conflicts.js";
import { quickstartHandlers } from "../gateway/server-methods/quickstart.js";
import { quickstartProvidersHandlers } from "../gateway/server-methods/quickstart-providers.js";
import { documentsHandlers } from "../gateway/server-methods/documents.js";
import { telegramSetupHandlers } from "../gateway/server-methods/telegram-setup.js";
import { voiceSetupHandlers } from "../gateway/server-methods/voice-setup.js";
import type { GatewayRequestHandler } from "../gateway/server-methods/types.js";
import type { RpcResult } from "./invoke.js";
import { SETUP_METHODS, setupHandlers } from "./setup-rpc.js";

export type { RpcResult };

const HANDLERS: Record<string, GatewayRequestHandler> = {
  ...quickstartHandlers,
  ...notionWizardHandlers,
  // Provider model discovery (Models step). Lives in its own module on the
  // gateway side, so it has to be merged in explicitly here too — the
  // allowlist below already includes "quickstart.providers.fetchModels", and
  // without this entry the dispatch would 404 on an allowlisted method.
  ...quickstartProvidersHandlers,
  // Schema reconciliation for imported Notion DBs (diff / applyPatch /
  // aiSuggest). Allowlisted below so the standalone wizard can run a
  // "fix imported DB" step before finalize.
  ...notionSchemaHandlers,
  // Unified import flow + conflict queue, both reachable from the
  // standalone setup-ui so first-time users can import existing DBs and
  // resolve sync conflicts without launching the full gateway.
  ...notionImportHandlers,
  ...notionConflictsHandlers,
  // Voice step handlers — the wizard's Voice step (incl. the "Voice brain"
  // cloud-vs-Ollama picker) calls voice.setup.get/save/brain/ollamaModels.
  // The allowlist below already lists these methods; without spreading the
  // handlers here the standalone dispatch would 404 on them.
  ...voiceSetupHandlers,
  // Federation handlers — the wizard's federation step calls
  // `federation.connect` on the invite-token path. Listing only the
  // methods that are explicitly allowlisted below keeps the standalone
  // setup-ui's surface tight.
  ...federationHandlers,
  // The premium wizard's own surface: verified keys/tokens, satellite pairing.
  ...setupHandlers,
  // "Import your notes" step: Obsidian (folder / git / ZIP via /upload) and
  // Notion (token search + import, or export ZIP via /upload). Jobs run in
  // this process while the wizard is open; whatever is unfinished when setup
  // exits is resumed by the gateway on its first boot (import-jobs.ts).
  ...pick(documentsHandlers, [
    "documents.notion.status",
    "documents.notion.search",
    "documents.notion.import",
    "documents.notion.jobs.get",
    "documents.notion.jobs.list",
    "documents.notion.jobs.cancel",
    "documents.obsidian.import",
    "documents.import.undo",
  ]),
  // Guided Telegram (same flow as Setup › Channels and cloud onboarding):
  // getMe check, owner capture via a t.me/<bot>?start=<code> link, test message.
  ...telegramSetupHandlers,
};

function pick(
  all: Record<string, GatewayRequestHandler>,
  names: string[],
): Record<string, GatewayRequestHandler> {
  const out: Record<string, GatewayRequestHandler> = {};
  for (const n of names) if (all[n]) out[n] = all[n];
  return out;
}

/**
 * The telegram.setup handlers read the channel runtime and restart the channel
 * through `context`. There is no gateway here: nothing is running, so the
 * snapshot is empty and start/stop are no-ops — the saved config takes effect
 * when the gateway starts.
 */
const STANDALONE_CONTEXT = {
  getRuntimeSnapshot: () => ({ channels: {} }),
  stopChannel: async () => undefined,
  startChannel: async () => undefined,
};

/**
 * Names of the methods that are safe to call from the standalone setup-ui.
 * Gating to an explicit allowlist (rather than dispatching anything in the
 * combined map) means a future addition to `quickstartHandlers` doesn't
 * silently widen the standalone server's attack surface.
 */
export const ALLOWED_METHODS: ReadonlySet<string> = new Set([
  "quickstart.status",
  "quickstart.applyPatch",
  "quickstart.verify",
  "quickstart.finalize",
  "quickstart.restartGateway",
  "quickstart.migrateLegacyNotion",
  "quickstart.notion.listDatabases",
  "quickstart.notion.import",
  "quickstart.kanban.getSettings",
  "quickstart.kanban.saveSettings",
  "quickstart.buildUi",
  "quickstart.voice.get",
  "quickstart.voice.save",
  "voice.setup.get",
  "voice.setup.validateKey",
  "voice.setup.save",
  "voice.setup.smoke",
  "voice.setup.doctor",
  "voice.setup.ollamaModels",
  "voice.setup.brainGet",
  "voice.setup.brain",
  "voice.runtime.status",
  "voice.node.get",
  "voice.node.set",
  "voice.nodes.list",
  "quickstart.providers.fetchModels",
  "quickstart.providers.validate",
  "quickstart.providers.testModel",
  "quickstart.federation.fetchMasterConfig",
  "federation.connect",
  "notion.wizard.status",
  "notion.wizard.verifyToken",
  "notion.wizard.listPages",
  "notion.wizard.importPages",
  "notion.wizard.createSystemDbs",
  "notion.wizard.verifySetup",
  "notion.wizard.finalize",
  "notion.wizard.disconnect",
  "notion.schema.diff",
  "notion.schema.applyPatch",
  "notion.schema.applyRename",
  "notion.schema.aiSuggest",
  "notion.import.listDatabases",
  "notion.import.preview",
  "notion.import.scanRelations",
  "notion.import.commit",
  "notion.import.unbind",
  "notion.import.listBindings",
  "notion.import.findOverlaps",
  "notion.import.mergeRows",
  "notion.bindings.changeTarget",
  "notion.conflicts.list",
  "notion.conflicts.get",
  "notion.conflicts.count",
  "notion.conflicts.resolve",
  ...SETUP_METHODS,
  "documents.notion.status",
  "documents.notion.search",
  "documents.notion.import",
  "documents.notion.jobs.get",
  "documents.notion.jobs.list",
  "documents.notion.jobs.cancel",
  "documents.obsidian.import",
  "documents.import.undo",
  "telegram.setup.summary",
  "telegram.setup.verify",
  "telegram.setup.deleteWebhook",
  "telegram.setup.capture.start",
  "telegram.setup.capture.status",
  "telegram.setup.capture.cancel",
  "telegram.setup.manual",
  "telegram.setup.confirm",
  "telegram.setup.test",
]);

export async function dispatchSetupRpc(
  method: string,
  params: Record<string, unknown>,
): Promise<RpcResult> {
  if (!ALLOWED_METHODS.has(method)) {
    return {
      ok: false,
      error: { code: "NOT_FOUND", message: `Unknown setup method: ${method}` },
    };
  }
  // `quickstart.restartGateway` is a no-op in standalone mode — there's no
  // gateway running yet. The wizard still sends it after a few "needs
  // restart" prompts; answering ok keeps the existing UX flow without a
  // user-visible regression.
  if (method === "quickstart.restartGateway") {
    return { ok: true, data: { ok: true, restarting: false, standalone: true } };
  }

  const handler = HANDLERS[method];
  if (!handler) {
    return {
      ok: false,
      error: { code: "NOT_FOUND", message: `Handler missing: ${method}` },
    };
  }

  return new Promise<RpcResult>((resolve) => {
    let settled = false;
    const respond = (ok: boolean, data?: unknown, error?: { code: string; message: string }) => {
      if (settled) return;
      settled = true;
      if (ok) {
        // No gateway to (re)start here: the bot comes up when the gateway starts.
        if (method === "telegram.setup.confirm" && data && typeof data === "object") {
          const d = data as Record<string, unknown>;
          if (d.starting) d.starting = "saved";
        }
        resolve({ ok: true, data });
      } else {
        resolve({
          ok: false,
          error: error ?? { code: "UNKNOWN", message: "RPC failed" },
        });
      }
    };
    Promise.resolve(
      handler({
        // None of the allowlisted handlers read these — passing minimal
        // stubs avoids dragging the gateway runtime into the setup CLI.
        req: {} as never,
        params: params ?? {},
        client: null,
        isWebchatConnect: () => false,
        respond,
        context: STANDALONE_CONTEXT as never,
      }),
    ).catch((err: unknown) => {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: err instanceof Error ? err.message : String(err),
      });
    });
  });
}
