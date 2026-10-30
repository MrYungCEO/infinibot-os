/**
 * CliModeSwitcher — the chat composer's Agent | CLI switch on mobile (the web
 * chat's <chat-mode-switcher> as a bottom sheet). An icon button left of Send
 * shows who the thread talks to; tapping it opens a sheet: the InfiniBot agent,
 * the coding CLIs with a status dot (ready / needs sign-in / not installed),
 * and in CLI mode the working folder + model.
 *
 * CLI mode needs the gateway's chat.cli.* methods; on an older gateway the
 * CLIs show "After gateway update" and can't be picked.
 */
import React, { useEffect, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useChatTokens } from './chat-tokens';
import { CLI_BACKENDS, CLI_LABELS, folderName } from './cli-route';
import { ProviderLogo } from '../utils/providerLogo';
import { tap } from '../utils/haptics';

const LOGO = { 'claude-code': 'claude', codex: 'openai', opencode: 'opencode', gemini: 'gemini', grok: 'grok' };
const STATUS = { ready: 'Ready', login: 'Needs sign-in', unavailable: 'Not installed' };
const DOT = { ready: '#34d399', login: '#fbbf24', unavailable: '#6b7280', update: '#60a5fa' };

export function CliModeSwitcher({ route, backends, cliSupported, folders = [], agentName, onChange, disabled }) {
  const t = useChatTokens();
  const insets = useSafeAreaInsets();
  const [open, setOpen] = useState(false);
  const [folder, setFolder] = useState(route?.cwd || '');
  const [model, setModel] = useState(route?.model || '');
  useEffect(() => {
    setFolder(route?.cwd || '');
    setModel(route?.model || '');
  }, [route?.mode, route?.backend, route?.cwd, route?.model]);

  const cli = route?.mode === 'cli' ? route.backend : null;
  const pick = (next) => {
    tap();
    onChange?.(next);
  };
  const commitCli = (patch) => {
    if (!cli) return;
    const next = { mode: 'cli', backend: cli, ...(route.cwd ? { cwd: route.cwd } : {}), ...(route.model ? { model: route.model } : {}), ...patch };
    if (!next.cwd) delete next.cwd;
    if (!next.model) delete next.model;
    pick(next);
  };

  return (
    <>
      <Pressable
        onPress={() => { tap(); setOpen(true); }}
        disabled={disabled}
        hitSlop={6}
        style={[styles.trigger, { borderColor: cli ? t.accent : t.borderStrong, backgroundColor: cli ? t.accentSoft : 'transparent' }]}
        accessibilityRole="button"
        accessibilityLabel={cli ? `Chatting with ${CLI_LABELS[cli]}. Switch target` : `Chatting with ${agentName}. Switch to a coding CLI`}
        testID="chat-mode-switcher"
      >
        {cli ? <ProviderLogo provider={LOGO[cli]} size={16} color={t.accent} /> : <Ionicons name="terminal-outline" size={16} color={t.muted} />}
      </Pressable>
      <Modal visible={open} transparent animationType="slide" onRequestClose={() => setOpen(false)}>
        <Pressable style={styles.backdrop} onPress={() => setOpen(false)} accessibilityLabel="Close" />
        <View style={[styles.sheet, { backgroundColor: t.side, borderColor: t.borderStrong, paddingBottom: 14 + insets.bottom }]}>
          <View style={[styles.grab, { backgroundColor: t.borderStrong }]} />
          <ScrollView keyboardShouldPersistTaps="handled">
            <Text style={[styles.h, { color: t.muted }]}>CODING CLI · runs on your computer</Text>
            {CLI_BACKENDS.map((id) => {
              const b = backends.find((x) => x.id === id) || { id, status: 'unavailable' };
              const needsUpdate = !cliSupported && b.status !== 'unavailable';
              const blocked = needsUpdate || b.status === 'unavailable';
              const on = cli === id;
              return (
                <Pressable
                  key={id}
                  disabled={blocked}
                  onPress={() => pick({ mode: 'cli', backend: id, ...(route?.cwd ? { cwd: route.cwd } : {}) })}
                  style={[styles.row, on && { backgroundColor: t.accentSoft }, blocked && { opacity: 0.5 }]}
                  accessibilityRole="button"
                  accessibilityState={{ selected: on, disabled: blocked }}
                >
                  <View style={[styles.ico, { backgroundColor: t.surfaceStrong }]}>
                    <ProviderLogo provider={LOGO[id]} size={16} color={t.accent} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={{ color: t.textStrong, fontFamily: t.font.semiBold, fontSize: 15 }}>{on ? CLI_LABELS[id] : `Switch to ${CLI_LABELS[id]}`}</Text>
                    <View style={styles.sub}>
                      <View style={[styles.dot, { backgroundColor: DOT[needsUpdate ? 'update' : b.status] }]} />
                      <Text style={{ color: t.muted, fontSize: 12 }}>
                        {needsUpdate ? 'After gateway update' : STATUS[b.status]}{b.version ? ` · v${b.version}` : ''}
                      </Text>
                    </View>
                  </View>
                  {on ? <Ionicons name="checkmark" size={18} color={t.accent} /> : null}
                </Pressable>
              );
            })}
            {cli ? (
              <View style={[styles.cli, { borderColor: t.border }]}>
                <Text style={[styles.lbl, { color: t.muted }]}>Folder</Text>
                <TextInput
                  value={folder}
                  onChangeText={setFolder}
                  onEndEditing={() => commitCli({ cwd: folder.trim() })}
                  placeholder="Home folder (or /path/to/project)"
                  placeholderTextColor={t.muted}
                  autoCapitalize="none"
                  autoCorrect={false}
                  style={[styles.input, { color: t.textStrong, borderColor: t.borderStrong }]}
                />
                {folders.length ? (
                  <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginTop: 6 }}>
                    {folders.map((f) => (
                      <Pressable key={f} onPress={() => commitCli({ cwd: f })} style={[styles.chip, { borderColor: route.cwd === f ? t.accent : t.border }]}>
                        <Text style={{ color: t.text, fontSize: 12 }}>{folderName(f)}</Text>
                      </Pressable>
                    ))}
                  </ScrollView>
                ) : null}
                <Text style={[styles.lbl, { color: t.muted, marginTop: 10 }]}>Model</Text>
                <TextInput
                  value={model}
                  onChangeText={setModel}
                  onEndEditing={() => commitCli({ model: model.trim() })}
                  placeholder="CLI default"
                  placeholderTextColor={t.muted}
                  autoCapitalize="none"
                  autoCorrect={false}
                  style={[styles.input, { color: t.textStrong, borderColor: t.borderStrong }]}
                />
              </View>
            ) : null}
            <Text style={[styles.h, { color: t.muted, marginTop: 12 }]}>INFINIBOT AGENT</Text>
            <Pressable
              onPress={() => pick({ mode: 'agent' })}
              style={[styles.row, !cli && { backgroundColor: t.accentSoft }]}
              accessibilityRole="button"
              accessibilityState={{ selected: !cli }}
            >
              <View style={[styles.ico, { backgroundColor: t.surfaceStrong }]}>
                <Ionicons name="sparkles-outline" size={16} color={t.accent} />
              </View>
              <Text style={{ flex: 1, color: t.textStrong, fontFamily: t.font.semiBold, fontSize: 15 }}>{cli ? `Switch to ${agentName}` : agentName}</Text>
              {!cli ? <Ionicons name="checkmark" size={18} color={t.accent} /> : null}
            </Pressable>
            <Text style={[styles.foot, { color: t.muted }]}>Tip: type /cli codex or /agent in the message box.</Text>
          </ScrollView>
        </View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  trigger: { width: 36, height: 36, borderRadius: 18, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)' },
  sheet: { position: 'absolute', left: 0, right: 0, bottom: 0, maxHeight: '82%', borderTopLeftRadius: 20, borderTopRightRadius: 20, borderWidth: 1, paddingHorizontal: 14, paddingTop: 6 },
  grab: { width: 40, height: 4, borderRadius: 2, alignSelf: 'center', marginBottom: 10 },
  h: { fontSize: 11, letterSpacing: 0.6, fontWeight: '700', marginBottom: 6, marginTop: 4 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 52, paddingHorizontal: 8, borderRadius: 12 },
  ico: { width: 32, height: 32, borderRadius: 9, alignItems: 'center', justifyContent: 'center' },
  sub: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 2 },
  dot: { width: 7, height: 7, borderRadius: 4 },
  cli: { borderWidth: 1, borderRadius: 12, padding: 10, marginTop: 8 },
  lbl: { fontSize: 12, marginBottom: 4 },
  input: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 8, fontSize: 14 },
  chip: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 5, marginRight: 6 },
  foot: { fontSize: 12, marginTop: 12, textAlign: 'center' },
});
