/**
 * Content series + idea → post stage pipeline.
 *
 * A series lives on a content page as rows of its `series` child database
 * (one row per episode). Episodes and ideas share one stage set
 * (CONTENT_STAGES). Advancing a row moves it along CONTENT_STAGE_ORDER and
 * applies the side effects that keep the page's other databases in step:
 *   - reaching Scripted (or later) with no linked script creates a Scripts
 *     row and links it;
 *   - reaching Posted with no linked content creates a Content row with
 *     Published At and links it;
 *   - posting an episode can drop a "Repurpose as Reel" idea on each linked
 *     Instagram page (once per episode).
 *
 * Rows are plain generic-database rows, so the existing children.* RPCs and
 * the Databases page keep working on them.
 */

import { getDatabasesStore, type DatabasesStore } from "../databases/store.js";
import type { DatabaseProperty, DatabaseRow, PropertyValue } from "../databases/types.js";
import { getContentPagesStore, type ContentPagesStore } from "./pages-store.js";
import type { ContentPage, ContentStage } from "./types.js";
import { CONTENT_STAGE_ORDER, CONTENT_STAGES, isContentStage } from "./types.js";

export type StageKind = "series" | "ideas";

export interface SeriesEpisode {
  id: string;
  title: string;
  seriesName: string;
  season: number | null;
  episode: number | null;
  painPoint: string;
  hook: string;
  whatToShow: string;
  payoff: string;
  stage: ContentStage;
  targetPublishDate: string | null;
  platformUrl: string | null;
  scriptRowId: string | null;
  contentRowId: string | null;
  repurposeNote: string;
  notes: string;
  updatedAt: number;
}

export interface EpisodeInput {
  /** Existing row id — update. Omit to create (or match by series/season/episode). */
  id?: string;
  title?: string;
  seriesName?: string;
  season?: number | null;
  episode?: number | null;
  painPoint?: string;
  hook?: string;
  whatToShow?: string;
  payoff?: string;
  stage?: ContentStage;
  targetPublishDate?: string | null;
  platformUrl?: string | null;
  scriptRowId?: string | null;
  repurposeNote?: string;
  notes?: string;
}

export interface SeriesGroup {
  name: string;
  seasons: Array<{ season: number | null; episodes: SeriesEpisode[] }>;
  episodeCount: number;
  stageCounts: Partial<Record<ContentStage, number>>;
}

export interface BoardItem {
  kind: StageKind;
  id: string;
  title: string;
  stage: ContentStage;
  /** "S1 · Ep 3" for episodes, null for ideas. */
  label: string | null;
  seriesName: string | null;
  scriptRowId: string | null;
  contentRowId: string | null;
}

export interface AdvanceResult {
  kind: StageKind;
  rowId: string;
  from: ContentStage;
  to: ContentStage;
  createdScriptRowId: string | null;
  createdContentRowId: string | null;
  repurposeIdeas: Array<{ pageId: string; rowId: string }>;
}

// ─── field mapping ───────────────────────────────────────────────

/** Episode field → series property name. */
const EPISODE_PROPS = {
  stage: "Stage",
  seriesName: "Series",
  season: "Season",
  episode: "Episode",
  painPoint: "Pain Point",
  hook: "Hook",
  whatToShow: "What to Show",
  payoff: "Payoff",
  targetPublishDate: "Target Publish Date",
  platformUrl: "Platform URL",
  scriptRowId: "Script",
  contentRowId: "Content",
  repurposeNote: "Repurpose Note",
  notes: "Notes",
} as const;

function propId(props: DatabaseProperty[], name: string): string | null {
  return props.find((p) => p.name.toLowerCase() === name.toLowerCase())?.id ?? null;
}

function text(v: PropertyValue | undefined): string {
  if (!v) return "";
  if (v.type === "richText") return v.markdown ?? "";
  if (v.type === "title") return v.text ?? "";
  return "";
}

function num(v: PropertyValue | undefined): number | null {
  return v && v.type === "number" ? (v.value ?? null) : null;
}

function firstRelation(v: PropertyValue | undefined): string | null {
  return v && v.type === "relation" ? (v.rowIds[0] ?? null) : null;
}

function stageOf(v: PropertyValue | undefined, fallback: ContentStage = "idea"): ContentStage {
  const id = v && (v.type === "status" || v.type === "select") ? v.optionId : null;
  return isContentStage(id) ? id : fallback;
}

/** Ideas created before stages existed: map the legacy Status onto a stage. */
function legacyIdeaStage(row: DatabaseRow, props: DatabaseProperty[]): ContentStage {
  const statusId = propId(props, "Status");
  const v = statusId ? row.values[statusId] : undefined;
  const opt = v && v.type === "status" ? v.optionId : null;
  if (opt === "shelved") return "shelved";
  if (opt === "promoted") return "outlined";
  return "idea";
}

function mapEpisode(row: DatabaseRow, props: DatabaseProperty[]): SeriesEpisode {
  const get = (name: string) => {
    const id = propId(props, name);
    return id ? row.values[id] : undefined;
  };
  const date = get(EPISODE_PROPS.targetPublishDate);
  const url = get(EPISODE_PROPS.platformUrl);
  return {
    id: row.id,
    title: row.title,
    seriesName: text(get(EPISODE_PROPS.seriesName)),
    season: num(get(EPISODE_PROPS.season)),
    episode: num(get(EPISODE_PROPS.episode)),
    painPoint: text(get(EPISODE_PROPS.painPoint)),
    hook: text(get(EPISODE_PROPS.hook)),
    whatToShow: text(get(EPISODE_PROPS.whatToShow)),
    payoff: text(get(EPISODE_PROPS.payoff)),
    stage: stageOf(get(EPISODE_PROPS.stage), "outlined"),
    targetPublishDate: date && date.type === "date" ? date.iso : null,
    platformUrl: url && url.type === "url" ? url.url : null,
    scriptRowId: firstRelation(get(EPISODE_PROPS.scriptRowId)),
    contentRowId: firstRelation(get(EPISODE_PROPS.contentRowId)),
    repurposeNote: text(get(EPISODE_PROPS.repurposeNote)),
    notes: text(get(EPISODE_PROPS.notes)),
    updatedAt: row.updatedAt,
  };
}

function episodeValues(
  props: DatabaseProperty[],
  input: EpisodeInput,
): Record<string, PropertyValue> {
  const out: Record<string, PropertyValue> = {};
  const set = (name: string, value: PropertyValue) => {
    const id = propId(props, name);
    if (id) out[id] = value;
  };
  const rich = (name: string, v: string | undefined) => {
    if (v !== undefined) set(name, { type: "richText", markdown: v });
  };
  if (input.stage !== undefined)
    set(EPISODE_PROPS.stage, { type: "status", optionId: input.stage });
  rich(EPISODE_PROPS.seriesName, input.seriesName);
  if (input.season !== undefined)
    set(EPISODE_PROPS.season, { type: "number", value: input.season });
  if (input.episode !== undefined)
    set(EPISODE_PROPS.episode, { type: "number", value: input.episode });
  rich(EPISODE_PROPS.painPoint, input.painPoint);
  rich(EPISODE_PROPS.hook, input.hook);
  rich(EPISODE_PROPS.whatToShow, input.whatToShow);
  rich(EPISODE_PROPS.payoff, input.payoff);
  if (input.targetPublishDate !== undefined)
    set(EPISODE_PROPS.targetPublishDate, { type: "date", iso: input.targetPublishDate });
  if (input.platformUrl !== undefined)
    set(EPISODE_PROPS.platformUrl, { type: "url", url: input.platformUrl });
  if (input.scriptRowId !== undefined)
    set(EPISODE_PROPS.scriptRowId, {
      type: "relation",
      rowIds: input.scriptRowId ? [input.scriptRowId] : [],
    });
  rich(EPISODE_PROPS.repurposeNote, input.repurposeNote);
  rich(EPISODE_PROPS.notes, input.notes);
  return out;
}

function compareEpisodes(a: SeriesEpisode, b: SeriesEpisode): number {
  const s = a.seriesName.localeCompare(b.seriesName);
  if (s !== 0) return s;
  const sa = a.season ?? Number.MAX_SAFE_INTEGER;
  const sb = b.season ?? Number.MAX_SAFE_INTEGER;
  if (sa !== sb) return sa - sb;
  const ea = a.episode ?? Number.MAX_SAFE_INTEGER;
  const eb = b.episode ?? Number.MAX_SAFE_INTEGER;
  if (ea !== eb) return ea - eb;
  return a.title.localeCompare(b.title);
}

export function nextStage(stage: ContentStage): ContentStage | null {
  if (stage === "shelved") return "idea";
  const i = CONTENT_STAGE_ORDER.indexOf(stage);
  return i >= 0 && i < CONTENT_STAGE_ORDER.length - 1 ? CONTENT_STAGE_ORDER[i + 1]! : null;
}

function atOrPast(stage: ContentStage, target: ContentStage): boolean {
  const i = CONTENT_STAGE_ORDER.indexOf(stage);
  return i >= 0 && i >= CONTENT_STAGE_ORDER.indexOf(target);
}

// ─── service ─────────────────────────────────────────────────────

export class ContentSeriesService {
  constructor(
    private pages: ContentPagesStore,
    private databases: DatabasesStore,
  ) {}

  private page(pageId: string): ContentPage {
    const page = this.pages.ensureSeries(pageId);
    if (!page) throw new Error(`Page not found: ${pageId}`);
    return page;
  }

  listEpisodes(pageId: string): SeriesEpisode[] {
    const page = this.page(pageId);
    const props = this.databases.listProperties(page.databaseIds.series);
    return this.databases
      .listRows(page.databaseIds.series)
      .map((r) => mapEpisode(r, props))
      .sort(compareEpisodes);
  }

  /** Episodes grouped by series name → season, each in episode order. */
  listSeries(pageId: string): { episodes: SeriesEpisode[]; series: SeriesGroup[] } {
    const episodes = this.listEpisodes(pageId);
    const groups = new Map<string, SeriesGroup>();
    for (const ep of episodes) {
      const name = ep.seriesName || "Unassigned";
      let g = groups.get(name);
      if (!g) {
        g = { name, seasons: [], episodeCount: 0, stageCounts: {} };
        groups.set(name, g);
      }
      let season = g.seasons.find((s) => s.season === ep.season);
      if (!season) {
        season = { season: ep.season, episodes: [] };
        g.seasons.push(season);
      }
      season.episodes.push(ep);
      g.episodeCount++;
      g.stageCounts[ep.stage] = (g.stageCounts[ep.stage] ?? 0) + 1;
    }
    return { episodes, series: [...groups.values()] };
  }

  getEpisode(pageId: string, rowId: string): SeriesEpisode | null {
    const page = this.page(pageId);
    const row = this.databases.getRow(rowId);
    if (!row || row.databaseId !== page.databaseIds.series) return null;
    return mapEpisode(row, this.databases.listProperties(page.databaseIds.series));
  }

  /**
   * Create or update an episode. Without `id`, an existing episode with the
   * same series + season + episode number is updated instead of duplicated,
   * so seeding is idempotent.
   */
  upsertEpisode(pageId: string, input: EpisodeInput): SeriesEpisode {
    const page = this.page(pageId);
    const dbId = page.databaseIds.series;
    const props = this.databases.listProperties(dbId);
    let id = input.id;
    if (id) {
      const row = this.databases.getRow(id);
      if (!row || row.databaseId !== dbId) throw new Error(`Episode not found: ${id}`);
    } else if (input.seriesName && input.episode !== undefined && input.episode !== null) {
      id = this.listEpisodes(pageId).find(
        (e) =>
          e.seriesName === input.seriesName &&
          e.season === (input.season ?? null) &&
          e.episode === input.episode,
      )?.id;
    }
    if (input.stage !== undefined && !isContentStage(input.stage)) {
      throw new Error(`Unknown stage: ${String(input.stage)}`);
    }
    const values = episodeValues(props, {
      ...input,
      stage: input.stage ?? (id ? undefined : "outlined"),
    });
    const row = this.databases.upsertRow({
      id,
      databaseId: dbId,
      title: input.title ?? (id ? undefined : "Untitled episode"),
      values,
    });
    return mapEpisode(row, props);
  }

  deleteEpisode(pageId: string, rowId: string): boolean {
    const page = this.page(pageId);
    const row = this.databases.getRow(rowId);
    if (!row || row.databaseId !== page.databaseIds.series) return false;
    return this.databases.deleteRow(rowId);
  }

  /** Add an idea at a stage (default Idea). Skips an existing idea with the same title. */
  addIdea(
    pageId: string,
    input: { title: string; notes?: string; source?: string; stage?: ContentStage },
  ): { row: DatabaseRow; created: boolean } {
    const page = this.page(pageId);
    const dbId = page.databaseIds.ideas;
    const existing = this.databases
      .listRows(dbId)
      .find((r) => r.title.trim().toLowerCase() === input.title.trim().toLowerCase());
    if (existing) return { row: existing, created: false };
    const props = this.databases.listProperties(dbId);
    const values: Record<string, PropertyValue> = {};
    const set = (name: string, v: PropertyValue) => {
      const id = propId(props, name);
      if (id) values[id] = v;
    };
    set("Stage", { type: "status", optionId: input.stage ?? "idea" });
    set("Status", { type: "status", optionId: "captured" });
    if (input.notes) set("Notes", { type: "richText", markdown: input.notes });
    if (input.source) set("Source", { type: "richText", markdown: input.source });
    const row = this.databases.upsertRow({ databaseId: dbId, title: input.title, values });
    return { row, created: true };
  }

  /** Every episode + idea on the page, bucketed by stage. */
  board(pageId: string): {
    stages: typeof CONTENT_STAGES;
    columns: Array<{ stage: ContentStage; name: string; items: BoardItem[] }>;
  } {
    const page = this.page(pageId);
    const items: BoardItem[] = this.listEpisodes(pageId).map((ep) => ({
      kind: "series",
      id: ep.id,
      title: ep.title,
      stage: ep.stage,
      label:
        ep.episode !== null
          ? `${ep.season !== null ? `S${ep.season} · ` : ""}Ep ${ep.episode}`
          : null,
      seriesName: ep.seriesName || null,
      scriptRowId: ep.scriptRowId,
      contentRowId: ep.contentRowId,
    }));
    const ideaProps = this.databases.listProperties(page.databaseIds.ideas);
    const stageId = propId(ideaProps, "Stage");
    const scriptId = propId(ideaProps, "Script");
    const contentId = propId(ideaProps, "Content");
    for (const row of this.databases.listRows(page.databaseIds.ideas)) {
      const sv = stageId ? row.values[stageId] : undefined;
      items.push({
        kind: "ideas",
        id: row.id,
        title: row.title,
        stage: sv ? stageOf(sv) : legacyIdeaStage(row, ideaProps),
        label: null,
        seriesName: null,
        scriptRowId: scriptId ? firstRelation(row.values[scriptId]) : null,
        contentRowId: contentId ? firstRelation(row.values[contentId]) : null,
      });
    }
    return {
      stages: CONTENT_STAGES,
      columns: CONTENT_STAGES.map((s) => ({
        stage: s.id,
        name: s.name,
        items: items.filter((i) => i.stage === s.id),
      })),
    };
  }

  /**
   * Move an episode or idea to `stage` (default: the next stage) and apply
   * the pipeline side effects. `repurpose: false` skips the linked-IG idea.
   */
  advanceStage(input: {
    pageId: string;
    kind: StageKind;
    rowId: string;
    stage?: ContentStage;
    repurpose?: boolean;
  }): AdvanceResult {
    const page = this.page(input.pageId);
    const dbId = input.kind === "series" ? page.databaseIds.series : page.databaseIds.ideas;
    const row = this.databases.getRow(input.rowId);
    if (!row || row.databaseId !== dbId) {
      throw new Error(`${input.kind === "series" ? "Episode" : "Idea"} not found: ${input.rowId}`);
    }
    const props = this.databases.listProperties(dbId);
    const stagePropId = propId(props, "Stage");
    if (!stagePropId) throw new Error("Stage property missing");
    const scriptPropId = propId(props, "Script");
    const contentPropId = propId(props, "Content");

    const current = row.values[stagePropId]
      ? stageOf(row.values[stagePropId], input.kind === "series" ? "outlined" : "idea")
      : input.kind === "ideas"
        ? legacyIdeaStage(row, props)
        : "outlined";
    let to: ContentStage;
    if (input.stage !== undefined) {
      if (!isContentStage(input.stage)) throw new Error(`Unknown stage: ${String(input.stage)}`);
      to = input.stage;
    } else {
      const n = nextStage(current);
      if (!n) throw new Error(`Already at the last stage (${current})`);
      to = n;
    }

    const values: Record<string, PropertyValue> = {
      [stagePropId]: { type: "status", optionId: to },
    };
    let scriptRowId = scriptPropId ? firstRelation(row.values[scriptPropId]) : null;
    let contentRowId = contentPropId ? firstRelation(row.values[contentPropId]) : null;
    if (scriptRowId && !this.databases.getRow(scriptRowId)) scriptRowId = null;
    if (contentRowId && !this.databases.getRow(contentRowId)) contentRowId = null;
    const episode = input.kind === "series" ? mapEpisode(row, props) : null;
    const result: AdvanceResult = {
      kind: input.kind,
      rowId: row.id,
      from: current,
      to,
      createdScriptRowId: null,
      createdContentRowId: null,
      repurposeIdeas: [],
    };

    if (atOrPast(to, "scripted") && !scriptRowId) {
      scriptRowId = this.createScript(page, row.title, episode);
      result.createdScriptRowId = scriptRowId;
      if (scriptPropId) values[scriptPropId] = { type: "relation", rowIds: [scriptRowId] };
    }
    if (to === "posted" && !contentRowId) {
      contentRowId = this.createContent(page, row.title, episode);
      result.createdContentRowId = contentRowId;
      if (contentPropId) values[contentPropId] = { type: "relation", rowIds: [contentRowId] };
    }
    if (input.kind === "ideas" && to === "posted") {
      const statusId = propId(props, "Status");
      if (statusId) values[statusId] = { type: "status", optionId: "promoted" };
    }
    this.databases.upsertRow({ id: row.id, databaseId: dbId, values });

    if (to === "posted" && episode && input.repurpose !== false) {
      for (const linked of this.pages.linkedPages(page)) {
        if (linked.surface !== "instagram") continue;
        const { row: idea, created } = this.addIdea(linked.id, {
          title: `Repurpose as Reel: ${row.title}`,
          notes: [
            episode.repurposeNote,
            episode.hook ? `Hook: ${episode.hook}` : "",
            episode.payoff ? `Payoff: ${episode.payoff}` : "",
          ]
            .filter(Boolean)
            .join("\n\n"),
          source: `${page.name}${episode.episode !== null ? ` · Ep ${episode.episode}` : ""}`,
        });
        if (created) result.repurposeIdeas.push({ pageId: linked.id, rowId: idea.id });
      }
    }
    return result;
  }

  private createScript(page: ContentPage, title: string, ep: SeriesEpisode | null): string {
    const dbId = page.databaseIds.scripts;
    const props = this.databases.listProperties(dbId);
    const values: Record<string, PropertyValue> = {};
    const status = propId(props, "Status");
    if (status) values[status] = { type: "status", optionId: "draft" };
    const hook = propId(props, "Hook");
    if (hook && ep?.hook) values[hook] = { type: "richText", markdown: ep.hook };
    const body = propId(props, "Body");
    if (body && ep) {
      const outline = [
        ep.painPoint && `**Pain:** ${ep.painPoint}`,
        ep.whatToShow && `**Show:** ${ep.whatToShow}`,
        ep.payoff && `**Payoff:** ${ep.payoff}`,
      ]
        .filter(Boolean)
        .join("\n\n");
      if (outline) values[body] = { type: "richText", markdown: outline };
    }
    return this.databases.upsertRow({ databaseId: dbId, title, values }).id;
  }

  private createContent(page: ContentPage, title: string, ep: SeriesEpisode | null): string {
    const dbId = page.databaseIds.content;
    const props = this.databases.listProperties(dbId);
    const values: Record<string, PropertyValue> = {};
    const status = propId(props, "Status");
    if (status) values[status] = { type: "status", optionId: "published" };
    const published = propId(props, "Published At");
    if (published) values[published] = { type: "date", iso: new Date().toISOString() };
    const type = propId(props, "Type");
    if (type) {
      const options = props.find((p) => p.id === type)?.config?.options?.map((o) => o.id) ?? [];
      const want = page.surface === "youtube" && options.includes("video") ? "video" : "post";
      if (options.includes(want)) values[type] = { type: "select", optionId: want };
    }
    const url = propId(props, "Platform URL");
    if (url && ep?.platformUrl) values[url] = { type: "url", url: ep.platformUrl };
    return this.databases.upsertRow({ databaseId: dbId, title, values }).id;
  }
}

export function getContentSeriesService(stateDir?: string): ContentSeriesService {
  const dir =
    stateDir || process.env.INFINIBOT_STATE_DIR || process.env.MOLTBOT_STATE_DIR || "state";
  return new ContentSeriesService(getContentPagesStore(dir), getDatabasesStore(dir));
}
