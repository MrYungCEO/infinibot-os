/**
 * Minimal check recorder: collects PASS / FAIL / SKIP per assertion, prints a
 * grouped summary and decides the process exit code.
 *
 * Deliberately not a test framework — the repo has vitest, but these suites
 * must drive a real browser against a live gateway with ordered setup and a
 * guaranteed cleanup phase, which a per-file test runner makes awkward.
 */

const ICON = { pass: "PASS", fail: "FAIL", skip: "SKIP" };

export function createReporter(title) {
  /** @type {{group: string, name: string, state: 'pass'|'fail'|'skip', detail: string}[]} */
  const checks = [];
  let group = "general";

  const record = (state, name, detail = "") => {
    checks.push({ group, name, state, detail });
    const line = `  ${ICON[state]}  ${name}${detail ? ` — ${detail}` : ""}`;
    console.log(line);
    return state === "pass";
  };

  return {
    title,
    /** Start a named group; printed as a header. */
    group(name) {
      group = name;
      console.log(`\n--- ${name} ---`);
    },
    /** Record a boolean assertion. `detail` should explain a failure. */
    check(name, ok, detail = "") {
      return record(ok ? "pass" : "fail", name, ok ? "" : detail);
    },
    /** Record a check that could not run (with the reason). */
    skip(name, reason) {
      return record("skip", name, reason);
    },
    /** Record an unconditional failure (thrown error, setup blew up). */
    fail(name, detail) {
      return record("fail", name, detail);
    },
    /** Informational line — never affects the exit code. */
    info(message) {
      console.log(`  ....  ${message}`);
    },
    get failures() {
      return checks.filter((c) => c.state === "fail");
    },
    get checks() {
      return checks;
    },
    summary() {
      const pass = checks.filter((c) => c.state === "pass").length;
      const fail = checks.filter((c) => c.state === "fail").length;
      const skip = checks.filter((c) => c.state === "skip").length;
      return { pass, fail, skip, total: checks.length };
    },
    printSummary() {
      const { pass, fail, skip, total } = this.summary();
      console.log(`\n===== ${title}: ${pass}/${total} passed, ${fail} failed, ${skip} skipped =====`);
      if (fail) {
        console.log("failing checks:");
        for (const c of this.failures) {
          console.log(`  - [${c.group}] ${c.name}${c.detail ? ` — ${c.detail}` : ""}`);
        }
      }
      return fail === 0;
    },
  };
}

/** Truncate long page text so failure details stay readable. */
export function excerpt(text, max = 220) {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}
