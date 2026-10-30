/**
 * Compatibility shim. The subagent broadcast bridge is backend-agnostic and now
 * lives at src/agents/coder-runtime/subagent-broadcast.ts (shared by the Claude
 * Code, OpenCode, and Codex backends). This file re-exports it so existing
 * imports (`../claude-code/subagent-broadcast.js`) keep working.
 *
 * COORDINATION: opencode-parity
 */
export * from "../coder-runtime/subagent-broadcast.js";
