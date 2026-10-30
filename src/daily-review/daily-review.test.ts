import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { classifyCategory, detectDeploys, resolveProject } from "./classify.js";
import { compactDay } from "./compact.js";
import { buildDay, type Sources } from "./rollup.js";
import { baselineFrom, finalizeScore, scorePoints, sizeBonus } from "./score.js";
import { commonGitDir, discoverRepos } from "./sources/git.js";
import type { KanbanData } from "./sources/kanban.js";
import { parseJournal, parseWatchdogLog } from "./sources/misc.js";
import { applySessionLine, channelForKey, type SessionDayBucket } from "./sources/sessions.js";
import { applyLine, emptyMetrics, parseResultBlock, parseRunLog } from "./stream-log.js";
import { parseBullets } from "./summary.js";
import type { DayRun, RunRecord } from "./types.js";
import { dayStart, redact } from "./util.js";

// Shapes copied from real durable/<runId>/stdout.log lines (trimmed).
const CLAUDE_RESULT_SINCE = JSON.stringify({
  duration_api_ms: 1273097,
  stop_reason: "end_turn",
  total_cost_usd: 12.7670404,
  usage: {
    input_tokens: 40,
    cache_creation_input_tokens: 39991,
    cache_read_input_tokens: 6803121,
    output_tokens: 20666,
  },
  modelUsage: { "claude-opus-5-5": { costUSD: 12.7670404 } },
  result:
    'Done.\n<<<RESULT\n{"status":"done","summary":"Deployed VG SL/TP drag to Netlify 6ade2c94fe15ec2f4a2e08ee and Fly v18","commits":["5e5a295","0ce1ae3"],"files_changed":["a.ts","b.ts","c.ts"],"claims":[{"claim":"live on fly","evidence_ref":"fly releases v18"}]}\nRESULT>>>',
  type: "result",
  model_usage_since_last_result: {
    "claude-opus-5-5": {
      inputTokens: 40,
      outputTokens: 20666,
      cacheReadInputTokens: 6803121,
      cacheCreationInputTokens: 39991,
      costUSD: 2.0940322,
    },
  },
});
const CLAUDE_RESULT_OLD = JSON.stringify({
  type: "result",
  subtype: "success",
  total_cost_usd: 3.5,
  usage: {
    input_tokens: 10,
    cache_creation_input_tokens: 90,
    cache_read_input_tokens: 1000,
    output_tokens: 500,
  },
  modelUsage: { "claude-sonnet-4-5": {} },
  result: "ok",
});
const CODEX_TURN =
  '{"type":"turn.completed","usage":{"input_tokens":325264,"cached_input_tokens":283008,"cache_write_input_tokens":0,"output_tokens":1651,"reasoning_output_tokens":536}}';
const CODEX_MSG = JSON.stringify({
  type: "item.completed",
  item: {
    id: "i1",
    type: "agent_message",
    text: '<<<RESULT\n{"status":"done","summary":"palindrome","commits":[],"files_changed":["x.py"]}\nRESULT>>>',
  },
});
const ASSISTANT_TG =
  '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"mcp__infinibot__message","input":{"action":"send","channel":"telegram","target":"123456789"}}]}}';

describe("stream-log", () => {
  it("sums per-result deltas from model_usage_since_last_result", () => {
    const m = emptyMetrics();
    applyLine(m, CLAUDE_RESULT_SINCE);
    applyLine(m, CLAUDE_RESULT_SINCE);
    expect(m.results).toBe(2);
    expect(m.costUsd).toBeCloseTo(4.1880644, 6);
    expect(m.tokensOut).toBe(41332);
    expect(m.tokensCached).toBe(2 * 6803121);
    expect(m.model).toBe("claude-opus-5-5");
  });

  it("falls back to total_cost_usd deltas on older logs", () => {
    const m = emptyMetrics();
    applyLine(m, CLAUDE_RESULT_OLD);
    applyLine(m, CLAUDE_RESULT_OLD.replace('"total_cost_usd":3.5', '"total_cost_usd":5'));
    expect(m.costUsd).toBeCloseTo(5, 6);
    expect(m.tokensIn).toBe(200);
  });

  it("reads codex usage and final agent message, and counts telegram tool calls", () => {
    const m = emptyMetrics();
    applyLine(m, CODEX_TURN);
    applyLine(m, CODEX_MSG);
    applyLine(m, ASSISTANT_TG);
    expect(m.tokensIn).toBe(325264 - 283008);
    expect(m.tokensOut).toBe(1651 + 536);
    expect(parseResultBlock(m.finalText)?.files).toBe(1);
    expect(m.telegramSends).toBe(1);
  });

  it("ignores result-looking text inside user/assistant lines", () => {
    const m = emptyMetrics();
    applyLine(m, '{"type":"user","message":{"content":"{\\"type\\":\\"result\\"}"}}');
    expect(m.results).toBe(0);
  });

  describe("parseRunLog", () => {
    let dir: string;
    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), "dr-log-"));
    });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    it("resumes from the saved offset and skips a partial last line", async () => {
      const file = path.join(dir, "stdout.log");
      fs.writeFileSync(file, `${CLAUDE_RESULT_SINCE}\n${CLAUDE_RESULT_SINCE.slice(0, 40)}`);
      const c1 = await parseRunLog(dir, null);
      expect(c1?.metrics.results).toBe(1);
      fs.writeFileSync(
        file,
        `${CLAUDE_RESULT_SINCE}\n${CLAUDE_RESULT_SINCE}\n${CLAUDE_RESULT_SINCE}\n`,
      );
      const c2 = await parseRunLog(dir, c1);
      expect(c2?.metrics.results).toBe(3);
      expect(c2?.metrics.costUsd).toBeCloseTo(3 * 2.0940322, 5);
      const c3 = await parseRunLog(dir, c2);
      expect(c3).toBe(c2); // unchanged file → same cursor, nothing re-read
    });

    it("parses archived stdout.log.gz once", async () => {
      fs.writeFileSync(
        path.join(dir, "stdout.log.gz"),
        zlib.gzipSync(`${CODEX_TURN}\n${CODEX_MSG}\n`),
      );
      const c = await parseRunLog(dir, null);
      expect(c?.done).toBe(true);
      expect(c?.metrics.results).toBe(1);
    });
  });

  it("parses the RESULT block and keeps the last one", () => {
    const r = parseResultBlock(
      `x <<<RESULT\n{"status":"blocked","summary":"a","commits":[]}\nRESULT>>> y <<<RESULT\n{"status":"done","summary":"b","commits":["abc"],"files_changed":["f"]}\nRESULT>>>`,
    );
    expect(r?.status).toBe("done");
    expect(r?.commits).toEqual(["abc"]);
    expect(parseResultBlock("no block")).toBeNull();
  });
});

describe("redaction", () => {
  it("strips common credential shapes", () => {
    const text = [
      "key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123",
      "gh ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      "bot 1234567890:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw1",
      "Authorization: Bearer abcdefghijklmnop.qrstuvwxyz",
      "postgres://user:pw@db.example.com:5432/x",
      "token=supersecretvalue123",
      "netlify nfp_abcdefghijklmnopqrstuvwxyz12",
    ].join("\n");
    const out = redact(text);
    for (const leak of [
      "sk-ant-api03",
      "ghp_abc",
      "AAHdqTcv",
      "abcdefghijklmnop.qrst",
      "user:pw",
      "supersecretvalue123",
      "nfp_abc",
    ]) {
      expect(out).not.toContain(leak);
    }
  });

  it("keeps commit hashes and deploy ids", () => {
    expect(
      redact("commit 5e5a2951c0ffee0123456789abcdef0123456789 netlify 6ade2c94fe15ec2f4a2e08ee"),
    ).toContain("6ade2c94fe15ec2f4a2e08ee");
  });
});

describe("classify", () => {
  it("resolves projects from label prefixes, kanban names and worktree paths", () => {
    expect(resolveProject({ label: "VG: entry price + live positions" })).toBe("VectorGames");
    expect(resolveProject({ label: "Fix stuff", kanbanProject: "KinglyVault Launch" })).toBe(
      "KinglyVault",
    );
    expect(resolveProject({ label: "Fix stuff", workdir: "/dev/shm/IB-daily-review" })).toBe(
      "InfiniBot",
    );
    expect(
      resolveProject({
        label: "Fix stuff",
        workdir: "/home/u/Desktop/Development/VG-position-accuracy",
      }),
    ).toBe("VectorGames");
    expect(resolveProject({ label: "Fix stuff" })).toBe("Other");
    expect(
      resolveProject({
        label: "Deploy VG SL/TP drag to production NOW",
        kanbanProject: "InfiniBot",
      }),
    ).toBe("VectorGames");
    expect(resolveProject({ label: "InfiniBot: KV device connect" })).toBe("InfiniBot");
  });

  it("categorises by label first", () => {
    expect(classifyCategory("Deploy VG SL/TP drag to production NOW")).toBe("deploy");
    expect(classifyCategory("KV lesson videos batch 3")).toBe("video");
    expect(classifyCategory("Research plan: sign in with ChatGPT")).toBe("research");
    expect(classifyCategory("Restyle the projects page")).toBe("design");
    expect(classifyCategory("Fix order execution latency")).toBe("code");
  });

  it("detects deploys with refs, dedupes and respects negation", () => {
    const d = detectDeploys(
      "Deployed to Netlify 6ade2c94fe15ec2f4a2e08ee and Fly v18.\nAlso deployed to netlify.\nDid not deploy the gateway.",
      "run-1",
      "VG",
      1,
    );
    expect(d.map((x) => `${x.target}:${x.ref ?? ""}`)).toEqual([
      "netlify:6ade2c94fe15ec2f4a2e08ee",
      "fly:v18",
      "netlify:",
    ]);
    expect(detectDeploys("Nothing was deployed; not released.", "r", "x", 1)).toEqual([]);
  });
});

describe("sessions", () => {
  it("buckets messages, cost and telegram sends by local day", () => {
    const days: Record<string, SessionDayBucket> = {};
    const ts = new Date(2026, 9, 26, 14, 5).toISOString();
    applySessionLine(
      days,
      `{"type":"message","id":"a","timestamp":"${ts}","message":{"role":"user","content":[{"type":"text","text":"hi"}]}}`,
    );
    applySessionLine(
      days,
      `{"type":"message","id":"b","timestamp":"${ts}","message":{"role":"assistant","content":[{"type":"toolCall","id":"x","name":"message","arguments":{"action":"send","channel":"telegram","message":"hi"}}],"usage":{"input":1,"output":2,"totalTokens":30,"cost":{"input":0.1,"output":0.2,"total":0.3}}}}`,
    );
    applySessionLine(days, '{"type":"session","version":3}');
    const b = days["2026-10-26"]!;
    expect(b.user).toBe(1);
    expect(b.assistant).toBe(1);
    expect(b.costUsd).toBeCloseTo(0.3);
    expect(b.tokens).toBe(30);
    expect(b.telegramSends).toBe(1);
    expect(b.hours[14]).toBe(2);
  });

  it("maps session keys to channels", () => {
    expect(channelForKey("voice", "agent:voice:main")).toBe("voice");
    expect(channelForKey("main", "agent:main:subagent:123")).toBe("agents");
    expect(channelForKey("main", "agent:main:mcp-host-1")).toBe("mcp");
    expect(channelForKey("main", "agent:main:main")).toBe("chat");
  });
});

describe("incidents", () => {
  it("parses journald oom kills and watchdog crashes", () => {
    const j = parseJournal(
      "2026-10-26T18:09:57+07:00 host systemd[1]: infinibot-watchdog.service: Failed with result 'oom-kill'.\n2026-10-26T18:10:02+07:00 host systemd[1]: Started x",
    );
    expect(j).toHaveLength(1);
    expect(j[0]!.kind).toBe("oom");
    const w = parseWatchdogLog(
      "[2026-10-27T00:04:26+07:00] Gateway exited code=1 — 1 crash(es)\n[2026-10-27T00:05:00+07:00] Gateway exited code=0",
    );
    expect(w).toHaveLength(1);
  });
});

describe("git discovery", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "dr-git-"));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it("dedupes worktrees onto their common git dir", () => {
    const main = path.join(root, "Repo");
    fs.mkdirSync(path.join(main, ".git", "worktrees", "wt1"), { recursive: true });
    fs.writeFileSync(path.join(main, ".git", "worktrees", "wt1", "commondir"), "../..\n");
    const wt = path.join(root, "Repo-wt");
    fs.mkdirSync(wt);
    fs.writeFileSync(
      path.join(wt, ".git"),
      `gitdir: ${path.join(main, ".git", "worktrees", "wt1")}\n`,
    );
    expect(commonGitDir(wt)).toBe(fs.realpathSync(path.join(main, ".git")));
    const repos = discoverRepos([root]);
    expect(repos).toHaveLength(1);
    expect(repos[0]!.name).toBe("Repo");
  });
});

describe("score", () => {
  const run = (o: Partial<DayRun>): DayRun => ({
    runId: "r",
    rootId: "r",
    label: "x",
    project: "P",
    category: "code",
    backend: "claude-code",
    kind: "coder",
    start: 0,
    end: 1,
    outcome: "verified",
    costUsd: 0,
    tokens: 0,
    commits: 0,
    files: 0,
    deploys: 0,
    rework: false,
    minutes: 0,
    ...o,
  });

  it("weights verified runs by size and subtracts failures, rework and incidents", () => {
    expect(sizeBonus({ commits: 8, files: 80, deploys: 1 })).toBe(2.5);
    const { net, components } = scorePoints({
      runs: [
        run({ commits: 4, files: 0 }),
        run({ outcome: "unverified" }),
        run({ outcome: "failed" }),
      ],
      deploysUncredited: 1,
      kanbanUnlinked: 2,
      commits: 50,
      incidents: 1,
      rework: 1,
    });
    // 20 (verified ×2) + 4 + 6 + 6 + 40 − 4 − 2 − 3
    expect(net).toBe(67);
    expect(components.find((c) => c.key === "commits")?.points).toBe(40);
  });

  it("lands near 50 at the baseline and is transparent", () => {
    const s = finalizeScore(60, 60, []);
    expect(s.value).toBe(50);
    expect(finalizeScore(0, 60, []).value).toBe(0);
    expect(finalizeScore(180, 60, []).value).toBeGreaterThan(70);
    expect(baselineFrom([0, 0, 100, 50, 200])).toBe(100);
    expect(baselineFrom([])).toBe(20);
  });
});

describe("buildDay", () => {
  const date = "2026-10-26";
  const t = (h: number, m = 0) => dayStart(date) + h * 3600_000 + m * 60_000;
  const rec = (o: Partial<RunRecord>): RunRecord => ({
    runId: "a",
    rootId: "a",
    label: "VG: ship",
    kind: "coder",
    backend: "claude-code",
    project: "VectorGames",
    category: "deploy",
    startedAt: t(9),
    endedAt: t(10),
    outcome: "verified",
    costUsd: 2,
    tokensIn: 100,
    tokensOut: 50,
    tokensCached: 0,
    commits: 2,
    files: 4,
    deploys: [],
    telegramSends: 0,
    ...o,
  });
  const kanban: KanbanData = {
    projectName: (id) => (id === "p1" ? "KinglyVault" : null),
    task: () => null,
    completed: [{ id: "k1", title: "Write copy", projectId: "p1", ts: t(12) }],
    created: [],
    moved: [],
    inProgress: [],
  };
  const src = (runs: RunRecord[]): Sources => ({
    runs,
    kanban,
    commits: [
      {
        repo: "VectorGames",
        project: "VectorGames",
        sha: "abc",
        ts: t(10),
        subject: "fix",
        merge: false,
      },
      {
        repo: "VectorGames",
        project: "VectorGames",
        sha: "def",
        ts: t(11),
        subject: "merge feat/x",
        merge: true,
      },
    ],
    reports: [],
    incidents: [{ ts: t(18), kind: "oom", detail: "oom" }],
    sessions: {},
    workEvents: {},
  });

  it("collapses continuation passes, keeps the verification and dedupes deploys", () => {
    const deploy = {
      target: "netlify",
      ref: "6ade2c94fe15ec2f4a2e08ee",
      label: "VG: ship",
      runId: "a",
      ts: t(10),
    };
    const day = buildDay(
      date,
      src([
        rec({ deploys: [deploy] }),
        rec({
          runId: "a-c2",
          startedAt: t(10, 30),
          endedAt: t(11),
          outcome: "unverified",
          label: "VG: ship",
          deploys: [{ ...deploy, runId: "a-c2" }],
        }),
        rec({
          runId: "b",
          rootId: "b",
          label: "Broken",
          outcome: "failed",
          startedAt: t(13),
          endedAt: t(14),
          respawnOf: "z",
        }),
      ]),
      t(23),
      [],
    );
    expect(day.totals.runs).toBe(2);
    expect(day.totals.verified).toBe(1);
    expect(day.totals.failed).toBe(1);
    expect(day.totals.rework).toBe(1);
    expect(day.totals.deploys).toBe(1);
    expect(day.totals.agentMinutes).toBe(150);
    expect(day.totals.commits).toBe(1);
    expect(day.totals.merges).toBe(1);
    expect(day.totals.kanbanCompleted).toBe(1);
    expect(day.hours[9]!.agentMinutes).toBe(60);
    expect(day.hours[10]!.agentMinutes).toBe(30);
    expect(day.byProject[0]!.name).toBe("VectorGames");
    expect(day.accomplishments[0]!.kind).toBe("run");
    expect(day.score.components.find((c) => c.key === "kanban")?.count).toBe(1);
    expect(day.score.components.find((c) => c.key === "incidents")?.count).toBe(1);
    expect(day.score.value).toBeGreaterThan(0);
    const text = compactDay(day, 600);
    expect(text.length).toBeLessThanOrEqual(600);
    expect(text).toContain("Daily review 2026-10-26");
  });

  it("splits a run across midnight", () => {
    const day = buildDay(
      date,
      src([rec({ startedAt: t(23), endedAt: t(25), costUsd: 4 })]),
      t(30),
      [],
    );
    expect(day.totals.agentMinutes).toBe(60);
    expect(day.totals.cliCostUsd).toBe(2);
    expect(day.totals.verified).toBe(0); // it ended the next day
  });
});

describe("summary parsing", () => {
  it("accepts JSON bullets and rejects junk", () => {
    expect(parseBullets('Sure:\n{"bullets":["- Shipped A","Blocked on B","Tomorrow: C"]}')).toEqual(
      ["Shipped A", "Blocked on B", "Tomorrow: C"],
    );
    expect(parseBullets("no json")).toBeNull();
  });
});
