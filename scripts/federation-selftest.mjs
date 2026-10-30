#!/usr/bin/env node
/**
 * Federation cross-node routing self-test.
 *
 * Exercises the full 6-cell matrix — master↔satellite↔satellite, both
 * directions — for the routing path that BOTH gateway sessions and CLI coder
 * spawns travel, and prints a pass/fail table per cell.
 *
 * MUST be run on the MASTER node (it drives every satellite origin via the
 * hub). Requires the gateway to be running; nothing here restarts it.
 *
 * Usage:
 *   node scripts/federation-selftest.mjs                 # transport ping matrix (safe, default)
 *   node scripts/federation-selftest.mjs --spawn         # real sessions.spawn per cell + teardown
 *   node scripts/federation-selftest.mjs --spawn --cli   # also spawn a CLI coder per cell
 *   node scripts/federation-selftest.mjs --no-teardown   # leave spawned children running
 *
 * Build first if running from source:  pnpm build
 */
import { callGateway } from "../dist/gateway/call.js";

const argv = process.argv.slice(2);
const mode = argv.includes("--spawn") ? "spawn" : "ping";
const includeCli = argv.includes("--cli");
const teardown = !argv.includes("--no-teardown");

function colorize(pass) {
  return pass ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m";
}

async function main() {
  let res;
  try {
    res = await callGateway({
      method: "federation.selftest",
      params: { mode, includeCli, teardown },
      timeoutMs: 120_000,
    });
  } catch (err) {
    console.error(`\nfederation.selftest call failed: ${err?.message || err}`);
    console.error("Is the gateway running? Are you on the MASTER node?");
    process.exit(2);
    return;
  }

  console.log(`\nFederation self-test — mode: ${res.mode}`);
  console.log(`Master: ${res.masterId}`);
  console.log(`Satellites connected: ${res.peers?.length ?? 0} ${res.peers?.length ? `(${res.peers.join(", ")})` : ""}`);
  console.log(`Matrix cells: ${res.cellCount}   Checks run: ${res.totalChecks}\n`);

  if (res.note) console.log(`⚠ ${res.note}\n`);

  const rows = res.results ?? [];
  if (rows.length === 0) {
    console.log("No checks were run (need at least one connected satellite).");
  } else {
    const w = (s, n) => String(s).padEnd(n);
    console.log(
      `${w("DIRECTION", 24)}${w("ORIGIN", 16)}${w("TARGET", 16)}${w("VARIANT", 16)}${w("RESULT", 8)}DETAIL`,
    );
    console.log("-".repeat(110));
    for (const r of rows) {
      console.log(
        `${w(r.direction, 24)}${w(r.origin, 16)}${w(r.target, 16)}${w(r.variant, 16)}${w(colorize(r.pass), 17)}${r.detail ?? ""}`,
      );
    }
  }

  console.log(`\n${res.passed}/${res.totalChecks} checks passed.`);
  if (res.allPassed) {
    console.log("\x1b[32m✓ All cells passed.\x1b[0m");
    process.exit(0);
  } else {
    console.log("\x1b[31m✗ Some cells failed (or no satellites connected).\x1b[0m");
    process.exit(1);
  }
}

void main();
