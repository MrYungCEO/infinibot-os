/**
 * ConnectionBanner — the app-wide "am I connected?" answer.
 *
 * Hidden while connected (after a brief "Connected" confirmation when a
 * connection is (re)established). Shows when the socket has failed, or has
 * been trying for a few seconds, with the reason (useGateway().lastError) and
 * two ways out: Retry, or Change connection (opens the chooser with the
 * manual address + password form).
 *
 * When the gateway REJECTED the credential (authFailure from useGateway —
 * wrong password/token, pairing required) auto-reconnect is halted and the
 * banner says exactly that ("Wrong gateway password for <host>") with
 * Edit connection / Retry, plus "Use this build's credentials" when the build
 * carries a secret for the same host (credentialOffer).
 */
import React, { useEffect, useRef, useState } from 'react';
import { View, Text, Pressable, StyleSheet, ActivityIndicator } from 'react-native';
import { describeAuthFailure } from '../connection/connection-logic';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

const GOLD = '#f1d38a';
const SLOW_MS = 6000;
const OK_MS = 2600;

export function ConnectionBanner({
  status, lastError, onRetry, onChange, authFailure, credentialOffer, onUseBuildCredentials, onEdit,
}) {
  const insets = useSafeAreaInsets();
  const [slow, setSlow] = useState(false);
  const [justConnected, setJustConnected] = useState(false);
  const prev = useRef(status);

  useEffect(() => {
    let t;
    if (status === 'connecting' || status === 'disconnected') {
      t = setTimeout(() => setSlow(true), SLOW_MS);
    } else {
      setSlow(false);
    }
    if (status === 'connected' && prev.current !== 'connected') {
      setJustConnected(true);
      const ok = setTimeout(() => setJustConnected(false), OK_MS);
      prev.current = status;
      return () => {
        clearTimeout(ok);
        if (t) clearTimeout(t);
      };
    }
    prev.current = status;
    return () => t && clearTimeout(t);
  }, [status]);

  const failed = status === 'error' || ((status === 'connecting' || status === 'disconnected') && slow);
  if (authFailure && status !== 'connected' && status !== 'connecting') {
    return (
      <AuthFailureCard
        top={insets.top + 6}
        failure={authFailure}
        credentialOffer={credentialOffer}
        onUseBuildCredentials={onUseBuildCredentials}
        onEdit={onEdit || onChange}
        onRetry={onRetry}
      />
    );
  }
  if (!failed && !justConnected) return null;

  if (!failed) {
    return (
      <View pointerEvents="none" style={[styles.wrap, { top: insets.top + 6 }]} testID="connection-ok">
        <View style={[styles.pill, styles.okPill]}>
          <View style={[styles.dot, { backgroundColor: '#3fb27f' }]} />
          <Text style={styles.okText}>Connected to your gateway</Text>
        </View>
      </View>
    );
  }

  return (
    <View style={[styles.wrap, { top: insets.top + 6 }]} testID="connection-banner" accessibilityRole="alert">
      <View style={styles.card}>
        <View style={styles.row}>
          <View style={[styles.dot, { backgroundColor: status === 'error' ? '#e5675c' : '#f5a524' }]} />
          <Text style={styles.title}>{status === 'error' ? 'Not connected' : 'Still connecting…'}</Text>
        </View>
        <Text style={styles.detail} numberOfLines={3}>
          {lastError || 'The gateway isn’t answering. Check that it’s running and this device can reach it (same Wi-Fi or Tailscale).'}
        </Text>
        <View style={styles.actions}>
          <Pressable onPress={onRetry} style={styles.btn} accessibilityRole="button" accessibilityLabel="Retry connecting" testID="connection-retry">
            <Text style={styles.btnText}>Retry</Text>
          </Pressable>
          <Pressable onPress={onChange} style={[styles.btn, styles.btnGhost]} accessibilityRole="button" accessibilityLabel="Change connection" testID="connection-change">
            <Text style={styles.btnGhostText}>Change connection</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

function AuthFailureCard({ top, failure, credentialOffer, onUseBuildCredentials, onEdit, onRetry }) {
  const [busy, setBusy] = useState(false);
  const [offerError, setOfferError] = useState(null);
  const pairing = failure.kind === 'pairing';
  const mode = failure.authMode === 'token' ? 'token' : 'password';
  const title = describeAuthFailure(failure, { gatewayUrl: failure.host });
  const detail = pairing
    ? 'Approve this device on your computer (InfiniBot › Nodes / pairing requests), then tap Retry.'
    : `The gateway uses a ${mode}. The one saved on this phone was rejected, so it stopped retrying. Fix it under Edit connection.`;
  const useOffer = async () => {
    setBusy(true);
    setOfferError(null);
    const res = await onUseBuildCredentials?.();
    setBusy(false);
    if (res && !res.ok) setOfferError(res.error || 'Those credentials were rejected too.');
  };
  return (
    <View style={[styles.wrap, { top }]} testID="connection-auth-failure" accessibilityRole="alert">
      <View style={[styles.card, styles.authCard]}>
        <View style={styles.row}>
          <View style={[styles.dot, { backgroundColor: '#e5675c' }]} />
          <Text style={styles.title} testID="connection-auth-title">{title}</Text>
        </View>
        <Text style={styles.detail}>{detail}</Text>
        {failure.message ? <Text style={styles.why} numberOfLines={2}>Gateway said: {failure.message}</Text> : null}
        {credentialOffer ? (
          <Pressable onPress={useOffer} disabled={busy} style={[styles.btn, styles.btnWide]} accessibilityRole="button"
            accessibilityLabel="Use this build's credentials" testID="connection-use-build-creds">
            {busy ? <ActivityIndicator color="#1a1408" /> : <Text style={styles.btnText}>Use this build's credentials</Text>}
          </Pressable>
        ) : null}
        {offerError ? <Text style={styles.why}>{offerError}</Text> : null}
        <View style={styles.actions}>
          <Pressable onPress={onEdit} style={[styles.btn, credentialOffer && styles.btnGhost]} accessibilityRole="button"
            accessibilityLabel="Edit connection" testID="connection-edit">
            <Text style={credentialOffer ? styles.btnGhostText : styles.btnText}>Edit connection</Text>
          </Pressable>
          <Pressable onPress={onRetry} style={[styles.btn, styles.btnGhost]} accessibilityRole="button"
            accessibilityLabel="Retry connecting" testID="connection-retry">
            <Text style={styles.btnGhostText}>Retry</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', left: 12, right: 12, alignItems: 'center', zIndex: 50 },
  pill: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999 },
  okPill: { backgroundColor: 'rgba(12,20,15,0.92)', borderWidth: 1, borderColor: 'rgba(63,178,127,0.5)' },
  okText: { color: '#bfe8d3', fontSize: 13, fontWeight: '600' },
  card: {
    width: '100%',
    maxWidth: 520,
    padding: 14,
    borderRadius: 16,
    backgroundColor: 'rgba(16,13,8,0.96)',
    borderWidth: 1,
    borderColor: 'rgba(229,103,92,0.45)',
    gap: 8,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  title: { color: '#f4f1ea', fontSize: 15, fontWeight: '700' },
  detail: { color: '#c9c3b6', fontSize: 13, lineHeight: 18 },
  actions: { flexDirection: 'row', gap: 8, marginTop: 2 },
  btn: { minHeight: 44, paddingHorizontal: 16, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: GOLD },
  btnText: { color: '#1a1408', fontWeight: '700', fontSize: 14 },
  btnGhost: { backgroundColor: 'transparent', borderWidth: 1, borderColor: 'rgba(241,211,138,0.45)' },
  btnGhostText: { color: GOLD, fontWeight: '600', fontSize: 14 },
  btnWide: { alignSelf: 'stretch', marginTop: 2 },
  authCard: { borderColor: 'rgba(229,103,92,0.7)', backgroundColor: '#100d08' },
  why: { color: 'rgba(201,195,182,0.7)', fontSize: 11.5, lineHeight: 16 },
});
