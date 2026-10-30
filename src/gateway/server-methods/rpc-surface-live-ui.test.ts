/**
 * Regression guard for the "called by the UI but not served" class of bug
 * catalogued in src/gateway/RPC-SURFACE-AUDIT.md, Table 3.
 *
 * `src/gateway/server-methods.ts` dispatches with a plain
 * `extraHandlers[method] ?? coreGatewayHandlers[method]` lookup and replies
 * `unknown method` otherwise — there is no alias table and no catch-all. So a
 * method simply being absent from the map is, by itself, a live UI bug: the
 * button that calls it always errors.
 *
 * Every entry below is a method the control UI calls that previously had no
 * handler and now does. Handlers implemented in other repos' modules
 * (`projects.*`, `agents.management.update`, …) are asserted here too, since
 * registration — not just definition — is what makes them reachable.
 */
import { describe, expect, it } from "vitest";
import { coreGatewayHandlers } from "../server-methods.js";

const NEWLY_SERVED = [
  // Vault
  "vault.courses.delete",
  "vault.courses.archive",
  "vault.courses.enrolled",
  "vault.moderation.logs",
  "vault.moderation.clearWarnings",
  "vault.rules.test",
  "vault.analytics.export",
  "vault.setup.status",
  "vault.setup.complete",
  // Services lifecycle (ServiceManager-backed)
  "services.get",
  "services.start",
  "services.stop",
  "services.restart",
  "services.health",
  "services.unregister",
  "services.instances",
  "services.capabilities",
  // Federation control center
  "federation.mcp.test",
  "federation.node.wake",
  "compute.node.status",
  // Sub-agents
  "subagents.stop",
  // Projects
  "projects.auditLog",
  "projects.checkpoints",
  // Agents
  "agents.management.update",
  // (discipline.score.range moved to the Discipline plugin — covered by
  // extensions/discipline/src/rpc.score-range.test.ts)
  // Systems intelligence
  "systems.reviews.delete",
  // Notion
  "notion.sync.workflow",
  // Docker
  "docker.status",
] as const;

/**
 * Methods the UI was renamed ONTO. These already existed; asserting them keeps
 * a future rename of the gateway side from silently re-breaking the same
 * buttons.
 */
const RENAME_TARGETS = [
  "vault.members.warn",
  "vault.members.kick",
  "vault.members.ban",
  "vault.members.unban",
  "vault.discord.roles.assign",
  "vault.discord.roles.remove",
  "vault.discord.send",
  "vault.config.update",
  "vault.rules.update",
  "federation.nodes.list",
  "federation.ping",
  "federation.sync",
  "federation.node.gateway",
  "sessions.list",
  "sessions.send",
  "sessions.spawn",
  "sessions.transcript",
  "sessions.delete",
  "mcp.internal.upsert",
  "mcp.tools.invoke",
  "skills.status",
  "config.get",
  "config.patch",
  "files.read",
  "files.write",
  "workflows.run.start",
  "terminal.destroy",
  "exec.run",
  "kanban.tasks.list",
  "send",
] as const;

describe("live-UI RPC surface", () => {
  it.each(NEWLY_SERVED)("serves %s", (method) => {
    expect(typeof coreGatewayHandlers[method]).toBe("function");
  });

  it.each(RENAME_TARGETS)("still serves rename target %s", (method) => {
    expect(typeof coreGatewayHandlers[method]).toBe("function");
  });

  it("no longer serves nothing for any Table 3 method the UI still calls", () => {
    const missing = [...NEWLY_SERVED, ...RENAME_TARGETS].filter(
      (m) => typeof coreGatewayHandlers[m] !== "function",
    );
    expect(missing).toEqual([]);
  });
});
