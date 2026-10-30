// TrendsScreen — mobile mirror of the <trends-radar> social-insights + news
// intelligence band (content.trends.last30days). Three sections, matching the
// web component's bands:
//   • Trending formats — short-form formats trending across gathered signal
//   • Social insights  — Reddit / HN / community signals, ranked by score
//   • News topics      — clustered trending news relevant to the niche
//
// Tappable cards open the source URL. Renders from the live RPC, the baked
// HTTP snapshot, or a bundled placeholder (see trendsApi.js) so it never blanks
// before a gateway restart.

import React, { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
  RefreshControl,
  Linking,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { COLORS, FONT_FAMILY } from '../../constants/theme';
import { withAlpha, glassGradient, headerGradient, innerTopHighlight } from '../../theme/color-utils';
import { fetchTrends, fmtAgo } from './trendsApi';

const PLATFORM_ICON = {
  reddit: 'logo-reddit',
  hackernews: 'logo-hackernews',
  youtube: 'logo-youtube',
  twitter: 'logo-twitter',
  x: 'logo-twitter',
  tiktok: 'musical-notes',
  instagram: 'logo-instagram',
};

export function TrendsScreen({ gateway, navigation }) {
  const [bundle, setBundle] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (force) => {
    const b = await fetchTrends(gateway, force ? { force: true } : {});
    setBundle(b);
    setLoading(false);
  }, [gateway]);

  useEffect(() => { load(); }, [load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load(true);
    setRefreshing(false);
  }, [load]);

  if (loading) {
    return (
      <SafeAreaView style={styles.container} edges={['left', 'right']}>
        <Header navigation={navigation} bundle={null} />
        <View style={styles.center}>
          <View style={styles.loaderChip}><ActivityIndicator color={COLORS.gold} /></View>
          <Text style={styles.muted}>Gathering trends…</Text>
        </View>
      </SafeAreaView>
    );
  }

  const formats = bundle?.trendingFormats || [];
  const social = [...(bundle?.socialInsights || [])].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const news = bundle?.newsTopics || [];
  const empty = formats.length === 0 && social.length === 0 && news.length === 0;
  const maxFmt = formats[0]?.mentions || Math.max(1, ...formats.map((f) => f.mentions || 0));

  return (
    <SafeAreaView style={styles.container} edges={['left', 'right']}>
      <Header navigation={navigation} bundle={bundle} />
      <ScrollView
        contentContainerStyle={styles.scroll}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={COLORS.gold} />}
      >
        {bundle?.keywords?.length ? (
          <View style={styles.keywordRow}>
            {bundle.keywords.map((k) => (
              <View key={k} style={styles.keyword}><Text style={styles.keywordText}>{k}</Text></View>
            ))}
          </View>
        ) : null}

        {empty ? (
          <View style={styles.emptyBand}>
            <View style={styles.emptyIconChip}>
              <Ionicons name="planet-outline" size={30} color={COLORS.gold} />
            </View>
            <Text style={styles.emptyTitle}>No trend signal yet</Text>
            <Text style={styles.muted}>
              {bundle?.warnings?.[0] || 'Trends activate once content.trends.last30days is live. Pull to refresh after a gateway restart.'}
            </Text>
          </View>
        ) : null}

        {/* Trending formats */}
        {formats.length ? (
          <Section title="Trending formats" icon="trending-up">
            {formats.map((f) => {
              const w = Math.max(6, Math.round(((f.mentions || 0) / maxFmt) * 100));
              return (
                <TouchableOpacity key={f.id || f.label} style={styles.fmtRow} disabled={!f.exampleUrl} onPress={() => f.exampleUrl && Linking.openURL(f.exampleUrl)}>
                  <View style={styles.fmtTop}>
                    <Text style={styles.fmtLabel}>{f.label}</Text>
                    <Text style={styles.fmtMentions}>{f.mentions} mentions</Text>
                  </View>
                  <View style={styles.fmtTrack}>
                    <LinearGradient
                      colors={COLORS.goldGradient}
                      start={{ x: 0, y: 0 }}
                      end={{ x: 1, y: 0 }}
                      style={[styles.fmtFill, { width: `${w}%` }]}
                    />
                  </View>
                  {f.example ? <Text style={styles.fmtExample} numberOfLines={1}>e.g. {f.example}</Text> : null}
                </TouchableOpacity>
              );
            })}
          </Section>
        ) : null}

        {/* Social insights */}
        {social.length ? (
          <Section title="Social insights" icon="chatbubbles">
            {social.map((s) => (
              <TouchableOpacity key={s.id || s.url} style={styles.card} onPress={() => s.url && Linking.openURL(s.url)}>
                <View style={styles.cardHead}>
                  <Ionicons name={PLATFORM_ICON[(s.platform || '').toLowerCase()] || 'globe-outline'} size={14} color={COLORS.gold} />
                  <Text style={styles.cardSource}>{s.community ? `${s.platform} · ${s.community}` : s.platform}</Text>
                  <View style={styles.scoreTag}><Ionicons name="arrow-up" size={10} color={COLORS.gold} /><Text style={styles.scoreTagText}>{s.score ?? 0}</Text></View>
                </View>
                <Text style={styles.cardTitle} numberOfLines={2}>{s.title}</Text>
                {s.summary ? <Text style={styles.cardSummary} numberOfLines={3}>{s.summary}</Text> : null}
                {s.publishedAt ? <Text style={styles.cardMeta}>{fmtAgo(Date.parse(s.publishedAt))}</Text> : null}
              </TouchableOpacity>
            ))}
          </Section>
        ) : null}

        {/* News topics */}
        {news.length ? (
          <Section title="In the news" icon="newspaper">
            {news.map((n) => (
              <TouchableOpacity key={n.id || n.url} style={styles.card} onPress={() => n.url && Linking.openURL(n.url)}>
                <View style={styles.cardHead}>
                  <Ionicons name="newspaper-outline" size={14} color={COLORS.gold} />
                  <Text style={styles.cardSource}>{n.source}</Text>
                  {n.cluster > 1 ? <View style={styles.clusterTag}><Text style={styles.clusterText}>+{n.cluster - 1} related</Text></View> : null}
                </View>
                <Text style={styles.cardTitle} numberOfLines={2}>{n.title}</Text>
                {n.summary ? <Text style={styles.cardSummary} numberOfLines={3}>{n.summary}</Text> : null}
                {n.publishedAt ? <Text style={styles.cardMeta}>{fmtAgo(Date.parse(n.publishedAt))}</Text> : null}
              </TouchableOpacity>
            ))}
          </Section>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

function Header({ navigation, bundle }) {
  return (
    <LinearGradient
      colors={headerGradient(COLORS.gold)}
      start={{ x: 0, y: 0 }}
      end={{ x: 1, y: 1 }}
      style={styles.header}
    >
      <TouchableOpacity onPress={() => navigation?.goBack?.()} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }} style={styles.backBtn}>
        <Ionicons name="arrow-back" size={20} color={COLORS.gold} />
      </TouchableOpacity>
      <View style={{ flex: 1, marginLeft: 12 }}>
        <Text style={styles.title}>Trends &amp; Research</Text>
        <View style={styles.subRow}>
          {bundle?.niche ? <Text style={styles.account}>{bundle.niche}</Text> : null}
          {bundle?.origin === 'live' ? (
            <View style={[styles.srcBadge, styles.srcLive]}><Text style={styles.srcLiveText}>● LIVE</Text></View>
          ) : bundle?.origin ? (
            <View style={[styles.srcBadge, styles.srcSnap]}><Text style={styles.srcSnapText}>SNAPSHOT</Text></View>
          ) : null}
          {bundle?.sourcesConsulted ? <Text style={styles.account}>· {bundle.sourcesConsulted} sources</Text> : null}
        </View>
      </View>
    </LinearGradient>
  );
}

function Section({ title, icon, children }) {
  return (
    <View style={styles.section}>
      <View style={styles.sectionHead}>
        <View style={styles.sectionAccent} />
        <Ionicons name={icon} size={15} color={COLORS.gold} />
        <Text style={styles.sectionTitle}>{title}</Text>
      </View>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.background },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 14 },
  loaderChip: {
    width: 56, height: 56, borderRadius: 28, alignItems: 'center', justifyContent: 'center',
    backgroundColor: withAlpha(COLORS.gold, 0.1), borderWidth: 1, borderColor: withAlpha(COLORS.gold, 0.25),
  },
  muted: { color: COLORS.textMuted, fontFamily: FONT_FAMILY.regular, fontSize: 13, textAlign: 'center', lineHeight: 19 },
  scroll: { padding: 16, paddingBottom: 60 },

  header: {
    flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingTop: 12, paddingBottom: 12,
    borderBottomWidth: 1, borderBottomColor: withAlpha(COLORS.gold, 0.15),
  },
  backBtn: {
    width: 38, height: 38, borderRadius: 12, alignItems: 'center', justifyContent: 'center',
    backgroundColor: withAlpha(COLORS.gold, 0.1), borderWidth: 1, borderColor: withAlpha(COLORS.gold, 0.22),
  },
  title: { color: COLORS.text, fontFamily: FONT_FAMILY.bold, fontSize: 19, letterSpacing: 0.2 },
  subRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 2, flexWrap: 'wrap' },
  account: { color: COLORS.textMuted, fontFamily: FONT_FAMILY.regular, fontSize: 12, textTransform: 'capitalize' },
  srcBadge: { paddingHorizontal: 7, paddingVertical: 2, borderRadius: 999, borderWidth: 1 },
  srcLive: { borderColor: 'rgba(127,214,160,0.4)', backgroundColor: 'rgba(127,214,160,0.12)' },
  srcLiveText: { color: '#7fd6a0', fontFamily: FONT_FAMILY.bold, fontSize: 9, letterSpacing: 0.5 },
  srcSnap: { borderColor: withAlpha(COLORS.gold, 0.4), backgroundColor: withAlpha(COLORS.gold, 0.14) },
  srcSnapText: { color: COLORS.gold, fontFamily: FONT_FAMILY.bold, fontSize: 9, letterSpacing: 0.5 },

  keywordRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 14 },
  keyword: {
    paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999, borderWidth: 1,
    borderColor: withAlpha(COLORS.gold, 0.4), backgroundColor: withAlpha(COLORS.gold, 0.08),
  },
  keywordText: { color: COLORS.goldLight, fontFamily: FONT_FAMILY.medium, fontSize: 12 },

  emptyBand: { alignItems: 'center', gap: 12, paddingVertical: 50, paddingHorizontal: 24 },
  emptyIconChip: {
    width: 68, height: 68, borderRadius: 34, alignItems: 'center', justifyContent: 'center',
    backgroundColor: withAlpha(COLORS.gold, 0.1), borderWidth: 1, borderColor: withAlpha(COLORS.gold, 0.25),
  },
  emptyTitle: { color: COLORS.text, fontFamily: FONT_FAMILY.bold, fontSize: 16 },

  section: { marginBottom: 22 },
  sectionHead: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12 },
  sectionAccent: { width: 3, height: 14, borderRadius: 2, backgroundColor: COLORS.gold },
  sectionTitle: { color: COLORS.gold, fontFamily: FONT_FAMILY.semiBold, fontSize: 11, textTransform: 'uppercase', letterSpacing: 1 },

  fmtRow: {
    padding: 13, borderRadius: 16, borderWidth: 1, borderColor: withAlpha(COLORS.gold, 0.18),
    backgroundColor: 'rgba(14,13,18,0.6)', marginBottom: 10,
    shadowColor: COLORS.gold, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.18, shadowRadius: 14, elevation: 6,
  },
  fmtTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  fmtLabel: { color: COLORS.text, fontFamily: FONT_FAMILY.bold, fontSize: 14 },
  fmtMentions: { color: COLORS.gold, fontFamily: FONT_FAMILY.semiBold, fontSize: 11 },
  fmtTrack: { height: 7, borderRadius: 999, backgroundColor: withAlpha(COLORS.gold, 0.1), overflow: 'hidden', marginTop: 9 },
  fmtFill: { height: '100%', borderRadius: 999, backgroundColor: COLORS.gold },
  fmtExample: { color: COLORS.textMuted, fontFamily: FONT_FAMILY.regular, fontSize: 11, marginTop: 7 },

  card: {
    padding: 14, borderRadius: 16, borderWidth: 1, borderColor: withAlpha(COLORS.gold, 0.18),
    backgroundColor: 'rgba(14,13,18,0.6)', marginBottom: 10,
    shadowColor: COLORS.gold, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.18, shadowRadius: 14, elevation: 6,
  },
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: 7, marginBottom: 7 },
  cardSource: { flex: 1, color: COLORS.textMuted, fontFamily: FONT_FAMILY.semiBold, fontSize: 11, textTransform: 'capitalize' },
  scoreTag: {
    flexDirection: 'row', alignItems: 'center', gap: 2, paddingHorizontal: 7, paddingVertical: 3, borderRadius: 8,
    backgroundColor: withAlpha(COLORS.gold, 0.14), borderWidth: 1, borderColor: withAlpha(COLORS.gold, 0.3),
  },
  scoreTagText: { color: COLORS.gold, fontFamily: FONT_FAMILY.bold, fontSize: 11 },
  clusterTag: {
    paddingHorizontal: 7, paddingVertical: 3, borderRadius: 8,
    backgroundColor: withAlpha(COLORS.gold, 0.12), borderWidth: 1, borderColor: withAlpha(COLORS.gold, 0.28),
  },
  clusterText: { color: COLORS.gold, fontFamily: FONT_FAMILY.semiBold, fontSize: 10 },
  cardTitle: { color: COLORS.text, fontFamily: FONT_FAMILY.semiBold, fontSize: 14, lineHeight: 19 },
  cardSummary: { color: COLORS.textSecondary, fontFamily: FONT_FAMILY.regular, fontSize: 12, lineHeight: 17, marginTop: 5 },
  cardMeta: { color: COLORS.textMuted, fontFamily: FONT_FAMILY.regular, fontSize: 10, marginTop: 7 },
});

export default TrendsScreen;
