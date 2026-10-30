/**
 * WhatsAppLink — native port of the WhatsApp card actions
 * (ui/src/ui/views/channels.whatsapp.ts + controllers/channels.ts, and the
 * comms-hub pairing-code variant):
 *
 *   Pairing code  web.login.pairingCode.start { phoneNumber, force, timeoutMs }
 *   Show QR       web.login.start { force, timeoutMs }  → qrDataUrl (PNG data URL)
 *   auto-poll     web.login.wait { timeoutMs: 30000 } until linked / expired / 3 min
 *   Wait for scan web.login.wait { timeoutMs: 120000 }
 *   Logout        channels.logout { channel: 'whatsapp' }
 *
 * The QR is the gateway's own PNG data URL rendered with <Image>; no QR lib.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, Image, StyleSheet } from 'react-native';
import * as Clipboard from 'expo-clipboard';

import { Button, Input, SegmentedControl, useUIKit, SPACE, RADIUS, MONO_FAMILY } from '../../ui-kit';
import { withAlpha } from '../../theme/color-utils';
import { WA_LOGIN_TTL_MS, waLoginExpired, formatPairingCode, normalizePhone, phoneLooksValid } from './comms-model';

export function WhatsAppLink({ gateway, onChanged }) {
  const { colors, type } = useUIKit();
  const sendReq = gateway?.sendReq;
  const [mode, setMode] = useState('pairing');
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);
  const [qr, setQr] = useState(null);
  const [code, setCode] = useState(null);
  const [linked, setLinked] = useState(null);
  const [polling, setPolling] = useState(false);
  const mounted = useRef(true);
  const pendingRef = useRef({ qr: null, code: null, linked: null });
  pendingRef.current = { qr, code, linked };

  useEffect(() => () => { mounted.current = false; }, []);

  const autoAwait = useCallback(async () => {
    const deadline = Date.now() + WA_LOGIN_TTL_MS;
    setPolling(true);
    try {
      while (mounted.current && Date.now() < deadline) {
        const p = pendingRef.current;
        if (!(p.qr || p.code) || p.linked) return;
        let res;
        try {
          res = await sendReq('web.login.wait', { timeoutMs: 30000 });
        } catch (e) {
          if (mounted.current) setMessage(e?.message || String(e));
          return;
        }
        if (!mounted.current) return;
        if (res?.connected) {
          setLinked(true);
          setMessage(res.message ?? 'Linked! WhatsApp is ready.');
          setQr(null);
          setCode(null);
          pendingRef.current = { qr: null, code: null, linked: true };
          onChanged?.(true);
          return;
        }
        if (res?.message) setMessage(res.message);
        if (waLoginExpired(res?.message)) {
          setQr(null);
          setCode(null);
          pendingRef.current = { qr: null, code: null, linked: null };
          return;
        }
      }
    } finally {
      if (mounted.current) setPolling(false);
    }
  }, [sendReq, onChanged]);

  const startQr = async (force) => {
    if (!sendReq || busy) return;
    setBusy(true);
    let got = null;
    try {
      const res = await sendReq('web.login.start', { force, timeoutMs: 30000 });
      setMessage(res?.message ?? null);
      got = res?.qrDataUrl ?? null;
      setQr(got);
      setCode(null);
      setLinked(null);
    } catch (e) {
      setMessage(e?.message || String(e));
      setQr(null);
      setLinked(null);
    } finally {
      setBusy(false);
    }
    onChanged?.(false);
    if (got) {
      pendingRef.current = { qr: got, code: null, linked: null };
      autoAwait();
    }
  };

  const startPairing = async (force) => {
    if (!sendReq || busy) return;
    setBusy(true);
    setCode(null);
    setQr(null);
    setLinked(null);
    let got = null;
    try {
      const res = await sendReq('web.login.pairingCode.start', { phoneNumber: normalizePhone(phone), force, timeoutMs: 30000 });
      setMessage(res?.message ?? null);
      got = res?.pairingCode ?? null;
      setCode(got);
    } catch (e) {
      setMessage(e?.message || String(e));
    } finally {
      setBusy(false);
    }
    if (got) {
      pendingRef.current = { qr: null, code: got, linked: null };
      autoAwait();
    }
  };

  const waitScan = async () => {
    if (!sendReq || busy) return;
    setBusy(true);
    try {
      const res = await sendReq('web.login.wait', { timeoutMs: 120000 });
      setMessage(res?.message ?? null);
      setLinked(res?.connected ?? null);
      if (res?.connected) { setQr(null); setCode(null); }
    } catch (e) {
      setMessage(e?.message || String(e));
      setLinked(null);
    } finally {
      setBusy(false);
    }
    onChanged?.(true);
  };

  const logout = async () => {
    if (!sendReq || busy) return;
    setBusy(true);
    try {
      await sendReq('channels.logout', { channel: 'whatsapp' });
      setMessage('Logged out.');
      setQr(null);
      setCode(null);
      setLinked(null);
    } catch (e) {
      setMessage(e?.message || String(e));
    } finally {
      setBusy(false);
    }
    onChanged?.(true);
  };

  const switchMode = (m) => {
    setMode(m);
    setMessage(null);
    // QR has a short TTL: mint one as soon as the user switches to it.
    if (m === 'qr' && !qr) startQr(false);
  };

  return (
    <View style={st.gap}>
      <SegmentedControl
        size="sm"
        options={[{ key: 'pairing', label: 'Phone number' }, { key: 'qr', label: 'Scan QR' }]}
        value={mode}
        onChange={switchMode}
      />

      {mode === 'pairing' ? (
        <View style={st.gap}>
          <Input
            label="Your WhatsApp number"
            value={phone}
            onChangeText={setPhone}
            placeholder="+15551234567"
            keyboardType="phone-pad"
            mono
            helper="Include the country code. WhatsApp shows a notification: enter the 8-digit code there (Linked devices → Link with phone number)."
          />
          <View style={st.row}>
            <Button title={busy ? 'Working…' : code ? 'New code' : 'Get code'} variant="primary" size="sm" loading={busy} disabled={busy || !phoneLooksValid(phone)} onPress={() => startPairing(Boolean(code))} />
          </View>
          {code ? (
            <View style={[st.codeBox, { borderColor: colors.primary, backgroundColor: withAlpha(colors.primary, 0.08) }]}>
              <Text style={[type.caption, { color: colors.textMuted }]}>Pairing code</Text>
              <Text selectable style={[st.code, { color: colors.primary }]}>{formatPairingCode(code)}</Text>
              <Button title="Copy" icon="copy-outline" variant="ghost" size="sm" onPress={() => Clipboard.setStringAsync(String(code)).catch(() => {})} />
            </View>
          ) : null}
        </View>
      ) : (
        <View style={st.gap}>
          {qr ? (
            <View style={st.qrWrap}>
              <Image source={{ uri: qr }} style={st.qr} resizeMode="contain" accessibilityLabel="WhatsApp QR" />
              <Text style={[type.caption, { color: colors.textMuted, textAlign: 'center' }]}>
                Open WhatsApp → Linked Devices → scan this code. It links automatically once scanned.
              </Text>
            </View>
          ) : null}
          <View style={st.row}>
            <Button title={busy ? 'Working…' : 'Connect (Show QR)'} variant="primary" size="sm" loading={busy} disabled={busy} onPress={() => startQr(false)} />
            <Button title="Relink" variant="outline" size="sm" disabled={busy} onPress={() => startQr(true)} />
          </View>
        </View>
      )}

      {polling ? <Text style={[type.caption, { color: colors.textMuted }]}>Waiting for WhatsApp to link…</Text> : null}
      {message ? (
        <View style={[st.callout, { borderColor: linked ? withAlpha(colors.success, 0.5) : colors.border }]}>
          <Text style={[type.small, { color: linked ? colors.success : colors.textSecondary }]}>{message}</Text>
        </View>
      ) : null}

      <View style={st.row}>
        <Button title="Wait for scan" variant="outline" size="sm" disabled={busy} onPress={waitScan} />
        <Button title="Logout" variant="danger" size="sm" disabled={busy} onPress={logout} />
      </View>
    </View>
  );
}

const st = StyleSheet.create({
  gap: { gap: SPACE.sm },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.sm },
  qrWrap: { alignItems: 'center', gap: SPACE.sm },
  qr: { width: 240, height: 240, borderRadius: RADIUS.sm, backgroundColor: '#fff' },
  codeBox: { alignItems: 'center', gap: SPACE.xs, padding: SPACE.md, borderRadius: RADIUS.md, borderWidth: 1 },
  code: { fontFamily: MONO_FAMILY, fontSize: 28, letterSpacing: 4, fontWeight: '700' },
  callout: { padding: SPACE.md, borderRadius: RADIUS.md, borderWidth: 1 },
});

export default WhatsAppLink;
