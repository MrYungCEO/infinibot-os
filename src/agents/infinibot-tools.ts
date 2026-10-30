import type { InfinibotConfig } from "../config/config.js";
import { createInfinibotHelpTool, createInfinibotStateTool } from "../infinibot-knowledge/tool.js";
import { resolvePluginTools } from "../plugins/tools.js";
import type { GatewayMessageChannel } from "../utils/message-channel.js";
import { resolveSessionAgentId } from "./agent-scope.js";
import { createAgentsListTool } from "./tools/agents-list-tool.js";
import { createBrowserTool } from "./tools/browser-tool.js";
import {
  createClaudeCoderTool,
  createOpenCodeCoderTool,
  createCodexCoderTool,
  createGrokCoderTool,
} from "./tools/claude-coder-tool.js";
import type { AnyAgentTool } from "./tools/common.js";
import { createCronTool } from "./tools/cron-tool.js";
import { createGatewayTool } from "./tools/gateway-tool.js";
import { createReportTool } from "./tools/report-tool.js";
import { createFileContextTool } from "./tools/file-context-tool.js";
import { createVideoAnalysisTool } from "./tools/video-analysis-tool.js";
import { createShowPanelTool } from "./tools/show-panel-tool.js";
import { createImageTool } from "./tools/image-tool.js";
import { createMessageTool } from "./tools/message-tool.js";
import {
  createTelegramSendTool,
  createTelegramSetDefaultTool,
} from "./tools/telegram-send-tool.js";
import { createGmailTool } from "./tools/gmail-tool.js";
import { createNodesTool } from "./tools/nodes-tool.js";
import { createSessionStatusTool } from "./tools/session-status-tool.js";
import { createSessionsHistoryTool } from "./tools/sessions-history-tool.js";
import { createSessionsListTool } from "./tools/sessions-list-tool.js";
import { createSessionsSendTool } from "./tools/sessions-send-tool.js";
import { createSessionsSpawnTool } from "./tools/sessions-spawn-tool.js";
import { createWebReachTools } from "./tools/web-reach.js";
import { createWebFetchTool, createWebSearchTool } from "./tools/web-tools.js";
import { createTtsTool } from "./tools/tts-tool.js";
import { createKanbanTool } from "./tools/kanban-tool.js";
import { createDatabasesTool } from "./tools/databases-tool.js";
import { createVideoEditorTool } from "./tools/video-editor-tool.js";
import { createFocusTool } from "./tools/focus-tool.js";
import { createDisciplineTool } from "./tools/discipline-tool.js";
import { createWorkflowsTool } from "./tools/workflows-tool.js";
import { createNotesTool } from "./tools/notes-tool.js";
import { createIdeasTool } from "./tools/ideas-tool.js";
import { createProjectReposTool } from "./tools/project-repos-tool.js";
import { createIssuesTool } from "./tools/issues-tool.js";
import { createResearchTool } from "./tools/research-tool.js";
import { createBudgetTool } from "./tools/budget-tool.js";
import { createVisionTool } from "./tools/vision-tool.js";
import { createSubagentProgressTool } from "./tools/subagent-progress-tool.js";
import { createCheckpointReportTool } from "./tools/checkpoint-report-tool.js";
import { createRequestApprovalTool, createWaitApprovalTool } from "./tools/approval-tools.js";
import {
  createSubagentInboxTool,
  createSubagentMessageTool,
} from "./tools/subagent-message-tool.js";
import { createSubagentsListTool } from "./tools/subagents-list-tool.js";
import { createVaultTool } from "./tools/vault-tool.js";
import { createMeshTool } from "./tools/mesh-tool.js";
import { createSSHDevicesTool } from "./tools/ssh-devices-tool.js";
import { createTailscaleControlTool } from "./tools/tailscale-control-tool.js";
import { createMCPTool } from "./tools/mcp-tool.js";
import { createLoopsTool } from "./tools/loops-tool.js";
import { createGoalRunTool } from "./tools/goal-run-tool.js";
import { createQueueRunTool } from "./tools/queue-run-tool.js";
import {
  createSubagentsEventsTool,
  createSubagentsWaitTool,
  createVisualVerifyTool,
} from "./tools/verification-tools.js";
import { createScheduledTaskTool } from "./tools/scheduled-task-tool.js";
import { createCharactersTool } from "./tools/characters-tool.js";
import { createDesktopAppTool } from "./tools/desktop-app-tool.js";
import { createDesktopUiTool } from "./tools/desktop-ui-tool.js";
import { createScreenAnalyzeTool } from "./tools/screen-analyze-tool.js";
import { createHyprlandWindowTool } from "./tools/hyprland-window-tool.js";
import { createHyprlandWorkspaceTool } from "./tools/hyprland-workspace-tool.js";
import { createHyprlandLaunchTool } from "./tools/hyprland-launch-tool.js";
import { createHyprlandCaptureTool } from "./tools/hyprland-capture-tool.js";
import { createHyprlandInputTool } from "./tools/hyprland-input-tool.js";
import { createHyprlandPickTool } from "./tools/hyprland-pick-tool.js";
import { createHyprlandHighlightTool } from "./tools/hyprland-highlight-tool.js";
import { createOverlayNotifyTool } from "./tools/overlay-notify-tool.js";
import { createInfinibotTerminalTool } from "./tools/infinibot-terminal-tool.js";
import { createUIControlTool } from "./tools/ui-control-tool.js";
import { createLeadTool } from "./tools/lead-tool.js";
import { createLeadScrapeTool } from "./tools/lead-scrape-tool.js";
import { createGithubProjectSyncTool } from "./tools/github-project-sync-tool.js";
import { createWorkloadTool } from "./tools/workload-tool.js";
import { createDailyReviewTool } from "./tools/daily-review-tool.js";
import { createProactiveTool } from "./tools/proactive-tool.js";
import { createClientContactsTool } from "./tools/client-contacts-tool.js";
import { createBusinessObjectsTool } from "./tools/business-objects-tool.js";
import { createBusinessHubTool } from "./tools/business-hub-tool.js";
import { createPeopleNetworkTool } from "./tools/people-network-tool.js";
import { createObjectRelationsTool } from "./tools/object-relations-tool.js";
import { createAutonomousTaskTool } from "./tools/autonomous-task-tool.js";
import { createAndroidOpsTool } from "./tools/android-ops-tool.js";
import { createLaunchPanelTool } from "./tools/launch-panel-tool.js";
import { isSaasMode } from "../saas/config.js";

export function createInfiniBotTools(options?: {
  sandboxBrowserBridgeUrl?: string;
  allowHostBrowserControl?: boolean;
  agentSessionKey?: string;
  agentChannel?: GatewayMessageChannel;
  agentAccountId?: string;
  /** Delivery target (e.g. telegram:group:123:topic:456) for topic/thread routing. */
  agentTo?: string;
  /** Thread/topic identifier for routing replies to the originating thread. */
  agentThreadId?: string | number;
  /** Group id for channel-level tool policy inheritance. */
  agentGroupId?: string | null;
  /** Group channel label for channel-level tool policy inheritance. */
  agentGroupChannel?: string | null;
  /** Group space label for channel-level tool policy inheritance. */
  agentGroupSpace?: string | null;
  agentDir?: string;
  sandboxRoot?: string;
  workspaceDir?: string;
  sandboxed?: boolean;
  config?: InfinibotConfig;
  pluginToolAllowlist?: string[];
  /** Current channel ID for auto-threading (Slack). */
  currentChannelId?: string;
  /** Current thread timestamp for auto-threading (Slack). */
  currentThreadTs?: string;
  /** Reply-to mode for Slack auto-threading. */
  replyToMode?: "off" | "first" | "all";
  /** Mutable ref to track if a reply was sent (for "first" mode). */
  hasRepliedRef?: { value: boolean };
  /** If true, the model has native vision capability */
  modelHasVision?: boolean;
  /** Explicit agent ID override for cron/hook sessions. */
  requesterAgentIdOverride?: string;
}): AnyAgentTool[] {
  const imageTool = options?.agentDir?.trim()
    ? createImageTool({
        config: options?.config,
        agentDir: options.agentDir,
        sandboxRoot: options?.sandboxRoot,
        modelHasVision: options?.modelHasVision,
      })
    : null;
  const webSearchTool = createWebSearchTool({
    config: options?.config,
    sandboxed: options?.sandboxed,
  });
  const webFetchTool = createWebFetchTool({
    config: options?.config,
    sandboxed: options?.sandboxed,
  });
  // The native `createBrowserTool` spins up its own Playwright Chromium with
  // a managed user-data-dir (defaults to the persistent "infini" profile so
  // logged-in cookies / extensions carry across runs). Enabled by default so
  // workflow runners and MCP clients have direct browser automation without
  // depending on an external Chrome extension being installed.
  //
  // Set INFINIBOT_NATIVE_BROWSER_TOOL=off to disable (e.g. when routing via
  // an external Browser MCP server configured in state/mcp-servers.json).
  const nativeBrowserEnabled =
    (process.env.INFINIBOT_NATIVE_BROWSER_TOOL ?? "on").toLowerCase() !== "off";

  // Filled below; infinibot_help reads it lazily (ui_control caps, tool catalogue).
  let allTools: AnyAgentTool[] = [];
  const tools: AnyAgentTool[] = [
    ...(nativeBrowserEnabled
      ? [
          createBrowserTool({
            sandboxBridgeUrl: options?.sandboxBrowserBridgeUrl,
            allowHostControl: options?.allowHostBrowserControl,
            agentSessionKey: options?.agentSessionKey,
            agentId: options?.requesterAgentIdOverride,
          }),
        ]
      : []),
    createNodesTool({
      agentSessionKey: options?.agentSessionKey,
      config: options?.config,
    }),
    createCronTool({
      agentSessionKey: options?.agentSessionKey,
    }),
    createMessageTool({
      agentAccountId: options?.agentAccountId,
      agentSessionKey: options?.agentSessionKey,
      config: options?.config,
      currentChannelId: options?.currentChannelId,
      currentChannelProvider: options?.agentChannel,
      currentThreadTs: options?.currentThreadTs,
      replyToMode: options?.replyToMode,
      hasRepliedRef: options?.hasRepliedRef,
    }),
    createTelegramSendTool({
      config: options?.config,
      agentId: resolveSessionAgentId({
        sessionKey: options?.agentSessionKey,
        config: options?.config,
      }),
    }),
    createTelegramSetDefaultTool(),
    createGmailTool(),
    createReportTool({
      agentSessionKey: options?.agentSessionKey,
    }),
    // file_context: local auto-OCR text / vision Q&A for uploaded files.
    createFileContextTool({ agentSessionKey: options?.agentSessionKey }),
    // video_analysis: specialist-agent analysis of uploaded videos (local VL).
    createVideoAnalysisTool({ agentSessionKey: options?.agentSessionKey }),
    // show_panel: answer with a live, interactive chat UI panel (mesh /
    // project / task / agent / business / CRM tables) — src/chat-panels.
    createShowPanelTool({
      agentSessionKey: options?.agentSessionKey,
      agentChannel: options?.agentChannel,
    }),
    createTtsTool({
      agentChannel: options?.agentChannel,
      config: options?.config,
    }),
    createGatewayTool({
      agentSessionKey: options?.agentSessionKey,
      config: options?.config,
    }),
    createAgentsListTool({
      agentSessionKey: options?.agentSessionKey,
      requesterAgentIdOverride: options?.requesterAgentIdOverride,
    }),
    createSessionsListTool({
      agentSessionKey: options?.agentSessionKey,
      sandboxed: options?.sandboxed,
    }),
    createSessionsHistoryTool({
      agentSessionKey: options?.agentSessionKey,
      sandboxed: options?.sandboxed,
    }),
    createSessionsSendTool({
      agentSessionKey: options?.agentSessionKey,
      agentChannel: options?.agentChannel,
      sandboxed: options?.sandboxed,
    }),
    createSessionsSpawnTool({
      agentSessionKey: options?.agentSessionKey,
      agentChannel: options?.agentChannel,
      agentAccountId: options?.agentAccountId,
      agentTo: options?.agentTo,
      agentThreadId: options?.agentThreadId,
      agentGroupId: options?.agentGroupId,
      agentGroupChannel: options?.agentGroupChannel,
      agentGroupSpace: options?.agentGroupSpace,
      sandboxed: options?.sandboxed,
      requesterAgentIdOverride: options?.requesterAgentIdOverride,
    }),
    createClaudeCoderTool({
      agentId: resolveSessionAgentId({
        sessionKey: options?.agentSessionKey,
        config: options?.config,
      }),
      agentSessionKey: options?.agentSessionKey,
      workspaceDir: options?.workspaceDir,
    }),
    createOpenCodeCoderTool({
      agentId: resolveSessionAgentId({
        sessionKey: options?.agentSessionKey,
        config: options?.config,
      }),
      agentSessionKey: options?.agentSessionKey,
      workspaceDir: options?.workspaceDir,
    }),
    createCodexCoderTool({
      agentId: resolveSessionAgentId({
        sessionKey: options?.agentSessionKey,
        config: options?.config,
      }),
      agentSessionKey: options?.agentSessionKey,
      workspaceDir: options?.workspaceDir,
    }),
    createGrokCoderTool({
      agentId: resolveSessionAgentId({
        sessionKey: options?.agentSessionKey,
        config: options?.config,
      }),
      agentSessionKey: options?.agentSessionKey,
      workspaceDir: options?.workspaceDir,
    }),
    createSessionStatusTool({
      agentSessionKey: options?.agentSessionKey,
      config: options?.config,
    }),
    ...(webSearchTool ? [webSearchTool] : []),
    ...(webFetchTool ? [webFetchTool] : []),
    // Keyless web reach (web_read, web_image_search, youtube_transcript,
    // github_read, rss_read): no key, no config, on for every agent.
    ...createWebReachTools({ config: options?.config }),
    ...(imageTool ? [imageTool] : []),
    createKanbanTool({
      agentId: resolveSessionAgentId({
        sessionKey: options?.agentSessionKey,
        config: options?.config,
      }),
    }),
    createDatabasesTool({
      agentId: resolveSessionAgentId({
        sessionKey: options?.agentSessionKey,
        config: options?.config,
      }),
    }),
    createVideoEditorTool({
      agentId: resolveSessionAgentId({
        sessionKey: options?.agentSessionKey,
        config: options?.config,
      }),
    }),
    createFocusTool(),
    createDisciplineTool(),
    createWorkflowsTool({
      agentId: resolveSessionAgentId({
        sessionKey: options?.agentSessionKey,
        config: options?.config,
      }),
    }),
    createLaunchPanelTool(),
    createNotesTool({
      agentId: resolveSessionAgentId({
        sessionKey: options?.agentSessionKey,
        config: options?.config,
      }),
    }),
    createIdeasTool({
      agentId: resolveSessionAgentId({
        sessionKey: options?.agentSessionKey,
        config: options?.config,
      }),
    }),
    createProjectReposTool(),
    createIssuesTool({
      agentId: resolveSessionAgentId({
        sessionKey: options?.agentSessionKey,
        config: options?.config,
      }),
    }),
    createProactiveTool({
      agentId: resolveSessionAgentId({
        sessionKey: options?.agentSessionKey,
        config: options?.config,
      }),
    }),
    createResearchTool({
      agentId: resolveSessionAgentId({
        sessionKey: options?.agentSessionKey,
        config: options?.config,
      }),
    }),
    createBudgetTool({
      agentId: resolveSessionAgentId({
        sessionKey: options?.agentSessionKey,
        config: options?.config,
      }),
    }),
    createLeadTool(),
    createLeadScrapeTool(),
    createClientContactsTool(),
    createBusinessHubTool(),
    createPeopleNetworkTool(),
    createBusinessObjectsTool({
      agentId: resolveSessionAgentId({
        sessionKey: options?.agentSessionKey,
        config: options?.config,
      }),
    }),
    createObjectRelationsTool({
      agentId: resolveSessionAgentId({
        sessionKey: options?.agentSessionKey,
        config: options?.config,
      }),
    }),
    createAutonomousTaskTool(),
    createVisionTool(),
    createSubagentsListTool({
      agentSessionKey: options?.agentSessionKey,
    }),
    createSubagentProgressTool({
      agentSessionKey: options?.agentSessionKey,
    }),
    createCheckpointReportTool({
      agentSessionKey: options?.agentSessionKey,
    }),
    // Operator approvals (Telegram + web inbox) before risky actions.
    createRequestApprovalTool({ agentSessionKey: options?.agentSessionKey }),
    createWaitApprovalTool(),
    createSubagentMessageTool({
      agentSessionKey: options?.agentSessionKey,
    }),
    createSubagentInboxTool({
      agentSessionKey: options?.agentSessionKey,
    }),
    createVaultTool({
      agentId: resolveSessionAgentId({
        sessionKey: options?.agentSessionKey,
        config: options?.config,
      }),
    }),
    createMeshTool({
      agentSessionKey: options?.agentSessionKey,
    }),
    createSSHDevicesTool(),
    createTailscaleControlTool(),
    // Android Ops drives USB/Wi-Fi handsets through a local adb: self-hosted
    // only (a hosted tenant Machine has no adb and no handsets).
    ...(isSaasMode() ? [] : [createAndroidOpsTool()]),
    createMCPTool({
      agentId: resolveSessionAgentId({
        sessionKey: options?.agentSessionKey,
        config: options?.config,
      }),
    }),
    createLoopsTool(),
    createGoalRunTool(),
    createQueueRunTool(),
    // Verified completion: await sub-agents + mandatory visual verification.
    createSubagentsWaitTool(),
    createSubagentsEventsTool({ agentSessionKey: options?.agentSessionKey }),
    createVisualVerifyTool({ agentSessionKey: options?.agentSessionKey }),
    createScheduledTaskTool(),
    createCharactersTool(),
    createDesktopAppTool(),
    createDesktopUiTool(),
    createScreenAnalyzeTool(),
    createHyprlandWindowTool(),
    createHyprlandWorkspaceTool(),
    createHyprlandLaunchTool(),
    createHyprlandCaptureTool(),
    createHyprlandInputTool(),
    createHyprlandPickTool(),
    createHyprlandHighlightTool(),
    createOverlayNotifyTool(),
    createInfinibotTerminalTool(),
    createUIControlTool({ agentSessionKey: options?.agentSessionKey }),
    // infinibot_help / infinibot_state: product knowledge (generated from the
    // code) + live state, so agents give real click-paths and navigate
    // instead of inventing them (src/infinibot-knowledge).
    createInfinibotHelpTool({ tools: () => allTools }),
    createInfinibotStateTool(),
    createGithubProjectSyncTool(),
    createWorkloadTool(),
    createDailyReviewTool(),
    // script / content_intel / viral_watch: contributed by the content-studio plugin.
  ];

  const pluginTools = resolvePluginTools({
    context: {
      config: options?.config,
      workspaceDir: options?.workspaceDir,
      agentDir: options?.agentDir,
      agentId: resolveSessionAgentId({
        sessionKey: options?.agentSessionKey,
        config: options?.config,
      }),
      sessionKey: options?.agentSessionKey,
      messageChannel: options?.agentChannel,
      agentAccountId: options?.agentAccountId,
      sandboxed: options?.sandboxed,
    },
    existingToolNames: new Set(tools.map((tool) => tool.name)),
    toolAllowlist: options?.pluginToolAllowlist,
  });

  allTools = [...tools, ...pluginTools];
  return allTools;
}
