/**
 * Message Stream — Live inter-agent message log
 */

import { html, nothing } from 'lit';
import type { AppViewState } from '../../app-view-state';
import { getMeshState, type MeshMessage } from '../../controllers/agent-mesh';

// ════════════════════════════════════════════════════════════════
// THEME
// ════════════════════════════════════════════════════════════════

const HUD = {
  bg: '#050505',
  bgCard: '#0a0a0a',
  bgSurface: '#0f0f0f',
  gold: 'var(--g-primary)',
  goldDim: 'var(--g-primary)',
  goldSubtle: 'color-mix(in srgb, var(--g-primary) 8%, transparent)',
  goldBorder: 'color-mix(in srgb, var(--g-primary) 20%, transparent)',
  text: '#e4e4e7',
  textMuted: '#71717a',
  textDim: '#52525b',
  border: '#1a1a1a',
  success: '#22c55e',
  error: '#ef4444',
  warning: '#f59e0b',
  info: '#3b82f6',
  mono: "'JetBrains Mono','SF Mono','Consolas',monospace",
};

const MESSAGE_TYPE_STYLES: Record<string, { color: string; icon: string }> = {
  request: { color: HUD.gold, icon: '→' },
  response: { color: HUD.success, icon: '←' },
  broadcast: { color: HUD.info, icon: '◎' },
  event: { color: HUD.warning, icon: '⚡' },
};

// ════════════════════════════════════════════════════════════════
// RENDER
// ════════════════════════════════════════════════════════════════

export function renderMessageStream(state: AppViewState) {
  const meshState = getMeshState();
  const messages = meshState.messages;

  return html`
    <div style="
      display: flex;
      flex-direction: column;
      height: 100%;
      font-family: ${HUD.mono};
    ">
      <!-- Header -->
      <div style="
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 12px 16px;
        border-bottom: 1px solid ${HUD.border};
      ">
        <div style="display: flex; align-items: center; gap: 8px;">
          <span style="font-size: 14px;">💬</span>
          <span style="
            font-size: 12px;
            font-weight: 500;
            color: ${HUD.gold};
          ">Message Stream</span>
          <span style="
            background: ${HUD.bgSurface};
            border: 1px solid ${HUD.border};
            border-radius: 10px;
            padding: 2px 8px;
            font-size: 10px;
            color: ${HUD.textMuted};
          ">${meshState.stats.messagesPerMinute}/min</span>
        </div>

        <div style="
          display: flex;
          align-items: center;
          gap: 12px;
          font-size: 10px;
          color: ${HUD.textMuted};
        ">
          <span style="display: flex; align-items: center; gap: 4px;">
            <span style="color: ${HUD.gold};">→</span> Request
          </span>
          <span style="display: flex; align-items: center; gap: 4px;">
            <span style="color: ${HUD.success};">←</span> Response
          </span>
          <span style="display: flex; align-items: center; gap: 4px;">
            <span style="color: ${HUD.info};">◎</span> Broadcast
          </span>
        </div>
      </div>

      <!-- Messages -->
      <div style="
        flex: 1;
        overflow-x: auto;
        overflow-y: hidden;
        padding: 12px 16px;
        display: flex;
        gap: 8px;
      ">
        ${messages.length === 0 ? html`
          <div style="
            display: flex;
            align-items: center;
            justify-content: center;
            width: 100%;
            color: ${HUD.textMuted};
            font-size: 12px;
          ">
            <span style="margin-right: 8px;">📭</span>
            No messages yet — agents will communicate here
          </div>
        ` : html`
          ${messages.slice(0, 20).map(msg => renderMessageCard(msg))}
        `}
      </div>
    </div>
  `;
}

function renderMessageCard(message: MeshMessage) {
  const style = MESSAGE_TYPE_STYLES[message.type] || MESSAGE_TYPE_STYLES.request;
  const timeAgo = formatTimeAgo(message.timestamp);

  return html`
    <div style="
      flex-shrink: 0;
      width: 280px;
      background: ${HUD.bgSurface};
      border: 1px solid ${HUD.border};
      border-left: 3px solid ${style.color};
      border-radius: 8px;
      padding: 10px 12px;
      display: flex;
      flex-direction: column;
      gap: 6px;
    ">
      <!-- Header -->
      <div style="
        display: flex;
        align-items: center;
        justify-content: space-between;
      ">
        <div style="
          display: flex;
          align-items: center;
          gap: 6px;
          font-size: 11px;
        ">
          <span style="color: ${style.color};">${style.icon}</span>
          <span style="color: ${HUD.text}; font-weight: 500;">
            ${truncateLabel(message.fromLabel || message.from)}
          </span>
          <span style="color: ${HUD.textDim};">→</span>
          <span style="color: ${HUD.textMuted};">
            ${truncateLabel(message.toLabel || message.to)}
          </span>
        </div>
        <span style="
          font-size: 9px;
          color: ${HUD.textDim};
        ">${timeAgo}</span>
      </div>

      <!-- Content -->
      ${message.payload?.message || message.payload?.action ? html`
        <div style="
          font-size: 11px;
          color: ${HUD.textMuted};
          background: ${HUD.bgCard};
          border-radius: 4px;
          padding: 6px 8px;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        ">
          ${message.payload.action ? html`
            <span style="color: ${style.color}; margin-right: 4px;">[${message.payload.action}]</span>
          ` : nothing}
          ${message.payload.message || ''}
        </div>
      ` : nothing}

      <!-- Type Badge -->
      <div style="
        display: flex;
        align-items: center;
        gap: 8px;
      ">
        <span style="
          background: ${style.color}15;
          border: 1px solid ${style.color}30;
          color: ${style.color};
          padding: 2px 6px;
          border-radius: 4px;
          font-size: 9px;
          text-transform: uppercase;
        ">${message.type}</span>
        
        ${!message.delivered ? html`
          <span style="
            color: ${HUD.warning};
            font-size: 9px;
          ">⏳ pending</span>
        ` : nothing}
      </div>
    </div>
  `;
}

// ════════════════════════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════════════════════════

function truncateLabel(label: string): string {
  if (label.length > 15) {
    return label.slice(0, 12) + '...';
  }
  return label;
}

function formatTimeAgo(timestamp: number): string {
  const diff = Date.now() - timestamp;
  if (diff < 5000) return 'now';
  if (diff < 60000) return `${Math.floor(diff / 1000)}s`;
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h`;
  return `${Math.floor(diff / 86400000)}d`;
}
