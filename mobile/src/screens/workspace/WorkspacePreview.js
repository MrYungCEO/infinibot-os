/**
 * WorkspacePreview — the live preview canvas of the native Workspace page.
 *
 * Web / App mode (web renderPreview):
 *   · dev server ready / manual URL → the proxied page in a WebView (native,
 *     authed: Bearer header + the gateway's session cookie bootstrapped via
 *     POST /api/auth/session so sub-resources load too) or an <iframe> on the
 *     web export.
 *   · active tab is an HTML file → rendered from the buffer (srcDoc / html),
 *     so unsaved edits preview instantly like the web's local preview.
 *   · server errored → "The preview server needs a hand" card + Fix with agent
 *   · otherwise → detecting / install-and-start / start card.
 * Document mode → rendered markdown of the active file.
 * Presentation mode → slide deck (prev / next / dots) from the active file.
 * PDF mode → print-styled rendering of the active file (+ Export on web).
 *
 * Device toggle (desktop / tablet / mobile) renders the page at that CSS
 * width and scales it to fit, like the web's device frame. "Select" turns on
 * the gateway preview proxy's element inspector (dev-server previews only);
 * picks come back as `infinibot:element-selected` and feed the composer.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Linking, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Markdown from 'react-native-markdown-display';
import { WebView } from 'react-native-webview';

import { Button, Chip, EmptyState, MONO_FAMILY, RADIUS, SPACE, Skeleton, useUIKit } from '../../ui-kit';
import { getGatewayAuthHeaders, getGatewayUrl } from '../../utils/storage';
import { gatewayHttpOrigin } from '../../utils/gatewayHost';
import { DEVICE_WIDTHS, isHtmlFile, isMarkdownFile, parseSlides, previewTarget, runtimeStatusOf } from './workspace-model';

/** Gateway HTTP origin + auth headers (+ a one-shot session-cookie bootstrap on native). */
export function useGatewayHttp() {
  const [cfg, setCfg] = useState({ origin: '', headers: {}, ready: false });
  useEffect(() => {
    let alive = true;
    (async () => {
      const [url, headers] = await Promise.all([getGatewayUrl(), getGatewayAuthHeaders()]);
      let origin = gatewayHttpOrigin(url);
      if (!origin && Platform.OS === 'web' && typeof window !== 'undefined') origin = window.location.origin;
      if (Platform.OS !== 'web' && origin && headers?.Authorization) {
        // Cookie jar is shared with the WebView, so proxied CSS/JS authenticate.
        try {
          await fetch(`${origin}/api/auth/session`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: '{}', credentials: 'include' });
        } catch {
          /* header auth still covers the document itself */
        }
      }
      if (alive) setCfg({ origin, headers: headers || {}, ready: true });
    })();
    return () => { alive = false; };
  }, []);
  return cfg;
}

const INSPECTOR_BRIDGE = `(function(){try{
  var fwd=function(d){try{window.ReactNativeWebView&&window.ReactNativeWebView.postMessage(JSON.stringify(d));}catch(e){}};
  var orig=window.postMessage.bind(window);
  window.postMessage=function(d,o){if(d&&d.type==='infinibot:element-selected'){fwd(d);return;}return orig(d,o);};
}catch(e){}})(); true;`;

function inspectorToggleJs(on) {
  return `(function(){try{window.__INFINIBOT_INSPECTOR__=${on ? 'true' : 'false'};window.dispatchEvent(new MessageEvent('message',{data:{type:'infinibot:inspector',enabled:${on ? 'true' : 'false'}},origin:location.origin}));}catch(e){}})(); true;`;
}

/** A page rendered at `deviceWidth` CSS px and scaled to the available width. */
function ScaledFrame({ width, height, deviceWidth, children }) {
  const scale = deviceWidth > width ? width / deviceWidth : 1;
  const innerW = deviceWidth > width ? deviceWidth : width;
  const innerH = height / scale;
  return (
    <View style={{ width, height, overflow: 'hidden' }}>
      <View
        style={{
          width: innerW,
          height: innerH,
          transform: [{ translateX: -(innerW - width) / 2 }, { translateY: -(innerH - height) / 2 }, { scale }],
        }}
      >
        {children}
      </View>
    </View>
  );
}

function FramedPage({ source, html, inspector, onSelect, width, height, deviceWidth }) {
  const ref = useRef(null);
  useEffect(() => {
    if (Platform.OS !== 'web') ref.current?.injectJavaScript?.(inspectorToggleJs(inspector));
  }, [inspector]);
  let body;
  if (Platform.OS === 'web') {
    body = React.createElement('iframe', {
      key: source?.uri || 'srcdoc',
      ...(html != null ? { srcDoc: html, sandbox: 'allow-scripts allow-forms' } : { src: source?.uri }),
      title: 'Workspace live preview',
      style: { border: 0, width: '100%', height: '100%', background: 'white' },
    });
  } else {
    body = (
      <WebView
        ref={ref}
        originWhitelist={['*']}
        source={html != null ? { html } : source}
        sharedCookiesEnabled
        thirdPartyCookiesEnabled
        javaScriptEnabled
        domStorageEnabled
        injectedJavaScriptBeforeContentLoaded={INSPECTOR_BRIDGE}
        onLoadEnd={() => ref.current?.injectJavaScript?.(inspectorToggleJs(inspector))}
        onMessage={(e) => {
          try {
            const d = JSON.parse(e.nativeEvent.data);
            if (d?.type === 'infinibot:element-selected') onSelect?.(d);
          } catch {
            /* not ours */
          }
        }}
        style={{ flex: 1, backgroundColor: 'transparent' }}
      />
    );
  }
  return (
    <ScaledFrame width={width} height={height} deviceWidth={deviceWidth}>
      <View style={{ flex: 1 }}>{body}</View>
    </ScaledFrame>
  );
}

function useMarkdownStyles() {
  const { colors, alpha } = useUIKit();
  return useMemo(
    () => ({
      body: { color: colors.text, fontSize: 15, lineHeight: 22 },
      heading1: { color: colors.text, fontSize: 24, fontWeight: '700', marginTop: SPACE.md, marginBottom: SPACE.sm },
      heading2: { color: colors.text, fontSize: 20, fontWeight: '700', marginTop: SPACE.md, marginBottom: SPACE.xs },
      heading3: { color: colors.text, fontSize: 17, fontWeight: '600', marginTop: SPACE.sm },
      link: { color: colors.primary },
      code_inline: { fontFamily: MONO_FAMILY, backgroundColor: alpha(colors.text, 0.08), color: colors.primary, borderRadius: 4, paddingHorizontal: 4 },
      code_block: { fontFamily: MONO_FAMILY, backgroundColor: alpha(colors.text, 0.05), color: colors.text, borderRadius: RADIUS.sm, padding: SPACE.md, borderColor: colors.borderSubtle, borderWidth: 1 },
      fence: { fontFamily: MONO_FAMILY, backgroundColor: alpha(colors.text, 0.05), color: colors.text, borderRadius: RADIUS.sm, padding: SPACE.md, borderColor: colors.borderSubtle, borderWidth: 1 },
      blockquote: { backgroundColor: alpha(colors.primary, 0.06), borderLeftColor: colors.primary, borderLeftWidth: 3, paddingHorizontal: SPACE.md },
      hr: { backgroundColor: colors.border },
      table: { borderColor: colors.border },
      th: { borderColor: colors.border, padding: 6 },
      td: { borderColor: colors.border, padding: 6 },
      bullet_list_icon: { color: colors.primary },
      ordered_list_icon: { color: colors.primary },
    }),
    [colors, alpha],
  );
}

function NeedFile({ title, message }) {
  return <EmptyState icon="document-text-outline" title={title} message={message} />;
}

/** Document mode — rendered markdown (non-markdown files show as mono text). */
function DocumentPreview({ tab }) {
  const md = useMarkdownStyles();
  const { colors } = useUIKit();
  if (!tab) return <NeedFile title="Open a markdown file" message="Select a .md file from Files to see the live preview." />;
  return (
    <ScrollView contentContainerStyle={{ padding: SPACE.lg }}>
      {isMarkdownFile(tab.name) || /\.txt$/i.test(tab.name) ? (
        <Markdown style={md}>{tab.content || ''}</Markdown>
      ) : (
        <Text style={{ fontFamily: MONO_FAMILY, fontSize: 12, color: colors.textSecondary }} selectable>{tab.content}</Text>
      )}
    </ScrollView>
  );
}

/** Presentation mode — one slide at a time. */
function SlideDeck({ tab, index, onIndex }) {
  const md = useMarkdownStyles();
  const { colors, type, alpha } = useUIKit();
  if (!tab) return <NeedFile title="Open a markdown file" message="Slides are parsed from a markdown file. Open one from Files." />;
  const slides = parseSlides(tab.content);
  const total = Math.max(1, slides.length);
  const idx = Math.min(index, total - 1);
  return (
    <View style={{ flex: 1, padding: SPACE.md, gap: SPACE.md }}>
      <View style={styles.slideBar}>
        <Button title="Prev" icon="chevron-back" size="sm" variant="outline" disabled={idx === 0} onPress={() => onIndex(idx - 1)} />
        <Text style={[type.mono, { color: colors.text, flex: 1, textAlign: 'center' }]}>{idx + 1} / {total}</Text>
        <Button title="Next" iconRight="chevron-forward" size="sm" variant="outline" disabled={idx >= total - 1} onPress={() => onIndex(idx + 1)} />
      </View>
      <ScrollView style={[styles.slide, { borderColor: colors.border, backgroundColor: alpha(colors.text, 0.03) }]} contentContainerStyle={{ padding: SPACE.lg }}>
        <Markdown style={md}>{slides[idx] || ''}</Markdown>
      </ScrollView>
      <View style={styles.dots}>
        {slides.map((_, i) => (
          <Pressable key={i} onPress={() => onIndex(i)} hitSlop={10} accessibilityRole="button" accessibilityLabel={`Slide ${i + 1}`} style={styles.dotHit}>
            <View style={[styles.dot, { backgroundColor: i === idx ? colors.primary : alpha(colors.text, 0.2) }]} />
          </Pressable>
        ))}
      </View>
    </View>
  );
}

/** PDF mode — the print rendering of the active file; Export prints on web. */
function PdfPreview({ tab, onEditSource }) {
  const md = useMarkdownStyles();
  const { colors, type } = useUIKit();
  if (!tab) return <NeedFile title="Open a file" message="Select a markdown or HTML file to preview and export as PDF." />;
  const exportPdf = () => {
    if (Platform.OS !== 'web' || typeof window === 'undefined') return;
    const w = window.open('', '_blank');
    if (!w) return;
    const body = isHtmlFile(tab.name) ? tab.content : `<pre style="white-space:pre-wrap;font-family:Georgia,serif">${String(tab.content).replace(/</g, '&lt;')}</pre>`;
    w.document.write(body);
    w.document.close();
    setTimeout(() => w.print(), 300);
  };
  return (
    <View style={{ flex: 1 }}>
      <View style={[styles.pdfBar, { borderColor: colors.borderSubtle }]}>
        <Text style={[type.label, { color: colors.textMuted, flex: 1 }]} numberOfLines={1}>PDF preview · {tab.name}</Text>
        {Platform.OS === 'web' ? <Button title="Export PDF" size="sm" variant="outline" icon="download-outline" onPress={exportPdf} /> : null}
        <Button title="Edit source" size="sm" variant="ghost" onPress={onEditSource} />
      </View>
      <ScrollView contentContainerStyle={{ padding: SPACE.lg }}>
        {isMarkdownFile(tab.name) ? (
          <Markdown style={md}>{tab.content || ''}</Markdown>
        ) : (
          <Text style={{ fontFamily: MONO_FAMILY, fontSize: 12, color: colors.textSecondary }} selectable>{tab.content}</Text>
        )}
      </ScrollView>
    </View>
  );
}

export function WorkspacePreview({ ws, width, height, inspector, onSelectElement, onFixWithAgent, onEditSource }) {
  const { colors, type, alpha } = useUIKit();
  const http = useGatewayHttp();
  const tab = ws.activeTab;

  if (ws.projectMode === 'document') return <DocumentPreview tab={tab} />;
  if (ws.projectMode === 'presentation') return <SlideDeck tab={tab} index={ws.slideIndex} onIndex={ws.setSlideIndex} />;
  if (ws.projectMode === 'pdf') return <PdfPreview tab={tab} onEditSource={onEditSource} />;

  const target = previewTarget({ devUrl: ws.devUrl, server: ws.server, route: ws.previewRoute, workspace: ws.selected, activeTab: tab, nonce: ws.previewNonce });
  const status = runtimeStatusOf(ws.server, ws.runtimeLoading);

  if (!target) {
    if (ws.server?.status === 'error') {
      const detail = ws.server?.error || ws.runtimeLogs.slice(-1200) || 'No output was captured.';
      return (
        <ScrollView contentContainerStyle={styles.centerPad}>
          <View style={[styles.errCard, { borderColor: alpha(colors.error, 0.45), backgroundColor: alpha(colors.error, 0.07) }]} testID="workspace-preview-error">
            <Text style={[type.h3, { color: colors.error }]}>The preview server needs a hand</Text>
            <Text style={[type.small, { color: colors.textSecondary }]}>
              InfiniBot could not start this project. The latest output is included so the agent can repair it with context.
            </Text>
            <ScrollView horizontal style={[styles.logBox, { backgroundColor: alpha(colors.background, 0.6), borderColor: colors.borderSubtle }]}>
              <Text style={[styles.log, { color: colors.error }]} selectable>{detail.split('\n').slice(-14).join('\n')}</Text>
            </ScrollView>
            <View style={styles.rowWrap}>
              <Button title="Fix with agent" icon="sparkles-outline" size="sm" onPress={() => onFixWithAgent?.()} />
              <Button title="Retry start" icon="refresh" size="sm" variant="outline" loading={ws.runtimeLoading} onPress={() => ws.startServer(Boolean(ws.detection?.missingDependencies))} />
            </View>
          </View>
        </ScrollView>
      );
    }
    const missing = ws.detection?.missingDependencies;
    const busy = status === 'installing' || status === 'starting' || status === 'detecting';
    return (
      <View style={styles.centerPad}>
        <View style={[styles.loadCard, { borderColor: colors.border, backgroundColor: alpha(colors.text, 0.03) }]}>
          {busy ? <Skeleton width="100%" height={10} /> : <Ionicons name="desktop-outline" size={28} color={colors.primary} />}
          <Text style={[type.bodyStrong, { color: colors.text, textAlign: 'center' }]}>
            {ws.runtimeLoading ? 'Detecting the project…' : missing ? 'Dependencies need to be installed' : busy ? `Server ${status}…` : 'Live preview'}
          </Text>
          <Text style={[type.small, { color: colors.textMuted, textAlign: 'center' }]}>
            {ws.detection
              ? `${ws.detection.kind}${ws.detection.packageManager && ws.detection.packageManager !== 'none' ? ` · ${ws.detection.packageManager}` : ''}${ws.detection.devCmd ? ` · ${ws.detection.devCmd}` : ''}`
              : 'Open an HTML file to preview it, or start the dev server.'}
          </Text>
          {missing ? (
            <Button title="Install and start" icon="download-outline" onPress={() => ws.startServer(true)} loading={ws.runtimeLoading} />
          ) : !busy && ws.detection && ws.detection.kind !== 'unknown' ? (
            <Button title="Start dev server" icon="play" onPress={() => ws.startServer(false)} loading={ws.runtimeLoading} />
          ) : null}
        </View>
      </View>
    );
  }

  const deviceWidth = DEVICE_WIDTHS[ws.previewDevice] || width;
  const htmlSource = target.html && tab && isHtmlFile(tab.name) ? tab.content : null;
  const absolute = target.kind === 'gateway' ? `${http.origin}${target.url}` : target.url;
  if (htmlSource == null && !http.ready) return <View style={styles.centerPad}><Skeleton width="80%" height={14} /></View>;
  return (
    <View style={{ width, height }} testID="workspace-preview-frame">
      <FramedPage
        source={{ uri: absolute, headers: target.kind === 'gateway' ? http.headers : undefined }}
        html={htmlSource}
        inspector={inspector}
        onSelect={onSelectElement}
        width={width}
        height={height}
        deviceWidth={deviceWidth}
      />
    </View>
  );
}

/** Absolute preview URL for "Open in browser". */
export function usePreviewUrl(ws) {
  const http = useGatewayHttp();
  const target = previewTarget({ devUrl: ws.devUrl, server: ws.server, route: ws.previewRoute, workspace: ws.selected, activeTab: ws.activeTab, nonce: 0 });
  if (!target) return { url: null, origin: http.origin };
  return { url: target.kind === 'gateway' ? `${http.origin}${target.url}` : target.url, path: target.url, origin: http.origin };
}

export function openExternal(url) {
  if (!url) return;
  if (Platform.OS === 'web' && typeof window !== 'undefined') window.open(url, '_blank', 'noopener');
  else Linking.openURL(url).catch(() => {});
}

const styles = StyleSheet.create({
  centerPad: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', padding: SPACE.lg },
  errCard: { width: '100%', maxWidth: 560, borderWidth: 1, borderRadius: RADIUS.lg, padding: SPACE.lg, gap: SPACE.md },
  loadCard: { width: '100%', maxWidth: 420, borderWidth: 1, borderRadius: RADIUS.lg, padding: SPACE.xl, gap: SPACE.md, alignItems: 'center' },
  logBox: { borderWidth: 1, borderRadius: RADIUS.sm, maxHeight: 220 },
  log: { fontFamily: MONO_FAMILY, fontSize: 12, lineHeight: 17, padding: SPACE.md },
  rowWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.sm },
  slideBar: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm },
  slide: { flex: 1, borderWidth: 1, borderRadius: RADIUS.lg },
  dots: { flexDirection: 'row', justifyContent: 'center', flexWrap: 'wrap' },
  dotHit: { width: 28, height: 44, alignItems: 'center', justifyContent: 'center' },
  dot: { width: 8, height: 8, borderRadius: 4 },
  pdfBar: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, paddingHorizontal: SPACE.md, paddingVertical: SPACE.sm, borderBottomWidth: StyleSheet.hairlineWidth },
});
