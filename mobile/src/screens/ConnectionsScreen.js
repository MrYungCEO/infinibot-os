/**
 * ConnectionsScreen — saved connection profiles (InfiniBot Cloud and any
 * number of self-hosted gateways). Switch the active one, remove one, or add a
 * new one through the chooser. Switching reconnects the app in place.
 * Every card has labelled Edit and Delete buttons (self-hosted profiles open
 * the chooser prefilled, so a stale password is fixed in place). Delete asks
 * for a second tap inline — Alert.alert has no buttons on the web export.
 * Props: gateway (useGateway()), onAddConnection(), onEditConnection(profile).
 */
import React, { useEffect, useState } from 'react';
import { View, Text, ScrollView, TouchableOpacity, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { COLORS } from '../constants/theme';
import {
  listProfiles, getActiveProfile, activateProfile, removeProfile, subscribeProfiles,
} from '../connection/profile-store';
import { describeProfile, PROFILE_KINDS } from '../connection/connection-logic';
import { useCloudSignOut } from '../connection/CloudAuth';

const GOLD = '#D4AF37';

export function ConnectionsScreen({ navigation, gateway, onAddConnection, onEditConnection }) {
  const insets = useSafeAreaInsets();
  const [profiles, setProfiles] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [confirmId, setConfirmId] = useState(null);
  const cloudSignOut = useCloudSignOut();

  const refresh = async () => {
    setProfiles(await listProfiles());
    setActiveId((await getActiveProfile())?.id || null);
  };
  useEffect(() => {
    refresh();
    return subscribeProfiles(refresh);
  }, []);

  const switchTo = async (p) => {
    if (p.id === activeId) return;
    await activateProfile(p.id);
    gateway?.connect?.();
    navigation.goBack();
  };

  const remove = async (p) => {
    if (confirmId !== p.id) { setConfirmId(p.id); return; }
    setConfirmId(null);
    if (p.kind === PROFILE_KINDS.CLOUD) await cloudSignOut().catch(() => {});
    await removeProfile(p.id);
  };

  return (
    <View style={[s.root, { paddingTop: insets.top }]}>
      <View style={s.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={s.hBtn} hitSlop={10}>
          <Ionicons name="chevron-back" size={22} color={GOLD} />
        </TouchableOpacity>
        <Text style={s.hTitle}>Connections</Text>
        <View style={s.hBtn} />
      </View>
      <ScrollView contentContainerStyle={{ padding: 14, gap: 10, paddingBottom: insets.bottom + 40 }}>
        {profiles.map((p) => {
          const on = p.id === activeId;
          return (
            <View key={p.id} style={[s.card, on && s.cardOn]} testID={`conn-card-${p.id}`}>
              <TouchableOpacity onPress={() => switchTo(p)} activeOpacity={0.8} style={s.cardMain}
                accessibilityRole="button" accessibilityLabel={on ? `${p.label} (active)` : `Switch to ${p.label}`}>
                <Ionicons name={p.kind === PROFILE_KINDS.CLOUD ? 'cloud-outline' : 'server-outline'} size={22} color={on ? GOLD : 'rgba(255,255,255,0.6)'} />
                <View style={{ flex: 1 }}>
                  <Text style={s.name}>{p.label}</Text>
                  <Text style={s.desc}>{describeProfile(p)}</Text>
                  {on ? (
                    <Text style={[s.status, gateway?.authFailure && s.statusBad]}>
                      {gateway?.authFailure ? 'Credential rejected — tap Edit' : gateway?.status === 'connected' ? 'Connected' : gateway?.status || ''}
                    </Text>
                  ) : null}
                </View>
                {on ? <Ionicons name="checkmark-circle" size={20} color={GOLD} /> : null}
              </TouchableOpacity>
              <View style={s.cardActions}>
                {p.kind === PROFILE_KINDS.SELF_HOSTED && onEditConnection ? (
                  <TouchableOpacity onPress={() => onEditConnection(p)} style={s.actBtn} testID={`conn-edit-${p.id}`}
                    accessibilityRole="button" accessibilityLabel={`Edit ${p.label}`}>
                    <Ionicons name="create-outline" size={15} color={GOLD} />
                    <Text style={s.actText}>Edit</Text>
                  </TouchableOpacity>
                ) : null}
                <TouchableOpacity onPress={() => remove(p)} style={[s.actBtn, s.actDanger, confirmId === p.id && s.actDangerOn]}
                  testID={`conn-delete-${p.id}`} accessibilityRole="button"
                  accessibilityLabel={confirmId === p.id ? `Confirm delete ${p.label}` : `Delete ${p.label}`}>
                  <Ionicons name="trash-outline" size={15} color="#f87171" />
                  <Text style={[s.actText, { color: '#f87171' }]}>{confirmId === p.id ? 'Tap again to delete' : 'Delete'}</Text>
                </TouchableOpacity>
              </View>
            </View>
          );
        })}
        <TouchableOpacity style={s.add} onPress={onAddConnection}>
          <Ionicons name="add" size={18} color="#000" />
          <Text style={s.addText}>Add connection</Text>
        </TouchableOpacity>
        <Text style={s.hint}>Tap a connection to switch. Edit fixes its address or password in place. Each connection keeps its own credentials; cloud connections use your InfiniBot account sign-in.</Text>
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: COLORS.bg || '#070707' },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 10, paddingVertical: 8, gap: 6, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: 'rgba(212,175,55,0.22)' },
  hBtn: { width: 36, height: 36, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.05)' },
  hTitle: { flex: 1, textAlign: 'center', color: '#fff', fontSize: 16, fontWeight: '700' },
  card: { padding: 14, borderRadius: 14, backgroundColor: 'rgba(14,14,20,0.85)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.06)', gap: 12 },
  cardMain: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  cardActions: { flexDirection: 'row', gap: 8, justifyContent: 'flex-end' },
  actBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 36, paddingHorizontal: 12, borderRadius: 10,
    borderWidth: 1, borderColor: 'rgba(212,175,55,0.35)',
  },
  actText: { color: GOLD, fontSize: 13, fontWeight: '700' },
  actDanger: { borderColor: 'rgba(248,113,113,0.35)' },
  actDangerOn: { backgroundColor: 'rgba(248,113,113,0.14)', borderColor: '#f87171' },
  statusBad: { color: '#f87171' },
  cardOn: { borderColor: 'rgba(212,175,55,0.5)' },
  name: { color: '#fff', fontSize: 15, fontWeight: '700' },
  desc: { color: 'rgba(255,255,255,0.5)', fontSize: 12, marginTop: 2 },
  status: { color: GOLD, fontSize: 11, marginTop: 4, fontWeight: '700' },
  add: { flexDirection: 'row', gap: 6, alignItems: 'center', justifyContent: 'center', backgroundColor: GOLD, borderRadius: 12, paddingVertical: 13, marginTop: 6 },
  addText: { color: '#000', fontWeight: '800' },
  hint: { color: 'rgba(255,255,255,0.35)', fontSize: 12, textAlign: 'center', marginTop: 8, lineHeight: 17 },
});

export default ConnectionsScreen;
