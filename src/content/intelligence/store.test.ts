/**
 * Content Intelligence — CSV parser + upsert idempotency tests.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseMetaCsv, parseShortcode } from "./csv-parser.js";
import { getContentIntelStore, resetContentIntelStore } from "./store.js";
import { importMetaCsv, importManifest, importTranscripts, DEFAULT_ACCOUNT } from "./importer.js";

// ═══════════════════════════════════════════════════════════════════
// CSV PARSER
// ═══════════════════════════════════════════════════════════════════

describe("parseMetaCsv", () => {
  it("parses the 2026 format (Views, Reach, Likes, Shares, Follows, Comments, Saves)", () => {
    const csv = `"Post ID","Account ID","Account username","Account name",Description,"Duration (sec)","Publish time",Permalink,"Post type","Data comment",Date,Views,Reach,Likes,Shares,Follows,Comments,Saves
17845294566647603,17841458689984460,demo.creator,"Demo Creator","Test description",30,"04/19/2026 08:53",https://www.instagram.com/reel/DTlDDeiCda9/,"IG reel",,Lifetime,1000,800,50,10,2,5,3
`;
    const rows = parseMetaCsv(csv);
    expect(rows).toHaveLength(1);
    expect(rows[0].postId).toBe("17845294566647603");
    expect(rows[0].accountUsername).toBe("demo.creator");
    expect(rows[0].postType).toBe("IG reel");
    expect(rows[0].views).toBe(1000);
    expect(rows[0].reach).toBe(800);
    expect(rows[0].likes).toBe(50);
    expect(rows[0].shares).toBe(10);
    expect(rows[0].follows).toBe(2);
    expect(rows[0].comments).toBe(5);
    expect(rows[0].saves).toBe(3);
    expect(rows[0].durationSec).toBe(30);
    expect(rows[0].permalink).toBe("https://www.instagram.com/reel/DTlDDeiCda9/");
  });

  it("parses the 2023-2024 format (no Views column)", () => {
    const csv = `"Post ID","Account ID","Account username","Account name",Description,"Duration (sec)","Publish time",Permalink,"Post type","Data comment",Date,Reach,Likes,Shares,Follows,Comments,Saves
17913086033825847,17841400877755046,demo.creator,"Demo Creator","Dream big",15,"01/15/2024 10:00",https://www.instagram.com/reel/ABC123/,"IG reel",,Lifetime,500,30,5,1,2,0
`;
    const rows = parseMetaCsv(csv);
    expect(rows).toHaveLength(1);
    expect(rows[0].views).toBeNull(); // No Views column in this format
    expect(rows[0].reach).toBe(500);
    expect(rows[0].likes).toBe(30);
    expect(rows[0].shares).toBe(5);
  });

  it("handles quoted descriptions with embedded commas and newlines", () => {
    const csv = `"Post ID","Account ID","Account username","Account name",Description,"Duration (sec)","Publish time",Permalink,"Post type","Data comment",Date,Views,Reach,Likes,Shares,Follows,Comments,Saves
18065259397819130,17841400877755046,demo.creator,"Demo Creator","Comment Whop To Get Started
#creator #explore #trending",69,"04/19/2025 08:53",https://www.instagram.com/reel/DIokJ-DJmFL/,"IG reel",,Lifetime,7576,4880,99,54,0,19,70
`;
    const rows = parseMetaCsv(csv);
    expect(rows).toHaveLength(1);
    expect(rows[0].description).toContain("Comment Whop To Get Started");
    expect(rows[0].description).toContain("#creator");
    expect(rows[0].durationSec).toBe(69);
  });

  it("strips BOM from the start of the file", () => {
    const csv = `\uFEFF"Post ID","Account username","Post type",Permalink,Views,Reach,Likes,Shares,Follows,Comments,Saves,Description,"Duration (sec)","Publish time"
1,demo.creator,"IG reel",https://www.instagram.com/reel/TEST1/,100,50,5,1,0,0,0,"desc",30,"01/01/2026"
`;
    const rows = parseMetaCsv(csv);
    expect(rows).toHaveLength(1);
    expect(rows[0].postId).toBe("1");
    expect(rows[0].accountUsername).toBe("demo.creator");
  });

  it("returns empty array for empty input", () => {
    expect(parseMetaCsv("")).toEqual([]);
    expect(parseMetaCsv("just a header\n")).toEqual([]);
  });

  it("treats empty / 'Lifetime' / '-' numeric fields as null", () => {
    const csv = `"Post ID","Account username","Post type",Permalink,Views,Reach,Likes,Shares,Follows,Comments,Saves,Description,"Duration (sec)","Publish time"
1,demo.creator,"IG reel",https://www.instagram.com/reel/A1/,,,10,,0,,,"desc",30,"01/01/2026"
`;
    const rows = parseMetaCsv(csv);
    expect(rows[0].views).toBeNull();
    expect(rows[0].reach).toBeNull();
    expect(rows[0].likes).toBe(10);
    expect(rows[0].shares).toBeNull();
    expect(rows[0].follows).toBe(0);
  });
});

describe("parseShortcode", () => {
  it("extracts shortcode from /reel/ URL", () => {
    expect(parseShortcode("https://www.instagram.com/reel/DTlDDeiCda9/")).toBe("DTlDDeiCda9");
  });

  it("extracts shortcode from /reels/ URL", () => {
    expect(parseShortcode("https://www.instagram.com/reels/DTlDDeiCda9/")).toBe("DTlDDeiCda9");
  });

  it("extracts shortcode from /p/ URL", () => {
    expect(parseShortcode("https://www.instagram.com/p/Cabc123/")).toBe("Cabc123");
  });

  it("extracts shortcode from bare path", () => {
    expect(parseShortcode("/reel/DTlDDeiCda9/")).toBe("DTlDDeiCda9");
  });

  it("returns null for invalid URL", () => {
    expect(parseShortcode("https://example.com")).toBeNull();
    expect(parseShortcode("")).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════
// STORE + IMPORTER (idempotency)
// ═══════════════════════════════════════════════════════════════════

let tmpDir: string;
let previousStateDir: string | undefined;

function useTemporaryStateDir(): void {
  previousStateDir = process.env.INFINIBOT_STATE_DIR;
  process.env.INFINIBOT_STATE_DIR = tmpDir;
}

function restoreStateDir(): void {
  if (previousStateDir === undefined) delete process.env.INFINIBOT_STATE_DIR;
  else process.env.INFINIBOT_STATE_DIR = previousStateDir;
}

function seedReels(...shortcodes: string[]): void {
  const store = getContentIntelStore(tmpDir);
  const now = Date.now();
  for (const shortcode of shortcodes) {
    store.upsertReel({
      shortcode,
      url: `https://www.instagram.com/reel/${shortcode}/`,
      post_id: `post-${shortcode}`,
      publish_time: "",
      duration_sec: null,
      account: "demo.creator",
      description: "",
      has_video: 0,
      has_transcript: 0,
      has_score: 0,
      created_at: now,
      updated_at: now,
    });
  }
}

function makeCsv(content: string): string {
  const filePath = join(tmpDir, "test-export.csv");
  writeFileSync(filePath, content, "utf-8");
  return filePath;
}

const SAMPLE_CSV_2026 = `"Post ID","Account ID","Account username","Account name",Description,"Duration (sec)","Publish time",Permalink,"Post type","Data comment",Date,Views,Reach,Likes,Shares,Follows,Comments,Saves
18065259397819130,17841400877755046,demo.creator,"Demo Creator","Test reel 1",69,"04/19/2025 08:53",https://www.instagram.com/reel/TESTAA1/,"IG reel",,Lifetime,7576,4880,99,54,0,19,70
18065259397819131,17841400877755046,demo.creator,"Demo Creator","Test reel 2",30,"04/20/2025 10:00",https://www.instagram.com/reel/TESTBB2/,"IG reel",,Lifetime,2000,1500,50,10,2,5,3
18065259397819132,17841400877755046,other.account,"Other","Skip this",10,"04/21/2025 10:00",https://www.instagram.com/reel/SKIPCC3/,"IG reel",,Lifetime,100,80,5,1,0,0,0
18065259397819133,17841400877755046,demo.creator,"Demo Creator","Skip carousel",10,"04/22/2025 10:00",https://www.instagram.com/p/SKIPDD4/,"IG carousel",,Lifetime,500,300,20,5,0,2,1
`;

describe("importMetaCsv + store idempotency", () => {
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "content-intel-test-"));
    useTemporaryStateDir();
  });

  afterEach(() => {
    resetContentIntelStore();
    restoreStateDir();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("filters to IG reel + account, inserts reels + metrics", () => {
    const filePath = makeCsv(SAMPLE_CSV_2026);
    const result = importMetaCsv(filePath, "demo.creator", 1700000000000);

    expect(result.totalRows).toBe(4);
    expect(result.igReelRows).toBe(3); // 3 IG reels, 1 carousel
    expect(result.accountFiltered).toBe(2); // 2 match account
    expect(result.inserted).toBe(2);
    expect(result.updated).toBe(0);
    expect(result.errors).toHaveLength(0);

    const store = getContentIntelStore(tmpDir);
    expect(store.countReels()).toBe(2);

    const reel = store.getReel("TESTAA1");
    expect(reel).toBeDefined();
    expect(reel!.account).toBe("demo.creator");
    expect(reel!.duration_sec).toBe(69);

    const metrics = store.getLatestMetrics("TESTAA1");
    expect(metrics).toBeDefined();
    expect(metrics!.views).toBe(7576);
    expect(metrics!.captured_at).toBe(1700000000000);
  });

  it("upsert is idempotent — re-importing same CSV updates, does not duplicate", () => {
    const filePath = makeCsv(SAMPLE_CSV_2026);
    const t1 = 1700000000000;
    const t2 = 1700000005000;

    const result1 = importMetaCsv(filePath, "demo.creator", t1);
    expect(result1.inserted).toBe(2);
    expect(result1.updated).toBe(0);

    const result2 = importMetaCsv(filePath, "demo.creator", t2);
    expect(result2.inserted).toBe(0); // all already exist
    expect(result2.updated).toBe(2); // all updated

    const store = getContentIntelStore(tmpDir);
    expect(store.countReels()).toBe(2); // no duplicates

    // Metrics snapshots accumulate (2 per reel)
    const allMetrics = store.getAllMetrics("TESTAA1");
    expect(allMetrics).toHaveLength(2);
    expect(allMetrics[0].captured_at).toBe(t1);
    expect(allMetrics[1].captured_at).toBe(t2);
  });

  it("handles missing file gracefully", () => {
    const result = importMetaCsv("/nonexistent/path.csv", DEFAULT_ACCOUNT);
    expect(result.errors).toContain("file not found: /nonexistent/path.csv");
    expect(result.inserted).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════
// MANIFEST IMPORT
// ═══════════════════════════════════════════════════════════════════

describe("importManifest", () => {
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "content-intel-test-"));
    useTemporaryStateDir();
  });

  afterEach(() => {
    resetContentIntelStore();
    restoreStateDir();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("parses the reel-pipeline manifest format", () => {
    const manifest = `shortcode,url,post_id,publish_time,duration_sec,views,reach,likes,shares,follows,comments,saves,description
TEST001,https://www.instagram.com/reel/TEST001/,18062730791274561,01/16/2026 08:50,74,12891,5825,278,65,9,88,41,Would You Say Yes
TEST002,https://www.instagram.com/reel/TEST002/,18067917650444237,01/23/2026 10:37,35,274,241,6,1,0,0,1,Crypto trending
`;
    const manifestPath = join(tmpDir, "manifest.csv");
    writeFileSync(manifestPath, manifest, "utf-8");

    const result = importManifest(manifestPath, 1700000000000);
    expect(result.totalRows).toBe(2);
    expect(result.inserted).toBe(2);

    const store = getContentIntelStore(tmpDir);
    expect(store.countReels()).toBe(2);

    const reel = store.getReel("TEST001");
    expect(reel).toBeDefined();
    expect(reel!.publish_time).toBe("01/16/2026 08:50");
    expect(reel!.duration_sec).toBe(74);

    const metrics = store.getLatestMetrics("TEST001");
    expect(metrics).toBeDefined();
    expect(metrics!.views).toBe(12891);
    expect(metrics!.reach).toBe(5825);
  });

  it("upserts idempotently on re-import", () => {
    const manifest = `shortcode,url,post_id,publish_time,duration_sec,views,reach,likes,shares,follows,comments,saves,description
TEST001,https://www.instagram.com/reel/TEST001/,18062730791274561,01/16/2026 08:50,74,12891,5825,278,65,9,88,41,Test
`;
    const manifestPath = join(tmpDir, "manifest.csv");
    writeFileSync(manifestPath, manifest, "utf-8");

    const r1 = importManifest(manifestPath, 1700000000000);
    const r2 = importManifest(manifestPath, 1700000005000);

    expect(r1.inserted).toBe(1);
    expect(r2.inserted).toBe(0);
    expect(r2.updated).toBe(1);

    const store = getContentIntelStore(tmpDir);
    expect(store.countReels()).toBe(1);
    // Two metric snapshots
    expect(store.getAllMetrics("TEST001")).toHaveLength(2);
  });
});

// ═══════════════════════════════════════════════════════════════════
// TRANSCRIPT IMPORT
// ═══════════════════════════════════════════════════════════════════

describe("importTranscripts", () => {
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "content-intel-test-"));
    useTemporaryStateDir();
  });

  afterEach(() => {
    resetContentIntelStore();
    restoreStateDir();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("imports .txt transcripts keyed by shortcode filename", () => {
    seedReels("TEST001", "TEST002");
    const transcriptsDir = join(tmpDir, "transcripts");
    const { mkdirSync } = require("node:fs");
    mkdirSync(transcriptsDir, { recursive: true });
    writeFileSync(join(transcriptsDir, "TEST001.txt"), "This is a transcript.", "utf-8");
    writeFileSync(join(transcriptsDir, "TEST002.txt"), "Another transcript.", "utf-8");
    writeFileSync(join(transcriptsDir, "empty.txt"), "", "utf-8");

    const result = importTranscripts(transcriptsDir);
    expect(result.inserted).toBe(2);
    expect(result.skipped).toBe(1);

    const store = getContentIntelStore(tmpDir);
    const t = store.getTranscript("TEST001");
    expect(t).toBeDefined();
    expect(t!.text).toBe("This is a transcript.");
    expect(t!.engine).toBe("whisper");
  });

  it("upserts idempotently on re-import", () => {
    seedReels("TEST001");
    const transcriptsDir = join(tmpDir, "transcripts");
    const { mkdirSync } = require("node:fs");
    mkdirSync(transcriptsDir, { recursive: true });
    writeFileSync(join(transcriptsDir, "TEST001.txt"), "Updated transcript.", "utf-8");

    importTranscripts(transcriptsDir);
    const result2 = importTranscripts(transcriptsDir);

    expect(result2.inserted).toBe(1); // upsert counts as insert in result
    const store = getContentIntelStore(tmpDir);
    expect(store.getTranscript("TEST001")!.text).toBe("Updated transcript.");
  });
});
