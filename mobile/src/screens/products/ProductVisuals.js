/**
 * Product visuals shared by the catalog grid, list and detail sheet:
 * placeholder art, media (image with expiry fallback), gallery card, list row.
 * Look follows extensions/products/ui/catalog.ts (glass card, status badge
 * top-left, type pill + margin pill, price on the title row, stock bar, tags).
 */
import React, { useState } from 'react';
import { View, Text, Image, Pressable, StyleSheet, Platform } from 'react-native';

// RN-web renders role=button as <button>; the card hosts its own More button,
// so the outer pressable must not also be a <button> on web.
const OUTER_ROLE = Platform.OS === 'web' ? undefined : 'button';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useUIKit, SPACE, RADIUS, toneColor, toneForStatus, Chip, MONO_FAMILY } from '../../ui-kit';
import { withAlpha } from '../../theme/color-utils';
import {
  typeIcon,
  typeTone,
  statusTone,
  formatStatus,
  formatType,
  formatCurrency,
  formatMargin,
  productMargin,
  inventoryPct,
  productInitials,
  placeholderComplement,
  formatRelativeTime,
  hashStr,
} from './catalog-model';

export function statusChipTone(status) {
  return statusTone(status) || toneForStatus(status) || 'neutral';
}

/** Gradient + initials + faded type watermark (web: renderProductPlaceholder). */
export function ProductPlaceholder({ product, accentTone, height, initialsSize = 30, watermark = 84 }) {
  const { colors } = useUIKit();
  const accent = toneColor(accentTone, colors);
  const complement = toneColor(placeholderComplement(product), colors);
  const h = hashStr(product?.id || product?.name);
  const tilt = (h % 60) / 100; // varies the gradient angle per product
  return (
    <LinearGradient
      colors={[withAlpha(accent, 0.55), withAlpha(complement, 0.28), withAlpha(colors.background || colors.surfaceDeep, 0.9)]}
      start={{ x: 0, y: tilt }}
      end={{ x: 1, y: 1 - tilt }}
      style={[styles.ph, height ? { height } : null]}
    >
      <Ionicons
        name={typeIcon(product?.type)}
        size={watermark}
        color={withAlpha(colors.text, 0.08)}
        style={styles.phWatermark}
      />
      <Text style={[styles.phInitials, { color: colors.text, fontSize: initialsSize }]} accessibilityElementsHidden>
        {productInitials(product?.name)}
      </Text>
    </LinearGradient>
  );
}

/** Image if it loads, placeholder otherwise (Notion file URLs expire ~1h after the API call). */
export function ProductMedia({ product, accentTone, height, initialsSize, watermark, children }) {
  const [failed, setFailed] = useState(false);
  const showImg = !!product?.image && !failed;
  return (
    <View style={[styles.media, { height }]}>
      {showImg ? (
        <Image
          source={{ uri: product.image }}
          style={StyleSheet.absoluteFill}
          resizeMode="cover"
          onError={() => setFailed(true)}
          accessibilityLabel={product.name}
        />
      ) : (
        <View style={StyleSheet.absoluteFill}>
          <ProductPlaceholder product={product} accentTone={accentTone} height={height} initialsSize={initialsSize} watermark={watermark} />
        </View>
      )}
      {children}
    </View>
  );
}

export function TypePill({ type, size = 'sm' }) {
  if (!type) return null;
  return <Chip size={size} tone={typeTone(type)} icon={typeIcon(type)} label={formatType(type)} />;
}

export function StatusBadge({ status, size = 'sm' }) {
  return <Chip size={size} tone={statusChipTone(status)} dot label={formatStatus(status)} />;
}

/** Gallery card (web: .products-card). */
export function ProductCard({ product: p, accentTone, width, onPress, onMore, selected }) {
  const { colors, type } = useUIKit();
  const accent = toneColor(accentTone, colors);
  const margin = productMargin(p);
  const inv = inventoryPct(p);
  const mediaH = Math.round(width * 0.62);
  const tags = p.tags || [];
  return (
    <Pressable
      onPress={onPress}
      onLongPress={onMore}
      delayLongPress={350}
      accessibilityRole={OUTER_ROLE}
      accessibilityLabel={`${p.name}${typeof p.price === 'number' ? `, ${formatCurrency(p.price)}` : ''}`}
      accessibilityHint="Opens the product. Long-press for actions."
      style={({ pressed }) => [
        styles.card,
        {
          width,
          backgroundColor: withAlpha(colors.surface || colors.text, 0.55),
          borderColor: selected ? accent : withAlpha(accent, 0.32),
          opacity: pressed ? 0.88 : 1,
          transform: [{ scale: pressed ? 0.985 : 1 }],
        },
      ]}
    >
      <ProductMedia product={p} accentTone={accentTone} height={mediaH} initialsSize={Math.max(20, Math.round(width / 6))} watermark={Math.round(width / 2.3)}>
        <View style={styles.mediaTopRow} pointerEvents="box-none">
          <StatusBadge status={p.status} />
          <Pressable
            onPress={onMore}
            hitSlop={10}
            accessibilityRole="button"
            accessibilityLabel={`More actions for ${p.name}`}
            style={[styles.moreBtn, { backgroundColor: withAlpha(colors.surfaceDeep || colors.background, 0.6), borderColor: withAlpha(colors.text, 0.18) }]}
          >
            <Ionicons name="ellipsis-horizontal" size={16} color={colors.text} />
          </Pressable>
        </View>
        <View style={styles.mediaBottomRow} pointerEvents="none">
          {p.type ? <TypePill type={p.type} /> : <View />}
          {margin !== null ? <Chip size="sm" tone={margin >= 0 ? 'success' : 'danger'} label={formatMargin(margin)} /> : null}
        </View>
      </ProductMedia>
      <View style={styles.cardBody}>
        <Text style={[type.smallStrong, { color: colors.text }]} numberOfLines={2}>{p.name}</Text>
        {typeof p.price === 'number' ? (
          <Text style={[type.mono, { color: colors.primary, fontWeight: '700' }]} numberOfLines={1}>{formatCurrency(p.price)}</Text>
        ) : null}
        {p.sku ? <Text style={[type.monoSmall, { color: colors.textMuted }]} numberOfLines={1}>{p.sku}</Text> : null}
        {typeof p.cost === 'number' || p.category || p.vendor ? (
          <View style={styles.statsRow}>
            {typeof p.cost === 'number' ? <MiniStat label="cost" value={formatCurrency(p.cost)} /> : null}
            {p.category ? <MiniStat label="cat" value={p.category} /> : null}
            {p.vendor ? <MiniStat label="vendor" value={p.vendor} /> : null}
          </View>
        ) : null}
        {inv !== null ? (
          <View style={styles.invWrap} accessibilityLabel={`Inventory ${p.inventory}`}>
            <View style={[styles.invTrack, { backgroundColor: withAlpha(colors.text, 0.08) }]}>
              <View style={[styles.invFill, { width: `${inv}%`, backgroundColor: p.inventory === 0 ? colors.error : colors.success }]} />
            </View>
            <Text style={[type.caption, { color: p.inventory === 0 ? colors.error : colors.textMuted }]}>{p.inventory ?? 0} in stock</Text>
          </View>
        ) : null}
        {tags.length ? (
          <Text style={[type.caption, { color: colors.textMuted }]} numberOfLines={1}>
            {tags.slice(0, 3).join(' · ')}{tags.length > 3 ? `  +${tags.length - 3}` : ''}
          </Text>
        ) : null}
        <View style={styles.footRow}>
          <Text style={[type.caption, { color: colors.textMuted }]}>{formatRelativeTime(p.updatedAt)}</Text>
          {p.externalUrl ? <Ionicons name="open-outline" size={14} color={colors.textMuted} /> : null}
        </View>
      </View>
    </Pressable>
  );
}

function MiniStat({ label, value }) {
  const { colors, type } = useUIKit();
  return (
    <View style={[styles.miniStat, { borderColor: withAlpha(colors.text, 0.1) }]}>
      <Text style={[type.caption, { color: colors.textMuted }]}>{label}</Text>
      <Text style={[type.caption, { color: colors.textSecondary, fontFamily: MONO_FAMILY, flexShrink: 1 }]} numberOfLines={1}>{value}</Text>
    </View>
  );
}

/** List view row (web: .products-list-row — thumb, name+desc, SKU, type, status, price, inventory, category). */
export function ProductListRow({ product: p, accentTone, onPress, onMore, wide }) {
  const { colors, type } = useUIKit();
  const accent = toneColor(accentTone, colors);
  const [failed, setFailed] = useState(false);
  const meta = [p.sku, p.category].filter(Boolean).join(' · ');
  return (
    <Pressable
      onPress={onPress}
      onLongPress={onMore}
      delayLongPress={350}
      accessibilityRole={OUTER_ROLE}
      accessibilityLabel={p.name}
      style={({ pressed }) => [styles.row, { opacity: pressed ? 0.8 : 1, borderBottomColor: withAlpha(colors.text, 0.06) }]}
    >
      <View style={[styles.thumb, { borderColor: withAlpha(accent, 0.4), backgroundColor: withAlpha(accent, 0.12) }]}>
        {p.image && !failed ? (
          <Image source={{ uri: p.image }} style={StyleSheet.absoluteFill} resizeMode="cover" onError={() => setFailed(true)} />
        ) : (
          <Ionicons name={typeIcon(p.type)} size={20} color={accent} />
        )}
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
        <Text style={[type.smallStrong, { color: colors.text }]} numberOfLines={1}>{p.name}</Text>
        {p.description ? (
          <Text style={[type.caption, { color: colors.textMuted }]} numberOfLines={1}>{p.description.replace(/[#*_>`\n]+/g, ' ').trim()}</Text>
        ) : null}
        <View style={styles.rowChips}>
          <StatusBadge status={p.status} />
          {p.type ? <TypePill type={p.type} /> : null}
          {wide && meta ? <Text style={[type.monoSmall, { color: colors.textMuted }]} numberOfLines={1}>{meta}</Text> : null}
        </View>
      </View>
      <View style={styles.rowRight}>
        <Text style={[type.mono, { color: typeof p.price === 'number' ? colors.text : colors.textMuted }]}>{formatCurrency(p.price)}</Text>
        <Text style={[type.monoSmall, { color: p.inventory === 0 ? colors.error : colors.textMuted }]}>
          {typeof p.inventory === 'number' ? `${p.inventory} in stock` : '—'}
        </Text>
      </View>
      <Pressable onPress={onMore} hitSlop={8} accessibilityRole="button" accessibilityLabel={`More actions for ${p.name}`} style={styles.rowMore}>
        <Ionicons name="ellipsis-vertical" size={16} color={colors.textMuted} />
      </Pressable>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  ph: { flex: 1, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  phWatermark: { position: 'absolute', right: -10, bottom: -14 },
  phInitials: { fontWeight: '800', letterSpacing: 1 },
  media: { width: '100%', overflow: 'hidden' },
  mediaTopRow: { position: 'absolute', top: SPACE.sm, left: SPACE.sm, right: SPACE.sm, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
  mediaBottomRow: { position: 'absolute', bottom: SPACE.sm, left: SPACE.sm, right: SPACE.sm, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end', gap: SPACE.xs },
  moreBtn: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center', borderWidth: StyleSheet.hairlineWidth },
  card: { borderRadius: RADIUS.lg, borderWidth: 1, overflow: 'hidden' },
  cardBody: { padding: SPACE.md, gap: SPACE.xs },
  statsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.xs },
  miniStat: { flexDirection: 'row', gap: 4, borderWidth: StyleSheet.hairlineWidth, borderRadius: RADIUS.sm, paddingHorizontal: 6, paddingVertical: 2, maxWidth: '100%' },
  invWrap: { gap: 4 },
  invTrack: { height: 5, borderRadius: 3, overflow: 'hidden' },
  invFill: { height: '100%', borderRadius: 3 },
  footRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 2 },
  row: { flexDirection: 'row', alignItems: 'center', gap: SPACE.md, paddingVertical: SPACE.md, paddingHorizontal: SPACE.md, borderBottomWidth: StyleSheet.hairlineWidth, minHeight: 64 },
  thumb: { width: 44, height: 44, borderRadius: RADIUS.sm, borderWidth: 1, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  rowChips: { flexDirection: 'row', alignItems: 'center', gap: SPACE.xs, flexWrap: 'wrap' },
  rowRight: { alignItems: 'flex-end', gap: 3 },
  rowMore: { width: 32, height: 44, alignItems: 'center', justifyContent: 'center' },
});
