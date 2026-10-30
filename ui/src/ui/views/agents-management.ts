/**
 * Agents page: per-agent editors, the "New agent" dialog and the config popup.
 *
 * The page itself (roster, constellation, cards, detail drawer) lives in
 * agents-premium.ts; this module hands it the legacy editors through the
 * `AgentsLegacyEditors` bridge. Styling is the black-gold glass system: the
 * `.gt-*` primitives (glass-tools-shared.ts), the agent-page helpers
 * (glass-agents-shared.ts) and the editor layer in glass-agents-mgmt.css.ts.
 */

import { html, nothing } from "lit";
import type { GatewayBrowserClient } from "../gateway";
import type { AppViewState } from "../app-view-state";
import type {
  AgentsManagementState,
  AgentListEntry,
  AgentSessionInfo,
  InfiniBotAgent,
  AgentType,
} from "../controllers/agents-management";
import {
  createAgentEntry,
  deleteAgentEntry,
  setDefaultAgent,
  updateAgentSystemPrompt,
  updateAgentModel,
  updateAgentTools,
  updateAgentSkills,
  updateAgentMcps,
  updateAgentSubagents,
  updateAgentReferences,
  updateAgentType,
  updateAgentCLIConfig,
} from "../controllers/agents-management";
import {
  getSkillFileContent,
  saveSkillFileContent,
  type SkillFileInfo,
} from "../controllers/agents-config";
import { renderAgentPopup, showAgentPopup } from "./agent-popup";
import { icons } from "../icons";
import { renderAgentsPremium, type AgentsLegacyEditors } from "./agents-premium";
import { glassAgentsStyle, glassEmpty } from "./glass-agents-shared";
import { AGM_CSS } from "./glass-agents-mgmt.css";

// Skill file editing state
const skillFileCache = new Map<string, SkillFileInfo>();
const skillFileDrafts = new Map<string, string>();
const skillFileEditing = new Set<string>();
const skillFileSaving = new Set<string>();

// ============================================================
// Local UI State (module-scoped, survives re-renders)
// ============================================================

/** Unsaved system prompt drafts keyed by agentId */
const promptDrafts = new Map<string, string>();

/** Agents currently saving their prompt */
const savingPrompts = new Set<string>();

/** Whether the prompt editor is in "edit" mode (vs read-only preview) */
const editingMode = new Set<string>();

/**
 * The roster error that was showing when the "New agent" dialog opened.
 * Validation errors raised by the dialog are shown inside it and cleared on
 * close, so they don't linger in the page banner as "Couldn't load the roster".
 */
let errorBeforeCreate: string | null = null;

// Built-in default system prompt description (since the real one is assembled dynamically)
const BUILTIN_PROMPT_DESCRIPTION = `# Built-in InfiniBot System Prompt (assembled at runtime)

This agent is using the default built-in system prompt. The prompt is
assembled dynamically from multiple sources:

## Sources (in order):
1. Core identity and behavioral instructions
2. Tool availability and usage guidelines
3. Workspace context (working directory, runtime info)
4. Skill instructions (from matched SKILL.md files)
5. Workspace files: SOUL.md, USER.md, AGENTS.md, TOOLS.md, etc.
6. Memory recall instructions
7. Channel-specific formatting rules
8. Heartbeat configuration
9. Runtime metadata (model, timezone, date/time)

## To customize:
- Set a custom system prompt below to REPLACE the built-in core prompt
- Context files (SOUL.md, USER.md, etc.) are STILL appended automatically
- Set to empty / "default" to revert to built-in behavior

## Workspace files (always appended):
- AGENTS.md — Agent-specific instructions and conventions
- SOUL.md — Persona, tone, and identity
- USER.md — Information about the human
- TOOLS.md — Local tool configuration notes
- IDENTITY.md — Name, emoji, avatar
- HEARTBEAT.md — Periodic check tasks
- MEMORY.md — Long-term memory (main session only)`;

// ============================================================
// Main Render
// ============================================================

export type AgentsManagementViewProps = {
  state: AppViewState;
  client: GatewayBrowserClient;
};

export function renderAgentsManagement(props: AgentsManagementViewProps) {
  const { state, client } = props;
  const mgmtOf = () => state.agentsManagementState!;
  const editors: AgentsLegacyEditors = {
    styles: renderLegacyStyles,
    typeSelector: (a) => renderTypeSelector(a, mgmtOf(), state, client),
    modelSelector: (a) => renderModelSelector(a, mgmtOf(), state, client),
    cliConfig: (a) => renderCLIConfigTab(a, mgmtOf(), state, client),
    prompt: (a) => renderPromptTab(a, mgmtOf(), state, client),
    tools: (a) => renderToolsTab(a, mgmtOf(), state, client),
    skills: (a) => renderSkillsTab(a, mgmtOf(), state, client),
    mcps: (a) => renderMcpsTab(a, mgmtOf(), state, client),
    subagents: (a) => renderSubagentsTab(a, mgmtOf(), state, client),
    references: (a) => renderReferencesTab(a, mgmtOf(), state, client),
    sessions: (a) => renderSessionsTab(a),
    createDialog: () => renderCreateDialog(state, client),
    configPopup: () => renderAgentPopup({ state, client }),
    openConfigPopup: () => showAgentPopup(),
    openCreate: () => {
      if (!state.agentsManagementState) return;
      errorBeforeCreate = state.agentsManagementState.error;
      state.agentsManagementState.showCreateDialog = true;
      state.agentsManagementState.editingAgent = { workspace: "~/infinibot-new" };
    },
    setDefault: async (id) => { await setDefaultAgent(state, client, id); },
    remove: async (id) => { await deleteAgentEntry(state, client, id); },
  };
  return renderAgentsPremium({ state, client, editors });
}

/**
 * Styles for the editors, the create dialog and the config popup: the shared
 * glass primitives plus the `.agm-*` editor layer. Rendered once by the page.
 */
function renderLegacyStyles() {
  return glassAgentsStyle(AGM_CSS);
}

// ============================================================
// Shared bits
// ============================================================

/** A glass toggle tile (tools / skills / MCP / sub-agents). */
function checkTile(label: unknown, on: boolean, onClick: () => void, extra: unknown = nothing) {
  return html`
    <button type="button" class="agm-check" aria-pressed=${on ? "true" : "false"} @click=${onClick}>
      <span class="agm-check-box" aria-hidden="true">${on ? icons.check : nothing}</span>
      ${typeof label === "string" ? html`<span class="agm-check-label" title=${label}>${label}</span>` : label}
      ${extra}
    </button>
  `;
}

function edHead(icon: unknown, title: string, meta?: unknown) {
  return html`
    <div class="agm-ed-head">
      <h3 class="agm-ed-title"><span class="agm-ico">${icon}</span>${title}</h3>
      ${meta ? html`<span class="agm-ed-meta">${meta}</span>` : nothing}
    </div>
  `;
}

function toggleIn<T>(set: Set<T>, value: T): T[] {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return Array.from(next);
}

// ============================================================
// Individual Tab Renderers
// ============================================================

function renderSessionsTab(agent: AgentListEntry) {
  if (agent.sessions.length === 0) {
    return html`<div class="agm-ed">
      ${glassEmpty({
        icon: icons.messageSquare,
        title: "No active sessions",
        sub: "Sessions appear here while this agent is running: chats, channel threads and sub-agent runs.",
      })}
    </div>`;
  }

  return html`
    <div class="agm-ed">
      ${edHead(icons.messageSquare, "Sessions", html`${agent.sessionCount} total${agent.activeSessionCount > 0 ? html` · <b>${agent.activeSessionCount} active</b>` : ""}`)}
      <div class="agm-rows agm-rows--scroll">
        ${agent.sessions.slice(0, 20).map((s) => renderSessionRow(s))}
      </div>
    </div>
  `;
}

function renderToolsTab(
  agent: AgentListEntry,
  mgmt: AgentsManagementState,
  state: AppViewState,
  client: GatewayBrowserClient
) {
  const selectedTools = new Set(agent.tools || []);
  const availableTools = mgmt.availableTools || [
    "exec", "read", "write", "edit", "web_search", "web_fetch", "browser",
    "kanban", "image", "sessions_spawn", "subagent_progress", "subagents_list",
    "cron", "message", "gateway", "tts", "vision", "memory_search", "memory_get",
    "notes", "research", "workflows", "budget"
  ];

  return html`
    <div class="agm-ed">
      ${edHead(icons.wrench, "Tool allow-list", html`<b>${selectedTools.size}</b>/${availableTools.length} selected`)}
      <p class="agm-ed-hint">Select which tools this agent can use. Empty means every tool is allowed.</p>

      <div class="agm-check-grid">
        ${availableTools.map((tool) =>
          checkTile(tool, selectedTools.has(tool), () => {
            updateAgentTools(state, client, agent.id, toggleIn(selectedTools, tool));
          }),
        )}
      </div>

      <div class="agm-ed-foot">
        ${selectedTools.size === 0
          ? html`<span class="is-open">All tools allowed (no restrictions)</span>`
          : html`<span>${selectedTools.size} tools enabled</span>`}
      </div>

      <div class="agm-sub-h">Presets</div>
      <div class="agm-actions">
        <button
          type="button"
          class="gt-btn agm-sm"
          @click=${() => {
            const essentialTools = ['exec', 'read', 'write', 'edit', 'web_search', 'web_fetch', 'browser', 'kanban', 'image', 'memory_search', 'memory_get'];
            updateAgentTools(state, client, agent.id, essentialTools);
          }}
        >
          ${icons.container} Essential set
        </button>
        <button
          type="button"
          class="gt-btn agm-sm"
          @click=${() => {
            const fullTools = ['exec', 'read', 'write', 'edit', 'web_search', 'web_fetch', 'browser', 'kanban', 'image', 'process', 'canvas', 'memory_search', 'memory_get', 'notes', 'research', 'sessions_spawn', 'subagent_progress'];
            updateAgentTools(state, client, agent.id, fullTools);
          }}
        >
          ${icons.zap} Full dev set
        </button>
        <button
          type="button"
          class="gt-btn agm-sm"
          @click=${() => {
            updateAgentTools(state, client, agent.id, []);
          }}
        >
          ${icons.key} Allow all
        </button>
      </div>
    </div>
  `;
}

function renderSkillsTab(
  agent: AgentListEntry,
  mgmt: AgentsManagementState,
  state: AppViewState,
  client: GatewayBrowserClient
) {
  const selectedSkills = new Set(agent.skills || []);
  const availableSkills = mgmt.availableSkills || [];

  return html`
    <div class="agm-ed">
      ${edHead(icons.zap, "Skill allow-list", availableSkills.length ? html`<b>${selectedSkills.size}</b>/${availableSkills.length} selected` : undefined)}
      <p class="agm-ed-hint">Select which skills this agent can access. Empty means every skill is allowed.</p>

      ${availableSkills.length === 0
        ? glassEmpty({ icon: icons.zap, title: "No skills available", sub: "Skills appear here once the gateway has loaded them." })
        : html`
          <div class="agm-check-grid agm-check-grid--wide">
            ${availableSkills.map((skill) =>
              checkTile(skill, selectedSkills.has(skill), () => {
                updateAgentSkills(state, client, agent.id, toggleIn(selectedSkills, skill));
              }),
            )}
          </div>
        `}

      <div class="agm-ed-foot">
        <span>Selected: ${selectedSkills.size} of ${availableSkills.length} skills</span>
        ${selectedSkills.size === 0 ? html`<span class="is-open">All skills allowed</span>` : nothing}
      </div>

      <!-- Skill File Editor Section -->
      ${selectedSkills.size > 0 ? html`
        <div class="agm-sub-h">${icons.penLine} Edit skill files</div>
        <p class="agm-ed-hint">Open a skill to edit its SKILL.md directly.</p>
        <div class="agm-actions">
          ${Array.from(selectedSkills).map(skill => {
            const isEditing = skillFileEditing.has(skill);
            const isSaving = skillFileSaving.has(skill);
            return html`
              <button
                type="button"
                class="gt-btn agm-xs ${isEditing ? "is-on" : ""}"
                aria-pressed=${isEditing ? "true" : "false"}
                @click=${async () => {
                  if (isEditing) {
                    skillFileEditing.delete(skill);
                  } else {
                    // Load skill file content
                    if (!skillFileCache.has(skill)) {
                      const info = await getSkillFileContent(client, skill);
                      if (info) skillFileCache.set(skill, info);
                    }
                    skillFileEditing.add(skill);
                  }
                  state.requestUpdate?.();
                }}
              >
                ${isSaving ? icons.clock : isEditing ? icons.book : icons.penLine} ${skill}
              </button>
            `;
          })}
        </div>

        <!-- Skill File Editor -->
        ${Array.from(skillFileEditing).map(skill => {
          const cached = skillFileCache.get(skill);
          const draft = skillFileDrafts.get(skill);
          const content = draft ?? cached?.content ?? '';
          const isDirty = draft !== undefined && draft !== (cached?.content || '');
          const isSaving = skillFileSaving.has(skill);

          return html`
            <div class="agm-file">
              <div class="agm-file-head">
                <span class="agm-file-path">skills/${skill}/SKILL.md</span>
                <div class="agm-actions">
                  ${isDirty ? html`
                    <button
                      type="button"
                      class="gt-btn gt-primary agm-xs"
                      ?disabled=${isSaving}
                      @click=${async () => {
                        skillFileSaving.add(skill);
                        state.requestUpdate?.();
                        const success = await saveSkillFileContent(client, skill, draft || '');
                        skillFileSaving.delete(skill);
                        if (success) {
                          skillFileDrafts.delete(skill);
                          const info = skillFileCache.get(skill);
                          if (info) info.content = draft || '';
                        }
                        state.requestUpdate?.();
                      }}
                    >
                      ${isSaving ? 'Saving…' : html`${icons.save} Save`}
                    </button>
                    <button
                      type="button"
                      class="gt-btn agm-xs"
                      @click=${() => {
                        skillFileDrafts.delete(skill);
                        state.requestUpdate?.();
                      }}
                    >
                      Discard
                    </button>
                  ` : ''}
                  <button
                    type="button"
                    class="gt-btn agm-xs"
                    @click=${() => {
                      skillFileEditing.delete(skill);
                      skillFileDrafts.delete(skill);
                      state.requestUpdate?.();
                    }}
                  >
                    Close
                  </button>
                </div>
              </div>
              <textarea
                class="agm-code ${isDirty ? "is-dirty" : ""}"
                aria-label="skills/${skill}/SKILL.md"
                spellcheck="false"
                .value=${content}
                @input=${(e: Event) => {
                  skillFileDrafts.set(skill, (e.target as HTMLTextAreaElement).value);
                  state.requestUpdate?.();
                }}
              ></textarea>
              <div class="agm-code-bar">
                <span>${content.split('\n').length} lines · ${content.length.toLocaleString()} chars</span>
                ${isDirty ? html`<span class="agm-dirty">Unsaved changes</span>` : ''}
              </div>
            </div>
          `;
        })}
      ` : ''}
    </div>
  `;
}

function renderMcpsTab(
  agent: AgentListEntry,
  mgmt: AgentsManagementState,
  state: AppViewState,
  client: GatewayBrowserClient
) {
  const selectedMcps = new Set(agent.mcps || []);
  const availableMcps = mgmt.availableMcps || [];

  return html`
    <div class="agm-ed">
      ${edHead(icons.plug, "MCP server allow-list", availableMcps.length ? html`<b>${selectedMcps.size}</b>/${availableMcps.length} selected` : undefined)}
      <p class="agm-ed-hint">Select which MCP servers this agent can access. Empty means every MCP server is allowed.</p>

      ${availableMcps.length === 0
        ? glassEmpty({ icon: icons.plug, title: "No MCP servers configured", sub: "Add an MCP server on the MCP page and it shows up here." })
        : html`
          <div class="agm-check-grid agm-check-grid--wide">
            ${availableMcps.map((mcp) =>
              checkTile(mcp, selectedMcps.has(mcp), () => {
                updateAgentMcps(state, client, agent.id, toggleIn(selectedMcps, mcp));
              }),
            )}
          </div>
        `}

      <div class="agm-ed-foot">
        <span>Selected: ${selectedMcps.size} of ${availableMcps.length} MCPs</span>
        ${selectedMcps.size === 0 ? html`<span class="is-open">All MCPs allowed</span>` : nothing}
      </div>
    </div>
  `;
}

function renderSubagentsTab(
  agent: AgentListEntry,
  mgmt: AgentsManagementState,
  state: AppViewState,
  client: GatewayBrowserClient
) {
  const selectedSubagents = new Set(agent.subagents || []);
  const availableAgents = (mgmt.agents || []).filter(a => a.id !== agent.id); // Exclude self

  return html`
    <div class="agm-ed">
      ${edHead(icons.bot, "Sub-agent allow-list", availableAgents.length ? html`<b>${selectedSubagents.size}</b>/${availableAgents.length} selected` : undefined)}
      <p class="agm-ed-hint">Select which agents this agent can spawn as sub-agents. Empty means every agent is allowed.</p>

      ${availableAgents.length === 0
        ? glassEmpty({ icon: icons.bot, title: "No other agents yet", sub: "Create more agents and they show up here as delegation targets." })
        : html`
          <div class="agm-check-grid agm-check-grid--wide">
            ${availableAgents.map((otherAgent) =>
              checkTile(
                html`<span class="agm-check-stack"><b>${otherAgent.name}</b><span>${otherAgent.id}</span></span>`,
                selectedSubagents.has(otherAgent.id),
                () => {
                  updateAgentSubagents(state, client, agent.id, toggleIn(selectedSubagents, otherAgent.id));
                },
                otherAgent.isDefault ? html`<span class="gt-chip" data-tone="gold">Default</span>` : nothing,
              ),
            )}
          </div>
        `}

      <div class="agm-ed-foot">
        <span>Selected: ${selectedSubagents.size} of ${availableAgents.length} agents</span>
        ${selectedSubagents.size === 0 ? html`<span class="is-open">All agents allowed</span>` : nothing}
      </div>
    </div>
  `;
}

function renderReferencesTab(
  agent: AgentListEntry,
  mgmt: AgentsManagementState,
  state: AppViewState,
  client: GatewayBrowserClient
) {
  const addReference = () => {
    const input = document.getElementById(`newRef-${agent.id}`) as HTMLInputElement;
    const value = input?.value.trim();
    if (value) {
      const newReferences = [...(agent.references || []), value];
      updateAgentReferences(state, client, agent.id, newReferences);
      input.value = "";
    }
  };
  return html`
    <div class="agm-ed">
      ${edHead(icons.book, "References", html`${(agent.references || []).length} total`)}
      <p class="agm-ed-hint">Add documents, files or URLs to include in this agent's context.</p>

      <!-- Add New Reference -->
      <div class="agm-add">
        <input
          type="text"
          class="gt-input agm-input agm-mono"
          placeholder="File path, URL, or document identifier…"
          aria-label="New reference"
          id="newRef-${agent.id}"
          @keydown=${(e: KeyboardEvent) => { if (e.key === "Enter") { e.preventDefault(); addReference(); } }}
        />
        <button type="button" class="gt-btn gt-primary agm-sm" @click=${addReference}>${icons.plus} Add</button>
      </div>

      <!-- References List -->
      ${(agent.references || []).length === 0
        ? glassEmpty({ icon: icons.book, title: "No references yet", sub: "Add a file path, URL or document identifier above." })
        : html`
          <div class="agm-rows">
            ${(agent.references || []).map((ref, index) => html`
              <div class="agm-row">
                <div class="agm-row-main">
                  <span class="agm-row-title is-mono" title=${ref}>${ref}</span>
                  <span class="agm-row-sub">${ref.startsWith('http') ? 'URL' : ref.includes('/') || ref.includes('\\') ? 'File path' : 'Identifier'}</span>
                </div>
                <button
                  type="button"
                  class="gt-btn gt-danger agm-xs"
                  @click=${() => {
                    if (confirm(`Remove reference: ${ref}?`)) {
                      const newReferences = (agent.references || []).filter((_, i) => i !== index);
                      updateAgentReferences(state, client, agent.id, newReferences);
                    }
                  }}
                >
                  Remove
                </button>
              </div>
            `)}
          </div>
        `}
    </div>
  `;
}

function renderPromptTab(
  agent: AgentListEntry,
  mgmt: AgentsManagementState,
  state: AppViewState,
  client: GatewayBrowserClient
) {
  const isEditing = editingMode.has(agent.id);
  const draft = promptDrafts.get(agent.id);
  const isSaving = savingPrompts.has(agent.id);
  const hasCustomPrompt = !!agent.systemPrompt;

  // What to show in the editor
  const displayValue = draft ?? agent.systemPrompt ?? "";
  const isDirty = draft !== undefined && draft !== (agent.systemPrompt || "");

  // Effective prompt description for read-only view
  const effectivePrompt = hasCustomPrompt
    ? agent.systemPrompt
    : mgmt.defaultSystemPrompt || BUILTIN_PROMPT_DESCRIPTION;
  const promptSource = hasCustomPrompt
    ? "Custom prompt (per-agent)"
    : mgmt.defaultSystemPrompt
      ? "Inherited from agents.defaults.systemPrompt"
      : "Built-in default (assembled at runtime)";

  return html`
    <div class="agm-ed">
      <div class="agm-ed-head">
        <div>
          <h3 class="agm-ed-title">
            <span class="agm-ico">${icons.penLine}</span>System prompt
            ${hasCustomPrompt
              ? html`<span class="gt-chip" data-tone="gold">Custom</span>`
              : html`<span class="gt-chip">Default</span>`}
          </h3>
          <p class="agm-ed-hint agm-ed-hint--head">${promptSource}</p>
        </div>
        <div class="agm-actions">
          ${!isEditing ? html`
            <button type="button" class="gt-btn gt-primary agm-sm" @click=${() => {
              editingMode.add(agent.id);
              // Pre-fill draft with current custom prompt if exists
              if (hasCustomPrompt && !promptDrafts.has(agent.id)) {
                promptDrafts.set(agent.id, agent.systemPrompt);
              }
              state.requestUpdate?.();
            }}>
              ${icons.edit} ${hasCustomPrompt ? "Edit" : "Customize"}
            </button>
          ` : html`
            <button type="button" class="gt-btn agm-sm" @click=${() => {
              editingMode.delete(agent.id);
              promptDrafts.delete(agent.id);
              state.requestUpdate?.();
            }}>
              Cancel
            </button>
          `}
        </div>
      </div>

      <div class="agm-prompt-body">
        ${isEditing
          ? renderPromptEditor(agent, displayValue, isDirty, isSaving, mgmt, state, client)
          : renderPromptPreview(effectivePrompt, hasCustomPrompt)}
      </div>
    </div>
  `;
}

// ============================================================
// Type Selector (Native / CLI)
// ============================================================

function renderTypeSelector(
  agent: AgentListEntry,
  mgmt: AgentsManagementState,
  state: AppViewState,
  client: GatewayBrowserClient
) {
  return html`
    <select
      class="agm-select ${agent.type === "cli" ? "is-cli" : ""}"
      aria-label="Agent type"
      .value=${agent.type || "native"}
      @change=${async (e: Event) => {
        const newType = (e.target as HTMLSelectElement).value as AgentType;
        if (newType !== agent.type) {
          if (confirm(`Switch "${agent.name}" to ${newType === "cli" ? "CLI" : "Native"} mode?\n\n${
            newType === "cli"
              ? "CLI fields (cliCommand, autoApprove, etc.) will be enabled.\nModel and systemPrompt will be cleared."
              : "Native fields (model, systemPrompt) will be restored.\nCLI config will be cleared."
          }`)) {
            await updateAgentType(state, client, agent.id, newType);
          } else {
            (e.target as HTMLSelectElement).value = agent.type;
          }
        }
      }}
    >
      <option value="native">Native</option>
      <option value="cli">CLI</option>
    </select>
  `;
}

// ============================================================
// CLI Config Tab
// ============================================================

function renderCLIConfigTab(
  agent: AgentListEntry,
  mgmt: AgentsManagementState,
  state: AppViewState,
  client: GatewayBrowserClient
) {
  const CLI_TOOL_OPTIONS = [
    "Edit", "Write", "Read", "Bash", "Grep", "Glob",
    "WebSearch", "WebFetch", "NotebookEdit", "Agent",
  ];
  const allowed = new Set(agent.allowedTools || []);

  return html`
    <div class="agm-ed">
      ${edHead(icons.terminal, "CLI agent configuration", "subprocess mode")}

      <div class="agm-fields agm-fields--spaced">
        <!-- CLI Command -->
        <label class="agm-field">
          <span class="agm-label">CLI command</span>
          <input
            type="text"
            class="gt-input agm-input agm-mono"
            placeholder="claude"
            .value=${agent.cliCommand || ""}
            @change=${async (e: Event) => {
              const val = (e.target as HTMLInputElement).value.trim();
              await updateAgentCLIConfig(state, client, agent.id, { cliCommand: val || undefined });
            }}
          />
          <span class="agm-help">Executable name or full path (e.g. "claude", "codex", "/usr/local/bin/claude")</span>
        </label>

        <!-- CLI Args -->
        <label class="agm-field">
          <span class="agm-label">CLI arguments</span>
          <input
            type="text"
            class="gt-input agm-input agm-mono"
            placeholder="--verbose --model claude-sonnet-4-5"
            .value=${(agent.cliArgs || []).join(" ")}
            @change=${async (e: Event) => {
              const val = (e.target as HTMLInputElement).value.trim();
              const args = val ? val.split(/\s+/) : [];
              await updateAgentCLIConfig(state, client, agent.id, { cliArgs: args.length ? args : undefined });
            }}
          />
          <span class="agm-help">Space-separated extra arguments appended to the command</span>
        </label>

        <!-- Timeout + Auto-Approve Row -->
        <div class="agm-row2">
          <label class="agm-field">
            <span class="agm-label">Timeout (minutes)</span>
            <input
              type="number"
              class="gt-input agm-input agm-mono"
              min="1"
              max="1440"
              .value=${String(agent.timeoutMinutes ?? 30)}
              @change=${async (e: Event) => {
                const val = parseInt((e.target as HTMLInputElement).value) || 30;
                await updateAgentCLIConfig(state, client, agent.id, { timeoutMinutes: val });
              }}
            />
          </label>

          <div class="agm-field">
            <span class="agm-label">Auto-approve</span>
            <label class="agm-toggle ${agent.autoApprove ? "is-danger" : ""}">
              <input
                type="checkbox"
                ?checked=${agent.autoApprove}
                @change=${async (e: Event) => {
                  const checked = (e.target as HTMLInputElement).checked;
                  await updateAgentCLIConfig(state, client, agent.id, { autoApprove: checked });
                }}
              />
              <span class="agm-switch" aria-hidden="true"></span>
              <span class="agm-toggle-text">${agent.autoApprove ? "Enabled (dangerous)" : "Disabled (safe)"}</span>
            </label>
          </div>
        </div>

        <!-- Allowed Tools Grid -->
        <div class="agm-field">
          <span class="agm-label">Allowed tools</span>
          <span class="agm-help">Tool categories the CLI agent can use. Empty means the CLI's own defaults.</span>
          <div class="agm-check-grid agm-check-grid--spaced">
            ${CLI_TOOL_OPTIONS.map((tool) =>
              checkTile(tool, allowed.has(tool), async () => {
                const current = new Set(agent.allowedTools || []);
                if (current.has(tool)) current.delete(tool); else current.add(tool);
                await updateAgentCLIConfig(state, client, agent.id, { allowedTools: current.size ? Array.from(current) : undefined });
              }),
            )}
          </div>
        </div>
      </div>
    </div>
  `;
}

// ============================================================
// Model Selector
// ============================================================

function renderModelSelector(
  agent: AgentListEntry,
  mgmt: AgentsManagementState,
  state: AppViewState,
  client: GatewayBrowserClient
) {
  const availableModels = mgmt.availableModels || {};
  const providers = Object.keys(availableModels);

  // Current model (format: provider/model or just model)
  const currentModel = agent.model === "default" ? "" : agent.model;

  return html`
    <select
      class="agm-select"
      aria-label="Model"
      .value=${currentModel}
      @change=${async (e: Event) => {
        const selectedValue = (e.target as HTMLSelectElement).value;
        await updateAgentModel(state, client, agent.id, selectedValue);
      }}
    >
      <option value="">Default</option>
      ${providers.map(provider => {
        const models = availableModels[provider] || [];
        if (models.length === 0) return nothing;

        return html`
          <optgroup label="${provider}">
            ${models.map(model => {
              const fullModel = `${provider}/${model}`;
              return html`
                <option value=${fullModel} ?selected=${fullModel === currentModel}>
                  ${model}
                </option>
              `;
            })}
          </optgroup>
        `;
      })}
    </select>
  `;
}

// ============================================================
// System Prompt Preview (Read-Only)
// ============================================================

function renderPromptPreview(content: string, isCustom: boolean) {
  const lineCount = content.split("\n").length;
  const charCount = content.length;

  return html`
    <div>
      <pre class="agm-code ${isCustom ? "" : "is-default"}">${content}</pre>
      <div class="agm-code-bar">
        <span>${lineCount} lines · ${charCount.toLocaleString()} chars</span>
        <span>${isCustom ? "Custom prompt active" : "Read-only. Choose Customize to override."}</span>
      </div>
    </div>
  `;
}

// ============================================================
// System Prompt Editor (Editable)
// ============================================================

function renderPromptEditor(
  agent: AgentListEntry,
  currentValue: string,
  isDirty: boolean,
  isSaving: boolean,
  mgmt: AgentsManagementState,
  state: AppViewState,
  client: GatewayBrowserClient
) {
  const hasCustomPrompt = !!agent.systemPrompt;
  const charCount = currentValue.length;

  return html`
    <div>
      <div class="agm-code-bar agm-code-bar--top">
        <span class="agm-label">Editor</span>
        ${isDirty ? html`<span class="agm-dirty">Unsaved changes</span>` : nothing}
      </div>

      <textarea
        class="agm-code ${isDirty ? "is-dirty" : ""}"
        aria-label="System prompt for ${agent.name}"
        spellcheck="false"
        .value=${currentValue}
        placeholder=${`Enter a custom system prompt for the "${agent.name}" agent.\n\nThis replaces the built-in core prompt.\nContext files (SOUL.md, USER.md, AGENTS.md, etc.) are still appended.\n\nLeave empty to use the default built-in prompt.`}
        ?disabled=${isSaving}
        @input=${(e: Event) => {
          const val = (e.target as HTMLTextAreaElement).value;
          promptDrafts.set(agent.id, val);
          state.requestUpdate?.();
        }}
      ></textarea>

      <!-- Status Bar -->
      <div class="agm-code-bar">
        <span>
          ${charCount > 0 ? `${charCount.toLocaleString()} chars` : "Empty (using default)"}
          ${mgmt.defaultSystemPrompt ? html`
            <span title="A global default system prompt is configured in agents.defaults.systemPrompt">
              · Global default: ${mgmt.defaultSystemPrompt.length.toLocaleString()} chars
            </span>
          ` : nothing}
        </span>

        <div class="agm-actions">
          ${hasCustomPrompt ? html`
            <button type="button" class="gt-btn gt-danger agm-xs"
              ?disabled=${isSaving}
              @click=${async () => {
                if (!confirm("Clear this agent's custom system prompt?\nIt will revert to the default.")) return;
                savingPrompts.add(agent.id);
                state.requestUpdate?.();
                await updateAgentSystemPrompt(state, client, agent.id, "");
                promptDrafts.delete(agent.id);
                editingMode.delete(agent.id);
                savingPrompts.delete(agent.id);
                state.requestUpdate?.();
              }}>
              Reset to default
            </button>
          ` : nothing}

          ${isDirty ? html`
            <button type="button" class="gt-btn agm-xs"
              @click=${() => {
                promptDrafts.delete(agent.id);
                state.requestUpdate?.();
              }}>
              Discard changes
            </button>
          ` : nothing}

          <button type="button" class="gt-btn gt-primary agm-xs"
            ?disabled=${!isDirty || isSaving}
            @click=${async () => {
              savingPrompts.add(agent.id);
              state.requestUpdate?.();
              const success = await updateAgentSystemPrompt(state, client, agent.id, currentValue);
              if (success) {
                promptDrafts.delete(agent.id);
                // Stay in edit mode so they can keep refining
              }
              savingPrompts.delete(agent.id);
              state.requestUpdate?.();
            }}>
            ${isSaving ? "Saving…" : html`${icons.save} Save`}
          </button>
        </div>
      </div>

      <!-- Help text -->
      <details class="agm-details">
        <summary>${icons.alertCircle} How system prompts work</summary>
        <div class="agm-details-body">
          <p><strong>Custom prompt</strong> replaces the built-in core instructions for this agent.</p>
          <p><strong>Context files</strong> from the agent's workspace (SOUL.md, USER.md, AGENTS.md, TOOLS.md, IDENTITY.md, etc.) are always appended automatically. They are NOT replaced.</p>
          <p><strong>Empty prompt</strong> means the agent uses the built-in default, which includes tool usage guidelines, workspace rules, memory recall instructions, and more.</p>
          <p class="agm-details-lead"><strong>Inheritance:</strong> Per-agent prompt → <code>agents.defaults.systemPrompt</code> → built-in default.</p>
        </div>
      </details>
    </div>
  `;
}

// ============================================================
// Session Row
// ============================================================

function renderSessionRow(session: AgentSessionInfo) {
  const timeAgo = session.updatedAt ? formatTimeAgo(session.updatedAt) : "—";
  const tokens = session.totalTokens ? formatTokenCount(session.totalTokens) : "";
  const kindBadge = session.kind === "subagent"
    ? html`<span class="gt-chip">sub</span>`
    : session.kind === "main"
      ? html`<span class="gt-chip" data-tone="gold">main</span>`
      : nothing;

  // Best display name: label > derivedTitle > displayName > key
  const name = session.label || session.derivedTitle || session.displayName || session.key;
  const truncatedName = name.length > 50 ? name.slice(0, 50) + "…" : name;

  return html`
    <div class="agm-row">
      <span class="gt-light" data-state=${session.active ? "ok" : "idle"} ?data-pulse=${session.active} title=${session.active ? "Active" : "Idle"}></span>
      <span class="agm-row-main">
        <span class="agm-row-title ${session.active ? "" : "is-idle"}" title="${name}">${truncatedName}</span>
        ${session.channel || tokens
          ? html`<span class="agm-row-sub">${[session.channel, tokens].filter(Boolean).join(" · ")}</span>`
          : nothing}
      </span>
      ${kindBadge}
      <span class="agm-row-meta">${timeAgo}</span>
    </div>
  `;
}

function formatTimeAgo(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 5000) return "now";
  if (diff < 60000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
}

function formatTokenCount(n: number): string {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M tok`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K tok`;
  return `${n} tok`;
}

// ============================================================
// Create Dialog
// ============================================================

function renderCreateDialog(state: AppViewState, client: GatewayBrowserClient) {
  const mgmt = state.agentsManagementState;
  if (!mgmt) return nothing;

  const draft = mgmt.editingAgent || {};
  const isCli = draft.type === "cli";
  const dialogError = mgmt.error && mgmt.error !== errorBeforeCreate ? mgmt.error : null;

  const close = () => {
    if (!state.agentsManagementState) return;
    state.agentsManagementState.showCreateDialog = false;
    state.agentsManagementState.editingAgent = null;
    // Drop a validation / create error raised by this dialog; keep a roster error.
    if (state.agentsManagementState.error !== errorBeforeCreate) state.agentsManagementState.error = errorBeforeCreate;
    state.requestUpdate?.();
  };
  const setDraft = (patch: Partial<InfiniBotAgent>, rerender = false) => {
    if (!state.agentsManagementState) return;
    // Merge into the current draft because ordinary input events deliberately
    // avoid a full modal re-render. Using the render-time snapshot here would
    // let the next field edit silently discard the previous one.
    state.agentsManagementState.editingAgent = {
      ...(state.agentsManagementState.editingAgent || {}),
      ...patch,
    };
    if (rerender) state.requestUpdate?.();
  };

  return html`
    <div
      class="agm-modal-scrim"
      @click=${(e: MouseEvent) => { if (e.target === e.currentTarget) close(); }}
      @keydown=${(e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); close(); } }}
    >
      <div class="agm-modal gt-scope" role="dialog" aria-modal="true" aria-labelledby="agm-create-title" data-learn-id="agents-create-dialog">
        <div class="agm-modal-head">
          <div class="agm-modal-orb">${icons.sparkles}</div>
          <div class="agm-modal-titles">
            <span class="gt-eyebrow">New agent</span>
            <h2 class="agm-modal-title" id="agm-create-title">Create an agent</h2>
            <p class="agm-modal-sub">A native agent talks to a model directly. A CLI agent drives a coder like Claude Code or Codex.</p>
          </div>
          <button type="button" class="agm-modal-close" aria-label="Close" @click=${close}>${icons.x}</button>
        </div>

        <div class="agm-modal-body agm-modal-body--flush">
          ${dialogError ? html`<div class="agm-error" role="alert"><span class="gt-light" data-state="danger"></span><span>${dialogError}</span></div>` : nothing}

          <div class="agm-fields">
            <div class="agm-row2">
              <!-- Agent ID -->
              <label class="agm-field">
                <span class="agm-label">Agent ID<span class="agm-req">*</span></span>
                <input type="text" class="gt-input agm-input agm-mono" data-learn-id="agents-create-id" placeholder="my-agent" value=${draft.id || ""}
                  autocomplete="off" spellcheck="false"
                  @input=${(e: Event) => setDraft({ id: (e.target as HTMLInputElement).value })}
                />
                <span class="agm-help">Unique identifier (lowercase, no spaces)</span>
              </label>

              <!-- Name -->
              <label class="agm-field">
                <span class="agm-label">Display name</span>
                <input type="text" class="gt-input agm-input" placeholder="My Agent" value=${draft.name || ""}
                  @input=${(e: Event) => setDraft({ name: (e.target as HTMLInputElement).value })}
                />
              </label>
            </div>

            <!-- Agent Type Selector -->
            <div class="agm-field" data-learn-id="agents-create-type">
              <span class="agm-label">Agent type</span>
              <div class="agm-choice-grid" role="group" aria-label="Agent type">
                <button type="button" class="agm-choice" aria-pressed=${!isCli ? "true" : "false"}
                  @click=${() => setDraft({ type: 'native' }, true)}>
                  <b>${icons.sparkles} Native</b>
                  <span>Direct LLM API</span>
                </button>
                <button type="button" class="agm-choice" aria-pressed=${isCli ? "true" : "false"}
                  @click=${() => setDraft({ type: 'cli' }, true)}>
                  <b>${icons.terminal} CLI</b>
                  <span>Subprocess (coder CLI)</span>
                </button>
              </div>
            </div>

            <!-- Workspace -->
            <label class="agm-field">
              <span class="agm-label">Workspace<span class="agm-req">*</span></span>
              <input type="text" class="gt-input agm-input agm-mono" placeholder="~/infinibot-new" value=${draft.workspace || ""}
                spellcheck="false"
                @input=${(e: Event) => setDraft({ workspace: (e.target as HTMLInputElement).value })}
              />
            </label>

            <!-- Native-specific fields -->
            ${!isCli ? html`
              <!-- Model -->
              <label class="agm-field">
                <span class="agm-label">Model<span class="agm-opt">(optional)</span></span>
                <input type="text" class="gt-input agm-input agm-mono" placeholder="anthropic/claude-opus-4-5" value=${draft.model || ""}
                  spellcheck="false"
                  @input=${(e: Event) => setDraft({ model: (e.target as HTMLInputElement).value })}
                />
              </label>

              <!-- System Prompt -->
              <label class="agm-field">
                <span class="agm-label">System prompt<span class="agm-opt">(optional)</span></span>
                <textarea class="agm-code agm-code--sm" placeholder="Leave empty for default. Enter custom instructions to define this agent's behavior."
                  .value=${draft.systemPrompt || ""}
                  @input=${(e: Event) => setDraft({ systemPrompt: (e.target as HTMLTextAreaElement).value })}
                ></textarea>
              </label>
            ` : html`
              <!-- CLI-specific fields -->
              <label class="agm-field">
                <span class="agm-label">CLI command<span class="agm-req">*</span></span>
                <input type="text" class="gt-input agm-input agm-mono" placeholder="claude" value=${draft.cliCommand || ""}
                  spellcheck="false"
                  @input=${(e: Event) => setDraft({ cliCommand: (e.target as HTMLInputElement).value })}
                />
                <span class="agm-help">e.g. "claude", "codex", "/usr/local/bin/claude"</span>
              </label>

              <!-- Timeout + Auto-Approve -->
              <div class="agm-row2">
                <label class="agm-field">
                  <span class="agm-label">Timeout (min)</span>
                  <input type="number" class="gt-input agm-input agm-mono" min="1" max="1440" value=${draft.timeoutMinutes ?? 30}
                    @input=${(e: Event) => setDraft({ timeoutMinutes: parseInt((e.target as HTMLInputElement).value) || 30 })}
                  />
                </label>
                <div class="agm-field">
                  <span class="agm-label">Auto-approve</span>
                  <label class="agm-toggle ${draft.autoApprove ? "is-danger" : ""}">
                    <input type="checkbox" ?checked=${draft.autoApprove || false}
                      @change=${(e: Event) => setDraft({ autoApprove: (e.target as HTMLInputElement).checked }, true)}
                    />
                    <span class="agm-switch" aria-hidden="true"></span>
                    <span class="agm-toggle-text">${draft.autoApprove ? "Dangerous" : "Disabled"}</span>
                  </label>
                </div>
              </div>
            `}

            <!-- Default Checkbox -->
            <label class="agm-toggle">
              <input type="checkbox" ?checked=${draft.default || false}
                @change=${(e: Event) => setDraft({ default: (e.target as HTMLInputElement).checked }, true)}
              />
              <span class="agm-switch" aria-hidden="true"></span>
              <span>Set as default agent</span>
            </label>
          </div>
        </div>

        <div class="agm-modal-foot">
          <span class="agm-foot-note">Workspace files stay on disk if you delete the agent later.</span>
          <button type="button" class="gt-btn" @click=${close} data-learn-id="agents-create-cancel">Cancel</button>
          <button type="button" class="gt-btn gt-primary" @click=${async () => {
            if (!state.agentsManagementState) return;
            const currentDraft = state.agentsManagementState.editingAgent || {};
            if (!currentDraft.id || !currentDraft.workspace) {
              state.agentsManagementState.error = "Agent ID and workspace are required";
              state.requestUpdate?.();
              return;
            }
            if (currentDraft.type === "cli" && !currentDraft.cliCommand) {
              state.agentsManagementState.error = "CLI Command is required for CLI agents";
              state.requestUpdate?.();
              return;
            }
            const success = await createAgentEntry(state, client, currentDraft as InfiniBotAgent);
            if (success) {
              state.agentsManagementState.showCreateDialog = false;
              state.agentsManagementState.editingAgent = null;
            }
            state.requestUpdate?.();
          }} data-learn-id="agents-create-submit">${icons.plus} Create agent</button>
        </div>
      </div>
    </div>
  `;
}
