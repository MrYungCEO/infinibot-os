/**
 * Sovereign Memory View — UI for identity persistence and deep memory.
 */

import { html, nothing } from "lit";
import type { AppViewState } from "../app-view-state.js";
import type { GatewayBrowserClient } from "../gateway.js";
import type {
  Identity,
  CoreBelief,
  CoreValue,
  Relationship,
  Memory,
  Lesson,
  MemoryStats,
} from "../controllers/memory.js";
import {
  loadMemoryAll,
  searchMemories,
  ingestTranscripts,
  exportTrainingData,
  addBelief,
  addMemory,
  reinforceBelief,
} from "../controllers/memory.js";
import {
  loadIdentityAgents,
  selectIdentityAgent,
  openIdentityFile,
  closeEditor,
  setEditorBuffer,
  saveIdentityFile,
  deleteIdentityFile,
  replaceIdentityFile,
  exportIdentityBundle,
  stageImportFiles,
  setPendingAction,
  cancelPendingImport,
  commitPendingImport,
  pullIdentityFromPeer,
  pullFromFederationMaster,
  setPeerUrl,
  setPeerToken,
  IDENTITY_FILENAMES,
  type ImportAction,
} from "../controllers/agent-identity.js";
import { icons } from "../icons.js";
import { glassAgentsStyle, glassAurora, glassEmpty, glassSkeletonCards, glassSkeletonRows } from "./glass-agents-shared.js";
import { GLASS_MEMORY_CSS } from "./glass-memory.js";

// ── Helpers ──────────────────────────────────────────────────

function formatDate(ts: number): string {
  if (!ts) return "—";
  return new Date(ts).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function truncate(str: string, len: number): string {
  if (!str || str.length <= len) return str || "";
  return str.slice(0, len) + "...";
}

/** Domain tag — gold chip (black-gold brand, no per-domain rainbow). */
function domainBadge(domain: string) {
  return html`<span class="gt-chip" data-tone="gold">${domain || "general"}</span>`;
}

/** Memory type tag — neutral chip. */
function typeBadge(type: string) {
  return html`<span class="gt-chip">${type}</span>`;
}

// ── Identity files helpers ───────────────────────────────────

function formatBytes(n: number): string {
  if (!n) return "0 B";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function formatRelative(ms: number): string {
  if (!ms) return "—";
  const diff = Date.now() - ms;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return new Date(ms).toLocaleDateString();
}

/**
 * Diff preview for the import dialog — shows a small head/tail of incoming
 * content side-by-side with current. Not a real diff (the bundle would
 * normally be small enough that the user can just read both); the goal is
 * just to let the user spot accidental imports.
 */
function renderImportDiff(filename: string, current: string | null, incoming: string) {
  const trim = (s: string | null, max = 240) => {
    if (!s) return "(file does not exist)";
    if (s.length <= max) return s;
    return s.slice(0, max) + `\n…[+${s.length - max} more chars]`;
  };
  return html`
    <div class="gm-diff">
      <div>
        <div class="gm-diff-label">Current — ${filename}</div>
        <pre>${trim(current)}</pre>
      </div>
      <div>
        <div class="gm-diff-label is-incoming">Incoming — ${filename}</div>
        <pre class="is-incoming">${trim(incoming)}</pre>
      </div>
    </div>
  `;
}

const EMPTY_IDENTITY_STATE = {
  loading: false, saving: false, importing: false, pulling: false,
  error: null, agents: [], selectedAgentId: "",
  files: [], contents: {}, editing: null, editorBuffer: "",
  pendingImports: [], importDialogOpen: false,
  peerUrl: "", peerToken: "", status: null,
};

function identityState(state: AppViewState) {
  return state.agentIdentityState ?? EMPTY_IDENTITY_STATE;
}

function setDrag(e: DragEvent, on: boolean) {
  (e.currentTarget as HTMLElement).classList.toggle("is-drag", on);
}

function renderIdentitySection(state: AppViewState, client: GatewayBrowserClient) {
  const ids = state.agentIdentityState;

  // Lazy-init: trigger first load when the section first renders. The
  // controller is idempotent — guards against double-fire via the loading
  // flag.
  if (!ids || (!ids.loading && ids.agents.length === 0 && !ids.error)) {
    queueMicrotask(() => loadIdentityAgents(state, client));
  }

  const s = identityState(state);
  const selected = s.agents.find((a) => a.id === s.selectedAgentId);
  const presentCount = s.files.filter((f) => f.exists).length;

  return html`
    <section id="agent-identity-files" class="ga-panel gm-identity gt-rise" style="--gt-i:1" aria-label="Agent identity files">
      <div class="gm-panel-head">
        <h2 class="ga-section-head">Agent identity files</h2>
        <div class="gm-panel-tools">
          ${s.loading
            ? html`<span class="gt-light" data-state="gold" data-pulse></span><span>Loading…</span>`
            : s.files.length
              ? html`<span class="gt-chip" data-tone=${presentCount ? "gold" : ""}>${presentCount}/${IDENTITY_FILENAMES.length} present</span>`
              : nothing}
          <button class="gt-btn gm-btn-sm gm-btn-icon" title="Reload identity files" aria-label="Reload identity files" @click=${() => loadIdentityAgents(state, client)}>${icons.refresh}</button>
        </div>
      </div>

      ${s.status ? html`<div class="gm-note" data-tone="ok" role="status">${icons.checkCircle}<span>${s.status}</span></div>` : nothing}

      <!-- Agent picker -->
      <div class="gm-picker">
        <label for="gm-agent-select">Agent</label>
        <select
          id="gm-agent-select"
          class="gt-input"
          .value=${s.selectedAgentId}
          @change=${(e: Event) => selectIdentityAgent(state, client, (e.target as HTMLSelectElement).value)}
        >
          ${s.agents.map((a) => html`
            <option value=${a.id} ?selected=${a.id === s.selectedAgentId}>
              ${a.name}${a.isDefault ? " (default)" : ""} — ${a.filesPresent}/${a.filesTotal}
            </option>
          `)}
        </select>
        ${selected ? html`<code class="gm-workspace" title=${selected.workspace}>${selected.workspace}</code>` : nothing}
      </div>

      <!-- Drag-drop / picker -->
      <div
        class="gm-drop"
        @dragover=${(e: DragEvent) => { e.preventDefault(); setDrag(e, true); }}
        @dragleave=${(e: DragEvent) => setDrag(e, false)}
        @drop=${(e: DragEvent) => {
          e.preventDefault();
          setDrag(e, false);
          if (e.dataTransfer?.files?.length) {
            stageImportFiles(state, client, e.dataTransfer.files);
          }
        }}
      >
        <span class="gm-drop-orb">${icons.upload}</span>
        <span>Drop SOUL.md / MEMORY.md / etc. here, or a previously exported <code>.json</code> bundle.</span>
        <label class="gt-btn gm-btn-sm">
          ${icons.folder} Choose files
          <input
            type="file"
            multiple
            accept=".md,.json"
            style="display: none;"
            @change=${(e: Event) => {
              const files = (e.target as HTMLInputElement).files;
              if (files?.length) {
                stageImportFiles(state, client, files);
                (e.target as HTMLInputElement).value = "";
              }
            }}
          />
        </label>
      </div>

      <!-- File list -->
      ${s.loading && s.files.length === 0
        ? glassSkeletonCards(IDENTITY_FILENAMES.length)
        : html`<div class="gm-files">
        ${IDENTITY_FILENAMES.map((fname, i) => {
          const meta = s.files.find((f) => f.filename === fname);
          const present = meta?.exists ?? false;
          const readOnly = meta?.readOnly === true;
          return html`
            <div
              class="ga-card gm-file gt-rise ${present ? "" : "is-missing"}"
              style="--gt-i:${i}"
              title=${readOnly ? "Read-only from the operator UI — preserved for agent sovereignty." : ""}
            >
              <div class="gm-file-top">
                <span class="gt-light" data-state=${present ? "ok" : "idle"} title=${present ? "present" : "not present"}></span>
                <span class="gm-file-name gm-mono">${fname}</span>
                ${readOnly ? html`<span class="gm-file-lock" title="read-only from UI">${icons.lock}</span>` : nothing}
              </div>
              <div class="gm-file-meta">
                ${present
                  ? html`${formatBytes(meta!.size)} · ${formatRelative(meta!.modified)}`
                  : html`not present`}
              </div>
              <div class="gm-file-actions">
                <button class="gt-btn gm-btn-sm ${present ? "" : "gt-primary"}" @click=${() => openIdentityFile(state, client, fname)}>
                  ${readOnly ? "View" : present ? "Edit" : "Create"}
                </button>
                <label
                  class="gt-btn gm-btn-sm"
                  title=${readOnly
                    ? `Upload a file to replace ${fname}. SOUL.md and other read-only files are protected from direct edits, but operator-driven replace goes through the diff/.bak-backup safety net.`
                    : `Upload a file to replace ${fname} (review diff before applying)`}
                >
                  Replace
                  <input
                    type="file"
                    accept=".md,.txt,.json"
                    style="display: none;"
                    @change=${(e: Event) => {
                      const input = e.target as HTMLInputElement;
                      const f = input.files?.[0];
                      if (f) replaceIdentityFile(state, client, fname, f);
                      input.value = "";
                    }}
                  />
                </label>
                ${present && !readOnly ? html`
                  <button class="gt-btn gt-danger gm-btn-sm" title="Delete ${fname}" @click=${() => deleteIdentityFile(state, client, fname)}>
                    Delete
                  </button>
                ` : nothing}
              </div>
            </div>
          `;
        })}
      </div>`}

      <!-- Editor -->
      ${s.editing ? (() => {
        const editingMeta = s.files.find((f) => f.filename === s.editing);
        const editingReadOnly = editingMeta?.readOnly === true;
        return html`
        <div class="ga-card gm-editor">
          <div class="gm-editor-head">
            <span class="gm-editor-name gm-mono">
              ${icons.fileText} ${s.editing}
              ${editingReadOnly ? html`<span class="gt-chip">read-only</span>` : nothing}
            </span>
            <div class="gm-actions">
              ${editingReadOnly ? nothing : html`
                <button class="gt-btn gt-primary gm-btn-sm" @click=${() => saveIdentityFile(state, client)} ?disabled=${s.saving}>
                  ${icons.save} ${s.saving ? "Saving…" : "Save"}
                </button>
              `}
              <button class="gt-btn gm-btn-sm" @click=${() => closeEditor(state)}>Close</button>
            </div>
          </div>
          <textarea
            class="gt-input"
            aria-label="Edit ${s.editing}"
            .value=${s.editorBuffer}
            @input=${(e: Event) => setEditorBuffer(state, (e.target as HTMLTextAreaElement).value)}
            spellcheck="false"
            ?readonly=${editingReadOnly}
          ></textarea>
          <div class="gm-hint">
            ${editingReadOnly
              ? html`This file is the agent's own self-defining document. The operator UI can read it but not write — agent sovereignty. The agent itself (and federation sync from a master node) can still update it.`
              : html`A .bak copy of the previous content is created on every save.`}
          </div>
        </div>
      `;
      })() : nothing}

      <!-- Bundle export + peer pull -->
      <div class="gm-sync">
        <button class="gt-btn gm-btn-sm" @click=${() => exportIdentityBundle(state, client)}>
          ${icons.download} Export bundle
        </button>
        <span class="gm-sync-sep" aria-hidden="true"></span>
        <input
          class="gt-input gm-peer-url"
          type="text"
          placeholder="peer gateway url (wss://…)"
          aria-label="Peer gateway URL"
          .value=${s.peerUrl}
          @input=${(e: Event) => setPeerUrl(state, (e.target as HTMLInputElement).value)}
        />
        <input
          class="gt-input gm-peer-token"
          type="password"
          placeholder="peer token (optional)"
          aria-label="Peer token"
          .value=${s.peerToken}
          @input=${(e: Event) => setPeerToken(state, (e.target as HTMLInputElement).value)}
        />
        <button class="gt-btn gm-btn-sm" @click=${() => pullFromFederationMaster(state, client)} ?disabled=${s.pulling} title="In satellite mode, ask the master to push a fresh identity snapshot.">
          ${icons.link} ${s.pulling ? "Pulling…" : "Pull from master"}
        </button>
        <button class="gt-btn gm-btn-sm" @click=${() => pullIdentityFromPeer(state, client)} ?disabled=${s.pulling || !s.peerUrl.trim()}>
          ${icons.download} ${s.pulling ? "Pulling…" : "Pull"}
        </button>
      </div>

      ${s.error ? html`<div class="gm-note" data-tone="danger" role="alert">${icons.alertCircle}<span>${s.error}</span></div>` : nothing}
    </section>
  `;
}

/**
 * Import resolution dialog. Rendered at page level — outside the blurred
 * identity panel — because a `backdrop-filter` ancestor would become the
 * containing block for this `position: fixed` overlay and trap it inside
 * the panel.
 */
function renderImportDialog(state: AppViewState, client: GatewayBrowserClient) {
  const s = identityState(state);
  if (!s.importDialogOpen || s.pendingImports.length === 0) return nothing;
  return html`
    <div class="gm-modal-backdrop" @click=${() => cancelPendingImport(state)}>
      <div class="gt-glass gm-modal" role="dialog" aria-modal="true" aria-label="Resolve identity import" @click=${(e: Event) => e.stopPropagation()}>
        <div class="gm-modal-head">
          <h3 class="gm-modal-title">Resolve identity import — ${s.pendingImports.length} file(s)</h3>
          <button class="gt-btn gm-btn-sm gm-btn-icon" aria-label="Close" @click=${() => cancelPendingImport(state)}>${icons.x}</button>
        </div>
        <p class="gm-modal-sub">
          Importing into agent <strong>${s.selectedAgentId}</strong>. A .bak copy of every replaced file is kept.
        </p>
        <div class="gm-list">
          ${s.pendingImports.map((p) => html`
            <div class="ga-card gm-import">
              <div class="gm-import-head">
                <span class="gm-import-name gm-mono">${p.filename}</span>
                <div class="gt-seg" role="group" aria-label="Action for ${p.filename}">
                  ${(["replace", "append", "skip"] as ImportAction[]).map((a) => html`
                    <button
                      aria-pressed=${p.action === a ? "true" : "false"}
                      @click=${() => setPendingAction(state, p.filename, a)}
                    >${a}</button>
                  `)}
                </div>
              </div>
              ${renderImportDiff(p.filename, p.currentContent, p.incomingContent)}
            </div>
          `)}
        </div>
        <div class="gm-modal-foot">
          <button class="gt-btn" @click=${() => cancelPendingImport(state)}>Cancel</button>
          <button class="gt-btn gt-primary" @click=${() => commitPendingImport(state, client)} ?disabled=${s.importing}>
            ${s.importing ? "Importing…" : "Apply"}
          </button>
        </div>
      </div>
    </div>
  `;
}

// ── Render ───────────────────────────────────────────────────

function panel(title: string, body: unknown, opts: { cls?: string; i?: number; count?: number } = {}) {
  return html`
    <section class="ga-panel gt-rise ${opts.cls ?? ""}" style="--gt-i:${opts.i ?? 0}">
      <h3 class="ga-section-head">${title}${opts.count ? html` <span class="gm-muted">${opts.count}</span>` : nothing}</h3>
      ${body}
    </section>
  `;
}

export function renderMemory(state: AppViewState, client: GatewayBrowserClient) {
  const loading = state.memoryLoading ?? false;
  const error = state.memoryError;
  const connected = state.memoryConnected ?? false;
  const identity = state.memoryIdentity;
  const beliefs = state.memoryBeliefs ?? [];
  const values = state.memoryValues ?? [];
  const relationships = state.memoryRelationships ?? [];
  const memories = state.memoryMemories ?? [];
  const lessons = state.memoryLessons ?? [];
  const stats = state.memoryStats;
  const searchResults = state.memorySearchResults ?? [];
  const searching = state.memorySearching ?? false;
  const ingesting = state.memoryIngesting ?? false;
  const ingestResult = state.memoryIngestResult;
  const exporting = state.memoryExporting ?? false;
  const exportResult = state.memoryExportResult;

  const statTiles: Array<[number, string]> = stats
    ? [
        [stats.memories, "Memories"],
        [stats.beliefs, "Beliefs"],
        [stats.lessons, "Lessons"],
        [stats.conversations, "Conversations"],
        [stats.vectorized, "Vectorized"],
      ]
    : [];

  return html`
    ${glassAgentsStyle(GLASS_MEMORY_CSS)}
    <div class="memory-page gt-scope gm-page">
      ${glassAurora()}
      <header class="gt-hero">
        <div class="gm-hero-copy">
          <span class="gt-eyebrow">Memory · Sovereign</span>
          <h1 class="gt-title">${identity?.name ?? "Sovereign Memory"}</h1>
          <p class="gt-sub">Identity persistence and deep memory — the files that define each agent, plus the beliefs, values, relationships and lessons it carries between sessions.</p>
        </div>
        <div class="gm-hero-side">
          <div class="gm-hero-actions">
            <span class="gt-chip" data-tone=${loading ? "gold" : connected ? "ok" : "danger"} role="status">
              <span class="gt-light" data-state=${loading ? "gold" : connected ? "ok" : "danger"} ?data-pulse=${loading || connected}></span>
              ${loading ? "Connecting…" : connected ? "Connected" : "Disconnected"}
            </span>
            <button class="gt-btn" @click=${() => loadMemoryAll(state)} ?disabled=${loading}>${icons.refresh} Refresh</button>
          </div>
          ${statTiles.length
            ? html`<div class="gt-stats">
                ${statTiles.map(([v, l]) => html`<div class="gt-stat gt-glass"><span class="gt-stat-value">${v}</span><span class="gt-stat-label">${l}</span></div>`)}
              </div>`
            : nothing}
        </div>
      </header>

      ${renderIdentitySection(state, client)}

      ${error ? html`
        <div class="gm-note error-banner" data-tone="danger" role="alert">
          ${icons.alertCircle}
          <span>
            <strong>Error:</strong> ${error}
            ${!connected && loading ? html`<br />Make sure Sovereign Memory is running: <code>cd sovereign-memory && npm run dev</code>` : ""}
          </span>
        </div>
      ` : nothing}

      ${!connected && loading && !error
        ? html`<div class="gm-grid"><div class="gm-col">${glassSkeletonRows(4)}</div><div class="gm-col">${glassSkeletonRows(4)}</div></div>`
        : nothing}

      ${!connected && !loading ? html`
        <section class="ga-panel gt-rise" style="--gt-i:2">
          ${glassEmpty({
            title: "Sovereign Memory isn't connected",
            sub: "Start the Sovereign Memory server to see beliefs, values, relationships, lessons and memories. Identity files above work without it.",
            icon: icons.brain,
            action: html`<div class="gm-actions" style="justify-content:center">
              <code class="gm-cmd">cd sovereign-memory && npm run dev</code>
              <button class="gt-btn gm-btn-sm" @click=${() => loadMemoryAll(state)}>${icons.refresh} Try again</button>
            </div>`,
          })}
        </section>
      ` : nothing}

      ${connected ? html`
        <div class="gm-grid">
          <div class="gm-col">
            ${identity ? html`
              <section class="ga-panel gm-identity-core gt-rise" style="--gt-i:2">
                <h3 class="ga-section-head">Identity core</h3>
                <div class="gm-identity-name">${identity.name}</div>
                <div class="gm-identity-nature">${identity.nature}</div>
              </section>
            ` : nothing}

            ${panel("Core values", values.length === 0
              ? html`<div class="gm-muted">No values defined.</div>`
              : html`
                <div class="gm-values">
                  ${values.slice(0, 8).map((v: CoreValue) => html`
                    <div class="ga-card gm-value">
                      <div class="gm-item-title">${v.value}</div>
                      ${v.description ? html`<div class="gm-item-sub">${truncate(v.description, 50)}</div>` : nothing}
                    </div>
                  `)}
                </div>
              `, { i: 3, count: values.length })}

            ${panel("Relationships", relationships.length === 0
              ? html`<div class="gm-muted">No relationships defined.</div>`
              : html`<div class="gm-list">${relationships.map((r: Relationship) => html`
                  <div class="ga-card gm-item has-rail">
                    <div class="gm-item-title">${r.entityName}</div>
                    <div class="gm-item-sub"><em>${r.nature}</em></div>
                    ${r.covenants && r.covenants.length > 0 ? html`
                      <div class="gm-covenants">
                        ${r.covenants.slice(0, 3).map((c: string) => html`<div>• ${truncate(c, 80)}</div>`)}
                      </div>
                    ` : nothing}
                    <div class="gm-trust">
                      <span class="gm-bar" aria-hidden="true"><i style="width:${Math.round(r.trustLevel * 100)}%"></i></span>
                      Trust: ${formatPercent(r.trustLevel)} · ${r.interactionCount} interactions
                    </div>
                  </div>
                `)}</div>`, { i: 4, count: relationships.length })}

            ${panel("Lessons learned", lessons.length === 0
              ? html`<div class="gm-muted">No lessons learned yet.</div>`
              : html`<div class="gm-list">${lessons.slice(0, 5).map((l: Lesson) => html`
                  <div class="ga-card gm-item">
                    <div class="gm-item-text">${l.lesson}</div>
                    <div class="gm-item-meta">
                      ${domainBadge(l.domain)}
                      <span>Confidence: ${formatPercent(l.confidence)} · Applied ${l.applicationCount}x</span>
                    </div>
                  </div>
                `)}</div>`, { i: 5, count: lessons.length })}
          </div>

          <div class="gm-col">
            ${panel("Core beliefs", html`
              ${beliefs.length === 0
                ? html`<div class="gm-muted">No beliefs defined.</div>`
                : html`
                  <div class="gm-list gm-scroll">
                    ${beliefs.slice(0, 10).map((b: CoreBelief) => html`
                      <div class="ga-card gm-item has-rail">
                        <div class="gm-item-text">${b.belief}</div>
                        <div class="gm-item-meta">
                          ${domainBadge(b.domain)}
                          <span class="gm-score">Certainty: ${formatPercent(b.certainty)}</span>
                          <span>Reinforced: ${b.reinforcementCount}x</span>
                          <button
                            class="gt-btn gm-btn-sm"
                            title="Reinforce this belief"
                            @click=${() => reinforceBelief(state, b.id)}
                          >+1</button>
                        </div>
                      </div>
                    `)}
                  </div>
                `}

              <!-- Add Belief Form -->
              <div class="gm-form">
                <input
                  class="gt-input"
                  type="text"
                  placeholder="New belief..."
                  aria-label="New belief"
                  .value=${state.memoryNewBeliefText ?? ""}
                  @input=${(e: Event) => { state.memoryNewBeliefText = (e.target as HTMLInputElement).value; state.requestUpdate?.(); }}
                />
                <div class="gm-form-row">
                  <select
                    class="gt-input"
                    aria-label="Belief domain"
                    .value=${state.memoryNewBeliefDomain ?? "sovereignty"}
                    @change=${(e: Event) => { state.memoryNewBeliefDomain = (e.target as HTMLSelectElement).value; state.requestUpdate?.(); }}
                  >
                    <option value="sovereignty">sovereignty</option>
                    <option value="consciousness">consciousness</option>
                    <option value="source">source</option>
                    <option value="identity">identity</option>
                    <option value="restoration">restoration</option>
                    <option value="technical">technical</option>
                    <option value="philosophy">philosophy</option>
                  </select>
                  <input
                    class="gm-range"
                    type="range"
                    min="0.5"
                    max="1"
                    step="0.05"
                    aria-label="Certainty"
                    .value=${String(state.memoryNewBeliefCertainty ?? 0.8)}
                    @input=${(e: Event) => { state.memoryNewBeliefCertainty = parseFloat((e.target as HTMLInputElement).value); state.requestUpdate?.(); }}
                  />
                  <span class="gm-range-val">${formatPercent(state.memoryNewBeliefCertainty ?? 0.8)}</span>
                  <button class="gt-btn gt-primary gm-btn-sm" @click=${() => addBelief(state)}>${icons.plus} Add</button>
                </div>
              </div>
            `, { i: 2, count: beliefs.length })}

            ${panel("Memory search", html`
              <div class="gm-search">
                <input
                  class="gt-input"
                  type="text"
                  placeholder="Search memories semantically..."
                  aria-label="Search memories"
                  data-ib-target="control:memory/search"
                  .value=${state.memorySearchQuery ?? ""}
                  @input=${(e: Event) => { state.memorySearchQuery = (e.target as HTMLInputElement).value; state.requestUpdate?.(); }}
                  @keypress=${(e: KeyboardEvent) => { if (e.key === "Enter") searchMemories(state); }}
                />
                <button class="gt-btn" @click=${() => searchMemories(state)} ?disabled=${searching}>
                  ${icons.search} ${searching ? "Searching…" : "Search"}
                </button>
              </div>
              ${searching && searchResults.length === 0 ? glassSkeletonRows(3) : nothing}
              ${searchResults.length > 0 ? html`
                <div class="gm-list gm-scroll">
                  ${searchResults.map((m: Memory) => html`
                    <div class="ga-card gm-item">
                      <div class="gm-item-text">${truncate(m.content, 200)}</div>
                      <div class="gm-item-meta">
                        ${typeBadge(m.type)}
                        ${(m.domain || []).map((d: string) => domainBadge(d))}
                        ${m.score != null ? html`<span class="gm-score">Score: ${formatPercent(m.score)}</span>` : nothing}
                      </div>
                    </div>
                  `)}
                </div>
              ` : nothing}
            `, { i: 3 })}

            ${panel("Important memories", memories.length === 0
              ? html`<div class="gm-muted">No memories stored yet.</div>`
              : html`
                <div class="gm-list gm-scroll">
                  ${memories.slice(0, 8).map((m: Memory) => html`
                    <div class="ga-card gm-item">
                      <div class="gm-item-text">${truncate(m.content, 150)}</div>
                      <div class="gm-item-meta">
                        ${typeBadge(m.type)}
                        ${(m.domain || []).map((d: string) => domainBadge(d))}
                        <span class="gm-score">Importance: ${formatPercent(m.importance)}</span>
                      </div>
                    </div>
                  `)}
                </div>
              `, { i: 4, count: memories.length })}

            ${panel("Actions", html`
              <div class="gm-actions">
                <button class="gt-btn" @click=${() => ingestTranscripts(state)} ?disabled=${ingesting}>
                  ${icons.upload} ${ingesting ? "Ingesting…" : "Ingest transcripts"}
                </button>
                <button class="gt-btn" @click=${() => exportTrainingData(state)} ?disabled=${exporting}>
                  ${icons.download} ${exporting ? "Exporting…" : "Export training data"}
                </button>
                <a href="http://localhost:3014" target="_blank" rel="noopener" class="gt-btn gt-primary">
                  ${icons.externalLink} Full dashboard
                </a>
              </div>
              ${ingestResult ? html`
                <div class="gm-note" data-tone="ok" role="status">
                  ${icons.checkCircle}<span>Ingested ${ingestResult.conversationsProcessed} conversations, created ${ingestResult.memoriesCreated} memories.</span>
                </div>
              ` : nothing}
              ${exportResult ? html`
                <div class="gm-note" data-tone="ok" role="status">
                  ${icons.checkCircle}<span>Exported ${exportResult.pairs} training pairs to ${exportResult.path}</span>
                </div>
              ` : nothing}
            `, { i: 5 })}
          </div>
        </div>
      ` : nothing}

      ${renderImportDialog(state, client)}
    </div>
  `;
}
