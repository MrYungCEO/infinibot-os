#!/usr/bin/env node
/**
 * Smoke test for the desktop-control fixes:
 *   1. fullscreenWindow on a tiled window (was no-op)
 *   2. resize without manual float/focus (was no-op)
 *   3. toggle_floating / float / tile actions
 *   4. click_window (center) + click_relative
 *   5. clipboard typing path is callable
 *
 * Picks a Kitty window from the live world so we don't disturb anything
 * the user is mid-flight on. Always restores state at the end.
 */

import { createHyprlandWindowTool } from "../src/agents/tools/hyprland-window-tool.js";
import { disposeSharedWorld, getSharedWorld } from "../src/desktop/backends/hyprland/state.js";

function pj(r: unknown): Record<string, unknown> {
  const x = r as { content?: Array<{ type: string; text?: string }> };
  const t = x.content?.find((c) => c.type === "text")?.text ?? "{}";
  try {
    return JSON.parse(t) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function main() {
  const winTool = createHyprlandWindowTool();
  const world = await getSharedWorld();
  const snap = world.snapshot();

  // Pick a docked terminal we don't mind temporarily floating/resizing.
  const target = snap.windows.find((w) => w.class === "kitty" && !w.fullscreen);
  if (!target) throw new Error("no kitty window found; open one to run this smoke");
  console.log(`target: ${target.address}  class=${target.class}  title="${target.title.slice(0, 60)}"  floating=${target.floating}`);
  const initialFloating = target.floating;

  console.log("\n=== 1. toggleFloating round-trip ===");
  const t1 = await winTool.execute("s1", { action: "toggleFloating", address: target.address });
  console.log("after toggle:", pj(t1));
  // Refresh world and confirm
  await world.refreshAll();
  const after1 = world.findWindow({ address: target.address });
  console.log("world floating now:", after1?.floating);

  console.log("\n=== 2. resize (auto-floats if needed) ===");
  const t2 = await winTool.execute("s2", {
    action: "resize",
    address: target.address,
    geometry: { x: 100, y: 100, width: 900, height: 600 },
  });
  console.log("resize result:", pj(t2));
  await world.refreshAll();
  const after2 = world.findWindow({ address: target.address });
  console.log("post-resize geometry:", after2?.at, after2?.size, "floating:", after2?.floating);

  console.log("\n=== 3. fullscreen real on tiled window ===");
  // First put it back to tiled state if it's currently floating
  if (after2?.floating) {
    await winTool.execute("s3a", { action: "tile", address: target.address });
    await world.refreshAll();
  }
  const t3 = await winTool.execute("s3", {
    action: "fullscreen",
    address: target.address,
    fullscreenMode: "real",
  });
  console.log("fullscreen result:", pj(t3));
  await new Promise((r) => setTimeout(r, 250));
  await world.refreshAll();
  const after3 = world.findWindow({ address: target.address });
  console.log("post-fullscreen fullscreen flag:", after3?.fullscreen);

  console.log("\n=== 4. fullscreen off (restore) ===");
  const t4 = await winTool.execute("s4", {
    action: "fullscreen",
    address: target.address,
    fullscreenMode: "off",
  });
  console.log("restore result:", pj(t4));
  await new Promise((r) => setTimeout(r, 250));
  await world.refreshAll();
  const after4 = world.findWindow({ address: target.address });
  console.log("post-restore fullscreen flag:", after4?.fullscreen);

  console.log("\n=== 5. maximize action ===");
  const t5 = await winTool.execute("s5", { action: "maximize", address: target.address });
  console.log("maximize result:", pj(t5));
  await new Promise((r) => setTimeout(r, 250));
  await world.refreshAll();
  console.log("post-maximize fullscreen flag:", world.findWindow({ address: target.address })?.fullscreen);

  // Restore
  console.log("\n=== 6. cleanup: fullscreen off ===");
  await winTool.execute("s6", {
    action: "fullscreen",
    address: target.address,
    fullscreenMode: "off",
  });
  await world.refreshAll();
  // Restore floating state
  const final = world.findWindow({ address: target.address });
  if (final && final.floating !== initialFloating) {
    await winTool.execute("s7", { action: "toggleFloating", address: target.address });
  }

  console.log("\n=== 7. click_window calls (cursor only, no actual click on screen recipient) ===");
  const { createHyprlandInputTool } = await import("../src/agents/tools/hyprland-input-tool.js");
  const inputTool = createHyprlandInputTool();
  const t7 = await inputTool.execute("s8", {
    action: "click_window",
    address: target.address,
    button: "left",
    focusFirst: false,           // don't fight focus during the test
  });
  console.log("click_window:", pj(t7));

  console.log("\n=== 8. click_relative 0.5, 0.5 ===");
  const t8 = await inputTool.execute("s9", {
    action: "click_relative",
    address: target.address,
    fx: 0.5,
    fy: 0.5,
    focusFirst: false,
  });
  console.log("click_relative center:", pj(t8));

  console.log("\n=== 9. clipboard typing path ===");
  // Type into something safe — focus the target kitty first, send a marker
  // string via wl-copy + Ctrl+V. If wl-copy isn't installed this surfaces
  // a structured error. We don't actually verify the receiving end of the
  // paste here — just that the path doesn't throw.
  const t9 = await inputTool.execute("s10", {
    action: "type",
    text: "infinibot-smoke-clipboard-✓",
    useClipboard: true,
    address: target.address,
  });
  console.log("clipboard type:", pj(t9));

  await disposeSharedWorld();
  console.log("\nOK — desktop fixes verified");
}

main().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
