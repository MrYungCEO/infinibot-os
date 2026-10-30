// ContentGenerationScreen — image/video generation for a content page.
//
// React Native routes generation through the content agent over chat.send.
// When enabled, the first-party FlyPic plugin contributes the
// flypic_generate_image / flypic_generate_video agent tools. We stream the
// agent's progress over EVENT.CHAT,
// parse any produced asset URL(s) out of the final message, preview them,
// and attach the chosen asset to the page's `videos` / `content` child-DB
// via content.pages.children.create (so it shows up on web + mobile).

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Image,
  Alert,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { COLORS } from '../../constants/theme';
import { withAlpha, glassGradient, headerGradient, innerTopHighlight } from '../../theme/color-utils';
import { EVENT, CHAT_STATE, METHOD } from '../../constants/gateway';
import { createChild, saveDraft, loadDraft, clearDraft } from './contentApi';

// Pull http(s) image/video URLs (markdown or bare) out of agent output.
function extractAssetUrls(text) {
  if (!text) return [];
  const urls = new Set();
  const md = /!\[[^\]]*\]\((https?:\/\/[^)\s]+|\/media\/[^)\s]+)\)/g;
  let m;
  while ((m = md.exec(text))) urls.add(m[1]);
  const bare = /(https?:\/\/[^\s)]+\.(?:png|jpe?g|webp|gif|mp4|mov|webm))/gi;
  while ((m = bare.exec(text))) urls.add(m[1]);
  // gateway-relative media paths
  const rel = /(\/media\/[^\s)]+\.(?:png|jpe?g|webp|gif|mp4|mov|webm))/gi;
  while ((m = rel.exec(text))) urls.add(m[1]);
  return Array.from(urls);
}

function isVideo(url) {
  return /\.(mp4|mov|webm)(\?|$)/i.test(url || '');
}

export function ContentGenerationScreen({ gateway, route, navigation }) {
  const pageId = route?.params?.pageId;
  const pageName = route?.params?.pageName || 'Content';
  const kind = route?.params?.kind === 'content' ? 'content' : 'videos';
  const draftKey = `gen.${pageId || 'adhoc'}.${kind}`;

  const [prompt, setPrompt] = useState('');
  const [mode, setMode] = useState(kind === 'content' ? 'image' : 'video');
  const [streaming, setStreaming] = useState(false);
  const [log, setLog] = useState('');
  const [assets, setAssets] = useState([]);
  const [status, setStatus] = useState('');
  const [attaching, setAttaching] = useState('');

  // Route to CONTENT-DIRECTOR, which receives tools from enabled plugins,
  // via the `agent:<id>:<rest>` session-key convention.
  const sessionKeyRef = useRef(`agent:content-director:media-${pageId || 'adhoc'}-${kind}`);

  useEffect(() => {
    loadDraft(draftKey).then((d) => {
      if (d?.prompt) setPrompt(d.prompt);
    });
  }, [draftKey]);

  useEffect(() => {
    if (!prompt) return;
    const t = setTimeout(() => saveDraft(draftKey, { prompt }), 600);
    return () => clearTimeout(t);
  }, [prompt, draftKey]);

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
      setLog(text);
    } else if (state === CHAT_STATE.FINAL) {
      setLog(text);
      const found = extractAssetUrls(text);
      setAssets(found);
      setStreaming(false);
      setStatus(found.length ? `✓ ${found.length} asset(s) produced` : 'Finished — no asset URL detected');
    } else if (state === CHAT_STATE.ERROR || state === CHAT_STATE.ABORTED) {
      setStreaming(false);
      setStatus('Generation ended');
    }
  }, []);

  const generate = async () => {
    if (!prompt.trim()) {
      Alert.alert('Prompt required', 'Describe the image or video you want.');
      return;
    }
    setStreaming(true);
    setAssets([]);
    setLog('');
    setStatus(`Generating ${mode}…`);
    const unsub = gateway.subscribeEvent(EVENT.CHAT, handleChatEvent);
    const tool = mode === 'video' ? 'flypic_generate_video' : 'flypic_generate_image';
    try {
      await gateway.sendReq(METHOD.CHAT_SEND, {
        sessionKey: sessionKeyRef.current,
        message:
          `Use the ${tool} agent tool to create a ${mode} for the "${pageName}" content page. ` +
          `Prompt: ${prompt.trim()}. ` +
          `When done, reply with ONLY the resulting asset URL(s) on their own line so they can be attached.`,
        idempotencyKey: `media-generation-${Date.now()}`,
      });
    } catch (e) {
      setStreaming(false);
      setStatus(e?.message || 'Generation failed');
    }
    setTimeout(() => unsub && unsub(), 180000);
  };

  const attach = async (url) => {
    if (!pageId) {
      Alert.alert('No page', 'Open this from a content page to attach.');
      return;
    }
    setAttaching(url);
    try {
      await createChild(gateway, pageId, kind, prompt.trim().slice(0, 60) || 'Generated asset', {
        fileUrl: { type: 'url', url },
        thumbnailUrl: { type: 'url', url },
        status: { type: 'select', value: 'editing' },
        prompt: { type: 'richText', markdown: prompt.trim() },
      });
      setStatus('✓ Attached to page');
      await clearDraft(draftKey);
      navigation?.navigate?.('ContentModal', { refreshAt: Date.now() });
    } catch (e) {
      Alert.alert('Attach failed', e?.message || 'Unknown error');
    } finally {
      setAttaching('');
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
        <TouchableOpacity
          onPress={() => navigation?.goBack?.()}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          style={styles.backChip}
        >
          <Ionicons name="arrow-back" size={20} color={COLORS.gold} />
        </TouchableOpacity>
        <View style={{ flex: 1, marginLeft: 12 }}>
          <Text style={styles.title}>Generate</Text>
          <Text style={styles.meta} numberOfLines={1}>
            {pageName} · {kind}
          </Text>
        </View>
      </LinearGradient>

      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <View style={styles.modeRow}>
            {['image', 'video'].map((m) => (
              <TouchableOpacity key={m} style={[styles.modeChip, mode === m && styles.modeChipActive]} onPress={() => setMode(m)}>
                <Ionicons
                  name={m === 'image' ? 'image-outline' : 'videocam-outline'}
                  size={14}
                  color={mode === m ? COLORS.gold : COLORS.textMuted}
                />
                <Text style={[styles.modeChipText, mode === m && styles.modeChipTextActive]}>{m}</Text>
              </TouchableOpacity>
            ))}
          </View>

          <View style={styles.labelRow}>
            <View style={styles.accentBar} />
            <Text style={styles.fieldLabel}>Prompt</Text>
          </View>
          <TextInput
            style={styles.promptInput}
            value={prompt}
            onChangeText={setPrompt}
            placeholder={`Describe the ${mode}…`}
            placeholderTextColor={COLORS.textMuted}
            multiline
          />

          <TouchableOpacity style={styles.genBtnWrap} onPress={generate} disabled={streaming} activeOpacity={0.85}>
            <LinearGradient
              colors={COLORS.goldGradient}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={[styles.genBtn, streaming && { opacity: 0.7 }]}
            >
              {streaming ? (
                <ActivityIndicator size="small" color={COLORS.background} />
              ) : (
                <>
                  <Ionicons name="sparkles" size={16} color={COLORS.background} />
                  <Text style={styles.genBtnText}>Generate {mode}</Text>
                </>
              )}
            </LinearGradient>
          </TouchableOpacity>

          <Text style={styles.note}>
            Runs through the enabled FlyPic provider plugin. Generation can take a while; progress streams below.
          </Text>

          {status ? (
            <Text style={[styles.status, status.startsWith('✓') && { color: '#37d67a' }]}>
              {/* '✓' prefix is an internal success marker — drawn as a vector icon */}
              {status.startsWith('✓') ? <Ionicons name="checkmark-circle" size={13} color="#37d67a" /> : null}
              {status.startsWith('✓') ? status.slice(1) : status}
            </Text>
          ) : null}

          {assets.length > 0 ? (
            <View style={{ marginTop: 14 }}>
              <View style={styles.labelRow}>
                <View style={styles.accentBar} />
                <Text style={styles.fieldLabel}>Results</Text>
              </View>
              {assets.map((url) => (
                <LinearGradient
                  key={url}
                  colors={[withAlpha(COLORS.gold, 0.55), withAlpha(COLORS.gold, 0.08), 'transparent']}
                  start={{ x: 0, y: 0 }}
                  end={{ x: 1, y: 1 }}
                  style={styles.assetBorder}
                >
                  <View style={styles.assetCard}>
                    {isVideo(url) ? (
                      <View style={styles.videoPlaceholder}>
                        <Ionicons name="play-circle-outline" size={32} color={COLORS.gold} />
                        <Text style={styles.videoUrl} numberOfLines={1}>
                          {url}
                        </Text>
                      </View>
                    ) : (
                      <Image source={{ uri: url }} style={styles.assetImage} resizeMode="cover" />
                    )}
                    <TouchableOpacity style={styles.attachBtnWrap} onPress={() => attach(url)} disabled={!!attaching} activeOpacity={0.85}>
                      <LinearGradient
                        colors={COLORS.goldGradient}
                        start={{ x: 0, y: 0 }}
                        end={{ x: 1, y: 1 }}
                        style={styles.attachBtn}
                      >
                        {attaching === url ? (
                          <ActivityIndicator size="small" color={COLORS.background} />
                        ) : (
                          <Text style={styles.attachBtnText}>Attach to page</Text>
                        )}
                      </LinearGradient>
                    </TouchableOpacity>
                  </View>
                </LinearGradient>
              ))}
            </View>
          ) : null}

          {log ? (
            <View style={styles.logBox}>
              <View style={styles.labelRow}>
                <View style={styles.accentBar} />
                <Text style={styles.logLabel}>Agent output</Text>
              </View>
              <Text style={styles.logText}>{log}</Text>
            </View>
          ) : null}

          <View style={{ height: 40 }} />
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.background },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: withAlpha(COLORS.gold, 0.15),
  },
  backChip: {
    width: 38,
    height: 38,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(10,10,14,0.72)',
    borderWidth: 1,
    borderColor: withAlpha(COLORS.gold, 0.25),
  },
  title: { color: COLORS.text, fontSize: 17, fontWeight: '800', letterSpacing: 0.3 },
  meta: { color: COLORS.textMuted, fontSize: 11, marginTop: 1 },
  content: { paddingHorizontal: 16, paddingTop: 8 },
  labelRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 14, marginBottom: 6 },
  accentBar: { width: 3, height: 13, borderRadius: 2, backgroundColor: COLORS.gold },
  modeRow: { flexDirection: 'row', gap: 10, marginTop: 6 },
  modeChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 16,
    paddingVertical: 9,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: withAlpha(COLORS.gold, 0.2),
    backgroundColor: 'rgba(14,13,18,0.6)',
  },
  modeChipActive: {
    backgroundColor: withAlpha(COLORS.gold, 0.18),
    borderColor: withAlpha(COLORS.gold, 0.5),
  },
  modeChipText: { color: COLORS.textMuted, fontSize: 13, fontWeight: '700', textTransform: 'capitalize' },
  modeChipTextActive: { color: COLORS.gold },
  fieldLabel: { color: COLORS.gold, fontSize: 11, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 1 },
  promptInput: {
    backgroundColor: 'rgba(20,20,28,0.55)',
    borderWidth: 1,
    borderColor: withAlpha(COLORS.gold, 0.2),
    borderRadius: 14,
    padding: 14,
    color: COLORS.text,
    fontSize: 15,
    minHeight: 90,
    textAlignVertical: 'top',
  },
  genBtnWrap: {
    marginTop: 16,
    borderRadius: 999,
    overflow: 'hidden',
    shadowColor: COLORS.gold,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.35,
    shadowRadius: 14,
    elevation: 8,
  },
  genBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7,
    paddingVertical: 14,
    borderRadius: 999,
  },
  genBtnText: { color: COLORS.background, fontWeight: '800', fontSize: 15, letterSpacing: 0.3 },
  note: { color: COLORS.textMuted, fontSize: 11, marginTop: 12, lineHeight: 16 },
  status: { color: COLORS.textMuted, fontSize: 12, marginTop: 12 },
  assetBorder: {
    borderRadius: 18,
    padding: 1,
    marginBottom: 12,
    shadowColor: COLORS.gold,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.18,
    shadowRadius: 14,
    elevation: 6,
  },
  assetCard: {
    borderRadius: 17,
    overflow: 'hidden',
    backgroundColor: 'rgba(10,10,14,0.72)',
  },
  assetImage: { width: '100%', height: 220, backgroundColor: '#000' },
  videoPlaceholder: { height: 120, alignItems: 'center', justifyContent: 'center', gap: 8, padding: 12 },
  videoUrl: { color: COLORS.textMuted, fontSize: 11 },
  attachBtnWrap: { overflow: 'hidden' },
  attachBtn: { paddingVertical: 13, alignItems: 'center' },
  attachBtnText: { color: COLORS.background, fontWeight: '800', letterSpacing: 0.3 },
  logBox: {
    marginTop: 16,
    borderWidth: 1,
    borderColor: withAlpha(COLORS.gold, 0.18),
    borderRadius: 16,
    padding: 14,
    backgroundColor: 'rgba(14,13,18,0.6)',
    shadowColor: COLORS.gold,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.12,
    shadowRadius: 12,
    elevation: 4,
  },
  logLabel: { color: COLORS.gold, fontSize: 10, fontWeight: '800', letterSpacing: 1, textTransform: 'uppercase' },
  logText: { color: COLORS.text, fontSize: 12, lineHeight: 18, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', marginTop: 8 },
});

export default ContentGenerationScreen;
