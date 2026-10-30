/**
 * Gateway handlers for the video posting queue
 * (CONTENT_STUDIO_POSTING_METHODS → posting-ops.ts).
 */

import type {
  GatewayRequestHandler,
  GatewayRequestHandlerOptions,
} from "../gateway/server-methods/types.js";
import type { ContentStudioPostingMethod } from "./methods.js";
import { ContentStudioError } from "./pipeline-store.js";
import { DroidUnavailableError } from "./posting-droid.js";
import * as ops from "./posting-ops.js";
import type { PostingRunner } from "./posting-runner.js";
import { ensurePagesStore, getPostingRunner } from "./posting-service.js";

type P = Record<string, unknown>;
type Impl = (params: P, runner: PostingRunner) => unknown;

const IMPLS: Record<ContentStudioPostingMethod, Impl> = {
  "content-studio.posting.get": (p, r) => ops.getPosting(r, p),
  "content-studio.posting.configure": (p, r) => ops.configurePosting(r, p),
  "content-studio.posting.devices": (p, r) => ops.listDevices(r, p),
  "content-studio.posting.detect": (p, r) => ops.detectAccounts(r, p),
  "content-studio.posting.candidates": (p, r) => ops.listCandidates(r, p),
  "content-studio.posting.enqueue": (p, r) => ops.enqueueVideo(r, p),
  "content-studio.posting.update": (p, r) => ops.updateEntry(r, p),
  "content-studio.posting.reorder": (p, r) => ops.reorderQueue(r, p),
  "content-studio.posting.action": (p, r) => ops.entryAction(r, p),
  "content-studio.posting.postNow": (p, r) => ops.postNow(r, p),
  "content-studio.posting.preview": (p, r) => ops.previewCaption(r, p),
  "content-studio.posting.aiCaption": (p, r) => ops.aiCaption(r, p),
  "content-studio.posting.history": (p, r) => ops.postingHistory(r, p),
  "content-studio.posting.tick": (_p, r) => ops.tickNow(r),
  "content-studio.posting.targets": (_p, r) => ops.listTargets(r),
  "content-studio.posting.lookup": (p, r) => ops.lookupEntries(r, p),
};

export function createPostingHandlers(
  resolveRunner: () => PostingRunner = () => getPostingRunner(),
): Record<ContentStudioPostingMethod, GatewayRequestHandler> {
  const out = {} as Record<ContentStudioPostingMethod, GatewayRequestHandler>;
  for (const [method, impl] of Object.entries(IMPLS) as Array<[ContentStudioPostingMethod, Impl]>) {
    out[method] = async ({ params, respond, client }: GatewayRequestHandlerOptions) => {
      try {
        await ensurePagesStore();
        const who =
          (client as { connect?: { client?: { displayName?: string; id?: string } } } | null)
            ?.connect?.client?.displayName ?? "operator";
        respond(true, await impl({ actor: `ui:${who}`, ...params }, resolveRunner()));
      } catch (err) {
        if (err instanceof ContentStudioError) {
          respond(false, undefined, {
            code: err.code === "NOT_FOUND" ? "NOT_FOUND" : "INVALID_REQUEST",
            message: err.message,
          });
          return;
        }
        respond(false, undefined, {
          code: err instanceof DroidUnavailableError ? "UNAVAILABLE" : "INTERNAL_ERROR",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    };
  }
  return out;
}
