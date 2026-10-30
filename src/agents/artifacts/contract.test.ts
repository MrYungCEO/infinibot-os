import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ensureRunArtifactsDir,
  parseShotName,
  parseStepsJson,
  parseVerificationMd,
  readRunArtifacts,
  resolveRunArtifactsDir,
} from "./contract.js";

const tmpDirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "artifact-contract-"));
  tmpDirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});

describe("parseStepsJson", () => {
  it("parses a valid ordered array", () => {
    const { steps, errors } = parseStepsJson(
      JSON.stringify([
        { id: "01-setup", title: "Install deps", status: "done" },
        { id: "02-build", title: "Build", status: "failed", note: "tsc error" },
        { id: "03-shots", title: "Screenshots", status: "skipped" },
      ]),
    );
    expect(errors).toEqual([]);
    expect(steps).toHaveLength(3);
    expect(steps[0]).toEqual({ id: "01-setup", title: "Install deps", status: "done" });
    expect(steps[1].status).toBe("failed");
    expect(steps[1].note).toBe("tsc error");
    expect(steps[2].status).toBe("skipped");
  });

  it("accepts a { steps: [...] } wrapper", () => {
    const { steps, errors } = parseStepsJson(
      JSON.stringify({ steps: [{ id: "a", title: "A", status: "done" }] }),
    );
    expect(errors).toEqual([]);
    expect(steps).toHaveLength(1);
  });

  it("coerces unknown statuses to done and fills missing ids/titles", () => {
    const { steps } = parseStepsJson(
      JSON.stringify([
        { id: "x", title: "X", status: "in_progress" },
        { title: "no id here" },
        { id: "only-id" },
      ]),
    );
    expect(steps[0].status).toBe("done");
    expect(steps[1].id).toBe("step-2");
    expect(steps[2].title).toBe("only-id");
  });

  it("skips invalid entries but keeps valid ones, reporting errors", () => {
    const { steps, errors } = parseStepsJson(
      JSON.stringify([{ id: "ok", title: "Ok", status: "done" }, 42, {}, null]),
    );
    expect(steps).toHaveLength(1);
    expect(errors).toHaveLength(3);
  });

  it("returns an error for garbage input without throwing", () => {
    expect(parseStepsJson("not json at all").steps).toEqual([]);
    expect(parseStepsJson("not json at all").errors[0]).toMatch(/invalid JSON/);
    expect(parseStepsJson('"a string"').errors[0]).toMatch(/expected an array/);
    expect(parseStepsJson("{}").errors[0]).toMatch(/expected an array/);
  });
});

describe("parseVerificationMd", () => {
  it("extracts PASS/FAIL claims from a GFM table and a SHIP verdict", () => {
    const md = [
      "# Verification",
      "",
      "| Claim | Result |",
      "| --- | --- |",
      "| Build passes | PASS |",
      "| Chip renders on card | ✅ PASS |",
      "| Mobile layout intact | FAIL |",
      "",
      "Overall: **SHIP**",
    ].join("\n");
    const v = parseVerificationMd(md);
    expect(v.verdict).toBe("SHIP");
    expect(v.claims).toHaveLength(3);
    expect(v.claims[0]).toEqual({ claim: "Build passes", status: "PASS" });
    expect(v.claims[2].status).toBe("FAIL");
  });

  it("prefers DO-NOT-SHIP over the SHIP substring it contains", () => {
    expect(parseVerificationMd("Overall verdict: DO-NOT-SHIP").verdict).toBe("DO-NOT-SHIP");
    expect(parseVerificationMd("Overall verdict: DO NOT SHIP").verdict).toBe("DO-NOT-SHIP");
  });

  it("returns null verdict + empty claims for prose without a verdict", () => {
    const v = parseVerificationMd("just some notes, nothing tabular");
    expect(v.verdict).toBeNull();
    expect(v.claims).toEqual([]);
  });
});

describe("parseShotName", () => {
  it("splits contract-named shots into step + viewport", () => {
    expect(parseShotName("02-dashboard-desktop.png")).toEqual({
      step: "02-dashboard",
      viewport: "desktop",
    });
    expect(parseShotName("01-login-mobile.png")).toEqual({ step: "01-login", viewport: "mobile" });
  });

  it("keeps non-contract names with an empty viewport", () => {
    expect(parseShotName("random.png")).toEqual({ step: "random", viewport: "" });
  });
});

describe("ensureRunArtifactsDir / readRunArtifacts", () => {
  it("creates the nested dir (including shots/) and resolves the contract path", () => {
    const base = tmp();
    const dir = ensureRunArtifactsDir("coder-test-run", base);
    expect(dir).toBe(resolveRunArtifactsDir("coder-test-run", base));
    expect(dir).toContain(join("agents", "main", "runs", "coder-test-run", "artifacts"));
  });

  it("reads a fully-populated artifacts dir", () => {
    const base = tmp();
    const dir = ensureRunArtifactsDir("coder-full", base)!;
    writeFileSync(join(dir, "report.md"), "# Did the thing");
    writeFileSync(
      join(dir, "steps.json"),
      JSON.stringify([{ id: "01-a", title: "A", status: "done" }]),
    );
    writeFileSync(join(dir, "verification.md"), "| c | PASS |\n\nSHIP");
    writeFileSync(join(dir, "shots", "01-a-desktop.png"), Buffer.from([0x89, 0x50]));
    writeFileSync(join(dir, "shots", "01-a-mobile.png"), Buffer.from([0x89, 0x50]));

    const a = readRunArtifacts(dir);
    expect(a.reportMd).toContain("Did the thing");
    expect(a.steps).toHaveLength(1);
    expect(a.verification.verdict).toBe("SHIP");
    expect(a.shots.map((s) => s.viewport).sort()).toEqual(["desktop", "mobile"]);
    expect(a.shots[0].step).toBe("01-a");
  });

  it("returns empty artifacts for a run that ignored the contract (backward compat)", () => {
    const base = tmp();
    const dir = join(base, "does-not-exist");
    const a = readRunArtifacts(dir);
    expect(a.reportMd).toBe("");
    expect(a.steps).toEqual([]);
    expect(a.shots).toEqual([]);
    expect(a.verification.verdict).toBeNull();
  });
});
