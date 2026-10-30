// ScriptEditorScreen — markdown script editor with two generation paths.
//
//   1. Generate (blocking) — scripts.generate with savePageId. This is the
//      canonical path the web hub uses: it runs the unified script service
//      and persists the result into the page's `scripts` child-DB. Best for
//      a one-shot, guaranteed-saved draft.
//
//   2. Live draft (streaming) — routes the prompt to the SCRIPTWRITER agent
//      over chat.send on a per-page session key and consumes the EVENT.CHAT
//      delta stream, so tokens land in the editor as they're produced and the
//      user can keep editing while it streams. On finish the streamed text is
//      saved with the same scripts.generate(savePageId) persistence call (or
//      content.pages.children.update if editing an existing row).
//
// Refine re-runs scripts.refine over the current editor text. Offline: the
// editor body is autosaved to AsyncStorage and restored on mount.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import Markdown from 'react-native-markdown-display';
import { COLORS } from '../../constants/theme';
import { withAlpha, glassGradient, headerGradient, innerTopHighlight } from '../../theme/color-utils';
import { EVENT, CHAT_STATE, METHOD } from '../../constants/gateway';
import {
  generateScript,
  refineScript,
  getScript,
  updateChild,
  saveDraft,
  loadDraft,
  clearDraft,
} from './contentApi';

const PLATFORMS = ['instagram', 'youtube', 'tiktok', 'custom'];

export function ScriptEditorScreen({ gateway, route, navigation }) {
  const pageId = route?.params?.pageId;
  const pageName = route?.params?.pageName || 'Content';
  const rowId = route?.params?.rowId || null;
  const draftKey = `script.${pageId || 'adhoc'}.${rowId || 'new'}`;

  const [prompt, setPrompt] = useState('');
  const [platform, setPlatform] = useState('instagram');
  const [body, setBody] = useState('');
  const [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [status, setStatus] = useState('');
  const [refineText, setRefineText] = useState('');

  // Session-key format `agent:<id>:<rest>` routes the run to the SCRIPTWRITER
  // native agent (see src/sessions/session-key-utils.ts parseAgentSessionKey).
  const sessionKeyRef = useRef(`agent:scriptwriter:script-${pageId || 'adhoc'}-${rowId || 'new'}`);
  const streamBufRef = useRef('');

  // Load existing row OR restore offline draft.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (rowId) {
        try {
          const row = await getScript(gateway, rowId);
          if (!cancelled && row) {
            setBody(row.body || row.values?.body?.markdown || '');
            setPrompt(row.title || '');
          }
        } catch {
          // fall through to draft
        }
      }
      const d = await loadDraft(draftKey);
      if (!cancelled && d && !rowId) {
        setBody(d.body || '');
        setPrompt(d.prompt || '');
        setPlatform(d.platform || 'instagram');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [gateway, rowId, draftKey]);

  // Autosave editor state offline.
  useEffect(() => {
    if (!body && !prompt) return;
    const t = setTimeout(() => saveDraft(draftKey, { body, prompt, platform }), 600);
    return () => clearTimeout(t);
  }, [body, prompt, platform, draftKey]);

  // ── Blocking generate (canonical, saves to page) ──
  const doGenerate = async () => {
    if (!prompt.trim()) {
      Alert.alert('Prompt required', 'Describe what the script should be about.');
      return;
    }
    setBusy(true);
    setStatus('Generating…');
    try {
      const res = await generateScript(gateway, {
        prompt: prompt.trim(),
        platform,
        savePageId: pageId,
        title: prompt.trim().slice(0, 60),
      });
      if (res?.success && res.script) {
        setBody(res.script);
        setStatus(res.savedTo?.pageRowId ? '✓ Saved to page' : '✓ Generated');
        await clearDraft(draftKey);
      } else {
        setStatus(res?.error || 'Generation failed');
      }
    } catch (e) {
      setStatus(e?.message || 'Generation failed');
    } finally {
      setBusy(false);
    }
  };

  // ── Streaming draft via SCRIPTWRITER agent (token stream) ──
  const handleChatEvent = useCallback((payload) => {
    if (!payload || payload.sessionKey !== sessionKeyRef.current) return;
    const { state, message } = payload;
    let text = '';
    if (typeof message === 'string') text = message;
    else if (message?.content) {
      text = Array.isArray(message.content)
        ? message.content.filter((b) => b.type === 'text').map((b) => b.text || '').join('')
        : String(message.content);
    } else if (typeof message?.text === 'string') text = message.text;

    if (state === CHAT_STATE.DELTA) {
      streamBufRef.current = text;
      setBody(text);
    } else if (state === CHAT_STATE.FINAL) {
      if (text) {
        streamBufRef.current = text;
        setBody(text);
      }
      setStreaming(false);
      setStatus('✓ Draft streamed — tap Save to attach');
    } else if (state === CHAT_STATE.ERROR || state === CHAT_STATE.ABORTED) {
      setStreaming(false);
      setStatus('Stream ended');
    }
  }, []);

  const doStream = async () => {
    if (!prompt.trim()) {
      Alert.alert('Prompt required', 'Describe what the script should be about.');
      return;
    }
    setStreaming(true);
    setBody('');
    streamBufRef.current = '';
    setStatus('Streaming from SCRIPTWRITER…');
    const unsub = gateway.subscribeEvent(EVENT.CHAT, handleChatEvent);
    try {
      await gateway.sendReq(METHOD.CHAT_SEND, {
        sessionKey: sessionKeyRef.current,
        message:
          `Write a publish-ready ${platform} script in markdown ` +
          `using the [SCENE X] / VISUAL / VOICEOVER structure. Topic:\n\n${prompt.trim()}`,
        idempotencyKey: `scriptstream-${Date.now()}`,
      });
    } catch (e) {
      setStreaming(false);
      setStatus(e?.message || 'Stream failed');
    }
    // Keep the subscription alive for the run; tear down after a generous cap.
    setTimeout(() => unsub && unsub(), 120000);
  };

  const doRefine = async () => {
    if (!body.trim() || !refineText.trim()) {
      Alert.alert('Need a script + instructions', 'Write or generate a script, then add refine notes.');
      return;
    }
    setBusy(true);
    setStatus('Refining…');
    try {
      const res = await refineScript(gateway, body, refineText.trim());
      if (res?.success && res.script) {
        setBody(res.script);
        setRefineText('');
        setStatus('✓ Refined');
      } else {
        setStatus(res?.error || 'Refine failed');
      }
    } catch (e) {
      setStatus(e?.message || 'Refine failed');
    } finally {
      setBusy(false);
    }
  };

  // Save the current editor body. If editing an existing row, update it in
  // place; otherwise persist through the script service so it lands in the
  // page's scripts child-DB.
  const doSave = async () => {
    if (!body.trim()) {
      Alert.alert('Nothing to save', 'The script is empty.');
      return;
    }
    setBusy(true);
    setStatus('Saving…');
    try {
      if (rowId && pageId) {
        await updateChild(gateway, pageId, 'scripts', rowId, {
          title: prompt.trim().slice(0, 60) || undefined,
          values: { body: { type: 'richText', markdown: body } },
        });
        setStatus('✓ Saved');
      } else if (pageId) {
        // Persist the (possibly streamed/edited) body. parse=false would be
        // ideal, but scripts.generate is the documented save path; we feed the
        // body back as the prompt-less persist by saving via children update of
        // a fresh row would lose structure — so we use generate with the body
        // as title context and store the body verbatim through a child create.
        const res = await generateScript(gateway, {
          prompt: prompt.trim() || body.slice(0, 80),
          platform,
          savePageId: pageId,
          title: prompt.trim().slice(0, 60) || 'Script',
        });
        // Overwrite the generated row body with the user's edited body so the
        // editor content is what's stored.
        if (res?.savedTo?.pageRowId) {
          await updateChild(gateway, pageId, 'scripts', res.savedTo.pageRowId, {
            values: { body: { type: 'richText', markdown: body } },
          });
        }
        setStatus('✓ Saved to page');
      } else {
        setStatus('No page — nothing to attach to');
      }
      await clearDraft(draftKey);
      navigation?.navigate?.('ContentModal', { refreshAt: Date.now() });
    } catch (e) {
      setStatus(e?.message || 'Save failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <SafeAreaView style={styles.container} edges={['left', 'right']}>
      <LinearGradient
        colors={headerGradient(COLORS.gold)}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={styles.header}
      >
        <TouchableOpacity onPress={() => navigation?.goBack?.()} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
          <Ionicons name="arrow-back" size={22} color={COLORS.gold} />
        </TouchableOpacity>
        <View style={{ flex: 1, marginLeft: 12 }}>
          <View style={styles.titleRow}>
            <View style={styles.accentBar} />
            <Text style={styles.title}>Script Editor</Text>
          </View>
          <Text style={styles.meta} numberOfLines={1}>
            {pageName}
          </Text>
        </View>
        <TouchableOpacity onPress={() => setPreview((p) => !p)} style={styles.iconBtn}>
          <Ionicons name={preview ? 'create-outline' : 'eye-outline'} size={18} color={COLORS.gold} />
        </TouchableOpacity>
        <TouchableOpacity onPress={doSave} disabled={busy} activeOpacity={0.85}>
          <LinearGradient
            colors={COLORS.goldGradient}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={styles.saveBtn}
          >
            <Text style={styles.saveBtnText}>Save</Text>
          </LinearGradient>
        </TouchableOpacity>
      </LinearGradient>

      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={{ flex: 1 }}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 80 : 0}
      >
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <View style={styles.labelRow}>
            <View style={styles.labelBar} />
            <Text style={styles.fieldLabel}>Topic / prompt</Text>
          </View>
          <TextInput
            style={styles.promptInput}
            value={prompt}
            onChangeText={setPrompt}
            placeholder="e.g. 3 mistakes new founders make on day one"
            placeholderTextColor={COLORS.textMuted}
            multiline
          />

          <View style={styles.platformRow}>
            {PLATFORMS.map((p) => (
              <TouchableOpacity
                key={p}
                style={[styles.chip, platform === p && styles.chipActive]}
                onPress={() => setPlatform(p)}
              >
                <Text style={[styles.chipText, platform === p && styles.chipTextActive]}>{p}</Text>
              </TouchableOpacity>
            ))}
          </View>

          <View style={styles.genRow}>
            <TouchableOpacity style={{ flex: 1 }} onPress={doGenerate} disabled={busy || streaming} activeOpacity={0.85}>
              <LinearGradient
                colors={COLORS.goldGradient}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
                style={styles.genBtn}
              >
                {busy ? (
                  <ActivityIndicator size="small" color={COLORS.background} />
                ) : (
                  <>
                    <Ionicons name="sparkles" size={15} color={COLORS.background} />
                    <Text style={styles.genBtnText}>Generate</Text>
                  </>
                )}
              </LinearGradient>
            </TouchableOpacity>
            <TouchableOpacity style={styles.streamBtn} onPress={doStream} disabled={busy || streaming}>
              {streaming ? (
                <ActivityIndicator size="small" color={COLORS.gold} />
              ) : (
                <>
                  <Ionicons name="radio-outline" size={15} color={COLORS.gold} />
                  <Text style={styles.streamBtnText}>Live draft</Text>
                </>
              )}
            </TouchableOpacity>
          </View>

          {status ? (
            <Text style={[styles.status, status.startsWith('✓') && { color: '#37d67a' }]}>
              {/* '✓' prefix is an internal success marker — drawn as a vector icon */}
              {status.startsWith('✓') ? <Ionicons name="checkmark-circle" size={13} color="#37d67a" /> : null}
              {status.startsWith('✓') ? status.slice(1) : status}
            </Text>
          ) : null}

          <View style={styles.labelRow}>
            <View style={styles.labelBar} />
            <Text style={styles.fieldLabel}>Script {streaming ? '(streaming…)' : ''}</Text>
          </View>
          <LinearGradient
            colors={[withAlpha(COLORS.gold, 0.55), withAlpha(COLORS.gold, 0.08), 'transparent']}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={styles.editorBorder}
          >
            {preview ? (
              <View style={styles.previewBox}>
                {body ? (
                  <Markdown style={markdownStyles}>{body}</Markdown>
                ) : (
                  <View style={styles.emptyState}>
                    <View style={styles.emptyChip}>
                      <Ionicons name="document-text-outline" size={22} color={COLORS.gold} />
                    </View>
                    <Text style={styles.placeholderText}>Nothing yet — generate or write a script.</Text>
                  </View>
                )}
              </View>
            ) : (
              <TextInput
                style={styles.bodyInput}
                value={body}
                onChangeText={setBody}
                placeholder="Your script appears here. You can edit while it streams."
                placeholderTextColor={COLORS.textMuted}
                multiline
                textAlignVertical="top"
              />
            )}
          </LinearGradient>

          <View style={styles.labelRow}>
            <View style={styles.labelBar} />
            <Text style={styles.fieldLabel}>Refine</Text>
          </View>
          <View style={styles.refineRow}>
            <TextInput
              style={styles.refineInput}
              value={refineText}
              onChangeText={setRefineText}
              placeholder="e.g. punchier hook, cut to 30s"
              placeholderTextColor={COLORS.textMuted}
            />
            <TouchableOpacity onPress={doRefine} disabled={busy || streaming} activeOpacity={0.85}>
              <LinearGradient
                colors={COLORS.goldGradient}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
                style={styles.refineBtn}
              >
                <Ionicons name="color-wand-outline" size={16} color={COLORS.background} />
              </LinearGradient>
            </TouchableOpacity>
          </View>

          <View style={{ height: 40 }} />
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const markdownStyles = {
  body: { color: COLORS.text, fontSize: 14, lineHeight: 21 },
  heading1: { color: COLORS.gold, fontSize: 18, fontWeight: '800' },
  heading2: { color: COLORS.goldLight, fontSize: 16, fontWeight: '700' },
  heading3: { color: COLORS.goldLight, fontSize: 15, fontWeight: '700' },
  strong: { color: COLORS.text, fontWeight: '800' },
  bullet_list: { color: COLORS.text },
  link: { color: COLORS.accent },
  code_inline: {
    color: COLORS.gold,
    backgroundColor: withAlpha(COLORS.gold, 0.1),
    borderWidth: 1,
    borderColor: withAlpha(COLORS.gold, 0.22),
    borderRadius: 4,
  },
  code_block: {
    color: COLORS.text,
    backgroundColor: 'rgba(20,20,28,0.6)',
    borderWidth: 1,
    borderColor: withAlpha(COLORS.gold, 0.22),
    borderRadius: 10,
    padding: 12,
  },
  fence: {
    color: COLORS.text,
    backgroundColor: 'rgba(20,20,28,0.6)',
    borderWidth: 1,
    borderColor: withAlpha(COLORS.gold, 0.22),
    borderRadius: 10,
    padding: 12,
  },
};

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.background },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 12,
    gap: 8,
    borderBottomWidth: 1,
    borderBottomColor: withAlpha(COLORS.gold, 0.15),
  },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  accentBar: { width: 3, height: 16, borderRadius: 2, backgroundColor: COLORS.gold },
  title: { color: COLORS.text, fontSize: 17, fontWeight: '800', letterSpacing: 0.3 },
  meta: { color: COLORS.textMuted, fontSize: 11, marginTop: 2, marginLeft: 11 },
  iconBtn: {
    padding: 8,
    borderRadius: 10,
    backgroundColor: withAlpha(COLORS.gold, 0.1),
    borderWidth: 1,
    borderColor: withAlpha(COLORS.gold, 0.25),
  },
  saveBtn: {
    paddingHorizontal: 16,
    paddingVertical: 9,
    borderRadius: 999,
    shadowColor: COLORS.gold,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.18,
    shadowRadius: 14,
    elevation: 6,
  },
  saveBtnText: { color: COLORS.background, fontWeight: '800', fontSize: 13 },
  content: { paddingHorizontal: 16, paddingTop: 6 },
  labelRow: { flexDirection: 'row', alignItems: 'center', gap: 7, marginTop: 16, marginBottom: 6 },
  labelBar: { width: 3, height: 12, borderRadius: 2, backgroundColor: COLORS.gold },
  fieldLabel: { color: COLORS.gold, fontSize: 11, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 1 },
  promptInput: {
    backgroundColor: 'rgba(20,20,28,0.55)',
    borderWidth: 1,
    borderColor: withAlpha(COLORS.gold, 0.2),
    borderRadius: 14,
    padding: 12,
    color: COLORS.text,
    fontSize: 15,
    minHeight: 56,
  },
  platformRow: { flexDirection: 'row', gap: 8, marginTop: 12, flexWrap: 'wrap' },
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: withAlpha(COLORS.gold, 0.4),
    backgroundColor: 'rgba(14,13,18,0.6)',
  },
  chipActive: {
    backgroundColor: withAlpha(COLORS.gold, 0.18),
    borderColor: withAlpha(COLORS.gold, 0.5),
  },
  chipText: { color: COLORS.textMuted, fontSize: 12, fontWeight: '600' },
  chipTextActive: { color: COLORS.gold },
  genRow: { flexDirection: 'row', gap: 10, marginTop: 16 },
  genBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 13,
    borderRadius: 14,
    shadowColor: COLORS.gold,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.18,
    shadowRadius: 14,
    elevation: 6,
  },
  genBtnText: { color: COLORS.background, fontWeight: '800' },
  streamBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 13,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: withAlpha(COLORS.gold, 0.4),
    backgroundColor: 'rgba(14,13,18,0.6)',
  },
  streamBtnText: { color: COLORS.gold, fontWeight: '800' },
  status: { color: COLORS.textMuted, fontSize: 12, marginTop: 12 },
  editorBorder: { borderRadius: 18, padding: 1, marginTop: 2 },
  bodyInput: {
    backgroundColor: 'rgba(20,20,28,0.55)',
    borderRadius: 17,
    padding: 14,
    color: COLORS.text,
    fontSize: 14,
    minHeight: 240,
    lineHeight: 21,
  },
  previewBox: {
    backgroundColor: 'rgba(10,10,14,0.72)',
    borderRadius: 17,
    padding: 16,
    minHeight: 240,
  },
  emptyState: { alignItems: 'center', justifyContent: 'center', paddingVertical: 48, gap: 12 },
  emptyChip: {
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: withAlpha(COLORS.gold, 0.1),
    borderWidth: 1,
    borderColor: withAlpha(COLORS.gold, 0.25),
  },
  placeholderText: { color: COLORS.textMuted, fontStyle: 'italic' },
  refineRow: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  refineInput: {
    flex: 1,
    backgroundColor: 'rgba(20,20,28,0.55)',
    borderWidth: 1,
    borderColor: withAlpha(COLORS.gold, 0.2),
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 11,
    color: COLORS.text,
    fontSize: 14,
  },
  refineBtn: {
    padding: 13,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: COLORS.gold,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.18,
    shadowRadius: 14,
    elevation: 6,
  },
});

export default ScriptEditorScreen;
