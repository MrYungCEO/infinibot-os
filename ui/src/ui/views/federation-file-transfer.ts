/**
 * Federation File Transfer View
 *
 * Pure render functions for the file transfer feature.
 * Matches the visual language of federation-control-center.ts.
 */

import { html, nothing, type TemplateResult } from "lit";
import type { GatewayBrowserClient } from "../gateway";
import type {
  FileTransferState,
  FileTransfer,
  FileTransferPeer,
  InboxFile,
} from "../controllers/file-transfer";
import {
  formatBytes,
  formatAgo,
  getOverallProgress,
  togglePeerSelection,
  setDragOver,
} from "../controllers/file-transfer";

// ══════════════════════════════════════════════════════════════════════════════
// Props
// ══════════════════════════════════════════════════════════════════════════════

export interface FileTransferPageProps {
  state: FileTransferState;
  client: GatewayBrowserClient;
  onRefresh: () => void;
  onSendFile: (filePath: string, toNodes: string[]) => void;
  onPause: (id: string) => void;
  onResume: (id: string) => void;
  onCancel: (id: string) => void;
  onTogglePeer: (peerId: string) => void;
  onDragOver: (value: boolean) => void;
  onFileDrop: (filePath: string) => void;
  onFileChoose: () => void;
  onTabChange: (tab: "send" | "inbox") => void;
  requestUpdate: () => void;
}

// ══════════════════════════════════════════════════════════════════════════════
// Styles
// ══════════════════════════════════════════════════════════════════════════════

function renderFileTransferStyles(): TemplateResult {
  return html`
    <style>
      /* ── CSS Variables ──────────────────────────────────────────────────── */
      .ft-page {
        --ft-accent: #6366f1;
        --ft-accent-dim: rgba(99, 102, 241, 0.15);
        --ft-accent-border: rgba(99, 102, 241, 0.3);
        --ft-surface: rgba(255, 255, 255, 0.04);
        --ft-surface-hover: rgba(255, 255, 255, 0.07);
        --ft-border: rgba(255, 255, 255, 0.08);
        --ft-border-strong: rgba(255, 255, 255, 0.14);
        --ft-text: #e4e4e7;
        --ft-text-muted: #a1a1aa;
        --ft-text-faint: #71717a;
        --ft-green: #22c55e;
        --ft-green-glow: rgba(34, 197, 94, 0.5);
        --ft-red: #ef4444;
        --ft-yellow: #eab308;
        --ft-blue: #3b82f6;

        padding: 24px;
        max-width: 1400px;
        margin: 0 auto;
        color: var(--ft-text);
        font-family: system-ui, -apple-system, sans-serif;
        font-size: 14px;
      }

      /* ── Header ─────────────────────────────────────────────────────────── */
      .ft-header {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        margin-bottom: 28px;
        padding-bottom: 20px;
        border-bottom: 1px solid var(--ft-border);
      }

      .ft-header-title {
        font-size: 26px;
        font-weight: 800;
        margin: 0 0 6px 0;
        background: linear-gradient(135deg, var(--ft-accent), #a5b4fc);
        -webkit-background-clip: text;
        -webkit-text-fill-color: transparent;
        background-clip: text;
      }

      .ft-header-subtitle {
        font-size: 13px;
        color: var(--ft-text-muted);
        margin: 0;
      }

      .ft-header-actions {
        display: flex;
        gap: 10px;
        align-items: center;
      }

      /* ── Stat strip ─────────────────────────────────────────────────────── */
      .ft-stats {
        display: grid;
        grid-template-columns: repeat(4, 1fr);
        gap: 12px;
        margin-bottom: 24px;
      }

      .ft-stat-cell {
        background: var(--ft-surface);
        border: 1px solid var(--ft-border);
        border-radius: 12px;
        padding: 16px 20px;
        display: flex;
        flex-direction: column;
        gap: 4px;
      }

      .ft-stat-label {
        font-size: 11px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--ft-text-faint);
      }

      .ft-stat-value {
        font-size: 24px;
        font-weight: 700;
        color: var(--ft-text);
        line-height: 1.2;
      }

      .ft-stat-value.accent {
        color: var(--ft-accent);
      }

      /* ── Layout grid ────────────────────────────────────────────────────── */
      .ft-layout {
        display: grid;
        grid-template-columns: 360px 1fr;
        gap: 20px;
        align-items: start;
      }

      /* ── Panel ──────────────────────────────────────────────────────────── */
      .ft-panel {
        background: var(--ft-surface);
        border: 1px solid var(--ft-border);
        border-radius: 12px;
        overflow: hidden;
      }

      .ft-panel-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 14px 18px;
        border-bottom: 1px solid var(--ft-border);
        background: rgba(0, 0, 0, 0.18);
      }

      .ft-panel-title {
        font-size: 14px;
        font-weight: 600;
        color: var(--ft-text);
        margin: 0;
      }

      .ft-panel-subtitle {
        font-size: 12px;
        color: var(--ft-text-faint);
      }

      .ft-panel-body {
        padding: 18px;
      }

      /* ── Buttons ────────────────────────────────────────────────────────── */
      .ft-btn {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 9px 16px;
        border-radius: 8px;
        font-size: 13px;
        font-weight: 500;
        cursor: pointer;
        transition: all 0.15s ease;
        border: none;
      }

      .ft-btn--primary {
        background: var(--ft-accent);
        color: #fff;
      }

      .ft-btn--primary:hover {
        background: #4f52d3;
        transform: translateY(-1px);
        box-shadow: 0 4px 12px rgba(99, 102, 241, 0.3);
      }

      .ft-btn--primary:disabled {
        opacity: 0.45;
        cursor: not-allowed;
        transform: none;
        box-shadow: none;
      }

      .ft-btn--outline {
        background: transparent;
        border: 1px solid var(--ft-accent-border);
        color: var(--ft-accent);
      }

      .ft-btn--outline:hover {
        background: var(--ft-accent-dim);
      }

      .ft-btn--ghost {
        background: transparent;
        border: 1px solid var(--ft-border);
        color: var(--ft-text-muted);
      }

      .ft-btn--ghost:hover {
        background: var(--ft-surface-hover);
        color: var(--ft-text);
      }

      .ft-btn--sm {
        padding: 5px 10px;
        font-size: 11px;
        border-radius: 6px;
      }

      .ft-btn--danger {
        background: transparent;
        border: 1px solid rgba(239, 68, 68, 0.35);
        color: var(--ft-red);
      }

      .ft-btn--danger:hover {
        background: rgba(239, 68, 68, 0.1);
      }

      /* ── Drop zone ──────────────────────────────────────────────────────── */
      .ft-dropzone {
        border: 2px dashed var(--ft-border-strong);
        border-radius: 10px;
        padding: 22px 18px;
        text-align: center;
        transition: border-color 0.15s ease, background 0.15s ease;
        background: rgba(0, 0, 0, 0.12);
        margin-bottom: 16px;
      }

      .ft-dropzone.drag-over {
        border-color: var(--ft-accent);
        background: var(--ft-accent-dim);
      }

      .ft-dropzone-icon {
        font-size: 28px;
        margin-bottom: 8px;
        display: block;
        opacity: 0.7;
      }

      .ft-dropzone-hint {
        font-size: 12px;
        color: var(--ft-text-faint);
        margin-bottom: 12px;
      }

      .ft-file-pending {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 8px 10px;
        background: var(--ft-accent-dim);
        border: 1px solid var(--ft-accent-border);
        border-radius: 8px;
        font-size: 12px;
        color: var(--ft-text-muted);
        word-break: break-all;
        text-align: left;
        margin-top: 8px;
      }

      .ft-file-pending-name {
        flex: 1;
        font-weight: 500;
        color: var(--ft-text);
      }

      /* ── Path input ─────────────────────────────────────────────────────── */
      .ft-input-group {
        display: flex;
        flex-direction: column;
        gap: 6px;
        margin-bottom: 16px;
      }

      .ft-input-label {
        font-size: 11px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--ft-text-faint);
      }

      .ft-input {
        width: 100%;
        padding: 9px 12px;
        background: rgba(0, 0, 0, 0.25);
        border: 1px solid var(--ft-border-strong);
        border-radius: 8px;
        color: var(--ft-text);
        font-size: 13px;
        font-family: "Fira Code", "JetBrains Mono", monospace;
        outline: none;
        box-sizing: border-box;
        transition: border-color 0.15s ease;
      }

      .ft-input:focus {
        border-color: var(--ft-accent);
      }

      .ft-input::placeholder {
        color: var(--ft-text-faint);
      }

      .ft-path-hint {
        font-size: 11px;
        color: var(--ft-text-faint);
        margin-top: 2px;
      }

      /* ── Peer list ──────────────────────────────────────────────────────── */
      .ft-peer-list {
        display: flex;
        flex-direction: column;
        gap: 6px;
        margin-bottom: 16px;
        max-height: 220px;
        overflow-y: auto;
      }

      .ft-peer-row {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 9px 12px;
        background: rgba(0, 0, 0, 0.18);
        border: 1px solid var(--ft-border);
        border-radius: 8px;
        cursor: pointer;
        transition: border-color 0.15s ease, background 0.15s ease;
        user-select: none;
      }

      .ft-peer-row:hover {
        background: var(--ft-surface-hover);
      }

      .ft-peer-row.selected {
        border-color: var(--ft-accent-border);
        background: var(--ft-accent-dim);
      }

      .ft-peer-row.offline {
        opacity: 0.5;
        cursor: default;
      }

      .ft-peer-dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        flex-shrink: 0;
      }

      .ft-peer-dot.online {
        background: var(--ft-green);
        box-shadow: 0 0 6px var(--ft-green-glow);
      }

      .ft-peer-dot.offline {
        background: #52525b;
      }

      .ft-peer-name {
        flex: 1;
        font-size: 13px;
        font-weight: 500;
        color: var(--ft-text);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .ft-peer-badge {
        font-size: 10px;
        padding: 2px 6px;
        border-radius: 4px;
        background: rgba(99, 102, 241, 0.12);
        color: #a5b4fc;
        font-weight: 500;
      }

      .ft-peer-checkbox {
        width: 16px;
        height: 16px;
        border-radius: 4px;
        border: 1.5px solid var(--ft-border-strong);
        display: flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
        background: transparent;
        transition: all 0.12s ease;
      }

      .ft-peer-checkbox.checked {
        background: var(--ft-accent);
        border-color: var(--ft-accent);
      }

      .ft-peer-checkbox.checked::after {
        content: "✓";
        font-size: 10px;
        color: #fff;
        line-height: 1;
      }

      .ft-empty-peers {
        padding: 24px;
        text-align: center;
        color: var(--ft-text-faint);
        font-size: 13px;
      }

      /* ── Transfer cards ─────────────────────────────────────────────────── */
      .ft-transfers {
        display: flex;
        flex-direction: column;
        gap: 12px;
      }

      .ft-transfer-card {
        background: rgba(0, 0, 0, 0.2);
        border: 1px solid var(--ft-border);
        border-radius: 10px;
        padding: 16px;
        transition: border-color 0.15s ease;
      }

      .ft-transfer-card:hover {
        border-color: var(--ft-border-strong);
      }

      .ft-transfer-top {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 12px;
        margin-bottom: 12px;
      }

      .ft-transfer-info {
        flex: 1;
        min-width: 0;
      }

      .ft-transfer-name {
        font-size: 14px;
        font-weight: 600;
        color: var(--ft-text);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        margin-bottom: 4px;
      }

      .ft-transfer-meta {
        display: flex;
        align-items: center;
        gap: 10px;
        font-size: 12px;
        color: var(--ft-text-muted);
        flex-wrap: wrap;
      }

      .ft-transfer-actions {
        display: flex;
        gap: 6px;
        flex-shrink: 0;
      }

      /* ── Status badge ───────────────────────────────────────────────────── */
      .ft-badge {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        padding: 2px 8px;
        border-radius: 999px;
        font-size: 10px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        white-space: nowrap;
      }

      .ft-badge--outgoing {
        background: rgba(99, 102, 241, 0.15);
        color: #a5b4fc;
      }

      .ft-badge--incoming {
        background: rgba(34, 197, 94, 0.12);
        color: #4ade80;
      }

      .ft-badge--transferring {
        background: rgba(59, 130, 246, 0.15);
        color: #60a5fa;
      }

      .ft-badge--completed {
        background: rgba(34, 197, 94, 0.12);
        color: #4ade80;
      }

      .ft-badge--failed {
        background: rgba(239, 68, 68, 0.15);
        color: #f87171;
      }

      .ft-badge--paused {
        background: rgba(234, 179, 8, 0.15);
        color: #facc15;
      }

      .ft-badge--queued,
      .ft-badge--negotiating {
        background: rgba(161, 161, 170, 0.12);
        color: #a1a1aa;
      }

      .ft-badge--cancelled {
        background: rgba(161, 161, 170, 0.1);
        color: #71717a;
      }

      /* ── Progress bars ──────────────────────────────────────────────────── */
      .ft-progress-section {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }

      .ft-progress-row {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }

      .ft-progress-label {
        display: flex;
        justify-content: space-between;
        font-size: 11px;
        color: var(--ft-text-faint);
      }

      .ft-progress-node {
        font-weight: 500;
        color: var(--ft-text-muted);
      }

      .ft-progress-pct {
        color: var(--ft-accent);
      }

      .ft-progress-bar-track {
        height: 5px;
        background: rgba(255, 255, 255, 0.08);
        border-radius: 3px;
        overflow: hidden;
      }

      .ft-progress-bar-fill {
        height: 100%;
        border-radius: 3px;
        background: linear-gradient(90deg, var(--ft-accent), #818cf8);
        transition: width 0.4s ease;
      }

      .ft-progress-bar-fill.complete {
        background: linear-gradient(90deg, var(--ft-green), #4ade80);
      }

      /* ── Tabs ───────────────────────────────────────────────────────────── */
      .ft-tabs {
        display: flex;
        gap: 2px;
        padding: 4px;
        background: rgba(0, 0, 0, 0.2);
        border-radius: 10px;
        margin-bottom: 20px;
        width: fit-content;
      }

      .ft-tab {
        padding: 8px 18px;
        border-radius: 8px;
        font-size: 13px;
        font-weight: 500;
        cursor: pointer;
        border: none;
        background: transparent;
        color: var(--ft-text-muted);
        transition: all 0.15s ease;
      }

      .ft-tab.active {
        background: var(--ft-accent);
        color: #fff;
      }

      .ft-tab:not(.active):hover {
        background: var(--ft-surface-hover);
        color: var(--ft-text);
      }

      .ft-tab-count {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 18px;
        height: 18px;
        padding: 0 5px;
        border-radius: 999px;
        font-size: 10px;
        font-weight: 700;
        background: rgba(255, 255, 255, 0.12);
        margin-left: 6px;
      }

      /* ── Inbox list ─────────────────────────────────────────────────────── */
      .ft-inbox-list {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }

      .ft-inbox-row {
        display: flex;
        align-items: center;
        gap: 14px;
        padding: 12px 14px;
        background: rgba(0, 0, 0, 0.18);
        border: 1px solid var(--ft-border);
        border-radius: 10px;
        transition: border-color 0.15s ease;
      }

      .ft-inbox-row:hover {
        border-color: var(--ft-border-strong);
      }

      .ft-inbox-icon {
        font-size: 22px;
        flex-shrink: 0;
      }

      .ft-inbox-info {
        flex: 1;
        min-width: 0;
      }

      .ft-inbox-name {
        font-size: 13px;
        font-weight: 600;
        color: var(--ft-text);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        margin-bottom: 2px;
      }

      .ft-inbox-meta {
        font-size: 11px;
        color: var(--ft-text-faint);
        display: flex;
        gap: 10px;
        flex-wrap: wrap;
      }

      .ft-inbox-actions {
        flex-shrink: 0;
      }

      .ft-inbox-link {
        font-size: 12px;
        color: var(--ft-accent);
        cursor: pointer;
        text-decoration: none;
        transition: color 0.12s ease;
      }

      .ft-inbox-link:hover {
        color: #a5b4fc;
        text-decoration: underline;
      }

      /* ── Error banner ───────────────────────────────────────────────────── */
      .ft-error {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 12px 16px;
        background: rgba(239, 68, 68, 0.1);
        border: 1px solid rgba(239, 68, 68, 0.25);
        border-radius: 10px;
        color: #f87171;
        font-size: 13px;
        margin-bottom: 20px;
      }

      /* ── Loading spinner ────────────────────────────────────────────────── */
      .ft-loading {
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 48px;
        color: var(--ft-text-faint);
        font-size: 13px;
        gap: 10px;
      }

      /* ── Empty states ───────────────────────────────────────────────────── */
      .ft-empty {
        display: flex;
        flex-direction: column;
        align-items: center;
        padding: 40px 20px;
        text-align: center;
        color: var(--ft-text-faint);
      }

      .ft-empty-icon {
        font-size: 36px;
        margin-bottom: 10px;
        opacity: 0.45;
      }

      .ft-empty-text {
        font-size: 14px;
        color: var(--ft-text-muted);
        margin-bottom: 6px;
      }

      .ft-empty-hint {
        font-size: 12px;
        color: var(--ft-text-faint);
      }

      /* ── Scrollbar ──────────────────────────────────────────────────────── */
      .ft-peer-list::-webkit-scrollbar {
        width: 4px;
      }

      .ft-peer-list::-webkit-scrollbar-track {
        background: transparent;
      }

      .ft-peer-list::-webkit-scrollbar-thumb {
        background: rgba(255, 255, 255, 0.12);
        border-radius: 2px;
      }

      /* ── Right column wrapper ───────────────────────────────────────────── */
      .ft-right-col {
        display: flex;
        flex-direction: column;
        gap: 20px;
      }
    </style>
  `;
}

// ══════════════════════════════════════════════════════════════════════════════
// Main Entry Point
// ══════════════════════════════════════════════════════════════════════════════

export function renderFederationFileTransfer(
  props: FileTransferPageProps
): TemplateResult {
  const { state } = props;

  const onlineCount = state.peers.filter((p) => p.online).length;
  const activeTransfers = state.transfers.filter(
    (t) =>
      t.status !== "completed" &&
      t.status !== "cancelled" &&
      t.status !== "failed"
  );

  return html`
    <div class="ft-page">
      ${renderFileTransferStyles()}

      <!-- Error banner -->
      ${state.error
        ? html`
            <div class="ft-error">
              <span>⚠</span>
              <span>${state.error}</span>
            </div>
          `
        : nothing}

      <!-- Header -->
      <header class="ft-header">
        <div>
          <h1 class="ft-header-title">File Transfer</h1>
          <p class="ft-header-subtitle">Send files across your mesh</p>
        </div>
        <div class="ft-header-actions">
          <button
            class="ft-btn ft-btn--ghost"
            @click=${props.onRefresh}
            ?disabled=${state.loading}
          >
            ↻ Refresh
          </button>
        </div>
      </header>

      <!-- Stat strip -->
      ${renderStats({ state, onlineCount, activeTransfers })}

      <!-- Main layout -->
      <div class="ft-layout">
        <!-- Left: Send panel -->
        ${renderSendPanel(props)}

        <!-- Right: Transfers + Inbox -->
        <div class="ft-right-col">
          <!-- Tab bar -->
          <div class="ft-tabs">
            <button
              class="ft-tab ${state.activeTab === "send" ? "active" : ""}"
              @click=${() => props.onTabChange("send")}
            >
              Active
              <span class="ft-tab-count">${activeTransfers.length}</span>
            </button>
            <button
              class="ft-tab ${state.activeTab === "inbox" ? "active" : ""}"
              @click=${() => props.onTabChange("inbox")}
            >
              Inbox
              <span class="ft-tab-count">${state.inboxFiles.length}</span>
            </button>
          </div>

          ${state.activeTab === "send"
            ? renderActiveTransfers(props, activeTransfers)
            : renderInbox(props)}
        </div>
      </div>
    </div>
  `;
}

// ══════════════════════════════════════════════════════════════════════════════
// Stat Strip
// ══════════════════════════════════════════════════════════════════════════════

function renderStats({
  state,
  onlineCount,
  activeTransfers,
}: {
  state: FileTransferState;
  onlineCount: number;
  activeTransfers: FileTransfer[];
}): TemplateResult {
  return html`
    <div class="ft-stats">
      <div class="ft-stat-cell">
        <span class="ft-stat-label">Nodes Online</span>
        <span class="ft-stat-value accent">${onlineCount}</span>
      </div>
      <div class="ft-stat-cell">
        <span class="ft-stat-label">Active Transfers</span>
        <span class="ft-stat-value">${activeTransfers.length}</span>
      </div>
      <div class="ft-stat-cell">
        <span class="ft-stat-label">Completed Today</span>
        <span class="ft-stat-value">${state.completedToday}</span>
      </div>
      <div class="ft-stat-cell">
        <span class="ft-stat-label">Total Transferred</span>
        <span class="ft-stat-value">${formatBytes(state.totalBytesTransferred)}</span>
      </div>
    </div>
  `;
}

// ══════════════════════════════════════════════════════════════════════════════
// Send Panel
// ══════════════════════════════════════════════════════════════════════════════

function renderSendPanel(props: FileTransferPageProps): TemplateResult {
  const { state } = props;
  const selectedOnlinePeers = state.peers
    .filter((p) => p.online && state.selectedPeers.has(p.id))
    .map((p) => p.id);

  const canSend =
    state.pendingFile !== null && selectedOnlinePeers.length > 0;

  const handleDragOver = (e: DragEvent) => {
    e.preventDefault();
    props.onDragOver(true);
  };

  const handleDragLeave = () => {
    props.onDragOver(false);
  };

  const handleDrop = (e: DragEvent) => {
    e.preventDefault();
    props.onDragOver(false);
    const file = e.dataTransfer?.files?.[0];
    if (file) {
      // In Electron/desktop the File object has a .path property
      const filePath = (file as any).path ?? file.name;
      props.onFileDrop(filePath);
    }
  };

  const handlePathInput = (e: Event) => {
    const input = e.target as HTMLInputElement;
    const val = input.value.trim();
    if (val) {
      // Synthesize a pendingFile from the typed path
      const name = val.split("/").pop() ?? val;
      // Dispatch as a file drop with the typed path
      props.onFileDrop(val);
    } else {
      props.onFileDrop("");
    }
  };

  const handleSend = () => {
    if (!state.pendingFile || selectedOnlinePeers.length === 0) return;
    props.onSendFile(state.pendingFile.path, selectedOnlinePeers);
  };

  return html`
    <div class="ft-panel">
      <div class="ft-panel-header">
        <span class="ft-panel-title">Send a File</span>
        <span class="ft-panel-subtitle">
          ${state.peers.filter((p) => p.online).length} peers available
        </span>
      </div>
      <div class="ft-panel-body">
        <!-- Drop zone -->
        <div
          class="ft-dropzone ${state.dragOver ? "drag-over" : ""}"
          @dragover=${handleDragOver}
          @dragleave=${handleDragLeave}
          @drop=${handleDrop}
        >
          <span class="ft-dropzone-icon">📂</span>
          <div class="ft-dropzone-hint">Drop a file here, or type the path below</div>
          ${state.pendingFile
            ? html`
                <div class="ft-file-pending">
                  <span>📄</span>
                  <span class="ft-file-pending-name">${state.pendingFile.name}</span>
                  ${state.pendingFile.size > 0
                    ? html`<span>${formatBytes(state.pendingFile.size)}</span>`
                    : nothing}
                </div>
              `
            : nothing}
        </div>

        <!-- Path input -->
        <div class="ft-input-group">
          <label class="ft-input-label">File Path on This Node</label>
          <input
            class="ft-input"
            type="text"
            placeholder="/home/user/documents/report.pdf"
            .value=${state.pendingFile?.path ?? ""}
            @change=${handlePathInput}
            @input=${handlePathInput}
          />
          <span class="ft-path-hint">Enter the local file path on this node's filesystem</span>
        </div>

        <!-- Peer list -->
        <div class="ft-input-group">
          <label class="ft-input-label">Send To</label>
          ${renderPeerList(props)}
        </div>

        <!-- Send button -->
        <button
          class="ft-btn ft-btn--primary"
          style="width: 100%;"
          ?disabled=${!canSend}
          @click=${handleSend}
        >
          ↑ Send to ${selectedOnlinePeers.length > 0
            ? `${selectedOnlinePeers.length} node${selectedOnlinePeers.length > 1 ? "s" : ""}`
            : "Selected"}
        </button>
      </div>
    </div>
  `;
}

// ══════════════════════════════════════════════════════════════════════════════
// Peer List
// ══════════════════════════════════════════════════════════════════════════════

function renderPeerList(props: FileTransferPageProps): TemplateResult {
  const { state } = props;

  if (state.peers.length === 0) {
    return html`
      <div class="ft-empty-peers">No peers discovered yet. Refresh to scan.</div>
    `;
  }

  return html`
    <div class="ft-peer-list">
      ${state.peers.map((peer) => renderPeerRow(peer, props))}
    </div>
  `;
}

function renderPeerRow(
  peer: FileTransferPeer,
  props: FileTransferPageProps
): TemplateResult {
  const { state } = props;
  const isSelected = state.selectedPeers.has(peer.id);
  const canSelect = peer.online && peer.capability.fileTransfer;

  const handleClick = () => {
    if (!canSelect) return;
    props.onTogglePeer(peer.id);
  };

  return html`
    <div
      class="ft-peer-row ${isSelected ? "selected" : ""} ${!peer.online ? "offline" : ""}"
      @click=${handleClick}
    >
      <div class="ft-peer-dot ${peer.online ? "online" : "offline"}"></div>
      <span class="ft-peer-name">${peer.name}</span>
      ${!peer.capability.fileTransfer
        ? html`<span class="ft-badge ft-badge--cancelled" style="font-size:9px">no ft</span>`
        : nothing}
      ${!peer.online
        ? html`<span class="ft-path-hint" style="font-size:10px;margin:0">${formatAgo(peer.lastSeen)}</span>`
        : nothing}
      <div class="ft-peer-checkbox ${isSelected ? "checked" : ""}"></div>
    </div>
  `;
}

// ══════════════════════════════════════════════════════════════════════════════
// Active Transfers
// ══════════════════════════════════════════════════════════════════════════════

function renderActiveTransfers(
  props: FileTransferPageProps,
  activeTransfers: FileTransfer[]
): TemplateResult {
  if (props.state.loading) {
    return html`<div class="ft-loading">Loading transfers…</div>`;
  }

  if (activeTransfers.length === 0) {
    return html`
      <div class="ft-empty">
        <span class="ft-empty-icon">⬆</span>
        <span class="ft-empty-text">No active transfers</span>
        <span class="ft-empty-hint">Select a file and peers to get started</span>
      </div>
    `;
  }

  return html`
    <div class="ft-transfers">
      ${activeTransfers.map((t) => renderTransferCard(t, props))}
    </div>
  `;
}

function renderTransferCard(
  transfer: FileTransfer,
  props: FileTransferPageProps
): TemplateResult {
  const pct = getOverallProgress(transfer);
  const isPaused = transfer.status === "paused";
  const isActive = transfer.status === "transferring";
  const isQueued =
    transfer.status === "queued" || transfer.status === "negotiating";

  return html`
    <div class="ft-transfer-card">
      <div class="ft-transfer-top">
        <div class="ft-transfer-info">
          <div class="ft-transfer-name">${transfer.fileName}</div>
          <div class="ft-transfer-meta">
            <span class="ft-badge ft-badge--${transfer.direction}">
              ${transfer.direction === "outgoing" ? "↑ Out" : "↓ In"}
            </span>
            <span class="ft-badge ft-badge--${transfer.status}">
              ${transfer.status}
            </span>
            <span>${formatBytes(transfer.fileSize)}</span>
            ${transfer.startedAt
              ? html`<span>${formatAgo(transfer.startedAt)}</span>`
              : nothing}
          </div>
        </div>
        <div class="ft-transfer-actions">
          ${isActive
            ? html`
                <button
                  class="ft-btn ft-btn--ghost ft-btn--sm"
                  title="Pause"
                  @click=${() => props.onPause(transfer.id)}
                >
                  ⏸
                </button>
              `
            : nothing}
          ${isPaused
            ? html`
                <button
                  class="ft-btn ft-btn--outline ft-btn--sm"
                  title="Resume"
                  @click=${() => props.onResume(transfer.id)}
                >
                  ▶
                </button>
              `
            : nothing}
          ${isQueued || isPaused || isActive
            ? html`
                <button
                  class="ft-btn ft-btn--danger ft-btn--sm"
                  title="Cancel"
                  @click=${() => props.onCancel(transfer.id)}
                >
                  ✕
                </button>
              `
            : nothing}
        </div>
      </div>

      <!-- Progress per recipient -->
      ${renderTransferProgress(transfer)}

      ${transfer.error
        ? html`
            <div style="font-size:11px;color:#f87171;margin-top:8px;">
              Error: ${transfer.error}
            </div>
          `
        : nothing}
    </div>
  `;
}

function renderTransferProgress(transfer: FileTransfer): TemplateResult {
  const nodes = Object.keys(transfer.progress);

  // If no per-node progress data, show a single aggregate bar
  if (nodes.length === 0) {
    const pct = getOverallProgress(transfer);
    return html`
      <div class="ft-progress-section">
        <div class="ft-progress-row">
          <div class="ft-progress-label">
            <span class="ft-progress-node">Overall</span>
            <span class="ft-progress-pct">${pct}%</span>
          </div>
          <div class="ft-progress-bar-track">
            <div
              class="ft-progress-bar-fill ${pct === 100 ? "complete" : ""}"
              style="width: ${pct}%"
            ></div>
          </div>
        </div>
      </div>
    `;
  }

  // Per-node progress
  return html`
    <div class="ft-progress-section">
      ${nodes.map((nodeId) => {
        const p = transfer.progress[nodeId];
        const pct =
          transfer.totalChunks > 0
            ? Math.min(
                100,
                Math.round((p.chunksSent / transfer.totalChunks) * 100)
              )
            : 0;
        return html`
          <div class="ft-progress-row">
            <div class="ft-progress-label">
              <span class="ft-progress-node">${nodeId}</span>
              <span class="ft-progress-pct">${pct}%</span>
            </div>
            <div class="ft-progress-bar-track">
              <div
                class="ft-progress-bar-fill ${pct === 100 ? "complete" : ""}"
                style="width: ${pct}%"
              ></div>
            </div>
          </div>
        `;
      })}
    </div>
  `;
}

// ══════════════════════════════════════════════════════════════════════════════
// Inbox
// ══════════════════════════════════════════════════════════════════════════════

function renderInbox(props: FileTransferPageProps): TemplateResult {
  const { state } = props;

  if (state.loading) {
    return html`<div class="ft-loading">Loading inbox…</div>`;
  }

  if (state.inboxFiles.length === 0) {
    return html`
      <div class="ft-empty">
        <span class="ft-empty-icon">📥</span>
        <span class="ft-empty-text">Inbox is empty</span>
        <span class="ft-empty-hint">Received files will appear here</span>
      </div>
    `;
  }

  return html`
    <div class="ft-panel">
      <div class="ft-panel-header">
        <span class="ft-panel-title">Received Files</span>
        <span class="ft-panel-subtitle">${state.inboxFiles.length} file${state.inboxFiles.length !== 1 ? "s" : ""}</span>
      </div>
      <div class="ft-panel-body">
        <div class="ft-inbox-list">
          ${state.inboxFiles.map((f) => renderInboxRow(f))}
        </div>
      </div>
    </div>
  `;
}

function renderInboxRow(file: InboxFile): TemplateResult {
  const ext = file.fileName.split(".").pop()?.toLowerCase() ?? "";
  const icon = getFileIcon(ext);
  const folder = file.path.substring(0, file.path.lastIndexOf("/")) || file.path;

  const handleOpenFolder = (e: Event) => {
    e.preventDefault();
    window.open("file://" + folder);
  };

  return html`
    <div class="ft-inbox-row">
      <span class="ft-inbox-icon">${icon}</span>
      <div class="ft-inbox-info">
        <div class="ft-inbox-name">${file.fileName}</div>
        <div class="ft-inbox-meta">
          <span>From: ${file.fromNode}</span>
          <span>${formatAgo(file.receivedAt)}</span>
          <span>${formatBytes(file.size)}</span>
        </div>
      </div>
      <div class="ft-inbox-actions">
        <a
          class="ft-inbox-link"
          href="#"
          @click=${handleOpenFolder}
          title="Open containing folder"
        >
          Open folder
        </a>
      </div>
    </div>
  `;
}

// ══════════════════════════════════════════════════════════════════════════════
// Utility helpers (view-only)
// ══════════════════════════════════════════════════════════════════════════════

function getFileIcon(ext: string): string {
  const imageExts = ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp"];
  const videoExts = ["mp4", "mkv", "mov", "avi", "webm"];
  const audioExts = ["mp3", "wav", "flac", "ogg", "aac"];
  const docExts = ["pdf", "doc", "docx", "odt", "rtf"];
  const codeExts = ["ts", "js", "py", "rs", "go", "json", "yaml", "yml", "sh"];
  const archiveExts = ["zip", "tar", "gz", "bz2", "7z", "rar"];

  if (imageExts.includes(ext)) return "🖼";
  if (videoExts.includes(ext)) return "🎬";
  if (audioExts.includes(ext)) return "🎵";
  if (docExts.includes(ext)) return "📄";
  if (codeExts.includes(ext)) return "💻";
  if (archiveExts.includes(ext)) return "📦";
  return "📄";
}
