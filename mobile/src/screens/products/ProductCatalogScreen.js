/**
 * ProductCatalogScreen — native Products catalog (web /products, plugin
 * `products`, builtin "products-catalog").
 *
 * 1:1 with extensions/products/ui/catalog.ts on the same RPCs:
 *   products.list / products.create / products.update / products.delete
 *   notion.import.listBindings / notion.import.refresh (Pull from Notion)
 *   notion.import.listDatabases / probeDatabase / commit (Import from Notion)
 *   business.list (business scope; the web reads the global agency filter)
 *
 * Sections: header + stats strip, Catalog | Portfolio switch, business scope,
 * search, filters + sort, gallery / list toggle, cards with context actions,
 * focus sheet (detail, pricing, inventory adjustments, description, files),
 * full editor, create dialog, Notion import + pull.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, FlatList, RefreshControl, StyleSheet, ScrollView, Linking, useWindowDimensions } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  AppHeader,
  Screen,
  StatCard,
  Chip,
  Button,
  Field,
  SegmentedControl,
  EmptyState,
  Skeleton,
  BottomSheet,
  Card,
  ListRow,
  Divider,
  useUIKit,
  SPACE,
  RADIUS,
  toneColor,
} from '../../ui-kit';
import { PluginGate } from '../../components/PluginGate';
import { navigateToScreen, SCREEN_SECTIONS, flattenScreens } from '../../navigation/screen-registry';
import { withAlpha } from '../../theme/color-utils';
import {
  DEFAULT_BUSINESS_ID,
  EMPTY_FILTERS,
  SORTS,
  ACCENT_TONES,
  PRODUCT_STATUSES,
  selectProducts,
  businessOptions,
  filterProducts,
  sortProducts,
  computeProductStats,
  filterOptions,
  hasActiveFilter,
  formatCurrencyCompact,
  formatStatus,
  formatType,
  typeIcon,
  typeTone,
  productAccentTone,
  productToForm,
  emptyCreateForm,
  validateForm,
  formToPatch,
  formToCreate,
  duplicatePayload,
  applyProductResult,
  hasProductsBinding,
  summarizePull,
  normalizeProduct,
} from './catalog-model';
import { ProductCard, ProductListRow, statusChipTone } from './ProductVisuals';
import { ProductDetail } from './ProductDetail';
import { ProductForm } from './ProductForm';
import { NotionImport } from './NotionImport';

const VIEW_KEY = 'infinibot-products-view';
const ACCENTS_KEY = 'infinibot-product-accents:v1';
const BIZ_KEY = 'infinibot-products-business';
const RPC_TIMEOUT = 20000;

function withTimeout(promise, ms = RPC_TIMEOUT) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('Request timed out')), ms)),
  ]);
}

function errMsg(e) {
  return e?.message || String(e || 'Unknown error');
}

export function ProductCatalogScreen({ navigation, gateway }) {
  const { colors, type } = useUIKit();
  const { width, height } = useWindowDimensions();
  const landscape = width > height;
  const connected = gateway?.status === 'connected';

  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(false);
  const [loadedOnce, setLoadedOnce] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [businesses, setBusinesses] = useState([{ id: DEFAULT_BUSINESS_ID, label: 'Default' }]);
  const [businessId, setBusinessId] = useState(DEFAULT_BUSINESS_ID);
  const [hasBinding, setHasBinding] = useState(false);
  const [pulling, setPulling] = useState(false);

  const [view, setView] = useState('gallery');
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [sort, setSort] = useState('default');
  const [accents, setAccents] = useState({});

  // One sheet at a time: { kind: 'detail'|'edit'|'create'|'actions'|'notion'|'filters', id? }
  const [sheet, setSheet] = useState(null);
  const [form, setForm] = useState(null);
  const [formErrors, setFormErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);

  const gen = useRef(0);
  const noticeTimer = useRef(null);

  const flash = useCallback((text, tone = 'success') => {
    setNotice({ text, tone });
    clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), tone === 'danger' ? 6000 : 3000);
  }, []);
  useEffect(() => () => clearTimeout(noticeTimer.current), []);

  // ── persisted UI prefs ──────────────────────────────────────────
  useEffect(() => {
    (async () => {
      try {
        const [v, a, b] = await Promise.all([
          AsyncStorage.getItem(VIEW_KEY),
          AsyncStorage.getItem(ACCENTS_KEY),
          AsyncStorage.getItem(BIZ_KEY),
        ]);
        if (v === 'gallery' || v === 'list') setView(v);
        if (a) setAccents(JSON.parse(a) || {});
        if (b) setBusinessId(b);
      } catch {
        /* prefs are optional */
      }
    })();
  }, []);

  const changeView = (v) => {
    setView(v);
    AsyncStorage.setItem(VIEW_KEY, v).catch(() => {});
  };

  const setAccent = useCallback((id, tone) => {
    setAccents((prev) => {
      const next = { ...prev };
      if (tone && ACCENT_TONES.includes(tone)) next[id] = tone;
      else delete next[id];
      AsyncStorage.setItem(ACCENTS_KEY, JSON.stringify(next)).catch(() => {});
      return next;
    });
  }, []);

  const changeBusiness = (id) => {
    setBusinessId(id);
    setFilters(EMPTY_FILTERS);
    AsyncStorage.setItem(BIZ_KEY, id).catch(() => {});
  };

  // ── load ────────────────────────────────────────────────────────
  const load = useCallback(async () => {
    if (!gateway?.sendReq || !connected) return;
    const g = ++gen.current;
    setLoading(true);
    setError(null);
    const [list, biz, bindings] = await Promise.allSettled([
      withTimeout(gateway.sendReq('products.list', { businessId })),
      withTimeout(gateway.sendReq('business.list', {})),
      withTimeout(gateway.sendReq('notion.import.listBindings', {}), 10000),
    ]);
    if (g !== gen.current) return;
    if (list.status === 'fulfilled') setProducts(selectProducts(list.value));
    else {
      const m = errMsg(list.reason);
      setError(/unknown method|not found|no handler/i.test(m)
        ? 'This gateway does not serve products.list — the Products plugin is off or the gateway needs an update.'
        : m);
    }
    if (biz.status === 'fulfilled') {
      const opts = businessOptions(biz.value);
      setBusinesses(opts);
      if (!opts.some((o) => o.id === businessId)) setBusinessId(DEFAULT_BUSINESS_ID);
    }
    // Web: Pull button hides only when listBindings answers with no match.
    setHasBinding(bindings.status === 'fulfilled' ? hasProductsBinding(bindings.value, businessId) : true);
    setLoading(false);
    setLoadedOnce(true);
  }, [gateway, connected, businessId]);

  useEffect(() => { load(); }, [load]);

  // ── writes ──────────────────────────────────────────────────────
  const patchProduct = useCallback(async (product, partial) => {
    if (!product || !partial || !Object.keys(partial).length) return null;
    const snapshot = products;
    setProducts((prev) => applyProductResult(prev, { type: 'patched', id: product.id, patch: partial }));
    try {
      const res = await withTimeout(gateway.sendReq('products.update', { id: product.id, businessId: product.businessId, ...partial }));
      if (res?.product) setProducts((prev) => applyProductResult(prev, { type: 'updated', product: res.product }));
      return res?.product || null;
    } catch (e) {
      setProducts(snapshot);
      flash(`Update failed: ${errMsg(e)}`, 'danger');
      return null;
    }
  }, [gateway, products, flash]);

  const createProduct = useCallback(async (payload) => {
    const res = await withTimeout(gateway.sendReq('products.create', { businessId, ...payload }));
    if (res?.product) {
      setProducts((prev) => applyProductResult(prev, { type: 'created', product: res.product }));
      return normalizeProduct(res.product);
    }
    return null;
  }, [gateway, businessId]);

  const deleteProduct = useCallback(async (product) => {
    setBusy(true);
    try {
      const res = await withTimeout(gateway.sendReq('products.delete', { id: product.id, businessId: product.businessId }));
      if (res?.deleted === false) throw new Error('Product was not found');
      setProducts((prev) => applyProductResult(prev, { type: 'deleted', id: product.id }));
      setAccent(product.id, null);
      setSheet(null);
      setConfirmDeleteId(null);
      flash(`Deleted "${product.name}"`);
    } catch (e) {
      flash(`Delete failed: ${errMsg(e)}`, 'danger');
    } finally {
      setBusy(false);
    }
  }, [gateway, flash, setAccent]);

  const duplicate = useCallback(async (product) => {
    setBusy(true);
    try {
      const dup = await createProduct(duplicatePayload(product));
      if (dup) {
        setSheet({ kind: 'detail', id: dup.id });
        flash('Duplicated as a draft');
      }
    } catch (e) {
      flash(`Duplicate failed: ${errMsg(e)}`, 'danger');
    } finally {
      setBusy(false);
    }
  }, [createProduct, flash]);

  const pullFromNotion = useCallback(async () => {
    if (pulling) return;
    setPulling(true);
    try {
      const res = await withTimeout(gateway.sendReq('notion.import.refresh', { role: 'products', businessId }), 90000);
      flash(summarizePull(res));
      await load();
    } catch (e) {
      flash(`Pull failed: ${errMsg(e)}`, 'danger');
    } finally {
      setPulling(false);
    }
  }, [gateway, businessId, pulling, load, flash]);

  // ── sheets ──────────────────────────────────────────────────────
  const openDetail = (p) => setSheet({ kind: 'detail', id: p.id });
  const openActions = (p) => { setConfirmDeleteId(null); setSheet({ kind: 'actions', id: p.id }); };
  const openCreate = () => { setForm(emptyCreateForm()); setFormErrors({}); setSheet({ kind: 'create' }); };
  const openEdit = (p) => { setForm(productToForm(p)); setFormErrors({}); setSheet({ kind: 'edit', id: p.id }); };
  const closeSheet = () => { setSheet(null); setConfirmDeleteId(null); };

  const sheetProduct = sheet?.id ? products.find((p) => p.id === sheet.id) : null;

  const submitCreate = async () => {
    const errs = validateForm(form);
    setFormErrors(errs);
    if (Object.keys(errs).length) return;
    setBusy(true);
    try {
      const created = await createProduct(formToCreate(form));
      if (created) setSheet({ kind: 'detail', id: created.id });
    } catch (e) {
      setFormErrors({ name: `Create failed: ${errMsg(e)}` });
    } finally {
      setBusy(false);
    }
  };

  const submitEdit = async () => {
    if (!sheetProduct) return;
    const errs = validateForm(form);
    setFormErrors(errs);
    if (Object.keys(errs).length) return;
    const patch = formToPatch(form, sheetProduct);
    if (!Object.keys(patch).length) { setSheet({ kind: 'detail', id: sheetProduct.id }); return; }
    setBusy(true);
    const saved = await patchProduct(sheetProduct, patch);
    setBusy(false);
    if (saved) { flash('Saved'); setSheet({ kind: 'detail', id: sheetProduct.id }); }
  };

  // ── derived ─────────────────────────────────────────────────────
  const stats = useMemo(() => computeProductStats(products), [products]);
  const options = useMemo(() => filterOptions(products), [products]);
  const visible = useMemo(() => sortProducts(filterProducts(products, filters), sort), [products, filters, sort]);
  const filtering = hasActiveFilter(filters);
  const activeFilterCount = ['type', 'status', 'category'].filter((k) => filters[k] !== 'all').length;

  const gutter = SPACE.lg;
  const gap = SPACE.md;
  const columns = view === 'list' ? 1 : width >= 1100 ? 5 : width >= 800 ? 4 : width >= 560 ? 3 : 2;
  const cardW = Math.floor((width - gutter * 2 - gap * (columns - 1)) / columns);

  const goPortfolio = () => {
    const entry = flattenScreens(SCREEN_SECTIONS).find((e) => e.key === 'kisproducts');
    if (!navigateToScreen(navigation, entry, { gateway })) navigation?.navigate?.('ProductRegistry');
  };

  // ── header ──────────────────────────────────────────────────────
  const statItems = [
    { label: 'Active', value: stats.active, tone: 'success', icon: 'checkmark-circle-outline' },
    { label: 'Drafts', value: stats.drafts, tone: 'neutral', icon: 'document-outline' },
    { label: 'Out of stock', value: stats.outOfStock, tone: 'warning', icon: 'alert-circle-outline' },
    { label: 'Catalog value', value: formatCurrencyCompact(stats.totalValue), tone: 'primary', icon: 'cash-outline' },
  ];
  const workspaceSeg = (
    <SegmentedControl
      size="sm"
      options={[{ key: 'catalog', label: 'Catalog', icon: 'pricetags-outline' }, { key: 'portfolio', label: 'Portfolio', icon: 'cube-outline' }]}
      value="catalog"
      onChange={(k) => k === 'portfolio' && goPortfolio()}
      style={landscape ? { width: 260 } : undefined}
    />
  );
  // Landscape: KPI tiles collapse to one chip strip so the products stay above the fold.
  const statsNode = landscape ? (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.hChips} style={{ flex: 1 }}>
      {statItems.map((s) => (
        <Chip key={s.label} tone={s.tone} icon={s.icon} label={s.label} count={s.value} accessibilityLabel={`${s.label} ${s.value}`} />
      ))}
    </ScrollView>
  ) : (
    <View style={styles.statsGrid}>
      {statItems.map((s) => (
        <StatCard
          key={s.label}
          compact
          label={s.label}
          value={s.value}
          tone={s.tone}
          icon={s.icon}
          loading={loading && !loadedOnce}
          style={{ width: (width - gutter * 2 - SPACE.sm) / 2 }}
        />
      ))}
    </View>
  );
  const searchNode = (
    <Field
      style={landscape ? { flex: 1 } : undefined}
      icon="search"
      value={filters.query}
      onChangeText={(q) => setFilters((f) => ({ ...f, query: q }))}
      placeholder="Search by name, SKU, tag, description…"
      rightIcon={filters.query ? 'close-circle' : undefined}
      onRightPress={filters.query ? () => setFilters((f) => ({ ...f, query: '' })) : undefined}
      rightLabel="Clear search"
      autoCapitalize="none"
      accessibilityLabel="Search products"
      returnKeyType="search"
    />
  );
  const viewSeg = (
    <SegmentedControl
      size="sm"
      options={[{ key: 'gallery', label: 'Gallery', icon: 'grid-outline' }, { key: 'list', label: 'List', icon: 'list-outline' }]}
      value={view}
      onChange={changeView}
      style={landscape ? { width: 220 } : { flex: 1, maxWidth: 240 }}
    />
  );
  const filtersBtn = (
    <Button
      size="sm"
      variant={activeFilterCount ? 'outline' : 'secondary'}
      icon="options-outline"
      title={activeFilterCount ? `Filters ${activeFilterCount}` : 'Filters'}
      onPress={() => setSheet({ kind: 'filters' })}
      accessibilityLabel="Filters and sort"
    />
  );
  const scopeRow = (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.hChips}>
      {businesses.length > 1 ? (
        <>
          <Ionicons name="business-outline" size={14} color={colors.textMuted} />
          {businesses.map((b) => (
            <Chip key={b.id} label={b.label} tone="primary" selected={businessId === b.id} onPress={() => changeBusiness(b.id)} accessibilityLabel={`Business ${b.label}`} />
          ))}
          <View style={[styles.vRule, { backgroundColor: colors.border }]} />
        </>
      ) : null}
      <Button size="sm" variant="ghost" icon="download-outline" title="Import from Notion" onPress={() => setSheet({ kind: 'notion' })} accessibilityLabel="Import a Notion database as Products" />
      {hasBinding ? (
        <Button size="sm" variant="ghost" icon="sync-outline" title={pulling ? 'Pulling…' : 'Pull from Notion'} loading={pulling} onPress={pullFromNotion} accessibilityLabel="Pull every connected Notion database for this page" />
      ) : null}
    </ScrollView>
  );

  const listHeader = (
    <View style={{ gap: landscape ? SPACE.sm : SPACE.md, paddingBottom: SPACE.md }}>
      {landscape ? (
        <>
          <View style={styles.toolbar}>{workspaceSeg}{statsNode}</View>
          <View style={styles.toolbar}>{searchNode}{viewSeg}{filtersBtn}</View>
        </>
      ) : (
        <>
          {workspaceSeg}
          {statsNode}
          {searchNode}
          <View style={styles.toolbar}>{viewSeg}{filtersBtn}</View>
        </>
      )}

      {filtering || sort !== 'default' ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.hChips}>
          {filters.type !== 'all' ? <Chip icon="close" tone={typeTone(filters.type)} label={formatType(filters.type)} onPress={() => setFilters((f) => ({ ...f, type: 'all' }))} accessibilityLabel="Clear type filter" /> : null}
          {filters.status !== 'all' ? <Chip icon="close" tone={statusChipTone(filters.status)} label={formatStatus(filters.status)} onPress={() => setFilters((f) => ({ ...f, status: 'all' }))} accessibilityLabel="Clear status filter" /> : null}
          {filters.category !== 'all' ? <Chip icon="close" label={filters.category} onPress={() => setFilters((f) => ({ ...f, category: 'all' }))} accessibilityLabel="Clear category filter" /> : null}
          {sort !== 'default' ? <Chip icon="swap-vertical" tone="primary" label={SORTS.find((s) => s.key === sort)?.label} onPress={() => setSheet({ kind: 'filters' })} /> : null}
          {filtering ? <Chip label="Clear all" tone="danger" onPress={() => setFilters(EMPTY_FILTERS)} /> : null}
        </ScrollView>
      ) : null}

      {scopeRow}

      {notice ? (
        <View style={[styles.notice, { borderColor: withAlpha(toneColor(notice.tone, colors), 0.45), backgroundColor: withAlpha(toneColor(notice.tone, colors), 0.08) }]}>
          <Ionicons name={notice.tone === 'danger' ? 'alert-circle-outline' : 'checkmark-circle-outline'} size={16} color={toneColor(notice.tone, colors)} />
          <Text style={[type.caption, { color: colors.text, flex: 1 }]}>{notice.text}</Text>
        </View>
      ) : null}

      {loadedOnce && !error && products.length ? (
        <Text style={[type.caption, { color: colors.textMuted }]}>
          {visible.length === products.length ? `${products.length} products` : `Showing ${visible.length} of ${products.length}`}
        </Text>
      ) : null}
    </View>
  );

  // ── body states ─────────────────────────────────────────────────
  let emptyNode = null;
  if (!connected && !loadedOnce) {
    emptyNode = <EmptyState icon="cloud-offline-outline" title="Connecting to gateway" message="The catalog loads as soon as the gateway connects." />;
  } else if (error && !products.length) {
    emptyNode = <EmptyState tone="danger" icon="alert-circle-outline" title="Couldn't load the catalog" message={error} actionLabel="Retry" onAction={load} />;
  } else if (loading && !loadedOnce) {
    emptyNode = (
      <View style={[styles.skelGrid, { gap }]}>
        {Array.from({ length: columns * 2 }).map((_, i) => (
          <Skeleton key={i} width={view === 'list' ? '100%' : cardW} height={view === 'list' ? 64 : Math.round(cardW * 1.15)} radius={RADIUS.lg} />
        ))}
      </View>
    );
  } else if (!visible.length) {
    emptyNode = filtering ? (
      <EmptyState icon="search-outline" title="No products match those filters" message="Try clearing the search or relaxing the filters." actionLabel="Clear filters" onAction={() => setFilters(EMPTY_FILTERS)} />
    ) : (
      <EmptyState icon="cube-outline" title="Your catalog is empty" message="Add your first digital or physical product to get started." actionLabel="Add your first product" onAction={openCreate} secondaryLabel="Import from Notion" onSecondary={() => setSheet({ kind: 'notion' })} />
    );
  }

  const renderItem = ({ item, index }) => {
    const tone = productAccentTone(item, accents);
    if (view === 'list') {
      return (
        <View
          style={[
            styles.listItem,
            {
              backgroundColor: withAlpha(colors.surface || colors.text, 0.5),
              borderColor: colors.border,
              borderTopLeftRadius: index === 0 ? RADIUS.lg : 0,
              borderTopRightRadius: index === 0 ? RADIUS.lg : 0,
              borderBottomLeftRadius: index === visible.length - 1 ? RADIUS.lg : 0,
              borderBottomRightRadius: index === visible.length - 1 ? RADIUS.lg : 0,
              borderTopWidth: index === 0 ? 1 : 0,
              borderBottomWidth: index === visible.length - 1 ? 1 : 0,
            },
          ]}
        >
          <ProductListRow product={item} accentTone={tone} wide={landscape} onPress={() => openDetail(item)} onMore={() => openActions(item)} />
        </View>
      );
    }
    return <ProductCard product={item} accentTone={tone} width={cardW} onPress={() => openDetail(item)} onMore={() => openActions(item)} />;
  };

  // ── sheet content ───────────────────────────────────────────────
  let sheetProps = null;
  if (sheet?.kind === 'detail' && sheetProduct) {
    sheetProps = {
      title: 'Product',
      subtitle: [sheetProduct.sku, sheetProduct.category].filter(Boolean).join(' · ') || undefined,
      maxHeightRatio: 0.94,
      children: (
        <ProductDetail
          product={sheetProduct}
          accentTone={productAccentTone(sheetProduct, accents)}
          onAccent={(t) => setAccent(sheetProduct.id, t)}
          onPatch={(partial) => patchProduct(sheetProduct, partial)}
          onEdit={() => openEdit(sheetProduct)}
          onDuplicate={() => duplicate(sheetProduct)}
          onDelete={() => deleteProduct(sheetProduct)}
          busy={busy}
          wide={landscape}
        />
      ),
    };
  } else if ((sheet?.kind === 'edit' && sheetProduct) || sheet?.kind === 'create') {
    const creating = sheet.kind === 'create';
    sheetProps = {
      title: creating ? 'Add a Product' : 'Edit product',
      subtitle: creating ? 'Name is required — everything else can be filled in later' : sheetProduct.name,
      maxHeightRatio: 0.94,
      children: form ? <ProductForm form={form} onChange={setForm} errors={formErrors} keys={creating ? ['name', 'sku', 'type', 'price', 'description'] : undefined} /> : null,
      footer: (
        <View style={styles.sheetFooter}>
          <Button variant="ghost" title="Cancel" onPress={() => (creating ? closeSheet() : setSheet({ kind: 'detail', id: sheetProduct.id }))} />
          <Button
            variant="primary"
            icon={creating ? 'add' : 'checkmark'}
            title={creating ? 'Create Product' : 'Save changes'}
            onPress={creating ? submitCreate : submitEdit}
            loading={busy}
            disabled={busy || !String(form?.name || '').trim()}
          />
        </View>
      ),
    };
  } else if (sheet?.kind === 'actions' && sheetProduct) {
    const p = sheetProduct;
    const tone = productAccentTone(p, accents);
    sheetProps = {
      title: p.name,
      subtitle: 'Product actions',
      children: (
        <View style={{ gap: SPACE.md }}>
          <View style={styles.swatchRow}>
            <Text style={[type.label, { color: colors.textMuted }]}>Accent</Text>
            {ACCENT_TONES.map((t) => (
              <Chip key={t} size="sm" tone={t} dot label={t} selected={tone === t} onPress={() => setAccent(p.id, t)} accessibilityLabel={`Accent ${t}`} />
            ))}
            <Chip size="sm" icon="refresh" label="Reset" onPress={() => setAccent(p.id, null)} accessibilityLabel="Reset accent" />
          </View>
          <Text style={[type.label, styles.groupLabel, { color: colors.textMuted }]}>Status</Text>
          <View style={styles.swatchRow}>
            {PRODUCT_STATUSES.map((s) => (
              <Chip key={s} dot tone={statusChipTone(s)} label={formatStatus(s)} selected={p.status === s} onPress={() => { if (p.status !== s) patchProduct(p, { status: s }); closeSheet(); }} />
            ))}
          </View>
          <Card tint="neutral" depth={1}>
            <ListRow icon="open-outline" title="Open product" onPress={() => setSheet({ kind: 'detail', id: p.id })} />
            <Divider inset />
            <ListRow icon="create-outline" title="Edit properties" onPress={() => openEdit(p)} />
            <Divider inset />
            <ListRow icon="image-outline" title="Change thumbnail" subtitle={p.image ? 'Edit the image URL' : 'Add an image URL'} onPress={() => openEdit(p)} />
            {p.externalUrl ? (
              <>
                <Divider inset />
                <ListRow icon="globe-outline" title="Open external URL" subtitle={p.externalUrl} onPress={() => { Linking.openURL(p.externalUrl).catch(() => {}); closeSheet(); }} />
              </>
            ) : null}
            <Divider inset />
            <ListRow icon="copy-outline" title="Duplicate" subtitle="Creates a draft copy" onPress={() => duplicate(p)} disabled={busy} />
            <Divider inset />
            <ListRow icon="archive-outline" title="Archive" onPress={() => { patchProduct(p, { status: 'archived' }); closeSheet(); }} disabled={p.status === 'archived'} />
            <Divider inset />
            {confirmDeleteId === p.id ? (
              <View style={[styles.sheetFooter, { padding: SPACE.md }]}>
                <Text style={[type.small, { color: colors.text, flex: 1 }]}>Delete "{p.name}"?</Text>
                <Button size="sm" variant="ghost" title="Cancel" onPress={() => setConfirmDeleteId(null)} />
                <Button size="sm" variant="danger" icon="trash-outline" title="Delete" loading={busy} onPress={() => deleteProduct(p)} />
              </View>
            ) : (
              <ListRow icon="trash-outline" iconTone="danger" title="Delete" valueTone="danger" onPress={() => setConfirmDeleteId(p.id)} />
            )}
          </Card>
        </View>
      ),
    };
  } else if (sheet?.kind === 'notion') {
    sheetProps = {
      title: 'Import from Notion',
      maxHeightRatio: 0.92,
      children: <NotionImport gateway={gateway} businessId={businessId} onImported={load} onClose={closeSheet} />,
    };
  } else if (sheet?.kind === 'filters') {
    sheetProps = {
      title: 'Filter & sort',
      subtitle: `${visible.length} of ${products.length} products`,
      children: (
        <View style={{ gap: SPACE.sm }}>
          <Text style={[type.label, styles.groupLabel, { color: colors.textMuted }]}>Type</Text>
          <View style={styles.swatchRow}>
            <Chip label="All types" selected={filters.type === 'all'} onPress={() => setFilters((f) => ({ ...f, type: 'all' }))} />
            {options.types.map((t) => (
              <Chip key={t} icon={typeIcon(t)} tone={typeTone(t)} label={formatType(t)} selected={filters.type === t} onPress={() => setFilters((f) => ({ ...f, type: t }))} />
            ))}
          </View>
          <Text style={[type.label, styles.groupLabel, { color: colors.textMuted }]}>Status</Text>
          <View style={styles.swatchRow}>
            <Chip label="All statuses" selected={filters.status === 'all'} onPress={() => setFilters((f) => ({ ...f, status: 'all' }))} />
            {options.statuses.map((s) => (
              <Chip key={s} dot tone={statusChipTone(s)} label={formatStatus(s)} selected={filters.status === s} onPress={() => setFilters((f) => ({ ...f, status: s }))} />
            ))}
          </View>
          {options.categories.length ? (
            <>
              <Text style={[type.label, styles.groupLabel, { color: colors.textMuted }]}>Category</Text>
              <View style={styles.swatchRow}>
                <Chip label="All categories" selected={filters.category === 'all'} onPress={() => setFilters((f) => ({ ...f, category: 'all' }))} />
                {options.categories.map((c) => (
                  <Chip key={c} icon="folder-outline" label={c} selected={filters.category === c} onPress={() => setFilters((f) => ({ ...f, category: c }))} />
                ))}
              </View>
            </>
          ) : null}
          <Text style={[type.label, styles.groupLabel, { color: colors.textMuted }]}>Sort</Text>
          <View style={styles.swatchRow}>
            {SORTS.map((s) => (
              <Chip key={s.key} icon="swap-vertical" tone="primary" label={s.label} selected={sort === s.key} onPress={() => setSort(s.key)} />
            ))}
          </View>
        </View>
      ),
      footer: (
        <View style={styles.sheetFooter}>
          <Button variant="ghost" title="Reset" onPress={() => { setFilters((f) => ({ ...EMPTY_FILTERS, query: f.query })); setSort('default'); }} />
          <Button variant="primary" title={`Show ${visible.length}`} onPress={closeSheet} />
        </View>
      ),
    };
  }

  const body = (
    <Screen
      scroll={false}
      padded={false}
      edges={['bottom']}
      keyboardAvoiding
      header={
        <AppHeader
          eyebrow="Products"
          title="Product Catalog"
          subtitle={`${stats.total} item${stats.total === 1 ? '' : 's'} · digital + physical`}
          leftIcon="chevron-back"
          leftLabel="Back"
          onLeftPress={() => navigation?.goBack?.()}
          rightActions={[
            { key: 'refresh', icon: 'refresh', label: 'Refresh from gateway', onPress: load, busy: loading },
            { key: 'new', icon: 'add', label: 'New product', onPress: openCreate },
          ]}
        />
      }
    >
      <FlatList
        key={`${view}-${columns}`}
        data={emptyNode ? [] : visible}
        keyExtractor={(p) => p.id}
        renderItem={renderItem}
        numColumns={columns}
        columnWrapperStyle={columns > 1 ? { gap } : undefined}
        contentContainerStyle={{ padding: gutter, gap: view === 'list' ? 0 : gap, paddingBottom: SPACE.xxl * 2 }}
        ListHeaderComponent={listHeader}
        ListEmptyComponent={emptyNode}
        refreshControl={<RefreshControl refreshing={loading && loadedOnce} onRefresh={load} tintColor={colors.primary} />}
        keyboardShouldPersistTaps="handled"
        initialNumToRender={12}
        windowSize={7}
      />
      <BottomSheet
        visible={!!sheetProps}
        onClose={closeSheet}
        side={landscape && width >= 700}
        sideWidth={Math.min(560, Math.round(width * 0.55))}
        {...(sheetProps || { children: null })}
      />
    </Screen>
  );

  return (
    <PluginGate pluginId="products" title="Products" navigation={navigation}>
      {body}
    </PluginGate>
  );
}

const styles = StyleSheet.create({
  statsGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.sm },
  hChips: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, paddingVertical: 2 },
  toolbar: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, justifyContent: 'space-between' },
  vRule: { width: StyleSheet.hairlineWidth, height: 24, marginHorizontal: SPACE.xs },
  notice: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, padding: SPACE.md, borderRadius: RADIUS.md, borderWidth: 1 },
  skelGrid: { flexDirection: 'row', flexWrap: 'wrap' },
  listItem: { borderLeftWidth: 1, borderRightWidth: 1, overflow: 'hidden' },
  sheetFooter: { flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center', gap: SPACE.sm, flexWrap: 'wrap' },
  groupLabel: { marginTop: SPACE.sm },
  swatchRow: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.sm, alignItems: 'center' },
});

export default ProductCatalogScreen;
