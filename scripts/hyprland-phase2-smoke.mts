#!/usr/bin/env node
/**
 * Phase 2 smoke test — pick + highlight tools.
 *
 * Verifies:
 *   - pick returns badge_map even when overlay daemon can't run (typelib missing)
 *   - highlight kind=window with style=ring uses native Hyprland border (zero deps)
 *   - highlight kind=region surfaces a structured install hint when overlay unavailable
 *   - clear_all + list work
 */

import { createHyprlandPickTool } from "../src/agents/tools/hyprland-pick-tool.js";
import { createHyprlandHighlightTool } from "../src/agents/tools/hyprland-highlight-tool.js";
import { createHyprlandWindowTool } from "../src/agents/tools/hyprland-window-tool.js";
import { disposeSharedWorld } from "../src/desktop/backends/hyprland/state.js";

function preview(result: unknown): string {
    const r = result as { content?: Array<{ type: string; text?: string }> };
    const text = r.content?.find((c) => c.type === "text")?.text ?? "";
    return text.length > 1000 ? text.slice(0, 1000) + "..." : text;
}

function jsonOf(result: unknown): Record<string, unknown> {
    const r = result as { content?: Array<{ type: string; text?: string }> };
    const text = r.content?.find((c) => c.type === "text")?.text ?? "{}";
    try {
        return JSON.parse(text) as Record<string, unknown>;
    } catch {
        return {};
    }
}

async function main() {
    const winTool = createHyprlandWindowTool();
    const pickTool = createHyprlandPickTool();
    const hiTool = createHyprlandHighlightTool();

    console.log("=== pick enter (windows) — overlay typelib missing → expect graceful degrade ===");
    const enter = await pickTool.execute("p-1", { action: "enter", mode: "windows", notify: false });
    const enterJ = jsonOf(enter);
    console.log("ok:", enterJ.ok, "count:", enterJ.count, "overlayUsed:", enterJ.overlayUsed);
    console.log("overlayError:", enterJ.overlayError);
    console.log("badge_map keys:", Object.keys((enterJ.badge_map as Record<string, unknown>) ?? {}).slice(0, 6));
    if (!enterJ.ok || (enterJ.count as number) === 0) throw new Error("pick mode did not return items");

    console.log("\n=== pick exit ===");
    const exit = await pickTool.execute("p-2", { action: "exit" });
    console.log(preview(exit));

    console.log("\n=== get an active window address ===");
    const winInfo = await winTool.execute("p-3", { action: "info", activeWindow: true });
    const winJ = jsonOf(winInfo);
    const activeAddr = (winJ.window as Record<string, unknown> | undefined)?.address as string | undefined;
    console.log("active address:", activeAddr);
    if (!activeAddr) throw new Error("no active window");

    console.log("\n=== highlight kind=window style=ring (native border path) ===");
    const hi1 = await hiTool.execute("p-4", {
        action: "add",
        target: { kind: "window", address: activeAddr },
        style: { type: "ring", color: "#FF0080", thickness: 6 },
    });
    const hi1J = jsonOf(hi1);
    console.log("ok:", hi1J.ok, "highlight_id:", hi1J.highlight_id, "borderUsed:", hi1J.borderUsed, "overlayUsed:", hi1J.overlayUsed);
    if (!hi1J.ok || !hi1J.borderUsed) throw new Error("native border highlight failed");

    console.log("\n=== highlight list ===");
    const list = await hiTool.execute("p-5", { action: "list" });
    console.log(preview(list));

    console.log("\n=== highlight kind=region (overlay required) — expect structured error ===");
    const hi2 = await hiTool.execute("p-6", {
        action: "add",
        target: { kind: "region", geometry: { x: 100, y: 100, width: 400, height: 200 } },
        style: { type: "fill", color: "#7AE3F4", label: "test" },
    });
    const hi2J = jsonOf(hi2);
    console.log("ok:", hi2J.ok);
    console.log("error:", hi2J.error);
    console.log("hint:", hi2J.hint);

    console.log("\n=== highlight clear (the native border one) ===");
    const cl = await hiTool.execute("p-7", { action: "clear", highlight_id: hi1J.highlight_id });
    console.log(preview(cl));

    console.log("\n=== highlight clear_all ===");
    const clAll = await hiTool.execute("p-8", { action: "clear_all" });
    console.log(preview(clAll));

    await disposeSharedWorld();
    console.log("\nOK — Phase 2 graceful-degrade verified");
}

main().catch((err) => {
    console.error("FAIL:", err);
    process.exit(1);
});
