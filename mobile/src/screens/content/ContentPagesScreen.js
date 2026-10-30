// ContentPagesScreen — mobile mirror of the web <content-pages-hub>.
//
// Three internal levels (same architecture as the web hub):
//   1. list   — all content pages (content.pages.list) + create
//   2. detail — stats overview + Scripts/Videos/Content/Ideas tabs + publish
//   3. (script editing + generation live in their own modal screens, reached
//      from the detail view via navigation params)
//
// Cross-device sync: detail view subscribes to content.pages.stats.subscribe
// and listens on the 'content.pages.stats' broadcast event, and additionally
// polls children every 5s, so an edit on web shows here within 5s and vice
// versa. Offline: a freshly typed (but unsent) new-page form is stashed in
// AsyncStorage and restored on reconnect.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  TextInput,
  StyleSheet,
  ActivityIndicator,
  RefreshControl,
  Alert,
  Modal,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { COLORS } from '../../constants/theme';
import { withAlpha, glassGradient, headerGradient, innerTopHighlight } from '../../theme/color-utils';
import {
  listPages,
  createPage,
  deletePage,
  getStats,
  subscribeStats,
  listChildren,
  createChild,
  deleteChild,
  listBusinesses,
  sendToChannel,
  saveDraft,
  loadDraft,
  clearDraft,
  CHILD_KINDS,
  SURFACES,
  SURFACE_ICON,
} from './contentApi';

const NEW_PAGE_DRAFT_KEY = 'new-page';
const CHANNELS = ['telegram', 'gmail', 'discord', 'sms'];

function rowTitle(row) {
  return row?.title || row?.name || row?.values?.title?.markdown || 'Untitled';
}

export function ContentPagesScreen({ gateway, navigation, route }) {
  const [pages, setPages] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState(null); // selected page object
  const [showCreate, setShowCreate] = useState(false);

  const loadPages = useCallback(async () => {
    try {
      setError('');
      const list = await listPages(gateway, {});
      setPages(list);
    } catch (e) {
      setError(e?.message || 'Failed to load content pages');
    } finally {
      setLoading(false);
    }
  }, [gateway]);

  useEffect(() => {
    loadPages();
  }, [loadPages]);

  // If a sibling screen (script editor / generation) asked us to refresh on
  // return, honour it.
  useEffect(() => {
    if (route?.params?.refreshAt) loadPages();
  }, [route?.params?.refreshAt, loadPages]);

  if (selected) {
    return (
      <PageDetail
        gateway={gateway}
        navigation={navigation}
        page={selected}
        onBack={() => {
          setSelected(null);
          loadPages();
        }}
      />
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={['left', 'right']}>
      <LinearGradient
        colors={headerGradient(COLORS.gold)}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={styles.header}
      >
        <View>
          <View style={styles.kickerRow}>
            <View style={styles.accentBar} />
            <Text style={styles.headerKicker}>CONTENT STUDIO</Text>
          </View>
          <Text style={styles.headerTitle}>Content Pages</Text>
        </View>
        <TouchableOpacity style={styles.newBtn} onPress={() => setShowCreate(true)}>
          <Ionicons name="add" size={18} color={COLORS.gold} />
          <Text style={styles.newBtnText}>New Page</Text>
        </TouchableOpacity>
      </LinearGradient>

      {error ? (
        <View style={styles.banner}>
          <Ionicons name="warning-outline" size={14} color="#ff6b6b" />
          <Text style={styles.bannerText}>{error}</Text>
        </View>
      ) : null}

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={COLORS.primary} />
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={styles.listContent}
          refreshControl={
            <RefreshControl refreshing={false} onRefresh={loadPages} tintColor={COLORS.primary} />
          }
        >
          {pages.length === 0 ? (
            <EmptyState onCreate={() => setShowCreate(true)} />
          ) : (
            pages.map((p) => (
              <PageCard
                key={p.id}
                page={p}
                onOpen={() => setSelected(p)}
                onDelete={async () => {
                  Alert.alert('Delete page', `Delete "${p.name}"? This removes its scripts, videos and ideas.`, [
                    { text: 'Cancel', style: 'cancel' },
                    {
                      text: 'Delete',
                      style: 'destructive',
                      onPress: async () => {
                        try {
                          await deletePage(gateway, p.id);
                          loadPages();
                        } catch (e) {
                          Alert.alert('Delete failed', e?.message || 'Unknown error');
                        }
                      },
                    },
                  ]);
                }}
              />
            ))
          )}
          <View style={{ height: 48 }} />
        </ScrollView>
      )}

      <CreatePageModal
        visible={showCreate}
        gateway={gateway}
        onClose={() => setShowCreate(false)}
        onCreated={(page) => {
          setShowCreate(false);
          setPages((prev) => [page, ...prev]);
          setSelected(page);
        }}
      />
    </SafeAreaView>
  );
}

function EmptyState({ onCreate }) {
  return (
    <View style={styles.empty}>
      <View style={styles.emptyIconChip}>
        <Ionicons name="albums-outline" size={36} color={COLORS.gold} />
      </View>
      <Text style={styles.emptyTitle}>No content pages yet</Text>
      <Text style={styles.emptyDesc}>
        A content page is a channel (Instagram, YouTube, a blog…) with its own scripts, videos and idea
        backlog. Create one to start producing.
      </Text>
      <TouchableOpacity style={styles.emptyBtn} onPress={onCreate} activeOpacity={0.85}>
        <LinearGradient
          colors={COLORS.goldGradient}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={styles.emptyBtnFill}
        >
          <Text style={styles.emptyBtnText}>Create your first page</Text>
        </LinearGradient>
      </TouchableOpacity>
    </View>
  );
}

function PageCard({ page, onOpen, onDelete }) {
  const stats = page.stats || {};
  return (
    <LinearGradient
      colors={[withAlpha(COLORS.gold, 0.55), withAlpha(COLORS.gold, 0.08), 'transparent']}
      start={{ x: 0, y: 0 }}
      end={{ x: 1, y: 1 }}
      style={styles.cardBorder}
    >
      <TouchableOpacity style={styles.card} activeOpacity={0.85} onPress={onOpen}>
        <View style={styles.cardIconWrap}>
          <Ionicons name={SURFACE_ICON[page.surface] || 'globe-outline'} size={20} color={COLORS.gold} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.cardTitle} numberOfLines={1}>
            {page.name}
          </Text>
          <Text style={styles.cardMeta} numberOfLines={1}>
            {page.surface}
            {page.handle ? ` · ${page.handle}` : ''} · {page.status || 'draft'}
          </Text>
          <View style={styles.cardStatsRow}>
            <Stat label="Followers" value={fmt(stats.followers)} />
            <Stat label="Posts" value={fmt(stats.totalPosts)} />
            <Stat label="Eng %" value={stats.engagementRate ? `${(stats.engagementRate * 100).toFixed(1)}` : '—'} />
          </View>
        </View>
        <TouchableOpacity onPress={onDelete} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <Ionicons name="trash-outline" size={16} color={COLORS.textMuted} />
        </TouchableOpacity>
      </TouchableOpacity>
    </LinearGradient>
  );
}

function Stat({ label, value }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

function fmt(n) {
  if (n == null || Number.isNaN(n)) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

// ── Detail view ───────────────────────────────────────────────
function PageDetail({ gateway, navigation, page: initialPage, onBack }) {
  const [page, setPage] = useState(initialPage);
  const [tab, setTab] = useState('overview');
  const [stats, setStats] = useState(initialPage.stats || {});
  const [igLive, setIgLive] = useState(false);
  const [children, setChildren] = useState({}); // kind -> rows[]
  const [busyKind, setBusyKind] = useState(null);
  const [showPublish, setShowPublish] = useState(false);
  const subIdRef = useRef(null);

  const loadChildren = useCallback(
    async (kind) => {
      try {
        const r = await listChildren(gateway, page.id, kind);
        setChildren((prev) => ({ ...prev, [kind]: r?.rows || [] }));
      } catch {
        // best effort
      }
    },
    [gateway, page.id],
  );

  const loadStats = useCallback(async () => {
    try {
      const r = await getStats(gateway, page.id);
      if (r?.stats) setStats(r.stats);
      if (r?.page) setPage((p) => ({ ...p, ...r.page }));
      setIgLive(!!r?.meta?.igLive);
    } catch {
      // ignore
    }
  }, [gateway, page.id]);

  // Initial load + cross-device sync: subscribe to the stats broadcast and
  // poll children every 5s so web<->mobile edits converge.
  useEffect(() => {
    loadStats();
    CHILD_KINDS.forEach(loadChildren);

    let unsub = () => {};
    subscribeStats(gateway, page.id)
      .then((r) => {
        subIdRef.current = r?.subscriptionId;
      })
      .catch(() => {});
    unsub = gateway.subscribeEvent('content.pages.stats', (payload) => {
      if (payload?.pageId !== page.id) return;
      if (payload?.stats) setStats(payload.stats);
      if (payload?.meta) setIgLive(!!payload.meta.igLive);
    });

    const poll = setInterval(() => {
      CHILD_KINDS.forEach(loadChildren);
    }, 5000);

    return () => {
      unsub && unsub();
      clearInterval(poll);
    };
  }, [gateway, page.id, loadStats, loadChildren]);

  const addChild = async (kind) => {
    if (kind === 'scripts') {
      navigation.navigate('ScriptEditorModal', { gateway, pageId: page.id, pageName: page.name });
      return;
    }
    if (kind === 'videos' || kind === 'content') {
      navigation.navigate('ContentGenerationModal', {
        gateway,
        pageId: page.id,
        pageName: page.name,
        kind,
      });
      return;
    }
    // ideas — quick inline create
    setBusyKind(kind);
    try {
      await createChild(gateway, page.id, kind, 'New idea', {});
      await loadChildren(kind);
    } catch (e) {
      Alert.alert('Create failed', e?.message || 'Unknown error');
    } finally {
      setBusyKind(null);
    }
  };

  const removeChild = async (kind, rowId) => {
    try {
      await deleteChild(gateway, rowId);
      await loadChildren(kind);
    } catch (e) {
      Alert.alert('Delete failed', e?.message || 'Unknown error');
    }
  };

  return (
    <SafeAreaView style={styles.container} edges={['left', 'right']}>
      <LinearGradient
        colors={headerGradient(COLORS.gold)}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={styles.detailHeader}
      >
        <TouchableOpacity
          style={styles.backBtn}
          onPress={onBack}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        >
          <Ionicons name="arrow-back" size={22} color={COLORS.gold} />
        </TouchableOpacity>
        <View style={{ flex: 1, marginLeft: 12 }}>
          <Text style={styles.detailTitle} numberOfLines={1}>
            {page.name}
          </Text>
          <Text style={styles.detailMeta}>
            {page.surface}
            {igLive ? ' · ● IG live' : ''}
          </Text>
        </View>
        <TouchableOpacity style={styles.publishBtn} onPress={() => setShowPublish(true)} activeOpacity={0.85}>
          <LinearGradient
            colors={COLORS.goldGradient}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={styles.publishBtnFill}
          >
            <Ionicons name="paper-plane" size={14} color={COLORS.background} />
            <Text style={styles.publishBtnText}>Publish</Text>
          </LinearGradient>
        </TouchableOpacity>
      </LinearGradient>

      <View style={styles.tabBarWrap}>
        <View style={styles.tabBar}>
          {['overview', ...CHILD_KINDS].map((t) => (
            <TouchableOpacity key={t} style={[styles.tab, tab === t && styles.tabActive]} onPress={() => setTab(t)}>
              <Text style={[styles.tabText, tab === t && styles.tabTextActive]}>
                {t === 'overview' ? 'Overview' : t.charAt(0).toUpperCase() + t.slice(1)}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>

      <ScrollView
        contentContainerStyle={styles.detailContent}
        refreshControl={
          <RefreshControl
            refreshing={false}
            onRefresh={() => {
              loadStats();
              CHILD_KINDS.forEach(loadChildren);
            }}
            tintColor={COLORS.primary}
          />
        }
      >
        {tab === 'overview' ? (
          <Overview stats={stats} igLive={igLive} />
        ) : (
          <ChildList
            kind={tab}
            rows={children[tab] || []}
            busy={busyKind === tab}
            onAdd={() => addChild(tab)}
            onOpen={(row) => {
              if (tab === 'scripts') {
                navigation.navigate('ScriptEditorModal', {
                  gateway,
                  pageId: page.id,
                  pageName: page.name,
                  rowId: row.id,
                });
              }
            }}
            onDelete={(row) => removeChild(tab, row.id)}
          />
        )}
        <View style={{ height: 60 }} />
      </ScrollView>

      <PublishModal
        visible={showPublish}
        gateway={gateway}
        page={page}
        onClose={() => setShowPublish(false)}
      />
    </SafeAreaView>
  );
}

function Overview({ stats, igLive }) {
  const cells = [
    { label: 'Followers', value: fmt(stats.followers) },
    { label: 'Total posts', value: fmt(stats.totalPosts) },
    { label: 'Monthly posts', value: fmt(stats.monthlyPosts) },
    { label: 'Reach 30d', value: fmt(stats.reach30d) },
    { label: 'Impressions 30d', value: fmt(stats.impressions30d) },
    {
      label: 'Engagement',
      value: stats.engagementRate ? `${(stats.engagementRate * 100).toFixed(2)}%` : '—',
    },
    { label: 'Clicks 30d', value: fmt(stats.clicks30d) },
    { label: 'Conversions 30d', value: fmt(stats.conversions30d) },
  ];
  return (
    <View>
      <View style={styles.liveRow}>
        <View style={[styles.dot, { backgroundColor: igLive ? '#37d67a' : COLORS.textMuted }]} />
        <Text style={styles.liveText}>{igLive ? 'Live Instagram sync active' : 'Local stats'}</Text>
      </View>
      <View style={styles.grid}>
        {cells.map((c) => (
          <View key={c.label} style={styles.gridCell}>
            <View style={styles.gridAccentBar} />
            <Text style={styles.gridValue}>{c.value}</Text>
            <Text style={styles.gridLabel}>{c.label}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

function ChildList({ kind, rows, busy, onAdd, onOpen, onDelete }) {
  const addLabel =
    kind === 'scripts'
      ? 'Write / generate script'
      : kind === 'videos'
        ? 'Generate video'
        : kind === 'content'
          ? 'Generate content'
          : 'Add idea';
  return (
    <View>
      <TouchableOpacity style={styles.addRow} onPress={onAdd} disabled={busy} activeOpacity={0.85}>
        {busy ? (
          <ActivityIndicator size="small" color={COLORS.gold} />
        ) : (
          <Ionicons name="add-circle-outline" size={18} color={COLORS.gold} />
        )}
        <Text style={styles.addRowText}>{addLabel}</Text>
      </TouchableOpacity>
      {rows.length === 0 ? (
        <Text style={styles.childEmpty}>No {kind} yet.</Text>
      ) : (
        rows.map((row) => (
          <TouchableOpacity key={row.id} style={styles.childRow} activeOpacity={0.8} onPress={() => onOpen(row)}>
            <Ionicons
              name={
                kind === 'scripts'
                  ? 'document-text-outline'
                  : kind === 'videos'
                    ? 'videocam-outline'
                    : kind === 'content'
                      ? 'image-outline'
                      : 'bulb-outline'
              }
              size={16}
              color={COLORS.gold}
            />
            <Text style={styles.childTitle} numberOfLines={1}>
              {rowTitle(row)}
            </Text>
            <TouchableOpacity onPress={() => onDelete(row)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <Ionicons name="close" size={16} color={COLORS.textMuted} />
            </TouchableOpacity>
          </TouchableOpacity>
        ))
      )}
    </View>
  );
}

// ── Create page modal (wizard, offline-draft aware) ───────────
function CreatePageModal({ visible, gateway, onClose, onCreated }) {
  const [name, setName] = useState('');
  const [handle, setHandle] = useState('');
  const [surface, setSurface] = useState('instagram');
  const [businesses, setBusinesses] = useState([]);
  const [businessId, setBusinessId] = useState('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    if (!visible) return;
    // restore an offline draft if present
    loadDraft(NEW_PAGE_DRAFT_KEY).then((d) => {
      if (d) {
        setName(d.name || '');
        setHandle(d.handle || '');
        setSurface(d.surface || 'instagram');
      }
    });
    listBusinesses(gateway)
      .then((list) => {
        setBusinesses(list);
        const active = list.find((b) => b.active) || list[0];
        if (active) setBusinessId(active.id);
      })
      .catch(() => {});
  }, [visible, gateway]);

  // Persist a draft as the user types so an offline/disconnect doesn't lose it.
  useEffect(() => {
    if (!visible) return;
    if (!name && !handle) return;
    saveDraft(NEW_PAGE_DRAFT_KEY, { name, handle, surface });
  }, [visible, name, handle, surface]);

  const submit = async () => {
    if (!name.trim()) {
      setErr('Name is required');
      return;
    }
    if (!businessId) {
      setErr('No business found — create a business first.');
      return;
    }
    setSaving(true);
    setErr('');
    try {
      const page = await createPage(gateway, {
        businessId,
        name: name.trim(),
        surface,
        handle: handle.trim() || undefined,
        status: 'active',
      });
      await clearDraft(NEW_PAGE_DRAFT_KEY);
      setName('');
      setHandle('');
      onCreated(page);
    } catch (e) {
      setErr(e?.message || 'Create failed');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.modalOverlay}
      >
        <View style={styles.modalSheet}>
          <View style={styles.modalHandle} />
          <Text style={styles.modalTitle}>New Content Page</Text>

          <Text style={styles.fieldLabel}>Name</Text>
          <TextInput
            style={styles.input}
            value={name}
            onChangeText={setName}
            placeholder="e.g. Brand IG"
            placeholderTextColor={COLORS.textMuted}
          />

          <Text style={styles.fieldLabel}>Handle (optional)</Text>
          <TextInput
            style={styles.input}
            value={handle}
            onChangeText={setHandle}
            placeholder="@brand"
            placeholderTextColor={COLORS.textMuted}
            autoCapitalize="none"
          />

          <Text style={styles.fieldLabel}>Surface</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 6 }}>
            {SURFACES.map((s) => (
              <TouchableOpacity
                key={s}
                style={[styles.chip, surface === s && styles.chipActive]}
                onPress={() => setSurface(s)}
              >
                <Ionicons
                  name={SURFACE_ICON[s]}
                  size={13}
                  color={surface === s ? COLORS.gold : COLORS.textMuted}
                />
                <Text style={[styles.chipText, surface === s && styles.chipTextActive]}>{s}</Text>
              </TouchableOpacity>
            ))}
          </ScrollView>

          {businesses.length > 1 ? (
            <>
              <Text style={styles.fieldLabel}>Business</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 6 }}>
                {businesses.map((b) => (
                  <TouchableOpacity
                    key={b.id}
                    style={[styles.chip, businessId === b.id && styles.chipActive]}
                    onPress={() => setBusinessId(b.id)}
                  >
                    <Text style={[styles.chipText, businessId === b.id && styles.chipTextActive]}>
                      {b.name}
                    </Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>
            </>
          ) : null}

          {err ? <Text style={styles.errText}>{err}</Text> : null}

          <View style={styles.modalActions}>
            <TouchableOpacity style={styles.cancelBtn} onPress={onClose}>
              <Text style={styles.cancelBtnText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.primaryBtn} onPress={submit} disabled={saving} activeOpacity={0.85}>
              <LinearGradient
                colors={COLORS.goldGradient}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
                style={styles.primaryBtnFill}
              >
                {saving ? (
                  <ActivityIndicator size="small" color={COLORS.background} />
                ) : (
                  <Text style={styles.primaryBtnText}>Create</Text>
                )}
              </LinearGradient>
            </TouchableOpacity>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

// ── Publish modal (channel picker → send RPC) ─────────────────
function PublishModal({ visible, gateway, page, onClose }) {
  const [channel, setChannel] = useState('telegram');
  const [to, setTo] = useState('');
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState('');

  useEffect(() => {
    if (visible) {
      setMessage(`New from ${page.name} (${page.surface})`);
      setResult('');
    }
  }, [visible, page]);

  const submit = async () => {
    if (!message.trim()) {
      setResult('Message is required');
      return;
    }
    setSending(true);
    setResult('');
    try {
      await sendToChannel(gateway, {
        to: to.trim() || undefined,
        message: message.trim(),
        channel,
      });
      setResult('✓ Sent');
      setTimeout(onClose, 900);
    } catch (e) {
      setResult(e?.message || 'Send failed');
    } finally {
      setSending(false);
    }
  };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.modalOverlay}
      >
        <View style={styles.modalSheet}>
          <View style={styles.modalHandle} />
          <Text style={styles.modalTitle}>Publish to channel</Text>

          <Text style={styles.fieldLabel}>Channel</Text>
          <View style={styles.channelRow}>
            {CHANNELS.map((c) => (
              <TouchableOpacity
                key={c}
                style={[styles.chip, channel === c && styles.chipActive]}
                onPress={() => setChannel(c)}
              >
                <Text style={[styles.chipText, channel === c && styles.chipTextActive]}>{c}</Text>
              </TouchableOpacity>
            ))}
          </View>

          <Text style={styles.fieldLabel}>To (optional — default account/chat)</Text>
          <TextInput
            style={styles.input}
            value={to}
            onChangeText={setTo}
            placeholder={channel === 'gmail' ? 'name@email.com' : 'chat id / @handle'}
            placeholderTextColor={COLORS.textMuted}
            autoCapitalize="none"
          />

          <Text style={styles.fieldLabel}>Message</Text>
          <TextInput
            style={[styles.input, { height: 96, textAlignVertical: 'top' }]}
            value={message}
            onChangeText={setMessage}
            multiline
            placeholder="What to send…"
            placeholderTextColor={COLORS.textMuted}
          />

          {result ? (
            <Text style={[styles.errText, result.startsWith('✓') && { color: '#37d67a' }]}>
              {/* '✓' prefix is an internal success marker — drawn as a vector icon */}
              {result.startsWith('✓') ? <Ionicons name="checkmark-circle" size={13} color="#37d67a" /> : null}
              {result.startsWith('✓') ? result.slice(1) : result}
            </Text>
          ) : null}

          <View style={styles.modalActions}>
            <TouchableOpacity style={styles.cancelBtn} onPress={onClose}>
              <Text style={styles.cancelBtnText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.primaryBtn} onPress={submit} disabled={sending} activeOpacity={0.85}>
              <LinearGradient
                colors={COLORS.goldGradient}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
                style={styles.primaryBtnFill}
              >
                {sending ? (
                  <ActivityIndicator size="small" color={COLORS.background} />
                ) : (
                  <Text style={styles.primaryBtnText}>Send</Text>
                )}
              </LinearGradient>
            </TouchableOpacity>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.background },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 14,
    borderBottomWidth: 1,
    borderBottomColor: withAlpha(COLORS.gold, 0.15),
  },
  kickerRow: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  accentBar: { width: 3, height: 12, borderRadius: 2, backgroundColor: COLORS.gold },
  headerKicker: { fontSize: 10, letterSpacing: 1.5, color: COLORS.gold, fontWeight: '700' },
  headerTitle: { fontSize: 22, fontWeight: '800', color: COLORS.text, marginTop: 4 },
  newBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: withAlpha(COLORS.gold, 0.4),
    backgroundColor: 'rgba(14,13,18,0.6)',
    shadowColor: COLORS.gold,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.18,
    shadowRadius: 14,
    elevation: 6,
  },
  newBtnText: { color: COLORS.gold, fontWeight: '700', fontSize: 13 },
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginHorizontal: 16,
    marginTop: 10,
    marginBottom: 8,
    padding: 10,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(255,107,107,0.3)',
    backgroundColor: 'rgba(255,107,107,0.1)',
  },
  bannerText: { color: '#ff6b6b', fontSize: 12, flex: 1 },
  listContent: { paddingHorizontal: 16, paddingTop: 12 },
  empty: { alignItems: 'center', paddingVertical: 60, paddingHorizontal: 24 },
  emptyIconChip: {
    width: 72,
    height: 72,
    borderRadius: 36,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: withAlpha(COLORS.gold, 0.1),
    borderWidth: 1,
    borderColor: withAlpha(COLORS.gold, 0.25),
    marginBottom: 16,
  },
  emptyTitle: { color: COLORS.text, fontSize: 17, fontWeight: '700', marginTop: 2 },
  emptyDesc: { color: COLORS.textMuted, fontSize: 13, textAlign: 'center', marginTop: 8, lineHeight: 19 },
  emptyBtn: {
    marginTop: 20,
    borderRadius: 999,
    overflow: 'hidden',
    shadowColor: COLORS.gold,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 16,
    elevation: 8,
  },
  emptyBtnFill: { paddingHorizontal: 22, paddingVertical: 13, alignItems: 'center', justifyContent: 'center' },
  emptyBtnText: { color: COLORS.background, fontWeight: '800' },
  cardBorder: {
    borderRadius: 18,
    padding: 1,
    marginBottom: 12,
    shadowColor: COLORS.gold,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.18,
    shadowRadius: 14,
    elevation: 6,
  },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 14,
    borderRadius: 17,
    backgroundColor: 'rgba(10,10,14,0.72)',
  },
  cardIconWrap: {
    width: 40,
    height: 40,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: withAlpha(COLORS.gold, 0.1),
    borderWidth: 1,
    borderColor: withAlpha(COLORS.gold, 0.25),
  },
  cardTitle: { color: COLORS.text, fontSize: 15, fontWeight: '700' },
  cardMeta: { color: COLORS.textMuted, fontSize: 11, marginTop: 2 },
  cardStatsRow: { flexDirection: 'row', gap: 18, marginTop: 8 },
  stat: {},
  statValue: { color: COLORS.text, fontSize: 14, fontWeight: '700' },
  statLabel: { color: COLORS.textMuted, fontSize: 10 },
  // detail
  detailHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 14,
    borderBottomWidth: 1,
    borderBottomColor: withAlpha(COLORS.gold, 0.15),
  },
  backBtn: {
    width: 38,
    height: 38,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: withAlpha(COLORS.gold, 0.1),
    borderWidth: 1,
    borderColor: withAlpha(COLORS.gold, 0.25),
  },
  detailTitle: { color: COLORS.text, fontSize: 17, fontWeight: '800' },
  detailMeta: { color: COLORS.textMuted, fontSize: 11, marginTop: 2 },
  publishBtn: {
    borderRadius: 999,
    overflow: 'hidden',
    shadowColor: COLORS.gold,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.28,
    shadowRadius: 14,
    elevation: 7,
  },
  publishBtnFill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 14,
    paddingVertical: 9,
  },
  publishBtnText: { color: COLORS.background, fontWeight: '800', fontSize: 12 },
  tabBarWrap: {
    marginHorizontal: 16,
    marginTop: 12,
    marginBottom: 6,
    padding: 5,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: withAlpha(COLORS.gold, 0.18),
    backgroundColor: 'rgba(14,13,18,0.6)',
  },
  tabBar: { flexDirection: 'row', gap: 6, flexWrap: 'wrap' },
  tab: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 12, borderWidth: 1, borderColor: 'transparent' },
  tabActive: {
    backgroundColor: withAlpha(COLORS.gold, 0.18),
    borderColor: withAlpha(COLORS.gold, 0.5),
  },
  tabText: { color: COLORS.textMuted, fontSize: 12, fontWeight: '600' },
  tabTextActive: { color: COLORS.gold, fontWeight: '700' },
  detailContent: { paddingHorizontal: 16, paddingTop: 8 },
  liveRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 12 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  liveText: { color: COLORS.textMuted, fontSize: 12 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  gridCell: {
    width: '47%',
    padding: 14,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: withAlpha(COLORS.gold, 0.18),
    backgroundColor: 'rgba(14,13,18,0.6)',
    shadowColor: COLORS.gold,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.12,
    shadowRadius: 12,
    elevation: 4,
  },
  gridAccentBar: { width: 22, height: 3, borderRadius: 2, backgroundColor: COLORS.gold, marginBottom: 8, opacity: 0.8 },
  gridValue: { color: COLORS.text, fontSize: 20, fontWeight: '800' },
  gridLabel: { color: COLORS.textMuted, fontSize: 11, marginTop: 4 },
  addRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    padding: 13,
    borderRadius: 14,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: withAlpha(COLORS.gold, 0.4),
    backgroundColor: withAlpha(COLORS.gold, 0.06),
    marginBottom: 12,
  },
  addRowText: { color: COLORS.gold, fontWeight: '700', fontSize: 13 },
  childEmpty: { color: COLORS.textMuted, fontSize: 13, fontStyle: 'italic', paddingVertical: 8 },
  childRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    padding: 13,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: withAlpha(COLORS.gold, 0.18),
    backgroundColor: 'rgba(14,13,18,0.6)',
    marginBottom: 8,
  },
  childTitle: { flex: 1, color: COLORS.text, fontSize: 14 },
  // modal
  modalOverlay: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.6)' },
  modalSheet: {
    backgroundColor: 'rgba(10,10,14,0.96)',
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    padding: 20,
    paddingBottom: 34,
    borderTopWidth: 1,
    borderLeftWidth: 1,
    borderRightWidth: 1,
    borderColor: withAlpha(COLORS.gold, 0.2),
  },
  modalHandle: { alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: withAlpha(COLORS.gold, 0.3), marginBottom: 14 },
  modalTitle: { color: COLORS.text, fontSize: 18, fontWeight: '800', marginBottom: 12 },
  fieldLabel: { color: COLORS.gold, fontSize: 11, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 1, marginTop: 12, marginBottom: 6 },
  input: {
    backgroundColor: 'rgba(20,20,28,0.55)',
    borderWidth: 1,
    borderColor: withAlpha(COLORS.gold, 0.2),
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 12,
    color: COLORS.text,
    fontSize: 15,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: withAlpha(COLORS.gold, 0.25),
    backgroundColor: 'rgba(14,13,18,0.6)',
    marginRight: 8,
  },
  chipActive: {
    backgroundColor: withAlpha(COLORS.gold, 0.18),
    borderColor: withAlpha(COLORS.gold, 0.5),
  },
  chipText: { color: COLORS.textMuted, fontSize: 12, fontWeight: '600' },
  chipTextActive: { color: COLORS.gold, fontWeight: '700' },
  channelRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  errText: { color: '#ff6b6b', fontSize: 12, marginTop: 10 },
  modalActions: { flexDirection: 'row', gap: 10, marginTop: 20 },
  cancelBtn: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: withAlpha(COLORS.gold, 0.2),
    backgroundColor: 'rgba(20,20,28,0.55)',
    alignItems: 'center',
  },
  cancelBtnText: { color: COLORS.textMuted, fontWeight: '700' },
  primaryBtn: {
    flex: 1,
    borderRadius: 14,
    overflow: 'hidden',
    shadowColor: COLORS.gold,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.28,
    shadowRadius: 14,
    elevation: 7,
  },
  primaryBtnFill: { paddingVertical: 14, alignItems: 'center', justifyContent: 'center' },
  primaryBtnText: { color: COLORS.background, fontWeight: '800' },
});

export default ContentPagesScreen;
