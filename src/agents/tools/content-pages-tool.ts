/**
 * Content Pages tool — lets the CMO / content agents work the content pages:
 * list pages and their associations, read a page's Content Intelligence
 * summary, list a page's series, add or update episodes, capture ideas and
 * move episodes / ideas through the idea → posted stage pipeline.
 *
 * Same store + service the content.pages.* RPCs use (src/content).
 */

import { Type } from "@sinclair/typebox";

import { getContentIntelStore } from "../../content/intelligence/store.js";
import { getPageIntel } from "../../content/pages-intel.js";
import { getContentPagesStore } from "../../content/pages-store.js";
import { getContentSeriesService, type EpisodeInput } from "../../content/series.js";
import { CONTENT_STAGES, isContentStage, type ContentPage } from "../../content/types.js";
import { stringEnum } from "../schema/typebox.js";
import { type AnyAgentTool, jsonResult, readNumberParam, readStringParam } from "./common.js";

const ACTIONS = [
  "list_pages",
  "get_page",
  "link_pages",
  "page_intel",
  "list_series",
  "upsert_episode",
  "add_idea",
  "board",
  "advance_stage",
] as const;

const STAGE_IDS = CONTENT_STAGES.map((s) => s.id);

const ContentPagesToolSchema = Type.Object({
  action: stringEnum(ACTIONS),
  pageId: Type.Optional(
    Type.String({ description: "Content page id, or its handle (e.g. '@iam.yungceo')." }),
  ),
  otherPageId: Type.Optional(Type.String({ description: "link_pages: the page to associate." })),
  unlink: Type.Optional(Type.Boolean({ description: "link_pages: remove the association." })),
  rowId: Type.Optional(Type.String({ description: "Episode / idea row id." })),
  kind: Type.Optional(
    stringEnum(["series", "ideas"] as const, {
      description: "advance_stage: 'series' (episode, default) or 'ideas'.",
    }),
  ),
  stage: Type.Optional(
    stringEnum(STAGE_IDS, {
      description:
        "Target stage. advance_stage without stage moves to the next one. " +
        "Idea → Outlined → Scripted → Filming → Editing → Scheduled → Posted (+ Shelved).",
    }),
  ),
  repurpose: Type.Optional(
    Type.Boolean({
      description:
        "advance_stage to posted: also add a 'Repurpose as Reel' idea on linked Instagram pages (default true).",
    }),
  ),
  title: Type.Optional(Type.String()),
  seriesName: Type.Optional(Type.String()),
  season: Type.Optional(Type.Number()),
  episode: Type.Optional(Type.Number()),
  painPoint: Type.Optional(Type.String()),
  hook: Type.Optional(Type.String()),
  whatToShow: Type.Optional(Type.String()),
  payoff: Type.Optional(Type.String()),
  targetPublishDate: Type.Optional(Type.String({ description: "ISO date (YYYY-MM-DD)." })),
  platformUrl: Type.Optional(Type.String()),
  repurposeNote: Type.Optional(Type.String()),
  notes: Type.Optional(Type.String()),
});

function pageSummary(p: ContentPage) {
  return {
    id: p.id,
    name: p.name,
    surface: p.surface,
    handle: p.handle ?? null,
    businessId: p.businessId,
    status: p.status,
    linkedPageIds: p.links.pageIds,
  };
}

export function createContentPagesTool(_options?: { agentId?: string }): AnyAgentTool {
  return {
    label: "Content Pages",
    name: "content_pages",
    description:
      "Work the operator's content pages (one per channel: Instagram, YouTube…). Actions: " +
      "'list_pages', 'get_page' (incl. linked sibling pages), 'link_pages' (associate two pages), " +
      "'page_intel' (Content Intelligence summary for the page's handle), " +
      "'list_series' (episodes grouped by series and season), " +
      "'upsert_episode' (add or update an episode; same series+season+episode updates in place), " +
      "'add_idea', 'board' (every episode and idea by stage), " +
      "'advance_stage' (move an episode or idea to the next / a given stage; Scripted creates a " +
      "Scripts row, Posted creates a Content row and a Reel repurpose idea on linked IG pages).",
    parameters: ContentPagesToolSchema,
    execute: async (_toolCallId, args, signal) => {
      if (signal?.aborted) {
        const err = new Error("content_pages aborted");
        err.name = "AbortError";
        throw err;
      }
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true });
      const store = getContentPagesStore();
      const series = getContentSeriesService();

      const resolvePage = (key = "pageId"): ContentPage => {
        const handle = readStringParam(params, key, { required: true });
        const byId = store.get(handle);
        if (byId) return byId;
        const want = handle.replace(/^@/, "").toLowerCase();
        const hits = store
          .list()
          .filter((p) => (p.handle ?? "").replace(/^@/, "").toLowerCase() === want);
        if (hits.length === 1) return hits[0]!;
        if (hits.length > 1) {
          throw new Error(
            `Handle ${handle} matches several pages (${hits.map((p) => `${p.id} ${p.surface}`).join(", ")}); pass the page id.`,
          );
        }
        throw new Error(`Content page not found: ${handle}`);
      };

      if (action === "list_pages") {
        return jsonResult({ pages: store.list().map(pageSummary) });
      }
      if (action === "get_page") {
        const page = resolvePage();
        return jsonResult({
          page: { ...pageSummary(page), theme: page.theme ?? null, goals: page.goals ?? null },
          linkedPages: store.linkedPages(page).map(pageSummary),
        });
      }
      if (action === "link_pages") {
        const a = resolvePage();
        const b = resolvePage("otherPageId");
        const res =
          params.unlink === true ? store.unlinkPages(a.id, b.id) : store.linkPages(a.id, b.id);
        if (!res) throw new Error("Could not link those pages");
        return jsonResult({ page: pageSummary(res.a), other: pageSummary(res.b) });
      }
      if (action === "page_intel") {
        const page = resolvePage();
        return jsonResult({ intel: getPageIntel(getContentIntelStore(), page, 10) });
      }
      if (action === "list_series") {
        const page = resolvePage();
        const { series: groups } = series.listSeries(page.id);
        return jsonResult({ pageId: page.id, series: groups });
      }
      if (action === "upsert_episode") {
        const page = resolvePage();
        const stage = params.stage;
        if (stage !== undefined && !isContentStage(stage))
          throw new Error(
            `Unknown stage: ${typeof stage === "string" ? stage : JSON.stringify(stage)}`,
          );
        const input: EpisodeInput = {
          id: readStringParam(params, "rowId"),
          title: readStringParam(params, "title"),
          seriesName: readStringParam(params, "seriesName"),
          season: readNumberParam(params, "season", { integer: true }),
          episode: readNumberParam(params, "episode", { integer: true }),
          painPoint: readStringParam(params, "painPoint"),
          hook: readStringParam(params, "hook"),
          whatToShow: readStringParam(params, "whatToShow"),
          payoff: readStringParam(params, "payoff"),
          stage: stage as EpisodeInput["stage"],
          targetPublishDate: readStringParam(params, "targetPublishDate"),
          platformUrl: readStringParam(params, "platformUrl"),
          repurposeNote: readStringParam(params, "repurposeNote"),
          notes: readStringParam(params, "notes"),
        };
        for (const k of Object.keys(input) as Array<keyof EpisodeInput>) {
          if (input[k] === undefined) delete input[k];
        }
        return jsonResult({ episode: series.upsertEpisode(page.id, input) });
      }
      if (action === "add_idea") {
        const page = resolvePage();
        const stage = params.stage;
        if (stage !== undefined && !isContentStage(stage))
          throw new Error(
            `Unknown stage: ${typeof stage === "string" ? stage : JSON.stringify(stage)}`,
          );
        const { row, created } = series.addIdea(page.id, {
          title: readStringParam(params, "title", { required: true }),
          notes: readStringParam(params, "notes"),
          stage: stage as EpisodeInput["stage"],
        });
        return jsonResult({ created, idea: { id: row.id, title: row.title } });
      }
      if (action === "board") {
        const page = resolvePage();
        const board = series.board(page.id);
        return jsonResult({
          pageId: page.id,
          columns: board.columns.map((c) => ({
            stage: c.stage,
            count: c.items.length,
            items: c.items.map((i) => ({ kind: i.kind, id: i.id, title: i.title, label: i.label })),
          })),
        });
      }
      if (action === "advance_stage") {
        const page = resolvePage();
        const stage = params.stage;
        if (stage !== undefined && !isContentStage(stage))
          throw new Error(
            `Unknown stage: ${typeof stage === "string" ? stage : JSON.stringify(stage)}`,
          );
        const kind = readStringParam(params, "kind") ?? "series";
        if (kind !== "series" && kind !== "ideas")
          throw new Error("kind must be 'series' or 'ideas'");
        const result = series.advanceStage({
          pageId: page.id,
          kind,
          rowId: readStringParam(params, "rowId", { required: true }),
          stage: stage as EpisodeInput["stage"],
          repurpose: params.repurpose !== false,
        });
        return jsonResult({ result });
      }
      throw new Error(`Unknown action: ${action}`);
    },
  };
}
