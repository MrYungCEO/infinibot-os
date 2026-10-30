/**
 * Chip / Badge / StatusChip / PriorityChip — the status vocabulary.
 *
 * All four render the same primitive: a pill with a NEUTRAL low-alpha fill, a
 * hairline border in the tone colour, and a 12px label in the tone colour.
 *
 * Why the fill is neutral rather than tone-tinted: a tone-tinted fill lifts
 * the backdrop luminance by an amount that scales with the tone's own
 * lightness, so the label (same tone) loses contrast exactly where it needs
 * it most. Measured across all six palettes, tone-on-its-own-wash put `error`
 * and `info` at ~3.9:1 and a neutral chip at ~3.6:1 — under the 4.5:1 floor,
 * with no lighter label able to recover it. A neutral fill gives every tone
 * the same predictable backdrop, and `ensureContrast` then guarantees the
 * label clears 4.5:1 against it for ANY master-chosen palette.
 *
 * The tone still reads: it owns the border, the dot and the text. This is
 * also strictly truer to the brand rule — gold and status colours are edges
 * and text, never fills.
 *
 * PriorityChip implements §26 of the KIS spec verbatim — the four-level
 * P0/P1/P2/P3 scale shared by every Phase 1 business object:
 *   P0 Critical (error) · P1 High (warning) · P2 Normal (info) · P3 Low (muted)
 *
 * StatusChip maps the status vocabularies actually used across the app and
 * the KIS objects (todo/in_progress/review/done/blocked, Active/Paused/…,
 * connection states) onto the palette's semantic tones. Unknown values fall
 * back to a neutral chip instead of throwing — status strings come from
 * Notion and remote objects and WILL drift.
 */

import React from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { useUIKit, SPACE, RADIUS, HIT } from './tokens';
import { a11yPress } from './a11y';
import { ensureContrast, neutralBackdrop } from './contrast';
import { withAlpha } from '../theme/color-utils';

// ── tone resolution ───────────────────────────────────────────────

export const PRIORITY_META = {
  P0: { label: 'P0 · Critical', short: 'P0', tone: 'danger' },
  P1: { label: 'P1 · High',     short: 'P1', tone: 'warning' },
  P2: { label: 'P2 · Normal',   short: 'P2', tone: 'info' },
  P3: { label: 'P3 · Low',      short: 'P3', tone: 'neutral' },
};

// Legacy priority words used by the Notion-backed kanban hook.
const PRIORITY_ALIASES = {
  critical: 'P0', immediate: 'P0', urgent: 'P0',
  high: 'P1',
  medium: 'P2', normal: 'P2',
  low: 'P3',
};

export function normalizePriority(value) {
  if (!value) return null;
  const raw = String(value).trim();
  const upper = raw.toUpperCase();
  if (PRIORITY_META[upper]) return upper;
  return PRIORITY_ALIASES[raw.toLowerCase()] || null;
}

const STATUS_TONES = {
  // kanban / task lifecycle
  backlog: 'neutral', todo: 'neutral', 'not started': 'neutral',
  in_progress: 'info', 'in progress': 'info', active: 'info', running: 'info',
  review: 'warning', 'awaiting response': 'warning', revisit: 'warning', pending: 'warning',
  done: 'success', complete: 'success', completed: 'success', shipped: 'success', won: 'success',
  blocked: 'danger', failed: 'danger', error: 'danger', lost: 'danger', overdue: 'danger',
  paused: 'neutral', archived: 'neutral', cancelled: 'neutral', draft: 'neutral',
  // connection
  connected: 'success', connecting: 'warning', disconnected: 'neutral', offline: 'neutral',
  // KIS data quality (§35) — an estimate must never look like a fact
  verified: 'success',
  founderreported: 'warning',
  operationsestimated: 'info',
  unknown: 'neutral',

  // ── KIS Phase 1 object statuses (added by the object-parity screens) ──
  // Sources: src/{opportunity,product,decision,risk,commitment,person}/types.ts.
  // These live here rather than in each screen so a status renders identically
  // wherever it appears (MASTER §9), and so an unmapped drift value still
  // degrades to a neutral chip instead of a wrong colour.
  //
  // Opportunity pipeline stages. Progressive stages read as info/warning as the
  // deal gets closer to a decision; won/lost/hold are already mapped above.
  new: 'neutral',
  qualification: 'info',
  discovery: 'info',
  evaluation: 'info',
  proposal: 'warning',
  negotiation: 'warning',
  hold: 'neutral',
  // Product status + validation stage (independent ladders — "Built ≠ Product").
  development: 'info',
  retired: 'neutral',
  idea: 'neutral',
  prototype: 'info',
  'proof of concept': 'info',
  pilot: 'info',
  'paying customer': 'success',
  'repeat sales': 'success',
  scaled: 'success',
  // Decision lifecycle. The two CEO-Queue statuses are the ones that must
  // stand out; 'Decided' is terminal-with-record.
  preparing: 'neutral',
  'ready for decision': 'warning',
  'ceo review': 'danger',
  decided: 'success',
  deferred: 'neutral',
  // Risk lifecycle. 'open' stays at warning rather than danger: severity on a
  // risk is carried by its P×I band chip, and 'open' is also a generic issue
  // status elsewhere in the app where danger would over-signal.
  open: 'warning',
  monitoring: 'info',
  mitigated: 'success',
  closed: 'neutral',
  // Commitment lifecycle ('overdue' and 'cancelled' are already mapped).
  expected: 'info',
  invoiced: 'warning',
  'partially paid': 'warning',
  paid: 'success',
  // Person lifecycle ('active' is already mapped).
  inactive: 'neutral',
  onboarding: 'info',
};

export function toneForStatus(status) {
  if (!status) return 'neutral';
  return STATUS_TONES[String(status).trim().toLowerCase()] || 'neutral';
}

export function toneColor(tone, colors) {
  switch (tone) {
    case 'success': return colors.success;
    case 'warning': return colors.warning;
    case 'danger':  return colors.error;
    case 'info':    return colors.info;
    case 'primary': return colors.primary;
    case 'accent':  return colors.accent;
    case 'neutral':
    default:        return colors.textMuted;
  }
}

// ── Chip ──────────────────────────────────────────────────────────

/**
 * Props
 *   label     string
 *   tone      'neutral'|'primary'|'accent'|'info'|'success'|'warning'|'danger'
 *   color     string   explicit tone override
 *   icon      Ionicons name
 *   dot       boolean  leading status dot instead of an icon
 *   size      'sm' | 'md'
 *   solid     boolean  slightly stronger wash (still not a full fill)
 *   selected  boolean  selected state for filter chips
 *   onPress   fn       makes the chip a tappable filter (>=44px tap area)
 *   count     number   trailing count, monospaced
 */
export function Chip({
  label,
  tone = 'neutral',
  color,
  icon,
  dot = false,
  size = 'md',
  solid = false,
  selected = false,
  onPress,
  count,
  style,
  textStyle,
  accessibilityLabel,
  testID,
}) {
  const { colors, type } = useUIKit();
  const c = color || toneColor(tone, colors);
  // Neutral fill — see the note at the top of this file. Alpha rises with
  // emphasis, but the hue never follows the tone.
  const fillAlpha = selected ? 0.14 : solid ? 0.1 : 0.07;
  const borderAlpha = selected ? 0.6 : solid ? 0.42 : 0.32;
  const fill = withAlpha(colors.text || '#ffffff', fillAlpha);
  const labelColor = ensureContrast(
    tone === 'neutral' && !color ? colors.text : c,
    neutralBackdrop(colors, fillAlpha),
    4.5,
  );

  const padV = size === 'sm' ? 3 : 5;
  const padH = size === 'sm' ? SPACE.sm : SPACE.md;

  const body = (
    <View
      style={[
        styles.chip,
        {
          paddingVertical: padV,
          paddingHorizontal: padH,
          backgroundColor: fill,
          borderColor: withAlpha(c, borderAlpha),
        },
        style,
      ]}
    >
      {dot ? <View style={[styles.dot, { backgroundColor: c }]} /> : null}
      {icon ? <Ionicons name={icon} size={size === 'sm' ? 11 : 13} color={labelColor} /> : null}
      <Text style={[type.caption, { color: labelColor }, textStyle]} numberOfLines={1}>
        {label}
      </Text>
      {count !== undefined && count !== null ? (
        <Text style={[type.monoSmall, { color: labelColor }]} numberOfLines={1}>
          {count}
        </Text>
      ) : null}
    </View>
  );

  if (!onPress) {
    return (
      <View accessible accessibilityRole="text" accessibilityLabel={accessibilityLabel || label} testID={testID}>
        {body}
      </View>
    );
  }

  return (
    <Pressable
      onPress={onPress}
      hitSlop={HIT.slop}
      testID={testID}
      style={({ pressed }) => (pressed ? { opacity: 0.7 } : null)}
      {...a11yPress({ label: accessibilityLabel || label, selected, role: 'button' })}
    >
      {body}
    </Pressable>
  );
}

/**
 * Badge — a compact count/marker. Same primitive as Chip, no icon slot,
 * monospaced so numbers of different widths line up in a list.
 */
export function Badge({ value, tone = 'primary', color, style, testID }) {
  const { colors, type } = useUIKit();
  const c = color || toneColor(tone, colors);
  const labelColor = ensureContrast(
    tone === 'neutral' && !color ? colors.text : c,
    neutralBackdrop(colors, 0.1),
    4.5,
  );
  return (
    <View
      style={[
        styles.badge,
        { backgroundColor: withAlpha(colors.text || '#ffffff', 0.1), borderColor: withAlpha(c, 0.45) },
        style,
      ]}
      accessible
      accessibilityRole="text"
      accessibilityLabel={`${value}`}
      testID={testID}
    >
      <Text style={[type.monoSmall, { color: labelColor }]} numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
}

/**
 * StatusChip — pass any status string from any object; the tone resolves
 * automatically. `label` overrides the displayed text.
 */
export function StatusChip({ status, label, size = 'md', dot = true, style, testID }) {
  const tone = toneForStatus(status);
  const text = label ?? String(status ?? 'Unknown').replace(/_/g, ' ');
  return (
    <Chip
      label={text}
      tone={tone}
      dot={dot}
      size={size}
      style={style}
      accessibilityLabel={`Status ${text}`}
      testID={testID}
    />
  );
}

/**
 * PriorityChip — §26 P0-P3. Accepts 'P0'..'P3' or the legacy words
 * (critical/high/medium/low). Renders nothing for an unrecognised value
 * rather than inventing a priority.
 */
export function PriorityChip({ priority, size = 'md', full = false, style, testID }) {
  const key = normalizePriority(priority);
  if (!key) return null;
  const meta = PRIORITY_META[key];
  return (
    <Chip
      label={full ? meta.label : meta.short}
      tone={meta.tone}
      size={size}
      solid
      style={style}
      accessibilityLabel={`Priority ${meta.label}`}
      testID={testID}
    />
  );
}

const styles = StyleSheet.create({
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    borderWidth: 1,
    borderRadius: RADIUS.pill,
    alignSelf: 'flex-start',
  },
  badge: {
    minWidth: 22,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderWidth: 1,
    borderRadius: RADIUS.pill,
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'flex-start',
  },
  dot: { width: 6, height: 6, borderRadius: 3 },
});

export default Chip;
