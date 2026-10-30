/**
 * MeshGamificationScreen — phone view of the Agent Neural Mesh gamification
 * layer (XP / levels / ranks / quests / achievements / leaderboard).
 *
 * Server-authoritative: every value comes from the gateway. Polls
 * `mesh.gamification.state` + `mesh.gamification.leaderboard` on an interval
 * (real-time-ish parity with the web card) and surfaces an unlock banner the
 * first time a new achievement id appears.
 *
 * Layout (top → bottom):
 *   • Rank badge + level + XP-to-next progress bar
 *   • Active quests (daily/weekly) with progress bars
 *   • Achievements grid (recent unlocks)
 *   • Federation leaderboard (agent vs agent across nodes)
 *
 * Mirrors the web rank/level helpers so it renders without extra round-trips.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  RefreshControl,
  TouchableOpacity,
  ActivityIndicator,
  Animated,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../theme/ThemeProvider';
import { FONT_FAMILY, SPACING } from '../constants/theme';

const POLL_MS = 8000;

const RANKS = [
  { key: 'recruit', label: 'Recruit', color: '#8b95a7', minLevel: 1 },
  { key: 'operator', label: 'Operator', color: '#4ea8de', minLevel: 3 },
  { key: 'specialist', label: 'Specialist', color: '#39d98a', minLevel: 6 },
  { key: 'veteran', label: 'Veteran', color: '#d4af37', minLevel: 10 },
  { key: 'elite', label: 'Elite', color: '#ff8c42', minLevel: 15 },
  { key: 'legend', label: 'Legend', color: '#b06bff', minLevel: 25 },
];

function rankForLevel(level) {
  let rank = RANKS[0];
  for (const r of RANKS) if (level >= r.minLevel) rank = r;
  return rank;
}

export function MeshGamificationScreen({ gateway, ownerId: ownerIdProp }) {
  // Progression is tracked per agent. The old default, 'global', is not an
  // owner the gateway knows, so the card showed "Recruit · 0 XP" for everyone.
  const ownerId = ownerIdProp || gateway?.chat?.defaultAgentId || 'main';
  const { colors } = useTheme();
  const [state, setState] = useState(null);
  const [leaderboard, setLeaderboard] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [banner, setBanner] = useState(null);
  const seenRef = useRef(new Set());
  const primedRef = useRef(false);
  const bannerAnim = useRef(new Animated.Value(0)).current;

  const sendReq = gateway?.sendReq;

  const showBanner = useCallback(
    (unlock) => {
      setBanner(unlock);
      bannerAnim.setValue(0);
      Animated.sequence([
        Animated.timing(bannerAnim, { toValue: 1, duration: 280, useNativeDriver: true }),
        Animated.delay(3200),
        Animated.timing(bannerAnim, { toValue: 0, duration: 280, useNativeDriver: true }),
      ]).start(() => setBanner(null));
    },
    [bannerAnim],
  );

  const load = useCallback(async () => {
    if (!sendReq) return;
    // Independent calls: the federation leaderboard fans out to other nodes and
    // can be slow, so it must never hold back the local progression card.
    const statePromise = sendReq('mesh.gamification.state', { ownerId })
      .then((res) => {
        if (res && res.progression) {
          if (!res.progression.rank) res.progression.rank = rankForLevel(res.progression.level || 1);
          // Detect fresh unlocks (skip the priming pass so history isn't replayed).
          for (const u of res.recentUnlocks || []) {
            if (seenRef.current.has(u.id)) continue;
            seenRef.current.add(u.id);
            if (primedRef.current) showBanner(u);
          }
          primedRef.current = true;
          setState(res);
        }
        setError(null);
      })
      .catch((e) => {
        setError(e?.message || String(e));
      })
      .finally(() => setLoading(false));
    const lbPromise = sendReq('mesh.gamification.leaderboard', { scope: 'federation', limit: 20 })
      .then((lb) => {
        if (lb && Array.isArray(lb.entries)) setLeaderboard(lb.entries);
      })
      .catch(() => {
        /* optional section — keeps the last good list */
      });
    await Promise.all([statePromise, lbPromise]);
  }, [sendReq, ownerId, showBanner]);

  useEffect(() => {
    load();
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  const prog = state?.progression;
  const quests = state?.quests || [];
  const unlocks = state?.recentUnlocks || [];
  const pct = prog ? Math.min(100, Math.round((prog.xpIntoLevel / prog.xpForNextLevel) * 100)) : 0;
  const rank = prog?.rank || rankForLevel(prog?.level || 1);

  const styles = useMemo(() => makeStyles(colors), [colors]);

  if (loading && !state) {
    return (
      <View style={[styles.screen, styles.center]}>
        <ActivityIndicator color={colors.accent || '#d4af37'} />
        <Text style={styles.dim}>Loading progression…</Text>
      </View>
    );
  }

  if (error && !state) {
    return (
      <View style={[styles.screen, styles.center]}>
        <Ionicons name="alert-circle-outline" size={32} color={colors.error || '#ef4444'} />
        <Text style={styles.empty}>Could not load progression</Text>
        <Text style={styles.dim}>{error}</Text>
        <TouchableOpacity
          style={styles.retryBtn}
          onPress={() => {
            setLoading(true);
            load();
          }}
        >
          <Ionicons name="refresh" size={14} color={colors.accent || '#d4af37'} />
          <Text style={styles.retryText}>Retry</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      {banner ? (
        <Animated.View
          style={[
            styles.banner,
            {
              opacity: bannerAnim,
              transform: [
                { translateY: bannerAnim.interpolate({ inputRange: [0, 1], outputRange: [-40, 0] }) },
              ],
            },
          ]}
        >
          {banner.def?.icon ? (
            <Text style={styles.bannerIcon}>{banner.def.icon}</Text>
          ) : (
            <Ionicons name="trophy-outline" size={24} color={colors.accent || '#d4af37'} />
          )}
          <View style={{ flex: 1 }}>
            <Text style={styles.bannerTitle}>Achievement Unlocked</Text>
            <Text style={styles.bannerSub}>{banner.def?.label || banner.kind}</Text>
          </View>
        </Animated.View>
      ) : null}

      <ScrollView
        contentContainerStyle={{ padding: SPACING.md, paddingBottom: 48 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.accent} />}
      >
        {/* Rank + XP */}
        <View style={styles.card}>
          <View style={styles.rankRow}>
            <View style={[styles.badge, { backgroundColor: rank.color }]}>
              <Text style={styles.badgeLvl}>L{prog?.level ?? 1}</Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.rankName}>{rank.label}</Text>
              <Text style={styles.dim}>
                {(prog?.xp ?? 0).toLocaleString()} XP · {prog?.xpIntoLevel ?? 0}/{prog?.xpForNextLevel ?? 1} to next
              </Text>
              <View style={styles.xpbar}>
                <View style={[styles.xpfill, { width: `${pct}%` }]} />
              </View>
            </View>
          </View>
          <View style={styles.statsRow}>
            <Stat label="Tasks" value={prog?.tasks ?? 0} styles={styles} />
            <Stat label="Tools" value={prog?.tools ?? 0} styles={styles} />
            <Stat label="Handshakes" value={prog?.handshakes ?? 0} styles={styles} />
          </View>
        </View>

        {/* Quests */}
        <Text style={styles.sectionT}>Active Quests</Text>
        <View style={styles.card}>
          {quests.length ? (
            quests.map((q) => {
              const done = q.completedAt != null;
              const qp = Math.min(100, Math.round((q.progress / q.target) * 100));
              return (
                <View key={q.id} style={styles.quest}>
                  {q.def?.icon ? (
                    <Text style={styles.questIco}>{q.def.icon}</Text>
                  ) : (
                    <Ionicons name="flag-outline" size={18} color={colors.accent || '#d4af37'} />
                  )}
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.questLabel, done && { color: '#39d98a' }]}>
                      {q.def?.label || q.defKind} {done ? <Ionicons name="checkmark" size={13} color="#39d98a" /> : null}
                    </Text>
                    <View style={styles.qbar}>
                      <View style={[styles.qfill, { width: `${qp}%` }]} />
                    </View>
                  </View>
                  <Text style={styles.dim}>{q.progress}/{q.target}</Text>
                </View>
              );
            })
          ) : (
            <Text style={styles.empty}>No quests yet</Text>
          )}
        </View>

        {/* Achievements */}
        <Text style={styles.sectionT}>Achievements</Text>
        <View style={[styles.card, styles.grid]}>
          {unlocks.length ? (
            unlocks.map((u) => (
              <View key={u.id} style={styles.achv}>
                {u.def?.icon ? (
                  <Text style={styles.achvIco}>{u.def.icon}</Text>
                ) : (
                  <Ionicons name="trophy-outline" size={22} color={colors.accent || '#d4af37'} />
                )}
                <Text style={styles.achvLabel} numberOfLines={1}>
                  {u.def?.label || u.kind}
                </Text>
              </View>
            ))
          ) : (
            <Text style={styles.empty}>No achievements yet</Text>
          )}
        </View>

        {/* Leaderboard */}
        <Text style={styles.sectionT}>Federation Leaderboard</Text>
        <View style={styles.card}>
          {leaderboard.length ? (
            leaderboard.slice(0, 12).map((e, i) => (
              <View key={`${e.nodeId}:${e.ownerId}`} style={styles.lbRow}>
                <Text style={styles.lbPos}>{i + 1}</Text>
                <View style={{ flex: 1 }}>
                  <Text style={styles.lbWho} numberOfLines={1}>{e.ownerId}</Text>
                  <Text style={styles.lbNode}>{e.nodeName}</Text>
                </View>
                <Text style={styles.lbXp}>{(e.xp || 0).toLocaleString()}</Text>
              </View>
            ))
          ) : (
            <Text style={styles.empty}>No ranked agents yet</Text>
          )}
        </View>
      </ScrollView>
    </View>
  );
}

function Stat({ label, value, styles }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

function makeStyles(colors) {
  const bg = colors.background || '#0a0c14';
  const panel = colors.surface || 'rgba(255,255,255,0.04)';
  const text = colors.text || '#eef1f8';
  const dim = colors.textSecondary || '#8b95a7';
  const accent = colors.accent || '#d4af37';
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: bg },
    center: { alignItems: 'center', justifyContent: 'center', gap: 10 },
    // fontFamily must be a string: FONTS.regular is a whole preset object and
    // crashes react-native-web's style resolver (fontFamily.indexOf).
    dim: { color: dim, fontSize: 12, fontFamily: FONT_FAMILY.regular },
    retryBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      paddingHorizontal: 14,
      paddingVertical: 8,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: accent,
    },
    retryText: { color: accent, fontSize: 13, fontWeight: '600' },
    empty: { color: dim, fontStyle: 'italic', fontSize: 12 },
    card: {
      backgroundColor: panel,
      borderRadius: 14,
      borderWidth: 1,
      borderColor: 'rgba(212,175,55,0.22)',
      padding: 14,
      marginBottom: 14,
    },
    rankRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
    badge: { width: 50, height: 50, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
    badgeLvl: { color: '#0b0d14', fontWeight: '800', fontSize: 14 },
    rankName: { color: text, fontWeight: '700', fontSize: 16 },
    xpbar: { height: 7, borderRadius: 4, backgroundColor: 'rgba(255,255,255,0.08)', marginTop: 6, overflow: 'hidden' },
    xpfill: { height: '100%', backgroundColor: accent },
    statsRow: { flexDirection: 'row', justifyContent: 'space-around', marginTop: 14 },
    stat: { alignItems: 'center' },
    statValue: { color: text, fontWeight: '800', fontSize: 18 },
    statLabel: { color: dim, fontSize: 10, textTransform: 'uppercase', letterSpacing: 1 },
    sectionT: {
      color: dim,
      fontSize: 11,
      fontWeight: '700',
      letterSpacing: 1.4,
      textTransform: 'uppercase',
      marginBottom: 8,
      marginTop: 4,
    },
    quest: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 10 },
    questIco: { fontSize: 18 },
    questLabel: { color: text, fontWeight: '600', fontSize: 13 },
    qbar: { height: 5, borderRadius: 3, backgroundColor: 'rgba(255,255,255,0.07)', marginTop: 4, overflow: 'hidden' },
    qfill: { height: '100%', backgroundColor: '#39d98a' },
    grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
    achv: { width: 76, alignItems: 'center', paddingVertical: 8 },
    achvIco: { fontSize: 26 },
    achvLabel: { color: dim, fontSize: 10, textAlign: 'center', marginTop: 4 },
    lbRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.05)' },
    lbPos: { color: dim, fontWeight: '800', width: 22 },
    lbWho: { color: text, fontWeight: '600', fontSize: 13 },
    lbNode: { color: dim, fontSize: 10 },
    lbXp: { color: accent, fontWeight: '800' },
    banner: {
      position: 'absolute',
      top: 8,
      left: 12,
      right: 12,
      zIndex: 20,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      padding: 14,
      borderRadius: 14,
      backgroundColor: 'rgba(16,18,28,0.96)',
      borderWidth: 1,
      borderColor: 'rgba(212,175,55,0.5)',
    },
    bannerIcon: { fontSize: 26 },
    bannerTitle: { color: accent, fontWeight: '800', fontSize: 11, letterSpacing: 1, textTransform: 'uppercase' },
    bannerSub: { color: text, fontWeight: '700', fontSize: 15 },
  });
}

export default MeshGamificationScreen;
