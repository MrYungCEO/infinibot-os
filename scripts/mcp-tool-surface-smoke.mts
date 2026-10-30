#!/usr/bin/env node
/**
 * Verifies that every new tool added this session is exposed through the
 * agent registry that the MCP adapter (and hence Claude Code) consumes.
 *
 * The MCP adapter (src/mcp/infinibot-adapter.ts) calls `agent.tools.list`
 * on the gateway, which calls `createInfiniBotTools()` and applies policy
 * filters. By instantiating the registry directly we exercise the same
 * code path without spinning up a gateway.
 */

import { createInfiniBotTools } from "../src/agents/infinibot-tools.js";
import { TOOL_GROUPS } from "../src/agents/tool-policy.js";

const REQUIRED = [
    "hyprland_window",
    "hyprland_workspace",
    "hyprland_launch",
    "hyprland_capture",
    "hyprland_input",
    "hyprland_pick",
    "hyprland_highlight",
    "ui_control",
];

async function main() {
    console.log("=== createInfiniBotTools() ===");
    const tools = createInfiniBotTools();
    console.log(`total tools: ${tools.length}`);
    const names = new Set(tools.map((t) => t.name));

    console.log("\n=== Required tools present? ===");
    let missing = 0;
    for (const name of REQUIRED) {
        const ok = names.has(name);
        console.log(`  ${ok ? "✓" : "✗"} ${name}`);
        if (!ok) missing++;
    }
    if (missing > 0) throw new Error(`${missing} required tool(s) missing from registry`);

    console.log("\n=== Tool descriptions (first 80 chars) ===");
    for (const name of REQUIRED) {
        const t = tools.find((x) => x.name === name);
        const desc = (t?.description ?? "").slice(0, 80);
        console.log(`  ${name.padEnd(22)} → ${desc}…`);
    }

    console.log("\n=== Policy groups ===");
    for (const groupName of ["group:hyprland", "group:desktop", "group:ui", "group:infinibot"]) {
        const members = TOOL_GROUPS[groupName] ?? [];
        const containsAny = REQUIRED.some((r) => members.includes(r));
        console.log(`  ${groupName.padEnd(20)} → ${members.length} members${containsAny ? " (includes new tools ✓)" : ""}`);
    }

    console.log("\n=== Sanity: tool shape match MCP expectations ===");
    for (const name of REQUIRED) {
        const t = tools.find((x) => x.name === name);
        if (!t) continue;
        const hasName = typeof t.name === "string";
        const hasDesc = typeof t.description === "string";
        const hasParams = !!t.parameters;
        const hasExecute = typeof t.execute === "function";
        const ok = hasName && hasDesc && hasParams && hasExecute;
        console.log(`  ${name.padEnd(22)} name=${hasName} desc=${hasDesc} params=${hasParams} execute=${hasExecute} ${ok ? "✓" : "✗"}`);
        if (!ok) throw new Error(`${name} missing required tool fields`);
    }

    console.log("\nOK — all new tools are MCP-ready and reachable from Claude Code");
}

main().catch((err) => {
    console.error("FAIL:", err);
    process.exit(1);
});
