/**
 * TerminalPanel — web <terminal-grid-panel>: one PTY in a tile.
 *
 * Same terminal.* contract as the Terminals page (constants/gateway METHOD):
 *   terminal.list → attach to a running PTY; terminal.create (+ terminal.agent.invoke
 *   for claude / codex / opencode / gemini) → spawn; terminal.getBuffer → scrollback;
 *   `terminal.output` / `terminal.exit` events → live output; terminal.write → input;
 *   terminal.resize from xterm.
 * Rendering: the app's native terminal renderer (XtermTerminal) on iOS /
 * Android; the web build (no WebView) shows an ANSI-stripped text tail.
 * The attached PTY persists on the panel as `terminalSessionId`.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { Chip, IconButton, ListRow, SPACE, RADIUS, useUIKit } from '../../../ui-kit';
import { withAlpha } from '../../../theme/color-utils';
import { METHOD } from '../../../constants/gateway';
import { navigateToScreen } from '../../../navigation/screen-registry';
import { newTerminalId, relTime, terminalRows, terminalTail } from '../grid-data';
import { MiniLabel, PanelEmpty, PanelError, PanelLoading, PanelOpen, withTimeout } from '../panel-kit';

let XtermTerminal = null;
if (Platform.OS !== 'web') {
  // eslint-disable-next-line global-require
  XtermTerminal = require('../../../components/XtermTerminal').XtermTerminal;
}

const CLIS = ['shell', 'claude', 'codex', 'opencode', 'gemini', 'grok'];
const MAX_BUF = 200000;
const KEYS = [
  { label: 'Ctrl-C', data: '\x03' },
  { label: 'Tab', data: '\t' },
  { label: 'Esc', data: '\x1b' },
  { label: 'Up', data: '\x1b[A' },
  { label: 'Down', data: '\x1b[B' },
  { label: 'Enter', data: '\r' },
];

export function TerminalPanel({ panel, gateway, navigation, onPatch, refreshSignal }) {
  const termId = panel.terminalSessionId || null;
  const open = () => navigateToScreen(navigation, { screen: 'TerminalsScreen' }, { gateway });
  return (
    <View style={styles.root}>
      {termId
        ? <AttachedTerminal key={termId} termId={termId} gateway={gateway} refreshSignal={refreshSignal} onDetach={() => onPatch({ terminalSessionId: null })} />
        : <TerminalPicker gateway={gateway} refreshSignal={refreshSignal} onAttach={(id, title, cli) => onPatch({ terminalSessionId: id, terminalCli: cli, title })} />}
      <PanelOpen label="Terminals" onPress={open} />
    </View>
  );
}

function TerminalPicker({ gateway, refreshSignal, onAttach }) {
  const { colors, type } = useUIKit();
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);
  const [spawning, setSpawning] = useState(null);

  const load = useCallback(async () => {
    if (gateway?.status !== 'connected') return;
    try {
      setRows(terminalRows(await withTimeout(gateway.sendReq(METHOD.TERMINAL_LIST, {}), 20000, 'terminal.list')));
      setError(null);
    } catch (err) {
      setError(String(err?.message || err));
    }
  }, [gateway]);
  useEffect(() => { load(); }, [load, refreshSignal]);

  const spawn = async (cli) => {
    const id = newTerminalId();
    setSpawning(cli);
    try {
      const res = await gateway.sendReq(METHOD.TERMINAL_CREATE, { id, cwd: '', cols: 80, rows: 24 });
      if (res && res.success === false) throw new Error(res.error || 'create failed');
      if (cli !== 'shell') {
        try {
          await gateway.sendReq(METHOD.TERMINAL_AGENT_INVOKE, { id, cli, options: {} });
        } catch {
          try { await gateway.sendReq(METHOD.TERMINAL_WRITE, { id, data: `${cli}\r` }); } catch { /* ignore */ }
        }
      }
      onAttach(id, cli === 'shell' ? 'Terminal' : `Terminal - ${cli}`, cli);
    } catch (err) {
      setError(String(err?.message || err));
    } finally {
      setSpawning(null);
    }
  };

  if (error && !rows) return <PanelError message={error} onRetry={load} />;
  if (!rows) return <PanelLoading rows={4} />;
  return (
    <ScrollView style={styles.flex} contentContainerStyle={styles.pad} nestedScrollEnabled>
      <MiniLabel style={{ marginTop: 0 }}>New terminal</MiniLabel>
      <View style={styles.wrap}>
        {CLIS.map((c) => <Chip key={c} label={spawning === c ? `${c}...` : c} icon={c === 'shell' ? 'terminal-outline' : 'sparkles-outline'} onPress={() => !spawning && spawn(c)} />)}
      </View>
      {error ? <Text style={[type.caption, { color: colors.error, marginTop: SPACE.sm }]}>{error}</Text> : null}
      <MiniLabel>Running on this gateway</MiniLabel>
      {rows.length === 0 ? <PanelEmpty icon="terminal-outline" title="No terminals running" message="Start one above." /> : rows.map((t) => (
        <ListRow
          key={t.id}
          dense
          icon={t.cli === 'shell' ? 'terminal-outline' : 'sparkles-outline'}
          title={t.title}
          subtitle={t.cwd}
          value={relTime(t.lastActiveAt)}
          onPress={() => onAttach(t.id, t.title, t.cli)}
          accessibilityLabel={`Attach to ${t.title}`}
        />
      ))}
    </ScrollView>
  );
}

function AttachedTerminal({ termId, gateway, refreshSignal, onDetach }) {
  const { colors, type } = useUIKit();
  const termRef = useRef(null);
  const bufRef = useRef('');
  const [tail, setTail] = useState('');
  const [hydrated, setHydrated] = useState(false);
  const [exited, setExited] = useState(false);
  const [input, setInput] = useState('');
  const [error, setError] = useState(null);
  const scrollRef = useRef(null);
  const isWeb = !XtermTerminal;

  const push = useCallback((data) => {
    bufRef.current = (bufRef.current + data).slice(-MAX_BUF);
    if (isWeb) setTail(terminalTail(bufRef.current, 80));
    else termRef.current?.write?.(data);
  }, [isWeb]);

  const hydrate = useCallback(async () => {
    try {
      const res = await withTimeout(gateway.sendReq(METHOD.TERMINAL_GET_BUFFER, { id: termId }), 20000, 'terminal.getBuffer');
      bufRef.current = String(res?.buffer || '').slice(-MAX_BUF);
      if (isWeb) setTail(terminalTail(bufRef.current, 80));
      else { termRef.current?.clear?.(); termRef.current?.write?.(bufRef.current); }
      setError(null);
    } catch (err) {
      setError(String(err?.message || err));
    } finally {
      setHydrated(true);
    }
  }, [gateway, termId, isWeb]);

  useEffect(() => { hydrate(); }, [hydrate, refreshSignal]);

  useEffect(() => {
    const { subscribeEvent } = gateway || {};
    if (typeof subscribeEvent !== 'function') return undefined;
    const offOut = subscribeEvent('terminal.output', (p) => {
      if ((p?.terminalId || p?.id) === termId && typeof p.data === 'string') push(p.data);
    });
    const offExit = subscribeEvent('terminal.exit', (p) => {
      if ((p?.terminalId || p?.id) !== termId) return;
      push(`\r\n[process exited with code ${p.exitCode ?? 0}]\r\n`);
      setExited(true);
    });
    return () => { offOut?.(); offExit?.(); };
  }, [gateway, termId, push]);

  useEffect(() => {
    if (isWeb) setTimeout(() => scrollRef.current?.scrollToEnd?.({ animated: false }), 30);
  }, [tail, isWeb]);

  const write = useCallback(async (data) => {
    if (!data) return;
    try {
      await gateway.sendReq(METHOD.TERMINAL_WRITE, { id: termId, data });
    } catch (err) {
      setError(String(err?.message || err));
    }
  }, [gateway, termId]);
  const resize = useCallback((cols, rows) => {
    if (cols && rows) gateway.sendReq(METHOD.TERMINAL_RESIZE, { id: termId, cols, rows }).catch(() => {});
  }, [gateway, termId]);

  return (
    <View style={styles.flex}>
      <View style={[styles.head, { borderBottomColor: colors.borderSubtle }]}>
        <View style={[styles.dot, { backgroundColor: exited ? colors.textMuted : colors.success }]} />
        <Text style={[type.monoSmall, { color: colors.textSecondary, flex: 1 }]} numberOfLines={1}>{termId}</Text>
        <IconButton icon="swap-horizontal-outline" size="sm" onPress={onDetach} accessibilityLabel="Choose another terminal" />
      </View>
      <View style={[styles.screen, { backgroundColor: withAlpha(colors.background || colors.surfaceDeep, 0.9) }]}>
        {!hydrated ? <PanelLoading rows={3} /> : isWeb ? (
          <ScrollView ref={scrollRef} nestedScrollEnabled contentContainerStyle={styles.tailPad}>
            <Text style={[type.monoSmall, { color: colors.text }]} selectable>{tail || ' '}</Text>
          </ScrollView>
        ) : (
          <XtermTerminal ref={termRef} initialBuffer={bufRef.current} onInput={write} onResize={resize} />
        )}
      </View>
      {error ? <Text style={[type.caption, { color: colors.error, paddingHorizontal: SPACE.sm }]} numberOfLines={2}>{error}</Text> : null}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.keys} nestedScrollEnabled style={{ flexGrow: 0 }}>
        {KEYS.map((k) => (
          <Pressable key={k.label} onPress={() => write(k.data)} style={[styles.key, { borderColor: colors.borderSubtle }]} accessibilityRole="button" accessibilityLabel={`Send ${k.label}`}>
            <Text style={[type.monoSmall, { color: colors.primary }]}>{k.label}</Text>
          </Pressable>
        ))}
      </ScrollView>
      <View style={[styles.inputRow, { borderColor: colors.border }]}>
        <Ionicons name="chevron-forward" size={14} color={colors.primary} />
        <TextInput
          value={input}
          onChangeText={setInput}
          onSubmitEditing={() => { write(`${input}\r`); setInput(''); }}
          placeholder="Type a command"
          placeholderTextColor={colors.textMuted}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="send"
          style={[type.mono, styles.input, { color: colors.text }]}
          accessibilityLabel="Terminal input"
        />
        <IconButton icon="return-down-back" size="sm" onPress={() => { write(`${input}\r`); setInput(''); }} accessibilityLabel="Send command" />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  flex: { flex: 1 },
  pad: { padding: SPACE.md },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.sm },
  head: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, paddingLeft: SPACE.md, borderBottomWidth: StyleSheet.hairlineWidth },
  dot: { width: 7, height: 7, borderRadius: 4 },
  screen: { flex: 1 },
  tailPad: { padding: SPACE.sm },
  keys: { gap: SPACE.xs, paddingHorizontal: SPACE.sm, paddingTop: SPACE.xs },
  key: { borderWidth: 1, borderRadius: RADIUS.sm, paddingHorizontal: SPACE.sm, minHeight: 32, justifyContent: 'center' },
  inputRow: { flexDirection: 'row', alignItems: 'center', gap: SPACE.xs, margin: SPACE.sm, borderWidth: 1, borderRadius: RADIUS.md, paddingLeft: SPACE.md },
  input: { flex: 1, minHeight: 40 },
});
