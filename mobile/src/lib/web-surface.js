// web-surface.js — reusable authed WebView that embeds the real InfiniBot
// control-UI (served by the gateway over HTTP on the same host:port as the WS
// endpoint). This is the shared foundation for BOTH the full-screen parity
// surfaces (Agency Operations, Inbox, Products, Vault, …) and the individual
// panels inside the draggable Grid.
//
// How auth works (mirrors screenshot_infinibot_ui_headless + auth-hash.ts):
//   The served UI reads gateway creds from localStorage key
//   `infinibot.control.settings.v1` = {password, gatewayUrl, token}. Two gates
//   otherwise block it: (1) a Gateway Password screen, (2) a "Pick a profile"
//   picker. We seed the settings key AND disable the profile gate
//   (`infinibot.profiles.gateEnabled.v1` = "0") in
//   `injectedJavaScriptBeforeContentLoaded`, so the WebView boots straight into
//   the requested route. Routing is path-based, so the source URI is just
//   `http://host:port/<path>`.

import React, { useEffect, useMemo, useState } from 'react';
import { View, Text, ActivityIndicator, StyleSheet, Platform, Pressable, Linking } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { WebView } from 'react-native-webview';
import { getGatewayUrl, getAuthToken } from '../utils/storage';
import { getActiveProfile, getCloudToken } from '../connection/profile-store';
import { COLORS } from '../constants/theme';
import { buildBeforeContentJS, wsToHttp } from './web-auth-seed';

// ws(s):// → http(s):// lives in web-auth-seed.js (pure, tested).
export { wsToHttp };

// Strip a trailing slash so `${base}/${path}` never doubles up.
function trimTrailingSlash(s) {
  return s.replace(/\/+$/, '');
}

// The credential/profile-gate seed lives in web-auth-seed.js (pure, tested).
export { buildBeforeContentJS };

// Chromeless embed for Grid panels. The web shell gained a first-class embed
// mode (?embed=1 -> <html data-embed="1">, PR #93 / feat/ui-embed-mode) that
// collapses the `.shell` grid and hides the chrome. We set the SAME attribute
// here and ship a matching fallback stylesheet keyed to the REAL shell
// selectors (.shell/.topbar/.nav/.threads-sidebar/.content), so panels render
// content-only whether or not the gateway build already includes that CSS.
const EMBED_CSS = `(function(){try{
  document.documentElement.setAttribute('data-embed','1');
  var s=document.createElement('style');
  s.id='__infinibot_embed';
  s.textContent=[
    '[data-embed="1"]{--shell-topbar-height:0px!important}',
    '[data-embed="1"] .shell{grid-template-areas:"content"!important;grid-template-columns:1fr!important;grid-template-rows:1fr!important}',
    '[data-embed="1"] .topbar,[data-embed="1"] .nav,[data-embed="1"] .threads-sidebar,[data-embed="1"] .threads-sidebar-overlay{display:none!important}',
    '[data-embed="1"] .content{grid-area:content!important;margin:0!important;padding:0!important;inset:0!important}'
  ].join('');
  var add=function(){document.head&&document.head.appendChild(s);};
  if(document.head)add();else document.addEventListener('DOMContentLoaded',add);
}catch(e){}})(); true;`;

/**
 * The active gateway's HTTP origin + the credential to seed the control UI
 * with: { httpBase, wsUrl, token, authMode }, or null with no gateway URL.
 */
export async function resolveWebSurfaceConfig() {
  const wsUrl = await getGatewayUrl();
  // InfiniBot Cloud: the web UI authenticates with the Clerk session
  // token (it is what the cloud web client puts in settings.token).
  const profile = await getActiveProfile();
  const token = profile?.kind === 'cloud' ? await getCloudToken() : await getAuthToken();
  const httpBase = trimTrailingSlash(wsToHttp(wsUrl));
  if (!httpBase) return null;
  const authMode = profile?.kind === 'cloud' ? 'token' : profile?.authMode || null;
  return { httpBase, wsUrl, token, authMode };
}

/**
 * WebSurface — the authed WebView. Give it a `path` (e.g. '/agency-operations').
 * Optional `embed` renders it chromeless for use inside a Grid panel.
 */
export function WebSurface({ path, embed = false, style, onLoadEnd, webviewRef }) {
  const [cfg, setCfg] = useState(null); // { httpBase, wsUrl, token } | null
  const [err, setErr] = useState(null);
  // A failed page load (gateway down, refused credentials) — shown with a retry.
  const [loadErr, setLoadErr] = useState(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const c = await resolveWebSurfaceConfig();
        if (!c) {
          if (alive) setErr('No gateway URL set. Open Settings and enter your gateway address first.');
          return;
        }
        if (alive) setCfg(c);
      } catch (e) {
        if (alive) setErr(e?.message || 'Failed to resolve gateway URL');
      }
    })();
    return () => { alive = false; };
  }, []);

  const source = useMemo(() => {
    if (!cfg) return null;
    const clean = String(path || '/dashboard');
    const withSlash = clean.startsWith('/') ? clean : `/${clean}`;
    const q = embed ? (withSlash.includes('?') ? '&embed=1' : '?embed=1') : '';
    return { uri: `${cfg.httpBase}${withSlash}${q}` };
  }, [cfg, path, embed]);

  const beforeJS = useMemo(
    () => (cfg ? buildBeforeContentJS(cfg.wsUrl, cfg.token, cfg.authMode) : ''),
    [cfg],
  );

  if (err) {
    return (
      <View style={[styles.fill, style]}>
        <Text style={styles.errText}>{err}</Text>
      </View>
    );
  }
  if (!source) {
    return (
      <View style={[styles.fill, style]}>
        <ActivityIndicator color={COLORS.primary} />
      </View>
    );
  }

  // Expo web has no WebView (and a cross-origin page could not be seeded with
  // credentials anyway): say so and offer the page in a browser tab.
  if (Platform.OS === 'web') {
    return (
      <View style={[styles.fill, style]}>
        <Ionicons name="globe-outline" size={28} color={COLORS.primary} />
        <Text style={styles.noteTitle}>This page is part of the web app</Text>
        <Text style={styles.errText}>On a phone or tablet it opens here, signed in. In this browser preview, open it in a tab instead.</Text>
        <Pressable style={styles.retry} onPress={() => Linking.openURL(source.uri)} accessibilityRole="link">
          <Text style={styles.retryText}>Open {String(path || '').split('?')[0]}</Text>
        </Pressable>
      </View>
    );
  }

  if (loadErr) {
    return (
      <View style={[styles.fill, style]}>
        <Ionicons name="cloud-offline-outline" size={28} color={COLORS.textMuted} />
        <Text style={styles.noteTitle}>Couldn't load this page</Text>
        <Text style={styles.errText}>{loadErr}</Text>
        <Pressable style={styles.retry} onPress={() => { setLoadErr(null); setAttempt((n) => n + 1); }} accessibilityRole="button">
          <Text style={styles.retryText}>Try again</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <WebView
      key={attempt}
      ref={webviewRef}
      source={source}
      onError={(e) => setLoadErr(e?.nativeEvent?.description || 'The gateway did not respond.')}
      onHttpError={(e) => {
        const code = e?.nativeEvent?.statusCode;
        if (code === 401 || code === 403) setLoadErr('The gateway refused the saved credentials. Check More › Connections.');
        else if (code >= 500) setLoadErr(`The gateway answered with an error (${code}).`);
      }}
      originWhitelist={['*']}
      style={[styles.web, style]}
      injectedJavaScriptBeforeContentLoaded={beforeJS}
      injectedJavaScript={embed ? EMBED_CSS : undefined}
      domStorageEnabled
      javaScriptEnabled
      allowsInlineMediaPlayback
      mediaPlaybackRequiresUserAction={false}
      // Robovoice calls on the Voice page need the mic (LiveKit getUserMedia).
      mediaCapturePermissionGrantType="grant"
      startInLoadingState
      onLoadEnd={onLoadEnd}
      renderLoading={() => (
        <View style={styles.center}>
          <ActivityIndicator color={COLORS.primary} />
        </View>
      )}
    />
  );
}

const styles = StyleSheet.create({
  web: { flex: 1, backgroundColor: 'transparent' },
  // In-flow states (error / preview note): fill the slot without covering the
  // host screen's header.
  fill: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: COLORS.bg, paddingVertical: 24 },
  center: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.bg,
  },
  errText: { color: COLORS.textMuted, textAlign: 'center', paddingHorizontal: 28, fontSize: 13, lineHeight: 19, maxWidth: 360 },
  noteTitle: { color: COLORS.text, fontSize: 16, fontWeight: '700', marginTop: 10, marginBottom: 6 },
  retry: { marginTop: 14, minHeight: 44, paddingHorizontal: 18, borderRadius: 12, borderWidth: 1, borderColor: COLORS.primaryMuted, alignItems: 'center', justifyContent: 'center' },
  retryText: { color: COLORS.primary, fontSize: 14, fontWeight: '700' },
});
