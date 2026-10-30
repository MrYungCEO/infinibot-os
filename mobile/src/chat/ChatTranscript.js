/**
 * ChatTranscript — renders the turns produced by session-sync.buildTurns with
 * the web chat's visual language (ui/src/ui/views/webchat.ts):
 *
 *   user       right-aligned rounded bubble on the strong glass surface
 *   assistant  no bubble — round brand-logo avatar + agent name + model, then
 *              the body indented under the name: markdown, code blocks with a
 *              copy button, tool cards, live panels, images
 *
 * Every size/colour comes from chat-tokens (generated from the web CSS).
 */
import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Image,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { Ionicons } from '@expo/vector-icons';
import Markdown from 'react-native-markdown-display';

import { useChatTokens } from './chat-tokens';
import { formatArgs } from './session-sync';
import { tap } from '../utils/haptics';
import { TappableImage } from '../components/ImageViewer';

const LOGO = require('../../assets/infinibot-logo.png');

// ── avatar ────────────────────────────────────────────────────────────────

/** The InfiniBot emblem in a round frame — the web's `.wc-avatar.chat-logo-avatar`. */
export const BrandAvatar = memo(function BrandAvatar({ size, style }) {
  const t = useChatTokens();
  const s = size || t.size.avatar;
  return (
    <View
      style={[
        {
          width: s,
          height: s,
          borderRadius: s / 2,
          borderWidth: 1,
          borderColor: t.borderStrong,
          backgroundColor: t.accentSoft,
          overflow: 'hidden',
          alignItems: 'center',
          justifyContent: 'center',
        },
        style,
      ]}
    >
      {/* The stock logo has wide transparent margins; scale to the emblem like
          the web's object-view-box crop. */}
      <Image source={LOGO} style={{ width: s * 1.62, height: s * 1.62 }} resizeMode="contain" accessibilityLabel="InfiniBot" />
    </View>
  );
});

// ── code block ────────────────────────────────────────────────────────────

function CodeBlock({ code, lang }) {
  const t = useChatTokens();
  const [copied, setCopied] = useState(false);
  const copy = useCallback(async () => {
    try {
      await Clipboard.setStringAsync(code);
      tap();
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {}
  }, [code]);
  return (
    <View style={[styles.code, { backgroundColor: t.codeBg, borderColor: t.borderNeutral, borderRadius: t.radius.code }]}>
      <View style={styles.codeHead}>
        <Text style={[styles.codeLang, { color: t.muted, fontFamily: t.font.mono }]} numberOfLines={1}>
          {lang || 'code'}
        </Text>
        <Pressable
          onPress={copy}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Copy code"
          style={[styles.codeCopy, { borderColor: copied ? t.accent : t.borderNeutral }]}
        >
          <Ionicons name={copied ? 'checkmark' : 'copy-outline'} size={12} color={copied ? t.accent : t.muted} />
          <Text style={[styles.codeCopyText, { color: copied ? t.accent : t.muted }]}>{copied ? 'Copied' : 'Copy'}</Text>
        </Pressable>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.codeScroll}>
        <Text selectable style={{ color: t.text, fontFamily: t.font.mono, fontSize: t.type.code, lineHeight: t.type.code * 1.55 }}>
          {code}
        </Text>
      </ScrollView>
    </View>
  );
}

// ── markdown ──────────────────────────────────────────────────────────────

function useMarkdown(t) {
  return useMemo(() => {
    const body = t.type.body;
    const mdStyles = StyleSheet.create({
      body: { color: t.text, fontFamily: t.font.regular, fontSize: body, lineHeight: Math.round(body * t.type.bodyLineHeight) },
      paragraph: { marginTop: 0, marginBottom: 10 },
      heading1: { color: t.textStrong, fontFamily: t.font.bold, fontSize: body * 1.35, lineHeight: body * 1.75, marginTop: 14, marginBottom: 6 },
      heading2: { color: t.textStrong, fontFamily: t.font.bold, fontSize: body * 1.2, lineHeight: body * 1.6, marginTop: 14, marginBottom: 6 },
      heading3: { color: t.textStrong, fontFamily: t.font.semiBold, fontSize: body * 1.07, lineHeight: body * 1.5, marginTop: 12, marginBottom: 4 },
      heading4: { color: t.textStrong, fontFamily: t.font.semiBold, fontSize: body, marginTop: 10, marginBottom: 4 },
      strong: { fontFamily: t.font.semiBold, color: t.textStrong, fontWeight: '600' },
      em: { fontStyle: 'italic' },
      link: { color: t.accent, textDecorationLine: 'underline' },
      bullet_list: { marginBottom: 10 },
      ordered_list: { marginBottom: 10 },
      list_item: { marginVertical: 2 },
      bullet_list_icon: { color: t.muted, marginLeft: 2, marginRight: 8 },
      ordered_list_icon: { color: t.muted, marginLeft: 2, marginRight: 8 },
      blockquote: {
        backgroundColor: 'transparent',
        borderLeftWidth: 3,
        borderLeftColor: t.accent,
        paddingHorizontal: 14,
        paddingVertical: 2,
        marginLeft: 0,
        marginBottom: 10,
      },
      code_inline: {
        fontFamily: t.font.mono,
        fontSize: body * 0.88,
        color: t.text,
        backgroundColor: t.surfaceStrong,
        borderWidth: 0,
        borderRadius: 5,
        padding: 0,
        paddingHorizontal: Platform.OS === 'web' ? 4 : 0,
      },
      table: { borderWidth: 1, borderColor: t.borderNeutral, borderRadius: 8, marginBottom: 10 },
      th: { padding: 8, backgroundColor: t.surface },
      td: { padding: 8 },
      tr: { borderBottomWidth: 1, borderColor: t.borderNeutral },
      hr: { backgroundColor: t.borderNeutral, height: 1, marginVertical: 12 },
      image: { borderRadius: 10 },
    });
    const rules = {
      fence: (node) => <CodeBlock key={node.key} code={String(node.content || '').replace(/\n$/, '')} lang={node.sourceInfo} />,
      code_block: (node) => <CodeBlock key={node.key} code={String(node.content || '').replace(/\n$/, '')} />,
      image: (node) => {
        const src = node.attributes?.src;
        if (!src) return null;
        return (
          <View key={node.key} style={styles.mdImage}>
            <TappableImage uri={src} style={styles.mdImageInner} />
          </View>
        );
      },
    };
    return { mdStyles, rules };
  }, [t]);
}

// A surface can intercept link taps (return false = handled, do not open).
const LinkPressContext = React.createContext(null);
export const ChatLinkHandler = LinkPressContext.Provider;

export const MarkdownText = memo(function MarkdownText({ text }) {
  const t = useChatTokens();
  const { mdStyles, rules } = useMarkdown(t);
  const onLinkPress = React.useContext(LinkPressContext);
  return (
    <Markdown style={mdStyles} rules={rules} mergeStyle onLinkPress={onLinkPress || undefined}>
      {text}
    </Markdown>
  );
});

// ── tool card ─────────────────────────────────────────────────────────────

const ToolCard = memo(function ToolCard({ tool }) {
  const t = useChatTokens();
  const [open, setOpen] = useState(false);
  const args = formatArgs(tool.args);
  const state = tool.pending ? 'running…' : tool.result ? 'completed' : 'called';
  return (
    <View style={[styles.tool, { borderColor: t.border, backgroundColor: t.surface, borderRadius: t.radius.tool }]}>
      <Pressable
        onPress={() => { tap(); setOpen((v) => !v); }}
        style={styles.toolHead}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`Tool ${tool.name}, ${state}`}
      >
        {tool.pending
          ? <ActivityIndicator size="small" color={t.accent} style={styles.toolSpin} />
          : <Ionicons name="construct-outline" size={14} color={t.accent} />}
        <Text style={[styles.toolName, { color: t.text, fontFamily: t.font.mono, fontSize: t.type.tool }]} numberOfLines={1}>
          {tool.name}
        </Text>
        <Text style={[styles.toolState, { color: t.muted }]} numberOfLines={1}>{state}</Text>
        <Ionicons name={open ? 'chevron-down' : 'chevron-forward'} size={14} color={t.muted} />
      </Pressable>
      {open ? (
        <View style={styles.toolBody}>
          {args ? (
            <>
              <Text style={[styles.toolLbl, { color: t.muted }]}>ARGUMENTS</Text>
              <ScrollView style={[styles.toolPre, { backgroundColor: t.codeBg }]} nestedScrollEnabled>
                <Text selectable style={{ color: t.text, fontFamily: t.font.mono, fontSize: 11.5 }}>{args}</Text>
              </ScrollView>
            </>
          ) : null}
          {tool.result ? (
            <>
              <Text style={[styles.toolLbl, { color: t.muted, marginTop: args ? 8 : 0 }]}>RESULT</Text>
              <ScrollView style={[styles.toolPre, { backgroundColor: t.codeBg }]} nestedScrollEnabled>
                <Text selectable style={{ color: t.text, fontFamily: t.font.mono, fontSize: 11.5 }}>
                  {tool.result.length > 6000 ? `${tool.result.slice(0, 6000)}\n… (${tool.result.length - 6000} more characters)` : tool.result}
                </Text>
              </ScrollView>
            </>
          ) : null}
          {!args && !tool.result ? <Text style={{ color: t.muted, fontSize: 12 }}>No arguments or output.</Text> : null}
        </View>
      ) : null}
    </View>
  );
});

// ── chat panel (show_panel) ───────────────────────────────────────────────

/**
 * A `show_panel` result. The web mounts an interactive card per kind; here the
 * panel is rendered natively from the kind's text view (the gateway's
 * `chat.panel.refresh` returns `text` for exactly this — channels without the
 * web renderers), kept live on the kind's refresh interval, with a button to
 * the full web page.
 */
export const PanelCard = memo(function PanelCard({ panel, sendReq, onOpenLink }) {
  const t = useChatTokens();
  const [result, setResult] = useState(null);
  const [error, setError] = useState(panel.error || null);
  const [loading, setLoading] = useState(false);
  const alive = useRef(true);

  const load = useCallback(async () => {
    if (typeof sendReq !== 'function') return;
    setLoading(true);
    try {
      const res = await sendReq('chat.panel.refresh', { kind: panel.kind, query: panel.query, title: panel.title });
      if (!alive.current) return;
      setResult(res);
      setError(res?.error || null);
    } catch (err) {
      if (alive.current) setError(String(err?.message || err));
    } finally {
      if (alive.current) setLoading(false);
    }
  }, [sendReq, panel.kind, panel.query, panel.title]);

  useEffect(() => {
    alive.current = true;
    load();
    const every = panel.refreshMs > 0 ? Math.max(panel.refreshMs, 5000) : 0;
    const timer = every ? setInterval(load, every) : null;
    return () => {
      alive.current = false;
      if (timer) clearInterval(timer);
    };
  }, [load, panel.refreshMs]);

  const title = result?.title || panel.title;
  const summary = result?.summary || panel.summary;
  const link = result?.link || panel.link;
  const text = result?.text || '';
  const empty = result ? result.empty : panel.empty;
  const canOpen = Boolean(link && (link.path || link.tab));

  return (
    <View style={[styles.panel, { borderColor: t.borderStrong, backgroundColor: t.surface, borderRadius: t.radius.panel }]}>
      <View style={styles.panelHead}>
        <View style={[styles.panelIcon, { backgroundColor: t.accentSoft }]}>
          <Ionicons name="albums-outline" size={14} color={t.accent} />
        </View>
        <View style={styles.panelTitles}>
          <Text style={[styles.panelTitle, { color: t.textStrong, fontFamily: t.font.semiBold }]} numberOfLines={1}>{title}</Text>
          {summary && !error ? <Text style={[styles.panelSummary, { color: t.muted }]} numberOfLines={2}>{summary}</Text> : null}
        </View>
        <Pressable onPress={() => { tap(); load(); }} hitSlop={10} accessibilityRole="button" accessibilityLabel="Refresh panel">
          {loading ? <ActivityIndicator size="small" color={t.accent} /> : <Ionicons name="refresh" size={16} color={t.muted} />}
        </Pressable>
      </View>
      {error ? (
        <Text style={[styles.panelError, { color: t.danger, backgroundColor: t.dangerSubtle }]}>{error}</Text>
      ) : text ? (
        <ScrollView style={styles.panelBody} nestedScrollEnabled>
          <MarkdownText text={text} />
        </ScrollView>
      ) : empty ? (
        <Text style={[styles.panelEmpty, { color: t.muted }]}>Nothing to show right now.</Text>
      ) : !result ? (
        <View style={styles.panelSkel}>
          <View style={[styles.skelLine, { width: '82%', backgroundColor: t.surfaceStrong }]} />
          <View style={[styles.skelLine, { width: '64%', backgroundColor: t.surfaceStrong }]} />
        </View>
      ) : null}
      {canOpen ? (
        <Pressable
          onPress={() => { tap(); onOpenLink?.(link, title); }}
          style={[styles.panelOpen, { borderTopColor: t.borderNeutral }]}
          accessibilityRole="button"
        >
          <Text style={{ color: t.accent, fontFamily: t.font.semiBold, fontSize: 13 }}>{link.label || 'Open'}</Text>
          <Ionicons name="arrow-forward" size={14} color={t.accent} />
        </Pressable>
      ) : null}
    </View>
  );
});

// ── typing + caret ────────────────────────────────────────────────────────

export function TypingDots() {
  const t = useChatTokens();
  const dots = useRef([0, 1, 2].map(() => new Animated.Value(0))).current;
  useEffect(() => {
    const anims = dots.map((d, i) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(i * 150),
          Animated.timing(d, { toValue: 1, duration: 380, useNativeDriver: Platform.OS !== 'web' }),
          Animated.timing(d, { toValue: 0, duration: 380, useNativeDriver: Platform.OS !== 'web' }),
          Animated.delay((2 - i) * 150),
        ]),
      ),
    );
    anims.forEach((a) => a.start());
    return () => anims.forEach((a) => a.stop());
  }, [dots]);
  return (
    <View style={styles.typing} accessibilityLabel="Assistant is typing">
      {dots.map((d, i) => (
        <Animated.View
          key={i}
          style={[
            styles.typingDot,
            { backgroundColor: t.accent, opacity: d.interpolate({ inputRange: [0, 1], outputRange: [0.3, 1] }),
              transform: [{ translateY: d.interpolate({ inputRange: [0, 1], outputRange: [0, -3] }) }] },
          ]}
        />
      ))}
    </View>
  );
}

// ── turns ─────────────────────────────────────────────────────────────────

const UserTurn = memo(function UserTurn({ turn }) {
  const t = useChatTokens();
  return (
    <View style={styles.user}>
      {turn.images?.length ? (
        <View style={styles.userImgs}>
          {turn.images.map((uri, i) => (
            <TappableImage key={i} uri={uri} style={[styles.userImg, { borderColor: t.border }]} />
          ))}
        </View>
      ) : null}
      {turn.text ? (
        <View
          style={[
            styles.bubble,
            {
              maxWidth: `${t.size.bubbleMaxWidthPct}%`,
              paddingVertical: t.size.bubblePadV,
              paddingHorizontal: t.size.bubblePadH,
              borderRadius: t.radius.bubble,
              backgroundColor: t.surfaceStrong,
              borderColor: turn.failed ? t.danger : t.border,
              opacity: turn.pending && !turn.failed ? 0.86 : 1,
            },
          ]}
        >
          <Text selectable style={{ color: t.textStrong, fontFamily: t.font.regular, fontSize: t.type.body, lineHeight: Math.round(t.type.body * t.type.bubbleLineHeight) }}>
            {turn.text}
          </Text>
        </View>
      ) : null}
      {turn.failed ? (
        <Text style={[styles.failed, { color: t.danger }]}>Not sent — check the connection and try again.</Text>
      ) : null}
    </View>
  );
});

const AssistantTurn = memo(function AssistantTurn({ turn, agentName, sendReq, onOpenLink }) {
  const t = useChatTokens();
  const [copied, setCopied] = useState(false);
  const plain = useMemo(
    () => turn.blocks.filter((b) => b.kind === 'text').map((b) => b.text).join('\n\n'),
    [turn.blocks],
  );
  const copy = useCallback(async () => {
    try {
      await Clipboard.setStringAsync(plain);
      tap();
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {}
  }, [plain]);
  const hasText = turn.blocks.some((b) => b.kind === 'text');
  return (
    <View style={styles.asst}>
      <View style={styles.asstHead}>
        <BrandAvatar />
        <Text style={{ color: t.textStrong, fontFamily: t.font.semiBold, fontSize: t.type.asstName }} numberOfLines={1}>
          {agentName}
        </Text>
        {turn.model ? (
          <Text style={[styles.asstModel, { color: t.muted, fontFamily: t.font.mono, fontSize: t.type.asstModel }]} numberOfLines={1}>
            {turn.model}
          </Text>
        ) : null}
      </View>
      <View style={{ paddingLeft: t.size.assistantIndent }}>
        {turn.blocks.map((b, i) => {
          if (b.kind === 'text') return <MarkdownText key={i} text={b.text} />;
          if (b.kind === 'panel') return <PanelCard key={b.panel.panelId || i} panel={b.panel} sendReq={sendReq} onOpenLink={onOpenLink} />;
          if (b.kind === 'tool') return <ToolCard key={b.tool.id || i} tool={b.tool} />;
          if (b.kind === 'error') {
            return (
              <Text key={i} style={[styles.error, { color: t.danger, backgroundColor: t.dangerSubtle, borderColor: t.danger, borderRadius: t.radius.row }]}>
                {b.text}
              </Text>
            );
          }
          return null;
        })}
        {turn.streaming && !hasText ? <TypingDots /> : null}
        {!turn.streaming && plain ? (
          <Pressable onPress={copy} hitSlop={8} style={styles.asstActions} accessibilityRole="button" accessibilityLabel="Copy reply">
            <Ionicons name={copied ? 'checkmark' : 'copy-outline'} size={14} color={copied ? t.accent : t.mutedStrong} />
          </Pressable>
        ) : null}
      </View>
    </View>
  );
});

export const ChatTurn = memo(function ChatTurn({ turn, agentName, sendReq, onOpenLink }) {
  const t = useChatTokens();
  return (
    <View style={{ marginBottom: t.size.turnGap }}>
      {turn.role === 'user'
        ? <UserTurn turn={turn} />
        : <AssistantTurn turn={turn} agentName={agentName} sendReq={sendReq} onOpenLink={onOpenLink} />}
    </View>
  );
});

/** Loading placeholder — the web's `.wc-skel` (one user line, two reply lines). */
export function TranscriptSkeleton() {
  const t = useChatTokens();
  const pulse = useRef(new Animated.Value(0.45)).current;
  useEffect(() => {
    const a = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 700, useNativeDriver: Platform.OS !== 'web' }),
        Animated.timing(pulse, { toValue: 0.45, duration: 700, useNativeDriver: Platform.OS !== 'web' }),
      ]),
    );
    a.start();
    return () => a.stop();
  }, [pulse]);
  const line = (w, right) => (
    <Animated.View
      style={{ height: 16, borderRadius: 8, width: w, alignSelf: right ? 'flex-end' : 'flex-start', backgroundColor: t.surfaceStrong, opacity: pulse }}
    />
  );
  return (
    <View style={styles.skel} accessibilityLabel="Loading conversation">
      {line('40%', true)}
      {line('90%')}
      {line('70%')}
      {line('34%', true)}
      {line('84%')}
    </View>
  );
}

const styles = StyleSheet.create({
  user: { alignItems: 'flex-end', gap: 4 },
  bubble: { borderWidth: 1 },
  userImgs: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, justifyContent: 'flex-end' },
  userImg: { width: 160, height: 160, borderRadius: 12, borderWidth: 1 },
  failed: { fontSize: 11 },
  asst: { gap: 6 },
  asstHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  asstModel: { flexShrink: 1 },
  asstActions: { alignSelf: 'flex-start', paddingVertical: 4, paddingRight: 8 },
  error: { borderWidth: 1, paddingHorizontal: 14, paddingVertical: 10, fontSize: 13, overflow: 'hidden', marginBottom: 8 },
  typing: { flexDirection: 'row', gap: 5, paddingVertical: 8 },
  typingDot: { width: 7, height: 7, borderRadius: 4 },
  code: { borderWidth: 1, marginBottom: 10, overflow: 'hidden' },
  codeHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingLeft: 12, paddingRight: 8, paddingTop: 6 },
  codeLang: { fontSize: 10.5, textTransform: 'lowercase' },
  codeCopy: { flexDirection: 'row', alignItems: 'center', gap: 4, borderWidth: 1, borderRadius: 7, paddingHorizontal: 8, paddingVertical: 3 },
  codeCopyText: { fontSize: 11 },
  codeScroll: { paddingHorizontal: 12, paddingTop: 8, paddingBottom: 12 },
  mdImage: { marginBottom: 10 },
  mdImageInner: { width: '100%', aspectRatio: 1.5, borderRadius: 10 },
  tool: { borderWidth: 1, marginBottom: 10, overflow: 'hidden' },
  toolHead: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 10, minHeight: 36 },
  toolSpin: { transform: [{ scale: 0.7 }], width: 14, height: 14 },
  toolName: { flexShrink: 1 },
  toolState: { flex: 1, fontSize: 11 },
  toolBody: { paddingHorizontal: 10, paddingBottom: 10 },
  toolLbl: { fontSize: 10, letterSpacing: 0.6, marginBottom: 4 },
  toolPre: { maxHeight: 220, borderRadius: 8, padding: 8 },
  panel: { borderWidth: 1, marginBottom: 10, overflow: 'hidden' },
  panelHead: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12 },
  panelIcon: { width: 28, height: 28, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  panelTitles: { flex: 1, minWidth: 0 },
  panelTitle: { fontSize: 14 },
  panelSummary: { fontSize: 12, marginTop: 1 },
  panelBody: { maxHeight: 320, paddingHorizontal: 12 },
  panelError: { marginHorizontal: 12, marginBottom: 12, padding: 10, borderRadius: 8, fontSize: 12, overflow: 'hidden' },
  panelEmpty: { paddingHorizontal: 12, paddingBottom: 12, fontSize: 13 },
  panelSkel: { paddingHorizontal: 12, paddingBottom: 12, gap: 8 },
  skelLine: { height: 12, borderRadius: 6 },
  panelOpen: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12, minHeight: 44, borderTopWidth: StyleSheet.hairlineWidth },
  skel: { gap: 14, paddingTop: 8 },
});
