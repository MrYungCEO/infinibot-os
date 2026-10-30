import { accessHandlers } from "./server-methods/access.js";
import { ErrorCodes, errorShape } from "./protocol/index.js";
import { runWithTenantScope } from "../config/paths.js";
import { agentHandlers } from "./server-methods/agent.js";
import { agentsHandlers } from "./server-methods/agents.js";
import { agentsKnowledgeHandlers } from "./server-methods/agents-knowledge.js";
import { saasHandlers } from "./server-methods/saas.js";
import { noteFleetRpc } from "../saas/fleet-idle.js";
import { browserHandlers } from "./server-methods/browser.js";
import { loopsHandlers } from "./server-methods/loops.js";
import { channelsHandlers } from "./server-methods/channels.js";
import { chatHandlers } from "./server-methods/chat.js";
import { configHandlers } from "./server-methods/config.js";
import { connectHandlers } from "./server-methods/connect.js";
import { cronHandlers } from "./server-methods/cron.js";
import { deviceHandlers } from "./server-methods/devices.js";
import { execApprovalsHandlers } from "./server-methods/exec-approvals.js";
import { healthHandlers } from "./server-methods/health.js";
import { logsHandlers } from "./server-methods/logs.js";
import { modelsHandlers } from "./server-methods/models.js";
import { nodeHandlers } from "./server-methods/nodes.js";
import { notionSchemaHandlers } from "./server-methods/notion-schema.js";
import { notionConflictsHandlers } from "./server-methods/notion-conflicts.js";
import { notionImportHandlers } from "./server-methods/notion-import.js";
import { projectsHandlers } from "./server-methods/projects.js";
import { relationsHandlers } from "./server-methods/relations.js";
// KIS Sprint 1 foundation — typed-edge business-object relations + audit log.
import { objectRelationHandlers } from "./server-methods/object-relations.js";
import { objectConnectionHandlers } from "./server-methods/object-connections.js";
// Android Social Ops — 4-phone V1 command center.
import {
  androidOpsHandlers,
  ANDROID_OPS_READ_METHODS,
  ANDROID_OPS_WRITE_METHODS,
} from "./server-methods/android-ops.js";
import { auditHandlers } from "./server-methods/audit.js";
// KIS Phase 1 — 10 Core Business Objects
import { chatPanelHandlers } from "./server-methods/chat-panel.js";
import { sendHandlers } from "./server-methods/send.js";
import { sessionsHandlers } from "./server-methods/sessions.js";
import { skillsHandlers } from "./server-methods/skills.js";
import { systemHandlers } from "./server-methods/system.js";
import { talkHandlers } from "./server-methods/talk.js";
import { ttsHandlers } from "./server-methods/tts.js";
import type { GatewayRequestHandlers, GatewayRequestOptions } from "./server-methods/types.js";
import { updateHandlers } from "./server-methods/update.js";
import { usageHandlers } from "./server-methods/usage.js";
import { worldHandlers } from "./server-methods/world.js";
import { voicewakeHandlers } from "./server-methods/voicewake.js";
import { webHandlers } from "./server-methods/web.js";
import { wizardHandlers } from "./server-methods/wizard.js";
import { fsHandlers } from "./server-methods/fs.js";
import { deviceControlHandlers } from "./server-methods/device-control.js";
import { kanbanHandlers } from "./server-methods/kanban.js";
import { videoSwiftHandlers } from "./server-methods/video-swift.js";
import { databasesHandlers } from "./server-methods/databases.js";
import { databasePacksHandlers } from "./server-methods/database-packs.js";
import { mcpLifecycleHandlers } from "./server-methods/mcp-lifecycle.js";
import { mcpClientHandlers } from "./server-methods/mcp-client.js";
import { autopilotHandlers } from "./server-methods/autopilot.js";
import { autopilotApprovalHandlers } from "./server-methods/autopilot-approval.js";
import {
  approvalsHandlers,
  APPROVALS_READ_METHODS,
  APPROVALS_RESOLVE_METHODS,
  APPROVALS_WRITE_METHODS,
} from "./server-methods/approvals.js";
import { notionSyncHandlers } from "./server-methods/notion-sync.js";
import { workflowHandlers } from "./server-methods/workflows.js";
import { noteHandlers } from "./server-methods/notes.js";
import { ideasHandlers, IDEAS_READ_METHODS, IDEAS_WRITE_METHODS } from "./server-methods/ideas.js";
import {
  projectReposHandlers,
  PROJECT_REPOS_READ_METHODS,
  PROJECT_REPOS_WRITE_METHODS,
} from "./server-methods/project-repos.js";
import {
  onboardingProfileHandlers,
  ONBOARDING_PROFILE_READ_METHODS,
  ONBOARDING_PROFILE_WRITE_METHODS,
} from "./server-methods/onboarding-profile.js";
import {
  localRuntimesHandlers,
  LOCAL_RUNTIMES_READ_METHODS,
  LOCAL_RUNTIMES_WRITE_METHODS,
} from "./server-methods/local-runtimes.js";
import {
  secureModeHandlers,
  secureResearchHandlers,
  SECURE_MODE_READ_METHODS,
  SECURE_MODE_WRITE_METHODS,
} from "./server-methods/secure-mode.js";
import { documentsHandlers } from "./server-methods/documents.js";
import { prioritiesHandlers } from "./server-methods/priorities.js";
import { issueHandlers } from "./server-methods/issues.js";
import { coverHandlers } from "./server-methods/covers.js";
import { opsAgentHandlers } from "./server-methods/opsagent.js";
import { researchHandlers } from "./server-methods/research.js";
import { gitHandlers } from "./server-methods/git.js";
import { checkpointHandlers } from "./server-methods/checkpoint.js";
import { taskWorktreeHandlers } from "./server-methods/task-worktree.js";
import { notionDatabaseHandlers } from "./server-methods/notion-databases.js";
import { terminalHandlers } from "./server-methods/terminal.js";
import { terminalPeekHandlers } from "./server-methods/terminal-peek.js";
import { filesHandlers } from "./server-methods/files.js";
import {
  filesOcrHandlers,
  FILES_OCR_READ_METHODS,
  FILES_OCR_WRITE_METHODS,
} from "./server-methods/files-ocr.js";
import {
  filesVideoHandlers,
  FILES_VIDEO_READ_METHODS,
  FILES_VIDEO_WRITE_METHODS,
} from "./server-methods/files-video.js";
import { filesDiffHandlers } from "./server-methods/files-diff.js";
import { notionProxyHandlers } from "./server-methods/notion-proxy.js";
import { notionWizardHandlers } from "./server-methods/notion-wizard.js";
import { quickstartHandlers } from "./server-methods/quickstart.js";
import { quickstartProvidersHandlers } from "./server-methods/quickstart-providers.js";
import { voiceSetupHandlers } from "./server-methods/voice-setup.js";
import { voiceDockerHandlers } from "./server-methods/voice-docker.js";
import { voiceLocalSetupHandlers } from "./server-methods/voice-local-setup.js";
import { voicePackHandlers } from "./server-methods/voice-pack.js";
import { budgetHandlers } from "./server-methods/budget.js";
import { creditsHandlers } from "./server-methods/credits.js";
import { autonomyHandlers } from "./server-methods/autonomy.js";
import { scheduleAlertsHandlers } from "./server-methods/schedule-alerts.js";
import { calendlyHandlers } from "./server-methods/calendly.js";
import { calendarSyncHandlers } from "./server-methods/calendar-sync.js";
import { discoveryHandlers } from "./server-methods/discovery.js";
import { designHandlers } from "./server-methods/design.js";
import { pushNotificationHandlers } from "./server-methods/push-notifications.js";
import { directoryHandlers } from "./server-methods/directories.js";
import { formsHandlers } from "./server-methods/forms.js";
import { compositionsHandlers } from "./server-methods/compositions.js";
import { moltbookHandlers } from "./server-methods/moltbook.js";
import { replicateHandlers } from "./server-methods/replicate.js";
import { emailHandlers } from "./server-methods/email.js";
import { emailAccountsHandlers } from "./server-methods/email-accounts.js";
import { authHandlers } from "./server-methods/auth.js";
import { supabaseHandlers } from "./server-methods/supabase.js";
import { navSidebarHandlers } from "./server-methods/nav-sidebar.js";
import { visionHandlers } from "./server-methods/vision.js";
import { tunnelHandlers } from "./server-methods/tunnel.js";
import { subagentsHandlers } from "./server-methods/subagents.handlers.js";
import { subagentsHistoryHandlers } from "./server-methods/subagents-history.handlers.js";
import { subagentReviewsHandlers } from "./server-methods/subagent-reviews.handlers.js";
import { agentsReviewsHandlers } from "./server-methods/agents-reviews.handlers.js";
import { oversightSamplerHandlers } from "./server-methods/oversight-sampler.handlers.js";
import { mediaHandlers } from "./server-methods/media.js";
import { federationHandlers } from "./server-methods/federation.js";
import { federationControlHandlers } from "./server-methods/federation-control.js";
import { federationFilesHandlers } from "./server-methods/federation-files.js";
import { autoUpdateHandlers } from "./server-methods/auto-update.js";
import { prodUpdateHandlers } from "./server-methods/prod-update.js";
import { vaultHandlers } from "./server-methods/vault.js";
import { agentMeshHandlers } from "./server-methods/agent-mesh.js";
import { meshGamificationHandlers } from "./server-methods/mesh-gamification.js";
import { servicesHandlers } from "./server-methods/services.js";
import { servicesLifecycleHandlers } from "./server-methods/services-lifecycle.js";
import { proactiveHandlers } from "./server-methods/proactive.js";
import { overlayHandlers } from "../overlay/rpc.js";
import { queueHandlers, QUEUE_READ_METHODS, QUEUE_WRITE_METHODS } from "./server-methods/queue.js";
import { goalsHandlers, GOALS_READ_METHODS, GOALS_WRITE_METHODS } from "./server-methods/goals.js";
import {
  groupChatHandlers,
  GROUPCHAT_READ_METHODS,
  GROUPCHAT_WRITE_METHODS,
} from "./server-methods/group-chat.js";
import {
  launchPanelHandlers,
  LAUNCH_PANEL_READ_METHODS,
  LAUNCH_PANEL_WRITE_METHODS,
} from "./server-methods/launch-panel.js";
// hq.* handlers are served by the business-agency plugin; core keeps the scopes.
import { HQ_READ_METHODS, HQ_WRITE_METHODS } from "./server-methods/hq-progress.js";
import {
  voiceProvidersHandlers,
  VOICE_PROVIDERS_READ_METHODS,
  VOICE_PROVIDERS_WRITE_METHODS,
} from "./server-methods/voice-providers.js";
import {
  voiceCliRouteHandlers,
  VOICE_CLI_ROUTE_READ_METHODS,
  VOICE_CLI_ROUTE_WRITE_METHODS,
} from "./server-methods/voice-cli-route.js";
import {
  verificationHandlers,
  VERIFICATION_READ_METHODS,
  VERIFICATION_WRITE_METHODS,
} from "./server-methods/verification.js";
import {
  ownerDecisionsHandlers,
  OWNER_DECISIONS_READ_METHODS,
} from "./server-methods/owner-decisions.js";
import {
  scheduledTasksHandlers,
  SCHEDULED_TASKS_READ_METHODS,
  SCHEDULED_TASKS_WRITE_METHODS,
} from "./server-methods/scheduled-tasks.js";
import { gmailHandlers } from "./server-methods/gmail.js";
import { systemsIntelligenceHandlers } from "./server-methods/systems-intelligence.js";
import { ollamaMonitorHandlers } from "./server-methods/ollama-monitor.js";
import { sshDeviceHandlers } from "./server-methods/ssh-devices.js";
import { pluginGatewayHandlers } from "./server-methods/plugins.js";
import { pluginPackageHandlers } from "./server-methods/plugins-packages.js";
import { pluginCatalogHandlers } from "./server-methods/plugins-catalog.js";
import { networkTailscaleHandlers } from "./server-methods/network-tailscale.js";
import { tailscaleRemoteHandlers } from "./server-methods/tailscale-remote.js";
import { graphGlobalHandlers } from "./server-methods/graph-global.js";
import { sessionHistoryHandlers } from "./server-methods/session-history.js";
import { landingPagesHandlers } from "./server-methods/landing-pages.js";
import { projectCollaborationHandlers } from "./server-methods/project-collaboration.js";
import { integrationHandlers } from "./server-methods/integrations.js";
import { kpiHandlers } from "./server-methods/kpi.js";
import { communityHandlers } from "./server-methods/community.js";
import { storyboardHandlers } from "./server-methods/storyboard.js";
import { characterHandlers } from "./server-methods/characters.js";
import { resolvePluginMethodAlias } from "./plugin-method-aliases.js";
import { agentToolsHandlers } from "./server-methods/agent-tools.js";
import { brandingHandlers } from "./server-methods/branding.js";
import { compositionBlocksHandlers } from "./server-methods/composition-blocks.js";
import { usersHandlers } from "./server-methods/users.js";
import { profilesHandlers } from "./server-methods/profiles.js";
import { mobileHandlers } from "./server-methods/mobile.js";
import { learnHandlers } from "./server-methods/learn.js";
import { learnGuidedHandlers } from "./server-methods/learn-guided.js";
import { visionClawHandlers } from "./server-methods/visionclaw.js";
import { appsHandlers } from "./server-methods/apps.js";
import { agentIdentityHandlers } from "./server-methods/agent-identity.js";
import { noteUiRequestSession, uiControlHandlers } from "./server-methods/ui-control.js";
import { browserSetupHandlers } from "./server-methods/browser-setup.js";
import { browserProfilesHandlers } from "./server-methods/browser-profiles.js";
import { browserViewerHandlers } from "./server-methods/browser-viewer.js";
import { browserExtensionHandlers } from "./server-methods/browser-extension.js";
import { setupConnectHandlers } from "./server-methods/setup-connect.js";
import { docAgentHandlers } from "./server-methods/doc-agent.js";
import { promptTemplateHandlers } from "./server-methods/prompt-templates.js";
import { fileTransferHandlers } from "./server-methods/file-transfer.js";
import { coderHandlers } from "./server-methods/coder.js";
import { chatCliHandlers } from "./server-methods/chat-cli.js";
import { codersHandlers, CODERS_READ_METHODS } from "./server-methods/coders.js";
import { cliRoutingHandlers, CLI_ROUTING_READ_METHODS } from "./server-methods/cli-routing.js";
import { setupStatusHandlers, SETUP_STATUS_READ_METHODS } from "./server-methods/setup-status.js";
import {
  telegramSetupHandlers,
  TELEGRAM_SETUP_READ_METHODS,
} from "./server-methods/telegram-setup.js";
import { isSetupRelevantWrite, scheduleSetupStatusRefresh } from "./setup-status/registry.js";
import { providersCatalogHandlers } from "./server-methods/providers-catalog.js";
import { agentIntegrationHandlers } from "./server-methods/agent-integrations.js";
import { workloadHandlers } from "./server-methods/workload.js";
import {
  dailyReviewHandlers,
  DAILY_REVIEW_READ_METHODS,
  DAILY_REVIEW_WRITE_METHODS,
} from "./server-methods/daily-review.js";
import { notificationHandlers } from "./server-methods/notifications.js";
import { projectSummaryHandlers } from "./server-methods/project-summary.js";
import { reportsHandlers } from "./server-methods/reports.js";
import { INVOICE_REPORT_KIND, PROPOSAL_REPORT_KIND } from "../reports/documents/types.js";
import { licenseHandlers } from "./server-methods/license.js";
import { canvasWorkflowHandlers } from "./server-methods/canvas-workflows.js";
import { warRoomHandlers } from "./server-methods/war-room.js";
import { workflowEngineHandlers } from "./server-methods/workflows.handlers.js";
import { commsHandlers } from "./server-methods/comms.js";
import { autonomousTaskHandlers } from "./server-methods/autonomous-tasks.js";
import { pairingHandlers } from "./server-methods/pairing.js";
import { workspaceDevHandlers } from "./server-methods/workspace-dev.js";
import { resolvePluginMethodScope } from "../plugins/runtime.js";
import { pluginMethodBlockedReason } from "../plugins/host-state.js";

const ADMIN_SCOPE = "operator.admin";
const READ_SCOPE = "operator.read";
const WRITE_SCOPE = "operator.write";
const APPROVALS_SCOPE = "operator.approvals";
const PAIRING_SCOPE = "operator.pairing";

const APPROVAL_METHODS = new Set<string>([
  "exec.approval.request",
  "exec.approval.resolve",
  ...APPROVALS_RESOLVE_METHODS,
]);
const NODE_ROLE_METHODS = new Set(["node.invoke.result", "node.event", "skills.bins"]);
const PAIRING_METHODS = new Set([
  "node.pair.request",
  "node.pair.list",
  "node.pair.approve",
  "node.pair.reject",
  "node.pair.verify",
  "device.pair.list",
  "device.pair.approve",
  "device.pair.reject",
  "device.token.rotate",
  "device.token.revoke",
  "node.rename",
  "pairing.createInvite",
  "pairing.listInvites",
]);
const ADMIN_METHOD_PREFIXES = ["exec.approvals."];
const READ_METHODS = new Set([
  "browser.viewer.status",
  // Plugins page / onboarding catalog (no secrets; account email only).
  "plugins.catalog",
  "plugins.entitlements.status",
  "plugins.purchase.urls",
  // "Connect KinglyVault": availability, linked account, the code on screen.
  "plugins.kv.status",
  "plugins.kv.connect.status",
  "saas.me",
  // A presence ping from the app (real user input), not a state change.
  "fleet.activity",
  "saas.onboarding.status",
  "agency.ops.agencies.list",
  "agency.ops.dashboard",
  "agency.ops.pipeline.list",
  "agency.ops.engagements.list",
  "agency.ops.approvals.list",
  "agency.ops.employees.list",
  "agency.ops.finance.summary",
  "agency.ops.invoices.parse",
  "agency.ops.invoices.list",
  "agency.ops.invoice.get",
  "agency.ops.invoice.number.next",
  "agency.ops.invoice.payments.list",
  "agency.ops.invoice.document.preview",
  "agency.ops.proposal.get",
  "agency.ops.proposal.list",
  "agency.ops.proposal.document.preview",
  "agency.ops.revenue.summary",
  "agency.ops.collaboration.status",
  "agency.ops.database.health",
  "agency.ops.database.schema.status",
  "agency.ops.database.backups.list",
  "agency.ops.database.backup.verify",
  "agency.ops.migration.preview",
  "agency.ops.clients.list",
  "agency.ops.projects.list",
  "agency.ops.tasks.list",
  "agency.ops.members.list",
  "agency.ops.audit.list",
  "agency.ops.employee.detail",
  "agency.ops.assignments.list",
  "agency.ops.assignment.suitability",
  "agency.ops.assignment.hybrid-plan",
  "agency.ops.employee.inbox.list",
  "agency.ops.employee.schedules.list",
  "agency.ops.employee.responsibilities.list",
  "agency.ops.employee.reviews.list",
  "agency.ops.employee.memory.list",
  "agency.ops.funnels.overview",
  "agency.ops.funnels.map.get",
  "agency.ops.funnels.context",
  "health",
  "logs.tail",
  "channels.status",
  "status",
  "usage.status",
  "usage.cost",
  "tts.status",
  "tts.providers",
  "models.list",
  "agents.list",
  "agents.management.list",
  "agents.knowledge.profile",
  "agent.identity.get",
  "users.list",
  "users.get",
  "users.me",
  "users.authenticate",
  "compositions.brief.get",
  "compositions.timeline.get",
  "compositions.timeline.validate",
  "compositions.audio.measure",
  "compositions.qc",
  "mobile.config.get",
  "mobile.expo.status",
  "mobile.eas.whoami",
  "mobile.eas.devices",
  "mobile.eas.builds",
  "learn.tracks.list",
  "learn.track.get",
  "learn.progress.get",
  "learn.certificate.status",
  "learn.certificate.svg",
  "learn.certificate.list",
  "learn.guided.catalog",
  "learn.guided.progress.get",
  "learn.guided.certificate",
  "apps.list",
  "apps.get",
  "funnels.page.config.get",
  "funnels.page.preview",
  "funnels.page.submissions",
  "skills.status",
  "voicewake.get",
  "voicePack.list",
  "voicePack.verify",
  "sessions.list",
  "sessions.preview",
  "cron.list",
  "cron.status",
  "cron.runs",
  "system-presence",
  "last-heartbeat",
  "node.list",
  "nodes.status",
  "node.describe",
  "chat.history",
  "projects.list",
  "projects.summaries",
  "projects.get",
  "projects.create",
  "projects.update",
  "projects.updateProgress",
  "projects.control",
  "projects.checkpoint",
  "projects.heartbeat",
  "projects.recover",
  "projects.tool",
  "notion.schema.diff",
  "notion.schema.applyPatch",
  "notion.schema.applyRename",
  "notion.schema.aiSuggest",
  "notion.sync.pullNow",
  // Loops.so email marketing
  "loops.status",
  "loops.config.get",
  "loops.contacts.upsert",
  "loops.contacts.find",
  "loops.contacts.delete",
  "loops.lists.list",
  "loops.groups.list",
  "loops.groups.upsert",
  "loops.groups.delete",
  "loops.properties.list",
  "loops.events.send",
  "loops.transactional.send",
  "loops.sync.crm",
  "loops.sync.log",
  "loops.kpi.summary",
  // Federation resources
  "federation.config.get",
  "federation.status",
  "federation.capabilities.local",
  "federation.urls",
  "federation.nodes.list",
  "federation.resources.projects",
  "federation.resources.tasks",
  "federation.resources.agents",
  "federation.resources.mcp",
  "federation.resources.business",
  "federation.resources.directories",
  "federation.node.gateway",
  "federation.selection.get",
  // Federation files (cross-node file-explorer fan-out)
  "federation.files.list",
  "federation.files.tree",
  "federation.files.stat",
  "federation.files.read",
  "federation.files.search",
  "federation.files.roots.list",
  // Media services
  "media.status",
  "fs.listDir",
  "fs.browseFolder",
  "fs.systemDirs",
  "fs.exists",
  // fs.read / fs.write (any path) and exec.run / exec.bg* (raw shell) are
  // deliberately NOT here: they fall through to operator.admin below. As read
  // methods they handed a shell to any operator.read device token and
  // bypassed exec approvals.
  "kanban.notionSync.status",
  "kanban.projects.list",
  "kanban.projects.content.get",
  "kanban.projects.content.getBlocks",
  "kanban.files.getMarkdown",
  "kanban.tasks.content.getBlocks",
  "kanban.tasks.content.getMarkdown",
  "kanban.tasks.list",
  "git.status",
  "git.branches",
  "git.log",
  "git.diff",
  "git.blame",
  "git.worktree",
  "mcp.status",
  "mcp.servers.list",
  "mcp.tools.list",
  "mcp.tools.get",
  "mcp.clients.status",
  "notion.sync.status",
  "business.list",
  "business.get",
  "business.notion.databases",
  "business.notion.status",
  "business.notion.fetchPage",
  "business.income.stats",
  "business.income.daily",
  "business.income.config.get",
  "business.priorities.get",
  "clients.list",
  "clients.get",
  "clients.findByOrigin",
  "clients.revenue.list",
  "clients.activity.list",
  "clients.notion.status",
  "clients.notion.schema",
  "business.clients.list",
  "business.clients.get",
  "business.clients.notion.status",
  "business.clients.notion.schema",
  "notion.db.list",
  "notion.db.pages.list",
  "notion.db.pages.blocks",
  "notion.db.pages.subpages",
  "notion.db.pages.relations",
  "notion.db.discover",
  "budget.status",
  "budget.subscriptions",
  "budget.history",
  "budget.complexity",
  "notes.list",
  ...IDEAS_READ_METHODS,
  ...PROJECT_REPOS_READ_METHODS,
  ...ONBOARDING_PROFILE_READ_METHODS,
  ...SECURE_MODE_READ_METHODS,
  ...LOCAL_RUNTIMES_READ_METHODS,
  ...FILES_OCR_READ_METHODS,
  ...FILES_VIDEO_READ_METHODS,
  "notes.get",
  "documents.tree",
  "documents.get",
  "documents.search",
  "documents.recent",
  "documents.trash",
  "documents.history",
  "documents.revision",
  "documents.backlinks",
  "documents.ticket",
  "documents.notion.status",
  "documents.notion.search",
  "documents.notion.jobs.get",
  "documents.notion.jobs.list",
  "documents.import.collections",
  "documents.import.mapping.preview",
  "documents.types.list",
  "documents.library",
  "notes.ocr",
  "issues.list",
  "issues.get",
  "issues.search",
  "issues.attachments.list",
  // Notion-style object cover images (opportunity / project / client / …)
  "covers.get",
  "covers.list",
  // KIS Phase 1 operations agents (§19–§21) — read-only observe/recommend.
  "opsagent.ceoBriefing",
  "opsagent.monitor",
  "opsagent.projectHealth",
  "research.list",
  "research.get",
  "files.list",
  "files.read",
  "files.stat",
  "files.search",
  "files.tree",
  "files.download",
  "files.thumb",
  "files.watch",
  "files.recent",
  "files.disk",
  "notion.query",
  "notion.databases.query",
  "notion.get",
  "directories.list",
  "directories.get",
  "directories.resolve",
  "directories.context",
  "autonomy:status",
  "autonomy:state",
  "autonomy:canWork",
  "autonomy:pauseState",
  "autonomy:queue.list",
  "autonomy:audit.recent",
  "autonomy:audit.today",
  "autonomy:audit.verify",
  "autonomy:hardware.check",
  "autonomy:hardware.isIdle",
  "autonomy:notify.pending",
  "autonomy:api.today",
  // SSH Device read methods
  "ssh.device.list",
  "ssh.device.get",
  "ssh.device.getActive",
  "ssh.device.search",
  "autonomy:api.summary",
  "autonomy:api.recent",
  "autonomy:api.taskUsage",
  "notifications.history.list",
  "project-summary.get",
  "notifications.history.get",
  "notifications.history.unreadCount",
  "notifications.history.byCategorySummary",
  "notifications.history.related",
  "notifications.preferences.get",
  "push.listDevices",
  "replicate.models.list",
  "replicate.models.search",
  "leads.list",
  "leads.timeline",
  // Services read methods
  "services.list",
  "services.get",
  "services.health",
  "services.instances",
  "services.capabilities",
  "leads.get",
  "leads.sources",
  "leads.stats",
  "auth.profiles.list",
  "auth.profiles.get",
  "auth.health",
  "canva.oauth.getRedirectUri",
  "nav.sidebar.get",
  "vision.status",
  "vision.devices",
  "tunnel.status",
  "subagents.list",
  "subagents.status",
  "subagents.usage",
  "subagents.history",
  "subagents.checkpoints",
  "subagents.messages",
  // Vault read methods
  "vault.members.list",
  "vault.members.get",
  "vault.members.search",
  "vault.courses.list",
  "vault.courses.get",
  "vault.modules.list",
  "vault.modules.get",
  "vault.lessons.list",
  "vault.lessons.get",
  "vault.progress.get",
  "vault.discord.roles.list",
  "vault.discord.channels.list",
  "vault.rules.list",
  "vault.rules.get",
  "vault.analytics.get",
  "vault.config.get",
  // Mesh read methods
  "mesh.status",
  "mesh.discover",
  "mesh.findBest",
  "mesh.getAgent",
  "mesh.getChain",
  "mesh.getMessages",
  // Focus read methods (aliases of the Discipline plugin's discipline.focus.*)
  "focus.list",
  "focus.status",
  "focus.get",
  "focus.contains",
  // Gmail read methods
  "gmail.status",
  "gmail.labels",
  "gmail.list",
  "gmail.search",
  "gmail.get",
  "gmail.thread",
  // Connect flow: build the Google consent URL + mint the OAuth session
  "gmail.oauth.authUrl",
  // Systems Intelligence read methods
  "systems.values.list",
  "systems.values.get",
  "systems.goals.list",
  "systems.goals.get",
  "systems.priorities.list",
  "systems.priorities.get",
  "systems.nodes.list",
  "systems.nodes.get",
  "systems.relationships.list",
  "systems.relationships.get",
  "systems.reviews.list",
  "systems.reviews.get",
  "systems.graph.get",
  "systems.map.aggregate",
  "systems.orphans.list",
  "systems.autolink.preview",
  "systems.autolink.suggestions",
  // Ollama monitor read methods
  "ollama.status",
  "ollama.models.byNode",
  "ollama.models.list",
  "ollama.models.loaded",
  "ollama.gpu",
  "ollama.sessions",
  "ollama.ping",
  // Funnels read methods
  "funnels.business.get",
  "funnels.business.list",
  "funnels.get",
  "funnels.list",
  "funnels.analytics",
  "funnels.stage.kpis",
  "funnels.lead.get",
  "funnels.lead.search",
  "funnels.lead.qualify",
  "funnels.lead.matchOffer",
  "funnels.kpi.get",
  "funnels.kpi.compare",
  "funnels.task.getChecklist",
  "funnels.offer.list",
  "funnels.offer.checkEligibility",
  "funnels.canvas.getLayout",
  // Landing Pages read methods
  "community.pages.list",
  // KPI Analytics read methods
  "kpi.sites.get",
  "kpi.sites.list",
  "kpi.sites.getScript",
  "kpi.analytics.get",
  "kpi.analytics.overview",
  "kpi.analytics.realtime",
  "kpi.analytics.timeseries",
  "kpi.goals.get",
  "kpi.goals.list",
  "kpi.funnels.get",
  "kpi.funnels.list",
  "kpi.funnels.analytics",
  "community.pages.get",
  "community.pages.preview",
  "community.pages.edit.get",
  "community.pages.edit.list",
  "community.pages.versions.list",
  "community.pages.templates.list",
  "community.pages.templates.get",
  // Storyboard read methods
  "storyboard.list",
  "storyboard.get",
  "storyboard.backends",
  "storyboard.models",
  "storyboard.voices",
  "storyboard.stylePresets",
  // Content trends / scripts: scopes now declared by the content-studio plugin.
  // Character read methods
  "characters.list",
  "characters.get",
  "characters.search",
  // Email accounts read surface
  "email.providerInfo",
  "email.accounts.list",
  "email.accounts.get",
  "email.accounts.inbox.list",
  "email.accounts.discover",
  // Coder backend introspection
  "coder.backends.list",
  // Workload tracking read methods
  "workload.list",
  "workload.summary",
  ...DAILY_REVIEW_READ_METHODS,
  "ui.list_clients",
  "ui.list_tabs",
  "ui_control.capabilities",
  "ui_control.audit",
  "ui.overlay.list",
  // UI target registry + tab presence (ui_control navigate/highlight/guide)
  "ui.targets.list",
  "ui.targets.search",
  "ui.targets.get",
  "ui.client.activity",
  // KIS Sprint 1 foundation — read methods
  "objrel.list",
  "objrel.graph",
  "objrel.connections",
  "objrel.object",
  "reports.forObject",
  "reports.associations",
  "audit.list",
  "audit.get",
  // KIS Phase 1 — object read methods
  "opportunity.list",
  // Agent-invokable chat panels (show_panel tool) — read-only resolvers
  // that fan out in-process to an allowlist of the read RPCs above.
  "chat.panel.kinds",
  "chat.panel.resolve",
  "chat.panel.refresh",
  "chat.panel.show",
  "opportunity.get",
  "opportunity.search",
  "decision.list",
  "decision.get",
  "decision.search",
  "decision.ceoQueue",
  "risk.list",
  "risk.get",
  "risk.search",
  "risk.overdue",
  "risk.links",
  "commitment.list",
  "commitment.get",
  "commitment.search",
  "commitment.aggregates",
  "person.list",
  "person.get",
  "person.search",
  "person.workload",
  ...ANDROID_OPS_READ_METHODS,
  ...GOALS_READ_METHODS,
  ...GROUPCHAT_READ_METHODS,
  ...LAUNCH_PANEL_READ_METHODS,
  ...QUEUE_READ_METHODS,
  ...HQ_READ_METHODS,
  ...VOICE_PROVIDERS_READ_METHODS,
  ...VOICE_CLI_ROUTE_READ_METHODS,
  ...VERIFICATION_READ_METHODS,
  ...OWNER_DECISIONS_READ_METHODS,
  ...SCHEDULED_TASKS_READ_METHODS,
  ...APPROVALS_READ_METHODS,
  // Setup › Coders. install/update/uninstall/keys/sign-in stay admin-only.
  ...CODERS_READ_METHODS,
  ...CLI_ROUTING_READ_METHODS,
  ...SETUP_STATUS_READ_METHODS,
  ...TELEGRAM_SETUP_READ_METHODS,
]);
const WRITE_METHODS = new Set([
  "browser.viewer.open",
  "browser.viewer.close",
  "browser.viewer.ack",
  "browser.viewer.input",
  "browser.viewer.navigate",
  "browser.viewer.tab",
  "browser.viewer.layout",
  "browser.viewer.dialog",
  "browser.viewer.copy",
  "models.allowlist.add",
  "models.allowlist.remove",
  "agency.ops.agency.create",
  "agency.ops.agency.share",
  "agency.ops.agency.invite.accept",
  "agency.ops.collaboration.enable",
  "agency.ops.database.backup.create",
  "agency.ops.database.backup.ensure",
  "agency.ops.database.backups.prune",
  "agency.ops.database.restore.prepare",
  "agency.ops.database.restore.cancel",
  "agency.ops.database.restore.activate",
  "agency.ops.migration.run",
  "agency.ops.pipeline.deal.create",
  "agency.ops.engagement.create",
  "agency.ops.approval.resolve",
  "agency.ops.employee.create",
  "agency.ops.employee.capacity.update",
  "agency.ops.employee.update",
  "agency.ops.employee.deactivate",
  "agency.ops.clients.create",
  "clients.create",
  "clients.update",
  "clients.delete",
  "clients.revenue.log",
  "clients.activity.log",
  "clients.import",
  "clients.notion.connect",
  "clients.notion.disconnect",
  "clients.notion.sync",
  "clients.notion.import",
  "clients.notion.create",
  "agency.ops.projects.create",
  "agency.ops.projects.update",
  "agency.ops.tasks.create",
  "agency.ops.tasks.update",
  "agency.ops.member.role.update",
  "agency.ops.member.remove",
  "agency.ops.assignment.create",
  "agency.ops.employee.work-item.create",
  "agency.ops.employee.work-item.transition",
  "agency.ops.employee.schedule.create",
  "agency.ops.employee.responsibility.create",
  "agency.ops.employee.review-cycle.create",
  "agency.ops.employee.review-cycle.complete",
  "agency.ops.employee.memory.upsert",
  "agency.ops.employee.loop.tick",
  "agency.ops.funnels.map.upsert",
  "agency.ops.funnels.connection.upsert",
  "agency.ops.funnels.connection.check",
  "agency.ops.funnels.health.check",
  "agency.ops.funnels.kpi.record",
  "voicePack.download",
  "voicePack.remove",
  "send",
  "agent",
  "agent.wait",
  "wake",
  "talk.mode",
  "tts.enable",
  "tts.disable",
  "tts.convert",
  "tts.setProvider",
  "voicewake.set",
  "node.invoke",
  "chat.send",
  "chat.abort",
  "browser.request",
  "kanban.projects.create",
  "kanban.projects.update",
  "kanban.projects.delete",
  "kanban.projects.content.createNote",
  "kanban.projects.content.updateNote",
  "kanban.projects.content.deleteNote",
  "kanban.projects.content.addAttachment",
  "kanban.projects.content.removeAttachment",
  "kanban.projects.content.addBadge",
  "kanban.projects.content.removeBadge",
  "kanban.projects.content.saveBlocks",
  "kanban.tasks.content.saveBlocks",
  "kanban.tasks.content.setMarkdown",
  "kanban.tasks.content.appendMarkdown",
  "kanban.tasks.create",
  "kanban.tasks.update",
  "kanban.tasks.delete",
  // Workload tracking write methods
  "workload.log",
  ...DAILY_REVIEW_WRITE_METHODS,
  "workload.start_block",
  "workload.end_block",
  "workload.purge",
  "ui.set_tab_label",
  "ui.focus_tab",
  "ui_control.invoke",
  "ui.overlay.spawn",
  "ui.overlay.update",
  "ui.overlay.close",
  "ui.overlay.focus",
  "ui.overlay.popOut",
  "ui.overlay.highlightText",
  "ui.overlay.clearHighlight",
  "ui.modals.openProject",
  "ui.modals.openTask",
  "ui.modals.openClient",
  "ui.modals.openPortfolio",
  "ui.modals.close",
  "ui.modals.closeAll",
  "mcp.start",
  "mcp.stop",
  "mcp.restart",
  "notion.sync",
  "notion.sync.push",
  "notion.sync.pull",
  "notion.sync.setup",
  "users.create",
  "users.update",
  "users.delete",
  "compositions.assets.analyze",
  "compositions.assets.analyzeAll",
  "compositions.brief.set",
  "compositions.timeline.set",
  "compositions.timeline.render",
  "compositions.audio.normalize",
  "compositions.audio.duck",
  "mobile.config.set",
  "mobile.expo.start",
  "mobile.expo.stop",
  "mobile.eas.build",
  "mobile.eas.cancel",
  "learn.progress.completeStep",
  "learn.progress.setCurrent",
  "learn.progress.setNotes",
  "learn.tracks.assign",
  "learn.tracks.unassign",
  "learn.admin.allUsers",
  "learn.admin.upsertTrack",
  "learn.admin.deleteTrack",
  "learn.admin.autoEnroll",
  "learn.guided.progress.update",
  "learn.guided.quiz.submit",
  "learn.guided.prefs.set",
  "apps.create",
  "apps.update",
  "apps.delete",
  "apps.featured.toggle",
  "apps.backfill",
  "funnels.page.config.set",
  "funnels.page.publish",
  "business.create",
  "business.save",
  "business.delete",
  "business.setActive",
  "business.notion.create",
  "business.notion.connect",
  "business.notion.sync",
  "business.income.log",
  "business.income.delete",
  "business.income.upsertStream",
  "business.income.syncWhop",
  "business.income.syncStripe",
  "business.income.syncSquare",
  "business.income.config.set",
  "business.priorities.set",
  "business.clients.create",
  "business.clients.update",
  "business.clients.delete",
  "business.clients.import",
  "business.clients.notion.create",
  "business.clients.notion.connect",
  "business.clients.notion.disconnect",
  "business.clients.notion.sync",
  "business.clients.notion.import",
  "notion.db.add",
  "notion.db.remove",
  "notion.db.refresh",
  "notion.db.pages.pull",
  "notion.db.pages.create",
  "notion.db.pages.update",
  "notion.db.pages.delete",
  "budget.route",
  "budget.record",
  "notes.create",
  ...IDEAS_WRITE_METHODS,
  ...PROJECT_REPOS_WRITE_METHODS,
  ...ONBOARDING_PROFILE_WRITE_METHODS,
  ...SECURE_MODE_WRITE_METHODS,
  ...LOCAL_RUNTIMES_WRITE_METHODS,
  ...FILES_OCR_WRITE_METHODS,
  ...FILES_VIDEO_WRITE_METHODS,
  "notes.update",
  "documents.create",
  "documents.update",
  "documents.append",
  "documents.move",
  "documents.delete",
  "documents.restore",
  "documents.purge",
  "documents.restoreRevision",
  "documents.uploadUrl",
  "documents.reextract",
  "documents.migrateNotes",
  "documents.notion.import",
  "documents.notion.jobs.cancel",
  "documents.obsidian.import",
  "documents.import.undo",
  "documents.import.mapping.apply",
  "documents.types.create",
  "documents.types.update",
  "documents.types.reorder",
  "documents.types.archive",
  "documents.types.migrate",
  "notes.delete",
  "issues.create",
  "issues.update",
  "issues.delete",
  "issues.attach",
  "issues.attachment.delete",
  "covers.setLink",
  "covers.upload",
  "covers.setPosition",
  "covers.clear",
  "research.create",
  "research.update",
  "research.delete",
  "git.checkout",
  "git.add",
  "git.commit",
  "git.push",
  "git.pull",
  "git.fetch",
  "git.stash",
  "git.reset",
  "git.tag",
  "git.merge",
  "files.write",
  "files.mkdir",
  "files.delete",
  "files.rename",
  "files.copy",
  "files.upload",
  "notion.create",
  "notion.update",
  "notion.createPage",
  "notion.updatePage",
  "notion.archivePage",
  "directories.create",
  "directories.update",
  "directories.delete",
  "autonomy:pause",
  "autonomy:resume",
  "autonomy:queue.add",
  "autonomy:queue.importKanban",
  "autonomy:queue.approve",
  "autonomy:queue.cancel",
  "autonomy:queue.start",
  "autonomy:queue.complete",
  "autonomy:queue.fail",
  "autonomy:queue.next",
  "autonomy:queue.setPrefire",
  "autonomy:queue.prefireStatus",
  "autonomy:queue.iterations",
  "autonomy:notify.send",
  // SSH Device write methods
  "ssh.device.create",
  "ssh.device.update",
  "ssh.device.delete",
  "ssh.device.setActive",
  "ssh.device.scan",
  "ssh.device.check",
  "ssh.device.test",
  "ssh.device.ping",
  "ssh.device.refreshStatus",
  "ssh.device.credentials",
  "autonomy:notify.retry",
  "autonomy:api.record",
  "autonomy:cage.report",
  "device.registerPush",
  "device.updatePushSettings",
  "device.unregisterPush",
  "push.send",
  "push.sendToDevice",
  "push.test",
  "notifications.history.markRead",
  "notifications.history.markUnread",
  "notifications.history.dismiss",
  "notifications.history.ack",
  "notifications.history.snooze",
  "notifications.preferences.set",
  "notifications.test",
  "project-summary.generate",
  "project-summary.revise",
  "replicate.predictions.create",
  "leads.search",
  "leads.searchWithSource",
  "leads.update",
  "leads.delete",
  "leads.saveToCRM",
  "leads.bulkSaveToCRM",
  "auth.profiles.upsert",
  "saas.onboarding.saveKey",
  "saas.onboarding.removeKey",
  "saas.onboarding.complete",
  "saas.onboarding.connector.save",
  "saas.onboarding.connector.remove",
  "saas.onboarding.whatsapp.start",
  "saas.onboarding.whatsapp.wait",
  "saas.onboarding.business.save",
  "auth.profiles.delete",
  "auth.profiles.test",
  "nav.sidebar.set",
  "nav.sidebar.reset",
  "vision.capture",
  "vision.analyze",
  "vision.describe",
  "vision.look",
  "vision.cleanup",
  // Federation operations
  "federation.config.set",
  "federation.connect",
  "federation.disconnect",
  "federation.scan",
  "federation.node.add",
  "federation.node.remove",
  "federation.node.invoke",
  "federation.identity.push",
  "federation.sync",
  "federation.share.project",
  "federation.assign.task",
  "federation.share.mcp",
  "federation.broadcast",
  "federation.mesh.messages",
  "federation.mesh.status",
  "federation.selection.set",
  "tunnel.start",
  "tunnel.stop",
  "subagents.progress",
  "subagents.ping",
  "subagents.respawn",
  "subagents.specAnalysis",
  "subagents.specAccept",
  "subagents.checkpointDecision",
  "subagents.message",
  "media.pause",
  "media.toggle",
  "media.next",
  "media.prev",
  "media.mute",
  // Vault write methods
  "vault.members.create",
  "vault.members.update",
  "vault.members.warn",
  "vault.members.timeout",
  "vault.members.kick",
  "vault.members.ban",
  "vault.members.unban",
  "vault.courses.create",
  "vault.courses.update",
  "vault.courses.publish",
  "vault.modules.create",
  "vault.modules.update",
  "vault.modules.delete",
  "vault.modules.reorder",
  "vault.lessons.create",
  "vault.lessons.update",
  "vault.lessons.delete",
  "vault.lessons.reorder",
  "vault.progress.enroll",
  "vault.progress.update",
  "vault.progress.completeLesson",
  "vault.discord.roles.assign",
  "vault.discord.roles.remove",
  "vault.discord.send",
  "vault.discord.dm",
  "vault.rules.create",
  "vault.rules.update",
  "vault.rules.delete",
  "vault.rules.trigger",
  "vault.config.update",
  // Mesh write methods
  "mesh.spawn",
  "mesh.send",
  "mesh.delegate",
  "mesh.kill",
  "mesh.waitResponse",
  "mesh.updateStatus",
  // Services write methods
  "services.start",
  "services.stop",
  "services.restart",
  "services.register",
  "services.unregister",
  "services.update",
  // Focus write methods (aliases of the Discipline plugin's discipline.focus.*)
  "focus.add.task",
  "focus.add.project",
  "focus.remove",
  "focus.reorder",
  "focus.moveUp",
  "focus.moveDown",
  "focus.clear",
  "focus.sync",
  "focus.set",
  // Gmail write methods
  "gmail.send",
  "gmail.reply",
  "gmail.draft",
  "gmail.label",
  "gmail.unlabel",
  "gmail.archive",
  "gmail.trash",
  "gmail.markRead",
  "gmail.markUnread",
  "gmail.star",
  "gmail.unstar",
  "gmail.createLabel",
  "gmail.deleteLabel",
  // Connect flow: server-side OAuth code→token exchange + account persist
  "gmail.oauth.exchange",
  // Systems Intelligence write methods
  "systems.values.create",
  "systems.values.update",
  "systems.values.delete",
  "systems.goals.create",
  "systems.goals.update",
  "systems.goals.delete",
  "systems.priorities.create",
  "systems.priorities.update",
  "systems.priorities.delete",
  "systems.nodes.create",
  "systems.nodes.update",
  "systems.nodes.delete",
  "systems.nodes.position",
  "systems.nodes.positions",
  "systems.relationships.create",
  "systems.relationships.update",
  "systems.relationships.delete",
  "systems.reviews.create",
  "systems.insights.generate",
  "systems.insights.dismiss",
  "systems.autolink.orphans",
  // Ollama monitor write methods
  "ollama.models.load",
  "ollama.models.unload",
  "ollama.session.register",
  "ollama.session.update",
  "ollama.session.unregister",
  "ollama.polling.start",
  "ollama.polling.stop",
  // Funnels write methods
  "funnels.business.create",
  "funnels.business.update",
  "funnels.create",
  "funnels.update",
  "funnels.delete",
  "funnels.duplicate",
  "funnels.stage.add",
  "funnels.stage.update",
  "funnels.stage.delete",
  "funnels.stage.connect",
  "funnels.stage.reorder",
  "funnels.lead.create",
  "funnels.lead.update",
  "funnels.lead.score",
  "funnels.lead.assignFunnel",
  "funnels.lead.moveStage",
  "funnels.kpi.log",
  "funnels.task.create",
  "funnels.task.update",
  "funnels.task.complete",
  "funnels.offer.create",
  "funnels.offer.update",
  "funnels.offer.toggle",
  "funnels.canvas.saveLayout",
  // Landing Pages write methods
  "community.pages.create",
  "community.pages.update",
  "community.pages.delete",
  "community.pages.publish",
  "community.pages.unpublish",
  "community.pages.edit.start",
  "community.pages.edit.update",
  "community.pages.edit.save",
  "community.pages.edit.end",
  "community.pages.component.add",
  "community.pages.component.update",
  "community.pages.component.remove",
  "community.pages.component.reorder",
  "community.pages.versions.restore",
  "community.pages.templates.clone",
  // KPI Analytics write methods
  "kpi.track",
  "kpi.sites.create",
  "kpi.sites.update",
  "kpi.sites.delete",
  "kpi.sites.regenerateKey",
  "kpi.goals.create",
  "kpi.goals.update",
  "kpi.goals.delete",
  "kpi.funnels.create",
  "kpi.funnels.update",
  "kpi.funnels.delete",
  // Storyboard write methods
  "storyboard.create",
  "storyboard.update",
  "storyboard.delete",
  "storyboard.run",
  "storyboard.generateScript",
  "storyboard.regenerateScript",
  "storyboard.splitScenes",
  "storyboard.regenerateScenes",
  "storyboard.regenerateSceneImage",
  "storyboard.generateImages",
  "storyboard.updateScene",
  "storyboard.addCharacter",
  "storyboard.updateCharacter",
  "storyboard.deleteCharacter",
  "storyboard.exportVideo",
  "storyboard.generateClip",
  "storyboard.cloneVoice",
  "storyboard.deleteVoice",
  "storyboard.generateVoiceover",
  "storyboard.generateAllVoiceovers",
  "storyboard.mergeAudio",
  "storyboard.analyzeStyle",
  "storyboard.runSurvivalWorkflow",
  // Content trends / scripts: scopes now declared by the content-studio plugin.
  // Character write methods
  "characters.create",
  "characters.update",
  "characters.delete",
  "characters.addImage",
  "characters.deleteImage",
  "characters.setPrimary",
  // Email accounts write surface
  "email.send",
  "email.accounts.create",
  "email.accounts.update",
  "email.accounts.delete",
  "email.accounts.setPrimary",
  "email.accounts.test",
  // Content Pages + Instagram setup: scopes declared by the content-studio plugin.
  // KIS Sprint 1 foundation — write methods
  "objrel.link",
  "objrel.unlink",
  "reports.link",
  "reports.unlink",
  "audit.log",
  // KIS Phase 1 — object write methods
  "opportunity.create",
  "opportunity.update",
  "opportunity.delete",
  "opportunity.convert",
  "decision.create",
  "decision.update",
  "decision.delete",
  "decision.guideTask",
  "risk.create",
  "risk.update",
  "risk.delete",
  "risk.impacts",
  "risk.unimpacts",
  "commitment.create",
  "commitment.update",
  "commitment.delete",
  "person.create",
  "person.update",
  "person.delete",
  "person.assignTask",
  "person.unassignTask",
  ...ANDROID_OPS_WRITE_METHODS,
  ...GOALS_WRITE_METHODS,
  ...GROUPCHAT_WRITE_METHODS,
  ...LAUNCH_PANEL_WRITE_METHODS,
  ...QUEUE_WRITE_METHODS,
  ...HQ_WRITE_METHODS,
  ...VOICE_PROVIDERS_WRITE_METHODS,
  ...VOICE_CLI_ROUTE_WRITE_METHODS,
  ...VERIFICATION_WRITE_METHODS,
  ...SCHEDULED_TASKS_WRITE_METHODS,
  ...APPROVALS_WRITE_METHODS,
]);

/** True for a method that only reads (core READ_METHODS, or a plugin's `read` scope). */
export function isReadOnlyGatewayMethod(method: string): boolean {
  return READ_METHODS.has(method) || resolvePluginMethodScope(method) === "read";
}

function authorizeGatewayMethod(method: string, client: GatewayRequestOptions["client"]) {
  if (!client?.connect) return null;
  const role = client.connect.role ?? "operator";
  const scopes = client.connect.scopes ?? [];
  if (NODE_ROLE_METHODS.has(method)) {
    if (role === "node") return null;
    return errorShape(ErrorCodes.INVALID_REQUEST, `unauthorized role: ${role}`);
  }
  if (role === "node") {
    return errorShape(ErrorCodes.INVALID_REQUEST, `unauthorized role: ${role}`);
  }
  if (role !== "operator") {
    return errorShape(ErrorCodes.INVALID_REQUEST, `unauthorized role: ${role}`);
  }
  if (scopes.includes(ADMIN_SCOPE)) return null;
  if (APPROVAL_METHODS.has(method) && !scopes.includes(APPROVALS_SCOPE)) {
    return errorShape(ErrorCodes.INVALID_REQUEST, "missing scope: operator.approvals");
  }
  if (PAIRING_METHODS.has(method) && !scopes.includes(PAIRING_SCOPE)) {
    return errorShape(ErrorCodes.INVALID_REQUEST, "missing scope: operator.pairing");
  }
  if (READ_METHODS.has(method) && !(scopes.includes(READ_SCOPE) || scopes.includes(WRITE_SCOPE))) {
    return errorShape(ErrorCodes.INVALID_REQUEST, "missing scope: operator.read");
  }
  if (WRITE_METHODS.has(method) && !scopes.includes(WRITE_SCOPE)) {
    return errorShape(ErrorCodes.INVALID_REQUEST, "missing scope: operator.write");
  }
  if (APPROVAL_METHODS.has(method)) return null;
  if (PAIRING_METHODS.has(method)) return null;
  if (READ_METHODS.has(method)) return null;
  if (WRITE_METHODS.has(method)) return null;
  // v2 plugins declare a scope per RPC method in their manifest.
  const pluginScope = resolvePluginMethodScope(method);
  if (pluginScope === "read") {
    if (scopes.includes(READ_SCOPE) || scopes.includes(WRITE_SCOPE)) return null;
    return errorShape(ErrorCodes.INVALID_REQUEST, "missing scope: operator.read");
  }
  if (pluginScope === "write") {
    if (scopes.includes(WRITE_SCOPE)) return null;
    return errorShape(ErrorCodes.INVALID_REQUEST, "missing scope: operator.write");
  }
  if (ADMIN_METHOD_PREFIXES.some((prefix) => method.startsWith(prefix))) {
    return errorShape(ErrorCodes.INVALID_REQUEST, "missing scope: operator.admin");
  }
  if (
    method.startsWith("config.") ||
    method.startsWith("wizard.") ||
    method.startsWith("update.") ||
    method === "channels.logout" ||
    method === "skills.install" ||
    method === "skills.update" ||
    method === "cron.add" ||
    method === "cron.update" ||
    method === "cron.remove" ||
    method === "cron.run" ||
    method === "sessions.patch" ||
    method === "sessions.reset" ||
    method === "sessions.delete" ||
    method === "sessions.compact"
  ) {
    return errorShape(ErrorCodes.INVALID_REQUEST, "missing scope: operator.admin");
  }
  return errorShape(ErrorCodes.INVALID_REQUEST, "missing scope: operator.admin");
}

// Business & Agency (opportunity/decision/risk/commitment/person, business.*,
// clients.*, leads.*, funnels.*, campaigns.*, agency.ops.*, hq.*): served by the
// business-agency plugin (src/business-agency/methods.ts) while it is enabled.
export const coreGatewayHandlers: GatewayRequestHandlers = {
  ...connectHandlers,
  ...accessHandlers,
  ...logsHandlers,
  ...voicewakeHandlers,
  ...healthHandlers,
  ...channelsHandlers,
  ...chatHandlers,
  ...cronHandlers,
  ...deviceHandlers,
  ...execApprovalsHandlers,
  ...webHandlers,
  ...modelsHandlers,
  ...configHandlers,
  ...wizardHandlers,
  ...talkHandlers,
  ...ttsHandlers,
  ...skillsHandlers,
  ...sessionsHandlers,
  ...systemHandlers,
  ...updateHandlers,
  ...nodeHandlers,
  ...notionSchemaHandlers,
  ...notionConflictsHandlers,
  ...notionImportHandlers,
  ...loopsHandlers,
  ...projectsHandlers,
  ...sendHandlers,
  ...usageHandlers,
  ...worldHandlers,
  ...agentHandlers,
  ...agentsHandlers,
  ...agentsKnowledgeHandlers,
  ...fsHandlers,
  ...deviceControlHandlers,
  ...kanbanHandlers,
  ...videoSwiftHandlers,
  ...databasesHandlers,
  ...databasePacksHandlers,
  ...mcpLifecycleHandlers,
  ...mcpClientHandlers,
  ...autopilotHandlers,
  ...autopilotApprovalHandlers,
  ...approvalsHandlers,
  ...notionSyncHandlers,
  ...workflowHandlers,
  ...noteHandlers,
  ...ideasHandlers,
  ...projectReposHandlers,
  ...onboardingProfileHandlers,
  ...secureModeHandlers,
  ...localRuntimesHandlers,
  ...secureResearchHandlers,
  ...documentsHandlers,
  ...prioritiesHandlers,
  ...issueHandlers,
  ...coverHandlers,
  ...opsAgentHandlers,
  ...researchHandlers,
  ...browserHandlers,
  ...gitHandlers,
  ...checkpointHandlers,
  ...taskWorktreeHandlers,
  ...relationsHandlers,
  // KIS Sprint 1 foundation (typed business-object edges + audit log).
  ...objectRelationHandlers,
  ...objectConnectionHandlers,
  ...androidOpsHandlers,
  ...saasHandlers,
  ...auditHandlers,
  // KIS Phase 1 — 10 Core Business Objects
  ...chatPanelHandlers,
  ...notionDatabaseHandlers,
  ...terminalHandlers,
  ...terminalPeekHandlers,
  ...filesHandlers,
  ...filesOcrHandlers,
  ...filesVideoHandlers,
  ...filesDiffHandlers,
  ...notionProxyHandlers,
  ...notionWizardHandlers,
  ...quickstartHandlers,
  ...quickstartProvidersHandlers,
  ...voiceSetupHandlers,
  ...voiceDockerHandlers,
  ...voiceLocalSetupHandlers,
  ...voicePackHandlers,
  ...budgetHandlers,
  ...creditsHandlers,
  ...autonomyHandlers,
  ...scheduleAlertsHandlers,
  ...calendlyHandlers,
  ...calendarSyncHandlers,
  ...discoveryHandlers,
  ...designHandlers,
  ...pushNotificationHandlers,
  ...directoryHandlers,
  ...formsHandlers,
  ...compositionsHandlers,
  ...moltbookHandlers,
  ...replicateHandlers,
  ...emailHandlers,
  ...emailAccountsHandlers,
  ...authHandlers,
  ...supabaseHandlers,
  ...visionClawHandlers,
  ...navSidebarHandlers,
  ...visionHandlers,
  ...tunnelHandlers,
  ...subagentsHandlers,
  ...subagentsHistoryHandlers,
  ...subagentReviewsHandlers,
  ...agentsReviewsHandlers,
  ...oversightSamplerHandlers,
  ...mediaHandlers,
  ...federationHandlers,
  ...federationControlHandlers,
  ...federationFilesHandlers,
  ...autoUpdateHandlers,
  ...prodUpdateHandlers,
  ...vaultHandlers,
  ...agentMeshHandlers,
  ...meshGamificationHandlers,
  ...servicesHandlers,
  ...servicesLifecycleHandlers,
  ...proactiveHandlers,
  ...overlayHandlers,
  ...queueHandlers,
  ...goalsHandlers,
  ...groupChatHandlers,
  ...launchPanelHandlers,
  ...voiceProvidersHandlers,
  ...voiceCliRouteHandlers,
  ...verificationHandlers,
  ...ownerDecisionsHandlers,
  ...scheduledTasksHandlers,
  ...gmailHandlers,
  ...systemsIntelligenceHandlers,
  ...ollamaMonitorHandlers,
  ...sshDeviceHandlers,
  ...pluginGatewayHandlers,
  ...pluginPackageHandlers,
  ...pluginCatalogHandlers,
  ...networkTailscaleHandlers,
  ...tailscaleRemoteHandlers,
  ...graphGlobalHandlers,
  ...sessionHistoryHandlers,
  ...projectCollaborationHandlers,
  ...integrationHandlers,
  ...landingPagesHandlers,
  ...kpiHandlers,
  ...communityHandlers,
  ...storyboardHandlers,
  ...characterHandlers,
  ...agentToolsHandlers,
  ...brandingHandlers,
  ...compositionBlocksHandlers,
  ...usersHandlers,
  ...profilesHandlers,
  ...mobileHandlers,
  ...learnHandlers,
  ...learnGuidedHandlers,
  ...appsHandlers,
  ...agentIdentityHandlers,
  ...uiControlHandlers,
  ...browserSetupHandlers,
  ...browserViewerHandlers,
  ...browserProfilesHandlers,
  ...browserExtensionHandlers,
  ...setupConnectHandlers,
  ...docAgentHandlers,
  ...promptTemplateHandlers,
  ...fileTransferHandlers,
  ...coderHandlers,
  ...chatCliHandlers,
  ...codersHandlers,
  ...cliRoutingHandlers,
  ...setupStatusHandlers,
  ...telegramSetupHandlers,
  ...providersCatalogHandlers,
  ...agentIntegrationHandlers,
  ...workloadHandlers,
  ...dailyReviewHandlers,
  ...notificationHandlers,
  ...projectSummaryHandlers,
  ...reportsHandlers,
  ...licenseHandlers,
  ...canvasWorkflowHandlers,
  ...warRoomHandlers,
  ...workflowEngineHandlers,
  ...commsHandlers,
  ...autonomousTaskHandlers,
  ...pairingHandlers,
  // Host-executing Workspace dev runtime. Intentionally omitted from the
  // read/write method sets so every action requires operator.admin.
  ...workspaceDevHandlers,
};

// DEBUG: Log registered terminal methods
console.log(
  "[Gateway] Registered terminal methods:",
  Object.keys(coreGatewayHandlers).filter((k) => k.startsWith("terminal.")),
);
console.log(
  "[Gateway] Registered subagents methods:",
  Object.keys(coreGatewayHandlers).filter((k) => k.startsWith("subagents.")),
);

/**
 * Method-name prefixes that get routed to the master when this gateway is
 * running as a satellite. Business data lives on the master — the satellite
 * UI is a thin client for those domains so all writes (and reads, so the UI
 * never sees stale local state) hit the master's authoritative store.
 *
 * Keep this list intentionally narrow. Local-only domains (terminal.*,
 * sessions.*, agent.*, kanban.*, etc.) keep their normal local dispatch.
 */
const SATELLITE_MASTER_PROXY_PREFIXES = [
  // --- CRM / business (original entries) ---
  "business.",
  // Leads + landing pages are part of the CRM/business domain and share the
  // same state file on master, so they ride the same proxy.
  "leads.",
  "community.pages.", // landing pages (the real method namespace; "landingPages." was a dead no-op)
  // --- Org data that backs dashboards, the knowledge graph, and other pages.
  // These domains are owned by the master node; a satellite is a thin client,
  // so reading them locally returns the satellite's empty store. Routing them
  // to master is what makes those pages reflect authoritative data. Writes ride
  // along too so the satellite never persists into a store master can't see. ---
  "graph.", // knowledge graph (graph.global.snapshot / graph.summary)
  "kpi.",
  "budget.",
  "credits.",
  "usage.",
  "autonomy.",
  "campaigns.",
  "funnels.",
  "notes.",
  "issues.",
  "directories.",
  "relations.",
  "products.",
  "discipline.",
  "systems.", // systems-intelligence graph/goals/priorities
  "db.", // user databases (db.list / db.rows.* etc.)
  "forms.",
  "promptTemplates.",
  "viralExamples.",
  "viral.formats.", // viral-format intelligence: benchmark base lives on master
  "learn.",
  "moltbook.",
  "loops.",
  "mesh.gamification.",
  "vault.", // community / courses / discord (master holds the bot + content)
  "content.pages.",
  "reports.",
  "socials.",
  "integrations.", // org-level integration credentials live on master
  "gmail.",
  "email.",
  "calendar.",
  "calendly.",
  "apps.",
  "branding.",
  "workload.",
  "daily_review.",
  "notifications.history.",
  "characters.",
  "instagram.insights.",
  "instagram.profile.",
] as const;

/**
 * Methods that match a proxied prefix but have a per-DEVICE/local aspect and
 * must keep running on the satellite itself — OAuth flows that complete in the
 * local browser, and live subscriptions whose transport is the local socket.
 */
const SATELLITE_MASTER_PROXY_LOCAL_EXCLUDES = new Set<string>([
  "content.pages.stats.subscribe",
  "calendly.connect",
  "calendly.completeOAuth",
]);
const SATELLITE_MASTER_PROXY_LOCAL_EXCLUDE_PREFIXES = ["gmail.oauth.", "calendar.oauth."] as const;

function shouldProxyToMaster(method: string): boolean {
  if (SATELLITE_MASTER_PROXY_LOCAL_EXCLUDES.has(method)) return false;
  for (const prefix of SATELLITE_MASTER_PROXY_LOCAL_EXCLUDE_PREFIXES) {
    if (method.startsWith(prefix)) return false;
  }
  for (const prefix of SATELLITE_MASTER_PROXY_PREFIXES) {
    if (method.startsWith(prefix)) return true;
  }
  return false;
}

/**
 * Report kinds a satellite renders for ITSELF and therefore owns locally.
 *
 * `agency.ops.*` is not proxied, so `agency.ops.invoice.document.render` runs
 * on the satellite, enqueues into the satellite's reports store and the local
 * worker writes the PDF here. `reports.*` IS proxied, so the follow-up
 * `reports.get` / `reports.preview` went to master, which had never heard of
 * that report and answered NOT_FOUND — the render worked and the download was
 * impossible. Anything rendered from local agency data is read locally.
 */
const SATELLITE_LOCAL_REPORT_KINDS = new Set([INVOICE_REPORT_KIND, PROPOSAL_REPORT_KIND]);

/**
 * True when a `reports.*` call must bypass the master proxy because this
 * satellite is the node that holds the row.
 *
 * Id-addressed reads are decided by looking the id up locally: a hit means we
 * rendered it, and master could only ever answer NOT_FOUND. A miss falls
 * through to the proxy unchanged, so master-owned reports keep working.
 * `reports.list` is decided by `kind`, which is how the invoice download finds
 * an already-rendered PDF from an earlier session.
 *
 * Never throws: a store failure here must not take down report dispatch, so it
 * degrades to the previous behaviour (proxy to master).
 */
async function reportsCallIsLocallyOwned(
  method: string,
  params: Record<string, unknown>,
): Promise<boolean> {
  try {
    if (method === "reports.list") {
      const kind = typeof params.kind === "string" ? params.kind : null;
      return kind !== null && SATELLITE_LOCAL_REPORT_KINDS.has(kind);
    }
    if (method === "reports.get" || method === "reports.preview" || method === "reports.delete") {
      const id = typeof params.id === "string" ? params.id : null;
      if (!id) return false;
      const { getReportsStore } = await import("../reports/store.js");
      const record = getReportsStore().getReport(id);
      return record !== null && SATELLITE_LOCAL_REPORT_KINDS.has(record.kind);
    }
    return false;
  } catch {
    return false;
  }
}

export async function handleGatewayRequest(
  opts: GatewayRequestOptions & { extraHandlers?: GatewayRequestHandlers },
): Promise<void> {
  // SaaS multi-tenancy: run the whole request (master-proxy + local dispatch)
  // inside the connection's tenant namespace, so resolveStateDir() — and thus
  // every per-tenant store that funnels through it — resolves to this tenant's
  // data for the duration of the request (and its awaits). No-op when the
  // connection carries no SaaS tenant (local mode / backend nodes).
  return runWithTenantScope(opts.client?.saasNamespace, opts.client?.saasRole, () =>
    handleGatewayRequestImpl(opts),
  );
}

async function handleGatewayRequestImpl(
  opts: GatewayRequestOptions & { extraHandlers?: GatewayRequestHandlers },
): Promise<void> {
  const { req, client, isWebchatConnect, context } = opts;
  let { respond } = opts;
  // Workspace users skip the scope check: their (stricter) deny-by-default
  // access check below replaces it.
  const authError = client?.access ? null : authorizeGatewayMethod(req.method, client);
  if (authError) {
    respond(false, undefined, authError);
    return;
  }
  // Multi-user workspaces: a signed-in workspace user (never the owner, agents
  // or devices) passes the central deny-by-default access check, and list
  // results are filtered to what their workspaces + allowance permit.
  if (client?.access) {
    const { isMultiUserEnabled, checkUserRequest } = await import("../access/runtime.js");
    if (!isMultiUserEnabled()) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "multi-user access is disabled"),
      );
      return;
    }
    const params = (req.params && typeof req.params === "object" ? req.params : {}) as Record<
      string,
      unknown
    >;
    req.params = params;
    const check = await checkUserRequest(client.access, req.method, params);
    if (!check.ok) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, check.message));
      return;
    }
    if (check.transform || check.after) {
      const inner = respond;
      respond = (ok, payload, error, meta) => {
        if (!ok) return inner(ok, payload, error, meta);
        let out = payload;
        try {
          check.after?.(payload);
          if (check.transform) out = check.transform(payload);
        } catch (err) {
          return inner(
            false,
            undefined,
            errorShape(ErrorCodes.INVALID_REQUEST, `access filter failed: ${String(err)}`),
          );
        }
        return inner(ok, out, error, meta);
      };
    }
  }
  // The tab that SENDS in a session is where that agent's highlights /
  // navigation go (ui_control navigate/highlight/guide targeting). Only a real
  // send binds — every tab loads chat.history for the main session on boot.
  if (req.method === "chat.send") noteUiRequestSession(client, req.params);
  // A group send binds the group's tab too; its members' ui_control calls
  // resolve to it through the group id (ui-guide pickActive).
  else if (req.method === "groupchat.send") {
    const key = (req.params as { key?: unknown } | null)?.key;
    if (typeof key === "string") noteUiRequestSession(client, { sessionKey: key });
  }
  // Hosted wake-mode Machine: a state-changing RPC is real activity (idle sleep).
  noteFleetRpc(req.method, client?.connect?.client?.id, () => isReadOnlyGatewayMethod(req.method));

  // Satellite-mode master proxy: business + CRM data lives on master. When
  // this gateway is a connected satellite, forward those RPCs upstream so
  // the master's gateway owns the write. Falls through to local dispatch
  // when we're standalone, when we're the master, or when the satellite
  // can't reach master (the local handler is the offline fallback).
  if (
    shouldProxyToMaster(req.method) &&
    !(
      req.method.startsWith("reports.") &&
      (await reportsCallIsLocallyOwned(req.method, (req.params ?? {}) as Record<string, unknown>))
    )
  ) {
    try {
      const { getFederationSatellite } = await import("../federation/index.js");
      const satellite = getFederationSatellite();
      if (satellite && satellite.getState?.() === "connected") {
        const result = await satellite.invokeOnMaster(
          req.method,
          (req.params ?? {}) as Record<string, unknown>,
        );
        if (result.success) {
          respond(true, result.data);
        } else {
          respond(false, undefined, {
            code: result.error?.code ?? "MASTER_INVOKE_FAILED",
            message: result.error?.message ?? "Master rejected the request",
          });
        }
        return;
      }
    } catch (err) {
      // Federation module not loadable or transient error — fall through to
      // local dispatch so the satellite isn't bricked when master is down.
      console.warn(
        `[Gateway] master-proxy fell through for ${req.method}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  // Legacy method names now served by a plugin under its namespace (e.g.
  // focus.* → discipline.focus.*); plugin-method-aliases.ts.
  const alias = resolvePluginMethodAlias(req.method, opts.extraHandlers);
  if (alias?.off) {
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, alias.off));
    return;
  }
  const handler =
    alias?.handler ?? opts.extraHandlers?.[req.method] ?? coreGatewayHandlers[req.method];
  // Plugin RPCs the owner switched off (or whose permission was revoked) in
  // Setup › Plugins — applied live, no restart.
  const pluginBlock = pluginMethodBlockedReason(alias?.target ?? req.method);
  if (pluginBlock) {
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, pluginBlock));
    return;
  }
  if (!handler) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, `unknown method: ${req.method}`),
    );
    return;
  }
  await handler({
    req,
    params: (req.params ?? {}) as Record<string, unknown>,
    client,
    isWebchatConnect,
    respond,
    context,
  });
  // A write may have finished a setup (key added, coder installed, plugin
  // configured): recompute setup.status shortly and push it if it changed.
  if (
    !READ_METHODS.has(req.method) &&
    resolvePluginMethodScope(alias?.target ?? req.method) !== "read" &&
    isSetupRelevantWrite(req.method) &&
    typeof context?.broadcast === "function"
  ) {
    scheduleSetupStatusRefresh(context.broadcast);
  }
}
