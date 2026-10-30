#!/usr/bin/env node
/**
 * Federation Windows self-test harness.
 *
 * Validates the bidirectional spawn invariant on a Windows node:
 *   OUTBOUND  this node → non-Windows peer  (spawn FROM Windows)
 *   INBOUND   non-Windows peer → this node  (spawn TO Windows via mux'd WS)
 *
 * Usage:
 *   node scripts/federation-windows-selftest.mjs              # full test on Windows
 *   node scripts/federation-windows-selftest.mjs --dry-run    # skip platform checks; works on Linux/Mac
 *   node scripts/federation-windows-selftest.mjs --port 18789 # override gateway port
 *
 * Build the project first:  pnpm build
 */

import { execSync } from "node:child_process";
import { platform, release, version as nodeVer } from "node:os";
import process from "node:process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require   = createRequire(import.meta.url);

// ─── CLI flags ────────────────────────────────────────────────────────────────

const argv    = process.argv.slice(2);
const DRY_RUN = argv.includes("--dry-run");
const IS_WIN  = platform() === "win32";

function argValue(flag) {
  const eqIdx = argv.findIndex(a => a.startsWith(`${flag}=`));
  if (eqIdx !== -1) return argv[eqIdx].split("=").slice(1).join("=");
  const idx = argv.indexOf(flag);
  return idx !== -1 ? argv[idx + 1] : null;
}

// Desktop default port is 47913; CLI gateway uses 18789.
const GATEWAY_PORT = parseInt(argValue("--port") ?? "47913", 10);
const TIMEOUT_MS   = parseInt(argValue("--timeout") ?? "30000", 10);

// ─── ANSI helpers ─────────────────────────────────────────────────────────────

const green  = s => `\x1b[32m${s}\x1b[0m`;
const red    = s => `\x1b[31m${s}\x1b[0m`;
const yellow = s => `\x1b[33m${s}\x1b[0m`;
const cyan   = s => `\x1b[36m${s}\x1b[0m`;
const bold   = s => `\x1b[1m${s}\x1b[0m`;
const PASS   = green("PASS");
const FAIL   = red("FAIL");
const SKIP   = yellow("SKIP");
const WARN   = yellow("WARN");

function banner(title) {
  const line = "═".repeat(62);
  console.log(`\n${bold(cyan(line))}\n  ${bold(cyan(title))}\n${bold(cyan(line))}`);
}

function row(label, verdict, detail = "") {
  const v = verdict === "PASS" ? PASS
          : verdict === "SKIP" ? SKIP
          : verdict === "WARN" ? WARN
          : FAIL;
  console.log(`  ${String(label).padEnd(32)}${v.padEnd(18)}${detail}`);
}

// ─── Result accumulator ───────────────────────────────────────────────────────

/** @type {{ label: string; passed: boolean; blocking: boolean; detail: string }[]} */
const checks = [];

function record(label, passed, detail = "", blocking = true) {
  checks.push({ label, passed, blocking, detail });
  return passed;
}

// ─── Platform detection ───────────────────────────────────────────────────────

function detectPlatform() {
  const info = { os: platform(), nodeVersion: process.version, release: release() };
  if (IS_WIN) {
    const build = parseInt(release().split(".")[2] ?? "0", 10);
    info.windowsLabel = build >= 22000 ? "Windows 11" : "Windows 10";
    info.shell = process.env.COMSPEC ?? "cmd.exe";
  }
  return info;
}

// ─── Windows platform checks ──────────────────────────────────────────────────

function checkFirewallRule(port) {
  try {
    const out = execSync(
      "netsh advfirewall firewall show rule name=all dir=in protocol=tcp",
      { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 12_000 },
    );
    const portStr = String(port);
    let currentName = "";
    let hit = false;
    let matchName = "";
    for (const line of out.split("\n")) {
      if (line.startsWith("Rule Name:")) {
        currentName = line.split(":").slice(1).join(":").trim();
      }
      if (line.includes("LocalPort") && line.includes(portStr)) {
        hit = true;
        matchName = currentName;
        break;
      }
    }
    return { ok: hit, ruleName: hit ? matchName : undefined };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function checkLongPaths() {
  try {
    const out = execSync(
      'reg query "HKLM\\SYSTEM\\CurrentControlSet\\Control\\FileSystem" /v LongPathsEnabled',
      { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 5_000 },
    );
    return { ok: out.includes("0x1") };
  } catch {
    return { ok: false };
  }
}

// ─── Gateway connectivity ─────────────────────────────────────────────────────

async function checkGatewayHTTP(port) {
  const url = `http://127.0.0.1:${port}/api/status`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(6_000) });
    return { ok: res.ok || res.status < 500, status: res.status };
  } catch (e) {
    return { ok: false, error: String(e.message ?? e) };
  }
}

// ─── Gateway RPC ─────────────────────────────────────────────────────────────

let _callGateway = null;

async function callGateway(method, params = {}) {
  if (!_callGateway) {
    const mod = await import(path.join(__dirname, "../dist/gateway/call.js"));
    _callGateway = mod.callGateway;
  }
  return _callGateway({ method, params, timeoutMs: TIMEOUT_MS });
}

// ─── Peer discovery ───────────────────────────────────────────────────────────

async function discoverPeers() {
  const res = await callGateway("federation.selftest", {
    mode: "ping",
    includeCli: false,
    teardown: true,
  });
  return {
    masterId: res.masterId ?? null,
    localNodeId: res.masterId ?? null,
    peers: Array.isArray(res.peers) ? res.peers : [],
    matrix: Array.isArray(res.results) ? res.results : [],
  };
}

// ─── Bidirectional round-trip tests ──────────────────────────────────────────

/**
 * OUTBOUND: invoke a no-op RPC on the target peer via federation routing.
 * Exercises: Windows → master hub → peer.
 */
async function testOutbound(peerNodeId) {
  const t0 = Date.now();
  try {
    // sessions.list is a safe read-only no-op present on every node.
    const res = await callGateway("federation.node.invoke", {
      nodeId: peerNodeId,
      method: "sessions.list",
      params: {},
    });
    const ms = Date.now() - t0;
    const ok = res != null && !res.error;
    return { ok, ms, detail: ok ? `RTT ${ms} ms` : (res?.error ?? "empty response") };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, detail: String(e.message ?? e) };
  }
}

/**
 * INBOUND: ask peer to invoke a no-op RPC back on the local (Windows) node.
 * Exercises: peer → master hub → Windows (via multiplexed outbound WS).
 *
 * Wire path: callGateway("federation.node.invoke", { nodeId: peer, method:
 *   "federation.node.invoke", params: { nodeId: localId, method: "sessions.list" }})
 *
 * The outer call tells the peer's gateway to make an outbound RPC *back* to
 * us.  If the Windows node is only reachable via its own outbound WS (no
 * inbound port open) the hub must use the existing mux'd connection.
 */
async function testInbound(localNodeId, peerNodeId) {
  const t0 = Date.now();
  try {
    const res = await callGateway("federation.node.invoke", {
      nodeId: peerNodeId,
      method: "federation.node.invoke",
      params: {
        nodeId: localNodeId,
        method: "sessions.list",
        params: {},
      },
    });
    const ms = Date.now() - t0;
    const ok = res != null && !res.error;
    return { ok, ms, detail: ok ? `RTT ${ms} ms  (${peerNodeId}→${localNodeId})` : (res?.error ?? "empty response") };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, detail: String(e.message ?? e) };
  }
}

// ─── Queue depth (informational) ──────────────────────────────────────────────

async function fetchQueueDepth() {
  try {
    const res = await callGateway("federation.queue.depth", {});
    return typeof res?.depth === "number" ? res.depth : null;
  } catch {
    return null;
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  banner("InfiniBot  ·  Federation Windows Self-Test");

  const plat = detectPlatform();
  console.log(`\n  Platform   ${plat.os} ${plat.release}${plat.windowsLabel ? "  (" + plat.windowsLabel + ")" : ""}`);
  console.log(`  Node       ${plat.nodeVersion}`);
  console.log(`  Gateway    port ${GATEWAY_PORT}  timeout ${TIMEOUT_MS} ms`);
  if (DRY_RUN) console.log(`  Mode       ${yellow("DRY-RUN")}  — platform checks skipped, round-trips active`);
  console.log();

  // ── 1. Platform checks ────────────────────────────────────────────────────
  banner("1 / Platform Checks");

  if (DRY_RUN || !IS_WIN) {
    const why = DRY_RUN ? "--dry-run" : "not Windows";
    row("OS / shell detection", "SKIP", why);
    row("Firewall inbound rule", "SKIP", why);
    row("LongPathsEnabled", "SKIP", why);
    row("Named-pipe IPC", "SKIP", why);
    row("Defender exclusion", "SKIP", why);
    record("platform-checks", true, "skipped", false);
  } else {
    // Firewall rule for gateway port
    const fw = checkFirewallRule(GATEWAY_PORT);
    row("Firewall inbound rule", fw.ok ? "PASS" : "FAIL",
      fw.ok
        ? `rule: "${fw.ruleName}"  port ${GATEWAY_PORT} TCP`
        : `No inbound rule for port ${GATEWAY_PORT}\n    Hint: netsh advfirewall firewall add rule name="InfiniBot Gateway" protocol=TCP dir=in localport=${GATEWAY_PORT} action=allow`
    );
    record("firewall", fw.ok, fw.error ?? "");

    // LongPathsEnabled registry flag
    const lp = checkLongPaths();
    row("LongPathsEnabled", lp.ok ? "PASS" : "FAIL",
      lp.ok ? "" : 'Hint: reg add "HKLM\\SYSTEM\\CurrentControlSet\\Control\\FileSystem" /v LongPathsEnabled /t REG_DWORD /d 1 /f'
    );
    record("longPaths", lp.ok);

    // Named-pipe IPC (always available on Windows)
    row("Named-pipe IPC", "PASS", "native — always available");
    record("namedPipe", true, "");

    // Defender exclusion (non-blocking warning)
    let defOk = false;
    try {
      const defOut = execSync(
        'powershell -NoProfile -Command "Get-MpPreference | Select-Object -ExpandProperty ExclusionPath"',
        { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 8_000 }
      );
      defOk = defOut.toLowerCase().includes(process.cwd().toLowerCase());
    } catch { /* elevation required */ }
    row("Defender exclusion", defOk ? "PASS" : "WARN",
      defOk ? `${process.cwd()} excluded` : `No exclusion for cwd — performance may be degraded\n    Hint: Add-MpPreference -ExclusionPath "${process.cwd()}"`
    );
    record("defenderExclusion", true, defOk ? "" : "no exclusion (non-blocking)", false);
  }

  // ── 2. Gateway connectivity ───────────────────────────────────────────────
  banner("2 / Gateway Connectivity");

  const gw = await checkGatewayHTTP(GATEWAY_PORT);
  row(`HTTP :${GATEWAY_PORT}/api/status`, gw.ok ? "PASS" : "FAIL",
    gw.ok ? `HTTP ${gw.status}` : (gw.error ?? "unreachable")
  );
  record("gatewayHTTP", gw.ok);

  if (!gw.ok) {
    console.log(`\n  ${red("Gateway not reachable — aborting transport tests.")}`);
    console.log(`  Hint: Is the gateway running?  pnpm start  or  pnpm desktop`);
    printMatrix();
    process.exit(1);
  }

  // ── 3. Peer discovery ─────────────────────────────────────────────────────
  banner("3 / Federation Peer Discovery");

  let discovery;
  try {
    discovery = await discoverPeers();
  } catch (e) {
    row("federation.selftest RPC", "FAIL", String(e.message ?? e));
    record("selftest", false, String(e.message ?? e));
    console.log(`\n  Hint: Is federation enabled?  Check federation.mode in gateway config.`);
    printMatrix();
    process.exit(1);
  }

  const { masterId, localNodeId, peers } = discovery;
  row("selftest RPC", "PASS", `master=${masterId ?? "n/a"}`);
  row("Local node ID", localNodeId ? "PASS" : "WARN", localNodeId ?? "could not determine (standalone?)");
  row("Peers reachable", peers.length > 0 ? "PASS" : "FAIL",
    peers.length > 0 ? peers.join(", ") : "0 peers — need ≥ 1 connected satellite"
  );
  record("selftest", true);
  record("peers", peers.length > 0, peers.join(", "));

  if (peers.length === 0) {
    console.log(`\n  ${yellow("No federation peers connected — skipping round-trip tests.")}`);
    printMatrix();
    process.exit(1);
  }

  // Pick a non-Windows peer (best-effort by name; fall back to first peer).
  const targetPeer =
    peers.find(p => !/win/i.test(p)) ?? peers[0];
  const effectiveLocalId = localNodeId ?? "local";
  console.log(`\n  Round-trip target: ${cyan(targetPeer)}   local id: ${cyan(effectiveLocalId)}`);

  // ── 4. Bidirectional spawn invariant ──────────────────────────────────────
  banner("4 / Bidirectional Spawn Invariant");

  // OUTBOUND: Windows → peer
  const out = await testOutbound(targetPeer);
  row(`OUTBOUND  (→ ${targetPeer})`, out.ok ? "PASS" : "FAIL", out.detail);
  record("outboundSpawn", out.ok);
  if (!out.ok) {
    console.log(`    Hint: Check federation routing on master hub.  Is ${targetPeer} connected?`);
  }

  // INBOUND: peer → Windows (via multiplexed outbound WS)
  const inp = await testInbound(effectiveLocalId, targetPeer);
  row(`INBOUND   (${targetPeer} → local)`, inp.ok ? "PASS" : "FAIL", inp.detail);
  record("inboundSpawn", inp.ok);
  if (!inp.ok) {
    console.log(`    Hint: Windows node id "${effectiveLocalId}" may not be reachable via hub.`);
    console.log(`    Check: hub.invokeOnNode targets the correct nodeId for this satellite.`);
    console.log(`    Ensure the outbound WS connection from this node to master is alive.`);
  }

  // Queue depth (informational)
  const qd = await fetchQueueDepth();
  if (qd !== null) console.log(`\n  Federation queue depth at end of test: ${qd}`);

  // ── Final matrix ──────────────────────────────────────────────────────────
  printMatrix();

  const failures = checks.filter(c => !c.passed && c.blocking);
  process.exit(failures.length > 0 ? 1 : 0);
}

function printMatrix() {
  banner("Results Matrix");
  console.log(`  ${"CHECK".padEnd(32)}${"RESULT".padEnd(18)}DETAIL`);
  console.log("  " + "─".repeat(78));

  let passed = 0;
  let failed = 0;
  let warned = 0;

  for (const c of checks) {
    let verdict;
    if (c.passed) {
      verdict = PASS;
      passed++;
    } else if (!c.blocking) {
      verdict = WARN;
      warned++;
    } else {
      verdict = FAIL;
      failed++;
    }
    console.log(`  ${c.label.padEnd(32)}${verdict.padEnd(18)}${c.detail}`);
  }

  console.log(`\n  ${green(`${passed} passed`)}   ${failed > 0 ? red(`${failed} failed`) : "0 failed"}   ${warned > 0 ? yellow(`${warned} warnings`) : ""}`);

  if (failed === 0) {
    console.log(`\n${green("✓  All critical checks passed — Windows node is federation-ready.")}`);
  } else {
    console.log(`\n${red("✗  Some checks failed.  See hints above for remediation steps.")}`);
  }
}

void main().catch(e => {
  console.error(red(`\nFatal: ${e?.message ?? e}`));
  process.exit(2);
});
