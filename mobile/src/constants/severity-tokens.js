/**
 * Severity tokens for the Alerts page family.
 *
 * Shared by NotificationsCenterScreen, NotificationDetailScreen, and
 * NotificationsPreferencesScreen so every list row, severity pill, badge,
 * and chip pulls colour + label + icon from a single source.
 *
 * IMPORTANT: only routes through existing theme tokens — no new palette.
 *   info     → theme.colors.info  (neutral blue)
 *   success  → theme.colors.success
 *   warn     → theme.colors.warning
 *   error    → theme.colors.error
 *   critical → theme.colors.error  (treated as a hot variant of error)
 *   subagent → theme.colors.primary at muted alpha (distinct from generic info)
 *
 * Call `getSeverityTokens(themeColors)` with the live `colors` object from
 * `useTheme()`. Returned object is plain — safe to use inline in StyleSheet
 * and JSX. Each entry exposes:
 *   - color:    the base hex/string token (use for stripes, icons, pills)
 *   - tint:     subtle rgba tint (use for icon glow circle backgrounds)
 *   - border:   tint at moderate alpha for severity chip borders
 *   - label:    short uppercase string for badge text
 *   - icon:     Ionicons name for the severity glyph
 */

import { withAlpha } from '../theme/color-utils';

export const SEVERITY_KEYS = ['info', 'success', 'warn', 'error', 'critical', 'subagent'];

const ICONS = {
  info: 'information-circle-outline',
  success: 'checkmark-circle-outline',
  warn: 'warning-outline',
  error: 'alert-circle-outline',
  critical: 'skull-outline',
  subagent: 'flash-outline',
};

const LABELS = {
  info: 'INFO',
  success: 'OK',
  warn: 'WARN',
  error: 'ERROR',
  critical: 'CRITICAL',
  subagent: 'AGENT',
};

function token(color) {
  return {
    color,
    tint: withAlpha(color, 0.15),
    border: withAlpha(color, 0.45),
  };
}

/**
 * Build the severity token table for the live theme. Pass in
 * `useTheme().colors` so palette swaps repaint every consumer.
 */
export function getSeverityTokens(colors) {
  const palette = {
    info: colors?.info ?? '#3B82F6',
    success: colors?.success ?? '#22C55E',
    warn: colors?.warning ?? '#F59E0B',
    error: colors?.error ?? '#EF4444',
    critical: colors?.error ?? '#DC2626',
    // subagent uses the brand primary so federation devices keep their
    // identity; muted alpha keeps it distinct from a louder generic info.
    subagent: colors?.primary ?? '#FFD700',
  };
  const out = {};
  for (const key of SEVERITY_KEYS) {
    out[key] = {
      ...token(palette[key]),
      label: LABELS[key],
      icon: ICONS[key],
    };
  }
  return out;
}

/**
 * Pick the severity token for a notification entry. Falls back to the
 * shared "subagent" tint when the notification came from a sub-agent
 * source even if its severity is `info`, so sub-agent rows stay visually
 * distinct from generic info pushes.
 */
export function severityKeyForNotification(notif) {
  if (!notif) return 'info';
  const sev = notif.severity || 'info';
  const cat = notif.category || '';
  const source = notif.source || '';
  const isSubagent =
    source === 'agent' ||
    cat.startsWith('agent.') ||
    notif?.data?.phase === 'spawn' ||
    notif?.data?.runId;
  if (sev === 'info' && isSubagent) return 'subagent';
  return SEVERITY_KEYS.includes(sev) ? sev : 'info';
}

/**
 * Prefer the humanized title produced by the server (`data.displayTitle`)
 * over the raw `title` field. Old notifications that don't carry the new
 * field still render via `title` — full backwards compat.
 */
export function preferredNotificationTitle(notif) {
  if (!notif) return '';
  return (notif.data && notif.data.displayTitle) || notif.title || 'Update';
}

/**
 * Prefer the structured `summary` over the freeform body when present.
 * Keeps "completed in 4m 12s · 3 files changed" rows scannable.
 */
export function preferredNotificationBody(notif) {
  if (!notif) return '';
  return (notif.data && notif.data.summary) || notif.body || '';
}
