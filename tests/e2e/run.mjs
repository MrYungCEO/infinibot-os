#!/usr/bin/env node
/**
 * Agency e2e entry point — UI route coverage + the autonomy lifecycle.
 *
 *   node tests/e2e/run.mjs                 # everything, SAFE (no CLI spend)
 *   node tests/e2e/run.mjs --routes        # UI routes only
 *   node tests/e2e/run.mjs --autonomy      # autonomy lifecycle only
 *   node tests/e2e/run.mjs --live          # ALSO stages real cards ($$$)
 *
 * Exits non-zero if any check fails. Every work item it creates is cancelled
 * before it exits, including on failure.
 *
 * Requires: the gateway serving the built UI (default http://localhost:18789)
 * and a Chromium from ms-playwright. Override with VERIFY_UI_URL /
 * VERIFY_GATEWAY_URL / VERIFY_CHROME.
 */
import { openControlUi, BASE_URL } from "./lib/harness.mjs";
import { createReporter } from "./lib/report.mjs";
import { runRouteSuite } from "./routes.mjs";
import { runAutonomySuite } from "./autonomy.mjs";

const argv = process.argv.slice(2);
const live = argv.includes("--live");
const onlyRoutes = argv.includes("--routes");
const onlyAutonomy = argv.includes("--autonomy");
const wantRoutes = onlyRoutes || !onlyAutonomy;
const wantAutonomy = onlyAutonomy || !onlyRoutes;

const reporter = createReporter("agency e2e");
const started = Date.now();

console.log(`agency e2e — ${BASE_URL} — mode: ${live ? "LIVE (spends CLI budget)" : "SAFE"}`);
if (live) {
  console.log(
    "!! --live stages real work items; the assigned AI employees will spawn coder CLIs.",
  );
}

let session;
try {
  session = await openControlUi({ route: "/agency-operations" });

  const agencies = await session.rpcOrThrow("agency.ops.agencies.list", {});
  const list = agencies?.agencies ?? [];
  const agency = list.find((a) => a.role === "owner") ?? list[0];
  if (!agency) throw new Error("no agency is visible to this account");
  console.log(`agency: ${agency.name} (${agency.id})\n`);

  if (wantRoutes) await runRouteSuite(session, reporter, agency.id);
  if (wantAutonomy) await runAutonomySuite(session, reporter, agency.id, { live });
} catch (error) {
  reporter.group("harness");
  reporter.fail("suite ran to completion", String(error?.stack ?? error));
} finally {
  await session?.close();
}

console.log(`\nelapsed ${Math.round((Date.now() - started) / 1000)}s`);
const ok = reporter.printSummary();
console.log(ok ? "\nRESULT: PASS" : "\nRESULT: FAIL");
process.exit(ok ? 0 : 1);
