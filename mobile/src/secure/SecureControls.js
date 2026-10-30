/**
 * Secure Mode chrome: the lock icon, the toggle, the persistent badge and the
 * accent frame shown around a screen / composer while the secure lane is on.
 *
 * Colours come from the live theme (`colors.success` is the secure accent),
 * the icon is a hairline react-native-svg glyph in the app's icon language.
 *
 * testIDs: `secure-toggle` (the Switch), `secure-toggle-row`, `secure-badge`.
 */
import React from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Switch, Text, View } from 'react-native';
import Svg, { Path, Rect } from 'react-native-svg';

import { useTheme } from '../theme/ThemeProvider';
import { withAlpha } from '../theme/color-utils';

/** The secure accent (emerald family) from the live palette. */
export function secureAccent(colors) {
  return colors?.success || colors?.primary;
}

export function useSecureAccent() {
  const { colors } = useTheme();
  return secureAccent(colors);
}

/** Accent frame for a screen root / panel while the secure lane is on. */
export function secureFrameStyle(colors, on, width = 2) {
  if (!on) return null;
  return { borderWidth: width, borderColor: withAlpha(secureAccent(colors), 0.75) };
}

export function LockIcon({ size = 16, color, open = false, strokeWidth = 1.9 }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round">
      <Rect x="4" y="11" width="16" height="10" rx="2.5" />
      <Path d={open ? 'M8 11V7a4 4 0 0 1 7.6-1.7' : 'M8 11V7a4 4 0 0 1 8 0v4'} />
      <Path d="M12 15.2v2.2" />
    </Svg>
  );
}

/** Persistent "Secure" pill (lock + label). */
export function SecureBadge({ label = 'Secure', style, compact = false, testID = 'secure-badge' }) {
  const { colors } = useTheme();
  const accent = secureAccent(colors);
  return (
    <View
      testID={testID}
      accessible
      accessibilityRole="text"
      accessibilityLabel="Secure Mode on"
      style={[
        styles.badge,
        compact && styles.badgeCompact,
        { borderColor: withAlpha(accent, 0.6), backgroundColor: withAlpha(accent, 0.14) },
        style,
      ]}
    >
      <LockIcon size={compact ? 11 : 12} color={accent} />
      {label ? <Text style={[styles.badgeText, compact && { fontSize: 10 }, { color: accent }]} numberOfLines={1}>{label}</Text> : null}
    </View>
  );
}

/**
 * Lock icon + "Secure Mode" label + Switch. Tapping the label toggles too.
 * `compact` drops the label to a short "Secure" for tight rows.
 */
export function SecureToggle({ value, onChange, busy = false, disabled = false, compact = false, label, style, testID = 'secure-toggle' }) {
  const { colors } = useTheme();
  const accent = secureAccent(colors);
  const text = label ?? (compact ? 'Secure' : 'Secure Mode');
  const off = disabled || busy;
  const flip = () => { if (!off) onChange?.(!value); };
  return (
    <View
      testID={`${testID}-row`}
      style={[
        styles.toggle,
        compact && styles.toggleCompact,
        {
          borderColor: value ? withAlpha(accent, 0.6) : colors.border,
          backgroundColor: value ? withAlpha(accent, 0.12) : withAlpha(colors.text || accent, 0.04),
          opacity: disabled ? 0.5 : 1,
        },
        style,
      ]}
    >
      <Pressable
        onPress={flip}
        disabled={off}
        hitSlop={6}
        accessibilityRole="button"
        accessibilityLabel={`${value ? 'Turn off' : 'Turn on'} Secure Mode`}
        style={styles.toggleLabel}
      >
        <LockIcon size={compact ? 14 : 16} color={value ? accent : colors.textMuted} open={!value} />
        <Text style={[styles.toggleText, compact && { fontSize: 12 }, { color: value ? accent : colors.text }]} numberOfLines={1}>{text}</Text>
      </Pressable>
      {busy ? <ActivityIndicator size="small" color={accent} style={styles.spin} /> : null}
      <Switch
        testID={testID}
        value={Boolean(value)}
        onValueChange={(v) => onChange?.(v)}
        disabled={off}
        trackColor={{ false: withAlpha(colors.text || accent, 0.2), true: withAlpha(accent, 0.55) }}
        thumbColor={value ? accent : colors.textMuted}
        activeThumbColor={accent}
        accessibilityRole="switch"
        accessibilityLabel="Secure Mode"
        accessibilityState={{ checked: Boolean(value), disabled: off }}
        style={compact ? styles.switchCompact : null}
      />
    </View>
  );
}

/** A one-line error under a toggle (secure.set failures, no keyring key, …). */
export function SecureError({ text, onDismiss, style }) {
  const { colors } = useTheme();
  if (!text) return null;
  return (
    <Pressable
      onPress={onDismiss}
      accessibilityRole="alert"
      accessibilityLabel={`${text}. Dismiss`}
      testID="secure-error"
      style={[styles.err, { borderColor: withAlpha(colors.error, 0.6), backgroundColor: withAlpha(colors.error, 0.12) }, style]}
    >
      <Text style={{ color: colors.error, fontSize: 12, flex: 1 }}>{text}</Text>
    </Pressable>
  );
}

/**
 * A slim header strip for screens without a header slot of their own:
 * [Secure badge while on] · title/hint · [toggle], plus the last error.
 * `secure` is the useSecureMode() result.
 */
export function SecureModeBar({ secure, connected = true, title, style }) {
  const { colors } = useTheme();
  if (!secure?.supported) return null;
  const on = secure.enabled;
  return (
    <View style={[styles.bar, style]} testID="secure-bar">
      <View style={styles.barRow}>
        {on ? <SecureBadge /> : null}
        <Text style={[styles.barText, { color: on ? colors.text : colors.textMuted }]} numberOfLines={1}>
          {title || (on ? 'Secure lane: encrypted, local-only' : 'Normal lane')}
        </Text>
        <SecureToggle
          compact
          value={on}
          busy={secure.busy}
          disabled={!connected}
          onChange={(v) => void secure.setEnabled(v)}
        />
      </View>
      <SecureError text={secure.error} onDismiss={secure.clearError} />
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { gap: 6, paddingHorizontal: 12, paddingVertical: 6 },
  barRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  barText: { flex: 1, fontSize: 12, fontWeight: '500' },
  badge: { flexDirection: 'row', alignItems: 'center', gap: 4, borderWidth: 1, borderRadius: 999, paddingHorizontal: 8, height: 24, alignSelf: 'flex-start' },
  badgeCompact: { height: 20, paddingHorizontal: 6 },
  badgeText: { fontSize: 11, fontWeight: '700', letterSpacing: 0.4 },
  toggle: { flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 1, borderRadius: 12, paddingLeft: 10, paddingRight: 6, minHeight: 44 },
  toggleCompact: { minHeight: 36, borderRadius: 999, paddingLeft: 8, gap: 4 },
  toggleLabel: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 36, flexShrink: 1 },
  toggleText: { fontSize: 13, fontWeight: '600' },
  spin: { marginHorizontal: 2 },
  switchCompact: { transform: [{ scale: 0.85 }] },
  err: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8 },
});
