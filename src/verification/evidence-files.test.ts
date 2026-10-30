import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { RunResult } from "./contract.js";
import { collectEvidence, commandOfRef } from "./evidence.js";
import { expandEvidenceGlob, extractPathRefs, inspectEvidenceFile } from "./evidence-files.js";
import { environmentProblem } from "./run-env.js";

let dir: string;
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(4096, 7)]);

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "vc-evfiles-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function result(claims: RunResult["claims"], extra: Partial<RunResult> = {}): RunResult {
  return {
    status: "done",
    summary: "s",
    commits: [],
    files_changed: [],
    claims,
    checks_run: [],
    screenshots: [],
    open_issues: [],
    ...extra,
  };
}

describe("extractPathRefs", () => {
  it("pulls paths out of refs that mix paths and prose (live records)", () => {
    expect(
      extractPathRefs(
        "/tmp/plugin-products-side-gateway-result.json; disabledAfterData.rpcUnavailable=true, retainedRows={catalogRows:1,portfolioRows:1}",
      ),
    ).toEqual(["/tmp/plugin-products-side-gateway-result.json"]);
    expect(
      extractPathRefs(
        "pnpm build (exit 0, /tmp/rp2-build2.log); pnpm -C ui build (exit 0, /tmp/rp2-uibuild2.log)",
      ),
    ).toEqual(["/tmp/rp2-build2.log", "/tmp/rp2-uibuild2.log"]);
    expect(extractPathRefs("/tmp/shots/a.png, /tmp/shots/b.png")).toEqual([
      "/tmp/shots/a.png",
      "/tmp/shots/b.png",
    ]);
    expect(extractPathRefs("src/verification/evidence.ts:120")).toEqual([
      "src/verification/evidence.ts",
    ]);
    expect(extractPathRefs("see https://example.com/a/b.json")).toEqual([]);
  });
});

describe("globs in evidence refs", () => {
  it("expands owner-*.json instead of reporting 'owner-' as missing", async () => {
    writeFileSync(path.join(dir, "owner-cron.json"), JSON.stringify({ ok: true }));
    writeFileSync(path.join(dir, "owner-agents.json"), JSON.stringify({ ok: true }));
    const ref = `${dir}/owner-*.json, ${dir}/owner-gateway.log`;
    writeFileSync(path.join(dir, "owner-gateway.log"), "listening\n");
    expect(extractPathRefs(ref)).toEqual([`${dir}/owner-*.json`, `${dir}/owner-gateway.log`]);
    expect(expandEvidenceGlob(`${dir}/owner-*.json`)).toHaveLength(2);
    expect(expandEvidenceGlob(`${dir}/none-*.json`)).toEqual([]);
    const ev = await collectEvidence({
      workdir: null,
      baseCommit: null,
      runStartedAt: Date.now() - 60_000,
      rerunCommands: false,
      result: result([{ claim: "owner-copy boot ok", evidence_type: "file", evidence_ref: ref }]),
    });
    const claim = ev.items.find((i) => i.kind === "claim")!;
    expect(claim.status).toBe("pass");
    expect(claim.detail).toContain("owner-agents.json");
  });
});

describe("inspectEvidenceFile", () => {
  it("JSON: claimed field=value assertions are checked against the file", () => {
    const f = path.join(dir, "result.json");
    writeFileSync(
      f,
      JSON.stringify({
        ok: true,
        disabledAfterData: {
          rpcUnavailable: true,
          retainedRows: { catalogRows: 1, portfolioRows: 1 },
        },
        ownerCopy: { catalogRows: 38, detectorMatched: true },
      }),
    );
    const good = inspectEvidenceFile(
      f,
      Date.now() - 60_000,
      "disabledAfterData.rpcUnavailable=true, retainedRows={catalogRows:1,portfolioRows:1}, ownerCopy.catalogRows=38",
    );
    expect(good.status).toBe("pass");
    expect(good.detail).toContain("3 claimed field(s) match");
    expect(good.excerpt).toContain("rpcUnavailable");

    const bad = inspectEvidenceFile(f, Date.now() - 60_000, "ownerCopy.catalogRows=40");
    expect(bad.status).toBe("fail");
    expect(bad.detail).toContain("claimed 40, file has 38");
  });

  it("JSON: vitest failure markers downgrade to warn", () => {
    const f = path.join(dir, "vitest.json");
    writeFileSync(f, JSON.stringify({ numFailedTests: 3, numPassedTests: 697, success: false }));
    const r = inspectEvidenceFile(f, Date.now() - 60_000, "697/700 pass");
    expect(r.status).toBe("warn");
    expect(r.detail).toContain("numFailedTests=3");
  });

  it("logs are tailed; images need size and mtime ≥ run start", () => {
    const log = path.join(dir, "build.log");
    writeFileSync(log, `${"noise\n".repeat(500)}✓ built in 12.3s\n`);
    const l = inspectEvidenceFile(log, Date.now() - 60_000);
    expect(l.status).toBe("pass");
    expect(l.excerpt).toContain("built in 12.3s");
    expect(l.excerpt!.split("\n").length).toBeLessThanOrEqual(30);

    const png = path.join(dir, "shot.png");
    writeFileSync(png, PNG);
    expect(inspectEvidenceFile(png, Date.now() - 60_000).status).toBe("pass");
    const old = (Date.now() - 3_600_000) / 1000;
    utimesSync(png, old, old);
    expect(inspectEvidenceFile(png, Date.now() - 60_000).status).toBe("fail");
  });
});

describe("collectEvidence with file evidence refs", () => {
  it("a file claim whose ref is 'path; field=value' is verified by reading the file", async () => {
    const f = path.join(dir, "side-gateway-result.json");
    writeFileSync(f, JSON.stringify({ ok: true, disabledAfterData: { rpcUnavailable: true } }));
    const ev = await collectEvidence({
      workdir: null,
      baseCommit: null,
      runStartedAt: Date.now() - 60_000,
      rerunCommands: false,
      result: result([
        {
          claim: "Disabling unregisters the RPCs",
          evidence_type: "file",
          evidence_ref: `${f}; disabledAfterData.rpcUnavailable=true`,
        },
      ]),
    });
    const claim = ev.items.find((i) => i.kind === "claim")!;
    expect(claim.status).toBe("pass");
    expect(claim.excerpt).toContain("rpcUnavailable");
  });

  it("a command claim pointing at its log file is checked from the file, not failed as 'not listed'", async () => {
    const log = path.join(dir, "rp2-build2.log");
    writeFileSync(log, "tsc -p tsconfig.json\nverify-build: ok\n");
    const ev = await collectEvidence({
      workdir: null,
      baseCommit: null,
      runStartedAt: Date.now() - 60_000,
      rerunCommands: false,
      result: result([
        {
          claim: "backend build succeeds",
          evidence_type: "command",
          evidence_ref: `pnpm build (exit 0, ${log})`,
        },
      ]),
    });
    const claim = ev.items.find((i) => i.kind === "claim")!;
    expect(claim.status).toBe("pass");
    expect(claim.detail).toContain("referenced result file");
  });

  it("the script a command ran is not evidence of its output", async () => {
    const script = path.join(dir, "bench.mjs");
    writeFileSync(script, "console.log(1)");
    const ev = await collectEvidence({
      workdir: null,
      baseCommit: null,
      runStartedAt: Date.now() - 60_000,
      rerunCommands: false,
      result: result([
        { claim: "cold 25s -> 3ms", evidence_type: "command", evidence_ref: `node ${script}` },
      ]),
    });
    const claim = ev.items.find((i) => i.kind === "claim")!;
    expect(claim.status).toBe("fail");
    expect(claim.detail).toContain("not listed in checks_run");
  });

  it("multi-path screenshot claims check each path", async () => {
    const a = path.join(dir, "a.png");
    const b = path.join(dir, "b.png");
    writeFileSync(a, PNG);
    writeFileSync(b, PNG);
    const ev = await collectEvidence({
      workdir: null,
      baseCommit: null,
      runStartedAt: Date.now() - 60_000,
      rerunCommands: false,
      result: result([
        { claim: "pages verified", evidence_type: "screenshot", evidence_ref: `${a}, ${b}` },
      ]),
    });
    expect(ev.items.find((i) => i.kind === "claim")!.status).toBe("pass");
  });
});

describe("annotated command refs", () => {
  it("strips trailing annotations so '(node22)' is not re-run as shell", () => {
    expect(commandOfRef("pnpm build (node22)")).toBe("pnpm build");
    expect(commandOfRef("pnpm build (worktree, node22) exit 0")).toBe("pnpm build");
    expect(commandOfRef("npx vitest run src/a.test.ts — exit 0")).toBe(
      "npx vitest run src/a.test.ts",
    );
  });

  it("a bash syntax error is an environment problem, not a contradiction", () => {
    expect(
      environmentProblem({
        code: 2,
        output:
          "bash: -c: line 1: syntax error near unexpected token `('\nbash: -c: line 1: `pnpm build (node22)'",
      }),
    ).toMatch(/not a runnable shell command/);
  });
});
