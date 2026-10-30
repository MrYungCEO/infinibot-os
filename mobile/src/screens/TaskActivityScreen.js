import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  TextInput,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  RefreshControl,
  Modal,
  UIManager,
  Alert,
  Linking,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { SPACING, DEPTH } from '../constants/theme';
import { useTheme } from '../theme/ThemeProvider';
import { GlassSurface } from '../components/GlassSurface';
import { PremiumHeader } from '../components/PremiumHeader';
import { useHardware } from '../hooks/useHardware';
import { ProviderLogo } from '../utils/providerLogo';

// Map the existing agent-type taxonomy (claude/codex/opencode/native/shell/voice)
// to the provider-logo taxonomy used by ProviderLogo.
function providerFromAgentType(type) {
  switch (type) {
    case 'claude':   return 'claude';
    case 'codex':    return 'openai';
    case 'opencode': return 'opencode';
    case 'native':   return 'infinibot';
    default:         return 'unknown';
  }
}

if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

// ─── Status helpers ─────────────────────────────────────────────────

const ACTIVE_STATUSES = new Set(['running', 'processing', 'pending', 'starting', 'working', 'in_progress']);
const DONE_STATUSES   = new Set(['completed', 'done', 'stopped', 'aborted', 'exited']);
const ERROR_STATUSES  = new Set(['error', 'failed', 'blocked']);

function classifyStatus(status) {
  const s = (status || '').toLowerCase();
  if (ACTIVE_STATUSES.has(s)) return 'active';
  if (ERROR_STATUSES.has(s))  return 'error';
  if (DONE_STATUSES.has(s))   return 'done';
  return 'idle';
}

function statusColor(status, colors) {
  switch (classifyStatus(status)) {
    case 'active': return colors.success;
    case 'error':  return colors.error;
    case 'done':   return colors.info || colors.cyan || '#22D3EE';
    default:       return colors.textMuted;
  }
}

// ─── Agent type mapping (Claude / OpenCode / Codex / Shell / Voice) ─

// Detection precedence: explicit coderBackend > heuristic on labels/kind/channel.
function detectAgentType(row) {
  if (!row || typeof row !== 'object') return 'native';

  const backend = String(row.coderBackend || '').toLowerCase();
  if (backend === 'claude-code' || backend === 'claude') return 'claude';
  if (backend === 'opencode') return 'opencode';
  if (backend === 'codex') return 'codex';
  if (backend === 'grok') return 'grok';

  const kind = String(row.kind || '').toLowerCase();
  const channel = String(row.channel || '').toLowerCase();
  const label = String(row.label || row.displayName || row.derivedTitle || '').toLowerCase();
  const task = String(row.task || '').toLowerCase();

  if (kind === 'voice' || channel === 'voice' || label.includes('voice call')) return 'voice';
  if (kind === 'shell' || label.startsWith('shell:') || label.includes(' shell') || task.includes('shell ')) return 'shell';

  if (label.includes('opencode')) return 'opencode';
  if (label.includes('codex')) return 'codex';
  if (label.includes('grok')) return 'grok';
  if (label.includes('claude')) return 'claude';

  if (kind === 'subagent') return 'claude';
  return 'native';
}

// Coarse session class used by the top filter row. Mirrors the desktop
// activity page's getSessionType() (native | subagent | coder | external) so
// the mobile filter chips line up 1:1 with the web NATIVE/SUB/CODER/EXTERNAL
// counters. Order matters: coder > subagent > external > native.
function sessionClass(row) {
  if (!row || typeof row !== 'object') return 'native';
  const backend = String(row.coderBackend || '').toLowerCase();
  const dn = String(row.displayName || row.label || '').toLowerCase();
  if (backend || dn.startsWith('opencode') || dn.startsWith('codex') || dn.startsWith('grok') || dn.startsWith('claude coder')) return 'coder';
  if (row.kind === 'subagent' || row.source === 'subagent') return 'subagent';
  const ch = String(row.channel || '').toLowerCase();
  if (ch && ch !== 'internal' && ch !== 'webchat' && ch !== 'gateway' && row.kind !== 'main') return 'external';
  return 'native';
}

// Agent-type badge: short label + color/icon. Reads from theme for palette switches.
function agentBadge(type, colors) {
  switch (type) {
    case 'claude':
      return { label: 'CLAUDE',   icon: 'sparkles',        color: colors.purple || '#a78bfa' };
    case 'opencode':
      return { label: 'OPENCODE', icon: 'code-slash',      color: colors.cyan   || '#22d3ee' };
    case 'codex':
      return { label: 'CODEX',    icon: 'cube',            color: colors.warning || colors.yellow || '#f59e0b' };
    case 'grok':
      return { label: 'GROK',     icon: 'flash',           color: '#f43f5e' };
    case 'shell':
      return { label: 'SHELL',    icon: 'terminal',        color: colors.success || '#22c55e' };
    case 'voice':
      return { label: 'VOICE',    icon: 'mic',             color: colors.pink   || '#ec4899' };
    default:
      return { label: 'NATIVE',   icon: 'flash',           color: colors.primary };
  }
}

// ─── Time / format helpers ──────────────────────────────────────────

function formatTime(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function timeAgo(ts) {
  if (!ts) return '';
  const diff = Date.now() - new Date(ts).getTime();
  if (diff < 5000) return 'just now';
  if (diff < 60000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
}

function fmtDuration(ms) {
  if (!ms || ms <= 0) return '—';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function withAlpha(color, alpha) {
  if (!color) return `rgba(255,255,255,${alpha})`;
  if (color.startsWith('#')) {
    let hex = color.slice(1);
    if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
    const num = parseInt(hex, 16);
    return `rgba(${(num >> 16) & 0xff},${(num >> 8) & 0xff},${num & 0xff},${alpha})`;
  }
  const m = color.match(/^rgba?\(([^)]+)\)$/);
  if (m) {
    const [r, g, b] = m[1].split(',').map(p => p.trim());
    return `rgba(${r},${g},${b},${alpha})`;
  }
  return color;
}

// ─── Hardware helpers ───────────────────────────────────────────────

function hwCpuPct(hw) { return hw?.cpu?.usage ?? hw?.cpu?.percent ?? null; }
function hwMemPct(hw) {
  if (hw?.mem?.percent != null) return hw.mem.percent;
  if (hw?.mem?.used && hw?.mem?.total) return Math.round(hw.mem.used / hw.mem.total * 100);
  return null;
}
function hwGpuPct(hw) { return hw?.gpu?.usage ?? null; }
function hwCpuModel(hw) { return hw?.cpu?.model ?? hw?.cpu?.name ?? null; }
function hwGpuModel(hw) { return hw?.gpu?.model ?? hw?.gpu?.name ?? null; }
function hwRamGB(hw) {
  const t = hw?.mem?.total;
  if (!t) return null;
  return `${(t / 1024 / 1024 / 1024).toFixed(0)} GB`;
}

// Inline hardware mini-bar used inside the focus modal.
const _hwBarStyles = StyleSheet.create({
  item: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  label: { fontSize: 8, fontWeight: '700', color: 'rgba(255,255,255,0.38)', width: 26, textAlign: 'right' },
  track: { width: 40, height: 3, backgroundColor: 'rgba(255,255,255,0.08)', borderRadius: 1.5, overflow: 'hidden' },
  fill: { height: 3, borderRadius: 1.5 },
  value: { fontSize: 8, fontWeight: '700', width: 24 },
});
function MiniHwBar({ label, value, color }) {
  if (value === null || value === undefined) return null;
  const v = Math.max(0, Math.min(100, value));
  return (
    <View style={_hwBarStyles.item}>
      <Text style={_hwBarStyles.label}>{label}</Text>
      <View style={_hwBarStyles.track}>
        <View style={[_hwBarStyles.fill, { width: `${v}%`, backgroundColor: color }]} />
      </View>
      <Text style={[_hwBarStyles.value, { color }]}>{Math.round(v)}%</Text>
    </View>
  );
}

// ─── Row data normalization ─────────────────────────────────────────

// Build a uniform row from either a subagent or a session, so the list
// rendering doesn't have to branch.
function rowFromSubagent(sa) {
  return {
    source: 'subagent',
    key: `sa:${sa.runId || sa.sessionKey}`,
    sessionKey: sa.sessionKey || sa.runId,
    title: sa.label || (sa.runId ? `Subagent ${sa.runId.slice(0, 8)}` : 'Subagent'),
    subtitle: sa.task || sa.currentCheckpoint || sa.lastActivity?.label || '',
    status: sa.status,
    progress: typeof sa.progress === 'number' ? sa.progress : null,
    startedAt: sa.startedAt || sa.createdAt,
    lastUpdateAt: sa.lastUpdateAt || sa.endedAt || sa.createdAt,
    endedAt: sa.endedAt || null,
    coderBackend: sa.coderBackend,
    kind: 'subagent',
    nodeName: sa.nodeName,
    remote: !!sa.remote,
    respawnOfRunId: sa.respawnOfRunId || null,
    raw: sa,
  };
}

function rowFromSession(s) {
  const key = s.key || s.sessionKey || s.id;
  const ts = s.lastActiveAt || s.updatedAt || s.createdAt;
  // Infer a soft "running" tag for sessions touched in the last 2 minutes.
  const inferredActive = ts && Date.now() - new Date(ts).getTime() < 120000;
  return {
    source: 'session',
    key: `s:${key}`,
    sessionKey: key,
    title: s.derivedTitle || s.label || key || 'Session',
    subtitle: s.lastMessage?.content
      ? (typeof s.lastMessage.content === 'string'
          ? s.lastMessage.content
          : (Array.isArray(s.lastMessage.content)
              ? s.lastMessage.content.filter(b => b.type === 'text').map(b => b.text).join('')
              : ''))
      : '',
    status: inferredActive ? 'running' : 'idle',
    progress: null,
    startedAt: s.createdAt,
    lastUpdateAt: ts,
    endedAt: null,
    coderBackend: s.coderBackend,
    kind: s.kind,
    channel: s.channel,
    displayName: s.displayName,
    model: s.model,
    totalTokens: s.totalTokens,
    raw: s,
  };
}

// ─── Activity Row (dashboard) ───────────────────────────────────────

function ActivityRow({ row, colors, styles, onPress, muted }) {
  const type = detectAgentType(row);
  const badge = agentBadge(type, colors);
  const sColor = statusColor(row.status, colors);
  const isActive = classifyStatus(row.status) === 'active';
  const ts = row.endedAt || row.lastUpdateAt || row.startedAt;
  const elapsed = row.startedAt ? Date.now() - new Date(row.startedAt).getTime() : null;

  return (
    <TouchableOpacity
      activeOpacity={0.75}
      onPress={onPress}
      style={[styles.row, muted && { opacity: 0.78 }]}
    >
      {/* Left rail — agent-type accent stripe */}
      <View style={[styles.rowAccent, { backgroundColor: badge.color }]} />

      <View style={styles.rowBody}>
        <View style={styles.rowTopLine}>
          <View style={[
            styles.typeBadge,
            { backgroundColor: withAlpha(badge.color, 0.14), borderColor: withAlpha(badge.color, 0.45) },
          ]}>
            <Ionicons name={badge.icon} size={10} color={badge.color} style={{ marginRight: 4 }} />
            <Text style={[styles.typeBadgeText, { color: badge.color }]}>{badge.label}</Text>
          </View>

          {row.remote && row.nodeName ? (
            <View style={[styles.nodeChip, { borderColor: withAlpha(colors.textMuted, 0.4) }]}>
              <Text style={[styles.nodeChipText, { color: colors.textMuted }]} numberOfLines={1}>
                {row.nodeName}
              </Text>
            </View>
          ) : null}

          {row.respawnOfRunId ? (
            <View
              style={[
                styles.respawnRowChip,
                {
                  borderColor: withAlpha(colors.warning || colors.primary, 0.45),
                  backgroundColor: withAlpha(colors.warning || colors.primary, 0.1),
                },
              ]}
            >
              <Ionicons
                name="refresh-circle-outline"
                size={9}
                color={colors.warning || colors.primary}
                style={{ marginRight: 3 }}
              />
              <Text
                style={[
                  styles.respawnRowChipText,
                  { color: colors.warning || colors.primary },
                ]}
                numberOfLines={1}
              >
                Respawn #{String(row.respawnOfRunId).slice(0, 6)}
              </Text>
            </View>
          ) : null}

          <View style={{ flex: 1 }} />

          <View style={[styles.statusPill, { backgroundColor: withAlpha(sColor, 0.14), borderColor: withAlpha(sColor, 0.45) }]}>
            <View style={[styles.statusDot, { backgroundColor: sColor }]} />
            <Text style={[styles.statusPillText, { color: sColor }]}>
              {(row.status || 'idle').toUpperCase()}
            </Text>
          </View>
        </View>

        <Text style={styles.rowTitle} numberOfLines={1}>{row.title}</Text>

        {row.subtitle ? (
          <Text style={styles.rowSubtitle} numberOfLines={2}>{row.subtitle}</Text>
        ) : null}

        {row.progress !== null ? (
          <View style={styles.rowProgressWrap}>
            <View style={styles.rowProgressTrack}>
              <View style={[
                styles.rowProgressFill,
                { width: `${Math.max(2, Math.min(100, row.progress))}%`, backgroundColor: sColor },
              ]} />
            </View>
            <Text style={[styles.rowProgressPct, { color: sColor }]}>{Math.round(row.progress)}%</Text>
          </View>
        ) : null}

        <View style={styles.rowMeta}>
          {isActive && elapsed ? (
            <Text style={styles.rowMetaText}><Ionicons name="time-outline" size={10} color={colors.textMuted} /> {fmtDuration(elapsed)}</Text>
          ) : ts ? (
            <Text style={styles.rowMetaText}>{timeAgo(ts)}</Text>
          ) : null}
          {row.model ? (
            <Text style={styles.rowMetaText}>· {row.model}</Text>
          ) : null}
          {row.totalTokens ? (
            <Text style={styles.rowMetaText}>· {(row.totalTokens / 1000).toFixed(1)}k tok</Text>
          ) : null}
        </View>
      </View>

      <Ionicons name="chevron-forward" size={16} color={colors.textMuted} style={{ marginLeft: 4 }} />
    </TouchableOpacity>
  );
}

// ─── Section shell ──────────────────────────────────────────────────

function Section({ icon, title, count, accent, colors, styles, children }) {
  return (
    <View style={styles.sectionWrap}>
      <View style={styles.sectionHeader}>
        <View style={styles.sectionHeaderLeft}>
          <View style={[styles.sectionEyebrowDot, { backgroundColor: accent || colors.primary }]} />
          <Text style={[styles.sectionEyebrow, { color: colors.textMuted }]}>
            {icon ? <Ionicons name={icon} size={11} color={accent || colors.textMuted} /> : null}{icon ? '  ' : ''}{title}
          </Text>
        </View>
        {typeof count === 'number' ? (
          <View style={[
            styles.sectionCount,
            { backgroundColor: withAlpha(accent || colors.primary, 0.16), borderColor: withAlpha(accent || colors.primary, 0.35) },
          ]}>
            <Text style={[styles.sectionCountText, { color: accent || colors.primary }]}>{count}</Text>
          </View>
        ) : null}
      </View>
      {children}
    </View>
  );
}

// ─── Autonomy Status strip ──────────────────────────────────────────

function AutonomyStrip({ status, colors, styles }) {
  const mode    = status?.mode || status?.autonomyMode || '—';
  const paused  = status?.paused || status?.pause?.active;
  const running = status?.queue?.running || null;
  const queued  = Array.isArray(status?.queue?.pending) ? status.queue.pending.length
               : (Array.isArray(status?.queue?.queued) ? status.queue.queued.length : 0);
  const budgetUsed = status?.budget?.usedToday ?? status?.budget?.today?.spent ?? null;
  const budgetCap  = status?.budget?.dailyLimit ?? status?.budget?.today?.limit ?? null;

  const pills = [
    { label: 'MODE', value: String(mode).toUpperCase(), color: paused ? colors.warning : colors.success },
    { label: 'PAUSED', value: paused ? 'YES' : 'NO', color: paused ? colors.warning : colors.textMuted },
    { label: 'RUNNING', value: running ? '1' : '0', color: running ? colors.success : colors.textMuted },
    { label: 'QUEUED', value: String(queued), color: queued > 0 ? colors.primary : colors.textMuted },
  ];

  if (budgetCap) {
    pills.push({
      label: 'BUDGET',
      value: `$${(budgetUsed || 0).toFixed(2)} / $${budgetCap.toFixed(2)}`,
      color: colors.info || colors.cyan || colors.primary,
    });
  }

  return (
    <GlassSurface depth={2} radius={14} style={styles.autonomyCard}>
      <View style={styles.autonomyCardInner}>
        <View style={styles.autonomyRow}>
          {pills.map((p, idx) => (
            <View key={idx} style={[
              styles.autonomyPill,
              { borderColor: withAlpha(p.color, 0.4), backgroundColor: withAlpha(p.color, 0.1) },
            ]}>
              <Text style={[styles.autonomyPillLabel, { color: colors.textMuted }]}>{p.label}</Text>
              <Text style={[styles.autonomyPillValue, { color: p.color }]} numberOfLines={1}>{p.value}</Text>
            </View>
          ))}
        </View>
        {running?.title ? (
          <Text style={styles.autonomyRunningText} numberOfLines={1}>
            <Ionicons name="play" size={10} color={colors.primary} /> {running.title}
          </Text>
        ) : null}
      </View>
    </GlassSurface>
  );
}

// ─── Focus Modal (single-session deep view) ─────────────────────────

function FocusTranscriptItem({ item, colors, styles, isLast }) {
  const isAssistant = item.role === 'assistant';
  const isUser      = item.role === 'user';
  const isSystem    = item.role === 'system' || item.actionType;

  if (isSystem) {
    const outcomeColor = item.outcome === 'failure' ? colors.error : colors.warning;
    return (
      <View style={[styles.systemItem, isLast && styles.itemNoBorder]}>
        <View style={styles.systemIconWrap}>
          <Ionicons name="cog-outline" size={14} color={colors.primary} />
        </View>
        <View style={styles.systemContent}>
          <Text style={styles.systemText}>{typeof item.content === 'string' ? item.content : ''}</Text>
          <View style={styles.systemMeta}>
            <Text style={styles.systemTime}>{formatTime(item.timestamp)}</Text>
            {item.outcome && item.outcome !== 'success' ? (
              <View style={[styles.outcomeBadge, { backgroundColor: withAlpha(outcomeColor, 0.18) }]}>
                <Text style={[styles.outcomeText, { color: outcomeColor }]}>{item.outcome}</Text>
              </View>
            ) : null}
          </View>
        </View>
      </View>
    );
  }

  const bubbleTint = isAssistant
    ? withAlpha(colors.primary, 0.06)
    : isUser
      ? withAlpha(colors.accent || colors.secondary || colors.primary, 0.07)
      : 'transparent';
  const roleColor = isAssistant
    ? colors.primary
    : colors.accent || colors.secondary || colors.info;

  const rawContent = item.content;
  const displayContent = Array.isArray(rawContent)
    ? rawContent.filter(b => b.type === 'text').map(b => b.text).join('')
    : (rawContent || '');

  return (
    <View style={[styles.messageItem, { backgroundColor: bubbleTint }, isLast && styles.itemNoBorder]}>
      <View style={styles.messageHeader}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
          <Ionicons name={isAssistant ? 'hardware-chip-outline' : 'person-outline'} size={12} color={roleColor} />
          <Text style={[styles.messageRole, { color: roleColor }]}>
            {isAssistant ? 'Ash' : 'You'}
          </Text>
        </View>
        <Text style={styles.messageTime}>{formatTime(item.timestamp)}</Text>
      </View>
      <Text style={styles.messageText}>{displayContent}</Text>
      {item.toolCalls?.length > 0 ? (
        <View style={styles.inlineTools}>
          {item.toolCalls.slice(0, 3).map((tool, i) => (
            <View key={i} style={styles.inlineTool}>
              <Text style={styles.inlineToolText}><Ionicons name="flash-outline" size={9} color={colors.primary} /> {tool.name || tool.function?.name}</Text>
            </View>
          ))}
          {item.toolCalls.length > 3 ? (
            <Text style={styles.moreTools}>+{item.toolCalls.length - 3} more</Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

// ── Overview tab ────────────────────────────────────────────────────
// Web parity: shows the task description, linked project, kanban tasks,
// content pages, files touched (with action colour-coding), and a metadata
// grid. Pulls from the subagents.detail envelope. All cross-screen jumps go
// through navigation.navigate so the user lands on the linked surface.

const _fileActionColor = {
  created: '#22c55e',
  edited: '#f59e0b',
  deleted: '#ef4444',
  read: 'rgba(255,255,255,0.5)',
};

function _fileAction(action) {
  const a = String(action || 'edited').toLowerCase();
  if (a in _fileActionColor) return a;
  return 'edited';
}

function FilesTouchedList({ files, totalCount, colors, styles }) {
  const [showAll, setShowAll] = useState(false);
  const VISIBLE = 25;
  const visible = showAll ? files : files.slice(0, VISIBLE);
  const groups = {};
  for (const f of files) {
    const a = _fileAction(f.action);
    groups[a] = (groups[a] || 0) + 1;
  }
  const order = ['created', 'edited', 'deleted', 'read'];
  return (
    <View>
      <View style={styles.overviewActionBadgesRow}>
        {order.filter((a) => groups[a]).map((a) => (
          <View
            key={a}
            style={[
              styles.overviewActionBadge,
              { borderColor: withAlpha(_fileActionColor[a], 0.5), backgroundColor: withAlpha(_fileActionColor[a], 0.14) },
            ]}
          >
            <Text style={[styles.overviewActionBadgeText, { color: _fileActionColor[a] }]}>
              {a.toUpperCase()} {groups[a]}
            </Text>
          </View>
        ))}
        {totalCount && totalCount > files.length ? (
          <View style={[styles.overviewActionBadge, { borderColor: withAlpha(colors.textMuted, 0.4) }]}>
            <Text style={[styles.overviewActionBadgeText, { color: colors.textMuted }]}>
              {totalCount} TOTAL
            </Text>
          </View>
        ) : null}
      </View>
      {files.length === 0 ? (
        <Text style={[styles.overviewEmpty, { color: colors.textMuted }]}>No file activity recorded.</Text>
      ) : (
        <View>
          {visible.map((f, idx) => {
            const a = _fileAction(f.action);
            const parts = String(f.path || '').replace(/\\/g, '/').split('/').filter(Boolean);
            const base = parts[parts.length - 1] || f.path;
            const dir = parts.length > 1 ? parts.slice(0, -1).join('/') : '';
            return (
              <View key={`${f.path}-${idx}`} style={styles.overviewFileRow}>
                <Text style={[styles.overviewFileActLetter, { color: _fileActionColor[a] }]}>
                  {a[0].toUpperCase()}
                </Text>
                <View style={{ flex: 1 }}>
                  {dir ? (
                    <Text style={styles.overviewFileDir} numberOfLines={1}>{dir}/</Text>
                  ) : null}
                  <Text style={styles.overviewFileBase} numberOfLines={1}>{base}</Text>
                </View>
              </View>
            );
          })}
          {!showAll && files.length > VISIBLE ? (
            <TouchableOpacity onPress={() => setShowAll(true)} style={styles.overviewLinkBtn}>
              <Text style={[styles.overviewLinkBtnText, { color: colors.primary }]}>
                Show all ({files.length})
              </Text>
            </TouchableOpacity>
          ) : null}
          {showAll && files.length > VISIBLE ? (
            <TouchableOpacity onPress={() => setShowAll(false)} style={styles.overviewLinkBtn}>
              <Text style={[styles.overviewLinkBtnText, { color: colors.primary }]}>Collapse</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      )}
    </View>
  );
}

function OverviewSection({ label, count, colors, styles, children, trailing }) {
  return (
    <View style={styles.overviewSection}>
      <View style={styles.overviewSectionHeader}>
        <Text style={[styles.overviewSectionLabel, { color: colors.textMuted }]}>{label}</Text>
        {typeof count === 'number' && count > 0 ? (
          <Text style={[styles.overviewSectionCount, { color: colors.primary }]}>{count}</Text>
        ) : null}
        {trailing || null}
      </View>
      {children}
    </View>
  );
}

function OverviewRow({ icon, title, sub, onPress, colors, styles }) {
  return (
    <TouchableOpacity
      activeOpacity={0.75}
      style={styles.overviewRow}
      onPress={onPress}
      disabled={!onPress}
    >
      <Ionicons name={icon} size={16} color={colors.primary} />
      <View style={{ flex: 1 }}>
        <Text style={[styles.overviewRowTitle, { color: colors.text }]} numberOfLines={1}>{title}</Text>
        {sub ? (
          <Text style={[styles.overviewRowSub, { color: colors.textMuted }]} numberOfLines={1}>{sub}</Text>
        ) : null}
      </View>
      {onPress ? <Ionicons name="chevron-forward" size={14} color={colors.textMuted} /> : null}
    </TouchableOpacity>
  );
}

function OverviewTab({ detail, runDetail, subagent, target, sessionKey, navigation, onClose, colors, styles }) {
  const run = detail?.run || runDetail || subagent || null;
  const project = detail?.project || null;
  const tasks = detail?.tasks || (detail?.task ? [detail.task] : []);
  const contentPages = detail?.contentPages || [];
  const isArchived = detail?.source === 'archive';

  const files = run?.filesTouched
    ? run.filesTouched
    : (run?.filesTouchedSample || []).map((p) => ({
        path: p, action: 'edited', at: run?.endedAt || 0,
      }));

  const taskText = run?.task || target?.title || '';

  const openInKanban = (projectId, taskId) => {
    if (!navigation) return;
    onClose?.();
    // Consistent deep-link shape with AgentFocusSheet ({ taskId, projectId });
    // _ts makes repeat taps re-fire KanbanScreen's deep-link consumer.
    // Board lives inside the tab root; pop back to it (never stack a second copy).
    try { navigation.navigate('MainTabs', { screen: 'Board', params: { taskId, projectId, _ts: Date.now() } }, { pop: true }); } catch {}
  };

  return (
    <View>
      {isArchived ? (
        <GlassSurface depth={2} radius={14} style={{ marginBottom: SPACING.md }}>
          <View style={[styles.failureBanner, { padding: SPACING.md }]}>
            <Ionicons name="archive-outline" size={16} color={colors.textMuted} />
            <View style={{ flex: 1 }}>
              <Text style={[styles.failureBannerLabel, { color: colors.textMuted }]}>ARCHIVED</Text>
              <Text style={styles.failureBannerText}>
                Completed run — live progress no longer available. Showing the archived summary.
              </Text>
            </View>
          </View>
        </GlassSurface>
      ) : null}

      <GlassSurface depth={2} radius={14} style={{ marginBottom: SPACING.md }}>
        <View style={{ padding: SPACING.md }}>
          <OverviewSection label="TASK" colors={colors} styles={styles}>
            <Text style={[styles.overviewTaskText, { color: colors.text }]}>
              {taskText || '—'}
            </Text>
          </OverviewSection>

          {project ? (
            <OverviewSection label="LINKED PROJECT" colors={colors} styles={styles}>
              <OverviewRow
                icon="folder-outline"
                title={project.name || project.id}
                sub={project.id ? String(project.id).slice(0, 16) : ''}
                onPress={() => openInKanban(project.id, tasks?.[0]?.id)}
                colors={colors}
                styles={styles}
              />
            </OverviewSection>
          ) : null}

          <OverviewSection label="KANBAN TASKS" count={tasks.length} colors={colors} styles={styles}>
            {tasks.length === 0 ? (
              <Text style={[styles.overviewEmpty, { color: colors.textMuted }]}>No linked tasks.</Text>
            ) : (
              tasks.map((t) => (
                <OverviewRow
                  key={t.id}
                  icon="checkbox-outline"
                  title={t.title || t.id}
                  sub={`${t.projectName || project?.name || '—'} · ${(t.status || '').replace('_', ' ')}`}
                  onPress={() => openInKanban(t.projectId || project?.id, t.id)}
                  colors={colors}
                  styles={styles}
                />
              ))
            )}
          </OverviewSection>

          <OverviewSection label="CONTENT PAGES" count={contentPages.length} colors={colors} styles={styles}>
            {contentPages.length === 0 ? (
              <Text style={[styles.overviewEmpty, { color: colors.textMuted }]}>
                No content pages linked to this agent.
              </Text>
            ) : (
              contentPages.map((p) => (
                <OverviewRow
                  key={p.id}
                  icon="document-text-outline"
                  title={p.name}
                  sub={`${(p.surface || '').toUpperCase()}${p.handle ? ` · @${p.handle}` : ''} · updated ${timeAgo(p.updatedAt)}`}
                  onPress={() => {
                    // Open the SPECIFIC page: external url when present, else the
                    // Notes screen keyed by the page id (mirrors AgentFocusSheet).
                    if (p.url) { Linking.openURL(p.url).catch(() => {}); return; }
                    onClose?.();
                    try { navigation?.navigate('Notes', { noteId: p.id, contentPageId: p.id }); } catch {}
                  }}
                  colors={colors}
                  styles={styles}
                />
              ))
            )}
          </OverviewSection>

          <OverviewSection label="FILES TOUCHED" colors={colors} styles={styles}>
            <FilesTouchedList
              files={files}
              totalCount={run?.filesTouchedCount}
              colors={colors}
              styles={styles}
            />
          </OverviewSection>

          <OverviewSection label="METADATA" colors={colors} styles={styles}>
            <View style={styles.overviewMetaGrid}>
              {run?.workdir ? (
                <View style={styles.overviewMetaCell}>
                  <Text style={[styles.overviewMetaKey, { color: colors.textMuted }]}>WORKDIR</Text>
                  <Text style={[styles.overviewMetaVal, { color: colors.text }]} numberOfLines={1}>{run.workdir}</Text>
                </View>
              ) : null}
              {run?.childPid ? (
                <View style={styles.overviewMetaCell}>
                  <Text style={[styles.overviewMetaKey, { color: colors.textMuted }]}>PID</Text>
                  <Text style={[styles.overviewMetaVal, { color: colors.text }]}>{run.childPid}</Text>
                </View>
              ) : null}
              {run?.claudeSessionId ? (
                <View style={styles.overviewMetaCell}>
                  <Text style={[styles.overviewMetaKey, { color: colors.textMuted }]}>SESSION</Text>
                  <Text style={[styles.overviewMetaVal, { color: colors.text }]} numberOfLines={1}>
                    {String(run.claudeSessionId).slice(0, 18)}…
                  </Text>
                </View>
              ) : null}
              {sessionKey ? (
                <View style={styles.overviewMetaCell}>
                  <Text style={[styles.overviewMetaKey, { color: colors.textMuted }]}>REQUESTER</Text>
                  <Text style={[styles.overviewMetaVal, { color: colors.text }]} numberOfLines={1}>{sessionKey}</Text>
                </View>
              ) : null}
              {run?.coderBackend ? (
                <View style={styles.overviewMetaCell}>
                  <Text style={[styles.overviewMetaKey, { color: colors.textMuted }]}>BACKEND</Text>
                  <Text style={[styles.overviewMetaVal, { color: colors.text }]}>{run.coderBackend}</Text>
                </View>
              ) : null}
              {run?.respawnOfRunId ? (
                <View style={styles.overviewMetaCell}>
                  <Text style={[styles.overviewMetaKey, { color: colors.textMuted }]}>RESPAWN OF</Text>
                  <Text style={[styles.overviewMetaVal, { color: colors.text }]} numberOfLines={1}>
                    #{String(run.respawnOfRunId).slice(0, 12)}
                  </Text>
                </View>
              ) : null}
            </View>
          </OverviewSection>
        </View>
      </GlassSurface>
    </View>
  );
}

// ── Tool Calls tab ──────────────────────────────────────────────────

function ToolCallsTab({ toolStream, colors, styles }) {
  if (!toolStream || toolStream.length === 0) {
    return (
      <GlassSurface depth={2} radius={14}>
        <View style={styles.emptyContainer}>
          <Ionicons name="construct-outline" size={32} color={colors.textMuted} />
          <Text style={styles.emptyText}>No tool calls yet</Text>
          <Text style={styles.emptyHint}>
            Live tool_use / tool_result events from the agent will appear here.
          </Text>
        </View>
      </GlassSurface>
    );
  }
  return (
    <GlassSurface depth={2} radius={14}>
      <View style={{ paddingVertical: 4 }}>
        {toolStream.map((t, idx) => {
          const isCall = t.kind === 'tool_use';
          const color = isCall ? (colors.info || colors.cyan || '#22d3ee') : colors.textMuted;
          const text = isCall
            ? `${t.toolName}(${(typeof t.args === 'string' ? t.args : JSON.stringify(t.args || ''))?.slice(0, 200)})`
            : (t.error
                ? `ERROR: ${String(t.error).slice(0, 300)}`
                : String(typeof t.result === 'string' ? t.result : JSON.stringify(t.result || '')).slice(0, 300));
          return (
            <View key={`tc-${idx}`} style={styles.toolCallRow}>
              <View style={[styles.toolCallLabel, { borderColor: withAlpha(color, 0.5), backgroundColor: withAlpha(color, 0.14) }]}>
                <Text style={[styles.toolCallLabelText, { color }]}>{isCall ? 'CALL' : 'RESULT'}</Text>
              </View>
              <Text style={[styles.toolCallText, { color: colors.text }]} numberOfLines={6}>
                {text}
              </Text>
              <Text style={[styles.toolCallTime, { color: colors.textMuted }]}>{formatTime(t.ts)}</Text>
            </View>
          );
        })}
      </View>
    </GlassSurface>
  );
}

// ── Output tab ──────────────────────────────────────────────────────

function OutputTab({ toolStream, colors, styles }) {
  const results = (toolStream || [])
    .filter((t) => t.kind === 'tool_result')
    .slice(-20);
  if (results.length === 0) {
    return (
      <GlassSurface depth={2} radius={14}>
        <View style={styles.emptyContainer}>
          <Ionicons name="terminal-outline" size={32} color={colors.textMuted} />
          <Text style={styles.emptyText}>No output captured yet</Text>
          <Text style={styles.emptyHint}>
            The most recent stdout / stderr chunks from tool results will appear here.
          </Text>
        </View>
      </GlassSurface>
    );
  }
  return (
    <View>
      {results.map((t, idx) => {
        const txt = t.error
          ? `[error] ${t.error}`
          : (typeof t.result === 'string' ? t.result : JSON.stringify(t.result, null, 2));
        return (
          <GlassSurface depth={2} radius={14} key={`out-${idx}`} style={{ marginBottom: SPACING.sm }}>
            <View style={styles.outputBlockHeader}>
              <Text style={[styles.outputBlockTime, { color: colors.textMuted }]}>
                {formatTime(t.ts)}{t.durationMs ? ` · ${fmtDuration(t.durationMs)}` : ''}
              </Text>
            </View>
            <Text style={styles.outputBlockText} selectable>
              {String(txt).slice(0, 4000)}
            </Text>
          </GlassSurface>
        );
      })}
    </View>
  );
}

// ── History tab ─────────────────────────────────────────────────────

function HistoryTab({ activity, colors, styles }) {
  if (!activity || activity.length === 0) {
    return (
      <GlassSurface depth={2} radius={14}>
        <View style={styles.emptyContainer}>
          <Ionicons name="time-outline" size={32} color={colors.textMuted} />
          <Text style={styles.emptyText}>No history yet</Text>
          <Text style={styles.emptyHint}>
            A flat read-only replay of the session's transcript turns lands here.
          </Text>
        </View>
      </GlassSurface>
    );
  }
  return (
    <GlassSurface depth={2} radius={14}>
      <View style={{ paddingVertical: 4 }}>
        {activity.map((item, idx) => {
          const role = item.role || (item.actionType ? 'system' : 'other');
          const text = typeof item.content === 'string'
            ? item.content
            : Array.isArray(item.content)
              ? item.content.filter((b) => b.type === 'text').map((b) => b.text).join('')
              : '';
          const color =
            role === 'assistant' ? colors.primary
            : role === 'user'     ? (colors.warning || colors.primary)
            : role === 'system'   ? colors.textMuted
            : colors.text;
          return (
            <View
              key={`h-${idx}-${item.timestamp || idx}`}
              style={[styles.historyRow, idx === activity.length - 1 && styles.itemNoBorder]}
            >
              <Text style={[styles.historyRole, { color }]}>{role.toUpperCase()}</Text>
              <Text style={[styles.historyText, { color: colors.text }]} numberOfLines={4}>
                {String(text).slice(0, 400)}{text.length > 400 ? '…' : ''}
              </Text>
              <Text style={[styles.historyTime, { color: colors.textMuted }]}>
                {formatTime(item.timestamp)}
              </Text>
            </View>
          );
        })}
      </View>
    </GlassSurface>
  );
}

function FocusModal({
  visible,
  target,           // { sessionKey, title, status, subagent? }
  onClose,
  onOpenTerminal,
  navigation,
  gateway,
  colors,
  styles,
}) {
  const { status: connStatus, sendReq, subscribeEvent } = gateway || {};
  const connected = connStatus === 'connected';

  const sessionKey = target?.sessionKey || null;
  const [activity, setActivity] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [respawning, setRespawning] = useState(false);
  const [currentStatus, setCurrentStatus] = useState(target?.status || 'idle');
  const [subagent, setSubagent] = useState(target?.subagent || null);
  // Chronological progress updates for the run (status pings + checkpoints).
  // Populated from `subagents.status` so the modal renders the full activity
  // feed the user reviews before pressing "Respawn".
  const [progressUpdates, setProgressUpdates] = useState([]);
  // Full detail blob (carries respawnOfRunId, outcome.error, files touched, …).
  const [runDetail, setRunDetail] = useState(null);
  // Full detail envelope from subagents.detail: { run, project, task, tasks[], contentPages[], source }.
  // Used by the Overview tab to render links into Kanban / Content Pages.
  const [detail, setDetail] = useState(null);

  // Web-parity additions: tabs, capabilities, transcript, tool stream, edit/compact controls.
  const [activeTab, setActiveTab] = useState('overview');
  // sessions.capabilities → which controls to show. `send` defaults true to match
  // the mobile composer's previous behaviour until the capabilities probe lands.
  const [capabilities, setCapabilities] = useState({ pause: false, send: true, edit: false, fork: false });
  const [paused, setPaused] = useState(false);
  // Stream of tool_use / tool_result pairs (parsed from live `agent` events).
  const [toolStream, setToolStream] = useState([]);
  // Last assistant editing flow (parallel to web `editingLastAssistant`).
  const [editing, setEditing] = useState(false);
  const [editDraft, setEditDraft] = useState('');
  const [pauseBusy, setPauseBusy] = useState(false);
  const [compactBusy, setCompactBusy] = useState(false);
  const [showJumpToLive, setShowJumpToLive] = useState(false);
  const stickToBottomRef = useRef(true);

  // Hardware data for the host node (enabled only while modal is open).
  const { snapshot: hwSnapshot, nodes: hwNodes } = useHardware({ enabled: visible });
  const hostHw = useMemo(() => {
    const nodeName = subagent?.nodeName || subagent?.nodeId || null;
    if (!nodeName) return hwSnapshot || null;
    return hwNodes?.find(
      n => n.id === nodeName || n.nodeId === nodeName || n.name === nodeName,
    ) || hwSnapshot || null;
  }, [hwNodes, hwSnapshot, subagent?.nodeName, subagent?.nodeId]);

  const scrollRef = useRef(null);
  const pollRef = useRef(null);

  const load = useCallback(async () => {
    if (!visible || !connected || !sendReq || !sessionKey) return;
    try {
      const items = [];

      // sessions.preview is the canonical transcript fetch on the gateway.
      // It takes `keys: string[]` (NOT singular `sessionKey`) and returns
      // `{ previews: [{ key, status, items: [...] }] }`. The earlier shape
      // (`{ sessionKey, messages }`) silently returned nothing, which is
      // why this modal looked empty for everyone.
      try {
        const previewRes = await sendReq('sessions.preview', {
          keys: [sessionKey],
          limit: 80,
          maxChars: 8000,
        });
        const previewItems = previewRes?.previews?.[0]?.items ?? [];
        for (const m of previewItems) {
          items.push({ ...m, timestamp: m.timestamp || m.ts || Date.now() });
        }
      } catch {}

      // Sync status from subagents.list if this session is a subagent.
      let matchedRunId = null;
      try {
        const subRes = await sendReq('subagents.list', { includeCompleted: true, limit: 100 });
        if (subRes?.subagents) {
          const match = subRes.subagents.find(
            sa => sa.sessionKey === sessionKey || sa.runId === sessionKey || (sessionKey || '').includes(sa.runId || '')
          );
          if (match) {
            setSubagent(match);
            matchedRunId = match.runId;
            const cls = classifyStatus(match.status);
            if (cls === 'active') setCurrentStatus('running');
            else if (cls === 'error') setCurrentStatus('failed');
            else if (cls === 'done') setCurrentStatus('completed');
          }
        }
      } catch {}

      // Pull progress updates + detail (carries respawnOfRunId, outcome.error).
      // Best-effort — older gateways may not have subagents.detail.
      const runIdForLookup = matchedRunId || target?.subagent?.runId || null;
      if (runIdForLookup) {
        try {
          const statusRes = await sendReq('subagents.status', { runId: runIdForLookup });
          const updates = Array.isArray(statusRes?.subagent?.updates)
            ? statusRes.subagent.updates
            : [];
          if (updates.length > 0) setProgressUpdates(updates);
          // Fold every progress checkpoint into the activity timeline so the
          // modal shows the agent's self-reports inline with the transcript.
          for (const u of updates) {
            items.push({
              role: 'system',
              actionType: 'subagent_progress',
              outcome:
                u.status === 'blocked'
                  ? 'failure'
                  : u.status === 'finishing'
                  ? 'success'
                  : 'pending',
              content: `${(u.status || 'update').toUpperCase()} · ${u.message ?? ''}${
                u.checkpoint ? ` (${u.checkpoint})` : ''
              }${typeof u.progress === 'number' ? ` — ${Math.round(u.progress)}%` : ''}`,
              timestamp: u.timestamp || Date.now(),
            });
          }
          const lastActivity = statusRes?.subagent?.lastActivity;
          if (lastActivity?.label) {
            items.push({
              role: 'system',
              actionType: 'subagent_activity',
              outcome: 'pending',
              content: `Now: ${lastActivity.label}`,
              timestamp: lastActivity.at || Date.now(),
            });
          }
        } catch {}
        try {
          const detailRes = await sendReq('subagents.detail', { runId: runIdForLookup });
          if (detailRes?.run) setRunDetail(detailRes.run);
          // Capture the full envelope for the Overview tab. Web's subagents.detail
          // returns { run, project, task, tasks[], contentPages[], source }. Older
          // gateways may omit these fields — render-side guards handle that.
          if (detailRes?.ok || detailRes?.run) {
            setDetail({
              run: detailRes.run,
              project: detailRes.project,
              task: detailRes.task,
              tasks: detailRes.tasks ?? (detailRes.task ? [detailRes.task] : []),
              contentPages: detailRes.contentPages ?? [],
              source: detailRes.source ?? 'live',
            });
          }
        } catch {}

        // Capabilities probe — tells us which controls (pause/send/edit/fork)
        // and live composer to render. Best-effort; web defaults are conservative.
        try {
          const capRes = await sendReq('sessions.capabilities', {
            runId: runIdForLookup,
            sessionKey,
          });
          if (capRes?.ok && capRes.supports) {
            setCapabilities(capRes.supports);
            setPaused(!!capRes.paused);
          }
        } catch {}
      }

      // For autonomy-task sessions, pull the per-task audit feed so the
      // modal also shows iteration_start / build_done / tester verdicts.
      try {
        const taskId = (sessionKey || '').match(/task_[a-z0-9_]+/i)?.[0];
        if (taskId) {
          const actRes = await sendReq('autonomy:queue.activity', { taskId, limit: 60 });
          for (const e of actRes?.entries ?? []) {
            items.push({
              role: 'system',
              actionType: e.kind || 'audit',
              outcome: e.outcome || 'pending',
              content: `${e.title ?? e.kind ?? 'event'}${e.detail ? ` — ${e.detail}` : ''}`,
              timestamp: e.timestamp || Date.now(),
            });
          }
        }
      } catch {}

      items.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
      setActivity(items);
    } catch (e) {
      console.warn('FocusModal load failed:', e);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [visible, connected, sendReq, sessionKey]);

  // Reset + poll while visible.
  useEffect(() => {
    if (!visible) return undefined;
    setLoading(true);
    setActivity([]);
    setProgressUpdates([]);
    setRunDetail(null);
    setDetail(null);
    setToolStream([]);
    setEditing(false);
    setEditDraft('');
    setShowJumpToLive(false);
    stickToBottomRef.current = true;
    setActiveTab('overview');
    setCapabilities({ pause: false, send: true, edit: false, fork: false });
    setPaused(false);
    setCurrentStatus(target?.status || 'idle');
    setSubagent(target?.subagent || null);
    load();
    pollRef.current = setInterval(load, 5000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [visible, sessionKey, load]);

  // Live `agent` stream subscription — mirrors the web modal's `client.subscribe`
  // dispatch. Streams text deltas into the activity feed and accumulates tool
  // calls/results for the Tool Calls + Output tabs.
  useEffect(() => {
    if (!visible || !subscribeEvent) return undefined;
    const runId =
      subagent?.runId || target?.subagent?.runId || runDetail?.runId || detail?.run?.runId || null;
    if (!runId) return undefined;
    const unsub = subscribeEvent('agent', (payload) => {
      if (!payload || payload.runId !== runId) return;
      const data = payload.data ?? {};
      if (payload.stream === 'tool') {
        const phase = data.phase;
        if (phase === 'start') {
          setToolStream((prev) => [
            ...prev,
            {
              kind: 'tool_use',
              toolName: String(data.name ?? 'tool'),
              toolCallId: data.toolCallId ?? null,
              args: data.arguments,
              ts: payload.ts || Date.now(),
            },
          ]);
        } else if (phase === 'end') {
          setToolStream((prev) => [
            ...prev,
            {
              kind: 'tool_result',
              toolCallId: data.toolCallId ?? null,
              result: data.result,
              error: data.error || null,
              durationMs: data.durationMs ?? null,
              ts: payload.ts || Date.now(),
            },
          ]);
        }
      } else if (payload.stream === 'text' && data.deltaText) {
        // Append streaming text as a transient assistant entry in the activity feed.
        setActivity((prev) => {
          const last = prev[prev.length - 1];
          const ts = payload.ts || Date.now();
          if (last && last.role === 'assistant' && last._streaming) {
            const updated = [...prev];
            updated[updated.length - 1] = {
              ...last,
              content: (typeof last.content === 'string' ? last.content : '') + data.deltaText,
              timestamp: ts,
            };
            return updated;
          }
          return [
            ...prev,
            {
              role: 'assistant',
              content: data.deltaText,
              timestamp: ts,
              _streaming: true,
            },
          ];
        });
      } else if (payload.stream === 'state') {
        const state = data?.state;
        if (state === 'paused') {
          setPaused(true);
          setCurrentStatus('paused');
        } else if (state === 'running') {
          setPaused(false);
          setCurrentStatus('running');
        } else if (state === 'finished') {
          setCurrentStatus('completed');
        } else if (state === 'error') {
          setCurrentStatus('failed');
        }
      }
    });
    return () => { try { unsub?.(); } catch {} };
  }, [
    visible,
    subscribeEvent,
    subagent?.runId,
    target?.subagent?.runId,
    runDetail?.runId,
    detail?.run?.runId,
  ]);

  // Live event subscription — refresh on session events for this key.
  useEffect(() => {
    if (!visible || !subscribeEvent || !sessionKey) return undefined;
    let timer = null;
    const handler = (payload) => {
      // `chat` streams a delta per token — only settle states are worth a reload.
      if (payload?.state === 'delta') return;
      const key = payload?.sessionKey || payload?.session?.key;
      if (!key || key === sessionKey) {
        // Coalesce bursts — the interval will catch up if anything slipped through.
        if (timer) return;
        timer = setTimeout(() => { timer = null; load(); }, 200);
      }
    };
    const unsubs = [];
    // The gateway has no `sessions.update` event; transcript changes for a
    // session arrive on `chat` ({ sessionKey, state }) — see GATEWAY_EVENTS in
    // src/gateway/server-methods-list.ts.
    try { unsubs.push(subscribeEvent('chat', handler)); } catch {}
    try { unsubs.push(subscribeEvent('session.message', handler)); } catch {}
    try { unsubs.push(subscribeEvent('subagents.update', handler)); } catch {}
    return () => {
      if (timer) clearTimeout(timer);
      unsubs.forEach(u => { try { u?.(); } catch {} });
    };
  }, [visible, sessionKey, subscribeEvent, load]);

  useEffect(() => {
    if (activity.length > 0 && scrollRef.current) {
      setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 100);
    }
  }, [activity.length]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    load();
  }, [load]);

  const handleSend = async () => {
    if (!message.trim() || !connected || sending || !sessionKey) return;
    setSending(true);
    try {
      // session.send is the canonical alias for chat.send registered in
      // the gateway. Mirrors the federation pipe's naming so a satellite
      // session and a master session look identical from this screen.
      await sendReq('session.send', { sessionKey, message: message.trim() });
      setMessage('');
      setTimeout(load, 600);
    } catch {
      // Last-resort fallback: target the main agent transcript with the
      // session id inlined so the message isn't lost when the session
      // can't be addressed directly.
      try {
        await sendReq('chat.send', {
          sessionKey: 'agent:main',
          message: `[Session ${sessionKey}]\n\n${message.trim()}`,
          idempotencyKey: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        });
        setMessage('');
        setTimeout(load, 600);
      } catch {}
    } finally {
      setSending(false);
    }
  };

  const handleAbort = () => {
    if (!sessionKey || !connected) return;
    Alert.alert(
      'Abort Session',
      'Send an abort signal to the running session?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Abort',
          style: 'destructive',
          onPress: async () => {
            setStopping(true);
            try {
              await sendReq('chat.abort', { sessionKey });
              setCurrentStatus('completed');
            } catch (e) {
              // chat.abort requires sessionKey, so there is no key-less fallback.
              Alert.alert('Abort failed', String(e?.message || e));
            } finally {
              setStopping(false);
            }
          },
        },
      ]
    );
  };

  // Resolve the runId we'd respawn — prefer the subagent record (matched by
  // session lookup in load()) and fall back to the target's seeded subagent.
  const respawnRunId = subagent?.runId || target?.subagent?.runId || runDetail?.runId || null;
  // A run is "failed" if its registry status is in ERROR_STATUSES, OR the
  // detail blob carries an outcome.status === 'error', OR the current ui
  // status the modal is showing is 'failed'.
  const outcomeFailed =
    runDetail?.outcome?.status === 'error' ||
    subagent?.outcome?.status === 'error';
  const isFailed =
    outcomeFailed ||
    ERROR_STATUSES.has(String(subagent?.status || '').toLowerCase()) ||
    ERROR_STATUSES.has(String(currentStatus || '').toLowerCase());

  const handleRespawn = () => {
    if (!respawnRunId || !connected || respawning) return;
    Alert.alert(
      'Respawn Agent',
      'Spawn a new run with the original task and a preamble describing the prior progress. The new agent will resume from where this one failed.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Respawn',
          style: 'default',
          onPress: async () => {
            setRespawning(true);
            try {
              const res = await sendReq('subagents.respawn', { runId: respawnRunId });
              if (res?.ok) {
                Alert.alert(
                  'Respawn started',
                  res?.newRunId
                    ? `New runId: ${String(res.newRunId).slice(0, 16)}…`
                    : 'New run created. Check the Active list.',
                );
                onClose?.();
              } else {
                Alert.alert('Respawn failed', String(res?.error || 'Unknown error'));
              }
            } catch (e) {
              Alert.alert('Respawn failed', String(e?.message || e));
            } finally {
              setRespawning(false);
            }
          },
        },
      ],
    );
  };

  const runIdForControls =
    subagent?.runId || target?.subagent?.runId || runDetail?.runId || detail?.run?.runId || null;

  const handlePauseToggle = async () => {
    if (!connected || pauseBusy) return;
    const wantPaused = !paused;
    setPauseBusy(true);
    try {
      await sendReq(wantPaused ? 'sessions.pause' : 'sessions.resume', {
        runId: runIdForControls,
        sessionKey,
      });
      setPaused(wantPaused);
      setCurrentStatus(wantPaused ? 'paused' : 'running');
    } catch (e) {
      Alert.alert(wantPaused ? 'Pause failed' : 'Resume failed', String(e?.message || e));
    } finally {
      setPauseBusy(false);
    }
  };

  const handleCompact = async () => {
    if (!connected || compactBusy) return;
    setCompactBusy(true);
    try {
      await sendReq('sessions.compact', { key: sessionKey });
      Alert.alert('Compacting', 'Context compaction requested.');
    } catch (e) {
      Alert.alert('Compact failed', String(e?.message || e));
    } finally {
      setCompactBusy(false);
    }
  };

  const handleEditToggle = () => {
    if (!capabilities.edit) return;
    if (editing) {
      setEditing(false);
      setEditDraft('');
      return;
    }
    // Seed the draft with the most recent assistant turn's plain-text content.
    const lastAssist = [...activity].reverse().find((it) => it.role === 'assistant');
    const seed = typeof lastAssist?.content === 'string'
      ? lastAssist.content
      : Array.isArray(lastAssist?.content)
        ? lastAssist.content.filter((b) => b.type === 'text').map((b) => b.text).join('')
        : '';
    setEditDraft(seed);
    setEditing(true);
  };

  const handleEditSave = async () => {
    const corrected = editDraft.trim();
    if (!corrected || !connected) return;
    setEditing(false);
    setActivity((prev) => [
      ...prev,
      {
        role: 'system',
        actionType: 'edit_assistant',
        outcome: 'pending',
        content: `[Edited last assistant response]: ${corrected.slice(0, 200)}${corrected.length > 200 ? '…' : ''}`,
        timestamp: Date.now(),
      },
    ]);
    try {
      // sessions.edit resolves the target from sessionKey or runId — send only
      // what we have (a null runId alone is rejected).
      await sendReq('sessions.edit', {
        ...(sessionKey ? { sessionKey } : {}),
        ...(runIdForControls ? { runId: runIdForControls } : {}),
        correctedText: corrected,
      });
    } catch (e) {
      Alert.alert('Edit failed', String(e?.message || e));
    } finally {
      setEditDraft('');
    }
  };

  if (!target) return null;

  const type = detectAgentType({ ...target, ...(subagent || {}), coderBackend: target.coderBackend || subagent?.coderBackend });
  const badge = agentBadge(type, colors);
  const sColor = statusColor(currentStatus, colors);
  const isActive = classifyStatus(currentStatus) === 'active';
  const elapsed = (subagent?.startedAt || subagent?.createdAt)
    ? Date.now() - new Date(subagent.startedAt || subagent.createdAt).getTime()
    : null;
  const progress = typeof subagent?.progress === 'number' ? subagent.progress : null;
  const respawnOfRunId = subagent?.respawnOfRunId || runDetail?.respawnOfRunId || null;
  const failureMessage =
    runDetail?.outcome?.error ||
    subagent?.outcome?.error ||
    (isFailed ? 'Run ended with errors' : null);

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="fullScreen"
      onRequestClose={onClose}
    >
      <View style={styles.modalRoot}>
        <KeyboardAvoidingView
          style={{ flex: 1 }}
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          keyboardVerticalOffset={0}
        >
          {/* Header */}
          <GlassSurface depth={2} radius={0} style={styles.modalHeader}>
            <View style={styles.modalHeaderRow}>
              <TouchableOpacity onPress={onClose} style={styles.modalCloseBtn} hitSlop={10}>
                <Ionicons name="chevron-down" size={22} color={colors.primary} />
              </TouchableOpacity>

              <View style={styles.modalHeaderContent}>
                <View style={styles.modalHeaderTopRow}>
                  <View style={[
                    styles.typeBadge,
                    { backgroundColor: withAlpha(badge.color, 0.14), borderColor: withAlpha(badge.color, 0.45) },
                  ]}>
                    <Ionicons name={badge.icon} size={10} color={badge.color} style={{ marginRight: 4 }} />
                    <Text style={[styles.typeBadgeText, { color: badge.color }]}>{badge.label}</Text>
                  </View>
                  <View style={[
                    styles.statusPill,
                    { backgroundColor: withAlpha(sColor, 0.14), borderColor: withAlpha(sColor, 0.45) },
                  ]}>
                    <View style={[styles.statusDot, { backgroundColor: sColor }]} />
                    <Text style={[styles.statusPillText, { color: sColor }]}>
                      {(currentStatus || 'idle').toUpperCase()}
                    </Text>
                  </View>
                </View>
                <Text style={styles.modalHeaderTitle} numberOfLines={1}>{target?.title || '—'}</Text>
                <Text style={styles.modalHeaderSub} numberOfLines={1}>
                  {isActive && elapsed ? <Ionicons name="time-outline" size={10} color={colors.textMuted} /> : null}{isActive && elapsed ? ` ${fmtDuration(elapsed)} · ` : ''}{sessionKey || '—'}
                </Text>
              </View>
            </View>

            {/* Identity detail chips — run id / host node / model */}
            {(subagent?.runId || runDetail?.runId || subagent?.nodeName || subagent?.nodeId || target?.model || subagent?.model) ? (
              <View style={styles.modalIdentityRow}>
                {(subagent?.runId || runDetail?.runId) ? (
                  <View style={[styles.modalIdentityChip, { borderColor: withAlpha(colors.primary, 0.22) }]}>
                    <Text style={[styles.modalIdentityLabel, { color: colors.textMuted }]}>RUN</Text>
                    <Text style={[styles.modalIdentityValue, { color: colors.text }]} numberOfLines={1}>
                      {String(subagent?.runId || runDetail?.runId).slice(0, 12)}
                    </Text>
                  </View>
                ) : null}
                {(subagent?.nodeName || subagent?.nodeId) ? (
                  <View style={[styles.modalIdentityChip, { borderColor: withAlpha(colors.primary, 0.22) }]}>
                    <Ionicons name="server-outline" size={9} color={colors.textMuted} />
                    <Text style={[styles.modalIdentityValue, { color: colors.text }]} numberOfLines={1}>
                      {subagent?.nodeName || subagent?.nodeId}
                    </Text>
                  </View>
                ) : null}
                {(target?.model || subagent?.model || runDetail?.model) ? (
                  <View style={[styles.modalIdentityChip, { borderColor: withAlpha(colors.primary, 0.22) }]}>
                    <Ionicons name="hardware-chip-outline" size={9} color={colors.textMuted} />
                    <Text style={[styles.modalIdentityValue, { color: colors.text }]} numberOfLines={1}>
                      {String(target?.model || subagent?.model || runDetail?.model)
                        .replace(/^anthropic\//i, '')
                        .slice(0, 24)}
                    </Text>
                  </View>
                ) : null}
              </View>
            ) : null}

            {/* Progress bar if subagent has progress */}
            {progress !== null ? (
              <View style={styles.modalProgressWrap}>
                <View style={styles.rowProgressTrack}>
                  <View style={[
                    styles.rowProgressFill,
                    { width: `${Math.max(2, Math.min(100, progress))}%`, backgroundColor: sColor },
                  ]} />
                </View>
                <Text style={[styles.rowProgressPct, { color: sColor }]}>{Math.round(progress)}%</Text>
              </View>
            ) : null}

            {/* Action row */}
            <View style={styles.modalActionRow}>
              <TouchableOpacity
                style={[styles.modalActionBtn, { borderColor: withAlpha(colors.primary, 0.4) }]}
                onPress={onOpenTerminal}
              >
                <Ionicons name="terminal" size={14} color={colors.primary} />
                <Text style={[styles.modalActionBtnText, { color: colors.primary }]}>Terminal</Text>
              </TouchableOpacity>

              {/* Open session in Chat view */}
              {sessionKey && navigation ? (
                <TouchableOpacity
                  style={[styles.modalActionBtn, { borderColor: withAlpha(colors.primary, 0.4) }]}
                  onPress={() => {
                    onClose?.();
                    try { navigation.navigate('MainTabs', { screen: 'Chat', params: { sessionKey } }, { pop: true }); } catch {}
                  }}
                >
                  <Ionicons name="chatbubbles-outline" size={14} color={colors.primary} />
                  <Text style={[styles.modalActionBtnText, { color: colors.primary }]}>Open session</Text>
                </TouchableOpacity>
              ) : null}
              {isActive ? (
                <TouchableOpacity
                  style={[styles.modalActionBtn, { borderColor: withAlpha(colors.error, 0.5) }, stopping && { opacity: 0.5 }]}
                  onPress={handleAbort}
                  disabled={stopping}
                >
                  {stopping ? (
                    <ActivityIndicator size="small" color={colors.error} />
                  ) : (
                    <Ionicons name="stop-circle-outline" size={14} color={colors.error} />
                  )}
                  <Text style={[styles.modalActionBtnText, { color: colors.error }]}>Abort</Text>
                </TouchableOpacity>
              ) : null}

              {/* Respawn — only surfaces on failed runs. Spawns a new run with
                  the original task + a preamble describing prior progress. */}
              {isFailed && respawnRunId ? (
                <TouchableOpacity
                  style={[
                    styles.modalActionBtn,
                    {
                      borderColor: withAlpha(colors.warning || colors.primary, 0.55),
                      backgroundColor: withAlpha(colors.warning || colors.primary, 0.12),
                    },
                    respawning && { opacity: 0.5 },
                  ]}
                  onPress={handleRespawn}
                  disabled={respawning}
                >
                  {respawning ? (
                    <ActivityIndicator size="small" color={colors.warning || colors.primary} />
                  ) : (
                    <Ionicons
                      name="refresh-circle-outline"
                      size={14}
                      color={colors.warning || colors.primary}
                    />
                  )}
                  <Text
                    style={[
                      styles.modalActionBtnText,
                      { color: colors.warning || colors.primary },
                    ]}
                  >
                    Respawn Agent
                  </Text>
                </TouchableOpacity>
              ) : null}
            </View>

            {/* Lineage chip — this run came from an earlier failed attempt. */}
            {respawnOfRunId ? (
              <View
                style={[
                  styles.modalRespawnChip,
                  {
                    borderColor: withAlpha(colors.warning || colors.primary, 0.45),
                    backgroundColor: withAlpha(colors.warning || colors.primary, 0.1),
                  },
                ]}
              >
                <Ionicons
                  name="git-branch-outline"
                  size={11}
                  color={colors.warning || colors.primary}
                />
                <Text
                  style={[
                    styles.modalRespawnChipText,
                    { color: colors.warning || colors.primary },
                  ]}
                  numberOfLines={1}
                >
                  Respawn of #{String(respawnOfRunId).slice(0, 8)}
                </Text>
              </View>
            ) : null}

            {/* Tab strip — Overview · Live · Tools · Output · History.
                Mirrors the web subagent-detail-modal so users carry the same
                navigation model between screens. Tabs that have no underlying
                data (e.g. no detail blob loaded) are still shown so the user
                isn't surprised by them appearing later. */}
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              style={styles.modalTabsScroll}
              contentContainerStyle={styles.modalTabsRow}
            >
              {[
                { id: 'overview', label: 'Overview' },
                { id: 'live',     label: 'Live Session' },
                { id: 'tools',    label: 'Tool Calls', badge: toolStream.length || null },
                { id: 'output',   label: 'Output' },
                { id: 'history',  label: 'History' },
              ].map((tab) => {
                const isActiveTab = activeTab === tab.id;
                const tabColor = isActiveTab ? colors.primary : colors.textMuted;
                return (
                  <TouchableOpacity
                    key={tab.id}
                    activeOpacity={0.75}
                    onPress={() => setActiveTab(tab.id)}
                    style={[
                      styles.modalTab,
                      isActiveTab && {
                        borderColor: withAlpha(colors.primary, 0.6),
                        backgroundColor: withAlpha(colors.primary, 0.14),
                      },
                    ]}
                  >
                    <Text style={[styles.modalTabText, { color: tabColor }]}>{tab.label}</Text>
                    {tab.id === 'live' && paused ? (
                      <View style={[styles.modalTabBadge, { backgroundColor: withAlpha(colors.warning, 0.2), borderColor: withAlpha(colors.warning, 0.6) }]}>
                        <Text style={[styles.modalTabBadgeText, { color: colors.warning }]}>PAUSED</Text>
                      </View>
                    ) : null}
                    {tab.id === 'live' && isActive && !paused ? (
                      <View style={[styles.modalTabLiveDot, { backgroundColor: colors.success }]} />
                    ) : null}
                    {tab.badge ? (
                      <View style={[styles.modalTabBadge, { backgroundColor: withAlpha(tabColor, 0.18), borderColor: withAlpha(tabColor, 0.5) }]}>
                        <Text style={[styles.modalTabBadgeText, { color: tabColor }]}>{tab.badge}</Text>
                      </View>
                    ) : null}
                  </TouchableOpacity>
                );
              })}
            </ScrollView>

            {/* Host device hardware mini-stream */}
            {hostHw ? (
              <View style={styles.modalHwSection}>
                <Ionicons name="hardware-chip-outline" size={11} color={colors.textMuted} />
                <Text style={[styles.modalHwHostLabel, { color: colors.textMuted }]} numberOfLines={1}>
                  {subagent?.nodeName || subagent?.nodeId || 'LOCAL'}
                </Text>
                <View style={styles.modalHwBars}>
                  <MiniHwBar label="CPU" value={hwCpuPct(hostHw)} color={colors.primary} />
                  <MiniHwBar label="MEM" value={hwMemPct(hostHw)} color={colors.success} />
                  <MiniHwBar label="GPU" value={hwGpuPct(hostHw)} color={colors.info || '#3b82f6'} />
                </View>
                {hwCpuModel(hostHw) ? (
                  <Text style={[styles.modalHwSpecsText, { color: colors.textMuted }]} numberOfLines={1}>
                    {hwCpuModel(hostHw)?.slice(0, 28)}
                    {hwRamGB(hostHw) ? ` · ${hwRamGB(hostHw)}` : ''}
                  </Text>
                ) : null}
              </View>
            ) : null}
          </GlassSurface>

          {/* Tab body — switches between Overview / Live / Tools / Output / History.
              Activity feed + transcript live under "Live"; Overview pulls from
              the subagents.detail envelope (project/tasks/contentPages/files). */}
          <ScrollView
            ref={scrollRef}
            style={{ flex: 1 }}
            contentContainerStyle={{ padding: SPACING.md, paddingBottom: SPACING.xl }}
            onScroll={(e) => {
              if (activeTab !== 'live') return;
              const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
              const distFromBottom = contentSize.height - contentOffset.y - layoutMeasurement.height;
              const atBottom = distFromBottom < 80;
              stickToBottomRef.current = atBottom;
              if (atBottom && showJumpToLive) setShowJumpToLive(false);
              if (!atBottom && !showJumpToLive) setShowJumpToLive(true);
            }}
            scrollEventThrottle={120}
            refreshControl={
              <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />
            }
          >
            {/* ── Overview tab ───────────────────────────────────────── */}
            {activeTab === 'overview' ? (
              <OverviewTab
                detail={detail}
                runDetail={runDetail}
                subagent={subagent}
                target={target}
                sessionKey={sessionKey}
                navigation={navigation}
                onClose={onClose}
                colors={colors}
                styles={styles}
              />
            ) : null}

            {/* ── Tool Calls tab ─────────────────────────────────────── */}
            {activeTab === 'tools' ? (
              <ToolCallsTab toolStream={toolStream} colors={colors} styles={styles} />
            ) : null}

            {/* ── Output tab ─────────────────────────────────────────── */}
            {activeTab === 'output' ? (
              <OutputTab toolStream={toolStream} colors={colors} styles={styles} />
            ) : null}

            {/* ── History tab ────────────────────────────────────────── */}
            {activeTab === 'history' ? (
              <HistoryTab activity={activity} colors={colors} styles={styles} />
            ) : null}

            {/* ── Live tab (default — keeps existing failure banner +
                activity feed + transcript) ───────────────────────────── */}
            {activeTab === 'live' ? (
            <>
            {/* Failure banner — surfaces the prior error message above the
                activity feed so the user can read it before deciding to respawn. */}
            {isFailed && failureMessage ? (
              <GlassSurface
                depth={2}
                radius={14}
                style={{
                  marginBottom: SPACING.md,
                  borderColor: withAlpha(colors.error, 0.45),
                  borderWidth: StyleSheet.hairlineWidth,
                }}
              >
                <View style={styles.failureBanner}>
                  <Ionicons name="alert-circle-outline" size={16} color={colors.error} />
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.failureBannerLabel, { color: colors.error }]}>
                      FAILED
                    </Text>
                    <Text style={styles.failureBannerText}>
                      {String(failureMessage).slice(0, 600)}
                    </Text>
                  </View>
                </View>
              </GlassSurface>
            ) : null}

            {/* Activity feed — chronological progress updates / checkpoints
                emitted by the run. This is the "prior work" the respawn's
                preamble is built from, surfaced verbatim so the user can
                verify what was done before retrying. */}
            {progressUpdates.length > 0 ? (
              <GlassSurface depth={2} radius={14} style={{ marginBottom: SPACING.md }}>
                <View style={styles.activityFeedInner}>
                  <View style={styles.activityFeedHeader}>
                    <Ionicons name="pulse-outline" size={13} color={colors.primary} />
                    <Text style={[styles.activityFeedTitle, { color: colors.primary }]}>
                      ACTIVITY FEED
                    </Text>
                    <Text style={[styles.activityFeedCount, { color: colors.textMuted }]}>
                      {progressUpdates.length} update{progressUpdates.length === 1 ? '' : 's'}
                    </Text>
                  </View>
                  {progressUpdates.map((u, idx) => {
                    const upStatus = String(u.status || '').toLowerCase();
                    const upColor =
                      upStatus === 'blocked' || upStatus === 'error'
                        ? colors.error
                        : upStatus === 'finishing' || upStatus === 'checkpoint'
                          ? colors.success
                          : colors.primary;
                    return (
                      <View
                        key={`pu-${idx}-${u.timestamp || idx}`}
                        style={[
                          styles.activityFeedRow,
                          idx === progressUpdates.length - 1 && styles.itemNoBorder,
                        ]}
                      >
                        <View
                          style={[
                            styles.activityFeedDot,
                            { backgroundColor: upColor },
                          ]}
                        />
                        <View style={{ flex: 1 }}>
                          <View style={styles.activityFeedTopRow}>
                            <Text
                              style={[
                                styles.activityFeedStatus,
                                { color: upColor },
                              ]}
                            >
                              {(u.status || 'update').toUpperCase()}
                            </Text>
                            {typeof u.progress === 'number' ? (
                              <Text
                                style={[
                                  styles.activityFeedPct,
                                  { color: upColor },
                                ]}
                              >
                                {Math.round(u.progress)}%
                              </Text>
                            ) : null}
                            {u.checkpoint ? (
                              <Text
                                style={[
                                  styles.activityFeedCheckpoint,
                                  {
                                    color: upColor,
                                    borderColor: withAlpha(upColor, 0.45),
                                    backgroundColor: withAlpha(upColor, 0.12),
                                  },
                                ]}
                                numberOfLines={1}
                              >
                                {u.checkpoint}
                              </Text>
                            ) : null}
                            <View style={{ flex: 1 }} />
                            <Text style={styles.activityFeedTime}>
                              {formatTime(u.timestamp)}
                            </Text>
                          </View>
                          <Text style={styles.activityFeedMessage}>{u.message}</Text>
                        </View>
                      </View>
                    );
                  })}
                </View>
              </GlassSurface>
            ) : null}

            <GlassSurface depth={2} radius={14} style={{ marginBottom: SPACING.md }}>
              <View style={styles.logInner}>
                {loading ? (
                  <View style={styles.loadingContainer}>
                    <ActivityIndicator size="large" color={colors.primary} />
                    <Text style={styles.loadingText}>Loading transcript…</Text>
                  </View>
                ) : activity.length === 0 ? (
                  <View style={styles.emptyContainer}>
                    <Ionicons name="time-outline" size={36} color={colors.textMuted} />
                    <Text style={styles.emptyText}>No activity yet</Text>
                    <Text style={styles.emptyHint}>Live messages appear here as the session runs</Text>
                  </View>
                ) : (
                  activity.map((item, idx) => (
                    <FocusTranscriptItem
                      key={`${item.timestamp}-${idx}`}
                      item={item}
                      colors={colors}
                      styles={styles}
                      isLast={idx === activity.length - 1}
                    />
                  ))
                )}

                {/* Thinking pulse — shown while the run is still active and
                    we already have at least one transcript item to anchor it. */}
                {isActive && activity.length > 0 ? (
                  <View style={styles.thinkingRow}>
                    <View style={[styles.thinkingDot, { backgroundColor: colors.primary }]} />
                    <Text style={[styles.thinkingText, { color: colors.textMuted }]}>thinking…</Text>
                  </View>
                ) : null}
              </View>
            </GlassSurface>
            </>
            ) : null}
          </ScrollView>

          {/* Jump-to-live affordance — appears when the user scrolls away
              from the bottom on the Live tab. */}
          {activeTab === 'live' && showJumpToLive ? (
            <TouchableOpacity
              style={[styles.jumpToLive, { borderColor: withAlpha(colors.primary, 0.5), backgroundColor: withAlpha(colors.primary, 0.18) }]}
              onPress={() => {
                stickToBottomRef.current = true;
                setShowJumpToLive(false);
                setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 50);
              }}
            >
              <Ionicons name="arrow-down" size={12} color={colors.primary} />
              <Text style={[styles.jumpToLiveText, { color: colors.primary }]}>Jump to live</Text>
            </TouchableOpacity>
          ) : null}

          {/* Edit-last-assistant area (web parity: textarea + Save / Cancel). */}
          {activeTab === 'live' && editing ? (
            <GlassSurface depth={2} radius={0} style={styles.editArea}>
              <Text style={[styles.editAreaLabel, { color: colors.warning || colors.primary }]}>
                EDITING LAST ASSISTANT RESPONSE
              </Text>
              <TextInput
                style={[styles.input, { maxHeight: 140 }]}
                value={editDraft}
                onChangeText={setEditDraft}
                multiline
                placeholder="Type the correction the agent should adopt…"
                placeholderTextColor={colors.textMuted}
              />
              <View style={styles.editAreaActions}>
                <TouchableOpacity
                  style={[styles.modalActionBtn, { borderColor: withAlpha(colors.primary, 0.45), backgroundColor: withAlpha(colors.primary, 0.14) }]}
                  onPress={handleEditSave}
                  disabled={!editDraft.trim()}
                >
                  <Ionicons name="checkmark" size={14} color={colors.primary} />
                  <Text style={[styles.modalActionBtnText, { color: colors.primary }]}>Save correction</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.modalActionBtn, { borderColor: withAlpha(colors.textMuted, 0.4) }]}
                  onPress={() => { setEditing(false); setEditDraft(''); }}
                >
                  <Text style={[styles.modalActionBtnText, { color: colors.textMuted }]}>Cancel</Text>
                </TouchableOpacity>
              </View>
            </GlassSurface>
          ) : null}

          {/* Session controls — Pause / Resume / Compact / Edit. Mirrors the
              web modal's "sadm-controls" strip; capability-gated so backends
              that don't support these RPCs don't surface dead buttons. */}
          {activeTab === 'live' ? (
            <View style={styles.modalControlsRow}>
              {capabilities.pause && (isActive || paused) ? (
                <TouchableOpacity
                  style={[styles.modalCtrlBtn, { borderColor: withAlpha(colors.warning, 0.45) }, pauseBusy && { opacity: 0.5 }]}
                  onPress={handlePauseToggle}
                  disabled={pauseBusy}
                >
                  {pauseBusy ? (
                    <ActivityIndicator size="small" color={colors.warning} />
                  ) : (
                    <Ionicons name={paused ? 'play-outline' : 'pause-outline'} size={14} color={colors.warning} />
                  )}
                  <Text style={[styles.modalCtrlBtnText, { color: colors.warning }]}>
                    {paused ? 'Resume' : 'Pause'}
                  </Text>
                </TouchableOpacity>
              ) : null}
              <TouchableOpacity
                style={[styles.modalCtrlBtn, { borderColor: withAlpha(colors.textMuted, 0.4) }, compactBusy && { opacity: 0.5 }]}
                onPress={handleCompact}
                disabled={compactBusy}
              >
                {compactBusy ? (
                  <ActivityIndicator size="small" color={colors.textMuted} />
                ) : (
                  <Ionicons name="contract-outline" size={14} color={colors.textMuted} />
                )}
                <Text style={[styles.modalCtrlBtnText, { color: colors.textMuted }]}>Compact</Text>
              </TouchableOpacity>
              {capabilities.edit ? (
                <TouchableOpacity
                  style={[styles.modalCtrlBtn, { borderColor: withAlpha(colors.primary, 0.4) }, editing && { backgroundColor: withAlpha(colors.primary, 0.14) }]}
                  onPress={handleEditToggle}
                >
                  <Ionicons name="create-outline" size={14} color={colors.primary} />
                  <Text style={[styles.modalCtrlBtnText, { color: colors.primary }]}>Edit</Text>
                </TouchableOpacity>
              ) : null}
            </View>
          ) : null}

          {/* Input bar */}
          <GlassSurface depth={2} radius={0} style={styles.inputContainer}>
            <View style={styles.inputAccent}>
              <LinearGradient
                colors={['rgba(0,0,0,0)', withAlpha(colors.primary, 0.55), 'rgba(0,0,0,0)']}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 0 }}
                style={StyleSheet.absoluteFill}
              />
            </View>
            {capabilities.send === false ? (
              <View style={styles.composerDisabled}>
                <Ionicons name="lock-closed-outline" size={14} color={colors.textMuted} />
                <Text style={[styles.composerDisabledText, { color: colors.textMuted }]} numberOfLines={2}>
                  {target?.coderBackend === 'opencode' || target?.coderBackend === 'codex' || target?.coderBackend === 'grok'
                    ? `${target.coderBackend} does not support live message injection.`
                    : 'Message injection not available for this agent.'}
                </Text>
              </View>
            ) : (
              <View style={styles.inputWrapper}>
                <TextInput
                  style={styles.input}
                  placeholder={
                    activeTab === 'live'
                      ? 'Send message to session…'
                      : 'Switch to Live tab to send messages'
                  }
                  placeholderTextColor={colors.textMuted}
                  value={message}
                  onChangeText={setMessage}
                  multiline
                  editable={activeTab === 'live'}
                  maxLength={1000}
                />
                <TouchableOpacity
                  style={[styles.sendBtn, { backgroundColor: colors.primary }, (!message.trim() || sending || activeTab !== 'live') && styles.sendBtnDisabled]}
                  onPress={handleSend}
                  disabled={!message.trim() || sending || activeTab !== 'live'}
                >
                  {sending ? (
                    <ActivityIndicator size="small" color={colors.background} />
                  ) : (
                    <Ionicons name="send" size={18} color={colors.background} />
                  )}
                </TouchableOpacity>
              </View>
            )}
          </GlassSurface>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
}

// ─── Filter chip row ────────────────────────────────────────────────
//
// Sticky horizontal, single-select filter that mirrors the desktop activity
// page's ACTIVE / SUBS / CODER toggles + NATIVE/SUB/CODER/EXTERNAL type
// counters. Each chip carries a live count so the row doubles as the
// session-type breakdown the web header shows.
function FilterChips({ value, onChange, counts, colors, styles }) {
  const OPTS = [
    { key: 'all',      label: 'ALL',      color: colors.primary },
    { key: 'active',   label: 'ACTIVE',   color: colors.success },
    { key: 'native',   label: 'NATIVE',   color: colors.primary },
    { key: 'subagent', label: 'SUBS',     color: colors.purple || '#a78bfa' },
    { key: 'coder',    label: 'CODER',    color: colors.cyan || colors.info || '#60a5fa' },
    { key: 'external', label: 'EXTERNAL', color: colors.textMuted },
  ];
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={styles.filterBar}
      contentContainerStyle={styles.filterBarContent}
    >
      {OPTS.map((opt) => {
        const selected = value === opt.key;
        const count = counts?.[opt.key] ?? 0;
        return (
          <TouchableOpacity
            key={opt.key}
            activeOpacity={0.75}
            onPress={() => onChange(opt.key)}
            style={[
              styles.filterChip,
              {
                borderColor: selected ? opt.color : withAlpha(colors.textMuted, 0.3),
                backgroundColor: selected ? withAlpha(opt.color, 0.16) : 'transparent',
              },
            ]}
          >
            <Text style={[styles.filterChipText, { color: selected ? opt.color : colors.textMuted }]}>
              {opt.label}
            </Text>
            <View style={[styles.filterChipCount, { backgroundColor: withAlpha(selected ? opt.color : colors.textMuted, 0.18) }]}>
              <Text style={[styles.filterChipCountText, { color: selected ? opt.color : colors.textMuted }]}>
                {count}
              </Text>
            </View>
          </TouchableOpacity>
        );
      })}
    </ScrollView>
  );
}

// ─── Main Screen — dashboard + focus modal ──────────────────────────

export default function TaskActivityScreen({ route, navigation, gateway }) {
  const { task: routeTask, session: routeSession } = route.params || {};
  const { status: connStatus, sendReq } = gateway || {};
  const connected = connStatus === 'connected';

  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);

  // ── Dashboard state ──
  const [subagents, setSubagents] = useState([]);     // raw subagent rows
  const [sessions, setSessions]   = useState([]);     // raw session rows
  const [autonomyStatus, setAutonomyStatus] = useState(null);
  const [dashLoading, setDashLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [errors, setErrors] = useState({ subagents: null, sessions: null, autonomy: null });
  const pollRef = useRef(null);

  // ── Focus modal state ──
  const [focus, setFocus] = useState(null); // { sessionKey, title, status, coderBackend, subagent? } | null

  // ── Top filter (mirrors desktop ACTIVE/SUBS/CODER toggles + type counters) ──
  const [typeFilter, setTypeFilter] = useState('all');

  const openFocus = useCallback((target) => {
    if (!target) return;
    setFocus(target);
  }, []);
  const closeFocus = useCallback(() => setFocus(null), []);

  // Auto-open focus when arriving with task/session params (backwards compat
  // with AutonomyScreen → TaskActivity (within AutonomyStack).
  useEffect(() => {
    if (routeSession) {
      const r = rowFromSession(routeSession);
      setFocus({
        sessionKey: r.sessionKey,
        title: r.title,
        status: r.status,
        coderBackend: r.coderBackend,
      });
    } else if (routeTask) {
      setFocus({
        sessionKey: routeTask.sessionKey || routeTask.id || null,
        title: routeTask.title || 'Task',
        status: routeTask.status || 'running',
        coderBackend: routeTask.coderBackend,
      });
    }
  }, [routeTask, routeSession]);

  const loadDashboard = useCallback(async () => {
    if (!connected || !sendReq) return;
    const next = { subagents: null, sessions: null, autonomy: null };

    const [subRes, sesRes, autRes] = await Promise.allSettled([
      sendReq('subagents.list', { includeCompleted: true, limit: 100 }),
      sendReq('sessions.list',  { activeMinutes: 1440, limit: 50, includeLastMessage: true, includeDerivedTitles: true }),
      sendReq('autonomy:status', {}),
    ]);

    if (subRes.status === 'fulfilled' && subRes.value?.subagents) {
      setSubagents(subRes.value.subagents);
    } else if (subRes.status === 'rejected') {
      next.subagents = String(subRes.reason?.message || subRes.reason || 'subagents.list failed');
    }

    if (sesRes.status === 'fulfilled' && sesRes.value?.sessions) {
      setSessions(sesRes.value.sessions);
    } else if (sesRes.status === 'rejected') {
      next.sessions = String(sesRes.reason?.message || sesRes.reason || 'sessions.list failed');
    }

    if (autRes.status === 'fulfilled' && autRes.value) {
      setAutonomyStatus(autRes.value);
    } else if (autRes.status === 'rejected') {
      next.autonomy = String(autRes.reason?.message || autRes.reason || 'autonomy:status failed');
    }

    setErrors(next);
    setDashLoading(false);
    setRefreshing(false);
  }, [connected, sendReq]);

  useEffect(() => {
    loadDashboard();
    pollRef.current = setInterval(loadDashboard, 5000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [loadDashboard]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    loadDashboard();
  }, [loadDashboard]);

  // ── Compose Active Now / Recently Completed lists ──
  // Active: subagents in active states + sessions touched within 2 minutes.
  // Completed: subagents in done/error states with endedAt in last 24h, plus
  // sessions older than 2 min (capped) for context.
  const { activeRows, completedRows, filterCounts } = useMemo(() => {
    const DAY_MS = 24 * 60 * 60 * 1000;
    const RECENT_SESSION_WINDOW = 120 * 1000;

    const seenSessionKeys = new Set();
    const activeList = [];
    const completedList = [];

    for (const sa of subagents) {
      const r = rowFromSubagent(sa);
      const cls = classifyStatus(r.status);
      if (r.sessionKey) seenSessionKeys.add(r.sessionKey);
      if (cls === 'active') {
        activeList.push(r);
      } else {
        const ended = r.endedAt || r.lastUpdateAt;
        if (ended && Date.now() - new Date(ended).getTime() < DAY_MS) {
          completedList.push(r);
        }
      }
    }

    for (const s of sessions) {
      const r = rowFromSession(s);
      if (!r.sessionKey || seenSessionKeys.has(r.sessionKey)) continue;
      const ts = r.lastUpdateAt;
      const ageMs = ts ? Date.now() - new Date(ts).getTime() : Infinity;
      if (ageMs < RECENT_SESSION_WINDOW) {
        r.status = 'running';
        activeList.push(r);
      } else if (ageMs < DAY_MS) {
        r.status = 'idle';
        completedList.push(r);
      }
    }

    activeList.sort((a, b) => (b.lastUpdateAt || 0) - (a.lastUpdateAt || 0));
    completedList.sort((a, b) => (b.lastUpdateAt || 0) - (a.lastUpdateAt || 0));

    const capped = completedList.slice(0, 30);

    // Per-filter counts across the visible union, so the chip row doubles as
    // the desktop's NATIVE/SUB/CODER/EXTERNAL type breakdown.
    const union = [...activeList, ...capped];
    const counts = {
      all: union.length,
      active: activeList.length,
      native: 0, subagent: 0, coder: 0, external: 0,
    };
    for (const r of union) counts[sessionClass(r)] += 1;

    return { activeRows: activeList, completedRows: capped, filterCounts: counts };
  }, [subagents, sessions]);

  // Apply the active type/status filter to a row list.
  const applyFilter = useCallback((rows) => {
    if (typeFilter === 'all') return rows;
    if (typeFilter === 'active') return rows.filter(r => classifyStatus(r.status) === 'active');
    return rows.filter(r => sessionClass(r) === typeFilter);
  }, [typeFilter]);

  const visibleActive = useMemo(() => applyFilter(activeRows), [applyFilter, activeRows]);
  const visibleCompleted = useMemo(() => applyFilter(completedRows), [applyFilter, completedRows]);

  const renderActiveSection = () => {
    if (dashLoading) {
      return (
        <GlassSurface depth={2} radius={14}>
          <View style={styles.loadingContainer}>
            <ActivityIndicator size="small" color={colors.primary} />
            <Text style={styles.loadingText}>Loading active agents…</Text>
          </View>
        </GlassSurface>
      );
    }
    if (errors.subagents && errors.sessions) {
      return (
        <GlassSurface depth={2} radius={14}>
          <View style={styles.emptyContainer}>
            <Ionicons name="warning-outline" size={28} color={colors.error} />
            <Text style={[styles.emptyText, { color: colors.error }]}>Couldn’t load active agents</Text>
            <Text style={styles.emptyHint}>{errors.subagents}</Text>
          </View>
        </GlassSurface>
      );
    }
    if (visibleActive.length === 0) {
      const filtered = typeFilter !== 'all';
      return (
        <GlassSurface depth={2} radius={14}>
          <View style={styles.emptyContainer}>
            <Ionicons name="moon-outline" size={28} color={colors.textMuted} />
            <Text style={styles.emptyText}>{filtered ? 'No matching agents' : 'No agents running'}</Text>
            <Text style={styles.emptyHint}>
              {filtered
                ? 'No active agents match this filter — try ALL.'
                : 'Spawned subagents and live sessions will show up here.'}
            </Text>
          </View>
        </GlassSurface>
      );
    }
    return (
      <GlassSurface depth={2} radius={14}>
        <View style={styles.rowListInner}>
          {visibleActive.map(row => (
            <ActivityRow
              key={row.key}
              row={row}
              colors={colors}
              styles={styles}
              onPress={() => openFocus({
                sessionKey: row.sessionKey,
                title: row.title,
                status: row.status,
                coderBackend: row.coderBackend,
                subagent: row.source === 'subagent' ? row.raw : null,
              })}
            />
          ))}
        </View>
      </GlassSurface>
    );
  };

  const renderCompletedSection = () => {
    if (dashLoading) return null;
    if (errors.subagents && errors.sessions) return null;
    if (visibleCompleted.length === 0) {
      const filtered = typeFilter !== 'all';
      return (
        <GlassSurface depth={2} radius={14}>
          <View style={styles.emptyContainer}>
            <Ionicons name="checkmark-done-outline" size={28} color={colors.textMuted} />
            <Text style={styles.emptyText}>{filtered ? 'No matching runs' : 'Nothing finished recently'}</Text>
            <Text style={styles.emptyHint}>
              {filtered
                ? 'No completed runs match this filter.'
                : 'Completed runs from the last 24h land here.'}
            </Text>
          </View>
        </GlassSurface>
      );
    }
    return (
      <GlassSurface depth={2} radius={14}>
        <View style={styles.rowListInner}>
          {visibleCompleted.map(row => (
            <ActivityRow
              key={row.key}
              row={row}
              colors={colors}
              styles={styles}
              muted
              onPress={() => openFocus({
                sessionKey: row.sessionKey,
                title: row.title,
                status: row.status,
                coderBackend: row.coderBackend,
                subagent: row.source === 'subagent' ? row.raw : null,
              })}
            />
          ))}
        </View>
      </GlassSurface>
    );
  };

  const renderAutonomySection = () => {
    if (dashLoading) {
      return (
        <GlassSurface depth={2} radius={14}>
          <View style={styles.loadingContainer}>
            <ActivityIndicator size="small" color={colors.primary} />
            <Text style={styles.loadingText}>Loading autonomy…</Text>
          </View>
        </GlassSurface>
      );
    }
    if (errors.autonomy) {
      return (
        <GlassSurface depth={2} radius={14}>
          <View style={styles.emptyContainer}>
            <Ionicons name="warning-outline" size={28} color={colors.warning} />
            <Text style={[styles.emptyText, { color: colors.warning }]}>Autonomy status unavailable</Text>
            <Text style={styles.emptyHint}>{errors.autonomy}</Text>
          </View>
        </GlassSurface>
      );
    }
    if (!autonomyStatus) {
      return (
        <GlassSurface depth={2} radius={14}>
          <View style={styles.emptyContainer}>
            <Text style={styles.emptyText}>No autonomy data</Text>
          </View>
        </GlassSurface>
      );
    }
    return <AutonomyStrip status={autonomyStatus} colors={colors} styles={styles} />;
  };

  return (
    <View style={styles.container}>
      {/* Premium sticky header — reflective gradient + shimmer */}
      <PremiumHeader
        eyebrow="AGENT ACTIVITY"
        title={activeRows.length > 0 ? String(activeRows.length) : '0'}
        subtitle={
          activeRows.length > 0
            ? `${activeRows.length} running · ${completedRows.length} recent`
            : 'No activity right now'
        }
        statusPill={
          !connected
            ? { label: 'OFFLINE', color: colors.warning }
            : activeRows.length > 0
              ? { label: 'LIVE', color: colors.success }
              : { label: 'IDLE', color: colors.textMuted }
        }
        leftIcon="chevron-back"
        onLeftPress={() => navigation?.goBack?.()}
        rightActions={[
          {
            icon: 'refresh',
            onPress: onRefresh,
            busy: refreshing,
            color: refreshing ? colors.textMuted : colors.primary,
          },
        ]}
      />

      {/* Sticky filter chip row — desktop parity (type + status) */}
      <FilterChips
        value={typeFilter}
        onChange={setTypeFilter}
        counts={filterCounts}
        colors={colors}
        styles={styles}
      />

      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.scrollContent}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />
        }
      >
        <Section
          icon="radio-button-on"
          title="ACTIVE NOW"
          count={visibleActive.length}
          accent={colors.success}
          colors={colors}
          styles={styles}
        >
          {renderActiveSection()}
        </Section>

        {typeFilter !== 'active' && (
          <Section
            icon="checkmark-circle-outline"
            title="RECENTLY COMPLETED"
            count={visibleCompleted.length}
            accent={colors.info || colors.cyan || colors.primary}
            colors={colors}
            styles={styles}
          >
            {renderCompletedSection()}
          </Section>
        )}

        <Section
          icon="cog-outline"
          title="AUTONOMY STATUS"
          accent={colors.primary}
          colors={colors}
          styles={styles}
        >
          {renderAutonomySection()}
        </Section>

        <View style={{ height: 32 }} />
      </ScrollView>

      <FocusModal
        visible={!!focus}
        target={focus}
        onClose={closeFocus}
        onOpenTerminal={() => {
          closeFocus();
          try { navigation?.getParent?.()?.navigate?.('TerminalsModal'); }
          catch { try { navigation?.navigate?.('TerminalsModal'); } catch {} }
        }}
        navigation={navigation}
        gateway={gateway}
        colors={colors}
        styles={styles}
      />
    </View>
  );
}

// ─── Styles ─────────────────────────────────────────────────────────

function makeStyles(colors) {
  const divider = withAlpha(colors.text || '#fff', 0.06);

  return StyleSheet.create({
    container: { flex: 1, backgroundColor: 'transparent' },

    scrollView: { flex: 1 },
    scrollContent: { padding: SPACING.md, paddingBottom: SPACING.xl },

    // Sticky filter chip row
    filterBar: {
      flexGrow: 0,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: withAlpha(colors.text || '#fff', 0.06),
    },
    filterBarContent: {
      paddingHorizontal: SPACING.md,
      paddingVertical: 8,
      gap: 8,
      alignItems: 'center',
    },
    filterChip: {
      flexDirection: 'row', alignItems: 'center', gap: 6,
      paddingHorizontal: 12, paddingVertical: 6,
      borderRadius: 999, borderWidth: 1,
    },
    filterChipText: { fontSize: 11, fontWeight: '700', letterSpacing: 0.6 },
    filterChipCount: {
      minWidth: 18, paddingHorizontal: 5, paddingVertical: 1,
      borderRadius: 9, alignItems: 'center',
    },
    filterChipCountText: { fontSize: 10, fontWeight: '700' },

    // Section
    sectionWrap: { marginBottom: SPACING.lg },
    sectionHeader: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
      paddingVertical: 8, paddingHorizontal: 4, marginBottom: 6,
    },
    sectionHeaderLeft: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm },
    sectionEyebrowDot: { width: 6, height: 6, borderRadius: 3 },
    sectionEyebrow: { fontSize: 10, fontWeight: '700', letterSpacing: 1.5 },
    sectionCount: {
      paddingHorizontal: 8, paddingVertical: 2,
      borderRadius: 10, borderWidth: StyleSheet.hairlineWidth,
    },
    sectionCountText: { fontSize: 10, fontWeight: '700' },

    // Row list
    rowListInner: { paddingVertical: 2 },
    row: {
      flexDirection: 'row', alignItems: 'stretch',
      paddingVertical: 12, paddingRight: SPACING.md,
      borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: divider,
      gap: SPACING.md,
    },
    rowAccent: { width: 3, borderRadius: 2, marginLeft: SPACING.md, marginRight: 2 },
    rowBody: { flex: 1, gap: 4 },
    rowTopLine: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 2 },
    rowTitle: { fontSize: 13, fontWeight: '700', color: colors.text },
    rowSubtitle: { fontSize: 11, color: colors.textSecondary, lineHeight: 16 },
    rowProgressWrap: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 6 },
    rowProgressTrack: { flex: 1, height: 4, backgroundColor: divider, borderRadius: 2, overflow: 'hidden' },
    rowProgressFill: { height: 4, borderRadius: 2 },
    rowProgressPct: { fontSize: 10, fontWeight: '700', minWidth: 32, textAlign: 'right' },
    rowMeta: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 4 },
    rowMetaText: { fontSize: 10, color: colors.textMuted, opacity: 0.85 },

    // Agent-type badge
    typeBadge: {
      flexDirection: 'row', alignItems: 'center',
      paddingHorizontal: 7, paddingVertical: 3,
      borderWidth: 1, borderRadius: 999,
    },
    typeBadgeText: { fontSize: 9, fontWeight: '700', letterSpacing: 0.6 },

    // Status pill
    statusPill: {
      flexDirection: 'row', alignItems: 'center',
      paddingHorizontal: 8, paddingVertical: 3,
      borderWidth: 1, borderRadius: 999, gap: 5,
    },
    statusDot: { width: 6, height: 6, borderRadius: 3 },
    statusPillText: { fontSize: 9, fontWeight: '700', letterSpacing: 0.5 },

    // Node (federation) chip
    nodeChip: {
      paddingHorizontal: 6, paddingVertical: 2,
      borderRadius: 6, borderWidth: StyleSheet.hairlineWidth,
      maxWidth: 110,
    },
    nodeChipText: { fontSize: 9, fontWeight: '600', letterSpacing: 0.3 },

    // Per-row "Respawn #abc123" chip — surfaces lineage at a glance.
    respawnRowChip: {
      flexDirection: 'row', alignItems: 'center',
      paddingHorizontal: 6, paddingVertical: 2,
      borderRadius: 6, borderWidth: StyleSheet.hairlineWidth,
      maxWidth: 130,
    },
    respawnRowChipText: {
      fontSize: 9, fontWeight: '700', letterSpacing: 0.3,
      fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    },

    // Autonomy strip
    autonomyCard: {},
    autonomyCardInner: { padding: SPACING.md, gap: 10 },
    autonomyRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
    autonomyPill: {
      paddingHorizontal: 10, paddingVertical: 6,
      borderRadius: 10, borderWidth: 1, minWidth: 80,
    },
    autonomyPillLabel: { fontSize: 8, fontWeight: '700', letterSpacing: 0.8, marginBottom: 2 },
    autonomyPillValue: { fontSize: 12, fontWeight: '700' },
    autonomyRunningText: {
      fontSize: 11, fontWeight: '600', color: colors.primary,
      paddingTop: 8,
      borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: divider,
    },

    // Loading / empty
    loadingContainer: { padding: 32, alignItems: 'center' },
    loadingText: { marginTop: SPACING.sm, color: colors.textMuted, fontSize: 12 },
    emptyContainer: { padding: 28, alignItems: 'center' },
    emptyText: { marginTop: SPACING.sm, color: colors.textSecondary, fontSize: 13, fontWeight: '600' },
    emptyHint: { marginTop: 4, color: colors.textMuted, fontSize: 11, textAlign: 'center', opacity: 0.85 },

    // ── Focus Modal ──
    modalRoot: { flex: 1, backgroundColor: colors.background },
    modalHeader: { paddingTop: Platform.OS === 'ios' ? 52 : 24, paddingBottom: 10 },
    modalHeaderRow: {
      flexDirection: 'row', alignItems: 'flex-start',
      paddingHorizontal: SPACING.md, paddingVertical: SPACING.sm, gap: SPACING.sm,
    },
    modalCloseBtn: { padding: 4, marginTop: 2 },
    modalHeaderContent: { flex: 1, gap: 6 },
    modalHeaderTopRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    modalHeaderTitle: { fontSize: 16, fontWeight: '700', color: colors.text },
    modalHeaderSub: { fontSize: 10, color: colors.textMuted, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },
    modalProgressWrap: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: SPACING.md, marginBottom: 6 },

    modalActionRow: {
      flexDirection: 'row', gap: 8,
      paddingHorizontal: SPACING.md, paddingTop: 6,
    },
    modalActionBtn: {
      flexDirection: 'row', alignItems: 'center', gap: 6,
      paddingHorizontal: 10, paddingVertical: 6,
      borderWidth: 1, borderRadius: 999,
    },
    modalActionBtnText: { fontSize: 11, fontWeight: '700', letterSpacing: 0.5 },

    // Identity detail chips (run id / host node / model)
    modalIdentityRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 5,
      paddingHorizontal: SPACING.md,
      paddingTop: 6,
      paddingBottom: 2,
    },
    modalIdentityChip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      paddingHorizontal: 7,
      paddingVertical: 3,
      borderRadius: 6,
      backgroundColor: withAlpha(colors.primary, 0.07),
      borderWidth: StyleSheet.hairlineWidth,
    },
    modalIdentityLabel: {
      fontSize: 8,
      fontWeight: '700',
      letterSpacing: 0.6,
      textTransform: 'uppercase',
    },
    modalIdentityValue: {
      fontSize: 9,
      fontWeight: '600',
      fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
      maxWidth: 160,
    },

    // Host hardware mini-stream row
    modalHwSection: {
      flexDirection: 'row',
      alignItems: 'center',
      flexWrap: 'wrap',
      gap: 6,
      paddingHorizontal: SPACING.md,
      paddingVertical: 7,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: withAlpha(colors.text || '#fff', 0.05),
    },
    modalHwHostLabel: {
      fontSize: 8,
      fontWeight: '700',
      letterSpacing: 0.5,
      textTransform: 'uppercase',
      minWidth: 36,
    },
    modalHwBars: {
      flexDirection: 'row',
      gap: 10,
      flex: 1,
    },
    modalHwSpecsText: {
      fontSize: 9,
      width: '100%',
      paddingLeft: 17,
      marginTop: -2,
    },

    // "Respawn of …" lineage chip inside the modal header.
    modalRespawnChip: {
      flexDirection: 'row', alignItems: 'center', gap: 6,
      alignSelf: 'flex-start',
      marginTop: 6,
      marginHorizontal: SPACING.md,
      paddingHorizontal: 10, paddingVertical: 4,
      borderRadius: 999, borderWidth: 1,
      maxWidth: '100%',
    },
    modalRespawnChipText: {
      fontSize: 10, fontWeight: '700', letterSpacing: 0.5,
      fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    },

    // Failure banner above the activity feed for error/timeout runs.
    failureBanner: {
      flexDirection: 'row', alignItems: 'flex-start', gap: SPACING.md,
      padding: SPACING.md,
    },
    failureBannerLabel: {
      fontSize: 10, fontWeight: '700', letterSpacing: 1.2, marginBottom: 4,
    },
    failureBannerText: {
      fontSize: 12, color: colors.text, lineHeight: 18,
    },

    // Activity-feed panel — chronological progress updates from the run.
    activityFeedInner: { paddingVertical: 4 },
    activityFeedHeader: {
      flexDirection: 'row', alignItems: 'center', gap: SPACING.sm,
      paddingHorizontal: SPACING.md, paddingTop: SPACING.sm, paddingBottom: 6,
      borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: divider,
    },
    activityFeedTitle: { fontSize: 10, fontWeight: '700', letterSpacing: 1.4 },
    activityFeedCount: { fontSize: 10, marginLeft: 'auto' },
    activityFeedRow: {
      flexDirection: 'row', alignItems: 'flex-start',
      paddingVertical: 10, paddingHorizontal: SPACING.md, gap: SPACING.md,
      borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: divider,
    },
    activityFeedDot: {
      width: 8, height: 8, borderRadius: 4, marginTop: 6,
    },
    activityFeedTopRow: {
      flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap',
    },
    activityFeedStatus: { fontSize: 9, fontWeight: '700', letterSpacing: 0.6 },
    activityFeedPct: { fontSize: 10, fontWeight: '700' },
    activityFeedCheckpoint: {
      fontSize: 9, fontWeight: '700', letterSpacing: 0.4,
      paddingHorizontal: 6, paddingVertical: 1,
      borderRadius: 4, borderWidth: StyleSheet.hairlineWidth,
      maxWidth: 160,
    },
    activityFeedTime: { fontSize: 9, color: colors.textMuted, opacity: 0.8 },
    activityFeedMessage: {
      fontSize: 12, color: colors.text, lineHeight: 18, marginTop: 3,
    },

    // Transcript
    logInner: { paddingVertical: 2 },
    itemNoBorder: { borderBottomWidth: 0 },

    systemItem: {
      flexDirection: 'row', paddingVertical: 10, paddingHorizontal: SPACING.md,
      borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: divider, gap: SPACING.md,
    },
    systemIconWrap: {
      width: 28, height: 28,
      backgroundColor: withAlpha(colors.primary, 0.12),
      borderRadius: 8,
      borderWidth: StyleSheet.hairlineWidth, borderColor: withAlpha(colors.primary, 0.22),
      alignItems: 'center', justifyContent: 'center',
    },
    systemContent: { flex: 1 },
    systemText: { fontSize: 12, color: colors.textSecondary, lineHeight: 18 },
    systemMeta: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm, marginTop: 4 },
    systemTime: { fontSize: 9, color: colors.textMuted, opacity: 0.7 },
    outcomeBadge: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4 },
    outcomeText: { fontSize: 9, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.4 },

    messageItem: {
      paddingVertical: 12, paddingHorizontal: SPACING.md,
      borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: divider,
    },
    messageHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 },
    messageRole: { fontSize: 11, fontWeight: '700', letterSpacing: 0.3 },
    messageTime: { fontSize: 9, color: colors.textMuted, opacity: 0.7 },
    messageText: { fontSize: 13, color: colors.text, lineHeight: 20 },
    inlineTools: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8 },
    inlineTool: {
      backgroundColor: withAlpha(colors.primary, 0.14),
      borderWidth: StyleSheet.hairlineWidth, borderColor: withAlpha(colors.primary, 0.25),
      paddingHorizontal: 8, paddingVertical: 4, borderRadius: 6,
    },
    inlineToolText: { fontSize: 9, fontWeight: '600', color: colors.primary, letterSpacing: 0.2 },
    moreTools: { fontSize: 9, color: colors.textMuted, alignSelf: 'center' },

    // Input bar (modal)
    inputContainer: {
      paddingTop: SPACING.md, paddingBottom: Platform.OS === 'ios' ? SPACING.xl : SPACING.md,
      paddingHorizontal: SPACING.md,
    },
    inputAccent: { position: 'absolute', left: 0, right: 0, top: 0, height: 1, overflow: 'hidden' },
    inputWrapper: { flexDirection: 'row', alignItems: 'flex-end', gap: 10 },
    input: {
      flex: 1,
      backgroundColor: withAlpha(colors.background || '#000', 0.45),
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: withAlpha(colors.primary, 0.22),
      paddingHorizontal: 14, paddingVertical: 10,
      color: colors.text, fontSize: 14,
      borderRadius: 12, maxHeight: 110,
      ...DEPTH[1].shadow,
    },
    sendBtn: {
      width: 44, height: 44,
      alignItems: 'center', justifyContent: 'center',
      borderRadius: 12, ...DEPTH[1].shadow,
    },
    sendBtnDisabled: { opacity: 0.4 },

    // ── Tabs (modal header) ──
    modalTabsScroll: {
      paddingTop: 8,
    },
    modalTabsRow: {
      flexDirection: 'row',
      paddingHorizontal: SPACING.md,
      gap: 6,
      paddingBottom: 2,
    },
    modalTab: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      paddingHorizontal: 12,
      paddingVertical: 6,
      borderRadius: 999,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: withAlpha(colors.text || '#fff', 0.1),
    },
    modalTabText: { fontSize: 11, fontWeight: '700', letterSpacing: 0.4 },
    modalTabBadge: {
      paddingHorizontal: 6,
      paddingVertical: 1,
      borderRadius: 4,
      borderWidth: StyleSheet.hairlineWidth,
    },
    modalTabBadgeText: { fontSize: 8, fontWeight: '700', letterSpacing: 0.4 },
    modalTabLiveDot: {
      width: 6, height: 6, borderRadius: 3,
    },

    // ── Live session controls row (Pause / Compact / Edit) ──
    modalControlsRow: {
      flexDirection: 'row',
      gap: 8,
      paddingHorizontal: SPACING.md,
      paddingVertical: 6,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: divider,
    },
    modalCtrlBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      paddingHorizontal: 10,
      paddingVertical: 5,
      borderWidth: 1,
      borderRadius: 999,
    },
    modalCtrlBtnText: { fontSize: 11, fontWeight: '700', letterSpacing: 0.4 },

    // ── Thinking pulse (Live tab) ──
    thinkingRow: {
      flexDirection: 'row', alignItems: 'center', gap: 6,
      paddingHorizontal: SPACING.md, paddingVertical: 8,
    },
    thinkingDot: { width: 6, height: 6, borderRadius: 3, opacity: 0.7 },
    thinkingText: { fontSize: 11, fontStyle: 'italic' },

    // ── Jump-to-live floating button ──
    jumpToLive: {
      flexDirection: 'row', alignItems: 'center', gap: 6,
      alignSelf: 'center',
      paddingHorizontal: 12, paddingVertical: 6,
      borderRadius: 999, borderWidth: 1,
      marginBottom: 4,
    },
    jumpToLiveText: { fontSize: 11, fontWeight: '700', letterSpacing: 0.4 },

    // ── Edit-last-assistant area ──
    editArea: {
      padding: SPACING.md, gap: 8,
      borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: divider,
    },
    editAreaLabel: { fontSize: 10, fontWeight: '700', letterSpacing: 1.2 },
    editAreaActions: { flexDirection: 'row', gap: 8 },

    // ── Composer disabled state ──
    composerDisabled: {
      flexDirection: 'row', alignItems: 'center', gap: SPACING.sm,
      paddingHorizontal: SPACING.md, paddingVertical: SPACING.sm,
    },
    composerDisabledText: { flex: 1, fontSize: 12 },

    // ── Overview tab ──
    overviewSection: { paddingVertical: 10 },
    overviewSectionHeader: {
      flexDirection: 'row', alignItems: 'center', gap: 8,
      marginBottom: 8,
    },
    overviewSectionLabel: { fontSize: 10, fontWeight: '700', letterSpacing: 1.4 },
    overviewSectionCount: { fontSize: 10, fontWeight: '700' },
    overviewTaskText: {
      fontSize: 13, lineHeight: 20,
      fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    },
    overviewEmpty: { fontSize: 11, fontStyle: 'italic' },
    overviewRow: {
      flexDirection: 'row', alignItems: 'center', gap: SPACING.sm,
      paddingVertical: 10,
      borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: divider,
    },
    overviewRowTitle: { fontSize: 13, fontWeight: '600' },
    overviewRowSub: { fontSize: 10, marginTop: 2 },
    overviewActionBadgesRow: {
      flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 8,
    },
    overviewActionBadge: {
      paddingHorizontal: 7, paddingVertical: 2,
      borderRadius: 4, borderWidth: StyleSheet.hairlineWidth,
    },
    overviewActionBadgeText: { fontSize: 9, fontWeight: '700', letterSpacing: 0.4 },
    overviewFileRow: {
      flexDirection: 'row', alignItems: 'center', gap: 8,
      paddingVertical: 6,
      borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: divider,
    },
    overviewFileActLetter: {
      width: 16, textAlign: 'center',
      fontSize: 10, fontWeight: '700',
      fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    },
    overviewFileDir: { fontSize: 9, color: 'rgba(255,255,255,0.4)' },
    overviewFileBase: {
      fontSize: 12, fontWeight: '600',
      fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    },
    overviewLinkBtn: { paddingVertical: 8 },
    overviewLinkBtnText: { fontSize: 12, fontWeight: '600' },
    overviewMetaGrid: { gap: 6 },
    overviewMetaCell: {
      flexDirection: 'row', alignItems: 'center', gap: 8,
      paddingVertical: 4,
    },
    overviewMetaKey: { fontSize: 9, fontWeight: '700', letterSpacing: 0.8, width: 80 },
    overviewMetaVal: {
      flex: 1, fontSize: 11,
      fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    },

    // ── Tool Calls tab ──
    toolCallRow: {
      flexDirection: 'row', alignItems: 'flex-start', gap: SPACING.sm,
      paddingHorizontal: SPACING.md, paddingVertical: 10,
      borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: divider,
    },
    toolCallLabel: {
      paddingHorizontal: 6, paddingVertical: 2,
      borderRadius: 4, borderWidth: StyleSheet.hairlineWidth,
      minWidth: 48, alignItems: 'center',
    },
    toolCallLabelText: { fontSize: 9, fontWeight: '700', letterSpacing: 0.4 },
    toolCallText: {
      flex: 1, fontSize: 11, lineHeight: 16,
      fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    },
    toolCallTime: { fontSize: 9 },

    // ── Output tab ──
    outputBlockHeader: {
      paddingHorizontal: SPACING.md, paddingTop: 8, paddingBottom: 4,
    },
    outputBlockTime: { fontSize: 9, fontWeight: '600', letterSpacing: 0.4 },
    outputBlockText: {
      paddingHorizontal: SPACING.md, paddingBottom: SPACING.md,
      fontSize: 11, lineHeight: 16,
      color: colors.text,
      fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    },

    // ── History tab ──
    historyRow: {
      paddingHorizontal: SPACING.md, paddingVertical: 8,
      borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: divider,
      gap: 2,
    },
    historyRole: { fontSize: 9, fontWeight: '700', letterSpacing: 0.6 },
    historyText: { fontSize: 11, lineHeight: 16 },
    historyTime: { fontSize: 9, opacity: 0.7 },
  });
}
