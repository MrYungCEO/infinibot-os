#!/usr/bin/env node
/**
 * Phase 1 smoke test for the Hyprland desktop backend.
 *
 * Exercises listDisplays, the cached world (windows, workspaces, monitors),
 * and a screen capture against a real Hyprland session. Throws on any failure
 * so CI / manual runs can grep for "OK".
 *
 * Run: node --import tsx scripts/hyprland-smoke.mts
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { detectBackend, describeBackend } from "../src/desktop/detect.js";
import { getSharedWorld, disposeSharedWorld } from "../src/desktop/backends/hyprland/state.js";

async function main() {
    const backend = await detectBackend();
    console.log(describeBackend(backend));
    if (backend.kind !== "hyprland") {
        console.log("not on Hyprland — skipping live tests");
        return;
    }

    console.log("\n--- listDisplays ---");
    const displays = await backend.listDisplays();
    console.log(JSON.stringify(displays, null, 2));
    if (displays.length === 0) throw new Error("expected at least one display");

    console.log("\n--- shared world snapshot ---");
    const world = await getSharedWorld();
    const snap = world.snapshot();
    console.log(`monitors: ${snap.monitors.length}`);
    console.log(`workspaces: ${snap.workspaces.length}`);
    console.log(`windows: ${snap.windows.length}`);
    console.log(`activeWindow: ${snap.activeWindowAddress}`);
    console.log(`activeWorkspaceId: ${snap.activeWorkspaceId}`);
    console.log(`focusedMonitor: ${snap.focusedMonitorName}`);

    console.log("\n--- a few windows ---");
    for (const w of snap.windows.slice(0, 5)) {
        console.log(`  ${w.address}  ws=${w.workspace.id}  ${w.class}  "${w.title.slice(0, 50)}"`);
    }

    console.log("\n--- screenshot primary monitor ---");
    const out = path.join(os.tmpdir(), `infinibot-smoke-${Date.now()}.png`);
    const shot = await backend.screenshotDisplay({ display: 1, out });
    if (!shot.ok) throw new Error(`screenshot failed: ${shot.error}`);
    const stat = await fs.stat(shot.path!);
    console.log(`wrote ${shot.path} (${stat.size} bytes, ${shot.width}x${shot.height})`);
    if (stat.size < 1000) throw new Error("screenshot is suspiciously small");
    await fs.unlink(shot.path!).catch(() => {});

    console.log("\n--- event stream (3s window) ---");
    let eventCount = 0;
    world.on("active-window-change", (addr) => {
        eventCount++;
        console.log(`  active-window-change → ${addr}`);
    });
    world.on("window-opened", (addr) => {
        eventCount++;
        console.log(`  window-opened → ${addr}`);
    });
    world.on("window-closed", (addr) => {
        eventCount++;
        console.log(`  window-closed → ${addr}`);
    });
    await new Promise((r) => setTimeout(r, 3000));
    console.log(`  events observed: ${eventCount}`);

    await disposeSharedWorld();
    console.log("\nOK");
}

main().catch((err) => {
    console.error("FAIL:", err);
    process.exit(1);
});
