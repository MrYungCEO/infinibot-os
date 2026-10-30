/**
 * ConnectionChooserScreen — first run (and "add connection"): pick
 * InfiniBot Cloud (Clerk sign-in → tenant gateway via /fleet/resolve) or a
 * self-hosted gateway (address + password/token, or scan the pairing QR from
 * the web UI's Setup › Mobile page). A self-hosted profile is only saved after
 * a real `connect` handshake succeeds, so a wrong port/secret is caught here
 * instead of as a silently dead app.
 *
 * Props: onConnected(), onCancel?() (shown when other profiles exist),
 *        initialPairing? ({ url, token, password }) from an infinibot://connect link.
 *        initialSuggestion? ({ gatewayUrl, secret, authMode, source, error }) — the web
 *          export's guess (page origin when the gateway serves it, else
 *          EXPO_PUBLIC_GATEWAY_URL); prefills the self-hosted form.
 *        editProfile? — an existing self-hosted profile to edit in place (same id):
 *          prefilled, "Save & connect", and a two-tap Delete.
 *        authFailure? — the failure that sent the user here ({ authMode }) so the
 *          form can say which credential the gateway expects.
 *        onDeleted?() — after editProfile was deleted.
 */
import React, { useEffect, useMemo, useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet, ScrollView, ActivityIndicator,
  KeyboardAvoidingView, Platform, Image, Modal,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { COLORS } from '../constants/theme';
import {
  GATEWAY_DEFAULT_PORT, normalizeGatewayUrl, makeSelfHostedProfile, buildConnectAuth, parsePairingPayload, isTailscaleHost,
} from '../connection/connection-logic';
import { saveAndActivateProfile, removeProfile } from '../connection/profile-store';
import { probeGateway } from '../connection/probe';
import { loginWorkspaceUser } from '../connection/access-login';
import { getCloudConfig } from '../connection/cloud-config';
import { CloudSignIn } from '../connection/CloudAuth';

const GOLD = '#D4AF37';

export function ConnectionChooserScreen({
  onConnected, onCancel, onDeleted, initialPairing, initialSuggestion, editProfile, authFailure,
}) {
  const cloud = getCloudConfig();
  const editing = editProfile && editProfile.kind === 'self-hosted' ? editProfile : null;
  const suggested = editing
    ? { gatewayUrl: editing.gatewayUrl, secret: editing.secret, authMode: authFailure?.authMode || editing.authMode }
    : initialSuggestion?.gatewayUrl ? initialSuggestion : null;
  const [mode, setMode] = useState(initialPairing || suggested ? 'self' : 'choose'); // choose | cloud | self
  const [address, setAddress] = useState(suggested?.gatewayUrl || '');
  const [authMode, setAuthMode] = useState(suggested?.authMode || 'password');
  // In 'user' mode the field holds the user's PASSWORD (exchanged for a session
  // token on connect); an edited user profile starts empty.
  const [secret, setSecret] = useState(suggested?.authMode === 'user' ? '' : suggested?.secret || '');
  const [username, setUsername] = useState(editing?.username || '');
  const [code, setCode] = useState('');
  const [needsCode, setNeedsCode] = useState(false);
  const [label, setLabel] = useState(editing ? editing.label : suggested?.source === 'origin' ? 'This gateway' : '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(suggested?.error || null);
  const [showSecret, setShowSecret] = useState(false);
  // What the gateway said it expects (from the failed connect / test).
  const [expectedMode, setExpectedMode] = useState(authFailure?.authMode || null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [perm, requestPerm] = useCameraPermissions();

  useEffect(() => {
    if (!initialPairing) return;
    const p = parsePairingPayload(
      `infinibot://connect?${Object.entries(initialPairing).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')}`,
    );
    if (p) applyPairing(p);
  }, [initialPairing]);

  const normalized = useMemo(() => normalizeGatewayUrl(address), [address]);

  function applyPairing(p) {
    setAddress(p.gatewayUrl);
    if (p.secret) {
      setSecret(p.secret);
      setAuthMode(p.authMode);
    }
    setMode('self');
    setError(null);
  }

  const onScanned = ({ data }) => {
    if (!scanning) return;
    setScanning(false);
    const p = parsePairingPayload(data);
    if (p) applyPairing(p);
    else setError('That QR code is not an InfiniBot pairing code.');
  };

  const startScan = async () => {
    if (!perm?.granted) {
      const r = await requestPerm();
      if (!r.granted) {
        setError('Camera permission is needed to scan the pairing QR.');
        return;
      }
    }
    setScanning(true);
  };

  const connectSelfHosted = async () => {
    setError(null);
    let profile;
    let credential = secret;
    if (authMode === 'user') {
      if (!normalizeGatewayUrl(address)) {
        setError(`Enter your gateway address, e.g. 192.168.1.20 or ws://my-pc:${GATEWAY_DEFAULT_PORT}`);
        return;
      }
      setBusy(true);
      const login = await loginWorkspaceUser({ gatewayUrl: address, username, password: secret, code: needsCode ? code : undefined });
      setBusy(false);
      if (!login.ok) {
        setError(login.error);
        if (login.needsCode) setNeedsCode(true);
        return;
      }
      credential = login.token;
    }
    try {
      profile = makeSelfHostedProfile({ gatewayUrl: address, secret: credential, authMode, label, username });
    } catch (e) {
      setError(e.message);
      return;
    }
    if (editing) profile = { ...profile, id: editing.id };
    setBusy(true);
    const res = await probeGateway(profile.gatewayUrl, buildConnectAuth(profile));
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      if (res.failure?.authMode) {
        setExpectedMode(res.failure.authMode);
        if (res.failure.authMode !== authMode) setAuthMode(res.failure.authMode);
      }
      return;
    }
    await saveAndActivateProfile(profile);
    onConnected?.();
  };

  const deleteEdited = async () => {
    if (!editing) return;
    if (!confirmDelete) { setConfirmDelete(true); return; }
    await removeProfile(editing.id);
    onDeleted?.();
  };

  return (
    <View style={s.root}>
      <LinearGradient colors={['#070707', '#101010', '#070707']} style={StyleSheet.absoluteFill} />
      <View style={s.glow} />
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
        <SafeAreaView style={{ flex: 1 }}>
          <ScrollView contentContainerStyle={s.scroll} keyboardShouldPersistTaps="handled">
            <View style={s.brand}>
              <Image source={require('../../assets/infinibot-logo.png')} style={s.logo} resizeMode="contain" />
              <Text style={s.title}>Connect InfiniBot</Text>
              <Text style={s.subtitle}>
                {mode === 'choose' ? 'Where does your InfiniBot run?' : mode === 'cloud' ? 'Sign in to InfiniBot Cloud' : editing ? `Edit “${editing.label}”` : 'Your own gateway'}
              </Text>
            </View>

            {mode === 'choose' && (
              <View style={{ gap: 12 }}>
                <Choice
                  icon="cloud-outline"
                  title="InfiniBot Cloud"
                  desc={cloud.enabled ? 'Sign in with your InfiniBot account. We find and wake your workspace for you.' : 'Not available in this build (no cloud configuration).'}
                  disabled={!cloud.enabled}
                  onPress={() => setMode('cloud')}
                  testID="choose-cloud"
                />
                <Choice
                  icon="server-outline"
                  title="Self-hosted gateway"
                  desc={`Your own PC or server — on the same Wi-Fi or over Tailscale. Port ${GATEWAY_DEFAULT_PORT}.`}
                  onPress={() => setMode('self')}
                  testID="choose-self"
                />
                {onCancel ? (
                  <TouchableOpacity onPress={onCancel} style={s.linkBtn}><Text style={s.linkText}>Cancel</Text></TouchableOpacity>
                ) : null}
              </View>
            )}

            {mode === 'cloud' && cloud.enabled && (
              <View style={s.card}>
                <CloudSignIn onConnected={onConnected} onBack={() => setMode('choose')} />
              </View>
            )}

            {mode === 'self' && (
              <View style={s.card}>
                <TouchableOpacity style={s.scanBtn} onPress={startScan}>
                  <Ionicons name="qr-code-outline" size={18} color={GOLD} />
                  <Text style={s.scanText}>Scan pairing QR</Text>
                </TouchableOpacity>
                {editing && authFailure ? (
                  <View style={s.authNote} testID="gw-auth-note">
                    <Ionicons name="alert-circle" size={16} color="#f87171" />
                    <Text style={s.authNoteText}>
                      The gateway rejected the saved {authFailure.authMode || editing.authMode || 'password'}. Re-enter it below (tap the eye to check what's saved).
                    </Text>
                  </View>
                ) : null}
                {editing ? null : suggested?.source === 'origin' ? (
                  <Text style={s.hint} testID="gw-origin-hint">
                    This page is served by your gateway, so it connects to {suggested.gatewayUrl}. Enter the gateway's password (the one you use for the web
                    control UI) — it's saved on this device.
                  </Text>
                ) : (
                  <Text style={s.hint}>On your computer open InfiniBot › Setup › Mobile and scan the pairing code, or enter the details below.</Text>
                )}

                <Text style={s.label}>Gateway address</Text>
                <TextInput
                  style={s.input} value={address} onChangeText={(v) => { setAddress(v); setError(null); }}
                  placeholder={`192.168.1.20  or  my-pc.tailnet.ts.net`} placeholderTextColor="rgba(255,255,255,0.3)"
                  autoCapitalize="none" autoCorrect={false} keyboardType="url" testID="gw-address"
                />
                {normalized ? (
                  <Text style={s.resolved}>
                    Connects to {normalized}{isTailscaleHost(normalized) ? '  (Tailscale)' : ''}
                  </Text>
                ) : null}

                <Text style={s.label}>Credential</Text>
                <View style={s.segment}>
                  {['password', 'token', 'user'].map((m) => (
                    <TouchableOpacity key={m} style={[s.segItem, authMode === m && s.segOn]} onPress={() => { setAuthMode(m); setError(null); }} testID={`gw-mode-${m}`}>
                      <Text style={[s.segText, authMode === m && s.segTextOn]}>{m === 'password' ? 'Password' : m === 'token' ? 'Token' : 'User account'}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
                {expectedMode ? (
                  <Text style={s.modeHint} testID="gw-mode-hint">
                    This gateway expects a {expectedMode === 'token' ? 'token' : 'password'}
                    {expectedMode !== authMode ? ` — switch to ${expectedMode === 'token' ? 'Token' : 'Password'}` : ''}.
                  </Text>
                ) : null}
                {authMode === 'user' ? (
                  <TextInput
                    style={s.input} value={username} onChangeText={(v) => { setUsername(v); setError(null); }}
                    autoCapitalize="none" autoCorrect={false} textContentType="username"
                    placeholder="Username or email" placeholderTextColor="rgba(255,255,255,0.3)" testID="gw-username"
                  />
                ) : null}
                <View style={s.secretRow}>
                  <TextInput
                    style={[s.input, s.secretInput]} value={secret} onChangeText={(v) => { setSecret(v); setError(null); }}
                    secureTextEntry={!showSecret} autoCapitalize="none" autoCorrect={false}
                    placeholder={authMode === 'password' ? 'Gateway password' : authMode === 'user' ? 'Your password' : 'Gateway token'} placeholderTextColor="rgba(255,255,255,0.3)"
                    onSubmitEditing={connectSelfHosted} testID="gw-secret"
                  />
                  <TouchableOpacity onPress={() => setShowSecret((v) => !v)} style={s.eye} hitSlop={8}
                    accessibilityRole="button" accessibilityLabel={showSecret ? 'Hide password' : 'Show password'} testID="gw-secret-toggle">
                    <Ionicons name={showSecret ? 'eye-off-outline' : 'eye-outline'} size={20} color={GOLD} />
                  </TouchableOpacity>
                </View>
                {authMode === 'user' && needsCode ? (
                  <TextInput
                    style={s.input} value={code} onChangeText={(v) => setCode(v.replace(/\D/g, '').slice(0, 6))}
                    keyboardType="number-pad" textContentType="oneTimeCode" maxLength={6}
                    placeholder="6-digit code" placeholderTextColor="rgba(255,255,255,0.3)" testID="gw-totp"
                  />
                ) : null}
                {authMode === 'user' ? (
                  <Text style={s.modeHint}>Sign in with the account your admin invited you to. You'll see only the workspaces they share with you.</Text>
                ) : null}
                <Text style={s.label}>Name (optional)</Text>
                <TextInput
                  style={s.input} value={label} onChangeText={setLabel} placeholder="Home PC"
                  placeholderTextColor="rgba(255,255,255,0.3)"
                />

                <TouchableOpacity style={s.primary} onPress={connectSelfHosted} disabled={busy || !address} testID="gw-connect">
                  {busy ? <ActivityIndicator color="#000" /> : <Text style={s.primaryText}>{editing ? 'Save & connect' : 'Test & connect'}</Text>}
                </TouchableOpacity>
                {error ? <Text style={s.error} testID="gw-error">{error}</Text> : null}
                {editing ? (
                  <View style={s.editActions}>
                    <TouchableOpacity onPress={deleteEdited} style={[s.deleteBtn, confirmDelete && s.deleteBtnOn]} testID="gw-delete"
                      accessibilityRole="button" accessibilityLabel={confirmDelete ? 'Confirm delete connection' : 'Delete connection'}>
                      <Ionicons name="trash-outline" size={16} color="#f87171" />
                      <Text style={s.deleteText}>{confirmDelete ? 'Tap again to delete' : 'Delete connection'}</Text>
                    </TouchableOpacity>
                    {onCancel ? (
                      <TouchableOpacity onPress={onCancel} style={s.linkBtn}><Text style={s.linkText}>Cancel</Text></TouchableOpacity>
                    ) : null}
                  </View>
                ) : (
                  <TouchableOpacity onPress={() => { setMode('choose'); setError(null); }} style={s.linkBtn}>
                    <Text style={s.linkText}>Back</Text>
                  </TouchableOpacity>
                )}
              </View>
            )}
          </ScrollView>
        </SafeAreaView>
      </KeyboardAvoidingView>

      <Modal visible={scanning} animationType="slide" onRequestClose={() => setScanning(false)}>
        <View style={{ flex: 1, backgroundColor: '#000' }}>
          <CameraView style={{ flex: 1 }} facing="back" barcodeScannerSettings={{ barcodeTypes: ['qr'] }} onBarcodeScanned={onScanned} />
          <SafeAreaView style={s.scanOverlay}>
            <Text style={s.scanTitle}>Point at the pairing QR on Setup › Mobile</Text>
            <TouchableOpacity onPress={() => setScanning(false)} style={s.scanClose}>
              <Text style={s.primaryText}>Close</Text>
            </TouchableOpacity>
          </SafeAreaView>
        </View>
      </Modal>
    </View>
  );
}

function Choice({ icon, title, desc, onPress, disabled, testID }) {
  return (
    <TouchableOpacity onPress={onPress} disabled={disabled} activeOpacity={0.8} testID={testID}
      style={[s.choice, disabled && { opacity: 0.45 }]}>
      <View style={s.choiceIcon}><Ionicons name={icon} size={24} color={GOLD} /></View>
      <View style={{ flex: 1 }}>
        <Text style={s.choiceTitle}>{title}</Text>
        <Text style={s.choiceDesc}>{desc}</Text>
      </View>
      <Ionicons name="chevron-forward" size={18} color="rgba(212,175,55,0.7)" />
    </TouchableOpacity>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#070707' },
  glow: { position: 'absolute', top: -120, alignSelf: 'center', width: 320, height: 320, borderRadius: 160, backgroundColor: 'rgba(212,175,55,0.08)' },
  scroll: { padding: 22, paddingTop: 36, paddingBottom: 48 },
  brand: { alignItems: 'center', marginBottom: 26 },
  logo: { width: 64, height: 64, marginBottom: 12 },
  title: { color: '#fff', fontSize: 26, fontWeight: '800', letterSpacing: -0.4 },
  subtitle: { color: 'rgba(255,255,255,0.55)', fontSize: 14, marginTop: 6 },
  choice: {
    flexDirection: 'row', alignItems: 'center', gap: 14, padding: 18, borderRadius: 16,
    backgroundColor: 'rgba(18,18,22,0.9)', borderWidth: 1, borderColor: 'rgba(212,175,55,0.22)',
  },
  choiceIcon: { width: 46, height: 46, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(212,175,55,0.1)' },
  choiceTitle: { color: '#fff', fontSize: 16, fontWeight: '700', marginBottom: 3 },
  choiceDesc: { color: 'rgba(255,255,255,0.5)', fontSize: 12.5, lineHeight: 17 },
  card: { padding: 18, borderRadius: 16, backgroundColor: 'rgba(18,18,22,0.92)', borderWidth: 1, borderColor: 'rgba(212,175,55,0.18)' },
  scanBtn: {
    flexDirection: 'row', gap: 8, alignItems: 'center', justifyContent: 'center', paddingVertical: 12,
    borderRadius: 12, borderWidth: 1, borderColor: 'rgba(212,175,55,0.4)', backgroundColor: 'rgba(212,175,55,0.06)',
  },
  scanText: { color: GOLD, fontWeight: '700', fontSize: 14 },
  hint: { color: 'rgba(255,255,255,0.45)', fontSize: 12, lineHeight: 17, marginTop: 10 },
  label: { color: 'rgba(255,255,255,0.55)', fontSize: 11, fontWeight: '700', letterSpacing: 1, textTransform: 'uppercase', marginTop: 16, marginBottom: 6 },
  input: {
    color: '#fff', fontSize: 15, paddingHorizontal: 14, paddingVertical: 12, borderRadius: 12,
    borderWidth: 1, borderColor: 'rgba(212,175,55,0.25)', backgroundColor: 'rgba(255,255,255,0.04)',
  },
  resolved: { color: 'rgba(212,175,55,0.85)', fontSize: 12, marginTop: 6, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },
  authNote: {
    flexDirection: 'row', gap: 8, alignItems: 'flex-start', marginTop: 12, padding: 10, borderRadius: 10,
    backgroundColor: 'rgba(248,113,113,0.08)', borderWidth: 1, borderColor: 'rgba(248,113,113,0.35)',
  },
  authNoteText: { flex: 1, color: '#fecaca', fontSize: 12.5, lineHeight: 17 },
  modeHint: { color: 'rgba(212,175,55,0.9)', fontSize: 12, marginBottom: 8 },
  secretRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  secretInput: { flex: 1 },
  eye: {
    width: 46, height: 46, borderRadius: 12, alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: 'rgba(212,175,55,0.25)', backgroundColor: 'rgba(255,255,255,0.04)',
  },
  editActions: { marginTop: 16, alignItems: 'center', gap: 4 },
  deleteBtn: {
    flexDirection: 'row', gap: 6, alignItems: 'center', paddingVertical: 10, paddingHorizontal: 16, borderRadius: 10,
    borderWidth: 1, borderColor: 'rgba(248,113,113,0.35)',
  },
  deleteBtnOn: { backgroundColor: 'rgba(248,113,113,0.14)', borderColor: '#f87171' },
  deleteText: { color: '#f87171', fontWeight: '700', fontSize: 13 },
  segment: { flexDirection: 'row', borderRadius: 10, borderWidth: 1, borderColor: 'rgba(212,175,55,0.25)', overflow: 'hidden', marginBottom: 8 },
  segItem: { flex: 1, paddingVertical: 9, alignItems: 'center' },
  segOn: { backgroundColor: 'rgba(212,175,55,0.18)' },
  segText: { color: 'rgba(255,255,255,0.55)', fontWeight: '600', fontSize: 13 },
  segTextOn: { color: GOLD },
  primary: { marginTop: 20, backgroundColor: GOLD, borderRadius: 12, paddingVertical: 14, alignItems: 'center' },
  primaryText: { color: '#000', fontWeight: '800', fontSize: 15 },
  error: { color: '#f87171', marginTop: 12, fontSize: 13, lineHeight: 18 },
  linkBtn: { alignSelf: 'center', marginTop: 14, padding: 6 },
  linkText: { color: 'rgba(255,255,255,0.5)', fontSize: 13 },
  scanOverlay: { position: 'absolute', left: 0, right: 0, bottom: 0, padding: 20, alignItems: 'center', gap: 12 },
  scanTitle: { color: '#fff', fontSize: 14, fontWeight: '600', textAlign: 'center', backgroundColor: 'rgba(0,0,0,0.6)', padding: 10, borderRadius: 10 },
  scanClose: { backgroundColor: GOLD, paddingVertical: 12, paddingHorizontal: 28, borderRadius: 12 },
});

export default ConnectionChooserScreen;
