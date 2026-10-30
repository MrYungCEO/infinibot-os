/**
 * AgentFocusSheet — Premium bottom-sheet drill-in for a single running agent.
 *
 * Renders inside NeuralMeshScreen's galaxy when a planet is tapped. Operator
 * console layout: identity / live activity (with transcript preview) /
 * resources / federation / action chips. Drag-to-expand with two snaps
 * (small ~auto, large ~85% screen). Polls `sessions.preview` every 3s while
 * open; cancels on close.
 *
 * Data sources (all best-effort — gracefully omits rows when missing):
 *  - agent.runId / agent.sessionKey / agent.task / agent.createdAt /
 *    agent.lastActivity / agent.filesTouchedCount / agent.kanbanTaskId /
 *    agent.coderBackend                    ← from subagents.list merge
 *  - sessions.preview                      ← transcript preview poll
 *  - subagents.status                      ← latest checkpoint + activity
 *  - subagents.detail                      ← content pages + files touched (enrichment)
 *  - federation.invokeOnNode('subagents.stop' | 'subagents.respawn')
 *
 * Style: glassmorphism over BlurView, status-tinted border glow when running,
 * uses COLORS from the mobile theme runtime (no hex inventions).
 */
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  Animated,
  Easing,
  Dimensions,
  PanResponder,
  Pressable,
  Alert,
  Platform,
  Linking,
  Modal,
  ActivityIndicator,
  TextInput,
} from 'react-native';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { BlurView } from 'expo-blur';
import * as Clipboard from 'expo-clipboard';

import { COLORS, SPACING, FONTS } from '../constants/theme';

const { height: SCREEN_HEIGHT } = Dimensions.get('window');

const SNAP_SMALL = Math.min(420, Math.round(SCREEN_HEIGHT * 0.55));
const SNAP_LARGE = Math.round(SCREEN_HEIGHT * 0.88);

const STATUS_COLORS = {
  idle:      '#64748B',
  running:   '#22C55E',
  completed: '#FFD700',
  error:     '#EF4444',
};

const MONO = Platform.OS === 'ios' ? 'Menlo' : 'monospace';

// ─── helpers ──────────────────────────────────────────────────────────

function truncMiddle(s, head = 6, tail = 6) {
  if (!s) return '—';
  const str = String(s);
  if (str.length <= head + tail + 1) return str;
  return `${str.slice(0, head)}…${str.slice(-tail)}`;
}

function fmtAbs(ts) {
  if (!ts) return '—';
  try {
    return new Date(ts).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return '—';
  }
}

function fmtRel(ts) {
  if (!ts) return '';
  const diff = Math.max(0, Date.now() - ts);
  const s = Math.floor(diff / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return rs > 0 && m < 5 ? `${m}m ${rs}s ago` : `${m}m ago`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  if (h < 24) return rm > 0 ? `${h}h ${rm}m ago` : `${h}h ago`;
  return new Date(ts).toLocaleDateString();
}

function fmtRuntime(ts) {
  if (!ts) return '—';
  const diff = Math.max(0, Date.now() - ts);
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return `${m}m ${rs}s`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return `${h}h ${rm}m`;
}

function fmtDurMs(ms) {
  if (!ms || ms <= 0) return null;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

// Heuristic closeout extraction for finished sub-agents (mirrors the web
// Completion tab). Sources: progress-update messages (skipping fine-grained
// "working" echoes) + transcript prose. No LLM call.
const CLOSE_DEFERRED =
  /\b(deferred?|to-?do|couldn'?t|could not|unable to|blocked|not implemented|not yet|skipped?|didn'?t|did not|won'?t)\b/i;
const CLOSE_NEXT = /\b(next step|follow.?up|recommend|suggest|consider|remaining)\b/i;
function buildCloseout({ updates, transcript, outcomeError }) {
  const msgs = [];
  if (Array.isArray(updates)) {
    for (const u of updates) {
      if (u?.status !== 'working' && u?.message) msgs.push(String(u.message));
    }
  }
  if (Array.isArray(transcript)) {
    for (const ln of transcript) {
      if (ln?.role !== 'user' && ln?.text) msgs.push(String(ln.text));
    }
  }
  const clean = (s) =>
    String(s)
      .replace(/^[^\w“"']+/, '')
      .replace(/^(starting|finishing|checkpoint|working)\s*[:：]\s*/i, '')
      .replace(/\s*\(\d+\s*ms\)\s*$/, '')
      .trim();
  const lines = msgs.map(clean).filter((l) => l.length > 3);
  let headline = '';
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].length > 18) { headline = lines[i]; break; }
  }
  if (!headline) headline = lines[lines.length - 1] || '';
  if (headline.length > 180) headline = headline.slice(0, 177) + '…';
  const deferred = [];
  const next = [];
  const seen = new Set();
  for (const l of lines) {
    const k = l.toLowerCase();
    if (seen.has(k) || l.length < 6 || l.length > 200) continue;
    if (CLOSE_NEXT.test(l)) { if (next.length < 4) { next.push(l); seen.add(k); } }
    else if (CLOSE_DEFERRED.test(l)) { if (deferred.length < 4) { deferred.push(l); seen.add(k); } }
  }
  return { headline, deferred, next, hasText: lines.length > 0, outcomeError: outcomeError || null };
}

function deriveStatus(agent) {
  if (!agent) return 'idle';
  if (agent.status) {
    const s = String(agent.status).toLowerCase();
    if (s === 'failed' || s === 'error' || s === 'errored') return 'error';
    if (s === 'completed' || s === 'done') return 'completed';
    if (s === 'working' || s === 'running' || s === 'streaming') return 'running';
    if (s === 'starting' || s === 'finishing' || s === 'thinking') return 'running';
    if (s === 'blocked' || s === 'input_required') return 'error';
    if (s === 'idle') return 'idle';
  }
  if (agent.isThinking || agent.isActive) return 'running';
  return 'idle';
}

// ─── small subcomponents ──────────────────────────────────────────────

function SectionLabel({ icon, text }) {
  return (
    <View style={styles.sectionLabelRow}>
      {icon ? (
        <Ionicons name={icon} size={10} color={COLORS.textMuted} />
      ) : null}
      <Text style={styles.sectionLabel}>{text}</Text>
      <View style={styles.sectionLabelRule} />
    </View>
  );
}

function MetaRow({ label, value, mono, copyable, onPress, rightIcon }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    if (!copyable || !value) return;
    try {
      await Clipboard.setStringAsync(String(value));
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {}
  }, [copyable, value]);

  const inner = (
    <View style={styles.metaRow}>
      <Text style={styles.metaLabel}>{label}</Text>
      <View style={styles.metaValueWrap}>
        <Text
          style={[styles.metaValue, mono && styles.metaValueMono]}
          numberOfLines={1}
        >
          {value ?? '—'}
        </Text>
        {copied ? (
          <Text style={styles.copiedTag}>copied</Text>
        ) : copyable ? (
          <Ionicons
            name="copy-outline"
            size={11}
            color={COLORS.textMuted}
            style={{ marginLeft: 6 }}
          />
        ) : rightIcon ? (
          <Ionicons
            name={rightIcon}
            size={11}
            color={COLORS.textMuted}
            style={{ marginLeft: 6 }}
          />
        ) : null}
      </View>
    </View>
  );

  if (copyable) {
    return (
      <Pressable onPress={handleCopy} hitSlop={6}>
        {inner}
      </Pressable>
    );
  }
  if (onPress) {
    return (
      <Pressable onPress={onPress} hitSlop={6}>
        {inner}
      </Pressable>
    );
  }
  return inner;
}

function ProgressBar({ value, color }) {
  const v = Math.max(0, Math.min(100, value || 0));
  return (
    <View style={styles.progressTrack}>
      <View
        style={[
          styles.progressFill,
          { width: `${v}%`, backgroundColor: color },
        ]}
      />
    </View>
  );
}

function ActionChip({ icon, label, onPress, tone, disabled }) {
  const color =
    tone === 'danger' ? '#EF4444'
    : tone === 'warn'  ? '#F59E0B'
    : COLORS.primary;
  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={disabled}
      activeOpacity={0.7}
      style={[
        styles.chip,
        { borderColor: color + '55' },
        disabled && { opacity: 0.35 },
      ]}
      hitSlop={6}
    >
      <Ionicons name={icon} size={13} color={color} />
      <Text style={[styles.chipText, { color }]}>{label}</Text>
    </TouchableOpacity>
  );
}

// ─── files-touched + content-page rows ───────────────────────────────
// Action→color uses hex already present in this file's STATUS_COLORS/ActionChip
// palette (no new invented tokens). Mirrors TaskActivityScreen's FilesTouchedList.

const FILE_ACTION_COLORS = {
  created: STATUS_COLORS.running, // green
  edited:  '#F59E0B',             // amber (same as ActionChip 'warn')
  deleted: STATUS_COLORS.error,   // red
  read:    COLORS.textMuted,
};

function normFileAction(action) {
  const a = String(action || 'edited').toLowerCase();
  return a in FILE_ACTION_COLORS ? a : 'edited';
}

// Risk hint — amber dot for security/dependency-sensitive files. Mirrors the
// web drawer's fileLooksRisky so oversight is consistent across surfaces.
const RISK_RE =
  /(secret|api[_-]?key|password|token|private[_-]?key|AKIA[0-9A-Z]{16})/i;
function fileLooksRisky(pathStr, patch) {
  const p = String(pathStr || '').toLowerCase();
  if (/package(-lock)?\.json$|\.env|requirements\.txt$|pnpm-lock|yarn\.lock|cargo\.toml$/.test(p)) return true;
  if (/(\.test\.|\.spec\.|__tests__|\/tests?\/)/.test(p) && patch && /^-/m.test(patch)) return true;
  if (patch && RISK_RE.test(patch)) return true;
  return false;
}

const FD_STATUS = {
  created:  { label: 'Created',  color: STATUS_COLORS.running },
  modified: { label: 'Modified', color: '#F59E0B' },
  deleted:  { label: 'Deleted',  color: STATUS_COLORS.error },
  renamed:  { label: 'Renamed',  color: '#818CF8' },
  unchanged:{ label: 'Unchanged',color: COLORS.textMuted },
};

// Parse a unified-diff patch into renderable rows.
function parsePatch(patch) {
  const rows = [];
  for (const raw of String(patch || '').split('\n')) {
    if (raw.startsWith('@@')) { rows.push({ kind: 'hunk', text: raw }); continue; }
    if (raw.startsWith('diff ') || raw.startsWith('index ') || raw.startsWith('--- ') ||
        raw.startsWith('+++ ') || raw.startsWith('new file') || raw.startsWith('deleted file') ||
        raw.startsWith('similarity ') || raw.startsWith('rename ')) continue;
    if (raw.startsWith('+')) rows.push({ kind: 'add', text: raw.slice(1) });
    else if (raw.startsWith('-')) rows.push({ kind: 'del', text: raw.slice(1) });
    else rows.push({ kind: 'ctx', text: raw.startsWith(' ') ? raw.slice(1) : raw });
  }
  return rows;
}

// Full-screen unified-diff drawer for one touched file. Swipe-down (Modal's
// native slide + the grab handle / backdrop tap) dismisses it.
function FileDiffModal({ gateway, runId, file, onClose }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);

  const load = useCallback(async () => {
    if (!gateway?.sendReq || !file) return;
    setLoading(true); setError(null);
    try {
      const res = await gateway.sendReq('files.diff', { path: file.path, runId });
      if (res?.ok) setData(res); else setError(res?.error || 'Failed to load diff');
    } catch (e) {
      setError(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }, [gateway, runId, file]);

  useEffect(() => { load(); }, [load]);

  const created = data?.status === 'created';
  const sm = FD_STATUS[data?.status] || FD_STATUS.modified;

  const doRevert = useCallback(() => {
    const verb = created ? 'Delete' : 'Revert';
    Alert.alert(
      `${verb} file?`,
      `${file?.path}\n\nThis discards the agent's change in the working tree and cannot be undone.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: verb, style: 'destructive',
          onPress: async () => {
            setBusy(true);
            try {
              const r = await gateway.sendReq('files.revert', {
                path: file.path, runId, mode: created ? 'delete' : 'auto',
              });
              setNotice(r?.ok ? (r.action === 'deleted' ? 'File deleted.' : 'Reverted to HEAD.') : `Revert failed: ${r?.error || 'unknown'}`);
              if (r?.ok) load();
            } catch (e) { setNotice(`Revert failed: ${e?.message || e}`); }
            finally { setBusy(false); }
          },
        },
      ],
    );
  }, [created, file, gateway, runId, load]);

  const doAccept = useCallback(async () => {
    setBusy(true);
    try {
      const r = await gateway.sendReq('files.accept', {
        path: file.path, runId, message: `Accept agent change: ${file.path}`,
      });
      setNotice(r?.ok ? `Committed${r.hash ? ` (${r.hash})` : ''}.` : `Accept failed: ${r?.error || 'unknown'}`);
      if (r?.ok) load();
    } catch (e) { setNotice(`Accept failed: ${e?.message || e}`); }
    finally { setBusy(false); }
  }, [file, gateway, runId, load]);

  const doOpen = useCallback(async () => {
    setBusy(true);
    try {
      const r = await gateway.sendReq('files.openInEditor', { path: file.path, runId });
      setNotice(r?.ok ? `Opened in ${r.launcher || 'editor'}.` : `Open failed: ${r?.error || 'no launcher'}`);
    } catch (e) { setNotice(`Open failed: ${e?.message || e}`); }
    finally { setBusy(false); }
  }, [file, gateway, runId]);

  const copyPatch = useCallback(async () => {
    if (data?.patch) { try { await Clipboard.setStringAsync(data.patch); setNotice('Patch copied.'); } catch {} }
  }, [data]);

  const parts = String(file?.path || '').replace(/\\/g, '/').split('/').filter(Boolean);
  const base = parts[parts.length - 1] || file?.path || '—';
  const dir = parts.length > 1 ? parts.slice(0, -1).join('/') : '';
  const rows = data && !data.binary ? parsePatch(data.patch) : [];
  const showFullCreate = data && !data.binary && !data.patch?.trim() && created && data.after;
  const showFullDelete = data && !data.binary && !data.patch?.trim() && data.status === 'deleted' && data.before;

  return (
    <Modal visible animationType="slide" transparent onRequestClose={onClose}>
      <Pressable style={styles.fdBackdrop} onPress={onClose} />
      <View style={styles.fdSheet}>
        <View style={styles.fdGripWrap}><View style={styles.grip} /></View>
        <View style={styles.fdHead}>
          <View style={{ flex: 1, minWidth: 0 }}>
            {dir ? <Text style={styles.fileDir} numberOfLines={1}>{dir}/</Text> : null}
            <Text style={styles.fdTitle} numberOfLines={1}>{base}</Text>
          </View>
          <TouchableOpacity onPress={onClose} style={styles.headerBtn} hitSlop={8}>
            <Ionicons name="close" size={20} color={COLORS.textMuted} />
          </TouchableOpacity>
        </View>

        <View style={styles.fdSub}>
          <View style={[styles.fileBadge, { borderColor: sm.color + '88', backgroundColor: sm.color + '22' }]}>
            <Text style={[styles.fileBadgeText, { color: sm.color }]}>{sm.label.toUpperCase()}</Text>
          </View>
          {data && !data.binary ? (
            <>
              <Text style={[styles.fdStat, { color: STATUS_COLORS.running }]}>+{data.added}</Text>
              <Text style={[styles.fdStat, { color: STATUS_COLORS.error }]}>−{data.removed}</Text>
            </>
          ) : null}
          {data && fileLooksRisky(file?.path, data.patch) ? (
            <Ionicons name="warning" size={13} color="#F59E0B" />
          ) : null}
          {data?.truncated ? <Text style={styles.fdMuted}>large file — summary only</Text> : null}
        </View>

        {notice ? <Text style={styles.fdNotice}>{notice}</Text> : null}

        <ScrollView style={styles.fdBody} horizontal={false}>
          {loading ? (
            <View style={styles.fdCenter}><ActivityIndicator color={COLORS.primary} /></View>
          ) : error ? (
            <Text style={[styles.emptyHint, { color: STATUS_COLORS.error, padding: 16 }]}>{error}</Text>
          ) : data?.binary ? (
            <Text style={[styles.emptyHint, { padding: 16 }]}>Binary file — diff not shown.</Text>
          ) : (
            <ScrollView horizontal contentContainerStyle={{ minWidth: '100%' }}>
              <View>
                {showFullCreate
                  ? String(data.after).split('\n').map((l, i) => (
                      <Text key={i} style={[styles.fdLine, styles.fdAdd]}>+ {l || ' '}</Text>))
                  : showFullDelete
                  ? String(data.before).split('\n').map((l, i) => (
                      <Text key={i} style={[styles.fdLine, styles.fdDel]}>- {l || ' '}</Text>))
                  : rows.length === 0
                  ? <Text style={[styles.emptyHint, { padding: 16 }]}>No textual changes against HEAD.</Text>
                  : rows.map((r, i) => (
                      <Text
                        key={i}
                        style={[
                          styles.fdLine,
                          r.kind === 'add' ? styles.fdAdd : r.kind === 'del' ? styles.fdDel : r.kind === 'hunk' ? styles.fdHunk : styles.fdCtx,
                        ]}
                      >
                        {r.kind === 'add' ? '+ ' : r.kind === 'del' ? '- ' : r.kind === 'hunk' ? '' : '  '}{r.text || ' '}
                      </Text>
                    ))}
              </View>
            </ScrollView>
          )}
        </ScrollView>

        <View style={styles.fdActions}>
          <ActionChip icon={created ? 'trash-outline' : 'arrow-undo-outline'} label={created ? 'Delete' : data?.status === 'deleted' ? 'Restore' : 'Revert'} tone="danger" onPress={doRevert} disabled={busy || !data} />
          <ActionChip icon="checkmark-done-outline" label="Accept" onPress={doAccept} disabled={busy || !data} />
          <ActionChip icon="open-outline" label="Open" onPress={doOpen} disabled={busy} />
          <ActionChip icon="copy-outline" label="Patch" onPress={copyPatch} disabled={!data?.patch} />
        </View>
      </View>
    </Modal>
  );
}

// ── Proposed-commit card ─────────────────────────────────────────────────────
// Proactive Finish / Reject / Schedule surface for a finished sub-agent that
// left uncommitted work. Mirrors the web subagent-detail-modal card. Uses only
// the live git.* RPCs so it needs no gateway restart.
function parseDiffStat(stat) {
  if (!stat) return { ins: 0, del: 0 };
  const ins = /(\d+) insertion/.exec(stat);
  const del = /(\d+) deletion/.exec(stat);
  return { ins: ins ? parseInt(ins[1], 10) : 0, del: del ? parseInt(del[1], 10) : 0 };
}

function CommitProposalCard({ gateway, workdir, runId, kanbanTaskId, suggestedMessage }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [summary, setSummary] = useState(null);
  const [message, setMessage] = useState(suggestedMessage || 'Agent changes');
  const [edited, setEdited] = useState(false);
  const [busy, setBusy] = useState(null); // 'finish' | 'reject' | null
  const [notice, setNotice] = useState(null);
  const [done, setDone] = useState(null); // { kind, detail }

  const load = useCallback(async () => {
    if (!gateway?.sendReq || !workdir) return;
    setLoading(true); setError(null);
    try {
      const [status, unstaged, staged] = await Promise.all([
        gateway.sendReq('git.status', { cwd: workdir }),
        gateway.sendReq('git.diff', { cwd: workdir }),
        gateway.sendReq('git.diff', { cwd: workdir, staged: true }),
      ]);
      const u = parseDiffStat(unstaged?.stat);
      const s = parseDiffStat(staged?.stat);
      const fileCount = Array.isArray(status?.files) ? status.files.length : 0;
      setSummary({
        branch: status?.branch || '(unknown)',
        fileCount,
        insertions: u.ins + s.ins,
        deletions: u.del + s.del,
        hasChanges: status ? status.clean === false : fileCount > 0,
      });
    } catch (e) {
      setError(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }, [gateway, workdir]);

  useEffect(() => { load(); }, [load]);

  // Keep the suggestion fresh until the user edits the field.
  useEffect(() => {
    if (!edited && suggestedMessage) setMessage(suggestedMessage);
  }, [suggestedMessage, edited]);

  const markDone = useCallback(async () => {
    if (!kanbanTaskId || !gateway?.sendReq) return;
    try { await gateway.sendReq('kanban.tasks.update', { id: kanbanTaskId, patch: { status: 'done' } }); } catch {}
  }, [gateway, kanbanTaskId]);

  const doFinish = useCallback(async () => {
    const msg = (message || '').trim();
    if (!msg) { setNotice('Enter a commit message first.'); return; }
    setBusy('finish'); setNotice(null);
    try {
      await gateway.sendReq('git.add', { cwd: workdir, files: ['-A'] });
      const r = await gateway.sendReq('git.commit', { cwd: workdir, message: msg });
      await markDone();
      setDone({ kind: 'committed', detail: r?.hash ? `Committed ${r.hash}` : 'Committed.' });
    } catch (e) {
      setNotice(`Commit failed: ${e?.message || e}`);
    } finally { setBusy(null); }
  }, [gateway, workdir, message, markDone]);

  const doReject = useCallback(() => {
    Alert.alert(
      'Reject this commit?',
      'Your changes will be stashed (recoverable via `git stash pop`), not deleted.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Reject', style: 'destructive',
          onPress: async () => {
            setBusy('reject'); setNotice(null);
            const label = `infinibot-reject-${kanbanTaskId || runId}`;
            try {
              await gateway.sendReq('git.add', { cwd: workdir, files: ['-A'] });
              await gateway.sendReq('git.stash', { cwd: workdir, op: 'push', message: label });
              let stashRef = 'stash@{0}';
              try {
                const list = await gateway.sendReq('git.stash', { cwd: workdir, op: 'list' });
                const first = String(list?.result || '').split('\n').find(Boolean);
                const m = first && /^(stash@\{\d+\})/.exec(first);
                if (m) stashRef = m[1];
              } catch {}
              await markDone();
              setDone({ kind: 'rejected', detail: `Stashed as ${stashRef} — pop to restore.` });
            } catch (e) {
              setNotice(`Reject failed: ${e?.message || e}`);
            } finally { setBusy(null); }
          },
        },
      ],
    );
  }, [gateway, workdir, runId, kanbanTaskId, markDone]);

  const doDismiss = useCallback(async () => {
    setBusy('finish');
    await markDone();
    setBusy(null);
    setDone({ kind: 'empty', detail: 'Dismissed — no changes.' });
  }, [markDone]);

  if (loading) {
    return (
      <View style={styles.commitCard}>
        <ActivityIndicator color={COLORS.primary} />
      </View>
    );
  }
  if (error) {
    return (
      <View style={styles.commitCard}>
        <Text style={[styles.emptyHint, { color: STATUS_COLORS.error }]}>Couldn't read working tree: {error}</Text>
      </View>
    );
  }
  if (done) {
    const color = done.kind === 'committed' ? STATUS_COLORS.running : '#F59E0B';
    return (
      <View style={styles.commitCard}>
        <Text style={[styles.commitDone, { color }]}>{done.detail}</Text>
      </View>
    );
  }
  if (!summary) return null;

  if (!summary.hasChanges) {
    return (
      <View style={styles.commitCard}>
        <View style={styles.commitEmptyRow}>
          <Text style={styles.commitEmptyText}>No changes to commit on {summary.branch}.</Text>
          <ActionChip icon="close-circle-outline" label="Dismiss" onPress={doDismiss} disabled={busy != null} />
        </View>
      </View>
    );
  }

  const disabled = busy != null;
  return (
    <View style={styles.commitCard}>
      <View style={styles.commitMetaRow}>
        <Text style={styles.commitBranch}>⎇ {summary.branch}</Text>
        <Text style={styles.commitStat}>{summary.fileCount} file{summary.fileCount === 1 ? '' : 's'}</Text>
        <Text style={[styles.commitStat, { color: STATUS_COLORS.running }]}>+{summary.insertions}</Text>
        <Text style={[styles.commitStat, { color: STATUS_COLORS.error }]}>−{summary.deletions}</Text>
      </View>

      <TextInput
        style={styles.commitInput}
        value={message}
        onChangeText={(t) => { setMessage(t); setEdited(true); }}
        placeholder="Commit message…"
        placeholderTextColor={COLORS.textMuted}
        editable={!disabled}
        multiline
      />

      {notice ? <Text style={styles.fdNotice}>{notice}</Text> : null}

      <View style={styles.commitActions}>
        <TouchableOpacity
          style={[styles.commitFinishBtn, disabled && { opacity: 0.5 }]}
          onPress={doFinish}
          disabled={disabled}
        >
          <Ionicons name="checkmark-done-outline" size={14} color="#fff" />
          <Text style={styles.commitFinishText}>{busy === 'finish' ? 'Committing…' : 'Finish & commit'}</Text>
        </TouchableOpacity>
        <ActionChip icon="arrow-undo-outline" label={busy === 'reject' ? 'Stashing…' : 'Reject'} tone="danger" onPress={doReject} disabled={disabled} />
        <TouchableOpacity
          onPress={() => setNotice('Scheduling isn’t available yet — use Finish or Reject.')}
          disabled={disabled}
          hitSlop={8}
        >
          <Text style={styles.commitSchedule}>Schedule…</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

function FilesTouchedList({ files, totalCount, gateway, runId }) {
  const [showAll, setShowAll] = useState(false);
  const [selected, setSelected] = useState(null);
  const VISIBLE = 12;
  const visible = showAll ? files : files.slice(0, VISIBLE);
  const canInspect = !!gateway?.sendReq && !!runId;

  const groups = {};
  for (const f of files) {
    const a = normFileAction(f.action);
    groups[a] = (groups[a] || 0) + 1;
  }
  const order = ['created', 'edited', 'deleted', 'read'];

  if (files.length === 0) {
    return (
      <Text style={styles.emptyHint}>
        {totalCount > 0
          ? `${totalCount} file${totalCount === 1 ? '' : 's'} touched (paths unavailable).`
          : 'No file activity recorded.'}
      </Text>
    );
  }

  return (
    <View>
      <View style={styles.fileBadgesRow}>
        {order.filter((a) => groups[a]).map((a) => (
          <View
            key={a}
            style={[
              styles.fileBadge,
              { borderColor: FILE_ACTION_COLORS[a] + '88', backgroundColor: FILE_ACTION_COLORS[a] + '22' },
            ]}
          >
            <Text style={[styles.fileBadgeText, { color: FILE_ACTION_COLORS[a] }]}>
              {a.toUpperCase()} {groups[a]}
            </Text>
          </View>
        ))}
        {totalCount && totalCount > files.length ? (
          <View style={[styles.fileBadge, { borderColor: 'rgba(255,255,255,0.18)' }]}>
            <Text style={[styles.fileBadgeText, { color: COLORS.textMuted }]}>
              {totalCount} TOTAL
            </Text>
          </View>
        ) : null}
      </View>
      {visible.map((f, idx) => {
        const a = normFileAction(f.action);
        const parts = String(f.path || '').replace(/\\/g, '/').split('/').filter(Boolean);
        const base = parts[parts.length - 1] || f.path || '—';
        const dir = parts.length > 1 ? parts.slice(0, -1).join('/') : '';
        const risky = fileLooksRisky(f.path);
        const Row = canInspect ? TouchableOpacity : View;
        return (
          <Row
            key={`${f.path}-${idx}`}
            style={styles.fileRow}
            {...(canInspect ? { onPress: () => setSelected(f), activeOpacity: 0.6, hitSlop: 4 } : {})}
          >
            <Text style={[styles.fileActLetter, { color: FILE_ACTION_COLORS[a] }]}>
              {a[0].toUpperCase()}
            </Text>
            <View style={{ flex: 1, minWidth: 0 }}>
              {dir ? (
                <Text style={styles.fileDir} numberOfLines={1}>{dir}/</Text>
              ) : null}
              <Text style={styles.fileBase} numberOfLines={1}>{base}</Text>
            </View>
            {risky ? <View style={styles.riskDot} /> : null}
            {canInspect ? <Ionicons name="chevron-forward" size={13} color={COLORS.textMuted} /> : null}
          </Row>
        );
      })}
      {files.length > VISIBLE ? (
        <TouchableOpacity onPress={() => setShowAll((v) => !v)} style={styles.fileToggleBtn} hitSlop={6}>
          <Text style={styles.fileToggleText}>
            {showAll ? 'Collapse' : `Show all (${files.length})`}
          </Text>
        </TouchableOpacity>
      ) : null}
      {selected ? (
        <FileDiffModal
          gateway={gateway}
          runId={runId}
          file={selected}
          onClose={() => setSelected(null)}
        />
      ) : null}
    </View>
  );
}

function ContentPageRow({ page, onPress }) {
  const sub = [
    page.surface ? String(page.surface).toUpperCase() : null,
    page.handle ? `@${page.handle}` : null,
    page.updatedAt ? `updated ${fmtRel(page.updatedAt)}` : null,
  ].filter(Boolean).join(' · ');
  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.7}
      style={styles.contentRow}
      hitSlop={4}
    >
      <Ionicons name="document-text-outline" size={15} color={COLORS.primary} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={styles.contentRowTitle} numberOfLines={1}>{page.name || page.id}</Text>
        {sub ? <Text style={styles.contentRowSub} numberOfLines={1}>{sub}</Text> : null}
      </View>
      <Ionicons name="open-outline" size={13} color={COLORS.textMuted} />
    </TouchableOpacity>
  );
}

// ─── transcript preview ───────────────────────────────────────────────

function useTranscriptPreview({ gateway, sessionKey, enabled, intervalMs = 3000 }) {
  const [lines, setLines] = useState([]);
  const [loading, setLoading] = useState(false);
  const pollRef = useRef(null);

  const fetchOnce = useCallback(async () => {
    if (!enabled || !sessionKey || !gateway?.sendReq) return;
    try {
      const res = await gateway.sendReq('sessions.preview', {
        keys: [sessionKey],
        limit: 30,
        maxChars: 3000,
      });
      const items = res?.previews?.[0]?.items ?? [];
      // Flatten messages into short label/text lines, prefer last ~5.
      const flattened = [];
      for (const m of items) {
        const role = m.role || (m.actionType ? 'system' : 'agent');
        const raw = Array.isArray(m.content)
          ? m.content.filter(b => b?.type === 'text').map(b => b.text).join('')
          : (m.content ?? m.text ?? '');
        const text = String(raw).replace(/\s+/g, ' ').trim();
        if (!text) continue;
        flattened.push({
          role,
          text,
          ts: m.timestamp || m.ts || Date.now(),
        });
      }
      setLines(flattened.slice(-6));
    } catch {
      // session may not exist or method unavailable — silent
    } finally {
      setLoading(false);
    }
  }, [enabled, sessionKey, gateway]);

  useEffect(() => {
    if (!enabled || !sessionKey) {
      setLines([]);
      return undefined;
    }
    setLoading(true);
    fetchOnce();
    pollRef.current = setInterval(fetchOnce, intervalMs);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = null;
    };
  }, [enabled, sessionKey, intervalMs, fetchOnce]);

  return { lines, loading, refresh: fetchOnce };
}

// ─── subagent status enrichment ───────────────────────────────────────

function useSubagentStatus({ gateway, runId, enabled, intervalMs = 4000 }) {
  const [data, setData] = useState(null);
  const pollRef = useRef(null);

  const fetchOnce = useCallback(async () => {
    if (!enabled || !runId || !gateway?.sendReq) return;
    try {
      const res = await gateway.sendReq('subagents.status', { runId });
      if (res?.subagent) setData(res.subagent);
    } catch {
      // not always available; ignore
    }
  }, [enabled, runId, gateway]);

  useEffect(() => {
    if (!enabled || !runId) {
      setData(null);
      return undefined;
    }
    fetchOnce();
    pollRef.current = setInterval(fetchOnce, intervalMs);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = null;
    };
  }, [enabled, runId, intervalMs, fetchOnce]);

  return data;
}

// ─── subagent detail enrichment (content pages + files touched) ───────
// Best-effort `subagents.detail` → { run, project, tasks[], contentPages[], source }.
// Older gateways lack this method; we guard with try/catch and keep prior data.
// Fetches once on mount/expand, then lightly polls a few times so enrichment
// that lands slightly after spawn still surfaces.

function useSubagentDetail({ gateway, runId, enabled }) {
  const [detail, setDetail] = useState(null);

  const fetchOnce = useCallback(async () => {
    if (!enabled || !runId || !gateway?.sendReq) return;
    try {
      const res = await gateway.sendReq('subagents.detail', { runId });
      if (res?.ok || res?.run || res?.contentPages || res?.tasks) {
        setDetail({
          run: res.run || null,
          project: res.project || null,
          tasks: res.tasks ?? (res.task ? [res.task] : []),
          contentPages: res.contentPages ?? [],
          source: res.source ?? 'live',
        });
      }
    } catch {
      // method unavailable on older gateways — leave prior detail intact
    }
  }, [enabled, runId, gateway]);

  useEffect(() => {
    if (!enabled || !runId) {
      setDetail(null);
      return undefined;
    }
    fetchOnce();
    let ticks = 0;
    const id = setInterval(() => {
      ticks += 1;
      fetchOnce();
      if (ticks >= 3 && id) clearInterval(id);
    }, 4000);
    return () => clearInterval(id);
  }, [enabled, runId, fetchOnce]);

  return { detail, refresh: fetchOnce };
}

// ─── main component ───────────────────────────────────────────────────

export function AgentFocusSheet({
  agent,
  provider,           // { color, icon, label, mono } from inferProvider
  gateway,
  federation,         // useFederation result (for invokeOnNode + node lookup)
  navigation,
  onClose,
  onOpenMore,         // legacy "More" overflow → QuickActionsModal
}) {
  const insetBottom = 12; // sheet has its own bottom padding; safe-area handled by host

  const [expanded, setExpanded] = useState(false);

  // Animated sheet height so drag/snap is smooth.
  const heightAnim = useRef(new Animated.Value(SNAP_SMALL)).current;
  const lastHeightRef = useRef(SNAP_SMALL);

  // Live ticker so "spawned … ago" / runtime stays fresh even between polls.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!agent) return undefined;
    const id = setInterval(() => setTick((t) => (t + 1) % 1_000_000), 1000);
    return () => clearInterval(id);
  }, [agent]);

  // Enter animation on mount.
  useEffect(() => {
    if (!agent) return;
    setExpanded(false);
    heightAnim.setValue(SNAP_SMALL * 0.4);
    Animated.spring(heightAnim, {
      toValue: SNAP_SMALL,
      friction: 9,
      tension: 70,
      useNativeDriver: false,
    }).start(() => { lastHeightRef.current = SNAP_SMALL; });
  }, [agent?.id, agent?.sessionKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const snapTo = useCallback((target) => {
    const clamped = Math.max(SNAP_SMALL, Math.min(SNAP_LARGE, target));
    setExpanded(clamped > (SNAP_SMALL + SNAP_LARGE) / 2);
    Animated.spring(heightAnim, {
      toValue: clamped > (SNAP_SMALL + SNAP_LARGE) / 2 ? SNAP_LARGE : SNAP_SMALL,
      friction: 9,
      tension: 70,
      useNativeDriver: false,
    }).start(({ finished }) => {
      if (finished) {
        lastHeightRef.current =
          clamped > (SNAP_SMALL + SNAP_LARGE) / 2 ? SNAP_LARGE : SNAP_SMALL;
      }
    });
  }, [heightAnim]);

  // Holds the latest detail-refresh fn; toggleExpand is defined before the
  // detail hook, so it reads through this ref to avoid a TDZ on the binding.
  const refreshDetailRef = useRef(null);

  const toggleExpand = useCallback(() => {
    if (!expanded) { try { refreshDetailRef.current?.(); } catch {} }
    snapTo(expanded ? SNAP_SMALL : SNAP_LARGE);
  }, [expanded, snapTo]);

  // PanResponder bound to the grip so the scrollview keeps scrolling cleanly.
  const dragStartRef = useRef(SNAP_SMALL);
  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: (_e, g) =>
          Math.abs(g.dy) > 4 && Math.abs(g.dy) > Math.abs(g.dx),
        onPanResponderGrant: () => {
          dragStartRef.current = lastHeightRef.current;
        },
        onPanResponderMove: (_e, g) => {
          const next = Math.max(
            SNAP_SMALL,
            Math.min(SNAP_LARGE, dragStartRef.current - g.dy),
          );
          heightAnim.setValue(next);
        },
        onPanResponderRelease: (_e, g) => {
          const target = dragStartRef.current - g.dy;
          snapTo(target);
        },
        onPanResponderTerminate: () => {
          snapTo(lastHeightRef.current);
        },
      }),
    [heightAnim, snapTo],
  );

  // ── live data ──
  const status = deriveStatus(agent);
  const statusColor = STATUS_COLORS[status] || STATUS_COLORS.idle;
  const runId = agent?.runId || agent?.sessionKey || null;
  const sessionKey = agent?.sessionKey || agent?.runId || null;

  const { lines: transcript, loading: transcriptLoading } = useTranscriptPreview({
    gateway,
    sessionKey,
    enabled: !!agent,
    intervalMs: 3000,
  });

  const liveStatus = useSubagentStatus({
    gateway,
    runId,
    enabled: !!agent && !!runId,
    intervalMs: 4000,
  });

  const { detail: runDetail, refresh: refreshDetail } = useSubagentDetail({
    gateway,
    runId,
    enabled: !!agent && !!runId,
  });
  useEffect(() => { refreshDetailRef.current = refreshDetail; }, [refreshDetail]);

  // Pulse for status dot when running.
  const dotPulse = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (status !== 'running') {
      dotPulse.setValue(0);
      return undefined;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(dotPulse, { toValue: 1, duration: 900, easing: Easing.out(Easing.ease), useNativeDriver: true }),
        Animated.timing(dotPulse, { toValue: 0, duration: 900, easing: Easing.in(Easing.ease), useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [status, dotPulse]);

  // ── computed display fields ──
  const createdAt = agent?.createdAt || agent?.startedAt || liveStatus?.createdAt;
  const lastUpdate = liveStatus?.lastUpdateAt || agent?.lastUpdateAt || agent?.lastActivity?.at || agent?.lastActivity;
  const lastUpdateTs =
    typeof lastUpdate === 'number' ? lastUpdate :
    lastUpdate ? new Date(lastUpdate).getTime() : null;

  const currentStepText =
    liveStatus?.lastActivity?.label
    || agent?.lastActivity?.label
    || agent?.currentCheckpoint
    || (Array.isArray(liveStatus?.updates) && liveStatus.updates.length > 0
        ? liveStatus.updates[liveStatus.updates.length - 1]?.message
        : null);

  const checkpoints = liveStatus?.checkpoints || agent?.checkpoints || [];
  const currentCheckpoint = liveStatus?.currentCheckpoint || agent?.currentCheckpoint;
  const filesCount = liveStatus?.filesTouchedCount ?? agent?.filesTouchedCount;
  const kanbanTaskId = liveStatus?.kanbanTaskId || agent?.kanbanTaskId;

  // ── content pages + files touched (from subagents.detail enrichment) ──
  const contentPages = runDetail?.contentPages || [];
  const detailFiles = useMemo(() => {
    const run = runDetail?.run;
    if (!run) return [];
    if (Array.isArray(run.filesTouched) && run.filesTouched.length > 0) {
      return run.filesTouched;
    }
    return (run.filesTouchedSample || []).map((p) => ({ path: p, action: 'edited' }));
  }, [runDetail]);
  const detailFilesCount = runDetail?.run?.filesTouchedCount ?? filesCount ?? 0;
  const taskText = liveStatus?.task || agent?.task || agent?.currentTask;
  const coderBackend = liveStatus?.coderBackend || agent?.coderBackend;
  const respawnOf = liveStatus?.respawnOfRunId || agent?.respawnOfRunId;

  // ── closeout summary (finished runs) ──
  const isFinished = status === 'completed' || status === 'error' || !!runDetail?.run?.endedAt;
  const closeout = useMemo(
    () => buildCloseout({
      updates: liveStatus?.updates,
      transcript,
      outcomeError: runDetail?.run?.outcome?.error,
    }),
    [liveStatus?.updates, transcript, runDetail],
  );
  const runStartMs = runDetail?.run?.startedAt || createdAt;
  const runEndMs = runDetail?.run?.endedAt || lastUpdateTs;
  const closeoutDuration =
    runStartMs && runEndMs && runEndMs > runStartMs ? fmtDurMs(runEndMs - runStartMs) : null;

  // ── federation/node info ──
  const nodeRecord = useMemo(() => {
    const id = agent?.nodeId || 'local';
    return federation?.nodes?.find?.((n) => n.id === id) || null;
  }, [agent?.nodeId, federation?.nodes]);

  const nodeOnline =
    nodeRecord?.status === 'online'
    || nodeRecord?.connected === true
    || nodeRecord?.isLocal
    || (agent?.nodeId === 'local');

  const nodeReachColor = nodeOnline
    ? STATUS_COLORS.running
    : (nodeRecord?.status === 'connecting' ? '#F59E0B' : STATUS_COLORS.error);

  const nodeName = nodeRecord?.name || agent?.nodeName || agent?.nodeId || 'local';

  // ── runtime header derived ──
  const runtime = createdAt ? fmtRuntime(createdAt) : null;
  const subheader = [
    provider?.label || 'Agent',
    nodeName,
    runtime ? `${runtime} runtime` : null,
  ].filter(Boolean).join(' · ');

  // ── actions ──
  const callOnNode = useCallback(async (method, params) => {
    if (!federation?.invokeOnNode) return null;
    try {
      return await federation.invokeOnNode(method, params, agent?.nodeId);
    } catch (err) {
      return { __err: err?.message || String(err) };
    }
  }, [federation, agent?.nodeId]);

  const handleStop = useCallback(() => {
    if (!agent) return;
    Alert.alert(
      'Stop agent?',
      `This will send a stop signal to "${agent.displayName || agent.label || agent.id}". The run will end and cannot be resumed.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Stop',
          style: 'destructive',
          onPress: async () => {
            await callOnNode('subagents.stop', {
              sessionKey: agent.sessionKey || agent.id,
              runId: agent.runId,
            });
          },
        },
      ],
    );
  }, [agent, callOnNode]);

  const handleRespawn = useCallback(async () => {
    if (!agent?.runId) return;
    await callOnNode('subagents.respawn', { runId: agent.runId });
  }, [agent, callOnNode]);

  const handleOpenChat = useCallback(() => {
    if (!agent) return;
    if (gateway?.switchSession && (agent.sessionKey || agent.id)) {
      gateway.switchSession(agent.sessionKey || agent.id);
    }
    navigation?.navigate?.('Chat', { sessionKey: agent.sessionKey || agent.id });
    onClose?.();
  }, [agent, gateway, navigation, onClose]);

  const handleOpenActivity = useCallback(() => {
    if (!agent) return;
    if (navigation?.navigate) {
      try {
        navigation.navigate('TaskActivity', {
          runId: agent.runId,
          sessionKey: agent.sessionKey,
        });
      } catch {
        // route may not exist on this nav stack — silently no-op
      }
    }
  }, [agent, navigation]);

  const handleOpenKanban = useCallback(() => {
    if (!kanbanTaskId) return;
    if (navigation?.navigate) {
      try {
        // Route name is 'Board' (KanbanScreen is registered as "Board" in App.js;
        // the old 'Kanban' target was a dead link). Consistent param shape with
        // TaskActivityScreen.openInKanban + web dispatchKanbanDeepLink:
        // { taskId, projectId }. projectId is best-effort (KanbanScreen resolves
        // it from the task id when absent). _ts makes repeat taps re-fire.
        // Board is a tab inside MainTabs; pop back to the existing tab root.
        navigation.navigate('MainTabs', {
          screen: 'Board',
          params: {
            taskId: kanbanTaskId,
            projectId: runDetail?.project?.id || runDetail?.tasks?.[0]?.projectId || undefined,
            _ts: Date.now(),
          },
        }, { pop: true });
      } catch {}
    }
  }, [navigation, kanbanTaskId, runDetail]);

  // Open a SPECIFIC content page. Prefer an external URL when the page carries
  // one; otherwise route to the Notes screen keyed by the page id so the exact
  // page opens (mirrors how files-touched rows resolve to a concrete target).
  const handleOpenContentPage = useCallback((page) => {
    if (!page) return;
    if (page.url) {
      Linking.openURL(page.url).catch(() => {});
      return;
    }
    if (navigation?.navigate) {
      try {
        navigation.navigate('Notes', { noteId: page.id, contentPageId: page.id });
        onClose?.();
      } catch {}
    }
  }, [navigation, onClose]);

  if (!agent) return null;

  const runningGlowColor = status === 'running' ? statusColor : 'rgba(255,255,255,0.06)';

  return (
    <View style={styles.wrap} pointerEvents="box-none">
      <BlurView
        intensity={70}
        tint="dark"
        style={[StyleSheet.absoluteFill, styles.blur]}
      />
      <Animated.View
        style={[
          styles.sheet,
          {
            height: heightAnim,
            borderColor: runningGlowColor,
            shadowColor: status === 'running' ? statusColor : '#000',
            shadowOpacity: status === 'running' ? 0.5 : 0.35,
          },
        ]}
      >
        {/* Drag handle (PanResponder bound here) */}
        <View {...panResponder.panHandlers} style={styles.gripWrap}>
          <View style={styles.grip} />
        </View>

        {/* Header */}
        <View style={styles.header}>
          <View
            style={[
              styles.headerIcon,
              { borderColor: provider?.color || COLORS.primary, backgroundColor: (provider?.color || COLORS.primary) + '22' },
              status === 'running' && {
                shadowColor: statusColor,
                shadowOpacity: 0.8,
                shadowRadius: 10,
              },
            ]}
          >
            <Ionicons
              name={provider?.icon || 'sparkles-outline'}
              size={22}
              color={provider?.color || COLORS.primary}
            />
          </View>

          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={styles.title} numberOfLines={1}>
              {agent.displayName || agent.label || agent.id}
            </Text>
            <Text style={styles.subtitle} numberOfLines={1}>
              {subheader}
            </Text>
          </View>

          <TouchableOpacity onPress={toggleExpand} style={styles.headerBtn} hitSlop={8}>
            <Ionicons
              name={expanded ? 'chevron-down' : 'chevron-up'}
              size={18}
              color={COLORS.textMuted}
            />
          </TouchableOpacity>
          <TouchableOpacity onPress={onClose} style={styles.headerBtn} hitSlop={8}>
            <Ionicons name="close" size={20} color={COLORS.textMuted} />
          </TouchableOpacity>
        </View>

        {/* Status strip */}
        <View style={styles.statusStrip}>
          <View style={[styles.statusPill, { borderColor: statusColor }]}>
            <Animated.View
              style={[
                styles.statusDot,
                { backgroundColor: statusColor, shadowColor: statusColor },
                status === 'running' && {
                  opacity: dotPulse.interpolate({ inputRange: [0, 1], outputRange: [0.6, 1] }),
                  transform: [
                    {
                      scale: dotPulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.6] }),
                    },
                  ],
                },
              ]}
            />
            <Text style={[styles.statusText, { color: statusColor }]}>
              {status.toUpperCase()}
            </Text>
          </View>
          {currentCheckpoint ? (
            <Text style={styles.statusCheckpoint} numberOfLines={1}>
              · {currentCheckpoint}
            </Text>
          ) : null}
          <View style={{ flex: 1 }} />
          {typeof (liveStatus?.progress ?? agent.progress) === 'number'
            && (liveStatus?.progress ?? agent.progress) > 0 ? (
            <Text style={[styles.statusPct, { color: statusColor }]}>
              {Math.round(liveStatus?.progress ?? agent.progress)}%
            </Text>
          ) : null}
        </View>

        {typeof (liveStatus?.progress ?? agent.progress) === 'number'
          && (liveStatus?.progress ?? agent.progress) > 0 ? (
          <ProgressBar
            value={liveStatus?.progress ?? agent.progress}
            color={statusColor}
          />
        ) : null}

        {/* Scrollable body */}
        <ScrollView
          style={styles.body}
          contentContainerStyle={{ paddingBottom: insetBottom + SPACING.lg }}
          showsVerticalScrollIndicator={false}
        >
          {/* ── IDENTITY ── */}
          <SectionLabel icon="finger-print-outline" text="IDENTITY" />
          {runId ? (
            <MetaRow label="Run ID" value={truncMiddle(runId, 8, 8)} mono copyable />
          ) : null}
          {sessionKey && sessionKey !== runId ? (
            <MetaRow label="Session" value={truncMiddle(sessionKey, 8, 8)} mono copyable />
          ) : null}
          {createdAt ? (
            <MetaRow
              label="Spawned"
              value={`${fmtRel(createdAt)}  •  ${fmtAbs(createdAt)}`}
            />
          ) : null}
          {coderBackend ? (
            <MetaRow label="Backend" value={String(coderBackend)} mono />
          ) : null}
          {respawnOf ? (
            <MetaRow label="Respawn of" value={truncMiddle(respawnOf, 6, 6)} mono copyable />
          ) : null}
          {kanbanTaskId ? (
            <MetaRow
              label="Kanban task"
              value={truncMiddle(kanbanTaskId, 6, 6)}
              mono
              onPress={handleOpenKanban}
              rightIcon="open-outline"
            />
          ) : null}

          {/* ── CURRENT ACTIVITY ── */}
          <SectionLabel icon="pulse-outline" text="CURRENT ACTIVITY" />
          {taskText ? (
            <View style={styles.taskBlock}>
              <Text style={styles.taskLabel}>TASK</Text>
              <Text style={styles.taskText} numberOfLines={expanded ? 6 : 3}>
                {taskText}
              </Text>
            </View>
          ) : null}
          {currentStepText ? (
            <View style={styles.stepRow}>
              <View style={[styles.stepDot, { backgroundColor: statusColor }]} />
              <Text style={styles.stepText} numberOfLines={2}>
                {currentStepText}
              </Text>
            </View>
          ) : null}

          {/* Transcript preview */}
          <View style={styles.transcriptBlock}>
            <View style={styles.transcriptHeader}>
              <Ionicons name="terminal-outline" size={11} color={COLORS.textMuted} />
              <Text style={styles.transcriptLabel}>TRANSCRIPT · live</Text>
              <View style={{ flex: 1 }} />
              {transcriptLoading && transcript.length === 0 ? (
                <Text style={styles.transcriptMuted}>loading…</Text>
              ) : null}
            </View>
            <View style={styles.transcriptInner}>
              {transcript.length === 0 ? (
                <Text style={styles.transcriptEmpty}>
                  {transcriptLoading ? '…' : 'No messages yet.'}
                </Text>
              ) : (
                transcript.slice(expanded ? -8 : -4).map((ln, i) => {
                  const isUser = ln.role === 'user';
                  const isSystem = ln.role === 'system';
                  const tint = isUser
                    ? COLORS.primary
                    : isSystem
                      ? COLORS.textMuted
                      : '#22D3EE';
                  const prefix = isUser ? '›' : isSystem ? '·' : '◆';
                  return (
                    <Text
                      key={i}
                      style={styles.transcriptLine}
                      numberOfLines={expanded ? 4 : 2}
                    >
                      <Text style={{ color: tint }}>{prefix}  </Text>
                      <Text style={styles.transcriptBody}>{ln.text}</Text>
                    </Text>
                  );
                })
              )}
            </View>
            <TouchableOpacity
              onPress={handleOpenActivity}
              activeOpacity={0.7}
              style={styles.openActivityBtn}
              hitSlop={6}
            >
              <Text style={styles.openActivityText}>Open full activity</Text>
              <Ionicons name="arrow-forward" size={11} color={COLORS.primary} />
            </TouchableOpacity>
          </View>

          {/* ── CLOSEOUT ── (finished runs only: what got done + final summary) */}
          {isFinished ? (
            <>
              <SectionLabel icon="checkmark-done-circle-outline" text="CLOSEOUT" />
              <View style={styles.closeoutCard}>
                <View style={styles.closeoutStatusRow}>
                  <View style={[styles.closeoutBadge, { borderColor: statusColor }]}>
                    <Text style={[styles.closeoutBadgeText, { color: statusColor }]}>
                      {status === 'error' ? 'FAILED' : status === 'completed' ? 'SUCCESS' : 'DONE'}
                    </Text>
                  </View>
                  {closeoutDuration ? (
                    <Text style={styles.closeoutMeta}>{closeoutDuration}</Text>
                  ) : null}
                  {detailFilesCount ? (
                    <Text style={styles.closeoutMeta}>{detailFilesCount} files</Text>
                  ) : null}
                  {coderBackend ? (
                    <Text style={styles.closeoutMeta}>{String(coderBackend)}</Text>
                  ) : null}
                </View>
                {closeout.outcomeError ? (
                  <Text style={styles.closeoutError} numberOfLines={2}>
                    {closeout.outcomeError}
                  </Text>
                ) : null}
                {closeout.headline ? (
                  <Text style={styles.closeoutHeadline} numberOfLines={4}>
                    {closeout.headline}
                  </Text>
                ) : (
                  <Text style={styles.emptyHint}>
                    No closeout summary was captured for this run.
                  </Text>
                )}
                {closeout.deferred.length > 0 ? (
                  <View style={styles.closeoutBullets}>
                    {closeout.deferred.map((b, i) => (
                      <Text key={`d${i}`} style={styles.closeoutBullet} numberOfLines={2}>
                        <Text style={{ color: '#F59E0B' }}>⟳  </Text>
                        {b}
                      </Text>
                    ))}
                  </View>
                ) : null}
                {closeout.next.length > 0 ? (
                  <View style={styles.closeoutBullets}>
                    {closeout.next.map((b, i) => (
                      <Text key={`n${i}`} style={styles.closeoutBullet} numberOfLines={2}>
                        <Text style={{ color: COLORS.primary }}>→  </Text>
                        {b}
                      </Text>
                    ))}
                  </View>
                ) : null}
              </View>

              {/* ── PROPOSED COMMIT ── (proactive Finish / Reject / Schedule) */}
              {runDetail?.run?.workdir ? (
                <>
                  <SectionLabel icon="git-commit-outline" text="PROPOSED COMMIT" />
                  <CommitProposalCard
                    gateway={gateway}
                    workdir={runDetail.run.workdir}
                    runId={runId}
                    kanbanTaskId={kanbanTaskId}
                    suggestedMessage={
                      (closeout.headline && closeout.headline.trim())
                      || (taskText ? String(taskText).split('\n')[0].slice(0, 100).trim() : '')
                      || 'Agent changes'
                    }
                  />
                </>
              ) : null}
            </>
          ) : null}

          {/* ── CONTENT PAGES ── (sourced from subagents.detail; graceful empty) */}
          <SectionLabel icon="document-text-outline" text="CONTENT PAGES" />
          {contentPages.length === 0 ? (
            <Text style={styles.emptyHint}>No content pages linked to this agent.</Text>
          ) : (
            contentPages.map((p) => (
              <ContentPageRow
                key={p.id}
                page={p}
                onPress={() => handleOpenContentPage(p)}
              />
            ))
          )}

          {/* ── FILES TOUCHED ── (linked list, not a bare count) */}
          <SectionLabel icon="git-commit-outline" text="FILES TOUCHED" />
          <FilesTouchedList
            files={detailFiles}
            totalCount={detailFilesCount}
            gateway={gateway}
            runId={runId}
          />

          {/* ── RESOURCES ── (checkpoints only; files now have their own list) */}
          {checkpoints.length > 0 ? (
            <>
              <SectionLabel icon="layers-outline" text="RESOURCES" />
              <MetaRow
                label="Checkpoints"
                value={`${checkpoints.length}${currentCheckpoint ? `  •  on ${currentCheckpoint}` : ''}`}
              />
            </>
          ) : null}

          {/* ── FEDERATION ── */}
          <SectionLabel icon="git-network-outline" text="FEDERATION" />
          <View style={styles.federationRow}>
            <MaterialCommunityIcons
              name={nodeRecord?.isLocal || agent.nodeId === 'local' ? 'desktop-tower' : 'server-network'}
              size={14}
              color={COLORS.text}
            />
            <Text style={styles.federationNode} numberOfLines={1}>{nodeName}</Text>
            <View style={[styles.federationDot, { backgroundColor: nodeReachColor }]} />
            <Text style={[styles.federationStatus, { color: nodeReachColor }]}>
              {nodeOnline ? 'LIVE' : (nodeRecord?.status === 'connecting' ? 'STALE' : 'OFFLINE')}
            </Text>
          </View>
          {lastUpdateTs ? (
            <MetaRow label="Last update" value={`${fmtRel(lastUpdateTs)}  •  ${fmtAbs(lastUpdateTs)}`} />
          ) : null}

          {/* spacer */}
          <View style={{ height: SPACING.md }} />
        </ScrollView>

        {/* Sticky action row */}
        <View style={styles.actionRow}>
          <ActionChip
            icon="terminal-outline"
            label="Logs"
            onPress={() => onOpenMore?.(agent)}
          />
          <ActionChip
            icon="chatbubble-ellipses-outline"
            label="Chat"
            onPress={handleOpenChat}
          />
          {agent.runId ? (
            <ActionChip
              icon="refresh"
              label="Respawn"
              tone="warn"
              onPress={handleRespawn}
            />
          ) : null}
          <ActionChip
            icon="stop-circle-outline"
            label="Stop"
            tone="danger"
            onPress={handleStop}
          />
          <ActionChip
            icon="ellipsis-horizontal"
            label="More"
            onPress={() => onOpenMore?.(agent)}
          />
        </View>
      </Animated.View>
    </View>
  );
}

// ─── styles ───────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
  },
  blur: {
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    overflow: 'hidden',
  },
  sheet: {
    marginHorizontal: SPACING.sm,
    marginBottom: SPACING.sm,
    paddingHorizontal: SPACING.lg,
    paddingTop: 6,
    paddingBottom: SPACING.sm,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    borderBottomLeftRadius: 20,
    borderBottomRightRadius: 20,
    backgroundColor: 'rgba(10,10,16,0.82)',
    borderWidth: 1,
    shadowOffset: { width: 0, height: 0 },
    shadowRadius: 16,
    elevation: 14,
    overflow: 'hidden',
  },

  // Grip
  gripWrap: {
    alignItems: 'center',
    paddingVertical: 6,
    marginBottom: 2,
  },
  grip: {
    width: 44,
    height: 4,
    borderRadius: 2,
    backgroundColor: 'rgba(255,255,255,0.22)',
  },

  // Header
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.md,
    marginBottom: SPACING.md,
  },
  headerIcon: {
    width: 42,
    height: 42,
    borderRadius: 13,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    shadowOffset: { width: 0, height: 0 },
  },
  headerBtn: {
    width: 30,
    height: 30,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 10,
  },
  title: {
    ...FONTS.heading,
    fontSize: 17,
    color: COLORS.text,
  },
  subtitle: {
    ...FONTS.tiny,
    color: COLORS.textMuted,
    marginTop: 2,
    letterSpacing: 0.4,
  },

  // Status strip
  statusStrip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 6,
  },
  statusPill: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 9,
    paddingVertical: 3,
    borderRadius: 999,
    borderWidth: 1,
    gap: 6,
  },
  statusDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    shadowOpacity: 0.9,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 0 },
  },
  statusText: {
    ...FONTS.tiny,
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 0.8,
  },
  statusCheckpoint: {
    ...FONTS.tiny,
    color: COLORS.textMuted,
    fontSize: 10,
    flexShrink: 1,
  },
  statusPct: {
    ...FONTS.tiny,
    fontSize: 11,
    fontWeight: '700',
  },

  // Progress
  progressTrack: {
    height: 3,
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderRadius: 2,
    overflow: 'hidden',
    marginTop: 4,
    marginBottom: SPACING.sm,
  },
  progressFill: {
    height: 3,
    borderRadius: 2,
  },

  // Body
  body: {
    flex: 1,
  },

  // Sections
  sectionLabelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    marginTop: SPACING.md,
    marginBottom: 4,
  },
  sectionLabel: {
    ...FONTS.tiny,
    color: COLORS.textMuted,
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 1.3,
    textTransform: 'uppercase',
  },
  sectionLabelRule: {
    flex: 1,
    height: 1,
    backgroundColor: 'rgba(255,255,255,0.06)',
    marginLeft: 4,
  },

  // Meta rows
  metaRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 5,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.04)',
    gap: SPACING.sm,
  },
  metaLabel: {
    ...FONTS.tiny,
    color: COLORS.textMuted,
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    minWidth: 86,
  },
  metaValueWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
    justifyContent: 'flex-end',
  },
  metaValue: {
    ...FONTS.small,
    color: COLORS.text,
    textAlign: 'right',
  },
  metaValueMono: {
    fontFamily: MONO,
    fontSize: 11,
    letterSpacing: 0.2,
  },
  copiedTag: {
    ...FONTS.tiny,
    fontSize: 9,
    color: COLORS.primary,
    marginLeft: 6,
    letterSpacing: 0.6,
  },

  // Task
  taskBlock: {
    backgroundColor: 'rgba(255,255,255,0.03)',
    borderRadius: 10,
    padding: 10,
    marginTop: 4,
  },

  closeoutCard: {
    backgroundColor: 'rgba(255,255,255,0.03)',
    borderRadius: 10,
    padding: 10,
    marginTop: 4,
    gap: 8,
  },
  commitCard: {
    backgroundColor: 'rgba(34,197,94,0.06)',
    borderColor: 'rgba(34,197,94,0.28)',
    borderWidth: 1,
    borderRadius: 10,
    padding: 10,
    marginTop: 4,
    gap: 8,
  },
  commitMetaRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 10 },
  commitBranch: {
    fontSize: 11, fontWeight: '600', color: COLORS.text,
    backgroundColor: 'rgba(255,255,255,0.06)', paddingHorizontal: 7, paddingVertical: 2, borderRadius: 4,
  },
  commitStat: { fontSize: 11, color: COLORS.textMuted },
  commitInput: {
    color: COLORS.text, fontSize: 12, minHeight: 38, maxHeight: 90,
    backgroundColor: 'rgba(0,0,0,0.30)', borderColor: 'rgba(255,255,255,0.14)', borderWidth: 1,
    borderRadius: 6, paddingHorizontal: 9, paddingVertical: 7, textAlignVertical: 'top',
  },
  commitActions: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8 },
  commitFinishBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: '#16A34A', paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8,
  },
  commitFinishText: { color: '#fff', fontSize: 12, fontWeight: '700' },
  commitSchedule: { fontSize: 11, color: COLORS.textMuted, textDecorationLine: 'underline' },
  commitEmptyRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  commitEmptyText: { flex: 1, fontSize: 12, color: COLORS.textMuted },
  commitDone: { fontSize: 12, fontWeight: '600' },
  closeoutStatusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 8,
  },
  closeoutBadge: {
    borderWidth: 1,
    borderRadius: 4,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  closeoutBadgeText: {
    ...FONTS.tiny,
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 1,
  },
  closeoutMeta: {
    ...FONTS.tiny,
    color: COLORS.textMuted,
    fontSize: 10,
  },
  closeoutError: {
    ...FONTS.small,
    color: '#FCA5A5',
    lineHeight: 16,
  },
  closeoutHeadline: {
    ...FONTS.small,
    color: COLORS.text,
    lineHeight: 18,
  },
  closeoutBullets: {
    gap: 4,
  },
  closeoutBullet: {
    ...FONTS.small,
    color: COLORS.text,
    lineHeight: 17,
  },
  taskLabel: {
    ...FONTS.tiny,
    color: COLORS.textMuted,
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 1,
    marginBottom: 4,
  },
  taskText: {
    ...FONTS.small,
    color: COLORS.text,
    lineHeight: 18,
  },

  stepRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 8,
  },
  stepDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  stepText: {
    ...FONTS.small,
    color: COLORS.text,
    flex: 1,
  },

  // Transcript
  transcriptBlock: {
    marginTop: 10,
    backgroundColor: 'rgba(0,0,0,0.45)',
    borderRadius: 10,
    padding: 10,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.05)',
  },
  transcriptHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 6,
  },
  transcriptLabel: {
    ...FONTS.tiny,
    fontSize: 9,
    color: COLORS.textMuted,
    letterSpacing: 1.2,
    fontWeight: '700',
  },
  transcriptMuted: {
    ...FONTS.tiny,
    fontSize: 9,
    color: COLORS.textMuted,
    fontStyle: 'italic',
  },
  transcriptInner: {
    gap: 4,
  },
  transcriptEmpty: {
    ...FONTS.tiny,
    color: COLORS.textMuted,
    fontFamily: MONO,
    fontSize: 11,
    paddingVertical: 6,
    textAlign: 'center',
  },
  transcriptLine: {
    fontFamily: MONO,
    fontSize: 11,
    lineHeight: 15,
  },
  transcriptBody: {
    color: COLORS.text,
  },
  openActivityBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 4,
    marginTop: 8,
    paddingTop: 6,
    borderTopWidth: 1,
    borderTopColor: 'rgba(255,255,255,0.05)',
  },
  openActivityText: {
    ...FONTS.tiny,
    color: COLORS.primary,
    fontWeight: '700',
    letterSpacing: 0.4,
  },

  // Federation
  federationRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.04)',
  },
  federationNode: {
    ...FONTS.small,
    color: COLORS.text,
    flexShrink: 1,
  },
  federationDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    marginLeft: 4,
  },
  federationStatus: {
    ...FONTS.tiny,
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 0.8,
  },

  // Files touched + content pages
  emptyHint: {
    ...FONTS.tiny,
    color: COLORS.textMuted,
    fontStyle: 'italic',
    paddingVertical: 6,
  },
  fileBadgesRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 5,
    marginTop: 4,
    marginBottom: 6,
  },
  fileBadge: {
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 6,
    borderWidth: 1,
  },
  fileBadgeText: {
    ...FONTS.tiny,
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 0.6,
  },
  fileRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 4,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.04)',
  },
  fileActLetter: {
    ...FONTS.tiny,
    fontFamily: MONO,
    fontSize: 11,
    fontWeight: '700',
    width: 12,
    textAlign: 'center',
  },
  fileDir: {
    ...FONTS.tiny,
    fontSize: 9,
    color: COLORS.textMuted,
  },
  fileBase: {
    ...FONTS.small,
    fontFamily: MONO,
    fontSize: 11,
    color: COLORS.text,
  },
  riskDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: '#F59E0B',
    marginRight: 2,
  },
  fileToggleBtn: {
    paddingVertical: 6,
    alignItems: 'flex-start',
  },

  // File-diff modal
  fdBackdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  fdSheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: Math.round(SCREEN_HEIGHT * 0.9),
    backgroundColor: 'rgba(10,10,16,0.98)',
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    borderTopWidth: 1,
    borderColor: 'rgba(255,255,255,0.10)',
    paddingHorizontal: SPACING.lg,
    paddingBottom: SPACING.lg,
  },
  fdGripWrap: {
    alignItems: 'center',
    paddingVertical: 8,
  },
  fdHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
    paddingBottom: 8,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.06)',
  },
  fdTitle: {
    ...FONTS.heading,
    fontSize: 15,
    color: COLORS.text,
  },
  fdSub: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 8,
    flexWrap: 'wrap',
  },
  fdStat: {
    ...FONTS.tiny,
    fontFamily: MONO,
    fontSize: 12,
    fontWeight: '700',
  },
  fdMuted: {
    ...FONTS.tiny,
    fontSize: 9,
    color: COLORS.textMuted,
    fontStyle: 'italic',
  },
  fdNotice: {
    ...FONTS.tiny,
    color: COLORS.text,
    backgroundColor: 'rgba(129,140,248,0.14)',
    borderWidth: 1,
    borderColor: 'rgba(129,140,248,0.3)',
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 5,
    marginBottom: 6,
  },
  fdBody: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.35)',
    borderRadius: 8,
    marginVertical: 6,
  },
  fdCenter: {
    paddingVertical: 32,
    alignItems: 'center',
  },
  fdLine: {
    fontFamily: MONO,
    fontSize: 11,
    lineHeight: 16,
    paddingHorizontal: 8,
  },
  fdAdd: { color: '#86EFAC', backgroundColor: 'rgba(34,197,94,0.10)' },
  fdDel: { color: '#FCA5A5', backgroundColor: 'rgba(239,68,68,0.10)' },
  fdCtx: { color: COLORS.textMuted },
  fdHunk: { color: '#A5B4FC', backgroundColor: 'rgba(129,140,248,0.10)' },
  fdActions: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: SPACING.sm,
    borderTopWidth: 1,
    borderTopColor: 'rgba(255,255,255,0.06)',
    gap: 6,
  },
  fileToggleText: {
    ...FONTS.tiny,
    color: COLORS.primary,
    fontWeight: '700',
    letterSpacing: 0.4,
  },
  contentRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 7,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.04)',
  },
  contentRowTitle: {
    ...FONTS.small,
    color: COLORS.text,
  },
  contentRowSub: {
    ...FONTS.tiny,
    fontSize: 9,
    color: COLORS.textMuted,
    marginTop: 1,
    letterSpacing: 0.3,
  },

  // Action row
  actionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: SPACING.sm,
    marginTop: 4,
    borderTopWidth: 1,
    borderTopColor: 'rgba(255,255,255,0.06)',
    gap: 6,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: 10,
    borderWidth: 1,
    backgroundColor: 'rgba(255,255,255,0.03)',
    flexShrink: 1,
  },
  chipText: {
    ...FONTS.tiny,
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.4,
  },
});

export default AgentFocusSheet;
