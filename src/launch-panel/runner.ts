import { randomUUID } from "node:crypto";
import { loadConfig } from "../config/config.js";
import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import { normalizeAgentId } from "../routing/session-key.js";
import type { GatewayRequestContext } from "../gateway/server-methods/types.js";
import { getGroupChatService } from "../gateway/server-methods/group-chat.js";
import { createSessionGroupChatStore } from "../gateway/group-chat/store.js";
import { getBrowserExtensionGovernance } from "../browser/extension-governance.js";
import { listAgentsForGateway } from "../gateway/session-utils.js";
import {
  DEFAULT_LAUNCH_FLOWS,
  assignPersonasToAgents,
  buildLaunchPanelWorkflow,
} from "./workflow.js";
import { writeLaunchPanelReport } from "./report.js";
import { LaunchPanelStore } from "./store.js";
import type { LaunchPanelRun, LaunchPanelRunInput } from "./types.js";
import { ensureLaunchPanelWorkflow } from "./register-workflow.js";
import {
  registerLaunchPanelBrowserSession,
  unregisterLaunchPanelBrowserSession,
} from "./runtime.js";

function validateUrl(raw: string): string {
  const url = new URL(raw);
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new Error("url must use http or https");
  return url.toString();
}

function selectAgentIds(): { moderator: string; personaAgents: string[] } {
  const cfg = loadConfig();
  const listed = listAgentsForGateway(cfg).agents;
  const ids = listed.map((a) => normalizeAgentId(a.id));
  const fallback = normalizeAgentId(resolveDefaultAgentId(cfg));
  if (!ids.length) ids.push(fallback);
  const moderator =
    ids.find((id) => /moderator|analyst|research/.test(id)) ||
    ids.find((id) => id === "main") ||
    ids[0]!;
  const configured = new Map(
    (cfg.agents?.list || []).map((agent) => [normalizeAgentId(agent.id), agent]),
  );
  const personaAgents = ids.filter((id) => {
    const agent = configured.get(id);
    const runtimeAgent = agent as
      | (typeof agent & { type?: string; cliCommand?: string })
      | undefined;
    if (runtimeAgent?.type === "cli" || runtimeAgent?.cliCommand) return false;
    const allow = agent?.tools?.allow;
    return !allow?.length || allow.includes("browser") || allow.includes("group:browser");
  });
  return { moderator, personaAgents: personaAgents.length ? personaAgents : [moderator] };
}

export function createLaunchPanelRun(
  input: LaunchPanelRunInput,
  context: GatewayRequestContext,
  store = new LaunchPanelStore(),
): LaunchPanelRun {
  ensureLaunchPanelWorkflow();
  const url = validateUrl(input.url);
  const allPersonas = store.listPersonas();
  const requested = input.personaIds?.length ? new Set(input.personaIds) : null;
  if (requested) {
    const known = new Set(allPersonas.map((persona) => persona.id));
    const unknown = [...requested].filter((id) => !known.has(id));
    if (unknown.length) throw new Error(`Unknown persona id(s): ${unknown.join(", ")}`);
  }
  const personas = allPersonas.filter((p) => p.enabled && (!requested || requested.has(p.id)));
  if (!personas.length) throw new Error("Select at least one enabled persona");
  const requestedFlows = input.flows?.length ? new Set(input.flows) : null;
  if (requestedFlows) {
    const known = new Set(DEFAULT_LAUNCH_FLOWS.map((flow) => flow.id));
    const unknown = [...requestedFlows].filter((id) => !known.has(id));
    if (unknown.length) throw new Error(`Unknown flow id(s): ${unknown.join(", ")}`);
  }
  const flows = DEFAULT_LAUNCH_FLOWS.filter((f) => !requestedFlows || requestedFlows.has(f.id));
  if (!flows.length) throw new Error("Select at least one flow");
  const depth = input.depth || "standard";
  const run: LaunchPanelRun = {
    id: `lp-${randomUUID().slice(0, 12)}`,
    url,
    personaIds: personas.map((p) => p.id),
    flows: flows.map((f) => f.id),
    depth,
    status: "queued",
    createdAt: Date.now(),
    telegram: { requested: input.telegram === true, target: input.telegramTarget },
  };
  store.saveRun(run);
  store.ensureTestAccounts(run.id, personas, input.testEmail);

  const { moderator, personaAgents } = selectAgentIds();
  const assignments = assignPersonasToAgents(personas, personaAgents);
  const members = [...new Set([moderator, ...assignments.map((a) => a.agentId)])];
  const service = getGroupChatService(context);
  const browserGovernance = getBrowserExtensionGovernance();
  const browserSessionKeys: string[] = [];

  void (async () => {
    try {
      run.status = "running";
      run.startedAt = Date.now();
      const group = await service.createGroup({
        ownerAgentId: "main",
        title: `Launch Room · ${new URL(url).hostname}`,
        members,
        mode: "moderator",
        moderatorId: moderator,
        binding: { purpose: `Customer-avatar launch test for ${url}` },
        ...(process.env.INFINIBOT_LAUNCH_PANEL_MODEL?.trim()
          ? {
              settings: {
                model: process.env.INFINIBOT_LAUNCH_PANEL_MODEL.trim(),
                thinkingLevel: "low",
              },
            }
          : {}),
      });
      run.groupKey = group.key;
      const groupId = group.key.match(/groupchat-(.+)$/)?.[1];
      if (groupId) {
        for (const member of members) {
          const sessionKey = `agent:${member}:gcmember-${groupId}`;
          browserGovernance.allowSiteForRun(url, sessionKey);
          registerLaunchPanelBrowserSession(sessionKey);
          browserSessionKeys.push(sessionKey);
        }
      }
      const workflow = buildLaunchPanelWorkflow({
        assignments,
        moderatorAgentId: moderator,
        url,
        flows,
        credentialsPath: store.credentialsPath(),
        runId: run.id,
        depth,
      });
      await service.saveWorkflow(group.key, workflow);
      run.workflowId = workflow.id;
      store.saveRun(run);
      context.broadcast("launch-panel", { type: "run.updated", run });

      const started = await service.startWorkflow(
        group.key,
        workflow.id,
        `Test ${url} as the selected real customer avatars. Ground every claim in a browser action and screenshot.`,
      );
      run.workflowRunId = started.run.id;
      run.workflowStatus = started.run.status;
      store.saveRun(run);
      context.broadcast("launch-panel", { type: "run.updated", run });

      const finished = await started.done;
      run.workflowStatus = finished.status;
      if (finished.status !== "done")
        throw new Error(finished.error || `room workflow ${finished.status}`);
      if (store.getRun(run.id)?.status === "cancelled") return;
      run.status = "reporting";
      store.saveRun(run);
      context.broadcast("launch-panel", { type: "run.updated", run });
      const messages = createSessionGroupChatStore().readMessages(group.key);
      const report = await writeLaunchPanelReport({
        run,
        personas,
        messages,
        telegramTarget: input.telegram === true ? input.telegramTarget || "" : undefined,
      });
      run.reportMarkdownPath = report.markdownPath;
      run.reportPdfPath = report.pdfPath;
      run.screenshotPaths = report.screenshotPaths;
      if (report.telegram)
        run.telegram = {
          ...run.telegram!,
          sent: report.telegram.sent,
          error: report.telegram.error,
        };
      if (store.getRun(run.id)?.status === "cancelled") return;
      run.status = "completed";
      run.completedAt = Date.now();
      store.saveRun(run);
      context.broadcast("launch-panel", { type: "run.updated", run });
    } catch (err) {
      run.status = "failed";
      run.error = err instanceof Error ? err.message : String(err);
      run.completedAt = Date.now();
      store.saveRun(run);
      context.broadcast("launch-panel", { type: "run.updated", run });
      context.logGateway.warn(`launch panel ${run.id} failed: ${run.error}`);
    } finally {
      for (const sessionKey of browserSessionKeys) {
        browserGovernance.revokeRunAllowances(sessionKey);
        unregisterLaunchPanelBrowserSession(sessionKey);
      }
    }
  })();
  return run;
}
