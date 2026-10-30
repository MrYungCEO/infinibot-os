// WorkflowsScreen — list + markdown editor + run / schedule / loop actions.
//
// Mobile-native port of the WebUI workflows view (ui/src/ui/views/workflows.ts)
// plus the workflow-scheduling panel from ui/src/ui/views/schedule.ts. Same
// gateway RPCs so desktop and mobile stay in lockstep:
//   workflows.list / .get / .create / .update / .delete
//   workflows.run.preflight / .run.start / .run.list / .run.cancel
//   workflows.continuous.start / .list / .pause / .resume / .stop
//   cron.list / .remove        (scheduled workflows = cron jobs that run a wf)
//   notion.sync.workflow       (Notion mirror)
//
// Federation: every gateway call goes through `useFederation().invokeOnNode`
// so workflows on a satellite node are reachable from the mobile master.
// invokeOnNode short-circuits to the local gateway when the selected node
// is local.

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
  FlatList,
  TouchableOpacity,
  RefreshControl,
  ActivityIndicator,
  TextInput,
  Modal,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  Animated,
  Alert,
  Linking,
} from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import Swipeable from 'react-native-gesture-handler/ReanimatedSwipeable';
import { SwipeReveal } from '../components/SwipeReveal';
import { Ionicons } from '@expo/vector-icons';
import Markdown from 'react-native-markdown-display';
import { LinearGradient } from 'expo-linear-gradient';
import { BlurView } from 'expo-blur';
import { useTheme } from '../theme/ThemeProvider';
import { SPACING, TYPOGRAPHY, FONT_FAMILY } from '../constants/theme';
import { withAlpha, innerTopHighlight } from '../theme/color-utils';
import { useFederation } from '../hooks/useFederation';

const RECENT_RUNS_LIMIT = 12;
const DAEMON_POLL_MS = 4000;

const CLI_OPTIONS = [
  { value: 'claude', label: 'Claude' },
  { value: 'opencode', label: 'OpenCode' },
  { value: 'gemini', label: 'Gemini' },
  { value: 'codex', label: 'Codex' },
  { value: 'grok', label: 'Grok Build' },
];

const FILTERS = [
  { key: 'all', label: 'All', icon: 'apps-outline' },
  { key: 'static', label: 'One-shot', icon: 'play-outline' },
  { key: 'continuous', label: 'Loops', icon: 'sync-outline' },
  { key: 'running', label: 'Running', icon: 'pulse-outline' },
  { key: 'scheduled', label: 'Scheduled', icon: 'time-outline' },
];

// ── Formatting helpers ──────────────────────────────────────

function fmtRelative(iso) {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const diff = Date.now() - t;
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  return new Date(iso).toLocaleDateString();
}

// Tolerant of both the web cron shape (when / intervalMs) and the mobile
// shape used by CronScreen (atMs / everyMs). Mirrors describeSchedule from
// ui/src/ui/controllers/cron.ts.
function describeSchedule(s) {
  if (!s) return 'Unknown schedule';
  if (s.kind === 'at') {
    const ms = s.atMs ?? (s.when ? new Date(s.when).getTime() : null);
    if (ms) return `Once · ${new Date(ms).toLocaleString()}`;
    return `Once · ${s.when || ''}`;
  }
  if (s.kind === 'every') {
    const ms = s.everyMs ?? s.intervalMs ?? 0;
    const m = Math.round(ms / 60000);
    if (m < 60) return `Every ${m}m`;
    if (m < 60 * 24) return `Every ${Math.round(m / 60)}h`;
    return `Every ${Math.round(m / (60 * 24))}d`;
  }
  if (s.kind === 'cron') {
    return `cron ${s.expr}${s.tz ? ` (${s.tz})` : ''}`;
  }
  return 'Unknown schedule';
}

function fmtNextRun(job) {
  const raw = job?.nextRunAtMs ?? job?.nextRunAt ?? null;
  if (raw == null) return null;
  const ms = typeof raw === 'number' ? raw : new Date(raw).getTime();
  if (Number.isNaN(ms)) return null;
  const diff = ms - Date.now();
  if (diff <= 0) return 'due now';
  const min = Math.round(diff / 60000);
  if (min < 60) return `in ${min}m`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `in ${hr}h`;
  return `in ${Math.round(hr / 24)}d`;
}

const jobId = (j) => j?.jobId || j?.id;

// Group cron jobs by the workflow they reference. Mirrors the web schedule
// panel: an agentTurn cron message of the form `… workflow "name" / id …`.
function buildScheduledMap(jobs) {
  const map = new Map();
  for (const job of jobs || []) {
    const hay = [
      job?.payload?.message,
      job?.payload?.text,
      job?.command,
      job?.name,
      typeof job?.payload === 'string' ? job.payload : '',
    ]
      .filter(Boolean)
      .join(' ');
    if (!hay) continue;
    const m = /workflow[s]?["\s:'\-]+([\w\-./]+)/i.exec(hay);
    const key = (m?.[1] || '').toLowerCase();
    if (!key) continue;
    const arr = map.get(key) || [];
    arr.push(job);
    map.set(key, arr);
  }
  return map;
}

function linkedJobsFor(wf, scheduledMap) {
  if (!wf) return [];
  return (
    scheduledMap.get((wf.name || '').toLowerCase()) ||
    scheduledMap.get((wf.id || '').toLowerCase()) ||
    []
  );
}

function statusTint(status, colors) {
  switch (status) {
    case 'completed':
      return colors.success || '#22c55e';
    case 'failed':
    case 'timeout':
      return colors.error || '#ef4444';
    case 'cancelled':
      return colors.textMuted;
    case 'paused':
      return colors.warning || '#f59e0b';
    case 'running':
    case 'pending':
    default:
      return colors.primary;
  }
}

function statusIcon(status) {
  switch (status) {
    case 'completed':
      return 'checkmark-circle';
    case 'failed':
    case 'timeout':
      return 'alert-circle';
    case 'cancelled':
      return 'close-circle';
    case 'paused':
      return 'pause-circle';
    case 'running':
      return 'sync';
    case 'pending':
    default:
      return 'ellipse';
  }
}

function humanize(s) {
  if (!s) return '';
  return s.replace(/[_-]+/g, ' ').replace(/\b([a-z])/g, (m) => m.toUpperCase());
}

// ── List item (with swipe actions) ──────────────────────────

function WorkflowListItem({
  workflow,
  onPress,
  onRun,
  onSchedule,
  index,
  colors,
  styles: s,
  scheduledCount,
  isRunning,
}) {
  const fade = useRef(new Animated.Value(0)).current;
  const swipeRef = useRef(null);
  useEffect(() => {
    Animated.timing(fade, {
      toValue: 1,
      duration: 260,
      delay: Math.min(index * 40, 240),
      useNativeDriver: true,
    }).start();
  }, []);

  const isContinuous = workflow.kind === 'continuous';
  const tint = isContinuous ? colors.warning || '#f59e0b' : colors.primary;

  const renderRightActions = (progress) => (
    <SwipeReveal value={progress} style={s.swipeActions}>
      <TouchableOpacity
        style={[s.swipeAction, { backgroundColor: withAlpha(tint, 0.9) }]}
        onPress={() => {
          swipeRef.current?.close?.();
          onRun(workflow);
        }}
      >
        <Ionicons
          name={isContinuous ? 'infinite' : 'play'}
          size={18}
          color={colors.background || '#000'}
        />
        <Text style={[s.swipeActionText, { color: colors.background || '#000' }]}>
          {isContinuous ? 'Loop' : 'Run'}
        </Text>
      </TouchableOpacity>
      <TouchableOpacity
        style={[s.swipeAction, { backgroundColor: withAlpha(colors.accent, 0.9) }]}
        onPress={() => {
          swipeRef.current?.close?.();
          onSchedule(workflow);
        }}
      >
        <Ionicons name="time" size={18} color={colors.background || '#000'} />
        <Text style={[s.swipeActionText, { color: colors.background || '#000' }]}>
          Sched
        </Text>
      </TouchableOpacity>
    </SwipeReveal>
  );

  return (
    <Animated.View style={{ opacity: fade }}>
      <Swipeable
        ref={swipeRef}
        renderRightActions={renderRightActions}
        overshootRight={false}
        friction={2}
      >
        <TouchableOpacity
          style={s.workflowCard}
          onPress={() => onPress(workflow)}
          activeOpacity={0.85}
        >
          <LinearGradient
            colors={[
              withAlpha(tint, 0.14),
              withAlpha(tint, 0.02),
              'rgba(0,0,0,0.25)',
            ]}
            start={{ x: 0, y: 0 }}
            end={{ x: 0, y: 1 }}
            style={StyleSheet.absoluteFill}
          />
          <View style={[s.workflowCardBorder, { backgroundColor: tint }]} />
          <View style={s.workflowCardContent}>
            <View style={s.workflowCardHeaderRow}>
              <View style={s.workflowCardTitleRow}>
                <Ionicons
                  name={isContinuous ? 'sync-circle' : 'play-circle'}
                  size={14}
                  color={tint}
                  style={{ marginRight: 6 }}
                />
                <Text style={s.workflowCardTitle} numberOfLines={1}>
                  {workflow.name || '(untitled)'}
                </Text>
                {isRunning ? (
                  <View style={s.liveDot}>
                    <View
                      style={[s.liveDotInner, { backgroundColor: colors.success || '#22c55e' }]}
                    />
                  </View>
                ) : null}
              </View>
              <Text style={s.workflowCardDate}>
                {workflow.updatedAt ? fmtRelative(workflow.updatedAt) : ''}
              </Text>
            </View>

            {workflow.description ? (
              <Text style={s.workflowCardDesc} numberOfLines={2}>
                {workflow.description}
              </Text>
            ) : null}

            <View style={s.workflowCardFooter}>
              {isContinuous ? (
                <View
                  style={[
                    s.workflowBadge,
                    {
                      backgroundColor: withAlpha(tint, 0.14),
                      borderColor: withAlpha(tint, 0.4),
                    },
                  ]}
                >
                  <Text style={[s.workflowBadgeText, { color: tint }]}>LOOP</Text>
                </View>
              ) : null}
              {scheduledCount > 0 ? (
                <View
                  style={[
                    s.workflowBadge,
                    {
                      backgroundColor: withAlpha(colors.accent, 0.14),
                      borderColor: withAlpha(colors.accent, 0.4),
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: 3,
                    },
                  ]}
                >
                  <Ionicons name="time" size={9} color={colors.accent} />
                  <Text style={[s.workflowBadgeText, { color: colors.accent }]}>
                    {scheduledCount}
                  </Text>
                </View>
              ) : null}
              {workflow.notionPageId ? (
                <Ionicons
                  name="document-text-outline"
                  size={12}
                  color={colors.textMuted}
                />
              ) : null}
              {workflow.tags?.slice(0, 2).map((t) => (
                <View
                  key={t}
                  style={[
                    s.workflowBadge,
                    {
                      backgroundColor: withAlpha(colors.accent, 0.12),
                      borderColor: withAlpha(colors.accent, 0.3),
                    },
                  ]}
                >
                  <Text style={[s.workflowBadgeText, { color: colors.accent }]}>
                    {t}
                  </Text>
                </View>
              ))}
              {typeof workflow.bodyLength === 'number' ? (
                <Text style={s.workflowMeta}>
                  {(workflow.bodyLength / 1000).toFixed(1)}k chars
                </Text>
              ) : null}
            </View>
          </View>
        </TouchableOpacity>
      </Swipeable>
    </Animated.View>
  );
}

export function WorkflowsScreen({ gateway, navigation, route }) {
  const { colors } = useTheme();
  const { status } = gateway || {};
  const isConnected = status === 'connected';
  const federation = useFederation(gateway);
  const { invokeOnNode, selectedNode, selectedNodeId } = federation;

  const initialCollection = route?.params?.collection || null;
  const initialQuery = route?.params?.query || '';

  const [workflows, setWorkflows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const [searchQuery, setSearchQuery] = useState(initialQuery);
  const [filter, setFilter] = useState('all');

  // Live continuous daemons + scheduled cron jobs
  const [daemons, setDaemons] = useState([]);
  const [cronJobs, setCronJobs] = useState([]);

  // Editor / detail modal
  const [editorVisible, setEditorVisible] = useState(false);
  const [editorWorkflow, setEditorWorkflow] = useState(null);
  const [editorName, setEditorName] = useState('');
  const [editorDescription, setEditorDescription] = useState('');
  const [editorBody, setEditorBody] = useState('');
  const [editorTags, setEditorTags] = useState('');
  const [editorTab, setEditorTab] = useState('edit'); // edit|preview|settings|runs|sched
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [recentRuns, setRecentRuns] = useState([]);
  const [previewBody, setPreviewBody] = useState('');
  const [notionSyncing, setNotionSyncing] = useState(false);

  // Run dialog
  const [runVisible, setRunVisible] = useState(false);
  const [runWorkflow, setRunWorkflow] = useState(null);
  const [runInputs, setRunInputs] = useState({});
  const [runPreflight, setRunPreflight] = useState(null);
  const [runPreflightInFlight, setRunPreflightInFlight] = useState(false);
  const [runStarting, setRunStarting] = useState(false);
  const [runError, setRunError] = useState(null);
  const [runExecMode, setRunExecMode] = useState('gateway'); // gateway|terminal
  const [runCli, setRunCli] = useState('claude');
  const [runCwd, setRunCwd] = useState('');

  const fadeAnim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(fadeAnim, {
      toValue: 1,
      duration: 280,
      useNativeDriver: true,
    }).start();
  }, []);

  // Debounced preview so each keystroke doesn't re-render the markdown tree.
  useEffect(() => {
    const id = setTimeout(() => setPreviewBody(editorBody), 200);
    return () => clearTimeout(id);
  }, [editorBody]);

  const loadWorkflows = useCallback(async () => {
    if (!invokeOnNode || !isConnected) return;
    setLoading(true);
    setError(null);
    try {
      const res = await invokeOnNode('workflows.list', {
        query: searchQuery || undefined,
      });
      let list = res?.workflows ?? [];
      if (initialCollection === 'continuous') {
        list = list.filter((w) => w.kind === 'continuous');
      } else if (initialCollection === 'static') {
        list = list.filter((w) => w.kind !== 'continuous');
      }
      setWorkflows(list);
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setLoading(false);
    }
  }, [invokeOnNode, isConnected, searchQuery, initialCollection]);

  const loadDaemons = useCallback(async () => {
    if (!invokeOnNode || !isConnected) return;
    try {
      const res = await invokeOnNode('workflows.continuous.list', {});
      setDaemons(res?.daemons ?? []);
    } catch {
      /* non-fatal — daemon list is best-effort */
    }
  }, [invokeOnNode, isConnected]);

  const loadCronJobs = useCallback(async () => {
    if (!invokeOnNode || !isConnected) return;
    try {
      const res = await invokeOnNode('cron.list', { includeDisabled: true });
      const jobs = Array.isArray(res) ? res : res?.jobs ?? [];
      setCronJobs(jobs);
    } catch {
      /* non-fatal — cron may be unavailable on satellite */
    }
  }, [invokeOnNode, isConnected]);

  useEffect(() => {
    if (isConnected) {
      loadWorkflows();
      loadDaemons();
      loadCronJobs();
    }
  }, [isConnected, selectedNodeId]);

  // Poll live daemons so running loops stay fresh.
  useEffect(() => {
    if (!isConnected) return undefined;
    const t = setInterval(loadDaemons, DAEMON_POLL_MS);
    return () => clearInterval(t);
  }, [isConnected, loadDaemons]);

  useEffect(() => {
    if (!isConnected) return undefined;
    const timer = setTimeout(() => loadWorkflows(), 300);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await Promise.all([loadWorkflows(), loadDaemons(), loadCronJobs()]);
    setRefreshing(false);
  }, [loadWorkflows, loadDaemons, loadCronJobs]);

  const scheduledMap = useMemo(() => buildScheduledMap(cronJobs), [cronJobs]);
  const runningIds = useMemo(
    () => new Set((daemons || []).filter((d) => !d.stopped).map((d) => d.workflowId)),
    [daemons],
  );

  const filteredWorkflows = useMemo(() => {
    switch (filter) {
      case 'static':
        return workflows.filter((w) => w.kind !== 'continuous');
      case 'continuous':
        return workflows.filter((w) => w.kind === 'continuous');
      case 'running':
        return workflows.filter((w) => runningIds.has(w.id));
      case 'scheduled':
        return workflows.filter((w) => linkedJobsFor(w, scheduledMap).length > 0);
      default:
        return workflows;
    }
  }, [workflows, filter, runningIds, scheduledMap]);

  const loadRecentRuns = useCallback(
    async (workflowId_) => {
      if (!invokeOnNode || !workflowId_) return;
      try {
        const res = await invokeOnNode('workflows.run.list', {
          workflowId: workflowId_,
          limit: RECENT_RUNS_LIMIT,
        });
        setRecentRuns(res?.runs ?? []);
      } catch {
        setRecentRuns([]);
      }
    },
    [invokeOnNode],
  );

  const openWorkflow = useCallback(
    async (wf) => {
      if (!invokeOnNode) return;
      try {
        const full = await invokeOnNode('workflows.get', { id: wf.id });
        setEditorWorkflow(full);
        setEditorName(full.name || '');
        setEditorDescription(full.description || '');
        setEditorBody(full.body || '');
        setEditorTags(full.tags?.join(', ') || '');
        setPreviewBody(full.body || '');
        setDirty(false);
        setIsCreating(false);
        setEditorTab(full.body ? 'preview' : 'edit');
        setEditorVisible(true);
        loadRecentRuns(full.id);
        loadCronJobs();
      } catch (err) {
        setError(err?.message || String(err));
      }
    },
    [invokeOnNode, loadRecentRuns, loadCronJobs],
  );

  const startCreate = useCallback(() => {
    const tpl = '# New Workflow\n\n## Steps\n\n1. \n2. \n3. \n';
    setEditorWorkflow(null);
    setEditorName('');
    setEditorDescription('');
    setEditorBody(tpl);
    setEditorTags('');
    setPreviewBody(tpl);
    setDirty(true);
    setIsCreating(true);
    setRecentRuns([]);
    setEditorTab('edit');
    setEditorVisible(true);
  }, []);

  const closeEditor = useCallback(() => {
    if (dirty) {
      Alert.alert('Discard changes?', 'You have unsaved edits to this workflow.', [
        { text: 'Keep editing', style: 'cancel' },
        {
          text: 'Discard',
          style: 'destructive',
          onPress: () => {
            setDirty(false);
            setEditorVisible(false);
          },
        },
      ]);
      return;
    }
    setEditorVisible(false);
  }, [dirty]);

  const handleSave = useCallback(async () => {
    if (!invokeOnNode || !editorName.trim()) return;
    setSaving(true);
    try {
      const tags = editorTags
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);
      const payload = {
        name: editorName.trim(),
        description: editorDescription.trim() || undefined,
        body: editorBody,
        tags: tags.length ? tags : undefined,
      };
      let saved;
      if (isCreating) {
        saved = await invokeOnNode('workflows.create', payload);
        setIsCreating(false);
      } else {
        saved = await invokeOnNode('workflows.update', {
          id: editorWorkflow.id,
          ...payload,
        });
      }
      if (saved?.id) {
        const full = await invokeOnNode('workflows.get', { id: saved.id });
        setEditorWorkflow(full);
      }
      setDirty(false);
      loadWorkflows();
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setSaving(false);
    }
  }, [
    invokeOnNode,
    editorName,
    editorDescription,
    editorBody,
    editorTags,
    isCreating,
    editorWorkflow,
    loadWorkflows,
  ]);

  const handleDelete = useCallback(() => {
    if (!editorWorkflow) return;
    Alert.alert(
      'Delete workflow?',
      `"${editorWorkflow.name}" will be removed permanently.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            try {
              await invokeOnNode('workflows.delete', { id: editorWorkflow.id });
              setEditorVisible(false);
              setDirty(false);
              loadWorkflows();
            } catch (err) {
              setError(err?.message || String(err));
            }
          },
        },
      ],
    );
  }, [invokeOnNode, editorWorkflow, loadWorkflows]);

  // ── Notion sync ────────────────────────────────────────────
  const handleNotionSync = useCallback(async () => {
    if (!invokeOnNode || !editorWorkflow) return;
    setNotionSyncing(true);
    try {
      const res = await invokeOnNode('notion.sync.workflow', {
        workflowId: editorWorkflow.id,
        name: editorWorkflow.name,
        description: editorWorkflow.description || '',
        tags: editorWorkflow.tags || [],
        body: editorBody,
        notionPageId: editorWorkflow.notionPageId || undefined,
      });
      const full = await invokeOnNode('workflows.get', { id: editorWorkflow.id });
      setEditorWorkflow(full);
      if (res?.notionPageId || full?.notionPageId) {
        Alert.alert('Notion', 'Workflow synced to Notion.');
      }
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setNotionSyncing(false);
    }
  }, [invokeOnNode, editorWorkflow, editorBody]);

  const openNotion = useCallback((pageId) => {
    if (!pageId) return;
    const clean = String(pageId).replace(/-/g, '');
    Linking.openURL(`https://www.notion.so/${clean}`).catch(() => {});
  }, []);

  // ── Run dialog ─────────────────────────────────────────────
  const applyDefaults = useCallback((wf) => {
    const out = {};
    for (const def of wf?.inputs ?? []) {
      if (def.default !== undefined) out[def.name] = def.default;
    }
    return out;
  }, []);

  const runPreflightCheck = useCallback(
    async (wf, inputs) => {
      if (!invokeOnNode || !wf) return;
      setRunPreflightInFlight(true);
      try {
        const res = await invokeOnNode('workflows.run.preflight', {
          id: wf.id,
          inputs,
        });
        setRunPreflight(res);
        setRunError(null);
      } catch (err) {
        setRunError(err?.message || String(err));
      } finally {
        setRunPreflightInFlight(false);
      }
    },
    [invokeOnNode],
  );

  // Open the run dialog for a given full workflow (from editor or swipe).
  const openRunDialogFor = useCallback(
    (wf) => {
      if (!wf) return;
      const inputs = applyDefaults(wf);
      setRunWorkflow(wf);
      setRunInputs(inputs);
      setRunPreflight(null);
      setRunError(null);
      setRunExecMode('gateway');
      setRunCli('claude');
      setRunCwd('');
      setRunVisible(true);
      runPreflightCheck(wf, inputs);
    },
    [applyDefaults, runPreflightCheck],
  );

  const openRunDialog = useCallback(() => {
    openRunDialogFor(editorWorkflow);
  }, [editorWorkflow, openRunDialogFor]);

  // Swipe-to-run from the list: fetch full workflow, then open run dialog.
  const quickRun = useCallback(
    async (wf) => {
      if (!invokeOnNode) return;
      try {
        const full = await invokeOnNode('workflows.get', { id: wf.id });
        openRunDialogFor(full);
      } catch (err) {
        setError(err?.message || String(err));
      }
    },
    [invokeOnNode, openRunDialogFor],
  );

  const setRunInput = useCallback(
    (name, value) => {
      setRunInputs((prev) => {
        const next = { ...prev, [name]: value };
        if (runWorkflow) {
          clearTimeout(setRunInput._t);
          setRunInput._t = setTimeout(
            () => runPreflightCheck(runWorkflow, next),
            350,
          );
        }
        return next;
      });
    },
    [runWorkflow, runPreflightCheck],
  );

  const startRun = useCallback(async () => {
    if (!runWorkflow || !invokeOnNode) return;
    setRunStarting(true);
    setRunError(null);
    try {
      const isContinuous = runWorkflow.kind === 'continuous';
      const method = isContinuous
        ? 'workflows.continuous.start'
        : 'workflows.run.start';
      const params = {
        id: runWorkflow.id,
        inputs: runInputs,
        executionMode: runExecMode,
      };
      if (runExecMode === 'terminal') {
        params.cli = runCli;
        if (runCwd.trim()) params.cwd = runCwd.trim();
      }
      const res = await invokeOnNode(method, params);
      if (res?.run?.status === 'failed') {
        setRunError(res.run.error ?? 'Run failed');
        setRunPreflight(res.preflight ?? null);
      } else {
        setRunVisible(false);
        if (isContinuous) loadDaemons();
        if (editorWorkflow && editorWorkflow.id === runWorkflow.id) {
          loadRecentRuns(editorWorkflow.id);
          setEditorTab('runs');
        }
      }
    } catch (err) {
      setRunError(err?.message || String(err));
    } finally {
      setRunStarting(false);
    }
  }, [
    runWorkflow,
    invokeOnNode,
    runInputs,
    runExecMode,
    runCli,
    runCwd,
    editorWorkflow,
    loadRecentRuns,
    loadDaemons,
  ]);

  const cancelRun = useCallback(
    async (runId) => {
      try {
        await invokeOnNode('workflows.run.cancel', { runId });
        if (editorWorkflow) loadRecentRuns(editorWorkflow.id);
      } catch (err) {
        setError(err?.message || String(err));
      }
    },
    [invokeOnNode, editorWorkflow, loadRecentRuns],
  );

  // ── Continuous daemon controls ─────────────────────────────
  const daemonAction = useCallback(
    async (method, runId) => {
      try {
        await invokeOnNode(method, { runId });
        loadDaemons();
      } catch (err) {
        setError(err?.message || String(err));
      }
    },
    [invokeOnNode, loadDaemons],
  );

  // ── Schedule (cron) ────────────────────────────────────────
  // Hand off to the existing Cron screen, pre-filling the workflow target.
  const openSchedule = useCallback(
    (wf, existingJobId) => {
      const target = wf || editorWorkflow;
      if (!target && !existingJobId) return;
      const parent = navigation?.getParent?.();
      const nav = parent || navigation;
      try {
        nav?.navigate?.('CronModal', {
          gateway,
          jobId: existingJobId,
          workflowId: target?.id,
          workflowName: target?.name,
        });
      } catch {
        Alert.alert(
          'Schedule',
          'Open the Scheduled screen from More to add a cron job for this workflow.',
        );
      }
    },
    [editorWorkflow, navigation, gateway],
  );

  const cancelSchedule = useCallback(
    (job) => {
      const id = jobId(job);
      if (!id) return;
      Alert.alert('Cancel schedule?', `Remove "${job.name || id}"?`, [
        { text: 'Keep', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: async () => {
            try {
              await invokeOnNode('cron.remove', { jobId: id });
              loadCronJobs();
            } catch (err) {
              setError(err?.message || String(err));
            }
          },
        },
      ]);
    },
    [invokeOnNode, loadCronJobs],
  );

  const styles = useMemo(() => makeStyles(colors), [colors]);
  const markdownStyles = useMemo(() => makeMarkdownStyles(colors), [colors]);

  if (!isConnected) {
    return (
      <View style={styles.center}>
        <Ionicons name="cloud-offline-outline" size={36} color={colors.textMuted} />
        <Text style={styles.emptyText}>Not connected to gateway</Text>
      </View>
    );
  }

  const collectionLabel =
    initialCollection === 'continuous'
      ? 'Continuous loops'
      : initialCollection === 'static'
      ? 'One-shot workflows'
      : 'All workflows';

  const editorLinkedJobs = linkedJobsFor(editorWorkflow, scheduledMap);
  const liveDaemons = (daemons || []).filter((d) => !d.stopped);

  // Header above the list: live running loops.
  const ListHeader =
    liveDaemons.length > 0 ? (
      <View style={styles.daemonSection}>
        <Text style={styles.sectionLabel}>RUNNING LOOPS · {liveDaemons.length}</Text>
        {liveDaemons.map((d) => {
          const wf = workflows.find((w) => w.id === d.workflowId);
          return (
            <View key={d.runId} style={styles.daemonCard}>
              <View
                style={[
                  styles.daemonBorder,
                  {
                    backgroundColor: d.paused
                      ? colors.warning || '#f59e0b'
                      : colors.success || '#22c55e',
                  },
                ]}
              />
              <View style={styles.daemonContent}>
                <View style={styles.daemonHeader}>
                  <Ionicons
                    name={d.paused ? 'pause-circle' : 'infinite'}
                    size={15}
                    color={d.paused ? colors.warning || '#f59e0b' : colors.success || '#22c55e'}
                  />
                  <Text style={styles.daemonName} numberOfLines={1}>
                    {wf?.name || d.workflowId}
                  </Text>
                  <Text style={styles.daemonMeta}>
                    iter {d.iterationCount}
                    {d.errorStreak ? ` · ${d.errorStreak} fail` : ''}
                  </Text>
                </View>
                <View style={styles.daemonActions}>
                  {d.paused ? (
                    <TouchableOpacity
                      style={[styles.daemonBtn, { borderColor: withAlpha(colors.success || '#22c55e', 0.5) }]}
                      onPress={() => daemonAction('workflows.continuous.resume', d.runId)}
                    >
                      <Ionicons name="play" size={13} color={colors.success || '#22c55e'} />
                      <Text style={[styles.daemonBtnText, { color: colors.success || '#22c55e' }]}>
                        Resume
                      </Text>
                    </TouchableOpacity>
                  ) : (
                    <TouchableOpacity
                      style={[styles.daemonBtn, { borderColor: withAlpha(colors.warning || '#f59e0b', 0.5) }]}
                      onPress={() => daemonAction('workflows.continuous.pause', d.runId)}
                    >
                      <Ionicons name="pause" size={13} color={colors.warning || '#f59e0b'} />
                      <Text style={[styles.daemonBtnText, { color: colors.warning || '#f59e0b' }]}>
                        Pause
                      </Text>
                    </TouchableOpacity>
                  )}
                  <TouchableOpacity
                    style={[styles.daemonBtn, { borderColor: withAlpha(colors.error, 0.5) }]}
                    onPress={() => daemonAction('workflows.continuous.stop', d.runId)}
                  >
                    <Ionicons name="stop" size={13} color={colors.error} />
                    <Text style={[styles.daemonBtnText, { color: colors.error }]}>Stop</Text>
                  </TouchableOpacity>
                </View>
              </View>
            </View>
          );
        })}
      </View>
    ) : null;

  return (
    <Animated.View style={[styles.container, { opacity: fadeAnim }]}>
      {/* Header slab */}
      <View style={styles.headerSlab}>
        <BlurView
          intensity={Platform.OS === 'android' ? 45 : 50}
          tint="dark"
          style={StyleSheet.absoluteFill}
        />
        <LinearGradient
          colors={[
            withAlpha(colors.primary, 0.22),
            withAlpha(colors.primary, 0.06),
            'rgba(0,0,0,0.4)',
          ]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 0 }}
          style={StyleSheet.absoluteFill}
        />
        <LinearGradient
          colors={innerTopHighlight}
          start={{ x: 0, y: 0 }}
          end={{ x: 0, y: 0.6 }}
          style={StyleSheet.absoluteFill}
        />
        <View
          style={[
            StyleSheet.absoluteFill,
            styles.headerSlabBorder,
            { borderColor: withAlpha(colors.primary, 0.18) },
          ]}
        />

        <View style={styles.headerTopRow}>
          <TouchableOpacity
            style={styles.headerBack}
            onPress={() => navigation?.goBack?.()}
            hitSlop={10}
          >
            <Ionicons name="chevron-back" size={20} color={colors.primary} />
          </TouchableOpacity>
          <View style={{ flex: 1 }}>
            <Text style={styles.headerTitle}>Workflows</Text>
            <Text style={styles.headerSubtitle}>
              {collectionLabel} · {selectedNode?.name || 'Local'}
            </Text>
          </View>
        </View>

        <View style={styles.searchRow}>
          <View style={styles.searchInputWrapper}>
            <Ionicons name="search-outline" size={16} color={colors.textMuted} />
            <TextInput
              style={styles.searchInput}
              value={searchQuery}
              onChangeText={setSearchQuery}
              placeholder="Search workflows…"
              placeholderTextColor={colors.textMuted}
            />
            {searchQuery ? (
              <TouchableOpacity onPress={() => setSearchQuery('')}>
                <Ionicons name="close-circle" size={16} color={colors.textMuted} />
              </TouchableOpacity>
            ) : null}
          </View>
          <TouchableOpacity
            style={[styles.createBtn, { backgroundColor: colors.primary }]}
            onPress={startCreate}
            activeOpacity={0.85}
          >
            <Ionicons name="add" size={20} color={colors.background || '#000'} />
          </TouchableOpacity>
        </View>

        {/* Filter chips */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.filterRow}
        >
          {FILTERS.map((f) => {
            const active = filter === f.key;
            return (
              <TouchableOpacity
                key={f.key}
                style={[
                  styles.filterChip,
                  active && {
                    backgroundColor: withAlpha(colors.primary, 0.2),
                    borderColor: withAlpha(colors.primary, 0.55),
                  },
                ]}
                onPress={() => setFilter(f.key)}
                activeOpacity={0.85}
              >
                <Ionicons
                  name={f.icon}
                  size={12}
                  color={active ? colors.primary : colors.textMuted}
                />
                <Text
                  style={[
                    styles.filterChipText,
                    { color: active ? colors.primary : colors.textMuted },
                  ]}
                >
                  {f.label}
                </Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>
      </View>

      {error ? (
        <View style={styles.errorBanner}>
          <Ionicons name="warning-outline" size={14} color={colors.error} />
          <Text style={styles.errorText}>{error}</Text>
          <TouchableOpacity onPress={() => setError(null)}>
            <Ionicons name="close" size={14} color={colors.error} />
          </TouchableOpacity>
        </View>
      ) : null}

      <GestureHandlerRootView style={{ flex: 1 }}>
        <FlatList
          data={filteredWorkflows}
          keyExtractor={(item) => item.id}
          ListHeaderComponent={ListHeader}
          renderItem={({ item, index }) => (
            <WorkflowListItem
              workflow={item}
              onPress={openWorkflow}
              onRun={quickRun}
              onSchedule={(wf) => openSchedule(wf)}
              index={index}
              colors={colors}
              styles={styles}
              scheduledCount={linkedJobsFor(item, scheduledMap).length}
              isRunning={runningIds.has(item.id)}
            />
          )}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={colors.primary}
              colors={[colors.primary]}
              progressBackgroundColor={colors.surface}
            />
          }
          ListEmptyComponent={
            <View style={styles.emptyContainer}>
              {loading ? (
                <ActivityIndicator color={colors.primary} size="large" />
              ) : (
                <View style={styles.emptyInner}>
                  <Ionicons name="layers-outline" size={44} color={colors.textMuted} />
                  <Text style={styles.emptyTitle}>
                    {searchQuery || filter !== 'all' ? 'No matches' : 'No workflows yet'}
                  </Text>
                  <Text style={styles.emptySubtitle}>
                    {searchQuery || filter !== 'all'
                      ? 'Try a different search or filter'
                      : 'Workflows are markdown playbooks an agent runs end-to-end'}
                  </Text>
                  {!searchQuery && filter === 'all' ? (
                    <TouchableOpacity
                      style={[
                        styles.emptyCta,
                        {
                          backgroundColor: withAlpha(colors.primary, 0.18),
                          borderColor: withAlpha(colors.primary, 0.4),
                        },
                      ]}
                      onPress={startCreate}
                    >
                      <Ionicons name="add-circle" size={18} color={colors.primary} />
                      <Text style={[styles.emptyCtaText, { color: colors.primary }]}>
                        Create your first workflow
                      </Text>
                    </TouchableOpacity>
                  ) : null}
                </View>
              )}
            </View>
          }
          contentContainerStyle={{
            paddingHorizontal: SPACING.md,
            paddingTop: SPACING.md,
            paddingBottom: 40,
            flexGrow: 1,
            gap: SPACING.sm,
          }}
        />
      </GestureHandlerRootView>

      {/* ── Workflow detail / editor modal ─────────────────────── */}
      <Modal visible={editorVisible} animationType="slide" onRequestClose={closeEditor}>
        <KeyboardAvoidingView
          style={styles.editorContainer}
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        >
          <View style={styles.editorHeader}>
            <TouchableOpacity onPress={closeEditor} hitSlop={10}>
              <Text style={styles.editorCancel}>Close</Text>
            </TouchableOpacity>
            <Text style={styles.editorTitle} numberOfLines={1}>
              {isCreating ? 'New Workflow' : editorName || 'Workflow'}
            </Text>
            <TouchableOpacity
              onPress={handleSave}
              disabled={saving || !editorName.trim() || !dirty}
              hitSlop={10}
            >
              <Text
                style={[
                  styles.editorSave,
                  (!editorName.trim() || saving || !dirty) && { opacity: 0.4 },
                ]}
              >
                {saving ? '…' : 'Save'}
              </Text>
            </TouchableOpacity>
          </View>

          {/* Action row — Run / Schedule */}
          {!isCreating && editorWorkflow ? (
            <View style={styles.actionRow}>
              <TouchableOpacity
                style={[
                  styles.actionBtn,
                  {
                    backgroundColor: withAlpha(colors.primary, 0.18),
                    borderColor: withAlpha(colors.primary, 0.5),
                  },
                ]}
                onPress={openRunDialog}
                activeOpacity={0.85}
              >
                <Ionicons name="play" size={14} color={colors.primary} />
                <Text style={[styles.actionBtnText, { color: colors.primary }]}>
                  {editorWorkflow.kind === 'continuous' ? 'Start loop' : 'Run'}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[
                  styles.actionBtn,
                  {
                    backgroundColor: withAlpha(colors.accent, 0.14),
                    borderColor: withAlpha(colors.accent, 0.4),
                  },
                ]}
                onPress={() => openSchedule(editorWorkflow)}
                activeOpacity={0.85}
              >
                <Ionicons name="time-outline" size={14} color={colors.accent} />
                <Text style={[styles.actionBtnText, { color: colors.accent }]}>
                  Schedule
                </Text>
              </TouchableOpacity>
              {dirty ? (
                <View style={styles.dirtyChip}>
                  <Text style={styles.dirtyChipText}>UNSAVED</Text>
                </View>
              ) : null}
            </View>
          ) : null}

          {/* Tabs */}
          <View style={styles.tabBar}>
            {[
              { key: 'edit', label: 'Edit', icon: 'create-outline' },
              { key: 'preview', label: 'Preview', icon: 'eye-outline' },
              { key: 'settings', label: 'Settings', icon: 'options-outline' },
              { key: 'runs', label: 'Runs', icon: 'pulse-outline' },
              { key: 'sched', label: 'Sched', icon: 'time-outline' },
            ].map((t) => {
              const active = editorTab === t.key;
              return (
                <TouchableOpacity
                  key={t.key}
                  style={[
                    styles.tab,
                    active && {
                      backgroundColor: withAlpha(colors.primary, 0.18),
                      borderColor: withAlpha(colors.primary, 0.55),
                    },
                  ]}
                  onPress={() => setEditorTab(t.key)}
                  activeOpacity={0.85}
                >
                  <Ionicons
                    name={t.icon}
                    size={14}
                    color={active ? colors.primary : colors.textMuted}
                  />
                  <Text
                    style={[
                      styles.tabText,
                      { color: active ? colors.primary : colors.textMuted },
                    ]}
                  >
                    {t.label}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>

          {editorTab === 'edit' ? (
            <ScrollView style={styles.editorPane} keyboardShouldPersistTaps="handled">
              <TextInput
                style={styles.editorContentInput}
                value={editorBody}
                onChangeText={(v) => {
                  setEditorBody(v);
                  if (!dirty) setDirty(true);
                }}
                placeholder="Write the workflow in Markdown…"
                placeholderTextColor={colors.textMuted}
                multiline
                textAlignVertical="top"
                autoCapitalize="sentences"
              />
            </ScrollView>
          ) : editorTab === 'preview' ? (
            <ScrollView
              style={styles.editorPane}
              contentContainerStyle={{ padding: SPACING.lg, paddingBottom: 80 }}
            >
              {previewBody.trim() ? (
                <Markdown style={markdownStyles}>{previewBody}</Markdown>
              ) : (
                <View style={styles.previewEmpty}>
                  <Ionicons name="eye-off-outline" size={32} color={colors.textMuted} />
                  <Text style={styles.emptyText}>
                    Nothing to preview yet — switch to Edit and start writing
                  </Text>
                </View>
              )}
            </ScrollView>
          ) : editorTab === 'settings' ? (
            <ScrollView
              style={styles.editorPane}
              contentContainerStyle={{ padding: SPACING.lg, paddingBottom: 80 }}
            >
              <Text style={styles.fieldLabel}>Name</Text>
              <TextInput
                style={styles.fieldInput}
                value={editorName}
                onChangeText={(v) => {
                  setEditorName(v);
                  if (!dirty) setDirty(true);
                }}
                placeholder="Workflow name"
                placeholderTextColor={colors.textMuted}
              />

              <Text style={styles.fieldLabel}>Description</Text>
              <TextInput
                style={styles.fieldInput}
                value={editorDescription}
                onChangeText={(v) => {
                  setEditorDescription(v);
                  if (!dirty) setDirty(true);
                }}
                placeholder="Short description"
                placeholderTextColor={colors.textMuted}
              />

              <Text style={styles.fieldLabel}>Tags (comma separated)</Text>
              <TextInput
                style={styles.fieldInput}
                value={editorTags}
                onChangeText={(v) => {
                  setEditorTags(v);
                  if (!dirty) setDirty(true);
                }}
                placeholder="tag1, tag2"
                placeholderTextColor={colors.textMuted}
                autoCapitalize="none"
              />

              {editorWorkflow ? (
                <View style={styles.readonlyBox}>
                  <Text style={styles.readonlyTitle}>RUNTIME</Text>
                  <View style={styles.readonlyRow}>
                    <Text style={styles.readonlyKey}>Agent</Text>
                    <Text style={styles.readonlyValue}>
                      {editorWorkflow.agent || 'main'}
                    </Text>
                  </View>
                  {editorWorkflow.model ? (
                    <View style={styles.readonlyRow}>
                      <Text style={styles.readonlyKey}>Model</Text>
                      <Text style={styles.readonlyValue}>{editorWorkflow.model}</Text>
                    </View>
                  ) : null}
                  {editorWorkflow.timeoutSeconds ? (
                    <View style={styles.readonlyRow}>
                      <Text style={styles.readonlyKey}>Timeout</Text>
                      <Text style={styles.readonlyValue}>
                        {editorWorkflow.timeoutSeconds}s
                      </Text>
                    </View>
                  ) : null}
                  <View style={styles.readonlyRow}>
                    <Text style={styles.readonlyKey}>Kind</Text>
                    <Text style={styles.readonlyValue}>
                      {editorWorkflow.kind || 'static'}
                    </Text>
                  </View>
                  {editorWorkflow.continuous ? (
                    <View style={styles.readonlyRow}>
                      <Text style={styles.readonlyKey}>Iter interval</Text>
                      <Text style={styles.readonlyValue}>
                        {editorWorkflow.continuous.iterationIntervalSeconds}s
                      </Text>
                    </View>
                  ) : null}
                </View>
              ) : null}

              {/* Notion sync */}
              {!isCreating && editorWorkflow ? (
                <View style={styles.notionBox}>
                  <Text style={styles.readonlyTitle}>NOTION</Text>
                  {editorWorkflow.notionSyncedAt ? (
                    <View style={styles.readonlyRow}>
                      <Text style={styles.readonlyKey}>Last synced</Text>
                      <Text style={styles.readonlyValue}>
                        {fmtRelative(editorWorkflow.notionSyncedAt)}
                      </Text>
                    </View>
                  ) : null}
                  <View style={styles.notionBtnRow}>
                    <TouchableOpacity
                      style={[
                        styles.actionBtn,
                        {
                          flex: 1,
                          justifyContent: 'center',
                          backgroundColor: withAlpha(colors.accent, 0.14),
                          borderColor: withAlpha(colors.accent, 0.4),
                        },
                      ]}
                      onPress={handleNotionSync}
                      disabled={notionSyncing}
                    >
                      <Ionicons name="sync" size={14} color={colors.accent} />
                      <Text style={[styles.actionBtnText, { color: colors.accent }]}>
                        {notionSyncing ? 'Syncing…' : 'Sync to Notion'}
                      </Text>
                    </TouchableOpacity>
                    {editorWorkflow.notionPageId ? (
                      <TouchableOpacity
                        style={[
                          styles.actionBtn,
                          {
                            justifyContent: 'center',
                            backgroundColor: withAlpha(colors.primary, 0.14),
                            borderColor: withAlpha(colors.primary, 0.4),
                          },
                        ]}
                        onPress={() => openNotion(editorWorkflow.notionPageId)}
                      >
                        <Ionicons name="open-outline" size={14} color={colors.primary} />
                        <Text style={[styles.actionBtnText, { color: colors.primary }]}>
                          Open
                        </Text>
                      </TouchableOpacity>
                    ) : null}
                  </View>
                </View>
              ) : null}

              {!isCreating && editorWorkflow ? (
                <TouchableOpacity style={styles.deleteBtn} onPress={handleDelete}>
                  <Ionicons name="trash-outline" size={16} color={colors.error} />
                  <Text style={styles.deleteBtnText}>Delete workflow</Text>
                </TouchableOpacity>
              ) : null}
            </ScrollView>
          ) : editorTab === 'sched' ? (
            // Scheduled (cron) tab
            <ScrollView
              style={styles.editorPane}
              contentContainerStyle={{
                padding: SPACING.lg,
                paddingBottom: 80,
                gap: SPACING.sm,
              }}
            >
              <View style={styles.runsHeaderRow}>
                <Text style={styles.fieldLabel}>SCHEDULES</Text>
                <TouchableOpacity onPress={loadCronJobs} hitSlop={6}>
                  <Ionicons name="refresh" size={16} color={colors.textMuted} />
                </TouchableOpacity>
              </View>

              {editorLinkedJobs.length === 0 ? (
                <View style={styles.previewEmpty}>
                  <Ionicons name="time-outline" size={28} color={colors.textMuted} />
                  <Text style={styles.emptyText}>
                    Not scheduled — add a cron schedule to run this on a timer
                  </Text>
                </View>
              ) : (
                editorLinkedJobs.map((job) => {
                  const next = fmtNextRun(job);
                  return (
                    <View key={jobId(job)} style={styles.scheduleCard}>
                      <View
                        style={[
                          styles.runCardBorder,
                          {
                            backgroundColor: job.enabled === false
                              ? colors.textMuted
                              : colors.accent,
                          },
                        ]}
                      />
                      <View style={styles.runCardContent}>
                        <View style={styles.runCardHeader}>
                          <Ionicons name="time" size={14} color={colors.accent} />
                          <Text style={styles.scheduleName} numberOfLines={1}>
                            {job.name || 'Scheduled run'}
                          </Text>
                          {job.enabled === false ? (
                            <Text style={[styles.runMetaText, { color: colors.textMuted }]}>
                              paused
                            </Text>
                          ) : null}
                        </View>
                        <Text style={styles.scheduleExpr}>
                          {describeSchedule(job.schedule)}
                        </Text>
                        <View style={styles.runMetaRow}>
                          {next ? (
                            <Text style={[styles.runMetaText, { color: colors.success || '#22c55e' }]}>
                              next {next}
                            </Text>
                          ) : null}
                          {job.lastRunStatus ? (
                            <Text style={styles.runMetaText}>· last {job.lastRunStatus}</Text>
                          ) : null}
                        </View>
                        <View style={styles.scheduleActions}>
                          <TouchableOpacity
                            style={styles.schedEditBtn}
                            onPress={() => openSchedule(editorWorkflow, jobId(job))}
                          >
                            <Ionicons name="create-outline" size={13} color={colors.primary} />
                            <Text style={[styles.daemonBtnText, { color: colors.primary }]}>
                              Edit
                            </Text>
                          </TouchableOpacity>
                          <TouchableOpacity
                            style={[styles.schedEditBtn, { borderColor: withAlpha(colors.error, 0.4) }]}
                            onPress={() => cancelSchedule(job)}
                          >
                            <Ionicons name="trash-outline" size={13} color={colors.error} />
                            <Text style={[styles.daemonBtnText, { color: colors.error }]}>
                              Cancel
                            </Text>
                          </TouchableOpacity>
                        </View>
                      </View>
                    </View>
                  );
                })
              )}

              <TouchableOpacity
                style={[
                  styles.emptyCta,
                  {
                    alignSelf: 'flex-start',
                    backgroundColor: withAlpha(colors.accent, 0.16),
                    borderColor: withAlpha(colors.accent, 0.4),
                    marginTop: SPACING.sm,
                  },
                ]}
                onPress={() => openSchedule(editorWorkflow)}
              >
                <Ionicons name="add-circle" size={18} color={colors.accent} />
                <Text style={[styles.emptyCtaText, { color: colors.accent }]}>
                  Add schedule
                </Text>
              </TouchableOpacity>
            </ScrollView>
          ) : (
            // runs tab
            <ScrollView
              style={styles.editorPane}
              contentContainerStyle={{
                padding: SPACING.lg,
                paddingBottom: 80,
                gap: SPACING.sm,
              }}
            >
              <View style={styles.runsHeaderRow}>
                <Text style={styles.fieldLabel}>RECENT RUNS</Text>
                <TouchableOpacity
                  onPress={() => editorWorkflow && loadRecentRuns(editorWorkflow.id)}
                  hitSlop={6}
                >
                  <Ionicons name="refresh" size={16} color={colors.textMuted} />
                </TouchableOpacity>
              </View>
              {recentRuns.length === 0 ? (
                <View style={styles.previewEmpty}>
                  <Ionicons name="pulse-outline" size={28} color={colors.textMuted} />
                  <Text style={styles.emptyText}>No runs yet — hit Run to kick one off</Text>
                </View>
              ) : (
                recentRuns.map((run) => {
                  const tint = statusTint(run.status, colors);
                  const ongoing = run.status === 'running' || run.status === 'pending';
                  return (
                    <View key={run.id} style={styles.runCard}>
                      <View style={[styles.runCardBorder, { backgroundColor: tint }]} />
                      <View style={styles.runCardContent}>
                        <View style={styles.runCardHeader}>
                          <Ionicons name={statusIcon(run.status)} size={14} color={tint} />
                          <Text style={[styles.runStatus, { color: tint }]}>
                            {run.status?.toUpperCase()}
                          </Text>
                          <Text style={styles.runDate}>{fmtRelative(run.startedAt)}</Text>
                          {ongoing ? (
                            <TouchableOpacity
                              style={styles.runCancelBtn}
                              onPress={() => cancelRun(run.id)}
                              hitSlop={6}
                            >
                              <Text style={styles.runCancelText}>Cancel</Text>
                            </TouchableOpacity>
                          ) : null}
                        </View>
                        {run.error ? (
                          <Text style={styles.runError} numberOfLines={2}>
                            {run.error}
                          </Text>
                        ) : run.result ? (
                          <Text style={styles.runResult} numberOfLines={2}>
                            {run.result}
                          </Text>
                        ) : null}
                        <View style={styles.runMetaRow}>
                          <Text style={styles.runMetaText}>agent {run.agent || 'main'}</Text>
                          {run.iterationCount != null ? (
                            <Text style={styles.runMetaText}>· iter {run.iterationCount}</Text>
                          ) : null}
                          {run.executionMode ? (
                            <Text style={styles.runMetaText}>· {run.executionMode}</Text>
                          ) : null}
                        </View>
                      </View>
                    </View>
                  );
                })
              )}
            </ScrollView>
          )}
        </KeyboardAvoidingView>
      </Modal>

      {/* ── Run dialog ────────────────────────────────────────── */}
      <Modal
        visible={runVisible}
        animationType="fade"
        transparent
        onRequestClose={() => setRunVisible(false)}
      >
        <View style={styles.runDialogBackdrop}>
          <View style={styles.runDialogCard}>
            <View style={styles.runDialogHeader}>
              <Text style={styles.runDialogTitle} numberOfLines={1}>
                {runWorkflow?.kind === 'continuous'
                  ? 'Start continuous loop'
                  : 'Run workflow'}
              </Text>
              <TouchableOpacity onPress={() => setRunVisible(false)} hitSlop={10}>
                <Ionicons name="close" size={20} color={colors.textMuted} />
              </TouchableOpacity>
            </View>
            <Text style={styles.runDialogSubtitle} numberOfLines={1}>
              {runWorkflow?.name}
            </Text>

            <ScrollView
              style={styles.runDialogBody}
              contentContainerStyle={{ paddingBottom: 12 }}
              keyboardShouldPersistTaps="handled"
            >
              {(runWorkflow?.inputs ?? []).length === 0 ? (
                <Text style={styles.runDialogInfo}>
                  No inputs required for this workflow.
                </Text>
              ) : (
                runWorkflow.inputs.map((def) =>
                  renderInput(def, runInputs[def.name], setRunInput, colors, styles),
                )
              )}

              {/* Execution mode */}
              <Text style={styles.fieldLabel}>EXECUTION MODE</Text>
              <View style={styles.selectRow}>
                {[
                  { value: 'gateway', label: 'Gateway' },
                  { value: 'terminal', label: 'Terminal' },
                ].map((m) => {
                  const active = runExecMode === m.value;
                  const tone = m.value === 'terminal' ? colors.accent : colors.primary;
                  return (
                    <TouchableOpacity
                      key={m.value}
                      style={[
                        styles.selectChip,
                        active && {
                          backgroundColor: withAlpha(tone, 0.18),
                          borderColor: withAlpha(tone, 0.5),
                        },
                      ]}
                      onPress={() => setRunExecMode(m.value)}
                    >
                      <Text
                        style={[
                          styles.selectChipText,
                          { color: active ? tone : colors.textSecondary },
                        ]}
                      >
                        {m.label}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>

              {runExecMode === 'terminal' ? (
                <>
                  <Text style={styles.fieldLabel}>CLI</Text>
                  <View style={styles.selectRow}>
                    {CLI_OPTIONS.map((c) => {
                      const active = runCli === c.value;
                      return (
                        <TouchableOpacity
                          key={c.value}
                          style={[
                            styles.selectChip,
                            active && {
                              backgroundColor: withAlpha(colors.accent, 0.18),
                              borderColor: withAlpha(colors.accent, 0.5),
                            },
                          ]}
                          onPress={() => setRunCli(c.value)}
                        >
                          <Text
                            style={[
                              styles.selectChipText,
                              { color: active ? colors.accent : colors.textSecondary },
                            ]}
                          >
                            {c.label}
                          </Text>
                        </TouchableOpacity>
                      );
                    })}
                  </View>
                  <Text style={styles.fieldLabel}>Working directory</Text>
                  <TextInput
                    style={styles.fieldInput}
                    value={runCwd}
                    onChangeText={setRunCwd}
                    placeholder="."
                    placeholderTextColor={colors.textMuted}
                    autoCapitalize="none"
                    autoCorrect={false}
                  />
                </>
              ) : null}

              {runPreflightInFlight ? (
                <Text style={styles.runDialogInfo}>Checking requirements…</Text>
              ) : runPreflight ? (
                renderPreflightSummary(runPreflight.issues || [], colors, styles)
              ) : null}

              {runError ? (
                <View style={styles.runDialogError}>
                  <Text style={styles.runDialogErrorText}>{runError}</Text>
                </View>
              ) : null}
            </ScrollView>

            <View style={styles.runDialogFooter}>
              <TouchableOpacity
                style={styles.runDialogSecondaryBtn}
                onPress={() => setRunVisible(false)}
                disabled={runStarting}
              >
                <Text style={styles.runDialogSecondaryText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[
                  styles.runDialogPrimaryBtn,
                  (runStarting || runPreflightInFlight || !(runPreflight?.ok ?? true)) && {
                    opacity: 0.5,
                  },
                ]}
                onPress={startRun}
                disabled={
                  runStarting || runPreflightInFlight || !(runPreflight?.ok ?? true)
                }
              >
                <Ionicons name="play" size={14} color={colors.background || '#000'} />
                <Text style={styles.runDialogPrimaryText}>
                  {runStarting ? 'Starting…' : 'Start'}
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </Animated.View>
  );
}

// ── Run dialog field renderers ──────────────────────────────

function renderInput(def, value, setRunInput, colors, styles) {
  const label = def.label || humanize(def.name);
  const onChange = (v) => setRunInput(def.name, v);
  let control;
  switch (def.type) {
    case 'text':
      control = (
        <TextInput
          style={[styles.fieldInput, { minHeight: 80, textAlignVertical: 'top' }]}
          placeholder={def.placeholder || ''}
          placeholderTextColor={colors.textMuted}
          value={typeof value === 'string' ? value : ''}
          onChangeText={onChange}
          multiline
        />
      );
      break;
    case 'number':
      control = (
        <TextInput
          style={styles.fieldInput}
          placeholder={def.placeholder || ''}
          placeholderTextColor={colors.textMuted}
          value={value != null ? String(value) : ''}
          onChangeText={(raw) => onChange(raw === '' ? undefined : Number(raw))}
          keyboardType="numeric"
        />
      );
      break;
    case 'boolean':
      control = (
        <TouchableOpacity
          style={[
            styles.boolToggle,
            value === true && {
              backgroundColor: withAlpha(colors.primary, 0.18),
              borderColor: withAlpha(colors.primary, 0.45),
            },
          ]}
          onPress={() => onChange(value !== true)}
          activeOpacity={0.85}
        >
          <Ionicons
            name={value === true ? 'checkbox' : 'square-outline'}
            size={16}
            color={value === true ? colors.primary : colors.textMuted}
          />
          <Text
            style={[
              styles.boolToggleText,
              { color: value === true ? colors.primary : colors.textMuted },
            ]}
          >
            {value === true ? 'Enabled' : 'Disabled'}
          </Text>
        </TouchableOpacity>
      );
      break;
    case 'select':
    case 'multiSelect':
      control = (
        <View style={styles.selectRow}>
          {(def.options || []).map((opt) => {
            const active = value === opt.value;
            return (
              <TouchableOpacity
                key={opt.value}
                style={[
                  styles.selectChip,
                  active && {
                    backgroundColor: withAlpha(colors.primary, 0.18),
                    borderColor: withAlpha(colors.primary, 0.5),
                  },
                ]}
                onPress={() => onChange(opt.value)}
              >
                <Text
                  style={[
                    styles.selectChipText,
                    { color: active ? colors.primary : colors.textSecondary },
                  ]}
                >
                  {opt.label || opt.value}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>
      );
      break;
    default:
      control = (
        <TextInput
          style={styles.fieldInput}
          placeholder={def.placeholder || ''}
          placeholderTextColor={colors.textMuted}
          value={typeof value === 'string' ? value : ''}
          onChangeText={onChange}
          autoCapitalize="none"
        />
      );
  }
  return (
    <View key={def.name} style={{ marginBottom: SPACING.md }}>
      <Text style={styles.fieldLabel}>
        {label}
        {def.required ? ' *' : ''}
      </Text>
      {control}
      {def.description ? <Text style={styles.fieldHelp}>{def.description}</Text> : null}
    </View>
  );
}

function renderPreflightSummary(issues, colors, styles) {
  const errors = issues.filter((i) => i.severity === 'error');
  const warnings = issues.filter((i) => i.severity === 'warning');
  if (errors.length === 0 && warnings.length === 0) {
    return (
      <View
        style={[
          styles.preflightPill,
          { borderColor: withAlpha(colors.success || '#22c55e', 0.4) },
        ]}
      >
        <Ionicons name="checkmark-circle" size={14} color={colors.success || '#22c55e'} />
        <Text style={[styles.preflightText, { color: colors.success || '#22c55e' }]}>
          Preflight passed — ready to run.
        </Text>
      </View>
    );
  }
  return (
    <View style={{ gap: 6, marginTop: 8 }}>
      {errors.map((e, i) => (
        <View
          key={`e${i}`}
          style={[
            styles.preflightPill,
            {
              borderColor: withAlpha(colors.error, 0.4),
              backgroundColor: withAlpha(colors.error, 0.08),
            },
          ]}
        >
          <Ionicons name="alert-circle" size={14} color={colors.error} />
          <Text style={[styles.preflightText, { color: colors.error }]}>
            {e.requirement?.kind}:{e.requirement?.name} — {e.detail}
          </Text>
        </View>
      ))}
      {warnings.map((w, i) => (
        <View
          key={`w${i}`}
          style={[
            styles.preflightPill,
            {
              borderColor: withAlpha(colors.warning || '#f59e0b', 0.4),
              backgroundColor: withAlpha(colors.warning || '#f59e0b', 0.08),
            },
          ]}
        >
          <Ionicons name="warning-outline" size={14} color={colors.warning || '#f59e0b'} />
          <Text style={[styles.preflightText, { color: colors.warning || '#f59e0b' }]}>
            {w.requirement?.kind}:{w.requirement?.name} — {w.detail}
          </Text>
        </View>
      ))}
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────

function makeStyles(colors) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: 'transparent' },
    center: {
      flex: 1,
      justifyContent: 'center',
      alignItems: 'center',
      padding: 40,
      gap: 12,
    },
    emptyText: { ...TYPOGRAPHY.body, color: colors.textMuted, textAlign: 'center' },

    headerSlab: { overflow: 'hidden', backgroundColor: 'transparent' },
    headerSlabBorder: { borderBottomWidth: StyleSheet.hairlineWidth },
    headerTopRow: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: SPACING.md,
      paddingTop: Platform.OS === 'ios' ? SPACING.lg : SPACING.md,
      gap: SPACING.sm,
    },
    headerBack: {
      width: 36,
      height: 36,
      borderRadius: 18,
      backgroundColor: withAlpha(colors.primary, 0.12),
      alignItems: 'center',
      justifyContent: 'center',
    },
    headerTitle: {
      ...TYPOGRAPHY.heading,
      color: colors.text,
      fontSize: 22,
      letterSpacing: -0.3,
    },
    headerSubtitle: { ...TYPOGRAPHY.caption, color: colors.textMuted, marginTop: 2 },

    searchRow: {
      flexDirection: 'row',
      gap: SPACING.sm,
      paddingHorizontal: SPACING.md,
      paddingTop: SPACING.sm,
      paddingBottom: SPACING.sm,
      alignItems: 'center',
    },
    searchInputWrapper: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      backgroundColor: withAlpha(colors.surfaceTint || '#000', 0.32),
      borderRadius: 14,
      paddingHorizontal: SPACING.md,
      paddingVertical: 8,
      borderWidth: 1,
      borderColor: withAlpha(colors.primary, 0.22),
    },
    searchInput: {
      flex: 1,
      color: colors.text,
      ...TYPOGRAPHY.body,
      paddingVertical: Platform.OS === 'ios' ? 4 : 0,
    },
    createBtn: {
      width: 38,
      height: 38,
      borderRadius: 19,
      alignItems: 'center',
      justifyContent: 'center',
      shadowColor: colors.primary,
      shadowOffset: { width: 0, height: 0 },
      shadowOpacity: 0.4,
      shadowRadius: 10,
      elevation: 6,
    },

    filterRow: {
      flexDirection: 'row',
      gap: SPACING.xs,
      paddingHorizontal: SPACING.md,
      paddingBottom: SPACING.sm,
    },
    filterChip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 5,
      paddingHorizontal: 12,
      paddingVertical: 6,
      borderRadius: 16,
      borderWidth: 1,
      borderColor: withAlpha(colors.primary, 0.18),
      backgroundColor: withAlpha(colors.surfaceTint || '#000', 0.25),
    },
    filterChipText: { ...TYPOGRAPHY.caption, fontWeight: '700' },

    errorBanner: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      marginHorizontal: SPACING.md,
      marginTop: SPACING.sm,
      paddingHorizontal: SPACING.md,
      paddingVertical: 8,
      borderRadius: 10,
      backgroundColor: withAlpha(colors.error, 0.14),
      borderWidth: 1,
      borderColor: withAlpha(colors.error, 0.33),
    },
    errorText: { color: colors.error, ...TYPOGRAPHY.small, flex: 1 },

    sectionLabel: {
      ...TYPOGRAPHY.caption,
      color: colors.textSecondary,
      letterSpacing: 1,
      fontWeight: '700',
      marginBottom: 6,
    },

    // Live daemons
    daemonSection: { marginBottom: SPACING.sm },
    daemonCard: {
      borderRadius: 14,
      borderWidth: 1,
      borderColor: withAlpha(colors.success || '#22c55e', 0.28),
      backgroundColor: withAlpha(colors.success || '#22c55e', 0.06),
      overflow: 'hidden',
      marginBottom: SPACING.xs,
    },
    daemonBorder: {
      position: 'absolute',
      left: 0,
      top: 0,
      bottom: 0,
      width: 3,
      opacity: 0.9,
    },
    daemonContent: { padding: SPACING.md, paddingLeft: SPACING.md + 4 },
    daemonHeader: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    daemonName: { ...TYPOGRAPHY.body, color: colors.text, fontWeight: '600', flex: 1 },
    daemonMeta: { ...TYPOGRAPHY.caption, color: colors.textMuted },
    daemonActions: { flexDirection: 'row', gap: SPACING.sm, marginTop: SPACING.sm },
    daemonBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      paddingHorizontal: 12,
      paddingVertical: 6,
      borderRadius: 8,
      borderWidth: 1,
    },
    daemonBtnText: { ...TYPOGRAPHY.caption, fontWeight: '700' },

    // List cards
    workflowCard: {
      borderRadius: 16,
      backgroundColor: withAlpha(colors.surfaceTint || colors.surface, 0.28),
      borderWidth: 1,
      borderColor: withAlpha(colors.primary, 0.18),
      overflow: 'hidden',
    },
    workflowCardBorder: {
      position: 'absolute',
      left: 0,
      top: 0,
      bottom: 0,
      width: 3,
      opacity: 0.85,
    },
    workflowCardContent: { padding: SPACING.md, paddingLeft: SPACING.md + 4 },
    workflowCardHeaderRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
    },
    workflowCardTitleRow: { flexDirection: 'row', alignItems: 'center', flex: 1 },
    workflowCardTitle: {
      ...TYPOGRAPHY.body,
      color: colors.text,
      fontWeight: '600',
      flex: 1,
    },
    liveDot: { marginLeft: 6 },
    liveDotInner: { width: 8, height: 8, borderRadius: 4 },
    workflowCardDate: { ...TYPOGRAPHY.caption, color: colors.textMuted, marginLeft: 8 },
    workflowCardDesc: { ...TYPOGRAPHY.small, color: colors.textSecondary, marginTop: 4 },
    workflowCardFooter: {
      flexDirection: 'row',
      alignItems: 'center',
      marginTop: 8,
      gap: 6,
      flexWrap: 'wrap',
    },
    workflowBadge: {
      paddingHorizontal: 7,
      paddingVertical: 2,
      borderRadius: 6,
      borderWidth: 1,
    },
    workflowBadgeText: { ...TYPOGRAPHY.caption, fontWeight: '700', letterSpacing: 0.5 },
    workflowMeta: { ...TYPOGRAPHY.caption, color: colors.textMuted },

    // Swipe actions
    swipeActions: { flexDirection: 'row', alignItems: 'stretch' },
    swipeAction: {
      width: 72,
      alignItems: 'center',
      justifyContent: 'center',
      gap: 3,
      marginLeft: 6,
      borderRadius: 16,
    },
    swipeActionText: { ...TYPOGRAPHY.caption, fontWeight: '800', letterSpacing: 0.4 },

    emptyContainer: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      padding: SPACING.xl,
    },
    emptyInner: { alignItems: 'center', gap: SPACING.sm, maxWidth: 320 },
    emptyTitle: { ...TYPOGRAPHY.heading, color: colors.text, marginTop: SPACING.sm },
    emptySubtitle: { ...TYPOGRAPHY.small, color: colors.textMuted, textAlign: 'center' },
    emptyCta: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      paddingHorizontal: 14,
      paddingVertical: 8,
      borderRadius: 12,
      borderWidth: 1,
      marginTop: SPACING.sm,
    },
    emptyCtaText: { ...TYPOGRAPHY.small, fontWeight: '700' },

    // Editor modal
    editorContainer: { flex: 1, backgroundColor: colors.background },
    editorHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: SPACING.md,
      paddingVertical: SPACING.md,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: withAlpha(colors.primary, 0.18),
      backgroundColor: colors.surface,
    },
    editorCancel: { ...TYPOGRAPHY.body, color: colors.textMuted },
    editorTitle: {
      ...TYPOGRAPHY.body,
      color: colors.text,
      fontWeight: '700',
      flex: 1,
      textAlign: 'center',
      paddingHorizontal: SPACING.sm,
    },
    editorSave: { ...TYPOGRAPHY.body, color: colors.primary, fontWeight: '700' },

    actionRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: SPACING.sm,
      paddingHorizontal: SPACING.md,
      paddingVertical: SPACING.sm,
      flexWrap: 'wrap',
    },
    actionBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      paddingHorizontal: SPACING.md,
      paddingVertical: 8,
      borderRadius: 10,
      borderWidth: 1,
    },
    actionBtnText: { ...TYPOGRAPHY.small, fontWeight: '700' },
    dirtyChip: {
      paddingHorizontal: 8,
      paddingVertical: 3,
      borderRadius: 6,
      backgroundColor: withAlpha(colors.warning || '#f59e0b', 0.18),
      borderWidth: 1,
      borderColor: withAlpha(colors.warning || '#f59e0b', 0.45),
    },
    dirtyChipText: {
      ...TYPOGRAPHY.caption,
      color: colors.warning || '#f59e0b',
      fontWeight: '700',
      letterSpacing: 1,
    },

    tabBar: {
      flexDirection: 'row',
      gap: SPACING.xs,
      paddingHorizontal: SPACING.md,
      paddingBottom: SPACING.sm,
    },
    tab: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 3,
      paddingVertical: 8,
      borderRadius: 10,
      borderWidth: 1,
      borderColor: 'transparent',
      backgroundColor: withAlpha(colors.surfaceTint || '#000', 0.25),
    },
    tabText: { ...TYPOGRAPHY.caption, fontWeight: '700' },

    editorPane: { flex: 1 },
    editorContentInput: {
      ...TYPOGRAPHY.body,
      color: colors.text,
      fontFamily: FONT_FAMILY.mono || FONT_FAMILY.regular,
      padding: SPACING.lg,
      minHeight: 320,
    },
    previewEmpty: { paddingVertical: SPACING.xl, alignItems: 'center', gap: SPACING.sm },

    fieldLabel: {
      ...TYPOGRAPHY.caption,
      color: colors.textSecondary,
      letterSpacing: 1,
      fontWeight: '700',
      marginTop: SPACING.sm,
      marginBottom: 6,
    },
    fieldInput: {
      ...TYPOGRAPHY.body,
      color: colors.text,
      backgroundColor: withAlpha(colors.surfaceTint || '#000', 0.32),
      borderRadius: 10,
      paddingHorizontal: SPACING.md,
      paddingVertical: 10,
      borderWidth: 1,
      borderColor: withAlpha(colors.primary, 0.18),
    },
    fieldHelp: { ...TYPOGRAPHY.caption, color: colors.textMuted, marginTop: 4 },

    readonlyBox: {
      marginTop: SPACING.lg,
      padding: SPACING.md,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: withAlpha(colors.primary, 0.2),
      backgroundColor: withAlpha(colors.surfaceTint || '#000', 0.24),
      gap: 6,
    },
    readonlyTitle: {
      ...TYPOGRAPHY.caption,
      color: colors.primary,
      letterSpacing: 1.2,
      fontWeight: '700',
    },
    readonlyRow: { flexDirection: 'row', justifyContent: 'space-between' },
    readonlyKey: { ...TYPOGRAPHY.small, color: colors.textMuted },
    readonlyValue: { ...TYPOGRAPHY.small, color: colors.text, fontWeight: '600' },

    notionBox: {
      marginTop: SPACING.md,
      padding: SPACING.md,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: withAlpha(colors.accent, 0.2),
      backgroundColor: withAlpha(colors.accent, 0.05),
      gap: 8,
    },
    notionBtnRow: { flexDirection: 'row', gap: SPACING.sm, marginTop: 4 },

    deleteBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 6,
      marginTop: SPACING.lg,
      paddingVertical: 12,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: withAlpha(colors.error, 0.45),
      backgroundColor: withAlpha(colors.error, 0.1),
    },
    deleteBtnText: { ...TYPOGRAPHY.body, color: colors.error, fontWeight: '700' },

    // Runs / schedule tab
    runsHeaderRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
    },
    runCard: {
      borderRadius: 12,
      borderWidth: 1,
      borderColor: withAlpha(colors.primary, 0.18),
      backgroundColor: withAlpha(colors.surfaceTint || '#000', 0.24),
      overflow: 'hidden',
    },
    scheduleCard: {
      borderRadius: 12,
      borderWidth: 1,
      borderColor: withAlpha(colors.accent, 0.22),
      backgroundColor: withAlpha(colors.surfaceTint || '#000', 0.24),
      overflow: 'hidden',
    },
    runCardBorder: {
      position: 'absolute',
      left: 0,
      top: 0,
      bottom: 0,
      width: 3,
      opacity: 0.9,
    },
    runCardContent: {
      paddingVertical: SPACING.sm,
      paddingHorizontal: SPACING.md,
      paddingLeft: SPACING.md + 4,
    },
    runCardHeader: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    runStatus: { ...TYPOGRAPHY.caption, fontWeight: '700', letterSpacing: 0.6 },
    runDate: { ...TYPOGRAPHY.caption, color: colors.textMuted, flex: 1 },
    runCancelBtn: {
      paddingHorizontal: 8,
      paddingVertical: 3,
      borderRadius: 6,
      borderWidth: 1,
      borderColor: withAlpha(colors.error, 0.4),
    },
    runCancelText: { ...TYPOGRAPHY.caption, color: colors.error, fontWeight: '700' },
    runError: { ...TYPOGRAPHY.small, color: colors.error, marginTop: 4 },
    runResult: { ...TYPOGRAPHY.small, color: colors.textSecondary, marginTop: 4 },
    runMetaRow: { flexDirection: 'row', gap: 4, marginTop: 4, flexWrap: 'wrap' },
    runMetaText: { ...TYPOGRAPHY.caption, color: colors.textMuted },

    scheduleName: { ...TYPOGRAPHY.body, color: colors.text, fontWeight: '600', flex: 1 },
    scheduleExpr: {
      ...TYPOGRAPHY.small,
      color: colors.accent,
      marginTop: 4,
      fontFamily: FONT_FAMILY.mono || FONT_FAMILY.regular,
    },
    scheduleActions: { flexDirection: 'row', gap: SPACING.sm, marginTop: SPACING.sm },
    schedEditBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      paddingHorizontal: 12,
      paddingVertical: 6,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: withAlpha(colors.primary, 0.4),
    },

    // Run dialog
    runDialogBackdrop: {
      flex: 1,
      backgroundColor: 'rgba(0,0,0,0.65)',
      justifyContent: 'flex-end',
    },
    runDialogCard: {
      backgroundColor: colors.surface,
      borderTopLeftRadius: 22,
      borderTopRightRadius: 22,
      maxHeight: '88%',
      borderWidth: 1,
      borderColor: withAlpha(colors.primary, 0.22),
    },
    runDialogHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: SPACING.lg,
      paddingTop: SPACING.lg,
    },
    runDialogTitle: { ...TYPOGRAPHY.heading, color: colors.text, fontSize: 16, flex: 1 },
    runDialogSubtitle: {
      ...TYPOGRAPHY.small,
      color: colors.textMuted,
      paddingHorizontal: SPACING.lg,
      marginTop: 2,
    },
    runDialogBody: { paddingHorizontal: SPACING.lg, paddingTop: SPACING.md },
    runDialogInfo: {
      ...TYPOGRAPHY.small,
      color: colors.textMuted,
      fontStyle: 'italic',
      marginBottom: SPACING.sm,
    },
    runDialogError: {
      marginTop: SPACING.sm,
      padding: SPACING.md,
      borderRadius: 10,
      backgroundColor: withAlpha(colors.error, 0.12),
      borderWidth: 1,
      borderColor: withAlpha(colors.error, 0.4),
    },
    runDialogErrorText: { ...TYPOGRAPHY.small, color: colors.error },

    runDialogFooter: {
      flexDirection: 'row',
      gap: SPACING.sm,
      paddingHorizontal: SPACING.lg,
      paddingVertical: SPACING.md,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: withAlpha(colors.primary, 0.18),
    },
    runDialogSecondaryBtn: {
      flex: 1,
      paddingVertical: 12,
      alignItems: 'center',
      borderRadius: 12,
      borderWidth: 1,
      borderColor: withAlpha(colors.primary, 0.22),
    },
    runDialogSecondaryText: {
      ...TYPOGRAPHY.body,
      color: colors.textSecondary,
      fontWeight: '600',
    },
    runDialogPrimaryBtn: {
      flex: 2,
      flexDirection: 'row',
      paddingVertical: 12,
      alignItems: 'center',
      justifyContent: 'center',
      gap: 6,
      borderRadius: 12,
      backgroundColor: colors.primary,
    },
    runDialogPrimaryText: {
      ...TYPOGRAPHY.body,
      color: colors.background || '#000',
      fontWeight: '700',
    },

    boolToggle: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      paddingVertical: 10,
      paddingHorizontal: SPACING.md,
      borderRadius: 10,
      borderWidth: 1,
      borderColor: withAlpha(colors.primary, 0.18),
      backgroundColor: withAlpha(colors.surfaceTint || '#000', 0.2),
    },
    boolToggleText: { ...TYPOGRAPHY.body, fontWeight: '600' },

    selectRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
    selectChip: {
      paddingHorizontal: SPACING.md,
      paddingVertical: 8,
      borderRadius: 14,
      borderWidth: 1,
      borderColor: withAlpha(colors.primary, 0.18),
      backgroundColor: withAlpha(colors.surfaceTint || '#000', 0.2),
    },
    selectChipText: { ...TYPOGRAPHY.small, fontWeight: '600' },

    preflightPill: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      paddingHorizontal: SPACING.md,
      paddingVertical: 8,
      borderRadius: 10,
      borderWidth: 1,
      marginTop: SPACING.sm,
    },
    preflightText: { ...TYPOGRAPHY.small, flex: 1 },
  });
}

function makeMarkdownStyles(colors) {
  return {
    body: {
      color: colors.text,
      fontFamily: FONT_FAMILY.regular,
      fontSize: 15,
      lineHeight: 23,
    },
    heading1: {
      color: colors.text,
      fontFamily: FONT_FAMILY.display || FONT_FAMILY.bold,
      fontSize: 26,
      lineHeight: 32,
      marginTop: 10,
      marginBottom: 8,
      letterSpacing: -0.4,
    },
    heading2: {
      color: colors.text,
      fontFamily: FONT_FAMILY.bold,
      fontSize: 21,
      lineHeight: 26,
      marginTop: 14,
      marginBottom: 6,
    },
    heading3: {
      color: colors.text,
      fontFamily: FONT_FAMILY.bold,
      fontSize: 17,
      lineHeight: 23,
      marginTop: 10,
      marginBottom: 4,
    },
    paragraph: { color: colors.text, marginBottom: 8 },
    list_item: { color: colors.text },
    bullet_list: { marginBottom: 6 },
    ordered_list: { marginBottom: 6 },
    code_inline: {
      backgroundColor: withAlpha(colors.surfaceTint || '#000', 0.35),
      color: colors.primary,
      fontFamily: FONT_FAMILY.mono || 'monospace',
      paddingHorizontal: 4,
      borderRadius: 4,
    },
    fence: {
      backgroundColor: withAlpha(colors.surfaceTint || '#000', 0.42),
      color: colors.text,
      fontFamily: FONT_FAMILY.mono || 'monospace',
      padding: SPACING.md,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: withAlpha(colors.primary, 0.2),
    },
    code_block: {
      backgroundColor: withAlpha(colors.surfaceTint || '#000', 0.42),
      color: colors.text,
      fontFamily: FONT_FAMILY.mono || 'monospace',
      padding: SPACING.md,
      borderRadius: 8,
    },
    blockquote: {
      backgroundColor: withAlpha(colors.primary, 0.08),
      borderLeftWidth: 3,
      borderLeftColor: colors.primary,
      paddingHorizontal: SPACING.md,
      paddingVertical: SPACING.sm,
      marginVertical: 6,
    },
    link: { color: colors.primary },
    hr: {
      backgroundColor: withAlpha(colors.primary, 0.3),
      height: 1,
      marginVertical: 12,
    },
    table: {
      borderWidth: 1,
      borderColor: withAlpha(colors.primary, 0.25),
      borderRadius: 8,
    },
    th: { backgroundColor: withAlpha(colors.primary, 0.12), padding: 6 },
    td: { padding: 6 },
  };
}

export default WorkflowsScreen;
