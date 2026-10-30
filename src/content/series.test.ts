import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { getDatabasesStore } from "../databases/store.js";
import { ContentIntelStore } from "./intelligence/store.js";
import { getPageIntel } from "./pages-intel.js";
import { getContentPagesStore } from "./pages-store.js";
import { IG_PAGE, SERIES_NAME, YT_PAGE_NAME, seedYoutubeSeries } from "./seed-youtube-series.js";
import { ContentSeriesService } from "./series.js";

const tmpDirs: string[] = [];
function tmpState(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-series-"));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function setup() {
  const dir = tmpState();
  const store = getContentPagesStore(dir);
  const databases = getDatabasesStore(dir);
  const series = new ContentSeriesService(store, databases);
  const ig = store.create({ name: "IG", surface: "instagram", handle: "@me", businessId: "b1" });
  const yt = store.create({
    name: "YT",
    surface: "youtube",
    businessId: "b1",
    links: { pageIds: [ig.id] },
  });
  return { dir, store, databases, series, ig: store.get(ig.id)!, yt };
}

function rowValue(
  databases: ReturnType<typeof getDatabasesStore>,
  dbId: string,
  rowId: string,
  prop: string,
) {
  const p = databases.listProperties(dbId).find((x) => x.name === prop)!;
  return databases.getRow(rowId)!.values[p.id];
}

describe("content page association", () => {
  it("links symmetrically on create, update, link and unlink", () => {
    const { store, ig, yt } = setup();
    expect(yt.links.pageIds).toEqual([ig.id]);
    expect(ig.links.pageIds).toEqual([yt.id]);

    // Removing via update drops the back-link too.
    store.update(yt.id, { links: { pageIds: [] } });
    expect(store.get(ig.id)!.links.pageIds).toEqual([]);

    // linkPages is idempotent and two-sided.
    store.linkPages(ig.id, yt.id);
    store.linkPages(ig.id, yt.id);
    store.linkPages(yt.id, ig.id);
    expect(store.get(ig.id)!.links.pageIds).toEqual([yt.id]);
    expect(store.get(yt.id)!.links.pageIds).toEqual([ig.id]);
    expect(store.linkedPages(store.get(yt.id)!).map((p) => p.id)).toEqual([ig.id]);

    store.unlinkPages(yt.id, ig.id);
    expect(store.get(ig.id)!.links.pageIds).toEqual([]);
    expect(store.get(yt.id)!.links.pageIds).toEqual([]);
  });

  it("rejects unknown targets and ignores self links; keeps other link fields", () => {
    const { store, ig, yt } = setup();
    expect(() => store.update(yt.id, { links: { pageIds: ["page_nope"] } })).toThrow(/not found/);
    store.update(ig.id, { links: { pageIds: [ig.id, yt.id], campaignIds: ["c1"] } });
    const after = store.get(ig.id)!;
    expect(after.links.pageIds).toEqual([yt.id]);
    expect(after.links.campaignIds).toEqual(["c1"]);
    expect(store.linkPages(ig.id, ig.id)).toBeNull();
  });
});

describe("series provisioning", () => {
  it("new pages get a Series child database with the episode properties", () => {
    const { databases, yt } = setup();
    expect(yt.databaseIds.series).toBeTruthy();
    const names = databases.listProperties(yt.databaseIds.series).map((p) => p.name);
    for (const n of [
      "Title",
      "Stage",
      "Series",
      "Season",
      "Episode",
      "Pain Point",
      "Hook",
      "What to Show",
      "Payoff",
      "Target Publish Date",
      "Platform URL",
      "Script",
      "Repurpose Note",
    ]) {
      expect(names).toContain(n);
    }
  });

  it("pages created before series existed are provisioned lazily, once", () => {
    const { dir, store, databases, series } = setup();
    const legacy = store.create({ name: "Old", surface: "instagram", businessId: "b1" });
    // Make it look like a pre-series page: no series id, ideas without stage props.
    const handle = (databases as unknown as { db: import("better-sqlite3").Database }).db;
    const { series: _s, ...fourKinds } = legacy.databaseIds;
    databases.deleteDatabase(legacy.databaseIds.series);
    handle
      .prepare("UPDATE content_pages SET database_ids_json = ? WHERE id = ?")
      .run(JSON.stringify(fourKinds), legacy.id);
    for (const p of databases.listProperties(legacy.databaseIds.ideas)) {
      if (["Stage", "Script", "Content"].includes(p.name)) databases.deleteProperty(p.id);
    }
    const oldIdea = databases.upsertRow({
      databaseId: legacy.databaseIds.ideas,
      title: "old idea",
    });
    expect(store.get(legacy.id)!.databaseIds.series).toBe("");

    expect(series.listEpisodes(legacy.id)).toEqual([]);
    const after = getContentPagesStore(dir).get(legacy.id)!;
    expect(after.databaseIds.series).toBeTruthy();
    expect(databases.getDatabase(after.databaseIds.series)?.meta).toMatchObject({
      contentPageId: legacy.id,
      contentChildKind: "series",
    });
    const ideaProps = databases.listProperties(after.databaseIds.ideas).map((p) => p.name);
    expect(ideaProps).toEqual(expect.arrayContaining(["Stage", "Script", "Content"]));

    // Second call does not provision again.
    series.listEpisodes(legacy.id);
    expect(store.get(legacy.id)!.databaseIds.series).toBe(after.databaseIds.series);
    expect(ideaProps.filter((n) => n === "Stage")).toHaveLength(1);
    expect(
      databases.listProperties(after.databaseIds.ideas).filter((p) => p.name === "Stage"),
    ).toHaveLength(1);

    // A pre-stage idea shows on the board at Idea.
    const board = series.board(legacy.id);
    expect(board.columns.find((c) => c.stage === "idea")!.items.map((i) => i.id)).toContain(
      oldIdea.id,
    );
  });
});

describe("stage pipeline", () => {
  it("episodes group by series and season in episode order", () => {
    const { series, yt } = setup();
    series.upsertEpisode(yt.id, { seriesName: "S", season: 1, episode: 2, title: "two" });
    series.upsertEpisode(yt.id, { seriesName: "S", season: 1, episode: 0, title: "zero" });
    series.upsertEpisode(yt.id, { seriesName: "S", season: 2, episode: 1, title: "s2e1" });
    // Same key updates in place.
    series.upsertEpisode(yt.id, {
      seriesName: "S",
      season: 1,
      episode: 2,
      title: "two!",
      hook: "h",
    });
    const { series: groups, episodes } = series.listSeries(yt.id);
    expect(episodes).toHaveLength(3);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.seasons.map((s) => s.season)).toEqual([1, 2]);
    expect(groups[0]!.seasons[0]!.episodes.map((e) => e.title)).toEqual(["zero", "two!"]);
    expect(groups[0]!.seasons[0]!.episodes[1]!.hook).toBe("h");
    expect(episodes.every((e) => e.stage === "outlined")).toBe(true);
  });

  it("advance: Scripted creates+links a script once; Posted logs Content and a Reel idea on the linked IG page once", () => {
    const { store, databases, series, ig, yt } = setup();
    const page = store.get(yt.id)!;
    const ep = series.upsertEpisode(yt.id, {
      seriesName: "S",
      season: 1,
      episode: 1,
      title: "Ep one",
      hook: "Big hook",
      painPoint: "pain",
      repurposeNote: "cut the aha",
      platformUrl: "https://youtu.be/x",
    });

    const r1 = series.advanceStage({ pageId: yt.id, kind: "series", rowId: ep.id });
    expect(r1).toMatchObject({ from: "outlined", to: "scripted" });
    expect(r1.createdScriptRowId).toBeTruthy();
    const script = databases.getRow(r1.createdScriptRowId!)!;
    expect(script.databaseId).toBe(page.databaseIds.scripts);
    expect(script.title).toBe("Ep one");
    expect(rowValue(databases, page.databaseIds.scripts, script.id, "Hook")).toEqual({
      type: "richText",
      markdown: "Big hook",
    });
    expect(series.getEpisode(yt.id, ep.id)!.scriptRowId).toBe(script.id);

    const r2 = series.advanceStage({ pageId: yt.id, kind: "series", rowId: ep.id });
    expect(r2).toMatchObject({ from: "scripted", to: "filming", createdScriptRowId: null });
    expect(databases.listRows(page.databaseIds.scripts)).toHaveLength(1);

    const r3 = series.advanceStage({
      pageId: yt.id,
      kind: "series",
      rowId: ep.id,
      stage: "posted",
    });
    expect(r3.to).toBe("posted");
    expect(r3.createdContentRowId).toBeTruthy();
    const content = databases.getRow(r3.createdContentRowId!)!;
    expect(content.databaseId).toBe(page.databaseIds.content);
    const published = rowValue(databases, page.databaseIds.content, content.id, "Published At");
    expect(published?.type === "date" && published.iso).toBeTruthy();
    expect(rowValue(databases, page.databaseIds.content, content.id, "Status")).toEqual({
      type: "status",
      optionId: "published",
    });
    expect(rowValue(databases, page.databaseIds.content, content.id, "Platform URL")).toEqual({
      type: "url",
      url: "https://youtu.be/x",
    });
    expect(r3.repurposeIdeas).toEqual([{ pageId: ig.id, rowId: expect.any(String) }]);
    const igIdeas = databases.listRows(ig.databaseIds.ideas);
    expect(igIdeas.map((r) => r.title)).toEqual(["Repurpose as Reel: Ep one"]);

    // Re-posting does not duplicate content or the IG idea; there is no stage after Posted.
    const r4 = series.advanceStage({
      pageId: yt.id,
      kind: "series",
      rowId: ep.id,
      stage: "posted",
    });
    expect(r4).toMatchObject({ createdContentRowId: null, repurposeIdeas: [] });
    expect(databases.listRows(page.databaseIds.content)).toHaveLength(1);
    expect(databases.listRows(ig.databaseIds.ideas)).toHaveLength(1);
    expect(() => series.advanceStage({ pageId: yt.id, kind: "series", rowId: ep.id })).toThrow(
      /last stage/,
    );

    // The board shows it under Posted.
    const posted = series.board(yt.id).columns.find((c) => c.stage === "posted")!;
    expect(posted.items.map((i) => i.id)).toEqual([ep.id]);
  });

  it("ideas advance through the same stages; repurpose:false skips the IG idea", () => {
    const { databases, series, ig, yt } = setup();
    const { row: idea } = series.addIdea(yt.id, { title: "An idea" });
    expect(series.addIdea(yt.id, { title: "an idea " }).created).toBe(false);
    const r1 = series.advanceStage({
      pageId: yt.id,
      kind: "ideas",
      rowId: idea.id,
      stage: "scripted",
    });
    expect(r1).toMatchObject({ from: "idea", to: "scripted" });
    expect(r1.createdScriptRowId).toBeTruthy();
    const ep = series.upsertEpisode(yt.id, { seriesName: "S", episode: 9, title: "quiet" });
    const r2 = series.advanceStage({
      pageId: yt.id,
      kind: "series",
      rowId: ep.id,
      stage: "posted",
      repurpose: false,
    });
    expect(r2.repurposeIdeas).toEqual([]);
    expect(databases.listRows(ig.databaseIds.ideas)).toHaveLength(0);
    // A row from another page is refused.
    expect(() => series.advanceStage({ pageId: ig.id, kind: "ideas", rowId: idea.id })).toThrow(
      /not found/,
    );
  });
});

describe("content intelligence bridge", () => {
  it("reads reels for the page handle and finds a YouTube channel by handle", () => {
    const { dir, store, ig, yt } = setup();
    const intel = new ContentIntelStore(dir);
    const now = Date.now();
    const ins = intel.db.prepare(
      "INSERT INTO reels (shortcode, url, post_id, account, description, has_video, has_transcript, has_score, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?, ?)",
    );
    ins.run("a1", "https://ig/a1", "a1", "me", "first", 1, now, now);
    ins.run("a2", "https://ig/a2", "a2", "me", "second", 0, now, now);
    ins.run("z1", "https://ig/z1", "z1", "someone.else", "other", 0, now, now);
    intel.db
      .prepare(
        "INSERT INTO reel_metrics (shortcode, views, saves, captured_at) VALUES (?, ?, ?, ?)",
      )
      .run("a2", 900, 4, now);
    // A duplicate snapshot at the same timestamp must not double-count the reel.
    intel.db
      .prepare(
        "INSERT INTO reel_metrics (shortcode, views, saves, captured_at) VALUES (?, ?, ?, ?)",
      )
      .run("a2", 900, 4, now);
    intel.db
      .prepare(
        "INSERT INTO scores (shortcode, hook, value, viral, overall, tier, created_at) VALUES ('a1', 7, 6, 8, 7, 'A', ?)",
      )
      .run(now);
    const igIntel = getPageIntel(intel, ig);
    expect(igIntel).toMatchObject({
      source: "instagram",
      account: "me",
      linked: true,
      totals: { reels: 2, scored: 1, views: 900, saves: 4 },
      tiers: { A: 1 },
    });
    if (igIntel.source !== "instagram") throw new Error("unreachable");
    expect(igIntel.topReels.map((r) => r.shortcode)).toEqual(["a2", "a1"]);

    expect(getPageIntel(intel, yt)).toMatchObject({
      source: "youtube",
      linked: false,
      channel: null,
    });
    intel.upsertYoutubeChannel({
      channel_id: "UC1",
      name: "Chan",
      handle: "@mychan",
      subscriber_count: 10,
      video_count: 1,
      thumbnail_url: null,
      captured_at: now,
      updated_at: now,
    });
    store.update(yt.id, { handle: "@MyChan" });
    expect(getPageIntel(intel, store.get(yt.id)!)).toMatchObject({
      linked: true,
      channel: { channelId: "UC1" },
    });
    intel.db.close();
  });
});

describe("seed-youtube-series", () => {
  it("is idempotent and never duplicates the IG page or resets progress", () => {
    const dir = tmpState();
    const first = seedYoutubeSeries({ stateDir: dir });
    expect(first.igPage).toMatchObject({ id: IG_PAGE.id, created: true });
    expect(first.youtubePage.created).toBe(true);
    expect(first.linked).toBe(true);
    expect(first.episodes).toMatchObject({ created: 14, kept: 0 });
    expect(first.ideas).toMatchObject({ created: 4, kept: 0 });

    const store = getContentPagesStore(dir);
    const series = new ContentSeriesService(store, getDatabasesStore(dir));
    const yt = store.get(first.youtubePage.id)!;
    expect(yt).toMatchObject({
      name: YT_PAGE_NAME,
      surface: "youtube",
      businessId: IG_PAGE.businessId,
    });
    expect(yt.theme).toEqual(IG_PAGE.theme);
    const { series: groups } = series.listSeries(yt.id);
    expect(groups.map((g) => g.name)).toEqual([SERIES_NAME]);
    expect(groups[0]!.seasons[0]!.episodes.map((e) => e.episode)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13,
    ]);
    expect(groups[0]!.stageCounts).toEqual({ outlined: 14 });
    const ideaCol = series.board(yt.id).columns.find((c) => c.stage === "idea")!;
    expect(ideaCol.items.filter((i) => i.kind === "ideas")).toHaveLength(4);

    // Owner progresses an episode, then the seed runs again.
    const ep1 = groups[0]!.seasons[0]!.episodes[1]!;
    series.advanceStage({ pageId: yt.id, kind: "series", rowId: ep1.id });
    const second = seedYoutubeSeries({ stateDir: dir });
    expect(second.igPage).toMatchObject({ id: IG_PAGE.id, created: false, matchedBy: "id" });
    expect(second.youtubePage).toEqual({ id: yt.id, created: false });
    expect(second.episodes).toMatchObject({ created: 0, kept: 14 });
    expect(second.ideas).toMatchObject({ created: 0, kept: 4 });
    expect(store.list({ includeArchived: true })).toHaveLength(2);
    expect(series.getEpisode(yt.id, ep1.id)!.stage).toBe("scripted");
  });

  it("matches an existing IG page by handle instead of creating one", () => {
    const dir = tmpState();
    const store = getContentPagesStore(dir);
    const mine = store.create({
      name: "Mine",
      surface: "instagram",
      handle: "@IAM.YungCEO",
      businessId: "biz-x",
    });
    const report = seedYoutubeSeries({ stateDir: dir });
    expect(report.igPage).toEqual({ id: mine.id, created: false, matchedBy: "handle" });
    expect(store.list({ surface: "instagram" })).toHaveLength(1);
    expect(store.get(report.youtubePage.id)!.businessId).toBe("biz-x");
    expect(store.get(mine.id)!.links.pageIds).toEqual([report.youtubePage.id]);
  });
});
