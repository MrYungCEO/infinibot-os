#!/usr/bin/env node
/**
 * Cross-platform delegation smoke test — confirms the existing
 * screen_analyze / desktop_app tools (originally Windows-only) now route
 * through DesktopBackend and work on Linux/Hyprland transparently.
 */

import { createScreenAnalyzeTool } from "../src/agents/tools/screen-analyze-tool.js";
import { createDesktopAppTool } from "../src/agents/tools/desktop-app-tool.js";
import { createDesktopUiTool } from "../src/agents/tools/desktop-ui-tool.js";
import { disposeSharedWorld } from "../src/desktop/backends/hyprland/state.js";

function preview(result: unknown): string {
    const r = result as { content?: Array<{ type: string; text?: string }> };
    const text = r.content?.find((c) => c.type === "text")?.text ?? "";
    return text.length > 400 ? text.slice(0, 400) + "..." : text;
}

async function main() {
    console.log("=== screen_analyze list_displays (delegates to Hyprland) ===");
    const screen = createScreenAnalyzeTool();
    const list = await screen.execute("t-1", { action: "list_displays" });
    console.log(preview(list));

    console.log("\n=== screen_analyze capture display=1 ===");
    const cap = await screen.execute("t-2", { action: "capture", display: 1 });
    const r = cap as { content?: Array<{ type: string; mimeType?: string; data?: string }>; details?: Record<string, unknown> };
    const img = r.content?.find((c) => c.type === "image");
    console.log(`  image present: ${!!img}`);
    console.log(`  mimeType: ${img?.mimeType}`);
    console.log(`  details: ${JSON.stringify(r.details)}`);

    console.log("\n=== desktop_app list_displays (delegates to Hyprland) ===");
    const app = createDesktopAppTool();
    const dList = await app.execute("t-3", { action: "list_displays" });
    console.log(preview(dList));

    console.log("\n=== desktop_ui list_windows (should fail with NotSupportedError on Linux) ===");
    const ui = createDesktopUiTool();
    const uiList = await ui.execute("t-4", { action: "list_windows" });
    console.log(preview(uiList));

    await disposeSharedWorld();
    console.log("\nOK");
}

main().catch((err) => {
    console.error("FAIL:", err);
    process.exit(1);
});
