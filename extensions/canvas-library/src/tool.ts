/**
 * `canvas_library` agent tool — browse and file canvases in the HoloCanvas
 * library. Only registered while the plugin is on. Showing a canvas on screen
 * stays a core capability (proactive emitMedia / `canvas.convert`), so agents
 * never depend on this plugin to present a walkthrough.
 */

import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "../../../src/agents/tools/common.js";
import type { CanvasRuntime } from "infinibot/plugin-sdk";
import { jsonResult, readNumberParam, readStringParam, stringEnum } from "infinibot/plugin-sdk";
import { EXAMPLE_CANVASES } from "./examples.js";
import { isCanvasPayload } from "./rpc.js";

export const CANVAS_LIBRARY_TOOL = "canvas_library";

const ACTIONS = ["list", "get", "save", "delete", "from_report", "from_markdown", "load_examples"] as const;

type Runtime = Pick<CanvasRuntime, "store" | "parseSource" | "convert" | "sharePath">;

export function createCanvasLibraryTool(rt: Runtime): AnyAgentTool {
  return {
    label: "HoloCanvas library",
    name: CANVAS_LIBRARY_TOOL,
    description:
      "HoloCanvas library of saved infinite-canvas walkthroughs. Actions: " +
      "'list' (optional tag, limit), 'get' (id → full payload), " +
      "'save' (title + payload {nodes[], scenes[]} + tags), 'delete' (id), " +
      "'from_report' (reportId → canvas built from that report, saved), " +
      "'from_markdown' (markdown [+ title] → canvas, saved), " +
      "'load_examples' (add the example canvases). Every saved canvas has a share " +
      "page at the returned sharePath. To show one on screen, emit it with the " +
      "proactive tool (media kind infinite-canvas-walkthrough).",
    parameters: Type.Object({
      action: stringEnum(ACTIONS),
      id: Type.Optional(Type.String()),
      tag: Type.Optional(Type.String()),
      limit: Type.Optional(Type.Number()),
      title: Type.Optional(Type.String()),
      payload: Type.Optional(Type.Unknown({ description: "Canvas payload ('save')." })),
      tags: Type.Optional(Type.Array(Type.String())),
      reportId: Type.Optional(Type.String()),
      markdown: Type.Optional(Type.String()),
    }),
    execute: async (_callId, args) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true });
      const store = await rt.store();
      const tags = Array.isArray(params.tags)
        ? params.tags.filter((t): t is string => typeof t === "string" && t.trim() !== "")
        : [];
      const brief = (e: { id: string; title: string; tags: string[]; payload: { scenes?: unknown[] } }) => ({
        id: e.id,
        title: e.title,
        tags: e.tags,
        scenes: e.payload.scenes?.length ?? 0,
        sharePath: rt.sharePath(e.id),
      });

      switch (action) {
        case "list": {
          const tag = readStringParam(params, "tag");
          const limit = readNumberParam(params, "limit") ?? 50;
          return jsonResult({
            canvases: store.list({ tag: tag || undefined, limit }).map(brief),
            total: store.count(tag || undefined),
          });
        }
        case "get": {
          const id = readStringParam(params, "id", { required: true });
          const entry = store.get(id);
          if (!entry) return jsonResult({ error: `canvas ${id} not found` });
          return jsonResult({ ...brief(entry), payload: entry.payload });
        }
        case "save": {
          const title = readStringParam(params, "title", { required: true });
          if (!isCanvasPayload(params.payload)) {
            return jsonResult({ error: "payload must have nodes[] and scenes[]" });
          }
          const id = readStringParam(params, "id");
          return jsonResult(brief(store.save({ title, payload: params.payload, tags, id: id || undefined })));
        }
        case "delete": {
          const id = readStringParam(params, "id", { required: true });
          return jsonResult({ ok: store.delete(id), id });
        }
        case "from_report":
        case "from_markdown": {
          const src = await rt.parseSource(
            action === "from_report"
              ? { source: "report", reportId: params.reportId, title: params.title }
              : { source: "markdown", markdown: params.markdown, title: params.title },
          );
          const converted = await rt.convert(src);
          const entry = store.save({
            title: converted.title,
            payload: converted.payload,
            tags: [...new Set([converted.source, ...tags])],
          });
          return jsonResult({ ...brief(entry), mediaKind: converted.mediaKind });
        }
        case "load_examples": {
          const added = EXAMPLE_CANVASES.filter((ex) => !store.findByTitle(ex.title)).map(
            (ex) => store.save({ title: ex.title, payload: ex.payload, tags: ex.tags }).id,
          );
          return jsonResult({ added });
        }
        default:
          return jsonResult({ error: `unknown action ${action}` });
      }
    },
  };
}
