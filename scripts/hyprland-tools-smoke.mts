#!/usr/bin/env node
/**
 * Tool-level smoke test — calls the 5 Hyprland tools directly via their
 * execute() handlers, exactly as the gateway would, to confirm the
 * agent-facing surface works end-to-end on this Hyprland session.
 */

import { createHyprlandWindowTool } from "../src/agents/tools/hyprland-window-tool.js";
import { createHyprlandWorkspaceTool } from "../src/agents/tools/hyprland-workspace-tool.js";
import { createHyprlandCaptureTool } from "../src/agents/tools/hyprland-capture-tool.js";
import { disposeSharedWorld } from "../src/desktop/backends/hyprland/state.js";

function preview(result: unknown): string {
    const r = result as { content?: Array<{ type: string; text?: string }> };
    const text = r.content?.find((c) => c.type === "text")?.text ?? "";
    return text.length > 600 ? text.slice(0, 600) + "..." : text;
}

async function main() {
    console.log("=== hyprland_window list ===");
    const winTool = createHyprlandWindowTool();
    const winList = await winTool.execute("test-1", { action: "list" });
    console.log(preview(winList));

    console.log("\n=== hyprland_workspace list ===");
    const wsTool = createHyprlandWorkspaceTool();
    const wsList = await wsTool.execute("test-2", { action: "list" });
    console.log(preview(wsList));

    console.log("\n=== hyprland_workspace list_monitors ===");
    const monList = await wsTool.execute("test-3", { action: "list_monitors" });
    console.log(preview(monList));

    console.log("\n=== hyprland_capture mode=active ===");
    const capTool = createHyprlandCaptureTool();
    const capRes = await capTool.execute("test-4", { mode: "active", note: "smoke test" });
    const capR = capRes as { content?: Array<{ type: string; mimeType?: string; data?: string }>; details?: Record<string, unknown> };
    const imgEntry = capR.content?.find((c) => c.type === "image");
    console.log(`  image present: ${!!imgEntry}`);
    console.log(`  mimeType: ${imgEntry?.mimeType}`);
    console.log(`  base64 length: ${imgEntry?.data?.length ?? 0}`);
    console.log(`  details: ${JSON.stringify(capR.details)}`);

    console.log("\n=== hyprland_window info (active) ===");
    const winInfo = await winTool.execute("test-5", { action: "info", activeWindow: true });
    console.log(preview(winInfo));

    await disposeSharedWorld();
    console.log("\nOK");
}

main().catch((err) => {
    console.error("FAIL:", err);
    process.exit(1);
});
