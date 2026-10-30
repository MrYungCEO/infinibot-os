/**
 * PluginsScreen — the mobile Plugins page (web: Setup › Plugins).
 *
 * Browse listing cards (icon/monogram, tagline, category, health), open a
 * plugin's pages, inspect what it adds and what it is allowed to do, and turn
 * it on/off. Turning a plugin on/off restarts the gateway (same RPC and same
 * confirmation copy as the web page); only owner/admin connections can do it —
 * `plugins.*` needs operator.admin, so a connection without it gets a
 * read-only list.
 *
 * Route params: { pluginId?, reason?: 'disabled'|'unknown' } — a deep link to
 * a plugin page that is off lands here with that plugin expanded.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet, Switch, Alert, Image, RefreshControl, ActivityIndicator,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { COLORS } from '../constants/theme';
import { usePlugins, refreshPlugins, setPluginEnabled } from '../plugins/plugin-store';
import { derivePluginSections, accentFor, monogramFor, isPluginActive } from '../plugins/plugin-nav';
import { navigateToScreen } from '../navigation/screen-registry';
import { getGatewayUrl, getGatewayAuthHeaders } from '../utils/storage';
import { gatewayHttpOrigin } from '../utils/gatewayHost';

const GOLD = '#D4AF37';

function useAssetAuth() {
  const [cfg, setCfg] = useState({ origin: '', headers: {} });
  useEffect(() => {
    (async () => setCfg({ origin: gatewayHttpOrigin(await getGatewayUrl()), headers: await getGatewayAuthHeaders() }))();
  }, []);
  return cfg;
}

function assetSource(src, cfg) {
  if (!src || typeof src !== 'string') return null;
  if (src.startsWith('data:')) return src.startsWith('data:image/svg') ? null : { uri: src };
  if (/\.svg($|\?)/i.test(src)) return null; // RN Image can't draw SVG; monogram instead
  const uri = /^https?:/i.test(src) ? src : `${cfg.origin}${src.startsWith('/') ? '' : '/'}${src}`;
  return cfg.origin ? { uri, headers: cfg.headers } : null;
}

export function PluginsScreen({ navigation, route, gateway }) {
  const insets = useSafeAreaInsets();
  const focusId = route?.params?.pluginId || null;
  const reason = route?.params?.reason || null;
  const { list, error, loading, applying } = usePlugins();
  const [expanded, setExpanded] = useState(focusId);
  const [filter, setFilter] = useState('all'); // all | on | off
  const cfg = useAssetAuth();
  const sendReq = gateway?.sendReq;
  const readOnly = error === 'scope';

  const reload = useCallback(() => refreshPlugins(sendReq), [sendReq]);
  useEffect(() => { if (gateway?.status === 'connected') reload(); }, [gateway?.status]);

  const sections = useMemo(() => (list ? derivePluginSections(list) : []), [list]);
  const plugins = useMemo(() => {
    const all = (list?.plugins || []).slice().sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id));
    return all.filter((p) => (filter === 'on' ? p.enabled : filter === 'off' ? !p.enabled : true));
  }, [list, filter]);

  const confirmToggle = async (p, next) => {
    let running = 0;
    try {
      const r = await sendReq('subagents.list', { compact: true, limit: 100 });
      running = (r?.subagents || r?.runs || []).filter((x) => x.status === 'running' || x.state === 'running').length;
    } catch {}
    const verb = next ? 'on' : 'off';
    Alert.alert(
      `Turn ${verb} ${p.name}?`,
      `Turning a plugin ${verb} restarts the gateway so it can ${next ? 'load' : 'unload'} the plugin's code. Open connections reconnect automatically (a few seconds).` +
        (running ? `\n\n${running} sub-agent${running === 1 ? ' is' : 's are'} running. The restart stops ${running === 1 ? 'it' : 'them'}.` : ''),
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: `Turn ${verb} & restart`,
          style: next ? 'default' : 'destructive',
          onPress: async () => {
            try {
              const after = await setPluginEnabled(sendReq, p.id, next);
              if (after?.status === 'error') Alert.alert(p.name, after.error || 'The plugin failed to load.');
            } catch (e) {
              Alert.alert(p.name, e?.message || 'Could not change the plugin.');
            }
          },
        },
      ],
    );
  };

  const openPlugin = (p) => {
    const sec = sections.find((x) => x.pluginId === p.id);
    const first = sec?.items?.[0];
    if (!first) return;
    navigateToScreen(navigation, first, { gateway });
  };

  return (
    <View style={[s.root, { paddingTop: insets.top }]}>
      <View style={s.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={s.hBtn} hitSlop={10}>
          <Ionicons name="chevron-back" size={22} color={GOLD} />
        </TouchableOpacity>
        <Text style={s.hTitle}>Plugins</Text>
        <TouchableOpacity onPress={reload} style={s.hBtn} hitSlop={10}>
          <Ionicons name="refresh" size={19} color={GOLD} />
        </TouchableOpacity>
      </View>
      <View style={s.filters}>
        {['all', 'on', 'off'].map((f) => (
          <TouchableOpacity key={f} onPress={() => setFilter(f)} style={[s.chip, filter === f && s.chipOn]}>
            <Text style={[s.chipText, filter === f && s.chipTextOn]}>{f === 'all' ? 'All' : f === 'on' ? 'On' : 'Off'}</Text>
          </TouchableOpacity>
        ))}
      </View>
      <ScrollView
        contentContainerStyle={{ padding: 14, paddingBottom: insets.bottom + 40, gap: 10 }}
        refreshControl={<RefreshControl refreshing={Boolean(loading)} onRefresh={reload} tintColor={GOLD} />}
      >
        {reason === 'disabled' && focusId ? (
          <Banner icon="power-outline" text={`That link opens ${focusId}, which is turned off on this gateway.`} />
        ) : null}
        {reason === 'unknown' && focusId ? (
          <Banner icon="help-circle-outline" text={`This gateway has no plugin called "${focusId}".`} />
        ) : null}
        {readOnly ? <Banner icon="lock-closed-outline" text="Only the owner or an admin can manage plugins. You are seeing a read-only list." /> : null}
        {applying ? <Banner icon="sync-outline" text="Applying — the gateway is restarting to load plugins…" spin /> : null}
        {!list && !error ? <ActivityIndicator color={GOLD} style={{ marginTop: 40 }} /> : null}
        {error && error !== 'scope' ? <Banner icon="warning-outline" text={error} /> : null}
        {plugins.map((p) => (
          <PluginCard
            key={p.id}
            p={p}
            cfg={cfg}
            expanded={expanded === p.id}
            onToggleExpand={() => setExpanded(expanded === p.id ? null : p.id)}
            onToggle={(next) => confirmToggle(p, next)}
            onOpen={() => openPlugin(p)}
            canOpen={Boolean(sections.find((x) => x.pluginId === p.id))}
            readOnly={readOnly || Boolean(applying)}
          />
        ))}
      </ScrollView>
    </View>
  );
}

function Banner({ icon, text }) {
  return (
    <View style={s.banner}>
      <Ionicons name={icon} size={16} color={GOLD} />
      <Text style={s.bannerText}>{text}</Text>
    </View>
  );
}

function PluginCard({ p, cfg, expanded, onToggleExpand, onToggle, onOpen, canOpen, readOnly }) {
  const accent = accentFor(p) || GOLD;
  const icon = assetSource(p.listing?.icon, cfg);
  const active = isPluginActive(p);
  const health = p.status === 'error' ? { t: 'Error', c: '#f87171' }
    : !p.enabled ? { t: 'Off', c: 'rgba(255,255,255,0.4)' }
    : p.health?.state === 'degraded' ? { t: 'Degraded', c: '#fbbf24' }
    : p.setup?.needed ? { t: 'Needs setup', c: '#fbbf24' }
    : { t: 'On', c: '#4ade80' };
  const perms = p.permissions || {};
  const pages = p.contributes?.pages || [];
  return (
    <View style={[s.card, { borderLeftColor: accent }]}>
      <TouchableOpacity style={s.cardTop} onPress={onToggleExpand} activeOpacity={0.8}>
        {icon ? (
          <Image source={icon} style={s.icon} />
        ) : (
          <View style={[s.mono, { borderColor: accent }]}>
            <Text style={[s.monoText, { color: accent }]}>{String(p.appearance?.monogram || monogramFor(p.name)).slice(0, 3)}</Text>
          </View>
        )}
        <View style={{ flex: 1 }}>
          <Text style={s.name}>{p.name}</Text>
          <Text style={s.tagline} numberOfLines={2}>{p.listing?.tagline || p.description || p.id}</Text>
          <View style={s.metaRow}>
            <Text style={[s.status, { color: health.c }]}>{health.t}</Text>
            <Text style={s.meta}>{(p.listing?.category || p.category || '').toString()}</Text>
            {p.tier ? <Text style={s.meta}>{p.tier}</Text> : null}
            <Text style={s.meta}>v{p.version}</Text>
          </View>
        </View>
        <Switch
          value={Boolean(p.enabled)}
          onValueChange={onToggle}
          disabled={readOnly}
          trackColor={{ true: 'rgba(212,175,55,0.55)', false: 'rgba(255,255,255,0.15)' }}
          thumbColor={p.enabled ? GOLD : '#888'}
        />
      </TouchableOpacity>
      {expanded ? (
        <View style={s.details}>
          {p.error ? <Text style={s.err}>{p.error}</Text> : null}
          {active && canOpen ? (
            <TouchableOpacity style={s.openBtn} onPress={onOpen}>
              <Ionicons name="open-outline" size={15} color="#000" />
              <Text style={s.openText}>Open {p.name}</Text>
            </TouchableOpacity>
          ) : null}
          <Text style={s.dh}>What it adds</Text>
          {pages.length ? pages.map((pg) => (
            <Text key={pg.tab} style={s.dl}>Page · {pg.title || pg.tab} <Text style={s.dim}>{pg.route}</Text></Text>
          )) : <Text style={s.dim}>No pages</Text>}
          {(p.contributes?.tools || []).length ? <Text style={s.dl}>Agent tools · {(p.contributes.tools || []).map((t) => t.name || t).join(', ')}</Text> : null}
          {(p.contributes?.topbarSlots || []).length ? <Text style={s.dl}>Top-bar · {(p.contributes.topbarSlots || []).map((t) => t.label).join(', ')}</Text> : null}
          <Text style={s.dh}>Permissions</Text>
          <Perm label="Network" v={(perms.network || []).join(', ')} />
          <Perm label="Files" v={(perms.fs || []).join(', ')} />
          <Perm label="Run programs" v={perms.exec ? 'Yes' : ''} />
          <Perm label="Secrets" v={(perms.secrets || []).join(', ')} />
          <Perm label="Channels" v={(perms.channels || []).join(', ')} />
          <Perm label="Spends credits" v={perms.credits ? 'Yes' : ''} />
          <Perm label="Health data (PHI)" v={perms.phi ? 'Yes' : ''} />
          {(perms.gated || []).map((g) => <Perm key={g.id} label={g.label} v={g.description || 'Ask first'} gated />)}
          {!Object.keys(perms).length ? <Text style={s.dim}>Declares no special permissions.</Text> : null}
          <Text style={s.dim}>Change permissions and settings in the web UI (Setup › Plugins).</Text>
        </View>
      ) : null}
    </View>
  );
}

function Perm({ label, v, gated }) {
  if (!v) return null;
  return (
    <View style={s.permRow}>
      <Ionicons name={gated ? 'hand-left-outline' : 'checkmark-circle-outline'} size={13} color={gated ? '#fbbf24' : 'rgba(212,175,55,0.8)'} />
      <Text style={s.permLabel}>{label}</Text>
      <Text style={s.permVal} numberOfLines={2}>{v}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: COLORS.bg || '#070707' },
  header: {
    flexDirection: 'row', alignItems: 'center', paddingHorizontal: 10, paddingVertical: 8, gap: 6,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: 'rgba(212,175,55,0.22)',
  },
  hBtn: { width: 36, height: 36, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.05)' },
  hTitle: { flex: 1, textAlign: 'center', color: '#fff', fontSize: 16, fontWeight: '700' },
  filters: { flexDirection: 'row', gap: 8, paddingHorizontal: 14, paddingTop: 10 },
  chip: { paddingHorizontal: 14, paddingVertical: 6, borderRadius: 999, borderWidth: 1, borderColor: 'rgba(212,175,55,0.25)' },
  chipOn: { backgroundColor: 'rgba(212,175,55,0.18)' },
  chipText: { color: 'rgba(255,255,255,0.6)', fontSize: 12, fontWeight: '600' },
  chipTextOn: { color: GOLD },
  banner: { flexDirection: 'row', gap: 8, alignItems: 'center', padding: 12, borderRadius: 12, backgroundColor: 'rgba(212,175,55,0.08)', borderWidth: 1, borderColor: 'rgba(212,175,55,0.25)' },
  bannerText: { color: 'rgba(255,255,255,0.8)', fontSize: 12.5, flex: 1, lineHeight: 17 },
  card: { borderRadius: 14, backgroundColor: 'rgba(14,14,20,0.85)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.06)', borderLeftWidth: 3, overflow: 'hidden' },
  cardTop: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14 },
  icon: { width: 44, height: 44, borderRadius: 11 },
  mono: { width: 44, height: 44, borderRadius: 11, borderWidth: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.03)' },
  monoText: { fontWeight: '800', fontSize: 14, letterSpacing: 0.5 },
  name: { color: '#fff', fontSize: 15, fontWeight: '700' },
  tagline: { color: 'rgba(255,255,255,0.5)', fontSize: 12, marginTop: 2, lineHeight: 16 },
  metaRow: { flexDirection: 'row', gap: 10, marginTop: 6, flexWrap: 'wrap' },
  status: { fontSize: 11, fontWeight: '700' },
  meta: { color: 'rgba(255,255,255,0.35)', fontSize: 11 },
  details: { paddingHorizontal: 14, paddingBottom: 14, gap: 4, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: 'rgba(255,255,255,0.06)' },
  openBtn: { flexDirection: 'row', gap: 6, alignSelf: 'flex-start', alignItems: 'center', backgroundColor: GOLD, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 10, marginTop: 10 },
  openText: { color: '#000', fontWeight: '800', fontSize: 13 },
  dh: { color: GOLD, fontSize: 11, fontWeight: '800', letterSpacing: 1, textTransform: 'uppercase', marginTop: 12, marginBottom: 2 },
  dl: { color: 'rgba(255,255,255,0.8)', fontSize: 12.5 },
  dim: { color: 'rgba(255,255,255,0.35)', fontSize: 12 },
  err: { color: '#f87171', fontSize: 12.5, marginTop: 8 },
  permRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  permLabel: { color: 'rgba(255,255,255,0.75)', fontSize: 12.5, width: 118 },
  permVal: { color: 'rgba(255,255,255,0.5)', fontSize: 12, flex: 1 },
});

export default PluginsScreen;
