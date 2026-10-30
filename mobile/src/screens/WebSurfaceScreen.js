// WebSurfaceScreen — full-screen host for any web control-UI route, embedded in
// an authed WebView. Backs the "WebView parity" agency surfaces that don't yet
// have a hand-built native screen (Agency Operations, Topology, Daily, Comms,
// Inbox, Products, Vault, Reviews, Workspace, Knowledge Graph, Systems,
// Whiteboard). Route params: { path, title }.

import React, { useRef } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, StatusBar } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { COLORS } from '../constants/theme';
import { WebSurface } from '../lib/web-surface';

export default function WebSurfaceScreen({ route, navigation }) {
  const { path = '/dashboard', title = 'InfiniBot', embed = false, accent = null } = route?.params || {};
  const insets = useSafeAreaInsets();
  const webRef = useRef(null);

  return (
    <View style={styles.root}>
      <StatusBar barStyle="light-content" />
      <View style={[styles.header, { paddingTop: insets.top + 6 }, accent ? { borderBottomColor: accent } : null]}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.hBtn} hitSlop={10}>
          <Ionicons name="chevron-back" size={22} color={COLORS.primary} />
        </TouchableOpacity>
        <Text style={styles.hTitle} numberOfLines={1}>{title}</Text>
        <TouchableOpacity onPress={() => webRef.current?.reload()} style={styles.hBtn} hitSlop={10}>
          <Ionicons name="refresh" size={19} color={COLORS.primary} />
        </TouchableOpacity>
      </View>
      {/* Plugin pages open chromeless (?embed=1): the native header above is
          the only chrome, like any native screen. */}
      <WebSurface path={path} embed={embed} webviewRef={webRef} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: COLORS.bg },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingBottom: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(212,175,55,0.22)',
    backgroundColor: COLORS.surface,
    gap: 6,
  },
  hBtn: {
    width: 36, height: 36, borderRadius: 10,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.05)',
  },
  hTitle: {
    flex: 1, textAlign: 'center',
    color: COLORS.text, fontSize: 15, fontWeight: '700',
    letterSpacing: 0.3,
  },
});
