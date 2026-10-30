/**
 * CloudAuth — Clerk for InfiniBot Cloud.
 *
 * <CloudAuthProvider> wraps the app in ClerkProvider when this build has a
 * cloud config, and bridges Clerk's `getToken` into the profile store so
 * every gateway request (WS connect + every HTTP call) gets a FRESH session
 * token. Builds without a cloud config render children untouched (the
 * chooser then only offers self-hosted).
 *
 * <CloudSignIn> — email + password (with email-code second step) and
 * Google, then resolves the tenant gateway through /fleet/resolve.
 */
import React, { useEffect, useState, useCallback } from 'react';
import { View, Text, TextInput, TouchableOpacity, ActivityIndicator, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as SecureStore from 'expo-secure-store';
import * as WebBrowser from 'expo-web-browser';
import { ClerkProvider, useAuth, useSignIn, useSSO, useUser } from '@clerk/clerk-expo';
import { COLORS } from '../constants/theme';
import { getCloudConfig } from './cloud-config';
import { setCloudTokenGetter, saveAndActivateProfile, ensureCloudGatewayUrl } from './profile-store';
import { makeCloudProfile } from './connection-logic';

WebBrowser.maybeCompleteAuthSession();

// Clerk's client token lives in the platform keystore, not AsyncStorage.
const tokenCache = {
  getToken: (key) => SecureStore.getItemAsync(key).catch(() => null),
  saveToken: (key, value) => SecureStore.setItemAsync(key, value).catch(() => {}),
  clearToken: (key) => SecureStore.deleteItemAsync(key).catch(() => {}),
};

function TokenBridge() {
  const { isSignedIn, getToken } = useAuth();
  useEffect(() => {
    if (isSignedIn) setCloudTokenGetter((opts) => getToken(opts || undefined));
    else setCloudTokenGetter(null);
    return () => setCloudTokenGetter(null);
  }, [isSignedIn, getToken]);
  return null;
}

export function CloudAuthProvider({ children }) {
  const cfg = getCloudConfig();
  if (!cfg.clerkPublishableKey) return children;
  return (
    <ClerkProvider publishableKey={cfg.clerkPublishableKey} tokenCache={tokenCache}>
      <TokenBridge />
      {children}
    </ClerkProvider>
  );
}

/** Sign out of Clerk (cloud profiles only). Safe to call without Clerk. */
export function useCloudSignOut() {
  const cfg = getCloudConfig();
  if (!cfg.clerkPublishableKey) return async () => {};
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const { signOut } = useAuth();
  return signOut;
}

export function CloudSignIn({ onConnected, onBack }) {
  const cfg = getCloudConfig();
  const { isSignedIn } = useAuth();
  const { user } = useUser();
  const { signIn, setActive, isLoaded } = useSignIn();
  const { startSSOFlow } = useSSO();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [step, setStep] = useState('credentials'); // credentials | code | resolving
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [note, setNote] = useState(null);

  const resolveAndConnect = useCallback(async (userEmail) => {
    setStep('resolving');
    setNote('Finding your InfiniBot…');
    setError(null);
    const profile = makeCloudProfile({ orchestratorUrl: cfg.orchestratorUrl, email: userEmail || null });
    await saveAndActivateProfile(profile);
    const out = await ensureCloudGatewayUrl({
      force: true,
      onWaking: () => setNote('Waking your InfiniBot — this takes a few seconds…'),
    });
    if (out.state === 'ready') {
      onConnected?.();
      return;
    }
    if (out.state === 'serverless') {
      setError('Your plan runs InfiniBot Cloud without a dedicated gateway. The mobile app needs a gateway — upgrade to Pro in the web dashboard, or connect a self-hosted gateway.');
    } else {
      setError(out.message || 'Could not reach InfiniBot Cloud.');
    }
    setStep('credentials');
    setNote(null);
  }, [cfg.orchestratorUrl, onConnected]);

  // Already signed in (returning user / after SSO): go straight to resolve.
  useEffect(() => {
    if (isSignedIn && step === 'credentials' && !busy) {
      resolveAndConnect(user?.primaryEmailAddress?.emailAddress);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSignedIn]);

  const submitPassword = async () => {
    if (!isLoaded) return;
    setBusy(true);
    setError(null);
    try {
      const res = await signIn.create({ identifier: email.trim(), password });
      if (res.status === 'complete') {
        await setActive({ session: res.createdSessionId });
      } else if (res.status === 'needs_second_factor' || res.status === 'needs_first_factor') {
        const factor = (res.supportedSecondFactors || res.supportedFirstFactors || []).find((f) => f.strategy === 'email_code');
        if (!factor) throw new Error('This account needs a sign-in method the app does not support yet — use the web dashboard.');
        if (res.status === 'needs_second_factor') await signIn.prepareSecondFactor({ strategy: 'email_code' });
        else await signIn.prepareFirstFactor({ strategy: 'email_code', emailAddressId: factor.emailAddressId });
        setStep('code');
      } else {
        throw new Error(`Sign-in incomplete (${res.status}).`);
      }
    } catch (e) {
      setError(e?.errors?.[0]?.longMessage || e?.errors?.[0]?.message || e?.message || 'Sign-in failed');
    } finally {
      setBusy(false);
    }
  };

  const submitCode = async () => {
    setBusy(true);
    setError(null);
    try {
      const attempt = signIn.status === 'needs_second_factor'
        ? await signIn.attemptSecondFactor({ strategy: 'email_code', code: code.trim() })
        : await signIn.attemptFirstFactor({ strategy: 'email_code', code: code.trim() });
      if (attempt.status !== 'complete') throw new Error('That code did not work.');
      await setActive({ session: attempt.createdSessionId });
    } catch (e) {
      setError(e?.errors?.[0]?.longMessage || e?.message || 'Verification failed');
    } finally {
      setBusy(false);
    }
  };

  const google = async () => {
    setBusy(true);
    setError(null);
    try {
      const { createdSessionId, setActive: setSSOActive } = await startSSOFlow({ strategy: 'oauth_google' });
      if (createdSessionId) await setSSOActive({ session: createdSessionId });
    } catch (e) {
      setError(e?.errors?.[0]?.longMessage || e?.message || 'Google sign-in failed');
    } finally {
      setBusy(false);
    }
  };

  if (step === 'resolving') {
    return (
      <View style={s.center}>
        <ActivityIndicator color={COLORS.primary} />
        <Text style={s.note}>{note}</Text>
      </View>
    );
  }

  return (
    <View>
      {step === 'credentials' ? (
        <>
          <Text style={s.label}>Email</Text>
          <TextInput style={s.input} value={email} onChangeText={setEmail} autoCapitalize="none" autoCorrect={false}
            keyboardType="email-address" placeholder="you@company.com" placeholderTextColor="rgba(255,255,255,0.3)" />
          <Text style={s.label}>Password</Text>
          <TextInput style={s.input} value={password} onChangeText={setPassword} secureTextEntry autoCapitalize="none"
            placeholder="Password" placeholderTextColor="rgba(255,255,255,0.3)" onSubmitEditing={submitPassword} />
          <TouchableOpacity style={s.primary} onPress={submitPassword} disabled={busy || !email || !password}>
            {busy ? <ActivityIndicator color="#000" /> : <Text style={s.primaryText}>Sign in</Text>}
          </TouchableOpacity>
          <TouchableOpacity style={s.secondary} onPress={google} disabled={busy}>
            <Ionicons name="logo-google" size={16} color={COLORS.primary} />
            <Text style={s.secondaryText}>Continue with Google</Text>
          </TouchableOpacity>
        </>
      ) : (
        <>
          <Text style={s.label}>Code sent to your email</Text>
          <TextInput style={s.input} value={code} onChangeText={setCode} keyboardType="number-pad" placeholder="123456"
            placeholderTextColor="rgba(255,255,255,0.3)" onSubmitEditing={submitCode} />
          <TouchableOpacity style={s.primary} onPress={submitCode} disabled={busy || !code}>
            {busy ? <ActivityIndicator color="#000" /> : <Text style={s.primaryText}>Verify</Text>}
          </TouchableOpacity>
        </>
      )}
      {error ? <Text style={s.error}>{error}</Text> : null}
      {onBack ? (
        <TouchableOpacity onPress={onBack} style={s.back}><Text style={s.backText}>Back</Text></TouchableOpacity>
      ) : null}
    </View>
  );
}

const s = StyleSheet.create({
  center: { alignItems: 'center', paddingVertical: 28, gap: 12 },
  note: { color: 'rgba(255,255,255,0.7)', fontSize: 13, textAlign: 'center' },
  label: { color: 'rgba(255,255,255,0.55)', fontSize: 11, fontWeight: '700', letterSpacing: 1, textTransform: 'uppercase', marginTop: 12, marginBottom: 6 },
  input: {
    color: '#fff', fontSize: 15, paddingHorizontal: 14, paddingVertical: 12, borderRadius: 12,
    borderWidth: 1, borderColor: 'rgba(212,175,55,0.25)', backgroundColor: 'rgba(255,255,255,0.04)',
  },
  primary: { marginTop: 18, backgroundColor: '#D4AF37', borderRadius: 12, paddingVertical: 14, alignItems: 'center' },
  primaryText: { color: '#000', fontWeight: '800', fontSize: 15 },
  secondary: {
    marginTop: 10, borderRadius: 12, paddingVertical: 12, alignItems: 'center', justifyContent: 'center',
    flexDirection: 'row', gap: 8, borderWidth: 1, borderColor: 'rgba(212,175,55,0.35)',
  },
  secondaryText: { color: '#D4AF37', fontWeight: '700' },
  error: { color: '#f87171', marginTop: 12, fontSize: 13, lineHeight: 18 },
  back: { alignSelf: 'center', marginTop: 14, padding: 6 },
  backText: { color: 'rgba(255,255,255,0.5)', fontSize: 13 },
});
