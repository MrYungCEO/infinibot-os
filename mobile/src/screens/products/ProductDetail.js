/**
 * ProductDetail — body of the product focus sheet (web: renderFocusModal).
 *
 * Hero + badges, name/price, accent palette, quick status, inventory
 * adjustments, pricing breakdown, properties, description preview/edit,
 * Files & Media strip with an in-sheet file preview, stamps and delete.
 * Every write goes through the parent's `onPatch(partial)` → products.update.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { View, Text, Image, Pressable, ScrollView, StyleSheet, Linking } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import Markdown from 'react-native-markdown-display';
import {
  useUIKit,
  SPACE,
  RADIUS,
  Chip,
  Button,
  IconButton,
  Field,
  SegmentedControl,
  Card,
  ListRow,
  Divider,
  toneColor,
  MONO_FAMILY,
} from '../../ui-kit';
import { withAlpha } from '../../theme/color-utils';
import {
  ACCENT_TONES,
  PRODUCT_STATUSES,
  formatCurrency,
  formatStatus,
  formatType,
  formatDate,
  formatMargin,
  productMargin,
  adjustInventory,
  galleryItems,
  kindIcon,
  textPreviewable,
  prettyText,
  typeIcon,
} from './catalog-model';
import { ProductMedia, StatusBadge, TypePill, statusChipTone } from './ProductVisuals';

const PROPERTY_ROWS = [
  { key: 'sku', label: 'SKU', icon: 'barcode-outline', mono: true },
  { key: 'category', label: 'Category', icon: 'folder-outline' },
  { key: 'vendor', label: 'Vendor', icon: 'storefront-outline' },
  { key: 'weight', label: 'Weight', icon: 'barbell-outline', fmt: (v) => `${v} kg` },
  { key: 'dimensions', label: 'Dimensions', icon: 'resize-outline' },
  { key: 'downloadUrl', label: 'Download URL', icon: 'cloud-download-outline', url: true },
  { key: 'licenseKeyPattern', label: 'License key pattern', icon: 'key-outline', mono: true },
  { key: 'stripeProductId', label: 'Stripe product id', icon: 'card-outline', mono: true },
  { key: 'externalUrl', label: 'External URL', icon: 'open-outline', url: true },
  { key: 'lastSynced', label: 'Last synced', icon: 'sync-outline', fmt: (v) => formatDate(v) },
];

function openUrl(url) {
  if (url) Linking.openURL(url).catch(() => {});
}

export function ProductDetail({ product: p, accentTone, onAccent, onPatch, onEdit, onDuplicate, onDelete, busy, wide }) {
  const { colors, type } = useUIKit();
  const accent = toneColor(accentTone, colors);
  const margin = productMargin(p);
  const [descMode, setDescMode] = useState('preview');
  const [descDraft, setDescDraft] = useState(p.description || '');
  const [invDraft, setInvDraft] = useState(typeof p.inventory === 'number' ? String(p.inventory) : '');
  const [file, setFile] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => { setDescDraft(p.description || ''); }, [p.id, p.description]);
  useEffect(() => { setInvDraft(typeof p.inventory === 'number' ? String(p.inventory) : ''); }, [p.id, p.inventory]);
  useEffect(() => { setFile(null); setConfirmDelete(false); }, [p.id]);

  const mdStyles = useMemo(() => ({
    body: { color: colors.textSecondary, fontSize: 14, lineHeight: 21 },
    heading1: { color: colors.text, fontSize: 18, fontWeight: '700', marginTop: 8 },
    heading2: { color: colors.text, fontSize: 16, fontWeight: '700', marginTop: 8 },
    heading3: { color: colors.text, fontSize: 15, fontWeight: '600', marginTop: 6 },
    link: { color: colors.primary },
    code_inline: { fontFamily: MONO_FAMILY, fontSize: 13, color: colors.text, backgroundColor: withAlpha(colors.text, 0.08), borderWidth: 0, borderRadius: 4, paddingHorizontal: 3, paddingVertical: 0 },
    fence: { fontFamily: MONO_FAMILY, color: colors.text, backgroundColor: withAlpha(colors.text, 0.06), borderColor: colors.border },
    bullet_list_icon: { color: colors.primary },
    hr: { backgroundColor: colors.border },
    blockquote: { backgroundColor: withAlpha(colors.primary, 0.06), borderColor: colors.primary },
  }), [colors]);

  if (file) return <FilePreview item={file} onBack={() => setFile(null)} />;

  const gallery = galleryItems(p);
  const hasInventory = p.type === 'physical' || typeof p.inventory === 'number';
  const unitProfit = typeof p.price === 'number' && typeof p.cost === 'number' ? p.price - p.cost : null;
  const stockValue = typeof p.price === 'number' && typeof p.inventory === 'number' ? p.price * p.inventory : null;
  const props = PROPERTY_ROWS.filter((r) => p[r.key] !== undefined && p[r.key] !== null && p[r.key] !== '');

  const invDirty = invDraft.trim() !== '' && invDraft.trim() !== (typeof p.inventory === 'number' ? String(p.inventory) : '');
  const setInventoryFromDraft = () => {
    const n = Number(invDraft);
    if (invDraft.trim() !== '' && Number.isFinite(n)) commitInventory(n);
  };
  const commitInventory = (next) => {
    const n = adjustInventory(next, 0);
    if (n !== p.inventory) onPatch({ inventory: n });
  };

  return (
    <View style={{ gap: SPACE.md }}>
      <View style={[styles.hero, { borderColor: withAlpha(accent, 0.4) }]}>
        <ProductMedia product={p} accentTone={accentTone} height={wide ? 200 : 180} initialsSize={44} watermark={140}>
          <View style={styles.heroTags} pointerEvents="none">
            <StatusBadge status={p.status} size="md" />
            {p.type ? <TypePill type={p.type} size="md" /> : null}
            {margin !== null ? <Chip tone={margin >= 0 ? 'success' : 'danger'} label={`${formatMargin(margin)} margin`} /> : null}
          </View>
        </ProductMedia>
      </View>

      <View style={styles.titleRow}>
        <View style={[styles.typeBadge, { backgroundColor: withAlpha(accent, 0.18), borderColor: withAlpha(accent, 0.45) }]}>
          <Ionicons name={typeIcon(p.type)} size={20} color={accent} />
        </View>
        <Text style={[type.h2, { color: colors.text, flex: 1 }]} numberOfLines={3}>{p.name}</Text>
        {typeof p.price === 'number' ? (
          <Text style={[type.metricSmall, { color: colors.primary }]}>{formatCurrency(p.price)}</Text>
        ) : null}
      </View>

      <View style={styles.actionsRow}>
        <Button size="sm" variant="primary" icon="create-outline" title="Edit" onPress={onEdit} accessibilityLabel="Edit product" />
        <Button size="sm" variant="secondary" icon="copy-outline" title="Duplicate" onPress={onDuplicate} disabled={busy} />
        {p.externalUrl ? <Button size="sm" variant="ghost" icon="open-outline" title="Open" onPress={() => openUrl(p.externalUrl)} accessibilityLabel="Open external URL" /> : null}
      </View>

      <View style={styles.paletteRow}>
        <Ionicons name="color-palette-outline" size={16} color={colors.textMuted} accessibilityLabel="Accent colour" />
        {ACCENT_TONES.map((t) => {
          const c = toneColor(t, colors);
          const active = accentTone === t;
          return (
            <Pressable
              key={t}
              onPress={() => onAccent(t)}
              hitSlop={6}
              accessibilityRole="button"
              accessibilityLabel={`Accent ${t}${active ? ', selected' : ''}`}
              style={[styles.swatch, { backgroundColor: c, borderColor: active ? colors.text : withAlpha(colors.text, 0.2) }]}
            >
              {active ? <Ionicons name="checkmark" size={14} color={colors.background || colors.surfaceDeep} /> : null}
            </Pressable>
          );
        })}
        <Pressable onPress={() => onAccent(null)} hitSlop={6} accessibilityRole="button" accessibilityLabel="Reset accent to type default" style={[styles.swatch, { borderColor: withAlpha(colors.text, 0.3) }]}>
          <Ionicons name="close" size={14} color={colors.textMuted} />
        </Pressable>
      </View>

      <Label title="Status" />
      <View style={styles.chipRow}>
        {(PRODUCT_STATUSES.includes(p.status) || !p.status ? PRODUCT_STATUSES : [p.status, ...PRODUCT_STATUSES]).map((s) => (
          <Chip
            key={s}
            dot
            tone={statusChipTone(s)}
            label={formatStatus(s)}
            selected={p.status === s}
            onPress={() => p.status !== s && onPatch({ status: s })}
            accessibilityLabel={`Set status ${formatStatus(s)}`}
          />
        ))}
      </View>

      <Label title="Pricing" />
      <Card padded={SPACE.md} tint="neutral" depth={1}>
        <View style={styles.priceGrid}>
          <PriceCell label="Price" value={formatCurrency(p.price)} tone="primary" />
          <PriceCell label="Cost" value={formatCurrency(p.cost)} />
          <PriceCell label="Margin" value={margin === null ? '—' : formatMargin(margin)} tone={margin === null ? null : margin >= 0 ? 'success' : 'danger'} />
          <PriceCell label="Profit / unit" value={unitProfit === null ? '—' : formatCurrency(unitProfit)} />
          {stockValue !== null ? <PriceCell label="Stock value" value={formatCurrency(stockValue)} /> : null}
        </View>
      </Card>

      {hasInventory ? (
        <>
          <Label title="Inventory" subtitle="Adjust stock on hand" />
          <Card padded={SPACE.md} tint="neutral" depth={1}>
            <View style={styles.invRow}>
              <IconButton icon="remove" variant="outline" accessibilityLabel="Remove 10 from stock" onPress={() => commitInventory(adjustInventory(p.inventory, -10))} />
              <IconButton icon="remove-circle-outline" variant="outline" accessibilityLabel="Remove 1 from stock" onPress={() => commitInventory(adjustInventory(p.inventory, -1))} />
              <Field
                style={{ flex: 1 }}
                value={invDraft}
                onChangeText={setInvDraft}
                onSubmitEditing={setInventoryFromDraft}
                returnKeyType="done"
                rightIcon={invDirty ? 'checkmark-circle' : undefined}
                onRightPress={invDirty ? setInventoryFromDraft : undefined}
                rightLabel="Set stock count"
                keyboardType="number-pad"
                mono
                placeholder="—"
                accessibilityLabel="Units in stock"
                inputStyle={{ textAlign: 'center' }}
              />
              <IconButton icon="add-circle-outline" variant="outline" accessibilityLabel="Add 1 to stock" onPress={() => commitInventory(adjustInventory(p.inventory, 1))} />
              <IconButton icon="add" variant="outline" accessibilityLabel="Add 10 to stock" onPress={() => commitInventory(adjustInventory(p.inventory, 10))} />
            </View>
            <Text style={[type.caption, { color: p.inventory === 0 ? colors.error : colors.textMuted, marginTop: SPACE.sm }]}>
              {typeof p.inventory === 'number' ? `${p.inventory} in stock` : 'Not tracked yet — set a count to start tracking'}
              {p.inventory === 0 && p.status !== 'out_of_stock' ? ' · consider marking Out of stock' : ''}
            </Text>
          </Card>
        </>
      ) : null}

      {props.length || (p.tags && p.tags.length) ? (
        <>
          <Label title="Properties" />
          <Card tint="neutral" depth={1}>
            {props.map((r, i) => {
              const raw = p[r.key];
              const v = r.fmt ? r.fmt(raw) : String(raw);
              return (
                <View key={r.key}>
                  {i ? <Divider inset /> : null}
                  <ListRow
                    dense
                    icon={r.icon}
                    iconTone="neutral"
                    title={r.label}
                    subtitle={v}
                    onPress={r.url ? () => openUrl(raw) : undefined}
                    trailing={r.url ? <Ionicons name="open-outline" size={16} color={colors.textMuted} /> : undefined}
                    chevron={false}
                    accessibilityLabel={`${r.label}: ${v}`}
                  />
                </View>
              );
            })}
            {p.tags && p.tags.length ? (
              <View style={[styles.chipRow, { padding: SPACE.md }]}>
                <Ionicons name="pricetag-outline" size={14} color={colors.textMuted} />
                {p.tags.map((t) => <Chip key={t} size="sm" label={t} />)}
              </View>
            ) : null}
          </Card>
        </>
      ) : null}

      <View style={styles.descHead}>
        <Text style={[type.label, { color: colors.textMuted }]}>Description</Text>
        <SegmentedControl
          size="sm"
          options={[{ key: 'preview', label: 'Preview' }, { key: 'edit', label: 'Edit' }]}
          value={descMode === 'edit' || !(p.description || '').trim() ? 'edit' : 'preview'}
          onChange={setDescMode}
          style={{ width: 170 }}
        />
      </View>
      {descMode === 'edit' || !(p.description || '').trim() ? (
        <View style={{ gap: SPACE.sm }}>
          <Field
            multiline
            rows={8}
            value={descDraft}
            onChangeText={setDescDraft}
            placeholder="What does this product do? Who is it for? (Markdown supported)"
            accessibilityLabel="Description"
          />
          {descDraft !== (p.description || '') ? (
            <View style={styles.actionsRow}>
              <Button size="sm" variant="secondary" title="Save description" icon="checkmark" onPress={() => { onPatch({ description: descDraft }); setDescMode('preview'); }} />
              <Button size="sm" variant="ghost" title="Discard" onPress={() => setDescDraft(p.description || '')} />
            </View>
          ) : null}
        </View>
      ) : (
        <Card padded={SPACE.md} tint="neutral" depth={1}>
          <Markdown style={mdStyles} onLinkPress={(url) => { openUrl(url); return false; }}>
            {p.description || ''}
          </Markdown>
        </Card>
      )}

      {gallery.total ? (
        <>
          <Label title="Files & Media" count={gallery.total} />
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: SPACE.sm }}>
            {gallery.items.map((it) => (
              <GalleryThumb key={it.url} item={it} onPress={() => setFile(it)} />
            ))}
            {gallery.more ? (
              <View style={[styles.thumb, { borderColor: colors.border, alignItems: 'center', justifyContent: 'center' }]}>
                <Text style={[type.monoSmall, { color: colors.textMuted }]}>+{gallery.more} more</Text>
              </View>
            ) : null}
          </ScrollView>
        </>
      ) : null}

      <View style={[styles.foot, { borderTopColor: colors.borderSubtle || colors.border }]}>
        <Text style={[type.caption, { color: colors.textMuted, flex: 1 }]}>
          Created {formatDate(p.createdAt)} · Updated {formatDate(p.updatedAt)}
        </Text>
        {confirmDelete ? (
          <View style={styles.actionsRow}>
            <Button size="sm" variant="ghost" title="Cancel" onPress={() => setConfirmDelete(false)} />
            <Button size="sm" variant="danger" icon="trash-outline" title="Delete" onPress={onDelete} loading={busy} accessibilityLabel={`Confirm delete ${p.name}`} />
          </View>
        ) : (
          <Button size="sm" variant="ghost" icon="trash-outline" title="Delete" onPress={() => setConfirmDelete(true)} textStyle={{ color: colors.error }} accessibilityLabel="Delete product" />
        )}
      </View>
    </View>
  );
}

function Label({ title, count, subtitle }) {
  const { colors, type } = useUIKit();
  return (
    <View style={styles.label}>
      <Text style={[type.label, { color: colors.textMuted }]}>{title}{count ? `  ${count}` : ''}</Text>
      {subtitle ? <Text style={[type.caption, { color: colors.textMuted }]}>{subtitle}</Text> : null}
    </View>
  );
}

function PriceCell({ label, value, tone }) {
  const { colors, type } = useUIKit();
  return (
    <View style={styles.priceCell}>
      <Text style={[type.label, { color: colors.textMuted }]}>{label}</Text>
      <Text style={[type.mono, { color: tone ? toneColor(tone, colors) : colors.text }]} numberOfLines={1}>{value}</Text>
    </View>
  );
}

function GalleryThumb({ item, onPress }) {
  const { colors, type } = useUIKit();
  const [failed, setFailed] = useState(false);
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`Open ${item.name}`}
      style={({ pressed }) => [styles.thumb, { borderColor: colors.border, backgroundColor: withAlpha(colors.text, 0.05), opacity: pressed ? 0.8 : 1 }]}
    >
      {item.kind === 'image' && !failed ? (
        <Image source={{ uri: item.url }} style={StyleSheet.absoluteFill} resizeMode="cover" onError={() => setFailed(true)} />
      ) : (
        <View style={styles.thumbInner}>
          <Ionicons name={kindIcon(item.kind)} size={22} color={colors.primary} />
          <Text style={[type.caption, { color: colors.textSecondary }]} numberOfLines={1}>{failed ? 'expired' : item.name}</Text>
          {item.ext ? <Text style={[type.monoSmall, { color: colors.textMuted }]}>{item.ext.toUpperCase()}</Text> : null}
        </View>
      )}
    </Pressable>
  );
}

/** In-sheet file focus (web: renderFileFocusModal). */
function FilePreview({ item, onBack }) {
  const { colors, type } = useUIKit();
  const [text, setText] = useState(null);
  const [err, setErr] = useState(null);
  const [imgFailed, setImgFailed] = useState(false);
  const [copied, setCopied] = useState(false);
  const wantsText = textPreviewable(item);

  useEffect(() => {
    if (!wantsText) return undefined;
    let alive = true;
    setText(null);
    setErr(null);
    fetch(item.url)
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`${r.status} ${r.statusText}`))))
      .then((t) => alive && setText(prettyText(item, t)))
      .catch((e) => alive && setErr(e?.message || String(e)));
    return () => { alive = false; };
  }, [item, wantsText]);

  let body;
  if (item.kind === 'image') {
    body = imgFailed ? (
      <Text style={[type.small, { color: colors.error }]}>Image failed to load — the URL may have expired. Try opening it instead.</Text>
    ) : (
      <Image source={{ uri: item.url }} style={styles.previewImg} resizeMode="contain" onError={() => setImgFailed(true)} />
    );
  } else if (wantsText) {
    body = err ? (
      <Text style={[type.small, { color: colors.error }]}>Preview unavailable: {err}. The file URL may have expired. Use Open below.</Text>
    ) : text === null ? (
      <Text style={[type.small, { color: colors.textMuted }]}>Loading preview…</Text>
    ) : (
      <ScrollView style={[styles.previewText, { backgroundColor: withAlpha(colors.text, 0.05), borderColor: colors.border }]} nestedScrollEnabled>
        <Text selectable style={[type.monoSmall, { color: colors.textSecondary }]}>{text.slice(0, 40000)}</Text>
      </ScrollView>
    );
  } else {
    body = (
      <View style={styles.fallback}>
        <Ionicons name={kindIcon(item.kind)} size={48} color={colors.primary} />
        <Text style={[type.small, { color: colors.textMuted, textAlign: 'center' }]}>
          {item.kind === 'video' || item.kind === 'audio' || item.kind === 'pdf'
            ? 'Opens in your device viewer.'
            : 'No inline preview available — use Open below.'}
        </Text>
      </View>
    );
  }

  return (
    <View style={{ gap: SPACE.md }}>
      <View style={styles.fileHead}>
        <IconButton icon="chevron-back" accessibilityLabel="Back to product" onPress={onBack} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={[type.bodyStrong, { color: colors.text }]} numberOfLines={1}>{item.name}</Text>
          <View style={styles.chipRow}>
            {item.ext ? <Chip size="sm" tone="primary" label={item.ext.toUpperCase()} /> : null}
            <Text style={[type.caption, { color: colors.textMuted }]}>{item.kind}</Text>
          </View>
        </View>
      </View>
      {body}
      <View style={styles.actionsRow}>
        <Button size="sm" variant="secondary" icon="open-outline" title="Open" onPress={() => openUrl(item.url)} />
        <Button
          size="sm"
          variant="ghost"
          icon={copied ? 'checkmark' : 'copy-outline'}
          title={copied ? 'Copied' : 'Copy URL'}
          onPress={async () => { try { await Clipboard.setStringAsync(item.url); setCopied(true); } catch { /* ignore */ } }}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  hero: { borderRadius: RADIUS.lg, overflow: 'hidden', borderWidth: 1 },
  heroTags: { position: 'absolute', left: SPACE.sm, bottom: SPACE.sm, right: SPACE.sm, flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.xs },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: SPACE.md },
  typeBadge: { width: 40, height: 40, borderRadius: RADIUS.md, alignItems: 'center', justifyContent: 'center', borderWidth: 1 },
  actionsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.sm, alignItems: 'center' },
  paletteRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: SPACE.sm, rowGap: SPACE.sm },
  label: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', marginTop: SPACE.sm },
  swatch: { width: 28, height: 28, borderRadius: 14, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
  tightTitle: { marginTop: SPACE.sm },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.sm, alignItems: 'center' },
  priceGrid: { flexDirection: 'row', flexWrap: 'wrap', rowGap: SPACE.md },
  priceCell: { width: '50%', gap: 2 },
  invRow: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm },
  descHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: SPACE.sm },
  thumb: { width: 96, height: 96, borderRadius: RADIUS.md, borderWidth: 1, overflow: 'hidden' },
  thumbInner: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 2, padding: SPACE.xs },
  foot: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, borderTopWidth: StyleSheet.hairlineWidth, paddingTop: SPACE.md, flexWrap: 'wrap' },
  fileHead: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm },
  previewImg: { width: '100%', height: 320 },
  previewText: { maxHeight: 360, borderWidth: 1, borderRadius: RADIUS.md, padding: SPACE.md },
  fallback: { alignItems: 'center', gap: SPACE.sm, paddingVertical: SPACE.xl },
});
