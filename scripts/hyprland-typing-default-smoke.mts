#!/usr/bin/env node
/**
 * Confirm the new default: a bare `type` call (no useClipboard, no
 * forceWtype) goes through the clipboard path and reports method=clipboard.
 *
 * Also confirms forceWtype routes to wtype as expected.
 */

import { createHyprlandInputTool } from "../src/agents/tools/hyprland-input-tool.js";
import { getSharedWorld, disposeSharedWorld } from "../src/desktop/backends/hyprland/state.js";

function pj(r: unknown): Record<string, unknown> {
  const x = r as { content?: Array<{ type: string; text?: string }> };
  const t = x.content?.find((c) => c.type === "text")?.text ?? "{}";
  try { return JSON.parse(t) as Record<string, unknown>; } catch { return {}; }
}

async function main() {
  const input = createHyprlandInputTool();
  const world = await getSharedWorld();
  const target = world.snapshot().windows.find((w) => w.class === "kitty");
  if (!target) throw new Error("need a kitty window open to run this");

  console.log("=== 1. Default (no flag) — should use clipboard ===");
  const r1 = await input.execute("t1", {
    action: "type",
    text: "Yo! 🤖 default path",
    address: target.address,
  });
  console.log(pj(r1));
  const m1 = pj(r1).method;
  if (m1 !== "clipboard") throw new Error(`expected method=clipboard, got ${m1}`);

  console.log("\n=== 2. useClipboard alias — should still be clipboard ===");
  const r2 = await input.execute("t2", {
    action: "type",
    text: "useClipboard alias",
    useClipboard: true,
    address: target.address,
  });
  console.log(pj(r2));
  if (pj(r2).method !== "clipboard") throw new Error("alias path failed");

  console.log("\n=== 3. forceWtype=true — should use wtype ===");
  const r3 = await input.execute("t3", {
    action: "type",
    text: "force wtype path",
    forceWtype: true,
    address: target.address,
  });
  console.log(pj(r3));
  if (pj(r3).method !== "wtype") throw new Error(`expected method=wtype, got ${pj(r3).method}`);

  await disposeSharedWorld();
  console.log("\nOK — default is clipboard, alias works, forceWtype works");
}

main().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
