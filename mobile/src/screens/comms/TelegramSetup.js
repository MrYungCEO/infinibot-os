/**
 * TelegramSetup — native port of <telegram-setup> (ui/src/ui/components/
 * telegram-setup.ts), the guided Telegram bot setup on the Channels card.
 *
 *   summary → create (token) → verify (bot card, webhook warning) →
 *   find (deep link + QR + code, polled) → confirm → test → done
 *
 * Talks only to telegram.setup.* RPCs; the token is sent once to verify and
 * dropped from state. onChanged() fires after save / disconnect so the parent
 * refreshes channels.status.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, Image, StyleSheet, Linking, Pressable } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { Ionicons } from '@expo/vector-icons';

import { Card, Button, Input, Chip, SegmentedControl, Divider, useUIKit, SPACE, RADIUS, MONO_FAMILY } from '../../ui-kit';
import { withAlpha } from '../../theme/color-utils';
import {
  TG_STEPS,
  checkTelegramTokenFormat,
  tgWho,
  tgClock,
  tgErrorFromThrow,
  tgStepIndex,
  tgInitialStep,
  tgReportsTarget,
} from './comms-model';

const POLL_MS = 1500;

export function TelegramSetup({ gateway, onChanged }) {
  const { colors, type } = useUIKit();
  const sendReq = gateway?.sendReq;
  const [step, setStep] = useState('loading');
  const [summary, setSummary] = useState(null);
  const [session, setSession] = useState(null);
  const [tokenInput, setTokenInput] = useState('');
  const [showToken, setShowToken] = useState(false);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [findTab, setFindTab] = useState('dm');
  const [qr, setQr] = useState(null);
  const [manualId, setManualId] = useState('');
  const [manualOpen, setManualOpen] = useState(false);
  const [makeDefault, setMakeDefault] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [copied, setCopied] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [starting, setStarting] = useState(false);
  const [privacyOpen, setPrivacyOpen] = useState(false);

  const pollRef = useRef(null);
  const tickRef = useRef(null);
  const sessionRef = useRef(null);
  const mounted = useRef(true);
  sessionRef.current = session;

  const api = useCallback(async (action, params = {}) => {
    if (!sendReq) return { ok: false, error: tgErrorFromThrow(new Error('Not connected to InfiniBot')) };
    try {
      const res = await sendReq(`telegram.setup.${action}`, params);
      return res && typeof res === 'object' ? res : { ok: false, error: tgErrorFromThrow(new Error('Empty reply')) };
    } catch (e) {
      return { ok: false, error: tgErrorFromThrow(e) };
    }
  }, [sendReq]);

  const run = useCallback(async (label, action, params) => {
    if (busy) return null;
    setBusy(label);
    setError(null);
    try {
      const res = await api(action, params);
      if (!res.ok) {
        if (mounted.current) setError(res.error);
        return null;
      }
      return res;
    } finally {
      if (mounted.current) setBusy(null);
    }
  }, [api, busy]);

  const stopPolling = useCallback(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    if (tickRef.current) clearInterval(tickRef.current);
    pollRef.current = null;
    tickRef.current = null;
  }, []);

  const pollOnce = useCallback(async () => {
    const s = sessionRef.current;
    if (!s || s.capture?.status !== 'waiting') { stopPolling(); return; }
    const res = await api('capture.status', { sessionId: s.sessionId });
    if (!mounted.current || sessionRef.current?.sessionId !== s.sessionId) return;
    if (!res.ok) { stopPolling(); setError(res.error); return; }
    setSession(res);
    if (res.capture?.status !== 'waiting') stopPolling();
  }, [api, stopPolling]);

  const startPolling = useCallback(() => {
    stopPolling();
    setNow(Date.now());
    tickRef.current = setInterval(() => setNow(Date.now()), 1000);
    pollRef.current = setInterval(() => { pollOnce(); }, POLL_MS);
  }, [pollOnce, stopPolling]);

  const loadSummary = useCallback(async () => {
    const res = await api('summary');
    if (!mounted.current) return;
    if (!res.ok) { setError(res.error); setStep('create'); return; }
    setSummary(res);
    setStep(tgInitialStep(res));
  }, [api]);

  useEffect(() => {
    mounted.current = true;
    loadSummary();
    return () => {
      mounted.current = false;
      stopPolling();
      const s = sessionRef.current;
      // Leaving the page stops the gateway listening for this setup.
      if (s?.capture?.status === 'waiting') api('capture.cancel', { sessionId: s.sessionId });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const verify = async (useSaved) => {
    const res = await run('verify', 'verify', useSaved ? { useSaved: true } : { token: tokenInput });
    if (!res) return;
    setTokenInput('');
    setShowToken(false);
    setSession(res);
    setStep('verify');
  };

  const startCapture = async (mode, base) => {
    const s = base || sessionRef.current;
    if (!s) return;
    setFindTab(mode);
    stopPolling();
    const res = await run('capture', 'capture.start', { sessionId: s.sessionId, mode });
    if (!res) { setSession({ ...s, capture: null }); return; }
    setSession(res);
    sessionRef.current = res;
    setQr(res.qr ?? null);
    startPolling();
  };

  const removeWebhook = async () => {
    const s = sessionRef.current;
    if (!s) return;
    const res = await run('webhook', 'deleteWebhook', { sessionId: s.sessionId });
    if (!res) return;
    setSession(res);
    sessionRef.current = res;
    if (step === 'find') startCapture(findTab, res);
  };

  const useManual = async () => {
    const s = sessionRef.current;
    if (!s) return;
    const res = await run('manual', 'manual', { sessionId: s.sessionId, mode: findTab, id: manualId });
    if (!res) return;
    stopPolling();
    setSession(res);
    setManualId('');
  };

  const waitUntilRunning = async () => {
    setStarting(true);
    try {
      const deadline = Date.now() + 45_000;
      while (Date.now() < deadline && mounted.current) {
        const res = await api('summary');
        if (res?.ok) {
          setSummary(res);
          if (res.running) return;
        }
        await new Promise((r) => setTimeout(r, 1500));
      }
    } finally {
      if (mounted.current) setStarting(false);
    }
  };

  const confirm = async () => {
    const s = sessionRef.current;
    if (!s) return;
    const mode = s.capture?.mode ?? 'dm';
    const res = await run('confirm', 'confirm', { sessionId: s.sessionId, makeDefault: mode === 'group' && makeDefault });
    if (!res) return;
    setSession(res);
    setSummary(res.summary);
    setTestResult(null);
    setStep(mode === 'group' ? 'done' : 'test');
    if (res.starting !== 'saved') await waitUntilRunning();
    onChanged?.();
  };

  const sendTest = async (chatId) => {
    const res = await run('test', 'test', { sessionId: sessionRef.current?.sessionId ?? '', ...(chatId ? { chatId } : {}) });
    if (res) setTestResult('sent');
  };

  const openSaved = async (then) => {
    const res = await run('verify', 'verify', { useSaved: true });
    if (!res) return;
    setSession(res);
    sessionRef.current = res;
    setStep('find');
    startCapture(then === 'find-group' ? 'group' : 'dm', res);
  };

  const disconnect = async () => {
    const res = await run('disconnect', 'disconnect', { sessionId: sessionRef.current?.sessionId ?? '' });
    if (!res) return;
    setConfirmDisconnect(false);
    setSession(null);
    setSummary(res);
    setStep('create');
    onChanged?.();
  };

  const restart = () => {
    stopPolling();
    const s = sessionRef.current;
    if (s?.capture?.status === 'waiting') api('capture.cancel', { sessionId: s.sessionId });
    setSession(null);
    setError(null);
    setStep('create');
  };

  const copyCode = async (code) => {
    try {
      await Clipboard.setStringAsync(String(code));
      setCopied(true);
      setTimeout(() => mounted.current && setCopied(false), 1600);
    } catch { /* code is on screen to type */ }
  };

  const open = (url) => { if (url) Linking.openURL(url).catch(() => {}); };

  // ── render helpers ──────────────────────────────────────────────────────
  const t = {
    h: [type.h3, { color: colors.text }],
    lead: [type.small, { color: colors.textSecondary }],
    muted: [type.caption, { color: colors.textMuted }],
    mono: { fontFamily: MONO_FAMILY, color: colors.text, fontSize: 13 },
  };

  const Alert = ({ e, tone = 'danger', children }) => (
    <View style={[st.alert, { borderColor: withAlpha(tone === 'danger' ? colors.error : colors.warning, 0.5), backgroundColor: withAlpha(tone === 'danger' ? colors.error : colors.warning, 0.08) }]}>
      {e?.title ? <Text style={[type.smallStrong, { color: colors.text }]}>{e.title}</Text> : null}
      {e?.message ? <Text style={t.lead}>{e.message}</Text> : null}
      {e?.fix ? <Text style={t.lead}><Text style={{ fontWeight: '700' }}>What to do: </Text>{e.fix}</Text> : null}
      {children}
    </View>
  );

  const renderError = (extra) => {
    if (!error) return null;
    return (
      <Alert e={error}>
        {error.action === 'deleteWebhook' && session ? (
          <Button title={busy === 'webhook' ? 'Disconnecting…' : 'Disconnect the other app'} size="sm" variant="primary" loading={busy === 'webhook'} disabled={Boolean(busy)} onPress={removeWebhook} />
        ) : null}
        {extra}
      </Alert>
    );
  };

  const Stepper = () => {
    const idx = tgStepIndex(step);
    return (
      <View style={{ gap: SPACE.xs }}>
        <View style={st.stepper}>
          {TG_STEPS.map((s, i) => (
            <View key={s.id} style={[st.stepDot, {
              borderColor: i <= idx ? colors.primary : colors.border,
              backgroundColor: i < idx ? withAlpha(colors.primary, 0.18) : 'transparent',
            }]}>
              {i < idx ? <Ionicons name="checkmark" size={13} color={colors.primary} /> : (
                <Text style={[type.caption, { color: i === idx ? colors.primary : colors.textMuted }]}>{i + 1}</Text>
              )}
            </View>
          ))}
        </View>
        <Text style={t.muted}>Step {idx + 1} of {TG_STEPS.length} · {TG_STEPS[idx]?.label}</Text>
      </View>
    );
  };

  const BotCard = ({ s }) => {
    const bot = s.bot || {};
    const initial = (bot.name || bot.username || 'B').slice(0, 1).toUpperCase();
    return (
      <View style={[st.botcard, { borderColor: colors.border }]}>
        {bot.avatar ? <Image source={{ uri: bot.avatar }} style={st.avatar} /> : (
          <View style={[st.avatar, { backgroundColor: withAlpha(colors.primary, 0.14), alignItems: 'center', justifyContent: 'center' }]}>
            <Text style={[type.h3, { color: colors.primary }]}>{initial}</Text>
          </View>
        )}
        <View style={{ flex: 1 }}>
          <Text style={[type.bodyStrong, { color: colors.text }]}>{bot.name ?? 'Your bot'}</Text>
          {bot.username ? <Text style={t.lead}>@{bot.username}</Text> : null}
          <Text style={[t.muted, { fontFamily: MONO_FAMILY }]}>Token {s.tokenMasked}</Text>
        </View>
        <Chip label="Token works" tone="success" icon="checkmark" size="sm" />
      </View>
    );
  };

  // ── steps ───────────────────────────────────────────────────────────────
  const renderCreate = () => {
    const typed = tokenInput.trim();
    const format = typed ? checkTelegramTokenFormat(typed) : null;
    const saved = summary?.connected;
    const steps = [
      'Open BotFather, Telegram\'s official bot for making bots.',
      'Send it /newbot',
      'Type a name for your bot. Anything works, like "My Assistant".',
      'Type a username that ends in bot, like my_helper_bot. If it\'s taken, try another.',
      'BotFather replies with a long line of numbers and letters. That\'s your token. Tap it to copy.',
    ];
    return (
      <View style={st.gap}>
        <Text style={t.h}>Create your Telegram bot</Text>
        <Text style={t.lead}>Your assistant talks to you through its own Telegram bot. Making one is free and takes about a minute.</Text>
        {steps.map((line, i) => (
          <View key={i} style={st.howRow}>
            <Text style={[type.monoSmall, { color: colors.primary, width: 18 }]}>{i + 1}.</Text>
            <Text style={[t.lead, { flex: 1 }]}>{line}</Text>
          </View>
        ))}
        <Button title="Open BotFather" icon="open-outline" variant="secondary" size="sm" onPress={() => open('https://t.me/BotFather')} />
        <Input
          label="Paste your bot token here"
          value={tokenInput}
          onChangeText={(v) => { setTokenInput(v); setError(null); }}
          placeholder="123456789:AAH…"
          mono
          secureTextEntry={!showToken}
          autoCapitalize="none"
          autoCorrect={false}
          rightIcon={showToken ? 'eye-off-outline' : 'eye-outline'}
          rightLabel={showToken ? 'Hide token' : 'Show token'}
          onRightPress={() => setShowToken(!showToken)}
          error={format && !format.ok ? format.message : undefined}
          helper={format?.ok ? 'Looks like a bot token. Press "Check my token".' : "It's only sent to your InfiniBot to check it. Keep it private, like a password."}
        />
        {renderError()}
        <View style={st.row}>
          <Button title={busy === 'verify' ? 'Checking with Telegram…' : 'Check my token'} variant="primary" size="sm" loading={busy === 'verify'} disabled={!format?.ok || Boolean(busy)} onPress={() => verify(false)} />
          {saved ? <Button title="Use the saved bot" variant="outline" size="sm" disabled={Boolean(busy)} onPress={() => verify(true)} /> : null}
          {saved ? <Button title="Cancel" variant="ghost" size="sm" onPress={() => setStep('summary')} /> : null}
        </View>
      </View>
    );
  };

  const renderVerify = () => {
    if (!session) return null;
    return (
      <View style={st.gap}>
        <Text style={t.h}>Is this your bot?</Text>
        <Text style={t.lead}>Telegram recognised the token. Check it's the bot you just made.</Text>
        <BotCard s={session} />
        {session.webhookHost ? (
          <Alert tone="warning" e={{
            title: 'This bot is connected to another app',
            message: `Telegram is sending this bot's messages to ${session.webhookHost}. A bot can only talk to one app at a time.`,
            fix: "if you're moving this bot to InfiniBot, disconnect the other app. It will stop getting this bot's messages. Otherwise go back and make a new bot.",
          }}>
            <Button title={busy === 'webhook' ? 'Disconnecting…' : 'Disconnect the other app'} variant="primary" size="sm" loading={busy === 'webhook'} disabled={Boolean(busy)} onPress={removeWebhook} />
          </Alert>
        ) : null}
        {renderError()}
        <View style={st.row}>
          <Button title="Yes, continue" variant="primary" size="sm" disabled={Boolean(session.webhookHost) || Boolean(busy)} onPress={() => { setError(null); setStep('find'); startCapture('dm'); }} />
          <Button title="Use a different token" variant="outline" size="sm" onPress={restart} />
        </View>
      </View>
    );
  };

  const renderWaiting = (bot) => {
    const capture = session?.capture;
    if (!capture) return null;
    const group = capture.mode === 'group';
    const left = capture.expiresAt - now;
    return (
      <View style={st.gap}>
        {(group
          ? [`Tap the button and pick the group to add ${bot} to.`, `Telegram posts a start message in the group for you. If nothing appears, send /start@${session.bot?.username ?? 'yourbot'} ${capture.code} in the group.`]
          : [`Tap the button to open ${bot} in Telegram.`, 'Press Start at the bottom of the chat.']
        ).map((line, i) => (
          <View key={i} style={st.howRow}>
            <Text style={[type.monoSmall, { color: colors.primary, width: 18 }]}>{i + 1}.</Text>
            <Text style={[t.lead, { flex: 1 }]}>{line}</Text>
          </View>
        ))}
        {capture.deepLink ? (
          <Button title={group ? 'Add bot to a group' : `Open ${bot} in Telegram`} icon="paper-plane-outline" variant="primary" onPress={() => open(capture.deepLink)} fullWidth />
        ) : null}
        <View style={[st.row, { alignItems: 'center' }]}>
          <Text style={t.lead}>{group ? 'The code for this group:' : 'Already chatting with it? Send it this code:'}</Text>
          <Pressable onPress={() => copyCode(capture.code)} accessibilityRole="button" accessibilityLabel="Copy code" hitSlop={10}
            style={({ pressed }) => [st.code, { borderColor: colors.primary, opacity: pressed ? 0.8 : 1 }]}>
            <Text style={[t.mono, { color: colors.primary }]}>{capture.code}</Text>
            <Ionicons name={copied ? 'checkmark' : 'copy-outline'} size={14} color={colors.primary} />
          </Pressable>
        </View>
        <View style={[st.row, { alignItems: 'center' }]}>
          <Ionicons name="time-outline" size={16} color={colors.textMuted} />
          <Text style={t.lead}>Waiting for your message… <Text style={{ fontFamily: MONO_FAMILY, color: colors.text }}>{tgClock(left)}</Text> left</Text>
        </View>
        {capture.otherMessages > 0 ? (
          <Text style={[t.lead, { color: colors.warning }]}>The bot got a message, but it didn't include your code, so it was ignored. Tap the button above again, or send the code {capture.code}.</Text>
        ) : null}
        {group ? (
          <View>
            <Pressable onPress={() => setPrivacyOpen(!privacyOpen)} accessibilityRole="button" accessibilityLabel="Group privacy help" style={st.disclosure}>
              <Ionicons name={privacyOpen ? 'chevron-down' : 'chevron-forward'} size={14} color={colors.textMuted} />
              <Text style={t.lead}>The bot doesn't see messages in the group?</Text>
            </Pressable>
            {privacyOpen ? (
              <View style={st.gap}>
                <Text style={t.lead}>{session.bot?.canReadAllGroupMessages === true
                  ? 'This bot can read all group messages, so that part is fine.'
                  : "Telegram bots start in privacy mode: in a group they only see messages that start with / or mention the bot by name. That's why the start message works but ordinary chat doesn't."}</Text>
                <Text style={t.lead}>To let your assistant read everything in the group: open @BotFather and send /setprivacy, pick your bot, choose Disable, then remove the bot from the group and add it again. Or leave privacy on and just mention the bot when you want it.</Text>
              </View>
            ) : null}
          </View>
        ) : null}
        {qr ? (
          <View style={st.qrWrap}>
            <Image source={{ uri: qr }} style={st.qr} resizeMode="contain" accessibilityLabel="QR code that opens your bot in Telegram" />
            <Text style={t.muted}>Telegram on another phone? Scan this with the camera.</Text>
          </View>
        ) : null}
      </View>
    );
  };

  const renderManual = () => {
    const dm = findTab === 'dm';
    return (
      <View>
        <Pressable onPress={() => setManualOpen(!manualOpen)} accessibilityRole="button" accessibilityLabel="Enter the ID by hand" style={st.disclosure}>
          <Ionicons name={manualOpen ? 'chevron-down' : 'chevron-forward'} size={14} color={colors.textMuted} />
          <Text style={t.lead}>Can't use the link? Enter the ID by hand</Text>
        </Pressable>
        {manualOpen ? (
          <View style={st.gap}>
            <Text style={t.lead}>{dm
              ? 'In Telegram, search for @userinfobot and press Start. It replies with your Id, a number like 123456789. Also press Start in your own bot once, so it\'s allowed to message you. Then paste the number here.'
              : "Add your bot to the group. Add @userinfobot to the group too: it posts the group's ID, a number that starts with a minus like -1001234567890. Paste it here (keep the minus), then remove @userinfobot."}</Text>
            <Input value={manualId} onChangeText={setManualId} placeholder={dm ? '123456789' : '-1001234567890'} mono keyboardType="numbers-and-punctuation" />
            <Button title={busy === 'manual' ? 'Checking…' : 'Use this ID'} variant="outline" size="sm" loading={busy === 'manual'} disabled={!manualId.trim() || Boolean(busy)} onPress={useManual} />
            {error && session?.capture?.status === 'waiting' ? renderError() : null}
          </View>
        ) : null}
      </View>
    );
  };

  const renderFound = (found, mode) => {
    const group = mode === 'group';
    return (
      <View style={st.gap}>
        <View style={[st.found, { borderColor: withAlpha(colors.success, 0.5) }]}>
          <Ionicons name="checkmark-circle" size={22} color={colors.success} />
          <View style={{ flex: 1 }}>
            <Text style={[type.smallStrong, { color: colors.text }]}>{group ? 'Found your group: ' : 'Found you: '}{tgWho(found)}</Text>
            <Text style={[t.muted, { fontFamily: MONO_FAMILY }]}>{group ? `Group ID ${found.chatId}` : `${found.firstName ? `${found.firstName} · ` : ''}User ID ${found.userId}`}</Text>
          </View>
        </View>
        <Text style={t.lead}>{group ? 'Confirm to let your assistant work in this group.' : 'Confirm to make this account the owner. Only you will be able to talk to your assistant, and its reports will come to this chat.'}</Text>
        {group && session?.owner ? (
          <Pressable onPress={() => setMakeDefault(!makeDefault)} accessibilityRole="checkbox" accessibilityState={{ checked: makeDefault }} accessibilityLabel="Send reports to this group" style={st.disclosure}>
            <Ionicons name={makeDefault ? 'checkbox' : 'square-outline'} size={20} color={colors.primary} />
            <Text style={[t.lead, { flex: 1 }]}>Send reports and alerts to this group instead of my private chat</Text>
          </Pressable>
        ) : null}
        {renderError()}
        <View style={st.row}>
          <Button title={busy === 'confirm' ? 'Saving…' : group ? 'Confirm group' : "Yes, that's me"} variant="primary" size="sm" loading={busy === 'confirm'} disabled={Boolean(busy)} onPress={confirm} />
          <Button title={group ? 'Not this group' : "That's not me"} variant="outline" size="sm" disabled={Boolean(busy)} onPress={() => startCapture(mode)} />
        </View>
      </View>
    );
  };

  const renderFind = () => {
    if (!session) return null;
    const capture = session.capture;
    const bot = session.bot?.username ? `@${session.bot.username}` : 'your bot';
    let body;
    if (capture?.status === 'found' && capture.found) body = renderFound(capture.found, capture.mode);
    else if (capture?.status === 'waiting') body = renderWaiting(bot);
    else if (capture?.status === 'expired') {
      body = (
        <Alert tone="warning" e={{ title: 'That took a little too long', message: 'For safety InfiniBot only listens for 5 minutes. Nothing was saved.' }}>
          <Button title="Try again" variant="primary" size="sm" onPress={() => startCapture(findTab)} />
        </Alert>
      );
    } else if (capture?.status === 'error' && capture.error) {
      body = (
        <Alert e={capture.error}>
          {capture.error.action === 'deleteWebhook'
            ? <Button title="Disconnect the other app" variant="primary" size="sm" onPress={removeWebhook} />
            : <Button title="Try again" variant="primary" size="sm" onPress={() => startCapture(findTab)} />}
        </Alert>
      );
    } else if (error) {
      body = renderError(error.action !== 'deleteWebhook' ? <Button title="Try again" variant="primary" size="sm" onPress={() => startCapture(findTab)} /> : null);
    } else body = <Text style={t.muted}>Getting your link ready…</Text>;

    return (
      <View style={st.gap}>
        <Text style={t.h}>{findTab === 'dm' ? 'Let InfiniBot find you' : 'Add your bot to a group'}</Text>
        <Text style={t.lead}>{findTab === 'dm'
          ? 'Your assistant should only answer you. Send your bot one message and InfiniBot will read your Telegram ID from it. No typing numbers.'
          : "Want your assistant in a group chat too? Add the bot to the group and InfiniBot will read the group's ID."}</Text>
        <SegmentedControl
          size="sm"
          options={[{ key: 'dm', label: 'Just me' }, { key: 'group', label: 'A group' }]}
          value={findTab}
          onChange={(k) => { if (k !== findTab) startCapture(k); }}
        />
        {body}
        {capture?.status === 'found' ? null : renderManual()}
        <View style={st.row}>
          <Button title="Start over" variant="ghost" size="sm" onPress={restart} />
          {session.owner && findTab === 'group' ? <Button title="Skip the group" variant="ghost" size="sm" onPress={() => { stopPolling(); setStep('done'); }} /> : null}
        </View>
      </View>
    );
  };

  const renderTest = () => {
    const sent = testResult === 'sent';
    return (
      <View style={st.gap}>
        <Text style={t.h}>Send a test message</Text>
        <Text style={t.lead}>Let's make sure your bot can reach you. InfiniBot will send "InfiniBot is connected" to your Telegram.</Text>
        {starting ? <Text style={t.lead}>Saved. Switching your bot on… this takes a few seconds.</Text> : null}
        {sent ? (
          <View style={[st.found, { borderColor: withAlpha(colors.success, 0.5) }]}>
            <Ionicons name="checkmark-circle" size={22} color={colors.success} />
            <View style={{ flex: 1 }}>
              <Text style={[type.smallStrong, { color: colors.text }]}>Sent. Check Telegram.</Text>
              <Text style={t.muted}>You should see "InfiniBot is connected" from your bot.</Text>
            </View>
          </View>
        ) : null}
        {renderError()}
        <View style={st.row}>
          {sent ? (
            <>
              <Button title="I got it, finish" variant="primary" size="sm" onPress={() => setStep('done')} />
              <Button title="Send again" variant="outline" size="sm" disabled={Boolean(busy)} onPress={() => sendTest()} />
            </>
          ) : (
            <>
              <Button title={busy === 'test' ? 'Sending…' : 'Send test message'} variant="primary" size="sm" loading={busy === 'test'} disabled={Boolean(busy) || starting} onPress={() => sendTest()} />
              <Button title="Skip" variant="ghost" size="sm" onPress={() => setStep('done')} />
            </>
          )}
        </View>
      </View>
    );
  };

  const renderSummary = (justFinished) => {
    const s = summary;
    if (!s) return null;
    const botUser = session?.bot?.username ?? s.bot?.username ?? null;
    const botName = session?.bot?.name ?? s.bot?.name ?? null;
    const ownerName = session?.owner ? tgWho(session.owner) : null;
    const groupNames = new Map((session?.groups ?? []).map((g) => [String(g.chatId), g.chatTitle ?? '']));
    const rows = [
      ['Bot token', s.tokenMasked ?? '—', true],
      ['Owner', s.owners?.length ? `${ownerName ? `${ownerName} · ` : ''}ID ${s.owners.join(', ')}` : 'Not set yet. Anyone who finds the bot has to be approved first.', Boolean(s.owners?.length)],
      ['Reports go to', tgReportsTarget(s.defaultChatId) ?? 'Not set yet', Boolean(s.defaultChatId)],
      ['Groups', s.groups?.length ? s.groups.map((g) => (groupNames.get(g) ? `${groupNames.get(g)} · ${g}` : g)).join(', ') : 'None', true],
    ];
    return (
      <View style={st.gap}>
        {justFinished ? (
          <>
            <Text style={t.h}>You're all set</Text>
            <Text style={t.lead}>{s.note ? 'Your bot is saved.' : 'Telegram is connected and running. Open your bot and say hello: your assistant will answer.'}</Text>
          </>
        ) : null}
        <View style={[st.botcard, { borderColor: colors.border }]}>
          <View style={[st.avatar, { backgroundColor: withAlpha(colors.primary, 0.14), alignItems: 'center', justifyContent: 'center' }]}>
            <Text style={[type.h3, { color: colors.primary }]}>{(botName || botUser || 'T').slice(0, 1).toUpperCase()}</Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={[type.bodyStrong, { color: colors.text }]}>{botName ?? 'Telegram bot'}</Text>
            <Text style={t.lead}>{botUser ? `@${botUser}` : 'Connected'}</Text>
          </View>
          <Chip size="sm" tone={s.running ? 'success' : 'neutral'} dot label={s.running ? 'Running' : starting ? 'Starting…' : s.note ? 'Saved' : 'Saved, not running'} />
        </View>
        {rows.map(([k, v, ok]) => (
          <View key={k} style={st.kv}>
            <Text style={[t.muted, { width: 104 }]}>{k}</Text>
            <Text style={[k === 'Bot token' ? t.mono : t.lead, { flex: 1 }, !ok && { color: colors.warning }]}>{v}</Text>
          </View>
        ))}
        {s.note ? <Text style={t.lead}>{s.note}</Text> : null}
        {s.lastError && !s.running && !s.note ? <Text style={[t.lead, { color: colors.error }]}>Last problem: {s.lastError}</Text> : null}
        {renderError()}
        {confirmDisconnect ? (
          <Alert tone="warning" e={{ title: 'Disconnect Telegram?', message: 'Your assistant will stop answering on Telegram and the saved token is removed. The bot itself stays in BotFather, so you can connect it again later.' }}>
            <View style={st.row}>
              <Button title={busy === 'disconnect' ? 'Disconnecting…' : 'Yes, disconnect'} variant="danger" size="sm" loading={busy === 'disconnect'} disabled={Boolean(busy)} onPress={disconnect} />
              <Button title="Keep it" variant="outline" size="sm" onPress={() => setConfirmDisconnect(false)} />
            </View>
          </Alert>
        ) : (
          <View style={st.row}>
            <Button title={s.owners?.length ? 'Change owner' : 'Find my ID'} variant="outline" size="sm" disabled={Boolean(busy)} loading={busy === 'verify'} onPress={() => openSaved('find-dm')} />
            <Button title="Add a group" variant="outline" size="sm" disabled={Boolean(busy)} onPress={() => openSaved('find-group')} />
            <Button title="Send test message" variant="outline" size="sm" disabled={Boolean(busy) || !s.defaultChatId} onPress={() => { setTestResult(null); setStep('test'); sendTest(s.defaultChatId ?? undefined); }} />
            <Button title="Use a different bot" variant="ghost" size="sm" onPress={restart} />
            <Button title="Disconnect" variant="ghost" size="sm" textStyle={{ color: colors.error }} onPress={() => setConfirmDisconnect(true)} />
          </View>
        )}
      </View>
    );
  };

  let content;
  if (step === 'loading') content = <Text style={t.muted}>Checking Telegram…</Text>;
  else if (step === 'summary') content = renderSummary(false);
  else {
    content = (
      <View style={st.gap}>
        <Stepper />
        <Divider />
        {step === 'create' ? renderCreate() : null}
        {step === 'verify' ? renderVerify() : null}
        {step === 'find' ? renderFind() : null}
        {step === 'test' ? renderTest() : null}
        {step === 'done' ? renderSummary(true) : null}
      </View>
    );
  }

  return <Card depth={0} padded={SPACE.md}>{content}</Card>;
}

const st = StyleSheet.create({
  gap: { gap: SPACE.sm },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.sm },
  howRow: { flexDirection: 'row', gap: SPACE.xs },
  stepper: { flexDirection: 'row', gap: SPACE.sm },
  stepDot: { width: 26, height: 26, borderRadius: 13, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  botcard: { flexDirection: 'row', alignItems: 'center', gap: SPACE.md, padding: SPACE.md, borderRadius: RADIUS.md, borderWidth: StyleSheet.hairlineWidth },
  avatar: { width: 44, height: 44, borderRadius: 22 },
  alert: { gap: SPACE.xs, padding: SPACE.md, borderRadius: RADIUS.md, borderWidth: 1 },
  code: { flexDirection: 'row', alignItems: 'center', gap: SPACE.xs, paddingHorizontal: SPACE.md, minHeight: 36, borderRadius: RADIUS.sm, borderWidth: 1 },
  disclosure: { flexDirection: 'row', alignItems: 'center', gap: SPACE.xs, minHeight: 44 },
  found: { flexDirection: 'row', alignItems: 'center', gap: SPACE.md, padding: SPACE.md, borderRadius: RADIUS.md, borderWidth: 1 },
  qrWrap: { alignItems: 'center', gap: SPACE.xs, paddingVertical: SPACE.sm },
  qr: { width: 200, height: 200, borderRadius: RADIUS.sm, backgroundColor: '#fff' },
  kv: { flexDirection: 'row', gap: SPACE.sm, paddingVertical: 2 },
});

export default TelegramSetup;
