/**
 * TerminalsScreen — live PTY terminals, federation-aware.
 *
 * Lists every PTY the gateway is hosting via `terminal.list`, plus terminals
 * running on remote federation nodes. Subscribes to `terminal.output` /
 * `terminal.exit` for live streaming.
 *
 * Output is rendered by xterm.js (via XtermTerminal — a WebView bridge).
 * All open terminals stay mounted in a horizontal swipe pager so switching
 * between them is instant and WebView re-init is avoided.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  TextInput,
  ScrollView,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  Dimensions,
  Keyboard,
  TouchableWithoutFeedback,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { METHOD, EVENT } from '../constants/gateway';
import {
  TERMINAL_COLORS as C,
  TERMINAL_FONTS as F,
  TERMINAL_SPACING as S,
  TERMINAL_SHADOWS,
} from '../constants/terminal-theme';
import { XtermTerminal } from '../components/XtermTerminal';
import { useFederatedTerminals } from '../hooks/useFederatedTerminals';
import { FederationPicker } from '../components/FederationPicker';
import { TerminalCallButton } from '../components/TerminalCallButton';
import { DOCK_BOTTOM_SPACE } from '../components/FloatingDock';
import { COLORS } from '../constants/theme';
import { useTerminalPanels } from '../terminals/useTerminalPanels';
import { FIRST_WORKSPACE } from '../terminals/panels';

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window');

// First-paint fallback height for the horizontal terminal pager, used only
// until the flex:1 wrapper reports its real measured height via onLayout.
// The screen no longer page-scrolls (that stole vertical drags away from the
// terminal's own xterm scrollback) — the terminal area now flexes to fill the
// space between the header and the input pill and owns all vertical gestures.
const TERM_PAGE_HEIGHT = Math.max(SCREEN_HEIGHT - 300, 360);

// ── Helpers ──────────────────────────────────────────────────

const MAX_BUFFER_CHARS = 80_000;

function trimBuffer(buf) {
  if (buf.length <= MAX_BUFFER_CHARS) return buf;
  return buf.slice(buf.length - MAX_BUFFER_CHARS);
}

const LOCAL_NODE_ID = 'local';
// Per-node "last active terminal" map. Persisted so returning to a node (or
// relaunching the app) restores the PTY the user had open on that node.
const ACTIVE_BY_NODE_KEY = '@infinibot/terminals_active_by_node';

const CLI_OPTIONS = [
  { id: 'shell',    label: 'Shell',    icon: 'console',          color: C.gold },
  { id: 'claude',   label: 'Claude',   icon: 'star-four-points', color: '#a78bfa' },
  { id: 'opencode', label: 'OpenCode', icon: 'code-tags',        color: '#22c55e' },
  { id: 'codex',    label: 'Codex',    icon: 'robot-outline',    color: '#f59e0b' },
  { id: 'gemini',   label: 'Gemini',   icon: 'diamond-stone',    color: '#3b82f6' },
  { id: 'grok',     label: 'Grok',     icon: 'alpha-x-box-outline', color: '#f43f5e' },
];

const STATUS_COLORS = {
  idle: C.textDim,
  running: C.ok,
  'claude-active': '#a78bfa',
  exited: C.danger,
};

function shortId(id) {
  if (!id) return '';
  return id.length > 14 ? `${id.slice(0, 6)}…${id.slice(-4)}` : id;
}

function generateTerminalId() {
  return `term-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// ── Glass Pill ───────────────────────────────────────────────
// Layered glass: BlurView + dark tint + top highlight + gold-accented border.
// Matches FloatingDock / ChatScreen GlassHeader visual language.

function GlassPill({ children, style, radius = 18, blurIntensity: blurProp = 75 }) {
  const intensity = Platform.OS === 'android' ? Math.min(blurProp, 65) : blurProp;
  return (
    <View style={[gpStyles.shadow, { borderRadius: radius }, style]}>
      <View style={[gpStyles.clip, { borderRadius: radius }]}>
        <BlurView intensity={intensity} tint="dark" style={StyleSheet.absoluteFill} />
        <View style={[StyleSheet.absoluteFill, gpStyles.tint]} />
        <LinearGradient
          colors={['rgba(255,255,255,0.08)', 'rgba(255,255,255,0.00)']}
          start={{ x: 0, y: 0 }}
          end={{ x: 0, y: 0.55 }}
          style={StyleSheet.absoluteFill}
          pointerEvents="none"
        />
        <View
          style={[StyleSheet.absoluteFill, gpStyles.border, { borderRadius: radius }]}
          pointerEvents="none"
        />
        {children}
      </View>
    </View>
  );
}

const gpStyles = StyleSheet.create({
  shadow: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.42,
    shadowRadius: 18,
    elevation: 12,
  },
  clip: {
    overflow: 'hidden',
    backgroundColor: Platform.OS === 'android' ? 'rgba(10,10,16,0.88)' : 'transparent',
  },
  tint: {
    backgroundColor: 'rgba(10,10,18,0.50)',
  },
  border: {
    borderWidth: 1,
    borderTopColor: 'rgba(255,255,255,0.12)',
    borderLeftColor: 'rgba(255,255,255,0.05)',
    borderRightColor: 'rgba(255,255,255,0.05)',
    borderBottomColor: COLORS.primaryMuted,
  },
});

// ── Create-Terminal Modal ────────────────────────────────────

function CreateTerminalModal({ visible, onClose, onCreate, recentDirs, nodes, defaultNodeId }) {
  const [cli, setCli] = useState('shell');
  const [cwd, setCwd] = useState('');
  const [name, setName] = useState('');
  const [nodeId, setNodeId] = useState(defaultNodeId || LOCAL_NODE_ID);

  useEffect(() => {
    if (!visible) {
      setCli('shell');
      setCwd('');
      setName('');
      setNodeId(defaultNodeId || LOCAL_NODE_ID);
    }
  }, [visible, defaultNodeId]);

  const handleSubmit = () => {
    onCreate({ cli, cwd: cwd.trim() || '.', name: name.trim(), nodeId });
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={modalStyles.backdrop} onPress={onClose}>
        <Pressable style={modalStyles.sheet} onPress={(e) => e.stopPropagation()}>
          <View style={modalStyles.header}>
            <Ionicons name="terminal" size={16} color={C.gold} />
            <Text style={modalStyles.title}>NEW TERMINAL</Text>
            <TouchableOpacity onPress={onClose} hitSlop={10}>
              <Ionicons name="close" size={18} color={C.textMuted} />
            </TouchableOpacity>
          </View>

          {nodes && nodes.length > 1 && (
            <>
              <Text style={modalStyles.label}>SPAWN ON</Text>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={{ gap: 6 }}
              >
                {nodes.map((n) => {
                  const active = nodeId === n.id;
                  return (
                    <TouchableOpacity
                      key={n.id}
                      onPress={() => setNodeId(n.id)}
                      style={[
                        modalStyles.cliChip,
                        active && { borderColor: C.gold, backgroundColor: C.goldSubtle },
                      ]}
                    >
                      <Ionicons
                        name={n.isLocal || n.id === LOCAL_NODE_ID ? 'home' : 'cloud'}
                        size={12}
                        color={active ? C.gold : C.textDim}
                      />
                      <Text style={[modalStyles.cliText, active && { color: C.gold, fontWeight: '700' }]}>
                        {n.name}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </ScrollView>
            </>
          )}

          <Text style={modalStyles.label}>CLI</Text>
          <View style={modalStyles.cliRow}>
            {CLI_OPTIONS.map((opt) => {
              const active = cli === opt.id;
              return (
                <TouchableOpacity
                  key={opt.id}
                  onPress={() => setCli(opt.id)}
                  style={[
                    modalStyles.cliChip,
                    active && { borderColor: opt.color, backgroundColor: `${opt.color}1A` },
                  ]}
                >
                  <MaterialCommunityIcons
                    name={opt.icon}
                    size={14}
                    color={active ? opt.color : C.textDim}
                  />
                  <Text style={[modalStyles.cliText, active && { color: opt.color, fontWeight: '700' }]}>
                    {opt.label}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>

          <Text style={modalStyles.label}>WORKING DIRECTORY</Text>
          <TextInput
            style={modalStyles.input}
            value={cwd}
            onChangeText={setCwd}
            placeholder="."
            placeholderTextColor={C.textDim}
            autoCapitalize="none"
            autoCorrect={false}
          />
          {recentDirs && recentDirs.length > 0 && (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              style={{ marginTop: 6 }}
              contentContainerStyle={{ gap: 6 }}
            >
              {recentDirs.slice(0, 6).map((d) => (
                <TouchableOpacity key={d} onPress={() => setCwd(d)} style={modalStyles.recentChip}>
                  <Text style={modalStyles.recentText} numberOfLines={1}>{d}</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          )}

          <Text style={modalStyles.label}>NAME (optional)</Text>
          <TextInput
            style={modalStyles.input}
            value={name}
            onChangeText={setName}
            placeholder="auto"
            placeholderTextColor={C.textDim}
            autoCapitalize="none"
          />

          <View style={modalStyles.actions}>
            <TouchableOpacity onPress={onClose} style={modalStyles.btnSecondary}>
              <Text style={modalStyles.btnSecondaryText}>CANCEL</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={handleSubmit} style={modalStyles.btnPrimary}>
              <Ionicons name="add" size={14} color={C.bg0} />
              <Text style={modalStyles.btnPrimaryText}>SPAWN</Text>
            </TouchableOpacity>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

// ── All-Terminals Sheet ──────────────────────────────────────
// Bottom sheet listing every PTY on the currently-selected federation node.
// Surfaces terminals the user didn't spawn locally (e.g. ones started from
// the satellite's desktop UI) so they can switch to any of them in one tap
// instead of swipe-discovering them.

function tailPath(p) {
  if (!p) return '';
  const s = String(p);
  if (s.length <= 28) return s;
  const parts = s.split('/').filter(Boolean);
  if (parts.length <= 2) return `…${s.slice(-26)}`;
  return `…/${parts.slice(-2).join('/')}`;
}

function AllTerminalsSheet({ visible, onClose, terminals, activeId, activeWorkspace, onSelect, nodeName }) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={modalStyles.backdrop} onPress={onClose}>
        <Pressable style={modalStyles.sheet} onPress={(e) => e.stopPropagation()}>
          <View style={modalStyles.header}>
            <Ionicons name="list" size={16} color={C.gold} />
            <Text style={modalStyles.title}>
              {nodeName ? `TERMINALS · ${nodeName.toUpperCase()}` : 'TERMINALS'}
            </Text>
            <TouchableOpacity onPress={onClose} hitSlop={10}>
              <Ionicons name="close" size={18} color={C.textMuted} />
            </TouchableOpacity>
          </View>

          {terminals.length === 0 ? (
            <View style={sheetStyles.empty}>
              <Ionicons name="terminal-outline" size={26} color={C.textDim} />
              <Text style={sheetStyles.emptyTitle}>NO TERMINALS ON THIS DEVICE</Text>
              <Text style={sheetStyles.emptyHint}>Tap + to spawn one.</Text>
            </View>
          ) : (
            <>
              <Text style={sheetStyles.hint}>
                Every panel on this device, across all workspaces. Tap one to
                follow it — switching workspace if it lives in another.
              </Text>
              <ScrollView
                style={sheetStyles.list}
                contentContainerStyle={{ paddingVertical: 4 }}
                showsVerticalScrollIndicator={false}
              >
                {terminals.map((t) => {
                  const cliInfo = CLI_OPTIONS.find((c) => c.id === t.cli) || CLI_OPTIONS[0];
                  const isActive = t.panelId === activeId;
                  const ledColor = STATUS_COLORS[t.status] || C.textDim;
                  return (
                    <TouchableOpacity
                      key={t.panelId}
                      onPress={() => onSelect(t)}
                      style={[sheetStyles.row, isActive && sheetStyles.rowActive]}
                      activeOpacity={0.75}
                    >
                      <View style={[sheetStyles.led, { backgroundColor: ledColor }]} />
                      <View style={sheetStyles.rowMain}>
                        <View style={sheetStyles.rowTitleLine}>
                          <Text
                            style={[sheetStyles.rowTitle, isActive && { color: C.gold }]}
                            numberOfLines={1}
                          >
                            {t.title || cliInfo.label}
                          </Text>
                          <View style={[
                            sheetStyles.cliBadge,
                            { borderColor: `${cliInfo.color}40`, backgroundColor: `${cliInfo.color}14` },
                          ]}>
                            <MaterialCommunityIcons name={cliInfo.icon} size={10} color={cliInfo.color} />
                            <Text style={[sheetStyles.cliBadgeText, { color: cliInfo.color }]}>
                              {cliInfo.label}
                            </Text>
                          </View>
                        </View>
                        <Text style={sheetStyles.rowSub} numberOfLines={1}>
                          {`WS${t.workspace}`}
                          {t.workspace !== activeWorkspace ? ' (elsewhere)' : ''}
                          {t.isMirror ? '  ·  MIRROR' : ''}
                          {'  ·  '}{tailPath(t.cwd)}  ·  {shortId(t.ptyId)}
                        </Text>
                      </View>
                      {isActive && <Ionicons name="checkmark" size={16} color={C.gold} />}
                    </TouchableOpacity>
                  );
                })}
              </ScrollView>
            </>
          )}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

// ── Workspace Bar ────────────────────────────────────────────
// Numbered workspaces, per federation node. A workspace is purely a VIEW
// grouping: moving a panel between workspaces never touches its PTY, so a
// long-running agent can be parked in workspace 3 and left to run while the
// user works in workspace 1.

function WorkspaceBar({ workspaces, active, onSelect, countIn, nextWorkspace, onAddWorkspace }) {
  return (
    <View style={wsStyles.row}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={wsStyles.content}
      >
        {workspaces.map((n) => {
          const isActive = n === active;
          const count = countIn(n);
          return (
            <TouchableOpacity
              key={n}
              onPress={() => onSelect(n)}
              style={[wsStyles.chip, isActive && wsStyles.chipActive]}
              activeOpacity={0.75}
              hitSlop={{ top: 10, bottom: 10, left: 4, right: 4 }}
              accessibilityRole="tab"
              accessibilityState={{ selected: isActive }}
              accessibilityLabel={`Workspace ${n}, ${count} ${count === 1 ? 'panel' : 'panels'}`}
            >
              <Text style={[wsStyles.chipNum, isActive && wsStyles.chipNumActive]}>{n}</Text>
              {count > 0 && (
                <Text style={[wsStyles.chipCount, isActive && wsStyles.chipCountActive]}>
                  {count}
                </Text>
              )}
            </TouchableOpacity>
          );
        })}

        <TouchableOpacity
          onPress={() => onAddWorkspace(nextWorkspace)}
          style={wsStyles.addChip}
          activeOpacity={0.75}
          hitSlop={{ top: 10, bottom: 10, left: 4, right: 4 }}
          accessibilityRole="button"
          accessibilityLabel={`New workspace ${nextWorkspace}`}
        >
          <Ionicons name="add" size={13} color={C.gold} />
        </TouchableOpacity>
      </ScrollView>
    </View>
  );
}

const wsStyles = StyleSheet.create({
  row: { paddingHorizontal: 14, paddingTop: 6 },
  content: { alignItems: 'center', gap: 6, paddingVertical: 2 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    minWidth: 34,
    height: 26,
    paddingHorizontal: 9,
    borderRadius: 13,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.10)',
    backgroundColor: 'rgba(255,255,255,0.04)',
    justifyContent: 'center',
  },
  chipActive: {
    borderColor: COLORS.primaryMuted,
    backgroundColor: COLORS.primaryLight,
  },
  chipNum: { ...F.mono, fontSize: 12, color: C.textMuted },
  chipNumActive: { color: C.gold },
  chipCount: { ...F.mono, fontSize: 12, color: C.textDim },
  chipCountActive: { color: C.gold },
  addChip: {
    width: 30,
    height: 26,
    borderRadius: 13,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: COLORS.primaryMuted,
    alignItems: 'center',
    justifyContent: 'center',
  },
});

// ── Send-to-Workspace Sheet ──────────────────────────────────
// Mirrors the web popover: every existing workspace plus "New workspace N+1".
// Picking one MOVES the panel; the session is never stopped.

function SendToWorkspaceSheet({ visible, onClose, panel, workspaces, current, nextWorkspace, countIn, onSend }) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={modalStyles.backdrop} onPress={onClose}>
        <Pressable style={modalStyles.sheet} onPress={(e) => e.stopPropagation()}>
          <View style={modalStyles.header}>
            <Ionicons name="swap-horizontal" size={16} color={C.gold} />
            <Text style={modalStyles.title}>SEND TO WORKSPACE</Text>
            <TouchableOpacity onPress={onClose} hitSlop={10} accessibilityLabel="Close">
              <Ionicons name="close" size={18} color={C.textMuted} />
            </TouchableOpacity>
          </View>

          <Text style={sendStyles.hint}>
            {panel ? `“${panel.title || 'Terminal'}” keeps running — only the panel moves.` : ''}
          </Text>

          <ScrollView style={sendStyles.list} showsVerticalScrollIndicator={false}>
            {workspaces.map((n) => {
              const here = n === current;
              const count = countIn(n);
              return (
                <TouchableOpacity
                  key={n}
                  disabled={here}
                  onPress={() => onSend(n)}
                  style={[sendStyles.row, here && sendStyles.rowHere]}
                  activeOpacity={0.75}
                  accessibilityRole="button"
                  accessibilityState={{ disabled: here }}
                  accessibilityLabel={
                    here ? `Workspace ${n}, this panel is already here`
                         : `Move to workspace ${n}`
                  }
                >
                  <View style={sendStyles.num}>
                    <Text style={sendStyles.numText}>{n}</Text>
                  </View>
                  <Text style={[sendStyles.rowLabel, here && { color: C.textMuted }]}>
                    Workspace {n}
                  </Text>
                  <Text style={sendStyles.rowMeta}>
                    {here ? 'HERE' : `${count} ${count === 1 ? 'panel' : 'panels'}`}
                  </Text>
                </TouchableOpacity>
              );
            })}

            <TouchableOpacity
              onPress={() => onSend(nextWorkspace)}
              style={[sendStyles.row, sendStyles.rowNew]}
              activeOpacity={0.75}
              accessibilityRole="button"
              accessibilityLabel={`Move to a new workspace ${nextWorkspace}`}
            >
              <View style={sendStyles.num}>
                <Ionicons name="add" size={13} color={C.gold} />
              </View>
              <Text style={[sendStyles.rowLabel, { color: C.gold }]}>
                New workspace {nextWorkspace}
              </Text>
            </TouchableOpacity>
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const sendStyles = StyleSheet.create({
  hint: { ...F.body, fontSize: 12, color: C.textMuted, paddingHorizontal: 14, paddingBottom: 8 },
  list: { maxHeight: 320, paddingHorizontal: 8 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    minHeight: 44,
    paddingHorizontal: 8,
    borderRadius: 10,
  },
  rowHere: { opacity: 0.55 },
  rowNew: {
    marginTop: 4,
    borderTopWidth: 1,
    borderTopColor: 'rgba(255,255,255,0.06)',
  },
  num: {
    width: 24,
    height: 24,
    borderRadius: 7,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
    backgroundColor: 'rgba(255,255,255,0.06)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  numText: { ...F.mono, fontSize: 12, color: C.gold },
  rowLabel: { ...F.body, fontSize: 13, color: C.text, flex: 1 },
  rowMeta: { ...F.mono, fontSize: 12, color: C.textDim },
});

// ── Main Screen ──────────────────────────────────────────────

export function TerminalsScreen({ navigation, gateway }) {
  const { sendReq, status, subscribeEvent } = gateway;
  const fed = useFederatedTerminals(gateway);
  const {
    terminals,
    setTerminals,
    loading,
    nodes,
    federation,
    refresh: refreshTerminals,
    invokeOnNode,
    invokeOnNodeId,
    nodeFor,
  } = fed;
  const selectedNodeId = federation.selectedNodeId;

  const insets = useSafeAreaInsets();

  // ── Panel model ────────────────────────────────────────────
  // A PTY (owned by the gateway) and a panel (a view of it, owned by us) are
  // two different things. That separation is what lets a panel move between
  // numbered workspaces without a teardown, and lets a duplicate be closed
  // without killing the session it shares. All of the logic lives in
  // src/terminals/panels.js (pure + unit-tested); this hook is the binding.
  const destroyPtyOnNode = useCallback(
    (ptyId, ptyNodeId) =>
      invokeOnNodeId(ptyNodeId || LOCAL_NODE_ID, METHOD.TERMINAL_DESTROY, { id: ptyId }),
    [invokeOnNodeId],
  );
  const panelModel = useTerminalPanels({
    terminals,
    nodeId: selectedNodeId,
    destroyPty: destroyPtyOnNode,
  });
  const {
    visiblePanels,
    nodePanels,
    workspaces,
    activeWorkspace,
    nextWorkspace,
    setActiveWorkspace,
    countIn: panelCountIn,
    targetsForPty,
    adoptPanel,
    sendToWorkspace,
    duplicate: duplicatePanelView,
    close: closePanelView,
    focusAfter,
  } = panelModel;

  // Panel id whose "send to workspace" sheet is open (or null).
  const [sendMenuFor, setSendMenuFor] = useState(null);

  // Per-node active terminal memory. Switching nodes preserves what was
  // selected on each one, so A → B → A returns to the same PTY on A. The
  // map is persisted to AsyncStorage so the memory survives screen-pop +
  // relaunch.
  const [activeByNode, setActiveByNode] = useState({});
  const [activeByNodeLoaded, setActiveByNodeLoaded] = useState(false);
  // Holds a PANEL id, not a PTY id. For an ordinary panel the two are equal
  // (panelId === ptyId), so previously-persisted values still resolve; only a
  // duplicated panel has an id the gateway has never heard of.
  //
  // Use a stable "no current selection" sentinel for the derived activeId so
  // downstream effects can distinguish "no nodes/terminals yet" from "user
  // explicitly cleared selection on this node".
  const activeId = activeByNode[selectedNodeId] || null;
  const setActiveId = useCallback(
    (idOrUpdater) => {
      setActiveByNode((prev) => {
        const current = prev[selectedNodeId] || null;
        const next = typeof idOrUpdater === 'function' ? idOrUpdater(current) : idOrUpdater;
        if (current === next) return prev;
        return { ...prev, [selectedNodeId]: next };
      });
    },
    [selectedNodeId],
  );

  const [showCreate, setShowCreate] = useState(false);
  const [showAllSheet, setShowAllSheet] = useState(false);
  const [error, setError] = useState(null);
  const [recentDirs, setRecentDirs] = useState([]);
  const [input, setInput] = useState('');
  const [keyboardVisible, setKeyboardVisible] = useState(false);
  // Measured height of the terminal area. The horizontal pager needs an
  // explicit height for its WebView pages (a horizontal ScrollView won't
  // stretch children on the cross axis reliably), so we measure the flex:1
  // wrapper via onLayout and feed it back down. TERM_PAGE_HEIGHT is only a
  // first-paint fallback until the real measurement lands.
  const [pagerHeight, setPagerHeight] = useState(0);

  // Track keyboard visibility so the input pill can sit flush against the
  // keyboard top (no dock-clearance margin while typing) and so a
  // dismiss-keyboard chevron can render on demand.
  useEffect(() => {
    const showEvt = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvt = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const subShow = Keyboard.addListener(showEvt, () => setKeyboardVisible(true));
    const subHide = Keyboard.addListener(hideEvt, () => setKeyboardVisible(false));
    return () => { subShow.remove(); subHide.remove(); };
  }, []);

  // ── Load + persist activeByNode map ─────────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const raw = await AsyncStorage.getItem(ACTIVE_BY_NODE_KEY);
        if (cancelled) return;
        if (raw) {
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed === 'object') setActiveByNode(parsed);
        }
      } catch {
        // Corrupt entry — fall through; next setItem will overwrite.
      } finally {
        if (!cancelled) setActiveByNodeLoaded(true);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!activeByNodeLoaded) return;
    AsyncStorage.setItem(ACTIVE_BY_NODE_KEY, JSON.stringify(activeByNode))
      .catch((err) => console.debug('[terminals] persist active-by-node failed:', err?.message));
  }, [activeByNode, activeByNodeLoaded]);

  // One imperative handle per mounted terminal (keeps all WebViews alive across swipes).
  const termRefsMap = useRef({});
  const activeIdRef = useRef(null);
  // Per-id scrollback mirror (ref, not state — avoids re-render on every PTY chunk).
  const buffersRef = useRef({});
  const hydratedRef = useRef(new Set());

  // Pager
  const pagerRef = useRef(null);
  const isScrollingRef = useRef(false);

  useEffect(() => {
    activeIdRef.current = activeId;
  }, [activeId]);

  // The active PANEL, and the PTY it points at. Every gateway call
  // (write/resize/destroy) must target `ptyId`; every view lookup (xterm
  // handle, pager index, React key) must use `panelId`.
  const activePanel = visiblePanels.find((p) => p.panelId === activeId) || null;
  const activePtyRef = useRef(null);
  useEffect(() => {
    activePtyRef.current = activePanel
      ? { ptyId: activePanel.ptyId, nodeId: activePanel.nodeId }
      : null;
  }, [activePanel]);

  // Live mirror of the visible panel list for event handlers that must not
  // re-subscribe on every panel change.
  const visiblePanelsRef = useRef(visiblePanels);
  useEffect(() => {
    visiblePanelsRef.current = visiblePanels;
  }, [visiblePanels]);

  // Write a chunk of PTY output to EVERY panel currently mirroring that PTY.
  //
  // The gateway tags output with the PTY id. Scrollback is therefore buffered
  // per PTY (one shared history, so a mirror opened later replays the same
  // thing), while xterm handles stay keyed by panel id so each mirror gets its
  // own live view. For the ordinary 1:1 case both keys are the same id and the
  // behaviour is identical to before.
  const appendOutput = useCallback((ptyId, data) => {
    if (!ptyId || !data) return;
    const prev = buffersRef.current[ptyId] || '';
    buffersRef.current[ptyId] = trimBuffer(prev + data);
    for (const panelId of targetsForPty(ptyId)) {
      const handle = termRefsMap.current[panelId];
      if (handle) handle.write(data);
    }
  }, [targetsForPty]);

  // ── Live event subscriptions ────────────────────────────────
  useEffect(() => {
    if (!subscribeEvent) return;

    const unsubOutput = subscribeEvent(EVENT.TERMINAL_OUTPUT, (payload) => {
      if (!payload) return;
      const termId = payload.terminalId || payload.id;
      const data = payload.data;
      if (termId && typeof data === 'string') appendOutput(termId, data);
    });

    const unsubExit = subscribeEvent(EVENT.TERMINAL_EXIT, (payload) => {
      if (!payload) return;
      const termId = payload.terminalId || payload.id;
      if (!termId) return;
      const code = payload.exitCode;
      appendOutput(termId, `\r\n[process exited with code ${code ?? 0}]\r\n`);
      setTerminals((prev) => {
        const next = prev.map((t) => (t.id === termId ? { ...t, status: 'exited' } : t));
        // If a panel showing the exited PTY was the active one, fall back to a
        // live sibling PANEL in the same workspace so the UI doesn't strand the
        // user on a dead terminal. Panels are the unit here: several may point
        // at the PTY that just died, and each is a separate selection.
        const dead = new Set(
          visiblePanelsRef.current
            .filter((p) => p.ptyId === termId)
            .map((p) => p.panelId),
        );
        if (dead.size) {
          setActiveByNode((prevMap) => {
            let changed = false;
            const nextMap = { ...prevMap };
            for (const [nodeId, currentId] of Object.entries(prevMap)) {
              if (!dead.has(currentId)) continue;
              const sibling = visiblePanelsRef.current.find(
                (p) => !dead.has(p.panelId) && p.status !== 'exited',
              );
              nextMap[nodeId] = sibling?.panelId || null;
              changed = true;
            }
            return changed ? nextMap : prevMap;
          });
        }
        return next;
      });
    });

    return () => { unsubOutput?.(); unsubExit?.(); };
  }, [subscribeEvent, appendOutput, setTerminals]);

  // ── Federation-filtered view: only terminals on the selected node ──
  // The global `terminals` list still drives event subscriptions, scrollback
  // hydration, and per-terminal routing (each terminal carries its own
  // nodeId). The user-visible pager / dots / empty state work off the
  // filtered subset so switching nodes acts like browsing that node's PTYs.
  // `visiblePanels` (from useTerminalPanels) is the panel-scoped equivalent:
  // this node AND this numbered workspace, each entry carrying both its
  // `panelId` (view key) and its `ptyId` (what every gateway call must use).
  const visibleTerminals = visiblePanels;

  // ── Pick active terminal from the visible subset ────────────
  // Only auto-pick if the remembered choice for this node isn't in the
  // current visible set (was destroyed, never existed, etc). Otherwise leave
  // the user's prior selection alone — that's what makes node switching feel
  // sticky instead of resetting to terminal #0 every time.
  useEffect(() => {
    if (!activeByNodeLoaded) return;
    setActiveId((prev) => {
      if (prev && visibleTerminals.find((t) => t.panelId === prev)) return prev;
      return visibleTerminals[0]?.panelId || null;
    });
  }, [visibleTerminals, activeByNodeLoaded, setActiveId]);

  // ── Re-fetch when the user switches federation node ─────────
  // Only refetch the per-node terminal list; node roster refresh is owned by
  // useFederation (15s poll + on-connect). Re-triggering it here caused
  // back-to-back nodes-array updates that thrashed the picker mid-animation.
  useEffect(() => {
    if (status !== 'connected') return;
    refreshTerminals?.();
  }, [selectedNodeId]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Scroll pager to active terminal ────────────────────────
  useEffect(() => {
    if (!pagerRef.current || visibleTerminals.length <= 1) return;
    const idx = visibleTerminals.findIndex((t) => t.panelId === activeId);
    if (idx < 0) return;
    isScrollingRef.current = true;
    pagerRef.current.scrollTo({ x: idx * SCREEN_WIDTH, animated: false });
    setTimeout(() => { isScrollingRef.current = false; }, 120);
  }, [activeId, visibleTerminals.length]);

  // ── Hydrate gateway-side scrollback for newly-seen terminals ──
  useEffect(() => {
    if (!sendReq || status !== 'connected') return;
    let cancelled = false;
    (async () => {
      for (const t of terminals) {
        if (hydratedRef.current.has(t.id)) continue;
        if (buffersRef.current[t.id]) { hydratedRef.current.add(t.id); continue; }
        const node =
          nodes.find((n) => n.id === t.nodeId) ||
          { id: LOCAL_NODE_ID, isLocal: true, name: 'Local' };
        try {
          const buf = await invokeOnNode(node, METHOD.TERMINAL_GET_BUFFER, { id: t.id });
          if (cancelled) return;
          if (buf?.buffer) {
            const live = buffersRef.current[t.id] || '';
            const full = trimBuffer(String(buf.buffer) + live);
            buffersRef.current[t.id] = full;
            // Replay into every panel currently mirroring this PTY.
            for (const panelId of targetsForPty(t.id)) {
              const handle = termRefsMap.current[panelId];
              if (handle) { handle.clear(); handle.write(full); }
            }
          }
          hydratedRef.current.add(t.id);
        } catch {
          // Non-fatal — events will fill the buffer as the PTY writes.
        }
      }
    })();
    return () => { cancelled = true; };
  }, [terminals, sendReq, status, nodes, invokeOnNode, targetsForPty]);

  // ── Actions ────────────────────────────────────────────────
  const handleCreate = useCallback(async ({ cli, cwd, name, nodeId }) => {
    if (!sendReq) return;
    setShowCreate(false);
    const id = generateTerminalId();
    const node =
      nodes.find((n) => n.id === nodeId) ||
      { id: LOCAL_NODE_ID, isLocal: true, name: 'Local' };
    const optimistic = {
      id,
      title: name || `${cli} #${terminals.filter((t) => t.cli === cli).length + 1}`,
      cli,
      cwd,
      status: 'idle',
      createdAt: new Date().toISOString(),
      nodeId: node.id,
      nodeName: node.name,
      isLocal: node.isLocal === true || node.id === LOCAL_NODE_ID,
    };
    setTerminals((prev) => [...prev, optimistic]);
    // Spawn target may not be the currently-viewed node. Record this id as
    // the active terminal under its OWN node, then switch the view to that
    // node so the user immediately sees the new PTY.
    // Adopt the new PTY as a panel in the workspace the user is currently in,
    // rather than always landing it in workspace 1.
    adoptPanel(id, node.id, node.id === selectedNodeId ? activeWorkspace : FIRST_WORKSPACE);
    setActiveByNode((prev) => ({ ...prev, [node.id]: id }));
    if (node.id !== selectedNodeId) {
      try { federation.selectNode?.(node.id); } catch {}
    }
    buffersRef.current[id] = '';
    if (cwd && cwd !== '.') {
      setRecentDirs((prev) => [cwd, ...prev.filter((d) => d !== cwd)].slice(0, 8));
    }

    try {
      const res = await invokeOnNode(node, METHOD.TERMINAL_CREATE, {
        id, cwd, cols: 80, rows: 24,
      });
      if (res && res.success === false) throw new Error(res.error || 'create failed');
      setTerminals((prev) => prev.map((t) => (t.id === id ? { ...t, status: 'running' } : t)));

      if (cli !== 'shell') {
        try {
          await invokeOnNode(node, METHOD.TERMINAL_AGENT_INVOKE, { id, cli, options: {} });
          setTerminals((prev) =>
            prev.map((t) => (t.id === id ? { ...t, status: 'claude-active' } : t))
          );
        } catch {
          try {
            await invokeOnNode(node, METHOD.TERMINAL_WRITE, { id, data: `${cli}\r` });
          } catch { /* ignore */ }
        }
      }
    } catch (err) {
      setError(err?.message || 'Failed to create terminal');
      setTerminals((prev) => prev.filter((t) => t.id !== id));
      delete buffersRef.current[id];
    }
  }, [sendReq, terminals, nodes, invokeOnNode, setTerminals, federation, selectedNodeId,
      adoptPanel, activeWorkspace]);

  /**
   * Close a PANEL — reference-counted.
   *
   * If other panels still show this PTY (a duplicate, possibly sitting in
   * another workspace), this only detaches THIS view: no confirm, no
   * terminal.destroy, and the shared scrollback buffer is left alone so the
   * surviving panels keep their history. Only the LAST panel referencing a PTY
   * actually kills the process, and only that path asks for confirmation.
   */
  const handleClose = useCallback((panelId) => {
    if (!sendReq) return;
    const panel = visiblePanelsRef.current.find((p) => p.panelId === panelId)
      || nodePanels.find((p) => p.panelId === panelId);
    if (!panel) return;

    const detachOnly = (panel.refs || 1) > 1;

    const finish = async () => {
      // Pick the successor BEFORE the panel leaves the list.
      const successor = focusAfter(panelId);
      const res = await closePanelView(panelId);
      setActiveByNode((prev) => {
        let changed = false;
        const next = { ...prev };
        for (const [nodeId, currentId] of Object.entries(prev)) {
          if (currentId !== panelId) continue;
          next[nodeId] = successor;
          changed = true;
        }
        return changed ? next : prev;
      });
      // Only tear down the shared scrollback when the PTY itself is gone.
      if (res.destroyed) {
        delete buffersRef.current[res.ptyId];
        hydratedRef.current.delete(res.ptyId);
      } else {
        setError(null);
      }
      delete termRefsMap.current[panelId];
    };

    if (detachOnly) {
      // Nothing is destroyed, so there is nothing to confirm.
      finish();
      return;
    }

    Alert.alert(
      'Close terminal',
      'This is the last panel showing this session. Closing it will kill the PTY process. Continue?',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Close', style: 'destructive', onPress: finish },
      ],
    );
  }, [sendReq, nodePanels, focusAfter, closePanelView]);

  /**
   * Mirror the panel: a second panel driven by the SAME live PTY. No
   * terminal.create is issued, so no new process is spawned — and closing
   * either mirror afterwards only detaches it (see handleClose).
   */
  const handleDuplicate = useCallback((panelId) => {
    const res = duplicatePanelView(panelId);
    if (res.error) { setError(res.error); return; }
    setActiveId(res.panelId);
  }, [duplicatePanelView, setActiveId]);

  /**
   * Send a panel to another numbered workspace WITHOUT killing its session.
   * Nothing is sent to the gateway: the PTY keeps running, only the panel's
   * workspace assignment moves. The panel vanishes from here and is waiting,
   * with its scrollback intact, when the user switches to the destination.
   */
  const handleSendToWorkspace = useCallback((panelId, target) => {
    const successor = focusAfter(panelId);
    sendToWorkspace(panelId, target);
    setSendMenuFor(null);
    setActiveByNode((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const [nodeId, currentId] of Object.entries(prev)) {
        if (currentId !== panelId) continue;
        next[nodeId] = successor;
        changed = true;
      }
      return changed ? next : prev;
    });
  }, [focusAfter, sendToWorkspace]);

  /** Follow a panel into its workspace (from the all-panels index). */
  const handleGoToPanel = useCallback((panel) => {
    setActiveWorkspace(panel.workspace);
    setActiveId(panel.panelId);
  }, [setActiveWorkspace, setActiveId]);

  const sendInput = useCallback(async (data) => {
    // Keyed on the active panel's PTY: typing into a mirror drives the shared
    // session, exactly as it does in the panel it was duplicated from.
    const target = activePtyRef.current;
    if (!sendReq || !target || !data) return;
    try {
      const node = nodeFor(target.ptyId);
      await invokeOnNodeId(
        node?.id || target.nodeId || LOCAL_NODE_ID,
        METHOD.TERMINAL_WRITE,
        { id: target.ptyId, data },
      );
    } catch (err) {
      setError(err?.message || 'Send failed');
    }
  }, [sendReq, nodeFor, invokeOnNodeId]);

  const handleSubmit = useCallback(() => {
    if (!input) return;
    sendInput(`${input}\r`);
    setInput('');
  }, [input, sendInput]);

  const sendResize = useCallback(async (cols, rows) => {
    const target = activePtyRef.current;
    if (!sendReq || !target || !cols || !rows) return;
    try {
      const node = nodeFor(target.ptyId);
      await invokeOnNodeId(
        node?.id || target.nodeId || LOCAL_NODE_ID,
        METHOD.TERMINAL_RESIZE,
        { id: target.ptyId, cols, rows },
      );
    } catch (err) {
      console.debug('[terminals] resize failed:', err?.message || err);
    }
  }, [sendReq, nodeFor, invokeOnNodeId]);

  const xtermTheme = useMemo(() => ({
    background: C.bg0,
    foreground: C.text,
    cursor: C.gold,
    cursorAccent: C.bg0,
    selectionBackground: COLORS.primaryStrong,
  }), []);

  const keys = useMemo(() => ([
    { label: '↵',   bytes: '\r' },
    { label: 'TAB', bytes: '\t' },
    { label: 'ESC', bytes: '\x1b' },
    { label: '↑',   bytes: '\x1b[A' },
    { label: '↓',   bytes: '\x1b[B' },
    { label: '←',   bytes: '\x1b[D' },
    { label: '→',   bytes: '\x1b[C' },
    { label: '^C',  bytes: '\x03' },
    { label: '^D',  bytes: '\x04' },
    { label: '^L',  bytes: '\x0c' },
  ]), []);

  const activeTerminal = activePanel;
  const activeIndex = visibleTerminals.findIndex((t) => t.panelId === activeId);
  const hasMultipleNodes = nodes.length > 1;

  const onPagerScrollEnd = useCallback((e) => {
    if (isScrollingRef.current) return;
    const idx = Math.round(e.nativeEvent.contentOffset.x / SCREEN_WIDTH);
    const term = visibleTerminals[idx];
    if (term && term.panelId !== activeId) setActiveId(term.panelId);
  }, [visibleTerminals, activeId]);

  // The input pill is the last child of the flex column (no page scroll), so it
  // must clear the floating dock + safe area itself when idle, and hug the
  // keyboard top (tiny gap) while typing.
  const bottomMargin = keyboardVisible ? 6 : DOCK_BOTTOM_SPACE + insets.bottom + 8;

  // ── Render ─────────────────────────────────────────────────
  if (status !== 'connected') {
    return (
      <View style={styles.center}>
        <Ionicons name="cloud-offline-outline" size={40} color={C.textDim} />
        <Text style={styles.emptyText}>Not connected to gateway</Text>
      </View>
    );
  }

  const cliInfo = activeTerminal
    ? CLI_OPTIONS.find((c) => c.id === activeTerminal.cli) || CLI_OPTIONS[0]
    : null;

  // Stale = node is in the roster but its connection state isn't reporting
  // healthy. We still show its terminals (the user may want to read the
  // last-known scrollback) but flag the node pill so it's obvious the
  // session is detached and writes will fail.
  const activeNodeMeta = activeTerminal
    ? nodes.find((n) => n.id === activeTerminal.nodeId)
    : null;
  const isActiveNodeStale = !!activeNodeMeta
    && !activeNodeMeta.isLocal
    && activeNodeMeta.status !== 'online'
    && activeNodeMeta.status !== 'registered'
    && activeNodeMeta.status !== 'connected';

  return (
    <View style={styles.container}>
      {/* ── Flex column layout (no page scroll) ─────────────────
         The terminal screen does NOT wrap its body in a vertical
         ScrollView: doing so stole vertical drag gestures from the
         terminal's own xterm scrollback, making history scroll
         unreliable. Instead the header sits on top, the terminal
         area flexes to fill the middle and owns all vertical
         gestures, and the quick-keys + input pills pin to the
         bottom. The horizontal pager keeps its own gesture via
         pagingEnabled + directionalLockEnabled. */}
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        keyboardVerticalOffset={0}
      >

      {/* ── Floating glass header pill ──────────────────────── */}
      {/*
        Two-row layout:
          Row 1 — chrome (back · title · count · LED · federation · refresh · close · add).
          Row 2 — metadata strip (CLI badge · node pill · STALE tag), only when
                  there's an active terminal AND there's something to show.
        This keeps Row 1 stable + glanceable at every width; long node names
        and the CLI label can no longer collide with FederationPicker or the
        trailing icon buttons.
      */}
      <GlassPill style={styles.headerPill} radius={20}>
        <View style={styles.headerCol}>
          <View style={styles.headerRow}>
            <TouchableOpacity
              onPress={() => navigation?.goBack?.()}
              style={styles.iconBtn}
              hitSlop={8}
              activeOpacity={0.7}
            >
              <Ionicons name="chevron-back" size={18} color={C.textMuted} />
            </TouchableOpacity>

            <View style={styles.headerCenter}>
              <Ionicons name="terminal" size={12} color={C.gold} />
              <Text style={styles.headerTitle} numberOfLines={1}>TERMINALS</Text>

              {visibleTerminals.length > 0 && (
                <TouchableOpacity
                  onPress={() => setShowAllSheet(true)}
                  style={styles.countBadge}
                  hitSlop={6}
                  activeOpacity={0.7}
                >
                  <Ionicons name="list" size={10} color={C.gold} />
                  <Text style={styles.countBadgeText}>{visibleTerminals.length}</Text>
                </TouchableOpacity>
              )}

              {activeTerminal && (
                <View style={[
                  styles.statusLed,
                  { backgroundColor: STATUS_COLORS[activeTerminal.status] || C.textDim },
                  activeTerminal.status === 'running' && TERMINAL_SHADOWS.status,
                ]} />
              )}
            </View>

            {/* Federation node picker — controls which gateway's terminals
                this screen is browsing. Existing per-terminal routing uses
                each terminal's own nodeId, so input still flows to the right
                PTY no matter what's selected here. */}
            <View style={styles.fedSlot}>
              <FederationPicker federation={federation} compact />
            </View>

            {activeTerminal && (
              <TerminalCallButton
                terminalSessionId={activeTerminal.id}
                size={16}
              />
            )}

            <TouchableOpacity
              onPress={refreshTerminals}
              style={styles.iconBtn}
              hitSlop={8}
              activeOpacity={0.7}
            >
              <Ionicons
                name="refresh"
                size={16}
                color={loading ? C.textDim : C.textMuted}
              />
            </TouchableOpacity>

            {/* Send this panel to another numbered workspace. The PTY is not
                touched — see handleSendToWorkspace. */}
            {activeTerminal && (
              <TouchableOpacity
                onPress={() => setSendMenuFor(activeId)}
                style={styles.iconBtn}
                hitSlop={8}
                activeOpacity={0.7}
                accessibilityRole="button"
                accessibilityLabel="Send panel to another workspace"
                accessibilityHint="Moves this panel without stopping its session"
              >
                <Ionicons name="swap-horizontal" size={16} color={C.textMuted} />
              </TouchableOpacity>
            )}

            {/* Mirror this panel — a second view of the SAME session. */}
            {activeTerminal && (
              <TouchableOpacity
                onPress={() => handleDuplicate(activeId)}
                style={styles.iconBtn}
                hitSlop={8}
                activeOpacity={0.7}
                accessibilityRole="button"
                accessibilityLabel="Duplicate panel"
                accessibilityHint="Opens a second panel showing the same session"
              >
                <Ionicons name="copy-outline" size={16} color={C.textMuted} />
              </TouchableOpacity>
            )}

            {activeTerminal && (
              <TouchableOpacity
                onPress={() => handleClose(activeId)}
                style={styles.iconBtn}
                hitSlop={8}
                activeOpacity={0.7}
                accessibilityRole="button"
                accessibilityLabel={
                  activeTerminal.refs > 1 ? 'Detach panel' : 'Close terminal'
                }
                accessibilityHint={
                  activeTerminal.refs > 1
                    ? 'Closes this view only; the session keeps running in its other panels'
                    : 'Kills the PTY process'
                }
              >
                <Ionicons
                  name={activeTerminal.refs > 1 ? 'remove-circle-outline' : 'close-circle-outline'}
                  size={16}
                  color={activeTerminal.refs > 1 ? C.textMuted : C.danger}
                />
              </TouchableOpacity>
            )}

            <TouchableOpacity
              onPress={() => setShowCreate(true)}
              accessibilityRole="button"
              accessibilityLabel="New terminal"
              testID="terminals-new"
              style={styles.addBtn}
              hitSlop={8}
              activeOpacity={0.8}
            >
              <Ionicons name="add" size={18} color={C.bg0} />
            </TouchableOpacity>
          </View>

          {activeTerminal && (cliInfo || activeTerminal.isMirror || !activeTerminal.isLocal) && (
            <>
              <View style={styles.metaDivider} />
              <View style={styles.metaStrip}>
                {cliInfo && (
                  <View style={[
                    styles.cliBadge,
                    { borderColor: `${cliInfo.color}40`, backgroundColor: `${cliInfo.color}14` },
                  ]}>
                    <MaterialCommunityIcons name={cliInfo.icon} size={10} color={cliInfo.color} />
                    <Text style={[styles.cliBadgeText, { color: cliInfo.color }]} numberOfLines={1}>
                      {cliInfo.label}
                    </Text>
                  </View>
                )}

                {/* A mirror shares its PTY with another panel — say so, so the
                    close button's "detach" behaviour is never a surprise. */}
                {activeTerminal.isMirror && (
                  <View style={styles.mirrorBadge}>
                    <Ionicons name="copy-outline" size={9} color={C.gold} />
                    <Text style={styles.mirrorBadgeText}>
                      MIRROR · {activeTerminal.refs} PANELS
                    </Text>
                  </View>
                )}

                {!activeTerminal.isLocal && (
                  <View style={[styles.nodePill, isActiveNodeStale && styles.nodePillStale]}>
                    <Ionicons
                      name={isActiveNodeStale ? 'cloud-offline' : 'cloud'}
                      size={9}
                      color={isActiveNodeStale ? C.danger : C.gold}
                    />
                    <Text
                      style={[
                        styles.nodePillText,
                        isActiveNodeStale && { color: C.danger },
                      ]}
                      numberOfLines={1}
                      ellipsizeMode="middle"
                    >
                      {activeTerminal.nodeName || activeTerminal.nodeId}
                    </Text>
                    {isActiveNodeStale && (
                      <View style={styles.staleTag}>
                        <Text style={styles.staleTagText}>STALE</Text>
                      </View>
                    )}
                  </View>
                )}
              </View>
            </>
          )}
        </View>
      </GlassPill>

      {/* ── Numbered workspaces (per node) ───────────────────── */}
      <WorkspaceBar
        workspaces={workspaces}
        active={activeWorkspace}
        onSelect={setActiveWorkspace}
        countIn={panelCountIn}
        nextWorkspace={nextWorkspace}
        onAddWorkspace={setActiveWorkspace}
      />

      {/* ── Page dots (2+ terminals) ─────────────────────────── */}
      {visibleTerminals.length > 1 && (
        <View style={styles.dotsRow}>
          {visibleTerminals.map((t, idx) => (
            <TouchableOpacity
              key={t.panelId}
              onPress={() => setActiveId(t.panelId)}
              hitSlop={8}
              activeOpacity={0.8}
            >
              <View style={[styles.dot, idx === activeIndex && styles.dotActive]} />
            </TouchableOpacity>
          ))}
        </View>
      )}

      {/* ── Error banner ────────────────────────────────────── */}
      {error && (
        <View style={styles.errorRow}>
          <Ionicons name="warning-outline" size={13} color={C.danger} />
          <Text style={styles.errorText} numberOfLines={2}>{error}</Text>
          <TouchableOpacity onPress={() => setError(null)} hitSlop={8}>
            <Ionicons name="close" size={13} color={C.danger} />
          </TouchableOpacity>
        </View>
      )}

      {/* ── Output + controls ───────────────────────────────── */}
        {visibleTerminals.length === 0 ? (

          /* ── Empty state glass card ───────────────────────── */
          <View style={styles.emptyOuter}>
            {loading ? (
              <ActivityIndicator color={C.gold} size="large" />
            ) : (
              <GlassPill style={styles.emptyCard} radius={22}>
                <View style={styles.emptyCardInner}>
                  <Text style={styles.emptyPrompt}>$_</Text>
                  <Text style={styles.emptyCardTitle}>NO TERMINALS</Text>
                  <Text style={styles.emptyCardHint}>
                    Spawn a live PTY for Shell, Claude, OpenCode, Codex, Gemini or Grok Build.
                  </Text>

                  <View style={styles.cliPickerRow}>
                    {CLI_OPTIONS.map((opt) => (
                      <TouchableOpacity
                        key={opt.id}
                        onPress={() => setShowCreate(true)}
                        style={[
                          styles.cliPickerChip,
                          {
                            borderColor: `${opt.color}40`,
                            backgroundColor: `${opt.color}12`,
                          },
                        ]}
                        activeOpacity={0.75}
                      >
                        <MaterialCommunityIcons
                          name={opt.icon}
                          size={16}
                          color={opt.color}
                        />
                        <Text style={[styles.cliPickerLabel, { color: opt.color }]}>
                          {opt.label}
                        </Text>
                      </TouchableOpacity>
                    ))}
                  </View>

                  <TouchableOpacity
                    onPress={() => setShowCreate(true)}
                    style={styles.emptyBtn}
                    activeOpacity={0.85}
                  >
                    <LinearGradient
                      colors={C.goldGradient}
                      start={{ x: 0, y: 0 }}
                      end={{ x: 1, y: 0 }}
                      style={styles.emptyBtnGrad}
                    >
                      <Ionicons name="add" size={18} color={C.bg0} />
                      <Text style={styles.emptyBtnText}>NEW TERMINAL</Text>
                    </LinearGradient>
                  </TouchableOpacity>
                </View>
              </GlassPill>
            )}
          </View>

        ) : (

          /* ── Horizontal swipe pager ───────────────────────── */
          /* Tap on the terminal output (outside the input pill) dismisses
             the keyboard. The xterm WebView swallows its own touches, so
             this fires only when the user taps the bg around it. */
          <TouchableWithoutFeedback onPress={Keyboard.dismiss} accessible={false}>
            <View
              style={styles.pagerWrap}
              onLayout={(e) => {
                const h = e.nativeEvent.layout.height;
                if (h > 0 && Math.abs(h - pagerHeight) > 1) setPagerHeight(h);
              }}
            >
              <ScrollView
                ref={pagerRef}
                horizontal
                pagingEnabled
                showsHorizontalScrollIndicator={false}
                onMomentumScrollEnd={onPagerScrollEnd}
                scrollEventThrottle={16}
                style={styles.flex}
                contentContainerStyle={{ width: SCREEN_WIDTH * visibleTerminals.length }}
                keyboardShouldPersistTaps="handled"
                nestedScrollEnabled
                directionalLockEnabled
              >
              {visibleTerminals.map((t) => (
                <View key={t.panelId} style={[styles.termPage, { height: pagerHeight || TERM_PAGE_HEIGHT }]}>
                  {/* One xterm per PANEL (so mirrors each get a live view),
                      hydrated from the PTY's shared scrollback buffer. */}
                  <XtermTerminal
                    ref={(handle) => {
                      if (handle) termRefsMap.current[t.panelId] = handle;
                      else delete termRefsMap.current[t.panelId];
                    }}
                    initialBuffer={buffersRef.current[t.ptyId] || ''}
                    theme={xtermTheme}
                    onInput={sendInput}
                    onResize={t.panelId === activeId ? sendResize : undefined}
                  />
                  {/* Spawning overlay while the PTY is being created */}
                  {t.status === 'idle' && (
                    <View style={styles.spawningOverlay}>
                      <ActivityIndicator color={C.gold} size="large" />
                      <Text style={styles.spawningText}>SPAWNING</Text>
                    </View>
                  )}
                </View>
              ))}
              </ScrollView>
            </View>
          </TouchableWithoutFeedback>

        )}

        {/* ── Quick keys glass pill ────────────────────────── */}
        {visibleTerminals.length > 0 && (
          <GlassPill style={styles.keysPill} radius={14}>
            <View style={styles.keysRow}>
              {keyboardVisible && (
                <TouchableOpacity
                  onPress={Keyboard.dismiss}
                  style={styles.kbDismissBtn}
                  activeOpacity={0.7}
                  hitSlop={6}
                >
                  <MaterialCommunityIcons name="keyboard-close" size={16} color={C.gold} />
                </TouchableOpacity>
              )}
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.keysContent}
                keyboardShouldPersistTaps="handled"
                style={styles.flex}
              >
                {keys.map((k) => (
                  <TouchableOpacity
                    key={k.label}
                    onPress={() => sendInput(k.bytes)}
                    style={styles.keyBtn}
                    activeOpacity={0.6}
                  >
                    <Text style={styles.keyText}>{k.label}</Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>
            </View>
          </GlassPill>
        )}

        {/* ── Input glass pill ─────────────────────────────── */}
        <GlassPill style={[styles.inputPill, { marginBottom: bottomMargin }]} radius={18}>
          <View style={styles.inputRow}>
            <Ionicons name="chevron-forward" size={16} color={C.gold} />
            <TextInput
              style={styles.input}
              value={input}
              onChangeText={setInput}
              placeholder={visibleTerminals.length > 0 ? 'Type a command…' : 'Spawn a terminal first'}
              placeholderTextColor={C.textDim}
              autoCapitalize="none"
              autoCorrect={false}
              spellCheck={false}
              editable={visibleTerminals.length > 0}
              onSubmitEditing={handleSubmit}
              blurOnSubmit={false}
              returnKeyType="send"
            />
            <TouchableOpacity
              onPress={handleSubmit}
              disabled={visibleTerminals.length === 0 || !input}
              style={[
                styles.sendBtn,
                (visibleTerminals.length === 0 || !input) && styles.sendBtnDisabled,
              ]}
              activeOpacity={0.75}
            >
              <Ionicons
                name="arrow-up"
                size={16}
                color={visibleTerminals.length === 0 || !input ? C.textDim : C.bg0}
              />
            </TouchableOpacity>
          </View>
        </GlassPill>
      </KeyboardAvoidingView>

      <CreateTerminalModal
        visible={showCreate}
        onClose={() => setShowCreate(false)}
        onCreate={handleCreate}
        recentDirs={recentDirs}
        nodes={nodes}
        defaultNodeId={selectedNodeId || activeTerminal?.nodeId || LOCAL_NODE_ID}
      />

      <SendToWorkspaceSheet
        visible={!!sendMenuFor}
        onClose={() => setSendMenuFor(null)}
        panel={nodePanels.find((p) => p.panelId === sendMenuFor) || null}
        workspaces={workspaces}
        current={activeWorkspace}
        nextWorkspace={nextWorkspace}
        countIn={panelCountIn}
        onSend={(n) => handleSendToWorkspace(sendMenuFor, n)}
      />

      <AllTerminalsSheet
        visible={showAllSheet}
        onClose={() => setShowAllSheet(false)}
        terminals={nodePanels}
        activeId={activeId}
        activeWorkspace={activeWorkspace}
        nodeName={nodes.find((n) => n.id === selectedNodeId)?.name}
        onSelect={(panel) => {
          // Following a panel that lives elsewhere switches workspace too,
          // otherwise the tap would silently do nothing.
          handleGoToPanel(panel);
          setShowAllSheet(false);
        }}
      />
    </View>
  );
}

export default TerminalsScreen;

// ── Styles ───────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg0 },
  flex: { flex: 1 },

  center: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: C.bg0,
    padding: 40,
  },
  emptyText: { ...F.panelTitle, color: C.textMuted, marginTop: 12 },

  // ── Top header pill ──
  // The pill is a vertical column so we can stack an optional metadata strip
  // below the chrome row without breaking the GlassPill shape.
  headerPill: {
    marginHorizontal: S.md,
    marginTop: S.sm,
    marginBottom: S.xs,
  },
  headerCol: {
    paddingHorizontal: 8,
    paddingVertical: 7,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  iconBtn: {
    width: 30,
    height: 30,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  addBtn: {
    width: 30,
    height: 30,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: C.gold,
    shadowColor: C.gold,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.45,
    shadowRadius: 10,
    elevation: 8,
  },
  headerCenter: {
    flex: 1,
    flexShrink: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    minWidth: 0,
  },
  headerTitle: {
    ...F.panelTitle,
    color: C.textMuted,
    letterSpacing: 1.5,
    flexShrink: 1,
  },
  // FederationPicker compact already caps itself at 160dp; this slot lets it
  // shrink when the row is tight without pushing the trailing icon buttons.
  fedSlot: {
    flexShrink: 1,
  },
  countBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 8,
    backgroundColor: C.goldSubtle,
    borderWidth: 1,
    borderColor: C.goldBorder,
  },
  countBadgeText: { ...F.status, color: C.gold, fontWeight: '700' },
  statusLed: {
    width: 6,
    height: 6,
    borderRadius: 3,
    marginLeft: 2,
  },

  // ── Header meta strip (row 2) ──
  metaDivider: {
    height: 1,
    marginTop: 7,
    marginBottom: 7,
    marginHorizontal: 2,
    backgroundColor: C.panelBorder,
  },
  metaStrip: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 6,
    paddingHorizontal: 2,
  },
  cliBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 8,
    borderWidth: 1,
  },
  cliBadgeText: { ...F.status, fontSize: 9, fontWeight: '700' },
  // A panel that shares its PTY with another panel. Gold hairline, no fill —
  // gold is edges, not area (design-system/MASTER.md rule 3).
  mirrorBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: COLORS.primaryMuted,
    backgroundColor: COLORS.primaryLight,
  },
  mirrorBadgeText: {
    ...F.mono,
    fontSize: 12,
    color: C.gold,
    letterSpacing: 0.4,
  },

  nodePill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 8,
    backgroundColor: COLORS.cardBorder,
    borderWidth: 1,
    borderColor: COLORS.primaryMuted,
    maxWidth: 160,
    flexShrink: 1,
  },
  nodePillText: {
    ...F.status,
    fontSize: 9,
    color: C.gold,
    flexShrink: 1,
  },
  nodePillStale: {
    backgroundColor: 'rgba(239,68,68,0.10)',
    borderColor: 'rgba(239,68,68,0.45)',
  },
  staleTag: {
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: 'rgba(239,68,68,0.55)',
    backgroundColor: 'rgba(239,68,68,0.10)',
    marginLeft: 2,
  },
  staleTagText: {
    ...F.status,
    fontSize: 8,
    color: C.danger,
    letterSpacing: 0.6,
    fontWeight: '800',
  },

  // ── Page dots ──
  dotsRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 5,
  },
  dot: {
    width: 5,
    height: 5,
    borderRadius: 3,
    backgroundColor: C.textSubtle,
  },
  dotActive: {
    width: 18,
    height: 5,
    borderRadius: 3,
    backgroundColor: C.gold,
    shadowColor: C.gold,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.7,
    shadowRadius: 5,
    elevation: 4,
  },

  // ── Error ──
  errorRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginHorizontal: S.md,
    marginBottom: S.xs,
    paddingHorizontal: 10,
    paddingVertical: 7,
    backgroundColor: 'rgba(239,68,68,0.08)',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'rgba(239,68,68,0.20)',
  },
  errorText: { ...F.small, color: C.danger, flex: 1 },

  // ── Pager ──
  // Flexes to fill the space between the header and the input pill; its
  // measured height is fed to each terminal page so the WebView has a defined
  // height and owns vertical scroll gestures.
  pagerWrap: {
    flex: 1,
  },
  termPage: {
    width: SCREEN_WIDTH,
    backgroundColor: C.bg0,
  },

  // ── Spawning overlay ──
  spawningOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(4,4,4,0.75)',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
  },
  spawningText: {
    ...F.panelTitle,
    color: C.gold,
    letterSpacing: 2,
  },

  // ── Empty state ──
  emptyOuter: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 32,
  },
  emptyCard: { width: '100%' },
  emptyCardInner: {
    alignItems: 'center',
    paddingHorizontal: 24,
    paddingVertical: 36,
    gap: 12,
  },
  emptyPrompt: {
    fontFamily: 'monospace',
    fontSize: 42,
    color: C.gold,
    textShadowColor: C.goldGlow,
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 22,
    marginBottom: 4,
  },
  emptyCardTitle: {
    ...F.panelTitle,
    color: C.textMuted,
    letterSpacing: 2,
    fontSize: 13,
  },
  emptyCardHint: {
    ...F.small,
    color: C.textDim,
    textAlign: 'center',
    maxWidth: 280,
  },
  cliPickerRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    justifyContent: 'center',
    marginTop: 4,
  },
  cliPickerChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
    borderWidth: 1,
  },
  cliPickerLabel: { ...F.small, fontWeight: '700' },
  emptyBtn: {
    marginTop: 10,
    borderRadius: 12,
    overflow: 'hidden',
    shadowColor: C.gold,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.38,
    shadowRadius: 14,
    elevation: 8,
  },
  emptyBtnGrad: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 28,
    paddingVertical: 14,
  },
  emptyBtnText: {
    ...F.panelTitle,
    color: C.bg0,
    fontWeight: '800',
    letterSpacing: 1.5,
    fontSize: 12,
  },

  // ── Quick keys pill ──
  keysPill: {
    marginHorizontal: S.md,
    marginTop: S.xs,
    marginBottom: S.xs,
  },
  keysRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  kbDismissBtn: {
    width: 32,
    height: 28,
    marginLeft: 6,
    borderRadius: 6,
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.10)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  keysContent: {
    paddingHorizontal: S.sm,
    paddingVertical: 6,
    gap: 5,
    alignItems: 'center',
  },
  keyBtn: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.10)',
    borderRadius: 6,
    minWidth: 36,
    alignItems: 'center',
  },
  keyText: {
    fontFamily: 'monospace',
    fontSize: 11,
    color: C.gold,
    fontWeight: '700',
  },

  // ── Input pill ──
  inputPill: {
    marginHorizontal: S.md,
    marginTop: S.xs,
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  prompt: {
    ...F.prompt,
    color: C.gold,
    fontSize: 16,
  },
  input: {
    flex: 1,
    ...F.code,
    color: C.text,
    fontFamily: 'monospace',
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.10)',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: Platform.OS === 'ios' ? 8 : 4,
  },
  sendBtn: {
    width: 34,
    height: 34,
    borderRadius: 10,
    backgroundColor: C.gold,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: C.gold,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.4,
    shadowRadius: 8,
    elevation: 6,
  },
  sendBtnDisabled: {
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    shadowOpacity: 0,
    elevation: 0,
  },
});

// ── Modal styles ─────────────────────────────────────────────

const modalStyles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.7)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: C.bg1,
    borderTopWidth: 1,
    borderTopColor: C.gold,
    paddingHorizontal: S.lg,
    paddingTop: S.lg,
    paddingBottom: S.xl,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    ...TERMINAL_SHADOWS.panelActive,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: S.lg,
  },
  title: {
    ...F.panelTitle,
    color: C.gold,
    flex: 1,
    letterSpacing: 1.5,
  },
  label: {
    ...F.status,
    color: C.textDim,
    marginBottom: 6,
    marginTop: S.sm,
  },
  cliRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  cliChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 6,
    backgroundColor: C.bg2,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 6,
  },
  cliText: { ...F.small, color: C.textMuted },
  input: {
    ...F.code,
    color: C.text,
    fontFamily: 'monospace',
    backgroundColor: C.inputBg,
    borderWidth: 1,
    borderColor: C.inputBorder,
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  recentChip: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    backgroundColor: C.goldSubtle,
    borderWidth: 1,
    borderColor: C.goldBorder,
    borderRadius: 4,
    maxWidth: 220,
  },
  recentText: { ...F.small, color: C.gold, fontFamily: 'monospace' },
  actions: {
    flexDirection: 'row',
    gap: S.sm,
    marginTop: S.xl,
    justifyContent: 'flex-end',
  },
  btnSecondary: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    backgroundColor: C.bg2,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 6,
  },
  btnSecondaryText: { ...F.status, color: C.textMuted },
  btnPrimary: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 16,
    paddingVertical: 10,
    backgroundColor: C.gold,
    borderRadius: 6,
    ...TERMINAL_SHADOWS.glow,
  },
  btnPrimaryText: { ...F.status, color: C.bg0, fontWeight: '800' },
});

// ── All-Terminals Sheet styles ───────────────────────────────

const sheetStyles = StyleSheet.create({
  hint: {
    ...F.small,
    color: C.textDim,
    marginBottom: S.sm,
    fontStyle: 'italic',
  },
  list: {
    maxHeight: 360,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 10,
    paddingVertical: 10,
    backgroundColor: C.bg2,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 8,
    marginBottom: 6,
  },
  rowActive: {
    borderColor: C.gold,
    backgroundColor: C.goldSubtle,
  },
  led: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  rowMain: {
    flex: 1,
    minWidth: 0,
  },
  rowTitleLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  rowTitle: {
    ...F.code,
    color: C.text,
    flexShrink: 1,
    fontWeight: '600',
  },
  rowSub: {
    ...F.small,
    color: C.textDim,
    marginTop: 2,
    fontFamily: 'monospace',
  },
  cliBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 5,
    borderWidth: 1,
  },
  cliBadgeText: {
    ...F.status,
    fontSize: 9,
    fontWeight: '700',
  },
  empty: {
    alignItems: 'center',
    paddingVertical: 24,
    gap: 8,
  },
  emptyTitle: {
    ...F.panelTitle,
    color: C.textMuted,
    letterSpacing: 1.5,
    fontSize: 11,
  },
  emptyHint: {
    ...F.small,
    color: C.textDim,
  },
});
