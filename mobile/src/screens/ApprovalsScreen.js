/**
 * ApprovalsScreen — pending agent approvals (approvals.list / approvals.resolve,
 * live via approval.requested / approval.resolved). Deep link:
 * infinibot://approvals/<id> opens this with that request expanded, which is
 * what the Telegram card's "Open" button and the approval push land on.
 * Route params: { approvalId? }.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, ScrollView, TouchableOpacity, StyleSheet, RefreshControl, ActivityIndicator, TextInput } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { COLORS } from '../constants/theme';

const GOLD = '#D4AF37';
const RISK = { low: '#4ade80', medium: '#fbbf24', high: '#f97316', critical: '#f87171' };

export function ApprovalsScreen({ navigation, route, gateway }) {
  const insets = useSafeAreaInsets();
  const focusId = route?.params?.approvalId || null;
  const [items, setItems] = useState(null);
  const [focus, setFocus] = useState(null); // the deep-linked record, even if no longer pending
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null);
  const [note, setNote] = useState('');
  const [status, setStatus] = useState('pending');
  const sendReq = gateway?.sendReq;

  const load = useCallback(async () => {
    if (!sendReq) return;
    try {
      const r = await sendReq('approvals.list', { status, limit: 100 });
      setItems(r?.approvals || []);
      setError(null);
      if (focusId) {
        try { setFocus(await sendReq('approvals.get', { id: focusId })); } catch { setFocus(null); }
      }
    } catch (e) {
      setError(e?.message || String(e));
    }
  }, [sendReq, status, focusId]);

  useEffect(() => { if (gateway?.status === 'connected') load(); }, [gateway?.status, load]);
  useEffect(() => {
    if (typeof gateway?.subscribeEvent !== 'function') return undefined;
    const a = gateway.subscribeEvent('approval.requested', load);
    const b = gateway.subscribeEvent('approval.resolved', load);
    return () => { a?.(); b?.(); };
  }, [gateway?.subscribeEvent, load]);

  const resolve = async (id, action) => {
    setBusy(`${id}:${action}`);
    try {
      await sendReq('approvals.resolve', { id, action, note: note.trim() || undefined });
      setNote('');
      await load();
    } catch (e) {
      setError(e?.message || String(e));
    } finally {
      setBusy(null);
    }
  };

  const list = items || [];
  const focused = focus && !list.some((a) => a.id === focus.id) ? [focus, ...list] : list;

  return (
    <View style={[s.root, { paddingTop: insets.top }]}>
      <View style={s.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={s.hBtn} hitSlop={10}>
          <Ionicons name="chevron-back" size={22} color={GOLD} />
        </TouchableOpacity>
        <Text style={s.hTitle}>Approvals</Text>
        <TouchableOpacity onPress={() => setStatus(status === 'pending' ? 'all' : 'pending')} style={s.hBtn} hitSlop={10}>
          <Ionicons name={status === 'pending' ? 'time-outline' : 'list-outline'} size={19} color={GOLD} />
        </TouchableOpacity>
      </View>
      <ScrollView
        contentContainerStyle={{ padding: 14, paddingBottom: insets.bottom + 40, gap: 10 }}
        refreshControl={<RefreshControl refreshing={false} onRefresh={load} tintColor={GOLD} />}
      >
        <Text style={s.caption}>{status === 'pending' ? 'Waiting for you' : 'Recent (all states)'}</Text>
        {error ? <Text style={s.err}>{error}</Text> : null}
        {!items && !error ? <ActivityIndicator color={GOLD} style={{ marginTop: 30 }} /> : null}
        {items && !focused.length ? <Text style={s.empty}>Nothing needs your approval.</Text> : null}
        {focused.map((a) => {
          const pending = a.status === 'pending';
          const open = a.id === focusId || focused.length === 1;
          return (
            <View key={a.id} style={[s.card, a.id === focusId && s.cardFocus]}>
              <View style={s.row}>
                <View style={[s.dot, { backgroundColor: RISK[a.risk] || GOLD }]} />
                <Text style={s.title} numberOfLines={2}>{a.title}</Text>
              </View>
              <Text style={s.meta}>
                {a.requester?.label || a.requester?.agentId || a.source} · {a.risk || 'normal'} risk · {pending ? `expires ${new Date(a.expiresAt).toLocaleTimeString()}` : `${a.status}${a.decidedBy ? ` by ${a.decidedBy}` : ''}`}
              </Text>
              {a.summary ? <Text style={s.summary}>{a.summary}</Text> : null}
              {open && a.details ? <Text style={s.details}>{a.details}</Text> : null}
              {pending ? (
                <>
                  {open ? (
                    <TextInput style={s.note} value={note} onChangeText={setNote} placeholder="Note / redirect instructions (optional)"
                      placeholderTextColor="rgba(255,255,255,0.3)" multiline />
                  ) : null}
                  <View style={s.actions}>
                    {(a.options?.length ? a.options : ['approve', 'deny']).filter((o) => ['approve', 'deny', 'approve-always', 'redirect'].includes(o)).map((o) => (
                      <TouchableOpacity key={o} disabled={Boolean(busy)} onPress={() => resolve(a.id, o)}
                        style={[s.btn, o === 'approve' ? s.btnGo : o === 'deny' ? s.btnNo : s.btnAlt]}>
                        {busy === `${a.id}:${o}` ? <ActivityIndicator color="#000" size="small" /> : (
                          <Text style={[s.btnText, o === 'deny' && { color: '#f87171' }, o !== 'approve' && o !== 'deny' && { color: GOLD }]}>
                            {o === 'approve' ? 'Approve' : o === 'deny' ? 'Deny' : o === 'approve-always' ? 'Always' : 'Redirect'}
                          </Text>
                        )}
                      </TouchableOpacity>
                    ))}
                  </View>
                </>
              ) : null}
            </View>
          );
        })}
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: COLORS.bg || '#070707' },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 10, paddingVertical: 8, gap: 6, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: 'rgba(212,175,55,0.22)' },
  hBtn: { width: 36, height: 36, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.05)' },
  hTitle: { flex: 1, textAlign: 'center', color: '#fff', fontSize: 16, fontWeight: '700' },
  caption: { color: 'rgba(255,255,255,0.45)', fontSize: 11, fontWeight: '700', letterSpacing: 1, textTransform: 'uppercase' },
  err: { color: '#f87171', fontSize: 13 },
  empty: { color: 'rgba(255,255,255,0.45)', textAlign: 'center', marginTop: 40 },
  card: { padding: 14, borderRadius: 14, backgroundColor: 'rgba(14,14,20,0.85)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.06)', gap: 6 },
  cardFocus: { borderColor: 'rgba(212,175,55,0.55)' },
  row: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  dot: { width: 8, height: 8, borderRadius: 4 },
  title: { color: '#fff', fontSize: 15, fontWeight: '700', flex: 1 },
  meta: { color: 'rgba(255,255,255,0.4)', fontSize: 11.5 },
  summary: { color: 'rgba(255,255,255,0.75)', fontSize: 13, lineHeight: 18 },
  details: { color: 'rgba(255,255,255,0.6)', fontSize: 11.5, fontFamily: 'monospace', backgroundColor: 'rgba(0,0,0,0.35)', padding: 10, borderRadius: 8 },
  note: { color: '#fff', minHeight: 40, borderRadius: 10, borderWidth: 1, borderColor: 'rgba(212,175,55,0.2)', padding: 10, fontSize: 13 },
  actions: { flexDirection: 'row', gap: 8, marginTop: 4, flexWrap: 'wrap' },
  btn: { paddingHorizontal: 16, paddingVertical: 10, borderRadius: 10, minWidth: 84, alignItems: 'center' },
  btnGo: { backgroundColor: GOLD },
  btnNo: { borderWidth: 1, borderColor: 'rgba(248,113,113,0.5)' },
  btnAlt: { borderWidth: 1, borderColor: 'rgba(212,175,55,0.4)' },
  btnText: { color: '#000', fontWeight: '800', fontSize: 13 },
});

export default ApprovalsScreen;
