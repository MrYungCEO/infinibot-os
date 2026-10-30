/**
 * KgEmbedView — the REAL web Knowledge Graph (the desktop control UI's
 * <infinibot-knowledge-graph>: three.js brain/galaxy, lobes, size by
 * connections, consolidate, AI actions, lasso, link mode…) running chromeless
 * in a WebView against the active gateway, signed in with the app's saved
 * credential (no login screen).
 *
 *   · iOS / Android: react-native-webview; bridge = ReactNativeWebView.postMessage
 *     ↔ injectJavaScript(window.__kgEmbed.*).
 *   · Web export (served by the same gateway at /mobile-web): a same-origin
 *     <iframe>; bridge = postMessage with exact origins.
 *
 * Props:
 *   initialParams   route params at mount ({ focus, project, family, layer, group })
 *   bottomInset     px the page keeps its floating panels above (the app's dock)
 *   onMessage(msg)  parsed bridge messages (see lib/kg-embed.js parseBridgeMessage)
 *   onError(text)   the page could not load (gateway down / credentials refused)
 * Ref: { send(cmd) } — a hostCommand() (focus / apply / fit / back); { reload() }.
 */
import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { Platform, StyleSheet, View } from 'react-native';

import { buildBeforeContentJS, resolveWebSurfaceConfig } from '../../lib/web-surface';
import { buildKgEmbedUrl, hostCommandMessage, hostCommandScript, originOf, parseBridgeMessage } from '../../lib/kg-embed';

let WebView = null;
if (Platform.OS !== 'web') {
  // eslint-disable-next-line global-require
  WebView = require('react-native-webview').WebView;
}

const BG = '#07060c';
const SETTINGS_KEY = 'infinibot.control.settings.v1';

/** Sets the dock inset on the page (works before and after its scripts run). */
function bottomInsetJS(px) {
  const v = `${Math.max(0, Math.round(Number(px) || 0))}px`;
  return `(function(){try{document.documentElement.style.setProperty('--kg-host-bottom',${JSON.stringify(v)});}catch(e){}})();true;`;
}

export const KgEmbedView = forwardRef(function KgEmbedView({ initialParams, bottomInset = 0, onMessage, onError, style }, ref) {
  const [cfg, setCfg] = useState(null);
  const [attempt, setAttempt] = useState(0);
  const webRef = useRef(null);
  const frameRef = useRef(null);
  // The URL is fixed at mount (later params move the graph over the bridge).
  const paramsAtMount = useRef(initialParams);
  const onMessageRef = useRef(onMessage);
  onMessageRef.current = onMessage;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  useEffect(() => {
    let alive = true;
    resolveWebSurfaceConfig()
      .then((c) => {
        if (!alive) return;
        if (!c) onErrorRef.current?.('No gateway URL set. Open More › Connections and add your gateway first.');
        else setCfg(c);
      })
      .catch((e) => alive && onErrorRef.current?.(e?.message || 'Could not read the gateway connection.'));
    return () => { alive = false; };
  }, []);

  const uri = useMemo(() => (cfg ? buildKgEmbedUrl(cfg.httpBase, paramsAtMount.current) : null), [cfg]);

  useEffect(() => {
    if (cfg && !uri) onErrorRef.current?.('The gateway address is not an http(s)/ws(s) URL.');
  }, [cfg, uri]);

  const deliver = useCallback((raw) => {
    const msg = parseBridgeMessage(raw);
    if (msg) onMessageRef.current?.(msg);
  }, []);

  // ── Web export: same-origin iframe ────────────────────────────────────────
  const frameOrigin = uri ? originOf(uri) : null;
  useEffect(() => {
    if (Platform.OS !== 'web' || !frameOrigin) return undefined;
    const on = (e) => {
      if (e.origin !== frameOrigin || e.source !== frameRef.current?.contentWindow) return;
      deliver(e.data);
    };
    window.addEventListener('message', on);
    return () => window.removeEventListener('message', on);
  }, [frameOrigin, deliver]);

  useEffect(() => {
    // Same origin as the gateway: hand the control UI the app's credential
    // when this browser has none yet (never overwrite a desktop session's).
    if (Platform.OS !== 'web' || !cfg || !frameOrigin) return;
    try {
      if (window.location.origin.toLowerCase() !== frameOrigin) return;
      if (!window.localStorage.getItem(SETTINGS_KEY)) {
        const pw = cfg.authMode === 'token' ? '' : cfg.token || '';
        const tok = cfg.authMode === 'password' ? '' : cfg.token || '';
        window.localStorage.setItem(SETTINGS_KEY, JSON.stringify({ password: pw, gatewayUrl: cfg.wsUrl || '', token: tok }));
      }
    } catch { /* storage blocked */ }
  }, [cfg, frameOrigin]);

  const applyFrameInset = useCallback(() => {
    try {
      frameRef.current?.contentWindow?.document?.documentElement?.style?.setProperty('--kg-host-bottom', `${Math.round(bottomInset)}px`);
    } catch { /* cross-origin frame */ }
  }, [bottomInset]);

  // ── Native: keep the dock inset current (rotation changes it) ─────────────
  useEffect(() => {
    if (Platform.OS === 'web') applyFrameInset();
    else webRef.current?.injectJavaScript(bottomInsetJS(bottomInset));
  }, [bottomInset, applyFrameInset]);

  useImperativeHandle(ref, () => ({
    send(cmd) {
      if (!cmd) return false;
      if (Platform.OS === 'web') {
        const w = frameRef.current?.contentWindow;
        const m = hostCommandMessage(cmd);
        if (!w || !m || !frameOrigin) return false;
        w.postMessage(m, frameOrigin);
        return true;
      }
      if (!webRef.current) return false;
      webRef.current.injectJavaScript(hostCommandScript(cmd));
      return true;
    },
    reload() {
      setAttempt((n) => n + 1);
    },
  }), [frameOrigin]);

  const beforeJS = useMemo(
    () => (cfg ? `${buildBeforeContentJS(cfg.wsUrl, cfg.token, cfg.authMode)}\n${bottomInsetJS(bottomInset)}` : ''),
    // The inset at load; later changes go through injectJavaScript.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [cfg],
  );

  if (!uri) return <View style={[styles.fill, style]} />;

  if (Platform.OS === 'web') {
    return (
      <View style={[styles.fill, style]}>
        {React.createElement('iframe', {
          key: attempt,
          ref: frameRef,
          src: uri,
          title: 'Knowledge Graph',
          onLoad: applyFrameInset,
          allow: 'clipboard-write',
          style: { border: 0, width: '100%', height: '100%', display: 'block', background: BG },
          'data-testid': 'kg-embed-frame',
        })}
      </View>
    );
  }

  return (
    <WebView
      key={attempt}
      ref={webRef}
      source={{ uri }}
      style={[styles.fill, style]}
      containerStyle={styles.fill}
      originWhitelist={['*']}
      injectedJavaScriptBeforeContentLoaded={beforeJS}
      onMessage={(e) => deliver(e?.nativeEvent?.data)}
      onError={(e) => onErrorRef.current?.(e?.nativeEvent?.description || 'The gateway did not respond.')}
      onHttpError={(e) => {
        const code = e?.nativeEvent?.statusCode;
        if (code === 401 || code === 403) onErrorRef.current?.('The gateway refused the saved credentials. Check More › Connections.');
        else if (code >= 500) onErrorRef.current?.(`The gateway answered with an error (${code}).`);
      }}
      onContentProcessDidTerminate={() => setAttempt((n) => n + 1)}
      onRenderProcessGone={() => setAttempt((n) => n + 1)}
      javaScriptEnabled
      domStorageEnabled
      // The page owns every gesture (orbit, pinch, long-press menu).
      scrollEnabled={false}
      bounces={false}
      overScrollMode="never"
      setBuiltInZoomControls={false}
      setDisplayZoomControls={false}
      allowsBackForwardNavigationGestures={false}
      allowsLinkPreview={false}
      textInteractionEnabled
      contentInsetAdjustmentBehavior="never"
      automaticallyAdjustContentInsets={false}
      keyboardDisplayRequiresUserAction={false}
      hideKeyboardAccessoryView
      allowsInlineMediaPlayback
      webviewDebuggingEnabled={__DEV__}
      testID="kg-embed-webview"
    />
  );
});

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: BG },
});

export default KgEmbedView;
