/**
 * MCP Server Management View
 * Luxury black-gold glass — shared primitives from glass-tools-shared.ts plus
 * the page layer in glass-mcp.css.ts.
 */

import { html, nothing } from "lit";
import { icons } from "../icons";
import type { GatewayBrowserClient } from "../gateway";
import type { AppViewState } from "../app-view-state";
import { t } from "../i18n";
import { GLASS_TOOLS_CSS, glassAurora, glassHero } from "./glass-tools-shared";
import { MCP_GLASS_CSS } from "./glass-mcp.css";
import type {
  McpManagementState,
  McpServerInfo,
  McpToolInfo,
  McpAgentInfo,
  QuickInstallState,
  QuickConnectInfo,
  QuickScope,
  QuickClient,
  QuickOS,
  QuickReach,
} from "../controllers/mcp";
import {
  startMcp,
  stopMcp,
  restartMcp,
  toggleMcpServer,
  addCustomServer,
  removeCustomServer,
  loadMcpPage,
  registerInClaudeCode,
  unregisterFromClaudeCode,
  saveCanvaToken,
  testCanvaConnection,
  disconnectCanva,
  startCanvaOAuth,
  saveSupabaseConfig,
  testSupabaseConnection,
  disconnectSupabase,
  openInspector,
  closeInspector,
  callInspectorTool,
  toggleInspectorTry,
  setInspectorTryArgs,
  toggleQuickInstall,
  toggleQuickHelp,
  setQuickScope,
  setQuickClient,
  setQuickOS,
  copyQuickSnippet,
  revealGatewayKey,
  rotateGatewayKey,
  loadQuickInstallInfo,
} from "../controllers/mcp";
import type { RegistryEntry, McpRegistryState, FeaturedMcp } from "../controllers/mcp-registry";
import {
  searchRegistry,
  loadMoreResults,
  selectRegistryServer,
  installRegistryServer,
  getInstallCommand,
  getTransportBadge,
  formatPublishedDate,
  filterCatalog,
  catalogCategoryCounts,
  openInstall,
  closeInstall,
  installFeatured,
  testFeaturedConnection,
  FEATURED_MCPS,
} from "../controllers/mcp-registry";

// Derived lookups for the curated catalog
const FEATURED_MCPS_LENGTH = FEATURED_MCPS.length;
const FEATURED_MCPS_BY_ID: Record<string, FeaturedMcp> = Object.fromEntries(
  FEATURED_MCPS.map((m) => [m.id, m]),
);

// ── Styles ──────────────────────────────────────────────────
// Shared luxury-glass primitives + the MCP page layer (glass-mcp.css.ts).
const pageStyles = html`<style>${GLASS_TOOLS_CSS}${MCP_GLASS_CSS}</style>`;


// ── Icon helpers ──────────────────────────────────────────────

const AGENT_ICONS: Record<string, string> = {
  main: "🦞",
  webdev: "🏗️",
  qa: "🔍",
};

const SERVER_ICONS: Record<string, string> = {
  kanban: "📋",
  filesystem: "📁",
  web: "🌐",
  browser: "🖥️",
  messaging: "💬",
  tts: "🔊",
};

function getAgentIcon(id: string): string {
  return AGENT_ICONS[id] || "🤖";
}

function getServerIcon(name: string): string {
  return SERVER_ICONS[name] || "⚡";
}

function formatUptime(seconds: number): string {
  if (!seconds || seconds <= 0) return "—";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

// ── Main Render ──────────────────────────────────────────────

function serverToolCount(server: McpServerInfo): number {
  return server.toolDetails?.length ?? server.tools?.length ?? 0;
}

/** Keyboard activation for card-style (div) buttons. */
function onActivateKey(fn: () => void) {
  return (e: KeyboardEvent) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      fn();
    }
  };
}

function renderMcpSkeleton(label: string) {
  return html`
    <div class="mcp-scope gt-scope" aria-busy="true">
      ${glassAurora()}
      <div class="mcp-skel-head">
        <div class="gt-skel" style="width:120px;height:10px"></div>
        <div class="gt-skel" style="width:min(380px,80%);height:30px;border-radius:10px"></div>
        <div class="gt-skel" style="width:min(520px,90%);height:12px"></div>
      </div>
      <div class="mcp-skel-grid">
        ${[0, 1, 2, 3, 4, 5].map(
          (i) => html`
            <div class="mcp-skel-card gt-glass gt-rise" style="--gt-i:${i}">
              <div class="mcp-skel-row">
                <div class="gt-skel" style="width:44px;height:44px;border-radius:14px;flex:none"></div>
                <div style="flex:1;display:grid;gap:8px">
                  <div class="gt-skel" style="width:55%;height:12px"></div>
                  <div class="gt-skel" style="width:85%;height:10px"></div>
                </div>
              </div>
              <div class="mcp-skel-row">
                <div class="gt-skel" style="width:56px;height:22px;border-radius:999px"></div>
                <div class="gt-skel" style="width:72px;height:22px;border-radius:999px"></div>
              </div>
            </div>
          `,
        )}
      </div>
      <div class="mcp-loading"><span class="mcp-loading-dot">◆</span> ${label}</div>
    </div>
  `;
}

export function renderMcp(state: AppViewState, client: GatewayBrowserClient) {
  const mcpState = state.mcpManagementState;
  if (!mcpState) {
    return html`<div class="mcp-page">${pageStyles}${renderMcpSkeleton("INITIALIZING MCP MANAGEMENT")}</div>`;
  }

  if (mcpState.loading && !mcpState.status) {
    return html`<div class="mcp-page">${pageStyles}${renderMcpSkeleton("LOADING MCP DATA")}</div>`;
  }

  const isRunning = mcpState.status?.running ?? false;
  const enabledCount = mcpState.servers.filter((s) => s.enabled).length;
  const runningCount = mcpState.servers.filter((s) => s.running).length;
  const toolsExposed = mcpState.servers.reduce((n, s) => n + serverToolCount(s), 0);
  const skills = mcpState.skillsReport?.skills ?? [];
  const skillsReady = skills.filter((s) => s.eligible && !s.disabled).length;

  return html`
    <div class="mcp-page">
      ${pageStyles}

      <div class="mcp-scope gt-scope">
        ${glassAurora()}
        ${glassHero({
          eyebrow: "Capabilities",
          title: "Tools & integrations",
          sub: "Native tools, skills and Model Context Protocol servers wired into InfiniBot — inspect, connect and extend from one place.",
          stats: [
            { value: `${runningCount}/${mcpState.servers.length}`, label: "Live servers" },
            { value: toolsExposed, label: "Tools exposed" },
            { value: `${skillsReady}/${skills.length}`, label: "Skills ready" },
          ],
        })}

        <!-- Success Message -->
        ${mcpState.successMessage ? html`<div class="mcp-success" role="status">${mcpState.successMessage}</div>` : nothing}

        <!-- Error Message -->
        ${mcpState.error ? html`
          <div class="mcp-error" role="alert">
            <span>⚠ ${mcpState.error}</span>
            <button class="mcp-error-dismiss" aria-label="Dismiss" @click=${() => { mcpState.error = null; state.requestUpdate?.(); }}>✕</button>
          </div>
        ` : nothing}

        <!-- Capabilities Tab Bar -->
        ${renderCapabilitiesTabs(state, mcpState)}

        <!-- Tab Content -->
        ${mcpState.currentTab === "tools" ? renderToolsTab(state, mcpState) : nothing}
        ${mcpState.currentTab === "skills" ? renderSkillsTab(state, mcpState) : nothing}
        ${mcpState.currentTab === "mcps" ? html`
          <!-- Status Header Bar -->
          ${renderStatusBar(state, mcpState, isRunning, enabledCount)}
          <!-- Quick Install: connect any external CLI / agent to this gateway -->
          ${renderQuickInstall(state, mcpState)}
          <!-- Discovery: search, category pills, featured one-click grid -->
          ${renderDiscoverySection(state, mcpState)}
          <!-- Server Configuration (installed + advanced) -->
          ${renderServersSection(state, mcpState)}
        ` : nothing}
      </div>

      <!-- Overlay layer: kept outside the isolated scope so fixed z-index still beats app chrome -->
      <div class="mcp-layers gt-scope">
        <!-- Add Server Dialog -->
        ${mcpState.showAddDialog ? renderAddDialog(state, mcpState) : nothing}

        <!-- Guided install modal (featured one-click) -->
        ${mcpState.registry.installTarget ? renderInstallModal(state, mcpState) : nothing}

        <!-- Canva credentials modal -->
        ${mcpState.canva.showModal ? renderCanvaModal(state, mcpState) : nothing}
        <!-- Supabase credentials modal -->
        ${mcpState.supabase.showModal ? renderSupabaseModal(state, mcpState) : nothing}

        <!-- Inspector drawer (live tools for a connected server) -->
        ${mcpState.inspector.serverName ? renderInspectorDrawer(state, mcpState) : nothing}

        <!-- Registry Marketplace -->
        ${mcpState.registry.open ? renderMarketplace(state, mcpState) : nothing}
      </div>
    </div>
  `;
}

// ── Capabilities Tab Bar ─────────────────────────────────────

function renderCapabilitiesTabs(state: AppViewState, mcpState: McpManagementState) {
  const { currentTab } = mcpState;
  const toolsCount = mcpState.servers.filter(s => s.category === "Built-in").length;
  const skillsCount = mcpState.skillsReport?.skills?.length ?? 0;
  const mcpsCount = mcpState.servers.filter(s => s.category !== "Built-in" && !s.name.startsWith("excalidraw")).length + 
    (mcpState.servers.some(s => s.name === "excalidraw") ? 1 : 0);

  const setTab = (tab: import("../controllers/mcp").CapabilitiesTab) => {
    mcpState.currentTab = tab;
    state.requestUpdate?.();
  };
  const tabIndex = currentTab === "skills" ? 1 : currentTab === "mcps" ? 2 : 0;

  return html`
    <div class="cap-tabbar">
      <div class="cap-tabs" role="tablist" aria-label="Capabilities" data-learn-id="mcp-tabs" style="--cap-i:${tabIndex}">
        <button 
          class="cap-tab ${currentTab === 'tools' ? 'active' : ''}"
          role="tab"
          aria-selected=${currentTab === "tools" ? "true" : "false"}
          data-learn-id="mcp-tab-tools"
          @click=${() => setTab("tools")}
        >
          ${icons.zap} Tools <span class="cap-tab-count">${toolsCount}</span>
        </button>
        <button 
          class="cap-tab ${currentTab === 'skills' ? 'active' : ''}"
          role="tab"
          aria-selected=${currentTab === "skills" ? "true" : "false"}
          data-learn-id="mcp-tab-skills"
          @click=${() => setTab("skills")}
        >
          ${icons.book} Skills <span class="cap-tab-count">${skillsCount}</span>
        </button>
        <button 
          class="cap-tab ${currentTab === 'mcps' ? 'active' : ''}"
          role="tab"
          aria-selected=${currentTab === "mcps" ? "true" : "false"}
          data-learn-id="mcp-tab-mcps"
          @click=${() => setTab("mcps")}
        >
          ${icons.plug} MCPs <span class="cap-tab-count">${mcpsCount}</span>
        </button>
      </div>
    </div>
  `;
}

// ── Tools Tab Content ────────────────────────────────────────

function renderToolsTab(state: AppViewState, mcpState: McpManagementState) {
  // Built-in tools are the "Built-in" category servers
  const builtInServers = mcpState.servers.filter(s => s.category === "Built-in");

  return html`
    <div class="mcp-section">
      <div class="mcp-section-header">
        <span class="mcp-section-title" data-learn-id="mcp-native-tools">${icons.zap} Native tools</span>
        <span class="mcp-section-sub">
          InfiniBot's built-in function calling capabilities
        </span>
      </div>

      ${builtInServers.length === 0 ? html`
        <div class="gt-empty gt-glass mcp-empty-glass">
          <div class="gt-empty-orb">${icons.zap}</div>
          <div class="gt-empty-title">No native tools reported</div>
          <div class="gt-empty-sub">Start the gateway or refresh to load InfiniBot's built-in tool servers.</div>
        </div>
      ` : html`
        <div class="mcp-servers-grid">
          ${builtInServers.map((server, i) => renderServerCard(state, mcpState, server, i))}
        </div>
      `}
    </div>
  `;
}

// ── Skills Tab Content ───────────────────────────────────────

function renderSkillsTab(state: AppViewState, mcpState: McpManagementState) {
  const skills = mcpState.skillsReport?.skills ?? [];
  const filter = mcpState.skillsFilter.toLowerCase();
  const filtered = filter 
    ? skills.filter(s => 
        s.name.toLowerCase().includes(filter) || 
        s.description.toLowerCase().includes(filter)
      )
    : skills;

  return html`
    <div class="mcp-section">
      <div class="mcp-section-header">
        <span class="mcp-section-title">${icons.book} Skills</span>
        <div class="mcp-section-tools">
          <label class="mcp-filter-wrap">
            ${icons.search}
            <input 
              class="gt-input mcp-filter"
              type="text"
              aria-label="Filter skills"
              placeholder="Filter skills..."
              .value=${mcpState.skillsFilter}
              @input=${(e: Event) => {
                mcpState.skillsFilter = (e.target as HTMLInputElement).value;
                state.requestUpdate?.();
              }}
            />
          </label>
          <span class="mcp-count-note">
            ${filtered.length} of ${skills.length} shown
          </span>
        </div>
      </div>

      ${skills.length === 0 ? html`
        <div class="gt-empty gt-glass mcp-empty-glass">
          <div class="gt-empty-orb">${icons.book}</div>
          <div class="gt-empty-title">No skills loaded</div>
          <div class="gt-empty-sub">Skills are instruction files that extend agent capabilities.</div>
        </div>
      ` : filtered.length === 0 ? html`
        <div class="gt-empty gt-glass mcp-empty-glass">
          <div class="gt-empty-orb">${icons.search}</div>
          <div class="gt-empty-title">Nothing matches “${mcpState.skillsFilter}”</div>
          <div class="gt-empty-sub">Try a shorter phrase, or search by what the skill does.</div>
        </div>
      ` : html`
        <div class="mcp-servers-grid">
          ${filtered.map((skill, i) => renderSkillCard(state, mcpState, skill, i))}
        </div>
      `}
    </div>
  `;
}

function renderSkillCard(
  state: AppViewState, 
  mcpState: McpManagementState, 
  skill: NonNullable<McpManagementState["skillsReport"]>["skills"][0],
  index = 0,
) {
  const isEligible = skill.eligible;
  const isDisabled = skill.disabled;
  const hasMissing = (skill.missing?.bins?.length ?? 0) > 0 || (skill.missing?.env?.length ?? 0) > 0;
  const light = isDisabled ? "idle" : isEligible ? "ok" : hasMissing ? "warn" : "danger";

  return html`
    <div class="mcp-server-card is-static gt-glass gt-lift gt-rise ${isEligible ? '' : 'disabled'}" style="--gt-i:${Math.min(index, 14)}">
      <div class="mcp-server-header">
        <div class="mcp-server-icon">${isEligible ? icons.checkCircle : isDisabled ? icons.pause : icons.alertCircle}</div>
        <div class="mcp-server-info">
          <div class="mcp-server-name">${skill.name}</div>
          <div class="mcp-server-desc">${skill.description}</div>
        </div>
        <span class="gt-light" data-state=${light} title=${isDisabled ? "Disabled" : isEligible ? "Ready" : "Not eligible"}></span>
      </div>
      
      <div class="mcp-server-meta">
        <span class="gt-chip">${skill.source}</span>
        ${isDisabled ? html`<span class="gt-chip" data-tone="danger">DISABLED</span>` : nothing}
        ${hasMissing ? html`<span class="gt-chip" data-tone="warn">MISSING DEPS</span>` : nothing}
      </div>

      ${hasMissing ? html`
        <div class="mcp-skill-missing">
          ${skill.missing?.bins?.length ? html`<div>Missing bins: <code>${skill.missing.bins.join(", ")}</code></div>` : nothing}
          ${skill.missing?.env?.length ? html`<div>Missing env: <code>${skill.missing.env.join(", ")}</code></div>` : nothing}
        </div>
      ` : nothing}

      ${skill.primaryEnv ? html`
        <div class="mcp-skill-key">
          <input
            class="gt-input"
            type="password"
            aria-label="API Key for ${skill.primaryEnv}"
            placeholder="API Key for ${skill.primaryEnv}"
            .value=${mcpState.skillEdits[skill.skillKey] ?? ""}
            @input=${(e: Event) => {
              mcpState.skillEdits[skill.skillKey] = (e.target as HTMLInputElement).value;
              state.requestUpdate?.();
            }}
          />
        </div>
      ` : nothing}
    </div>
  `;
}

// ── Server Card (Tools Tab) ──────────────────────────────────

function renderServerCard(
  state: AppViewState,
  mcpState: McpManagementState,
  server: McpServerInfo,
  index = 0,
) {
  const isExpanded = mcpState.expandedServers.has(server.name);
  const toolCount = serverToolCount(server);
  const toggle = () => {
    if (isExpanded) mcpState.expandedServers.delete(server.name);
    else mcpState.expandedServers.add(server.name);
    state.requestUpdate?.();
  };

  return html`
    <div class="mcp-server-card gt-glass gt-lift gt-rise ${isExpanded ? "expanded" : ""}"
         style="--gt-i:${Math.min(index, 14)}"
         role="button"
         tabindex="0"
         aria-expanded=${isExpanded ? "true" : "false"}
         @click=${toggle}
         @keydown=${onActivateKey(toggle)}>
      <div class="mcp-server-header">
        <div class="mcp-server-icon">${getServerIcon(server.name)}</div>
        <div class="mcp-server-info">
          <div class="mcp-server-name">${server.name}</div>
          <div class="mcp-server-desc">${server.description || "No description"}</div>
        </div>
        <span class="gt-light" data-state=${server.running ? "ok" : "idle"} ?data-pulse=${server.running}
          title=${server.running ? "Running" : "Idle"}></span>
      </div>
      
      <div class="mcp-server-meta">
        <span class="gt-chip">${server.transport?.toUpperCase() || "STDIO"}</span>
        <span class="gt-chip mcp-chip-count" data-tone="gold">
          ${toolCount} TOOLS
        </span>
        ${server.running ? html`
          <span class="gt-chip" data-tone="ok">● RUNNING</span>
        ` : nothing}
        ${toolCount > 0 ? html`
          <span class="mcp-expand-hint">${isExpanded ? "Hide" : "Tools"} ${icons.chevronDown}</span>
        ` : nothing}
      </div>

      ${isExpanded && server.toolDetails?.length ? html`
        <div class="mcp-server-tools-preview" @click=${(e: Event) => e.stopPropagation()}>
          <div class="mcp-tools-label">AVAILABLE TOOLS · ${server.toolDetails.length}</div>
          <div class="mcp-toolrows">
            ${server.toolDetails.map(tool => html`
              <div class="mcp-toolrow" title="${tool.description}">
                <span class="mcp-toolrow-name">${tool.name}</span>
                ${tool.description ? html`<span class="mcp-toolrow-desc">${tool.description}</span>` : nothing}
              </div>
            `)}
          </div>
        </div>
      ` : nothing}

      ${isExpanded && !server.toolDetails?.length && server.tools?.length ? html`
        <div class="mcp-server-tools-preview" @click=${(e: Event) => e.stopPropagation()}>
          <div class="mcp-tools-label">AVAILABLE TOOLS</div>
          <div class="mcp-tools-list">
            ${server.tools.map(tool => html`
              <span class="mcp-tool-pill">${tool}</span>
            `)}
          </div>
        </div>
      ` : nothing}
    </div>
  `;
}

// ── MCP Status Bar ───────────────────────────────────────────

function renderStatusBar(
  state: AppViewState,
  mcpState: McpManagementState,
  isRunning: boolean,
  enabledCount: number,
) {
  const isBusy = mcpState.actionBusy !== null;

  return html`
    <div class="mcp-status-bar gt-glass gt-rise ${isRunning ? "running" : ""}" data-learn-id="mcp-status">
      <div class="mcp-status-left">
        <div class="mcp-status-orb">
          <span class="gt-light" data-state=${isRunning ? "ok" : "idle"} ?data-pulse=${isRunning}></span>
        </div>
        <div class="mcp-status-indicator">
          <span class="mcp-status-kicker">MCP gateway</span>
          <span class="mcp-status-label ${isRunning ? "active" : ""}">
            ${isRunning ? "Running" : "Stopped"}
          </span>
        </div>
        <div class="mcp-meta">
          ${isRunning ? html`
            <span class="gt-chip">PORT <span class="mcp-meta-value">${mcpState.status?.port || "—"}</span></span>
            <span class="gt-chip">UPTIME <span class="mcp-meta-value">${formatUptime(mcpState.status?.uptime || 0)}</span></span>
          ` : html`
            <span>MCP server is not running</span>
          `}
        </div>
      </div>
      <div class="mcp-actions">
        <span class="mcp-servers-count gt-chip" data-tone="gold">${enabledCount} SERVERS</span>
        ${isRunning ? html`
          <button class="mcp-btn gt-btn" ?disabled=${isBusy} @click=${() => restartMcp(state)}>
            ${mcpState.actionBusy === "restart" ? "…" : html`${icons.refresh} Restart`}
          </button>
          <button class="mcp-btn gt-btn gt-danger danger" ?disabled=${isBusy} @click=${() => stopMcp(state)}>
            ${mcpState.actionBusy === "stop" ? "…" : html`${icons.stop} Stop`}
          </button>
        ` : html`
          <button class="mcp-btn gt-btn gt-primary primary" ?disabled=${isBusy} @click=${() => startMcp(state)}>
            ${mcpState.actionBusy === "start" ? "…" : html`${icons.play} Start`}
          </button>
        `}
        <button
          class="mcp-btn gt-btn"
          ?disabled=${isBusy}
          title="Write/refresh ~/.claude/mcp.json so Claude Code auto-discovers Infinibot"
          data-learn-id="mcp-claude-code"
          @click=${() => registerInClaudeCode(state, { force: true })}
        >
          ${mcpState.actionBusy === "claudeCodeRegister" ? "… CC" : html`${icons.terminal} Claude Code`}
        </button>
        <button
          class="mcp-btn gt-btn"
          ?disabled=${isBusy}
          title="Remove the infinibot entry from ~/.claude/mcp.json"
          aria-label="Remove from Claude Code"
          @click=${() => unregisterFromClaudeCode(state)}
        >
          ${mcpState.actionBusy === "claudeCodeUnregister" ? "…" : html`${icons.x} CC`}
        </button>
        <button class="mcp-btn mcp-icon-btn" ?disabled=${mcpState.loading} title="Refresh" aria-label="Refresh" @click=${() => loadMcpPage(state)}>
          ${mcpState.loading ? "…" : icons.refresh}
        </button>
      </div>
    </div>
  `;
}

// ── Agents Section ───────────────────────────────────────────

function renderAgentsSection(state: AppViewState, mcpState: McpManagementState) {
  if (!mcpState.agents.length) {
    return html`
      <div class="mcp-section">
        <div class="mcp-section-header">
          <span class="mcp-section-title">◇ AGENTS</span>
        </div>
        <div class="mcp-empty">NO AGENTS CONFIGURED</div>
      </div>
    `;
  }

  // Group agents by category
  const grouped = new Map<string, McpAgentInfo[]>();
  for (const agent of mcpState.agents) {
    const cat = agent.category || "Other";
    if (!grouped.has(cat)) grouped.set(cat, []);
    grouped.get(cat)!.push(agent);
  }

  return html`
    <div class="mcp-section">
      <div class="mcp-section-header">
        <span class="mcp-section-title">◇ AGENTS</span>
        <span class="mcp-section-sub">${mcpState.agents.length} configured</span>
      </div>
      ${Array.from(grouped.entries()).map(([category, agents]) => {
        const isCollapsed = mcpState.collapsedAgentCategories.has(category);
        return html`
          <div class="mcp-category">
            <div class="mcp-category-header" @click=${() => {
              if (isCollapsed) mcpState.collapsedAgentCategories.delete(category);
              else mcpState.collapsedAgentCategories.add(category);
              state.requestUpdate?.();
            }}>
              <span class="mcp-category-chevron ${isCollapsed ? "" : "open"}">▸</span>
              <span class="mcp-category-label">${category}</span>
              <span class="mcp-category-count">${agents.length}</span>
            </div>
            ${isCollapsed ? nothing : html`
              <div class="mcp-agents-grid">
                ${agents.map((agent) => renderAgentCard(state, mcpState, agent))}
              </div>
            `}
          </div>
        `;
      })}
    </div>
  `;
}

function renderAgentCard(state: AppViewState, mcpState: McpManagementState, agent: McpAgentInfo) {
  const isExpanded = mcpState.expandedAgents.has(agent.id);
  const toolCount = agent.tools?.allow?.length ?? 0;
  const denyCount = agent.tools?.deny?.length ?? 0;

  return html`
    <div class="mcp-agent-card gt-lift ${isExpanded ? "expanded" : ""} ${agent.isDefault ? "default" : ""}"
         @click=${() => {
           if (isExpanded) mcpState.expandedAgents.delete(agent.id);
           else mcpState.expandedAgents.add(agent.id);
           state.requestUpdate?.();
         }}>
      <div class="mcp-agent-header">
        <div class="mcp-agent-icon">${getAgentIcon(agent.id)}</div>
        <div>
          <div class="mcp-agent-name">${agent.name}</div>
          <div class="mcp-agent-id">${agent.id}</div>
        </div>
      </div>
      <div class="mcp-agent-meta">
        ${agent.model ? html`<span class="mcp-badge">${truncateModel(agent.model)}</span>` : nothing}
        ${agent.thinkingLevel ? html`<span class="mcp-badge thinking">${icons.zap} ${agent.thinkingLevel}</span>` : nothing}
        ${agent.tools?.profile ? html`<span class="mcp-badge">PROFILE: ${agent.tools.profile}</span>` : nothing}
        <span class="mcp-badge mcp-count">
          ${toolCount > 0 ? `${toolCount} TOOLS` : denyCount > 0 ? `${denyCount} DENIED` : "ALL TOOLS"}
          <span class="arrow ${isExpanded ? "open" : ""}">▾</span>
        </span>
      </div>
      <div class="mcp-agent-desc">${agent.description}</div>
      ${isExpanded ? renderAgentExpanded(agent) : nothing}
    </div>
  `;
}

function renderAgentExpanded(agent: McpAgentInfo) {
  const allowTools = agent.tools?.allow ?? [];
  const denyTools = agent.tools?.deny ?? [];
  const subagents = agent.subagents?.allowAgents ?? [];

  return html`
    <div class="mcp-agent-expanded">
      ${allowTools.length > 0 ? html`
        <div class="mcp-tools-label">ALLOWED TOOLS</div>
        <div class="mcp-tools-list">
          ${allowTools.map((t) => html`<span class="mcp-tool-pill">${t}</span>`)}
        </div>
      ` : html`
        <div class="mcp-tools-label">TOOL ACCESS</div>
        <div class="mcp-form-hint" style="margin: 0 0 8px;">All tools available (no allow-list set)</div>
      `}
      ${denyTools.length > 0 ? html`
        <div class="mcp-tools-label" style="margin-top: 10px;">DENIED TOOLS</div>
        <div class="mcp-tools-list">
          ${denyTools.map((t) => html`<span class="mcp-tool-pill is-deny">${t}</span>`)}
        </div>
      ` : nothing}
      ${subagents.length > 0 ? html`
        <div class="mcp-tools-label" style="margin-top: 10px;">SUB-AGENTS</div>
        <div class="mcp-tools-list">
          ${subagents.map((a) => html`<span class="mcp-tool-pill is-agent">${a}</span>`)}
        </div>
      ` : nothing}
      ${agent.workspace ? html`
        <div class="mcp-tools-label" style="margin-top: 10px;">WORKSPACE</div>
        <div class="mcp-detail-value">${agent.workspace}</div>
      ` : nothing}
      ${agent.systemPromptPreview ? html`
        <div class="mcp-tools-label" style="margin-top: 10px;">SYSTEM PROMPT</div>
        <div class="mcp-form-hint" style="font-style: italic;">${agent.systemPromptPreview}</div>
      ` : nothing}
    </div>
  `;
}

// ── Servers Section ──────────────────────────────────────────

function renderServersSection(state: AppViewState, mcpState: McpManagementState) {
  // Group servers by category
  const grouped = new Map<string, McpServerInfo[]>();
  for (const server of mcpState.servers) {
    const cat = server.category || "General";
    if (!grouped.has(cat)) grouped.set(cat, []);
    grouped.get(cat)!.push(server);
  }

  return html`
    <div class="mcp-section">
      <div class="mcp-section-header">
        <span class="mcp-section-title" data-learn-id="mcp-servers-title">${icons.server} MCP servers</span>
        <div class="mcp-section-tools">
          <button class="mcp-btn gt-btn gt-primary primary" @click=${() => {
            mcpState.registry.open = true;
            if (!mcpState.registry.results.length) searchRegistry(state);
            state.requestUpdate?.();
          }}>${icons.zap} Browse registry</button>
          <button class="mcp-btn gt-btn" @click=${() => {
            mcpState.showAddDialog = true;
            state.requestUpdate?.();
          }}>${icons.plus} Add custom</button>
        </div>
      </div>
      ${grouped.size === 0 ? html`
        <div class="gt-empty gt-glass mcp-empty-glass mcp-empty">
          <div class="gt-empty-orb">${icons.server}</div>
          <div class="gt-empty-title">No servers configured</div>
          <div class="gt-empty-sub">Browse the MCP registry or add a custom stdio server to give your agents new tools.</div>
        </div>
      ` : nothing}
      ${Array.from(grouped.entries()).map(([category, servers]) => {
        const isCollapsed = mcpState.collapsedCategories.has(category);
        return html`
          <div class="mcp-category">
            <button class="mcp-category-header" aria-expanded=${isCollapsed ? "false" : "true"} @click=${() => {
              if (isCollapsed) mcpState.collapsedCategories.delete(category);
              else mcpState.collapsedCategories.add(category);
              state.requestUpdate?.();
            }}>
              <span class="mcp-category-chevron ${isCollapsed ? "" : "open"}">${icons.chevronRight}</span>
              <span class="mcp-category-label">${category}</span>
              <span class="mcp-category-rule"></span>
              <span class="mcp-category-count">${servers.length}</span>
            </button>
            ${isCollapsed ? nothing : html`
              <div class="mcp-server-list">
                ${servers.map((server, i) => renderServerRow(state, mcpState, server, i))}
              </div>
            `}
          </div>
        `;
      })}
    </div>
  `;
}

function renderServerRow(state: AppViewState, mcpState: McpManagementState, server: McpServerInfo, index = 0) {
  const toolCount = serverToolCount(server);
  const isExpanded = mcpState.expandedServers.has(server.name);
  const toggle = () => {
    if (isExpanded) mcpState.expandedServers.delete(server.name);
    else mcpState.expandedServers.add(server.name);
    state.requestUpdate?.();
  };
  const light = server.running ? "ok" : server.enabled ? "warn" : "idle";

  return html`
    <div class="mcp-server-item gt-glass gt-rise ${isExpanded ? "expanded" : ""}" style="--gt-i:${Math.min(index, 14)}">
      <div class="mcp-server-row ${isExpanded ? "expanded" : ""}"
        role="button"
        tabindex="0"
        aria-expanded=${isExpanded ? "true" : "false"}
        @click=${toggle}
        @keydown=${onActivateKey(toggle)}>
        <span class="mcp-server-chevron ${isExpanded ? "open" : ""}">${icons.chevronRight}</span>
        <span class="mcp-server-status-dot gt-light ${server.running ? "running" : ""}" data-state=${light} ?data-pulse=${server.running}
          title=${server.running ? "Running" : server.enabled ? "Enabled — not running" : "Disabled"}></span>
        <span class="mcp-server-icon">${getServerIcon(server.name)}</span>
        <div class="mcp-server-info">
          <div class="mcp-server-name">${server.name}</div>
          ${server.description ? html`<div class="mcp-server-desc">${server.description}</div>` : nothing}
        </div>
        ${toolCount > 0 ? html`<span class="mcp-server-tools-count gt-chip" data-tone="gold">${toolCount} TOOLS</span>` : nothing}
        <div class="mcp-server-actions">
          <button class="mcp-insp-trybtn gt-btn" title="Inspect live tools"
            @click=${(e: Event) => { e.stopPropagation(); openInspector(state, server.name); }}>${icons.eye} Inspect</button>
          <label class="mcp-toggle" title=${server.enabled ? "Disable server" : "Enable server"} @click=${(e: Event) => e.stopPropagation()}>
            <input type="checkbox" .checked=${server.enabled}
              aria-label="Enable ${server.name}"
              @change=${(e: Event) => {
                e.stopPropagation();
                const checked = (e.target as HTMLInputElement).checked;
                toggleMcpServer(state, server.name, checked);
              }}
            />
            <div class="mcp-toggle-track"></div>
            <div class="mcp-toggle-thumb"></div>
          </label>
          ${server.custom ? html`
            <button class="mcp-delete-btn mcp-icon-btn" title="Remove server" aria-label="Remove ${server.name}"
              @click=${(e: Event) => { e.stopPropagation(); removeCustomServer(state, server.name); }}>${icons.trash}</button>
          ` : nothing}
        </div>
      </div>
      ${isExpanded ? renderServerDetail(server) : nothing}
    </div>
  `;
}

function renderServerDetail(server: McpServerInfo) {
  const details = server.toolDetails ?? [];
  const hasCommand = !!server.command;

  return html`
    <div class="mcp-server-detail">
      <!-- Connection Info Grid -->
      <div class="mcp-server-detail-grid">
        ${server.url ? html`
          <div class="mcp-detail-item">
            <span class="mcp-detail-label">ENDPOINT</span>
            <span class="mcp-detail-value">${server.url}</span>
          </div>
        ` : nothing}
        ${server.transport ? html`
          <div class="mcp-detail-item">
            <span class="mcp-detail-label">TRANSPORT</span>
            <span class="mcp-detail-value">${server.transport.toUpperCase()}</span>
          </div>
        ` : nothing}
        ${server.docsUrl ? html`
          <div class="mcp-detail-item">
            <span class="mcp-detail-label">DOCUMENTATION</span>
            <span class="mcp-detail-value">
              <a href="${server.docsUrl}" target="_blank" rel="noopener">${server.docsUrl}</a>
            </span>
          </div>
        ` : nothing}
        ${server.category ? html`
          <div class="mcp-detail-item">
            <span class="mcp-detail-label">CATEGORY</span>
            <span class="mcp-detail-value">${server.category}</span>
          </div>
        ` : nothing}
      </div>

      ${hasCommand ? html`
        <div class="mcp-detail-item" style="margin-bottom: 16px;">
          <span class="mcp-detail-label">COMMAND</span>
          <div class="mcp-command-block">${server.command}${server.args?.length ? " " + server.args.join(" ") : ""}</div>
        </div>
      ` : nothing}

      <div class="mcp-detail-divider"></div>

      <!-- Tools Section -->
      <div class="mcp-tools-detail-header">
        <span class="mcp-tools-detail-title">Available tools</span>
        <span class="mcp-tools-detail-count gt-chip" data-tone="gold">${details.length || server.tools?.length || 0} TOOLS</span>
      </div>

      ${details.length > 0 ? html`
        <div class="mcp-tool-detail-list">
          ${details.map((tool) => html`
            <div class="mcp-tool-detail-row">
              <span class="mcp-tool-detail-name">${tool.name}</span>
              <span class="mcp-tool-detail-desc">${tool.description}</span>
            </div>
          `)}
        </div>
      ` : server.tools?.length ? html`
        <div class="mcp-tool-detail-list">
          ${server.tools.map((t) => html`
            <div class="mcp-tool-detail-row">
              <span class="mcp-tool-detail-name">${t}</span>
              <span class="mcp-tool-detail-desc is-muted">No description available</span>
            </div>
          `)}
        </div>
      ` : html`
        <div class="mcp-no-tools">No tools registered for this server</div>
      `}

      ${server.env && Object.keys(server.env).length > 0 ? html`
        <div class="mcp-detail-divider" style="margin-top: 16px;"></div>
        <div class="mcp-detail-item">
          <span class="mcp-detail-label">ENVIRONMENT VARIABLES</span>
          <div class="mcp-command-block">${Object.entries(server.env).map(([k, v]) => `${k}=${v.length > 20 ? v.slice(0, 8) + "••••" + v.slice(-4) : v}`).join("\n")}</div>
        </div>
      ` : nothing}
    </div>
  `;
}

// ── Add Server Dialog ────────────────────────────────────────

// ── Canva Integration ─────────────────────────────────────────

function renderCanvaSection(state: AppViewState, mcpState: McpManagementState) {
  const cv = mcpState.canva;
  const statusLabel =
    cv.status === "connected"
      ? cv.accountEmail
        ? `Connected · ${cv.accountEmail}`
        : "Connected"
      : cv.status === "expired"
      ? "Token expired"
      : "Not connected";

  return html`
    <div class="canva-section">
      <div class="canva-section-label">◇ FEATURED INTEGRATIONS</div>
      <div class="canva-card">
        <div class="canva-card-icon">${icons.palette}</div>
        <div class="canva-card-info">
          <div class="canva-card-name">Canva</div>
          <div class="canva-card-desc">Generate, list, and export Canva designs.</div>
        </div>
        <span class="canva-status-pill ${cv.status}">${statusLabel}</span>
        <div class="canva-card-actions">
          <button class="mcp-btn gt-btn ${cv.status === "connected" ? "" : "gt-primary primary"}"
            @click=${() => {
              cv.showModal = true;
              cv.error = null;
              cv.testResult = null;
              state.requestUpdate?.();
            }}
          >${cv.status === "connected" ? "Manage" : "Connect"}</button>
        </div>
      </div>
    </div>
  `;
}

function renderCanvaModal(state: AppViewState, mcpState: McpManagementState) {
  const cv = mcpState.canva;
  const isConnected = cv.status === "connected" || cv.status === "expired";
  const tokenTooShort = cv.tokenDraft.length > 0 && cv.tokenDraft.trim().length < 20;

  const close = () => {
    cv.showModal = false;
    cv.tokenDraft = "";
    cv.error = null;
    state.requestUpdate?.();
  };

  const handleKeydown = (e: KeyboardEvent) => {
    if (e.key === "Escape") close();
    if (e.key === "Enter" && !isConnected && cv.tokenDraft.trim().length >= 20) {
      saveCanvaToken(state);
    }
  };

  return html`
    <div class="mcp-dialog-overlay"
      @click=${(e: Event) => { if (e.target === e.currentTarget) close(); }}
      @keydown=${handleKeydown}
    >
      <div class="mcp-dialog gt-sheet-panel" style="width:520px;" role="dialog" aria-modal="true" aria-label="Canva MCP settings">

        <!-- Header -->
        <div class="canva-modal-header">
          <div class="canva-card-icon">${icons.palette}</div>
          <div class="mcp-sheet-titles">
            <div class="canva-modal-title">Canva MCP</div>
            <div class="canva-modal-subtitle">Connect your Canva workspace to InfiniBot</div>
          </div>
          <button class="mcp-delete-btn mcp-icon-btn mcp-sheet-close" @click=${close} aria-label="Close">${icons.x}</button>
        </div>

        <!-- Not-yet-installed notice (graceful fallback) -->
        ${!mcpState.servers.some(s => s.name === "canva") ? html`
          <div class="canva-not-installed">
            ⚠ Canva MCP not yet installed — restart the gateway after install completes.
            You can still save your token now; it will activate automatically.
          </div>
        ` : nothing}

        <!-- Error banner -->
        ${cv.error ? html`
          <div class="mcp-error" style="margin-bottom:12px;">
            <span>⚠ ${cv.error}</span>
            <button class="mcp-error-dismiss" @click=${() => { cv.error = null; state.requestUpdate?.(); }}>✕</button>
          </div>
        ` : nothing}

        <!-- Connected account info -->
        ${isConnected ? html`
          <div class="canva-connected-info">
            <div class="canva-connected-email">
              ${cv.accountDisplayName
                ? `✓ ${cv.accountDisplayName}${cv.accountEmail ? ` · ${cv.accountEmail}` : ""}`
                : cv.accountEmail ? `✓ ${cv.accountEmail}` : "✓ Token saved"}
            </div>
            <div class="canva-connected-status">
              ${cv.status === "expired" ? "⚠ Token may be expired — run a test to verify" : "Active credential"}
            </div>
          </div>
        ` : nothing}

        <!-- Test result -->
        ${cv.testResult ? html`
          <div class="canva-test-result ${cv.testResult.valid ? "success" : "failure"}">
            ${cv.testResult.valid
              ? `✓ Connection verified${cv.testResult.designCount != null ? ` · ${cv.testResult.designCount} designs found` : ""}`
              : `✗ ${cv.testResult.message}`
            }
          </div>
        ` : nothing}

        <!-- OAuth sign-in (shown when disconnected or expired) -->
        ${!isConnected || cv.status === "expired" ? html`
          <div class="mcp-form-group">
            <div class="mcp-form-label">SIGN IN WITH CANVA (OAuth)</div>
            <button
              class="mcp-btn gt-btn gt-primary primary"
              style="width:100%;height:44px;"
              ?disabled=${cv.oauthPending}
              @click=${() => startCanvaOAuth(state)}
            >
              ${cv.oauthPending ? "Waiting for authorization…" : "Sign in with Canva"}
            </button>
            <div class="mcp-form-hint">Opens a Canva sign-in popup. Requires <code>CANVA_OAUTH_CLIENT_ID</code> in your <code>.env</code>.</div>
          </div>
          <div class="canva-or-divider">— or paste a personal access token —</div>
        ` : nothing}

        <!-- Token input (manual PAT fallback) -->
        <div class="mcp-form-group">
          <label class="mcp-form-label" for="canva-token-input">
            ${isConnected ? "ROTATE PERSONAL ACCESS TOKEN" : "PERSONAL ACCESS TOKEN (MANUAL)"}
          </label>
          <div class="canva-token-row">
            <input
              id="canva-token-input"
              class="mcp-form-input"
              type="${cv.showToken ? "text" : "password"}"
              placeholder="Paste your Canva personal access token…"
              autocomplete="off"
              .value=${cv.tokenDraft}
              @input=${(e: Event) => { cv.tokenDraft = (e.target as HTMLInputElement).value; state.requestUpdate?.(); }}
              @keydown=${(e: KeyboardEvent) => {
                if (e.key === "Enter" && cv.tokenDraft.trim().length >= 20) saveCanvaToken(state);
                if (e.key === "Escape") close();
              }}
            />
            <button class="mcp-btn gt-btn" title="${cv.showToken ? "Hide token" : "Show token"}"
              @click=${() => { cv.showToken = !cv.showToken; state.requestUpdate?.(); }}>
              ${cv.showToken ? "Hide" : "Show"}
            </button>
            ${cv.tokenDraft ? html`
              <button class="mcp-btn gt-btn" title="Clear"
                @click=${() => { cv.tokenDraft = ""; state.requestUpdate?.(); }}>✕</button>
            ` : nothing}
          </div>
          ${tokenTooShort ? html`<div class="canva-token-warning">⚠ Token looks too short — Canva PATs are typically 64+ characters.</div>` : nothing}
          ${!cv.tokenDraft && !isConnected ? html`<div class="mcp-form-hint">Create a token at Canva → Settings → Canva for Developers → Personal access tokens.</div>` : nothing}
          <a class="canva-help-link" href="https://www.canva.com/developers/docs/connect/authentication/" target="_blank" rel="noopener">
            ↗ Canva developer docs
          </a>
        </div>

        <!-- Actions -->
        <div class="mcp-dialog-actions">
          ${isConnected ? html`
            <button class="mcp-btn gt-btn gt-danger danger"
              ?disabled=${cv.disconnecting}
              @click=${() => disconnectCanva(state)}>
              ${cv.disconnecting ? "Disconnecting…" : "Disconnect"}
            </button>
            <button class="mcp-btn gt-btn"
              ?disabled=${cv.testing}
              @click=${() => testCanvaConnection(state)}>
              ${cv.testing ? "Testing…" : "Test connection"}
            </button>
          ` : nothing}
          ${cv.tokenDraft.trim().length >= 20 ? html`
            <button class="mcp-btn gt-btn gt-primary primary"
              ?disabled=${cv.saving}
              @click=${() => saveCanvaToken(state)}>
              ${cv.saving ? "Saving…" : isConnected ? "Update token" : "Save token"}
            </button>
          ` : nothing}
          <button class="mcp-btn gt-btn" @click=${close}>Close</button>
        </div>
      </div>
    </div>
  `;
}

function renderFeaturedIntegrations(state: AppViewState, mcpState: McpManagementState) {
  return html`
    <div>
      ${renderCanvaSection(state, mcpState)}
      ${renderSupabaseSection(state, mcpState)}
    </div>
  `;
}

function renderSupabaseSection(state: AppViewState, mcpState: McpManagementState) {
  const sb = mcpState.supabase;
  const statusLabel =
    sb.status === "connected"
      ? sb.projectName
        ? `Connected · ${sb.projectName}`
        : sb.projectRef
        ? `Connected · ${sb.projectRef}`
        : "Connected"
      : "Not connected";

  return html`
    <div class="supabase-card">
      <div class="supabase-card-icon">${icons.database}</div>
      <div class="canva-card-info">
        <div class="canva-card-name">Supabase</div>
        <div class="canva-card-desc">List tables, run SQL, apply migrations, fetch logs.</div>
      </div>
      <span class="supabase-status-pill ${sb.status}">${statusLabel}</span>
      <div class="canva-card-actions">
        <button class="mcp-btn gt-btn ${sb.status === "connected" ? "" : "gt-primary primary"}"
          @click=${() => {
            sb.showModal = true;
            sb.error = null;
            sb.testResult = null;
            state.requestUpdate?.();
          }}
        >${sb.status === "connected" ? "Manage" : "Connect"}</button>
      </div>
    </div>
  `;
}

function renderSupabaseModal(state: AppViewState, mcpState: McpManagementState) {
  const sb = mcpState.supabase;
  const isConnected = sb.status === "connected";
  const patTooShort = sb.patDraft.length > 0 && sb.patDraft.trim().length < 20;

  const close = () => {
    sb.showModal = false;
    sb.patDraft = "";
    sb.error = null;
    state.requestUpdate?.();
  };

  const handleKeydown = (e: KeyboardEvent) => {
    if (e.key === "Escape") close();
    if (e.key === "Enter" && sb.patDraft.trim().length >= 20) saveSupabaseConfig(state);
  };

  return html`
    <div class="mcp-dialog-overlay"
      @click=${(e: Event) => { if (e.target === e.currentTarget) close(); }}
      @keydown=${handleKeydown}
    >
      <div class="mcp-dialog gt-sheet-panel" style="width:520px;" role="dialog" aria-modal="true" aria-label="Supabase MCP settings">

        <!-- Header -->
        <div class="supabase-modal-header">
          <div class="supabase-card-icon">${icons.database}</div>
          <div class="mcp-sheet-titles">
            <div class="supabase-modal-title">Supabase MCP</div>
            <div class="supabase-modal-subtitle">Connect your Supabase projects to InfiniBot</div>
          </div>
          <button class="mcp-delete-btn mcp-icon-btn mcp-sheet-close" @click=${close} aria-label="Close">${icons.x}</button>
        </div>

        <!-- Not-yet-registered notice -->
        ${!mcpState.servers.some(s => s.name === "supabase") && !isConnected ? html`
          <div class="canva-not-installed">
            ⚠ Supabase MCP will be registered on save. Restart the gateway to activate it.
          </div>
        ` : nothing}

        <!-- Error banner -->
        ${sb.error ? html`
          <div class="mcp-error" style="margin-bottom:12px;">
            <span>⚠ ${sb.error}</span>
            <button class="mcp-error-dismiss" @click=${() => { sb.error = null; state.requestUpdate?.(); }}>✕</button>
          </div>
        ` : nothing}

        <!-- Connected info -->
        ${isConnected ? html`
          <div class="supabase-connected-info">
            <div class="supabase-connected-pat">✓ ${sb.maskedPat ?? "Token saved"}</div>
            <div class="supabase-connected-meta">
              ${sb.projectRef ? `Project: ${sb.projectRef}` : "All projects accessible"}
              ${sb.readOnly ? " · read-only" : ""}
            </div>
          </div>
        ` : nothing}

        <!-- Test result -->
        ${sb.testResult ? html`
          <div class="supabase-test-result ${sb.testResult.valid ? "success" : "failure"}">
            ${sb.testResult.valid
              ? `✓ ${sb.testResult.message}${sb.testResult.projectName ? ` · active: ${sb.testResult.projectName}` : ""}`
              : `✗ ${sb.testResult.message}`
            }
          </div>
        ` : nothing}

        <!-- PAT input -->
        <div class="mcp-form-group">
          <label class="mcp-form-label" for="supabase-pat-input">
            ${isConnected ? "ROTATE PERSONAL ACCESS TOKEN" : "PERSONAL ACCESS TOKEN"}
          </label>
          <div class="supabase-pat-row">
            <input
              id="supabase-pat-input"
              class="mcp-form-input"
              type="${sb.showPat ? "text" : "password"}"
              placeholder="sbp_xxxx…"
              autocomplete="off"
              .value=${sb.patDraft}
              @input=${(e: Event) => { sb.patDraft = (e.target as HTMLInputElement).value; state.requestUpdate?.(); }}
              @keydown=${(e: KeyboardEvent) => {
                if (e.key === "Enter" && sb.patDraft.trim().length >= 20) saveSupabaseConfig(state);
                if (e.key === "Escape") close();
              }}
            />
            <button class="mcp-btn gt-btn" title="${sb.showPat ? "Hide" : "Show"}"
              @click=${() => { sb.showPat = !sb.showPat; state.requestUpdate?.(); }}>
              ${sb.showPat ? "Hide" : "Show"}
            </button>
            ${sb.patDraft ? html`
              <button class="mcp-btn gt-btn" title="Clear"
                @click=${() => { sb.patDraft = ""; state.requestUpdate?.(); }}>✕</button>
            ` : nothing}
          </div>
          ${patTooShort ? html`<div class="canva-token-warning">⚠ Token looks too short.</div>` : nothing}
          <a class="supabase-help-link" href="https://supabase.com/dashboard/account/tokens" target="_blank" rel="noopener">
            ↗ Get a token at supabase.com/dashboard/account/tokens
          </a>
        </div>

        <!-- Project ref (optional) -->
        <div class="mcp-form-group">
          <label class="mcp-form-label" for="supabase-ref-input">PROJECT REF (OPTIONAL — scopes MCP to one project)</label>
          <input
            id="supabase-ref-input"
            class="mcp-form-input"
            type="text"
            placeholder="abcdefghijklmnop"
            autocomplete="off"
            .value=${sb.projectRefDraft}
            @input=${(e: Event) => { sb.projectRefDraft = (e.target as HTMLInputElement).value; state.requestUpdate?.(); }}
          />
          <div class="mcp-form-hint">Found in your project URL: supabase.com/dashboard/project/<strong>&lt;ref&gt;</strong></div>
        </div>

        <!-- Read-only toggle -->
        <div class="mcp-form-group">
          <div class="mcp-form-label">READ-ONLY MODE</div>
          <div class="supabase-readonly-row">
            <div class="supabase-readonly-toggle ${sb.readOnly ? "on" : ""}"
              role="switch" aria-checked="${sb.readOnly}"
              @click=${() => { sb.readOnly = !sb.readOnly; state.requestUpdate?.(); }}>
            </div>
            <span class="supabase-readonly-label">
              ${sb.readOnly ? "Enabled — only SELECT queries allowed" : "Disabled — full read/write access"}
            </span>
          </div>
        </div>

        <!-- Actions -->
        <div class="mcp-dialog-actions">
          ${isConnected ? html`
            <button class="mcp-btn gt-btn gt-danger danger"
              ?disabled=${sb.disconnecting}
              @click=${() => disconnectSupabase(state)}>
              ${sb.disconnecting ? "Disconnecting…" : "Disconnect"}
            </button>
            <button class="mcp-btn gt-btn"
              ?disabled=${sb.testing}
              @click=${() => testSupabaseConnection(state)}>
              ${sb.testing ? "Testing…" : "Test connection"}
            </button>
          ` : nothing}
          ${sb.patDraft.trim().length >= 20 ? html`
            <button class="mcp-btn gt-btn gt-primary primary"
              ?disabled=${sb.saving}
              @click=${() => saveSupabaseConfig(state)}>
              ${sb.saving ? "Saving…" : isConnected ? "Update" : "Save & connect"}
            </button>
          ` : nothing}
          <button class="mcp-btn gt-btn" @click=${close}>Close</button>
        </div>
      </div>
    </div>
  `;
}

function renderAddDialog(state: AppViewState, mcpState: McpManagementState) {
  const form = mcpState.newServer;
  const close = () => {
    mcpState.showAddDialog = false;
    state.requestUpdate?.();
  };

  return html`
    <div class="mcp-dialog-overlay" @click=${(e: Event) => {
      if (e.target === e.currentTarget) {
        close();
      }
    }} @keydown=${(e: KeyboardEvent) => { if (e.key === "Escape") close(); }}>
      <div class="mcp-dialog gt-sheet-panel" role="dialog" aria-modal="true" aria-labelledby="mcp-add-title">
        <div class="mcp-sheet-head">
          <div class="mcp-sheet-orb">${icons.plug}</div>
          <div class="mcp-sheet-titles">
            <div class="mcp-dialog-title" id="mcp-add-title">Add custom MCP server</div>
            <div class="mcp-sheet-sub">Register any stdio Model Context Protocol server and expose its tools to InfiniBot.</div>
          </div>
          <button class="mcp-delete-btn mcp-icon-btn mcp-sheet-close" @click=${close} aria-label="Close">${icons.x}</button>
        </div>

        <div class="mcp-form-group">
          <label class="mcp-form-label" for="mcp-add-name">SERVER NAME</label>
          <input id="mcp-add-name" class="mcp-form-input is-code" type="text" placeholder="my-server" autocomplete="off"
            .value=${form.name}
            @input=${(e: Event) => { form.name = (e.target as HTMLInputElement).value; state.requestUpdate?.(); }}
          />
        </div>

        <div class="mcp-form-group">
          <label class="mcp-form-label" for="mcp-add-desc">DESCRIPTION</label>
          <input id="mcp-add-desc" class="mcp-form-input" type="text" placeholder="What does this server do?"
            .value=${form.description}
            @input=${(e: Event) => { form.description = (e.target as HTMLInputElement).value; state.requestUpdate?.(); }}
          />
        </div>

        <div class="mcp-form-group">
          <label class="mcp-form-label" for="mcp-add-cmd">COMMAND</label>
          <input id="mcp-add-cmd" class="mcp-form-input is-code" type="text" placeholder="npx -y @modelcontextprotocol/server-name" autocomplete="off" spellcheck="false"
            .value=${form.command}
            @input=${(e: Event) => { form.command = (e.target as HTMLInputElement).value; state.requestUpdate?.(); }}
          />
        </div>

        <div class="mcp-form-group">
          <label class="mcp-form-label" for="mcp-add-args">ARGUMENTS</label>
          <input id="mcp-add-args" class="mcp-form-input is-code" type="text" placeholder="arg1 arg2 arg3 (space-separated)" autocomplete="off" spellcheck="false"
            .value=${form.args}
            @input=${(e: Event) => { form.args = (e.target as HTMLInputElement).value; state.requestUpdate?.(); }}
          />
          <div class="mcp-form-hint">Space-separated list of arguments</div>
        </div>

        <div class="mcp-form-group">
          <label class="mcp-form-label" for="mcp-add-env">ENVIRONMENT VARIABLES</label>
          <textarea id="mcp-add-env" class="mcp-form-input" placeholder='{"API_KEY": "xxx"} or KEY=value per line' spellcheck="false"
            .value=${form.env}
            @input=${(e: Event) => { form.env = (e.target as HTMLTextAreaElement).value; state.requestUpdate?.(); }}
          ></textarea>
          <div class="mcp-form-hint">JSON object or KEY=VALUE per line</div>
        </div>

        <div class="mcp-dialog-actions">
          <button class="mcp-btn gt-btn" @click=${close}>
            Cancel
          </button>
          <button class="mcp-btn gt-btn gt-primary primary"
            ?disabled=${!form.name.trim() || !form.command.trim()}
            @click=${() => addCustomServer(state)}>
            ${icons.plus} Add server
          </button>
        </div>
      </div>
    </div>
  `;
}

// ── Discovery Surface (featured grid + search + pills) ───────

interface FeaturedStatus { cls: string; label: string; }

function featuredStatus(mcpState: McpManagementState, fm: FeaturedMcp): FeaturedStatus {
  const reg = mcpState.registry;
  if (reg.installBusy && reg.installTarget?.id === fm.id) return { cls: "installing", label: "Installing…" };

  if (fm.customFlow === "canva") {
    if (mcpState.canva.status === "connected") return { cls: "connected", label: "Connected" };
    if (mcpState.canva.status === "expired") return { cls: "error", label: "Expired" };
    return { cls: "notinstalled", label: "Not installed" };
  }
  if (fm.customFlow === "supabase") {
    return mcpState.supabase.status === "connected"
      ? { cls: "connected", label: "Connected" }
      : { cls: "notinstalled", label: "Not installed" };
  }

  const server = mcpState.servers.find((s) => s.name === fm.id);
  if (!server) return { cls: "notinstalled", label: "Not installed" };
  if (server.running) return { cls: "connected", label: "Connected" };
  return { cls: "installed", label: "Installed" };
}

function runFeaturedPrimary(state: AppViewState, mcpState: McpManagementState, fm: FeaturedMcp): void {
  if (fm.customFlow === "canva") {
    mcpState.canva.showModal = true;
    mcpState.canva.error = null;
    mcpState.canva.testResult = null;
    state.requestUpdate?.();
    return;
  }
  if (fm.customFlow === "supabase") {
    mcpState.supabase.showModal = true;
    mcpState.supabase.error = null;
    mcpState.supabase.testResult = null;
    state.requestUpdate?.();
    return;
  }
  const status = featuredStatus(mcpState, fm);
  if (status.cls === "connected" || status.cls === "installed") {
    openInspector(state, fm.id);
  } else {
    openInstall(state, fm);
  }
}

function primaryLabel(status: FeaturedStatus, fm: FeaturedMcp): string {
  if (status.cls === "installing") return "…";
  if (fm.customFlow) return status.cls === "connected" ? "Manage" : "Connect";
  if (status.cls === "connected" || status.cls === "installed") return "Inspect";
  return "Install";
}

// ── Quick Install ────────────────────────────────────────────

interface QuickClientMeta {
  id: QuickClient;
  label: string;
  lang: string;
}

const QUICK_CLIENTS: QuickClientMeta[] = [
  { id: "claude-code", label: "Claude Code", lang: "bash" },
  { id: "claude-desktop", label: "Claude Desktop", lang: "json" },
  { id: "cursor", label: "Cursor", lang: "json" },
  { id: "windsurf", label: "Windsurf", lang: "json" },
  { id: "cline", label: "Cline", lang: "json" },
  { id: "continue", label: "Continue", lang: "yaml" },
  { id: "codex", label: "Codex CLI", lang: "toml" },
  { id: "grok", label: "Grok Build", lang: "toml" },
  { id: "opencode", label: "OpenCode", lang: "json" },
  { id: "generic-json", label: "Generic JSON (stdio)", lang: "json" },
  { id: "generic-http", label: "Generic HTTP", lang: "bash" },
];

const QUICK_SCOPES: QuickScope[] = ["local", "lan", "tailscale"];
const QUICK_OSES: { id: QuickOS; label: string }[] = [
  { id: "macos", label: "macOS" },
  { id: "linux", label: "Linux" },
  { id: "windows", label: "Windows" },
];

function quickHost(info: QuickConnectInfo, scope: QuickScope): string {
  if (scope === "lan") return info.hosts.lan ?? "<LAN_IP>";
  if (scope === "tailscale") return info.hosts.tailscale ?? "<TAILSCALE_HOST>";
  return info.hosts.local;
}

function quickWsUrl(info: QuickConnectInfo, scope: QuickScope): string {
  return `ws://${quickHost(info, scope)}:${info.gatewayPort}`;
}

/** Placeholder until the user reveals the real key — never leak it pre-reveal. */
function quickSecret(qi: QuickInstallState): string {
  if (!qi.info?.auth.required) return "";
  return qi.revealKey && qi.keyValue ? qi.keyValue : "<YOUR_GATEWAY_KEY>";
}

function quickEnv(info: QuickConnectInfo, scope: QuickScope, secret: string): Record<string, string> {
  const env: Record<string, string> = { [info.stdio.urlEnv]: quickWsUrl(info, scope) };
  if (info.auth.required) {
    const key = info.auth.mode === "password" ? info.stdio.passwordEnv : info.stdio.tokenEnv;
    env[key] = secret;
  }
  return env;
}

/** Build the ready-to-paste snippet for the selected (scope, client) pair. */
function quickSnippet(info: QuickConnectInfo, qi: QuickInstallState): string {
  const { scope, client } = qi;
  const secret = quickSecret(qi);
  const env = quickEnv(info, scope, secret);
  const cmd = info.stdio.command || "node";
  const entry = info.stdio.entry || "<infinibot>/dist/cli/mcp-stdio.js";

  switch (client) {
    case "claude-code": {
      const flags = Object.entries(env)
        .map(([k, v]) => `  --env ${k}=${v} \\`)
        .join("\n");
      return `claude mcp add infinibot \\\n${flags}\n  -- ${cmd} ${entry}`;
    }
    case "claude-desktop":
    case "cursor":
    case "windsurf":
    case "cline":
    case "generic-json":
      return JSON.stringify({ mcpServers: { infinibot: { command: cmd, args: [entry], env } } }, null, 2);
    case "continue": {
      const envLines = Object.entries(env)
        .map(([k, v]) => `        ${k}: ${v}`)
        .join("\n");
      return `mcpServers:\n  - name: infinibot\n    command: ${cmd}\n    args:\n      - ${entry}\n    env:\n${envLines}`;
    }
    case "codex": {
      const envInline = Object.entries(env)
        .map(([k, v]) => `${k} = "${v}"`)
        .join(", ");
      return `[mcp_servers.infinibot]\ncommand = "${cmd}"\nargs = ["${entry}"]\nenv = { ${envInline} }`;
    }
    case "grok": {
      const envInline = Object.entries(env)
        .map(([k, v]) => `${k} = "${v}"`)
        .join(", ");
      return `[mcp_servers.infinibot]\ncommand = "${cmd}"\nargs = ["${entry}"]\nenv = { ${envInline} }`;
    }
    case "opencode":
      return JSON.stringify(
        {
          $schema: "https://opencode.ai/config.json",
          mcp: { infinibot: { type: "local", command: [cmd, entry], environment: env, enabled: true } },
        },
        null,
        2,
      );
    case "generic-http": {
      const port = info.httpBridgePort;
      if (!port) {
        return `# The HTTP REST bridge is disabled on this gateway.\n# Use the stdio bridge (pick another client) — it is the supported transport.`;
      }
      const base = `http://${quickHost(info, scope)}:${port}/mcp`;
      const authHeader = info.auth.required ? ` \\\n  -H "Authorization: Bearer ${secret}"` : "";
      return `# InfiniBot exposes a REST compatibility bridge (not a spec MCP transport).\ncurl ${base}/tools${authHeader}`;
    }
  }
  return "";
}

function quickConfigPath(client: QuickClient, os: QuickOS): string {
  switch (client) {
    case "claude-code":
      return "Runs `claude mcp add` → writes ~/.claude.json";
    case "claude-desktop":
      return os === "macos"
        ? "~/Library/Application Support/Claude/claude_desktop_config.json"
        : os === "windows"
          ? "%APPDATA%\\Claude\\claude_desktop_config.json"
          : "~/.config/Claude/claude_desktop_config.json";
    case "cursor":
      return os === "windows"
        ? "%USERPROFILE%\\.cursor\\mcp.json  (or .cursor\\mcp.json per-project)"
        : "~/.cursor/mcp.json  (or .cursor/mcp.json per-project)";
    case "windsurf":
      return os === "windows"
        ? "%USERPROFILE%\\.codeium\\windsurf\\mcp_config.json"
        : "~/.codeium/windsurf/mcp_config.json";
    case "cline":
      return os === "macos"
        ? "~/Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json"
        : os === "windows"
          ? "%APPDATA%\\Code\\User\\globalStorage\\saoudrizwan.claude-dev\\settings\\cline_mcp_settings.json"
          : "~/.config/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json";
    case "continue":
      return os === "windows" ? "%USERPROFILE%\\.continue\\config.yaml" : "~/.continue/config.yaml";
    case "codex":
      return os === "windows" ? "%USERPROFILE%\\.codex\\config.toml" : "~/.codex/config.toml";
    case "grok":
      return os === "windows" ? "%USERPROFILE%\\.grok\\config.toml" : "~/.grok/config.toml";
    case "opencode":
      return os === "windows"
        ? "%USERPROFILE%\\.config\\opencode\\opencode.json  (or opencode.json per-project)"
        : "~/.config/opencode/opencode.json  (or opencode.json per-project)";
    case "generic-json":
      return "Your client's MCP config (an mcpServers object)";
    case "generic-http":
      return "HTTP REST bridge — no file; point your client at the endpoint URL";
  }
  return "";
}

function quickExplain(client: QuickClient): string {
  switch (client) {
    case "claude-code":
      return "Registers InfiniBot as an MCP server in Claude Code — its tools appear next time you run `claude`.";
    case "claude-desktop":
      return "Adds InfiniBot to Claude Desktop. Restart Claude Desktop to load the tools.";
    case "cursor":
      return "Adds InfiniBot to Cursor's MCP servers — tools show under Settings → MCP.";
    case "windsurf":
      return "Adds InfiniBot to Windsurf's Cascade MCP servers.";
    case "cline":
      return "Adds InfiniBot to Cline's MCP settings inside VS Code.";
    case "continue":
      return "Adds InfiniBot to Continue's config — its tools become available in chat.";
    case "codex":
      return "Registers InfiniBot under [mcp_servers] for the Codex CLI.";
    case "grok":
      return "Registers InfiniBot under [mcp_servers] for xAI's Grok Build CLI (grok_coder runs).";
    case "opencode":
      return "Adds InfiniBot as a local MCP server for OpenCode.";
    case "generic-json":
      return "Standard stdio MCP entry — works with any client that reads an mcpServers object.";
    case "generic-http":
      return "For clients that only speak HTTP. InfiniBot's bridge is REST-style, not a full MCP transport — prefer stdio when possible.";
  }
  return "";
}

function reachLabel(r: QuickReach): string {
  return t(`mcp.qi.reach.${r}`, undefined, r);
}

function renderQuickInstall(state: AppViewState, mcpState: McpManagementState) {
  const qi = mcpState.quickInstall;

  return html`
    <div class="qi-section gt-glass gt-rise" style="--gt-i:1" data-learn-id="mcp-quick-install">
      <button class="qi-head" data-learn-id="mcp-quick-install-toggle" @click=${() => toggleQuickInstall(state)} aria-expanded=${qi.expanded}>
        <span class="qi-head-icon">${icons.zap}</span>
        <span class="qi-head-text">
          <span class="qi-head-title">${t("mcp.qi.title", undefined, "Quick Install — connect external agents to this InfiniBot")}</span>
          <span class="qi-head-sub">${t("mcp.qi.subtitle", undefined, "Point any CLI or MCP client at this gateway in seconds.")}</span>
        </span>
        <span class="qi-head-chevron ${qi.expanded ? "open" : ""}">${icons.chevronDown}</span>
      </button>

      ${qi.expanded ? renderQuickBody(state, mcpState) : nothing}
    </div>
  `;
}

function renderQuickBody(state: AppViewState, mcpState: McpManagementState) {
  const qi = mcpState.quickInstall;

  if (qi.loading && !qi.info) {
    return html`<div class="qi-body"><div class="qi-loading"><span class="mcp-loading-dot">◆</span> Detecting connection info…</div></div>`;
  }
  if (qi.error && !qi.info) {
    return html`
      <div class="qi-body">
        <div class="mcp-error">
          <span>⚠ ${qi.error}</span>
          <button class="mcp-btn gt-btn" @click=${() => loadQuickInstallInfo(state)}>${t("mcp.qi.refresh", undefined, "Refresh")}</button>
        </div>
      </div>
    `;
  }

  const info = qi.info;
  if (!info) return nothing;

  return html`
    <div class="qi-body">
      ${qi.error ? html`<div class="mcp-error"><span>⚠ ${qi.error}</span><button class="mcp-error-dismiss" @click=${() => { qi.error = null; state.requestUpdate?.(); }}>✕</button></div>` : nothing}

      ${renderQuickKey(state, qi, info)}
      ${renderQuickScopes(state, qi, info)}
      ${renderQuickPickers(state, qi)}
      ${renderQuickSnippet(state, qi, info)}
      ${qi.showHelp ? renderQuickHelp() : nothing}
    </div>
  `;
}

function renderQuickKey(state: AppViewState, qi: QuickInstallState, info: QuickConnectInfo) {
  if (!info.auth.required) {
    return html`<div class="qi-noauth">${icons.lock} ${t("mcp.qi.noAuth", undefined, "No auth required — this gateway is bound to loopback and accepts local connections without a key.")}</div>`;
  }

  const shown = qi.revealKey && qi.keyValue ? qi.keyValue : "••••••••••••••••";
  return html`
    <div class="qi-key-row">
      <span class="qi-key-label">${icons.key} ${t("mcp.qi.apiKey", undefined, "Gateway API key")}</span>
      <code class="qi-key-value">${shown}</code>
      <button class="mcp-btn gt-btn" @click=${() => revealGatewayKey(state)}>
        ${qi.revealKey ? t("mcp.qi.hide", undefined, "Hide key") : t("mcp.qi.reveal", undefined, "Reveal key")}
      </button>
      ${qi.revealKey && qi.keyValue
        ? html`<button class="mcp-btn gt-btn" @click=${() => copyQuickSnippet(state, "key", qi.keyValue ?? "")}>${qi.copied === "key" ? t("mcp.qi.copied", undefined, "Copied!") : t("mcp.qi.copy", undefined, "Copy")}</button>`
        : nothing}
      <button class="mcp-btn gt-btn gt-danger danger" ?disabled=${qi.rotating} @click=${() => {
        if (confirm(t("mcp.qi.rotateConfirm", undefined, "Rotate the gateway key now? This restarts the gateway and disconnects every currently-connected client until they're re-added with the new key."))) {
          void rotateGatewayKey(state);
        }
      }}>${qi.rotating ? "…" : t("mcp.qi.rotate", undefined, "Rotate key")}</button>
    </div>
  `;
}

function renderQuickScopes(state: AppViewState, qi: QuickInstallState, info: QuickConnectInfo) {
  const scope = qi.scope;
  return html`
    <div class="qi-scopes" data-learn-id="mcp-quick-scopes">
      ${QUICK_SCOPES.map((s) => {
        const r = info.reach[s];
        return html`
          <button class="qi-scope ${scope === s ? "active" : ""}" aria-pressed=${scope === s ? "true" : "false"} @click=${() => setQuickScope(state, s)}>
            <span class="qi-dot ${r}" title=${reachLabel(r)}></span>
            <span class="qi-scope-name">${t(`mcp.qi.scope.${s}`, undefined, s)}</span>
          </button>
        `;
      })}
      <button class="qi-why" @click=${() => toggleQuickHelp(state)}>${t("mcp.qi.whyScopes", undefined, "Why these scopes?")}</button>
      <button class="mcp-btn gt-btn qi-refresh" @click=${() => loadQuickInstallInfo(state)} title=${t("mcp.qi.refresh", undefined, "Refresh")} aria-label=${t("mcp.qi.refresh", undefined, "Refresh")}>${icons.refresh}</button>
    </div>
    <div class="qi-scope-hint">${t(`mcp.qi.scope.${scope}.hint`, undefined, "")}</div>
    ${scope === "lan"
      ? html`<div class="qi-warn">⚠ ${t("mcp.qi.lanWarning", undefined, "Exposes the gateway on your local network. Enable an API key so only trusted clients can connect.")}</div>`
      : nothing}
    ${scope === "tailscale" && !info.tailscale.hostname
      ? html`<div class="qi-warn">⚠ ${t("mcp.qi.tailscaleMissing", undefined, "Tailscale not detected. Install Tailscale and run tailscale up, then refresh.")} <a href="https://tailscale.com/download" target="_blank" rel="noopener">tailscale.com/download</a></div>`
      : nothing}
  `;
}

function renderQuickPickers(state: AppViewState, qi: QuickInstallState) {
  return html`
    <div class="qi-pickers" data-learn-id="mcp-quick-clients">
      <div class="qi-picker-group">
        <span class="qi-picker-label">${t("mcp.qi.client", undefined, "Client")}</span>
        <div class="qi-client-pills">
          ${QUICK_CLIENTS.map((c) => html`
            <button class="qi-pill ${qi.client === c.id ? "active" : ""}" @click=${() => setQuickClient(state, c.id)}>${c.label}</button>
          `)}
        </div>
      </div>
      <div class="qi-picker-group">
        <span class="qi-picker-label">${t("mcp.qi.os", undefined, "OS")}</span>
        <div class="qi-os-pills">
          ${QUICK_OSES.map((o) => html`
            <button class="qi-pill ${qi.os === o.id ? "active" : ""}" @click=${() => setQuickOS(state, o.id)}>${o.label}</button>
          `)}
        </div>
      </div>
    </div>
  `;
}

function renderQuickSnippet(state: AppViewState, qi: QuickInstallState, info: QuickConnectInfo) {
  const snippet = quickSnippet(info, qi);
  const endpoint = quickWsUrl(info, qi.scope);
  const path = quickConfigPath(qi.client, qi.os);

  return html`
    <div class="qi-endpoint-row">
      <span class="qi-endpoint-label">${t("mcp.qi.endpoint", undefined, "Endpoint")}</span>
      <code class="qi-endpoint">${endpoint}</code>
      <button class="mcp-btn gt-btn" @click=${() => copyQuickSnippet(state, "endpoint", endpoint)}>
        ${qi.copied === "endpoint" ? t("mcp.qi.copied", undefined, "Copied!") : t("mcp.qi.copy", undefined, "Copy")}
      </button>
    </div>

    <div class="qi-snippet-wrap" data-learn-id="mcp-quick-snippet">
      <button class="qi-snippet-copy" @click=${() => copyQuickSnippet(state, "snippet", snippet)}>
        ${qi.copied === "snippet" ? t("mcp.qi.copied", undefined, "Copied!") : t("mcp.qi.copy", undefined, "Copy")}
      </button>
      <pre class="qi-snippet"><code>${snippet}</code></pre>
    </div>

    <div class="qi-meta">
      <div class="qi-meta-row"><span class="qi-meta-key">${t("mcp.qi.configPath", undefined, "Config file")}</span><code class="qi-meta-val">${path}</code></div>
      <div class="qi-explain">${quickExplain(qi.client)}</div>
    </div>
  `;
}

function renderQuickHelp() {
  return html`
    <div class="qi-help">
      <div class="qi-help-item"><strong>${t("mcp.qi.scope.local", undefined, "Local")}</strong> — ${t("mcp.qi.scope.local.hint", undefined, "Same machine. Zero config, fastest.")}</div>
      <div class="qi-help-item"><strong>${t("mcp.qi.scope.lan", undefined, "LAN")}</strong> — ${t("mcp.qi.scope.lan.hint", undefined, "Same network. Reachable from other devices on this Wi-Fi/LAN.")}</div>
      <div class="qi-help-item"><strong>${t("mcp.qi.scope.tailscale", undefined, "Tailscale")}</strong> — ${t("mcp.qi.scope.tailscale.hint", undefined, "Remote secure access over your tailnet — recommended for reaching this gateway from outside the LAN.")}</div>
    </div>
  `;
}

function renderDiscoverySection(state: AppViewState, mcpState: McpManagementState) {
  const reg = mcpState.registry;
  const cats = catalogCategoryCounts();
  const matches = filterCatalog(reg);

  return html`
    <div class="mcp-discovery" data-learn-id="mcp-discovery">
      <div class="mcp-discovery-head">
        <span class="mcp-discovery-title">${icons.sparkles} Discover</span>
        <div class="mcp-search-wrap">
          <span class="mcp-search-icon">${icons.search}</span>
          <input
            class="mcp-search-input gt-input"
            data-learn-id="mcp-discovery-search"
            aria-label="Search integrations"
            type="text"
            placeholder="Search integrations — name, tag, or category…"
            .value=${reg.catalogQuery}
            @input=${(e: Event) => { reg.catalogQuery = (e.target as HTMLInputElement).value; state.requestUpdate?.(); }}
          />
        </div>
      </div>

      <div class="mcp-pills" role="toolbar" aria-label="Integration categories">
        <button class="mcp-pill ${reg.activeCategory === "All" ? "active" : ""}"
          aria-pressed=${reg.activeCategory === "All" ? "true" : "false"}
          @click=${() => { reg.activeCategory = "All"; state.requestUpdate?.(); }}>
          All<span class="mcp-pill-count">${FEATURED_MCPS_LENGTH}</span>
        </button>
        ${cats.map((c) => html`
          <button class="mcp-pill ${reg.activeCategory === c.key ? "active" : ""}"
            aria-pressed=${reg.activeCategory === c.key ? "true" : "false"}
            @click=${() => { reg.activeCategory = c.key; state.requestUpdate?.(); }}>
            ${c.key}<span class="mcp-pill-count">${c.count}</span>
          </button>
        `)}
      </div>

      <div class="mcp-featured-grid">
        ${matches.length === 0
          ? html`<div class="mcp-discovery-empty gt-empty">
              <div class="gt-empty-orb">${icons.search}</div>
              <div class="gt-empty-title">No integrations match "${reg.catalogQuery}"</div>
              <div class="gt-empty-sub">Try another name or tag — or browse the full MCP registry below.</div>
            </div>`
          : matches.map((fm, i) => renderFeaturedCard(state, mcpState, fm, i))}
      </div>
    </div>
  `;
}

function renderFeaturedCard(state: AppViewState, mcpState: McpManagementState, fm: FeaturedMcp, index = 0) {
  const status = featuredStatus(mcpState, fm);

  return html`
    <div class="mcp-feat-card gt-glass gt-lift gt-rise" style="--accent:${fm.accent};--gt-i:${Math.min(index, 14)};"
      role="button"
      tabindex="0"
      aria-label="${fm.name} — ${status.label}"
      @click=${() => runFeaturedPrimary(state, mcpState, fm)}
      @keydown=${onActivateKey(() => runFeaturedPrimary(state, mcpState, fm))}>
      <span class="mcp-feat-glow" aria-hidden="true"></span>
      <div class="mcp-feat-top">
        <div class="mcp-feat-logo">${fm.icon}</div>
        <div class="mcp-feat-namewrap">
          <div class="mcp-feat-name">${fm.name}</div>
          <div class="mcp-feat-cat">${fm.category}</div>
        </div>
        <span class="mcp-stat ${status.cls}"><span class="dot"></span>${status.label}</span>
      </div>
      <div class="mcp-feat-tagline">${fm.tagline}</div>
      <div class="mcp-feat-foot">
        <span class="mcp-feat-transport">
          ${fm.transport === "stdio" ? (fm.command ?? "stdio") : fm.transport}
        </span>
        <button class="mcp-feat-install gt-btn ${status.cls === "notinstalled" ? "gt-primary" : ""}"
          ?disabled=${status.cls === "installing"}
          @click=${(e: Event) => { e.stopPropagation(); runFeaturedPrimary(state, mcpState, fm); }}>
          ${primaryLabel(status, fm)}
        </button>
      </div>
    </div>
  `;
}

// ── Guided Install Modal (one-click featured) ────────────────

function renderInstallModal(state: AppViewState, mcpState: McpManagementState) {
  const reg = mcpState.registry;
  const fm = reg.installTarget;
  if (!fm) return nothing;

  const close = () => closeInstall(state);
  const envVars = fm.env ?? [];
  const previewArgs = [...(fm.args ?? [])];
  const previewEnv: Record<string, string> = {};
  for (const ev of envVars) {
    const v = reg.installEnv[ev.name]?.trim();
    if (!v) continue;
    if (ev.asArg) previewArgs.push(ev.type === "secret" ? "••••" : v);
    else previewEnv[ev.name] = ev.type === "secret" ? "••••" : v;
  }
  const configPreview = JSON.stringify(
    fm.transport === "stdio"
      ? { name: fm.id, command: fm.command, args: previewArgs, env: previewEnv, transport: fm.transport }
      : { name: fm.id, url: fm.url, transport: fm.transport },
    null,
    2,
  );

  return html`
    <div class="mcp-dialog-overlay" @click=${(e: Event) => { if (e.target === e.currentTarget) close(); }}>
      <div class="mcp-dialog gt-sheet-panel" style="width:540px;--accent:${fm.accent};" role="dialog" aria-modal="true" aria-label="Install ${fm.name}">
        <div class="canva-modal-header">
          <div class="mcp-feat-logo">${fm.icon}</div>
          <div class="mcp-sheet-titles">
            <div class="canva-modal-title">${fm.name}</div>
            <div class="mcp-guided-sub">${fm.tagline}</div>
          </div>
          <button class="mcp-delete-btn mcp-icon-btn mcp-sheet-close" @click=${close} aria-label="Close">${icons.x}</button>
        </div>

        ${reg.installError ? html`
          <div class="mcp-error" style="margin-bottom:14px;">
            <span>⚠ ${reg.installError}</span>
            <button class="mcp-error-dismiss" @click=${() => { reg.installError = null; state.requestUpdate?.(); }}>✕</button>
          </div>
        ` : nothing}

        ${reg.installTestResult ? html`
          <div class="mcp-guided-test ${reg.installTestResult.ok ? "ok" : "bad"}">
            ${reg.installTestResult.ok ? "✓ " : "✗ "}${reg.installTestResult.message}
          </div>
        ` : nothing}

        ${envVars.length === 0 ? html`
          <div class="mcp-guided-noenv">✓ No credentials required — this server is ready to install in one click.</div>
        ` : html`
          <div class="mcp-config-kicker">
            Required configuration
          </div>
          ${envVars.map((ev) => renderInstallField(state, mcpState, ev))}
        `}

        <details class="mcp-advanced">
          <summary>Show advanced config (JSON)</summary>
          <div class="mcp-command-block" style="margin-top:8px;">${configPreview}</div>
          <div class="mcp-form-hint" style="margin-top:6px;">Need full control? Use <strong>+ Add Custom</strong> in the server list for a raw editor.</div>
        </details>

        <div class="mcp-dialog-actions">
          <button class="mcp-btn gt-btn"
            ?disabled=${reg.installTesting || reg.installBusy}
            @click=${() => testFeaturedConnection(state, fm)}>
            ${reg.installTesting ? "Testing…" : "Test connection"}
          </button>
          <button class="mcp-btn gt-btn gt-primary primary"
            ?disabled=${reg.installBusy}
            @click=${() => installFeatured(state, fm)}>
            ${reg.installBusy ? "Installing…" : "Install & connect"}
          </button>
          <button class="mcp-btn gt-btn" @click=${close}>Cancel</button>
        </div>
      </div>
    </div>
  `;
}

function renderInstallField(
  state: AppViewState,
  mcpState: McpManagementState,
  ev: NonNullable<FeaturedMcp["env"]>[number],
) {
  const reg = mcpState.registry;
  const value = reg.installEnv[ev.name] ?? "";
  const inputType = ev.type === "secret" ? "password" : "text";

  return html`
    <div class="mcp-field">
      <div class="mcp-field-label">
        ${ev.label}
        ${ev.required ? html`<span class="mcp-field-req">*</span>` : nothing}
        ${ev.type === "secret" ? html`<span class="mcp-field-secret-tag">SECRET</span>` : nothing}
      </div>
      <div class="mcp-field-inputrow">
        ${ev.type === "path" ? html`<span class="mcp-field-prefix">${icons.folder}</span>` : nothing}
        <input
          class="mcp-form-input"
          type="${inputType}"
          autocomplete="off"
          placeholder="${ev.placeholder ?? ev.name}"
          .value=${value}
          @input=${(e: Event) => {
            reg.installEnv[ev.name] = (e.target as HTMLInputElement).value;
            state.requestUpdate?.();
          }}
        />
      </div>
      ${ev.hint ? html`<div class="mcp-form-hint">${ev.hint}</div>` : nothing}
      ${ev.helpUrl ? html`
        <a class="mcp-field-help" href="${ev.helpUrl}" target="_blank" rel="noopener">
          ↗ ${ev.helpLabel ?? "Where do I get this?"}
        </a>
      ` : nothing}
    </div>
  `;
}

// ── Inspector Drawer (live tools for a connected server) ─────

function renderInspectorDrawer(state: AppViewState, mcpState: McpManagementState) {
  const insp = mcpState.inspector;
  const name = insp.serverName ?? "";
  const fm = FEATURED_MCPS_BY_ID[name];
  const icon = fm?.icon ?? getServerIcon(name);
  const accent = fm?.accent ?? "var(--g-primary)";
  const close = () => closeInspector(state);

  return html`
    <div class="mcp-drawer-overlay" @click=${close}></div>
    <div class="mcp-drawer gt-sheet-panel" style="--g-primary-accent:${accent};" role="dialog" aria-modal="true" aria-label="${name} inspector">
      <div class="mcp-drawer-head">
        <div class="mcp-drawer-logo">${icon}</div>
        <div style="flex:1;min-width:0;">
          <div class="mcp-drawer-title">${name}</div>
          <div class="mcp-drawer-sub">Inspector · live tools</div>
        </div>
        <button class="mcp-delete-btn mcp-icon-btn" @click=${close} aria-label="Close">${icons.x}</button>
      </div>
      <div class="mcp-drawer-body">
        ${insp.loading ? html`
          <div style="display:grid;gap:8px">
            ${[0, 1, 2, 3, 4].map((i) => html`<div class="gt-skel" style="height:52px;border-radius:14px;opacity:${1 - i * 0.15}"></div>`)}
          </div>
          <div class="mcp-loading"><span class="mcp-loading-dot">◆</span> LOADING TOOLS</div>
        ` : insp.error ? html`
          <div class="mcp-error"><span>⚠ ${insp.error}</span></div>
        ` : insp.tools.length === 0 ? html`
          <div class="gt-empty">
            <div class="gt-empty-orb">${icons.wrench}</div>
            <div class="gt-empty-title">No tools exposed yet</div>
            <div class="gt-empty-sub">Start MCP to discover the tools this server exposes.</div>
          </div>
        ` : html`
          <div class="mcp-insp-toolcount">${insp.tools.length} TOOL${insp.tools.length === 1 ? "" : "S"}</div>
          ${insp.tools.map((tool) => renderInspectorTool(state, mcpState, tool))}
        `}
      </div>
    </div>
  `;
}

function renderInspectorTool(state: AppViewState, mcpState: McpManagementState, tool: McpToolInfo) {
  const slot = mcpState.inspector.tries[tool.name];
  const open = slot?.open ?? false;

  return html`
    <div class="mcp-insp-tool">
      <div class="mcp-insp-tool-head" @click=${() => toggleInspectorTry(state, tool.name)}>
        <span class="mcp-insp-tool-name">${tool.name}</span>
        <span class="mcp-insp-tool-desc">${tool.description || "No description"}</span>
        <button class="mcp-insp-trybtn gt-btn" aria-expanded=${open ? "true" : "false"} @click=${(e: Event) => { e.stopPropagation(); toggleInspectorTry(state, tool.name); }}>
          ${open ? "Close" : "Try it"}
        </button>
      </div>
      ${open ? html`
        <div class="mcp-insp-tryform">
          <textarea
            spellcheck="false"
            placeholder='{ "arg": "value" }'
            .value=${slot?.args ?? "{}"}
            @input=${(e: Event) => setInspectorTryArgs(state, tool.name, (e.target as HTMLTextAreaElement).value)}
          ></textarea>
          <div class="mcp-insp-runrow">
            <button class="mcp-btn gt-btn gt-primary primary"
              ?disabled=${slot?.running ?? false}
              @click=${() => callInspectorTool(state, tool.name)}>
              ${slot?.running ? "Running…" : html`${icons.play} Run`}
            </button>
            <span class="mcp-insp-runnote">Calls the tool live via the gateway.</span>
          </div>
          ${slot?.error ? html`<div class="mcp-insp-result err">${slot.error}</div>` : nothing}
          ${slot?.result ? html`<div class="mcp-insp-result">${slot.result}</div>` : nothing}
        </div>
      ` : nothing}
    </div>
  `;
}

// ── Marketplace ──────────────────────────────────────────────

function renderMarketplace(state: AppViewState, mcpState: McpManagementState) {
  const reg = mcpState.registry;

  return html`
    <div class="mcp-marketplace-overlay" @click=${(e: Event) => {
      if (e.target === e.currentTarget) {
        reg.open = false;
        reg.selectedServer = null;
        state.requestUpdate?.();
      }
    }}>
      <div class="mcp-marketplace gt-sheet-panel" role="dialog" aria-modal="true" aria-label="MCP registry">
        <!-- Header with search -->
        <div class="mcp-marketplace-header">
          <span class="mcp-marketplace-title">${icons.zap} MCP registry</span>
          <div class="mcp-marketplace-search">
            <input type="text" placeholder="Search MCP servers…" aria-label="Search MCP servers"
              .value=${reg.query}
              @input=${(e: Event) => { reg.query = (e.target as HTMLInputElement).value; }}
              @keydown=${(e: KeyboardEvent) => {
                if (e.key === "Enter") searchRegistry(state, reg.query);
              }}
            />
            <button class="mcp-btn gt-btn" ?disabled=${reg.loading}
              @click=${() => searchRegistry(state, reg.query)}>
              ${reg.loading ? "…" : html`${icons.search} Search`}
            </button>
          </div>
          <button class="mcp-marketplace-close mcp-icon-btn" aria-label="Close" @click=${() => {
            reg.open = false;
            reg.selectedServer = null;
            state.requestUpdate?.();
          }}>${icons.x}</button>
        </div>

        <!-- Body -->
        <div class="mcp-marketplace-body">
          ${reg.successMessage ? html`<div class="mcp-success">${reg.successMessage}</div>` : nothing}
          ${reg.error ? html`<div class="mcp-error"><span>⚠ ${reg.error}</span></div>` : nothing}

          ${reg.selectedServer
            ? renderRegistryDetail(state, reg)
            : renderRegistryGrid(state, reg)
          }
        </div>

        <!-- Footer -->
        <div class="mcp-marketplace-footer">
          <span class="mcp-marketplace-footer-text">
            ${reg.results.length} servers loaded
            ${reg.nextCursor ? " · more available" : ""}
          </span>
          <span class="mcp-marketplace-footer-text">
            SOURCE: registry.modelcontextprotocol.io
          </span>
        </div>
      </div>
    </div>
  `;
}

function renderRegistryGrid(state: AppViewState, reg: McpRegistryState) {
  if (reg.loading && !reg.results.length) {
    return html`
      <div class="mcp-reg-grid">
        ${[0, 1, 2, 3, 4, 5].map((i) => html`
          <div class="mcp-reg-card gt-glass gt-rise" style="--gt-i:${i};cursor:default">
            <div class="gt-skel" style="width:60%;height:13px"></div>
            <div class="gt-skel" style="width:95%;height:10px"></div>
            <div class="gt-skel" style="width:75%;height:10px"></div>
          </div>
        `)}
      </div>
      <div class="mcp-loading"><span class="mcp-loading-dot">◆</span> SEARCHING REGISTRY</div>`;
  }

  if (!reg.results.length) {
    return html`
      <div class="gt-empty">
        <div class="gt-empty-orb">${reg.query ? icons.search : icons.server}</div>
        <div class="gt-empty-title">${reg.query ? "No servers found" : "Explore the MCP registry"}</div>
        <div class="gt-empty-sub">${reg.query ? "Try a broader term — the registry matches names and descriptions." : "Search the official Model Context Protocol registry, then add a server in one click."}</div>
      </div>`;
  }

  return html`
    <div class="mcp-reg-grid">
      ${reg.results.map((entry, i) => renderRegistryCard(state, reg, entry, i))}
    </div>
    ${reg.nextCursor ? html`
      <div class="mcp-reg-load-more">
        <button class="mcp-btn gt-btn" ?disabled=${reg.loading}
          @click=${() => loadMoreResults(state)}>
          ${reg.loading ? "Loading…" : "Load more"}
        </button>
      </div>
    ` : nothing}
  `;
}

function renderRegistryCard(state: AppViewState, reg: McpRegistryState, entry: RegistryEntry, index = 0) {
  const srv = entry.server;
  const badge = getTransportBadge(entry);
  const meta = entry._meta?.["io.modelcontextprotocol.registry/official"];

  return html`
    <div class="mcp-reg-card gt-glass gt-lift gt-rise" style="--gt-i:${Math.min(index, 14)}"
      role="button"
      tabindex="0"
      @click=${() => selectRegistryServer(state, entry)}
      @keydown=${onActivateKey(() => selectRegistryServer(state, entry))}>
      <div class="mcp-reg-card-top">
        <span class="mcp-reg-card-name">${srv.name}</span>
        <span class="mcp-reg-transport" style="color:${badge.color};border-color:${badge.color}40;">${badge.label}</span>
      </div>
      <div class="mcp-reg-card-desc">${srv.description || "No description"}</div>
      <div class="mcp-reg-card-meta">
        <span class="mcp-reg-version">v${srv.version}</span>
        ${meta?.publishedAt ? html`<span>${formatPublishedDate(meta.publishedAt)}</span>` : nothing}
        ${srv.repository?.url ? html`<span>${icons.container} ${srv.repository.source || "repo"}</span>` : nothing}
      </div>
    </div>
  `;
}

function renderRegistryDetail(state: AppViewState, reg: McpRegistryState) {
  const entry = reg.selectedServer!;
  const srv = entry.server;
  const meta = entry._meta?.["io.modelcontextprotocol.registry/official"];
  const badge = getTransportBadge(entry);
  const installInfo = getInstallCommand(entry);
  const pkg = srv.packages?.[0];
  const remote = srv.remotes?.[0];
  const envVars = pkg?.environmentVariables ?? [];

  return html`
    <div class="mcp-reg-detail">
      <button class="mcp-reg-detail-back gt-btn" @click=${() => selectRegistryServer(state, null)}>${icons.arrowLeft} Back to results</button>

      <div class="mcp-reg-detail-header">
        <div>
          <div class="mcp-reg-detail-name">${srv.name}</div>
          <div style="margin-top:6px;">
            <span class="mcp-reg-transport" style="color:${badge.color};border-color:${badge.color}40;">${badge.label}</span>
          </div>
        </div>
      </div>

      <div class="mcp-reg-detail-desc">${srv.description || "No description available."}</div>

      <!-- Info Grid -->
      <div class="mcp-reg-detail-info">
        <div class="mcp-reg-info-item">
          <span class="mcp-reg-info-label">VERSION</span>
          <span class="mcp-reg-info-value">${srv.version}</span>
        </div>
        ${pkg ? html`
          <div class="mcp-reg-info-item">
            <span class="mcp-reg-info-label">PACKAGE</span>
            <span class="mcp-reg-info-value">${pkg.identifier}</span>
          </div>
          <div class="mcp-reg-info-item">
            <span class="mcp-reg-info-label">REGISTRY</span>
            <span class="mcp-reg-info-value">${pkg.registryType.toUpperCase()}</span>
          </div>
          <div class="mcp-reg-info-item">
            <span class="mcp-reg-info-label">TRANSPORT</span>
            <span class="mcp-reg-info-value">${pkg.transport?.type?.toUpperCase() || "STDIO"}</span>
          </div>
        ` : nothing}
        ${remote ? html`
          <div class="mcp-reg-info-item">
            <span class="mcp-reg-info-label">REMOTE URL</span>
            <span class="mcp-reg-info-value">
              <a href="${remote.url}" target="_blank" rel="noopener">${remote.url}</a>
            </span>
          </div>
          <div class="mcp-reg-info-item">
            <span class="mcp-reg-info-label">TRANSPORT</span>
            <span class="mcp-reg-info-value">${remote.type.toUpperCase()}</span>
          </div>
        ` : nothing}
        ${srv.repository?.url ? html`
          <div class="mcp-reg-info-item">
            <span class="mcp-reg-info-label">REPOSITORY</span>
            <span class="mcp-reg-info-value">
              <a href="${srv.repository.url}" target="_blank" rel="noopener">${srv.repository.url}</a>
            </span>
          </div>
        ` : nothing}
        ${meta?.publishedAt ? html`
          <div class="mcp-reg-info-item">
            <span class="mcp-reg-info-label">PUBLISHED</span>
            <span class="mcp-reg-info-value">${formatPublishedDate(meta.publishedAt)}</span>
          </div>
        ` : nothing}
      </div>

      <!-- Install Command Preview -->
      ${installInfo ? html`
        <div>
          <div class="mcp-detail-label" style="margin-bottom:6px;">INSTALL COMMAND</div>
          ${"command" in installInfo ? html`
            <div class="mcp-reg-install-cmd">
              <span class="cmd-prefix">$</span> ${installInfo.command} ${installInfo.args.join(" ")}
            </div>
          ` : html`
            <div class="mcp-reg-install-cmd">
              <span class="cmd-prefix">URL:</span> ${installInfo.url}
            </div>
          `}
        </div>
      ` : nothing}

      <!-- Environment Variables -->
      ${envVars.length > 0 ? html`
        <div class="mcp-reg-env-section">
          <div class="mcp-detail-label">ENVIRONMENT VARIABLES</div>
          ${envVars.map((ev) => html`
            <div class="mcp-reg-env-row">
              <span class="mcp-reg-env-name">
                ${ev.name}
                ${ev.isSecret ? html` <span class="mcp-reg-env-secret">${icons.key}</span>` : nothing}
              </span>
              <input class="mcp-reg-env-input"
                type="${ev.isSecret ? "password" : "text"}"
                placeholder="${ev.description || ev.name}"
                .value=${reg.envValues[ev.name] || ""}
                @input=${(e: Event) => {
                  reg.envValues[ev.name] = (e.target as HTMLInputElement).value;
                  state.requestUpdate?.();
                }}
              />
            </div>
            ${ev.description ? html`<div class="mcp-reg-env-hint">${ev.description}</div>` : nothing}
          `)}
        </div>
      ` : nothing}

      <!-- Install Button -->
      <button class="mcp-reg-install-btn gt-btn gt-primary"
        ?disabled=${reg.installing !== null}
        @click=${() => installRegistryServer(state)}>
        ${reg.installing ? "Installing…" : "Add to MoltBot"}
      </button>
    </div>
  `;
}

// ── Helpers ──────────────────────────────────────────────────

function truncateModel(model: string): string {
  // Show just the model name part, truncate long provider prefixes
  const parts = model.split("/");
  const name = parts[parts.length - 1] || model;
  if (name.length > 30) return name.slice(0, 27) + "…";
  return name;
}
