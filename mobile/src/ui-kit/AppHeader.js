/**
 * AppHeader — THE header. Consolidates PremiumHeader + SleekHeader +
 * StatusBarHeader into one configurable component.
 *
 * Variants (visual recipe, not a different API):
 *   'premium'  (default)  eyebrow / big title / subtitle / status pill /
 *                         right action row, reflective sheen + slow shimmer,
 *                         gradient bottom hairline. The oversight-grade
 *                         chrome from PremiumHeader.
 *   'nav'                 compact 3-column nav bar — left icon | centered
 *                         title-or-logo | right icon/component. The old
 *                         SleekHeader.
 *   'status'              a single dense status strip: pulsing dot + state
 *                         label on the left, meta on the right. The old
 *                         StatusBarHeader.
 *
 * Safe area: `safeArea` defaults to true and applies the top inset. Pass
 * false when the header renders BELOW a navigator header that already
 * consumed it (PremiumHeader's original callers do exactly this).
 *
 * Props
 *   variant        'premium' | 'nav' | 'status'
 *   title          string
 *   eyebrow        string           small all-caps kicker (premium)
 *   subtitle       string           (premium)
 *   statusPill     { label, color, dot? }
 *   status         'connected'|'connecting'|'disconnected'|'error'  (status)
 *   statusMeta     string           right-hand text on the status strip
 *   leftIcon       Ionicons name
 *   onLeftPress    fn
 *   leftLabel      string           a11y label for the left button
 *   rightIcon      Ionicons name    single right action (nav)
 *   onRightPress   fn
 *   rightComponent node             replaces the right slot entirely (nav)
 *   rightActions   [{ key?, icon, onPress, color?, busy?, disabled?, label? }]
 *   showLogo       boolean          render the wordmark instead of a title (nav)
 *   logoSource     ImageSource
 *   transparent    boolean          skip the glass backdrop
 *   shimmer        boolean          animated sheen (premium, default true)
 *   bottomLine     boolean          gradient hairline under the header
 *   safeArea       boolean          apply top inset (default true)
 *   children       node             extra row below the title (tabs, search)
 */

import React, { useEffect, useMemo, useRef } from 'react';
import {
  View,
  Text,
  Image,
  Animated,
  StyleSheet,
  Pressable,
  ActivityIndicator,
} from 'react-native';
import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useUIKit, SPACE, RADIUS, HIT, MOTION, blurFor } from './tokens';
import { useReducedMotion, a11yPress } from './a11y';
import { withAlpha, innerTopHighlight } from '../theme/color-utils';

const STATUS_MAP = {
  connected:    { label: 'CONNECTED', key: 'success' },
  connecting:   { label: 'CONNECTING', key: 'warning' },
  disconnected: { label: 'OFFLINE', key: 'textMuted' },
  error:        { label: 'ERROR', key: 'error' },
};

// ── Icon action button — 44x44, always labelled ───────────────────
function HeaderAction({ icon, onPress, color, busy, disabled, label, size = 20 }) {
  const { colors } = useUIKit();
  const tone = color || colors.primary;
  const off = disabled || busy;
  return (
    <Pressable
      onPress={off ? undefined : onPress}
      disabled={off}
      hitSlop={HIT.slop}
      style={({ pressed }) => [
        styles.iconBtn,
        {
          backgroundColor: withAlpha(tone, 0.12),
          borderColor: withAlpha(tone, 0.32),
          opacity: off ? 0.55 : pressed ? 0.7 : 1,
        },
      ]}
      {...a11yPress({ label: label || icon, disabled: off, busy })}
    >
      {busy ? (
        <ActivityIndicator size="small" color={tone} />
      ) : (
        <Ionicons name={icon} size={size} color={tone} />
      )}
    </Pressable>
  );
}

// ── Glass backdrop shared by premium + nav ────────────────────────
function HeaderGlass({ accent, variant, shimmerOpacity }) {
  const horizontal = variant === 'nav';
  return (
    <>
      <BlurView
        intensity={blurFor(variant === 'premium' ? 50 : 45)}
        tint="dark"
        style={StyleSheet.absoluteFill}
        pointerEvents="none"
      />
      <LinearGradient
        colors={[
          withAlpha(accent, horizontal ? 0.22 : 0.16),
          withAlpha(accent, horizontal ? 0.06 : 0.05),
          'rgba(0,0,0,0.45)',
        ]}
        start={{ x: 0, y: 0 }}
        end={horizontal ? { x: 1, y: 0 } : { x: 0, y: 1 }}
        style={StyleSheet.absoluteFill}
        pointerEvents="none"
      />
      {variant === 'premium' && (
        <LinearGradient
          colors={[withAlpha('#ffffff', 0.18), withAlpha('#ffffff', 0.05), 'transparent']}
          locations={[0, 0.45, 1]}
          start={{ x: 0, y: 0 }}
          end={{ x: 0.85, y: 0.55 }}
          style={StyleSheet.absoluteFill}
          pointerEvents="none"
        />
      )}
      {shimmerOpacity ? (
        <Animated.View
          style={[StyleSheet.absoluteFill, { opacity: shimmerOpacity }]}
          pointerEvents="none"
        >
          <LinearGradient
            colors={['transparent', withAlpha(accent, 0.18), 'transparent']}
            start={{ x: 0.1, y: 0 }}
            end={{ x: 1, y: 0.7 }}
            style={StyleSheet.absoluteFill}
          />
        </Animated.View>
      ) : null}
      <LinearGradient
        colors={innerTopHighlight}
        start={{ x: 0, y: 0 }}
        end={{ x: 0, y: 0.55 }}
        style={StyleSheet.absoluteFill}
        pointerEvents="none"
      />
    </>
  );
}

export function AppHeader({
  variant = 'premium',
  title,
  eyebrow,
  subtitle,
  statusPill,
  status,
  statusMeta = 'LIVE',
  leftIcon,
  onLeftPress,
  leftLabel,
  rightIcon,
  onRightPress,
  rightLabel,
  rightComponent,
  rightActions = [],
  showLogo = false,
  logoSource,
  transparent = false,
  shimmer = true,
  bottomLine = true,
  safeArea = true,
  style,
  children,
  testID,
}) {
  const { colors, type } = useUIKit();
  const insets = useSafeAreaInsets();
  const reduceMotion = useReducedMotion();
  const accent = colors.primary;

  const shimmerAnim = useRef(new Animated.Value(0)).current;
  const runShimmer = variant === 'premium' && shimmer && !transparent && !reduceMotion;

  useEffect(() => {
    if (!runShimmer) return undefined;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(shimmerAnim, { toValue: 1, duration: 3200, useNativeDriver: true }),
        Animated.timing(shimmerAnim, { toValue: 0, duration: 3200, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [runShimmer, shimmerAnim]);

  const shimmerOpacity = useMemo(
    () =>
      runShimmer
        ? shimmerAnim.interpolate({ inputRange: [0, 1], outputRange: [0.25, 0.7] })
        : null,
    [runShimmer, shimmerAnim],
  );

  const topPad = safeArea ? insets.top : 0;

  // ── status strip ────────────────────────────────────────────────
  if (variant === 'status') {
    const cfg = STATUS_MAP[status] || STATUS_MAP.disconnected;
    const tone = colors[cfg.key] || colors.textMuted;
    return (
      <View style={[styles.root, { paddingTop: topPad }, style]} testID={testID}>
        {!transparent && (
          <BlurView intensity={blurFor(40)} tint="dark" style={StyleSheet.absoluteFill} pointerEvents="none" />
        )}
        <View
          style={[styles.statusRow, { borderBottomColor: withAlpha(accent, 0.18) }]}
          accessible
          accessibilityRole="text"
          accessibilityLabel={`Connection ${cfg.label.toLowerCase()}`}
        >
          <View style={styles.statusLeft}>
            <View style={[styles.dot, { backgroundColor: tone }]} />
            <Text style={[type.label, { color: tone }]}>{cfg.label}</Text>
          </View>
          <Text style={[type.label, { color: colors.textMuted }]}>{statusMeta}</Text>
        </View>
      </View>
    );
  }

  // ── nav bar ─────────────────────────────────────────────────────
  if (variant === 'nav') {
    return (
      <View style={[styles.root, { paddingTop: topPad }, style]} testID={testID}>
        {!transparent && (
          <>
            <HeaderGlass accent={accent} variant="nav" shimmerOpacity={null} />
            <View
              style={[
                StyleSheet.absoluteFill,
                {
                  borderBottomWidth: StyleSheet.hairlineWidth,
                  borderBottomColor: withAlpha(accent, 0.18),
                },
              ]}
              pointerEvents="none"
            />
          </>
        )}
        <View style={styles.navRow}>
          <View style={styles.navSide}>
            {leftIcon ? (
              <HeaderAction icon={leftIcon} onPress={onLeftPress} label={leftLabel || 'Back'} size={22} />
            ) : null}
          </View>

          <View style={styles.navCenter}>
            {showLogo ? (
              <View style={styles.logoRow}>
                {logoSource ? (
                  <Image source={logoSource} style={styles.logo} resizeMode="contain" />
                ) : null}
                <Text style={[type.h2, { color: colors.text }]} numberOfLines={1}>
                  {title || 'InfiniBot'}
                </Text>
                {status ? (
                  <View
                    style={[
                      styles.dot,
                      { backgroundColor: status === 'connected' ? colors.success : colors.textMuted },
                    ]}
                  />
                ) : null}
              </View>
            ) : (
              <Text style={[type.h2, { color: colors.text }]} numberOfLines={1}>
                {title}
              </Text>
            )}
          </View>

          <View style={[styles.navSide, styles.navSideRight]}>
            {rightComponent
              || (rightIcon ? (
                <HeaderAction icon={rightIcon} onPress={onRightPress} label={rightLabel || rightIcon} size={22} />
              ) : null)}
          </View>
        </View>

        {children}

        {bottomLine ? (
          <LinearGradient
            colors={['transparent', withAlpha(accent, 0.4), 'transparent']}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 0 }}
            style={styles.bottomLine}
          />
        ) : null}
      </View>
    );
  }

  // ── premium (default) ───────────────────────────────────────────
  return (
    <View style={[styles.root, { paddingTop: topPad }, style]} testID={testID}>
      {!transparent && (
        <HeaderGlass accent={accent} variant="premium" shimmerOpacity={shimmerOpacity} />
      )}

      <View style={styles.premiumContent}>
        <View style={styles.premiumRow}>
          {leftIcon ? (
            <HeaderAction icon={leftIcon} onPress={onLeftPress} label={leftLabel || 'Back'} />
          ) : null}

          <View style={styles.premiumTextCol}>
            {eyebrow ? (
              <Text style={[type.label, { color: withAlpha(colors.text || '#fff', 0.55) }]}>
                {eyebrow}
              </Text>
            ) : null}
            <View style={styles.titleRow}>
              {title ? (
                <Text
                  style={[type.h1, styles.titleShadow, { color: colors.text || '#fff' }]}
                  numberOfLines={1}
                  accessibilityRole="header"
                >
                  {title}
                </Text>
              ) : null}
              {statusPill ? (
                <View
                  style={[
                    styles.pill,
                    {
                      backgroundColor: withAlpha(statusPill.color, 0.14),
                      borderColor: withAlpha(statusPill.color, 0.4),
                    },
                  ]}
                >
                  {statusPill.dot !== false ? (
                    <View style={[styles.dot, { backgroundColor: statusPill.color }]} />
                  ) : null}
                  <Text style={[type.caption, { color: statusPill.color }]} numberOfLines={1}>
                    {statusPill.label}
                  </Text>
                </View>
              ) : null}
            </View>
            {subtitle ? (
              <Text
                style={[type.caption, { color: withAlpha(colors.text || '#fff', 0.62) }]}
                numberOfLines={1}
              >
                {subtitle}
              </Text>
            ) : null}
          </View>

          {rightActions.length > 0 ? (
            <View style={styles.actionsRow}>
              {rightActions.map((a, i) => (
                <HeaderAction
                  key={a.key || a.icon || i}
                  icon={a.icon}
                  onPress={a.onPress}
                  color={a.color}
                  busy={a.busy}
                  disabled={a.disabled}
                  label={a.label || a.icon}
                  size={18}
                />
              ))}
            </View>
          ) : null}
        </View>

        {children}
      </View>

      {bottomLine ? (
        <LinearGradient
          colors={['transparent', withAlpha(accent, 0.55), 'transparent']}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 0 }}
          style={styles.bottomLine}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { position: 'relative', overflow: 'hidden' },

  iconBtn: {
    width: HIT.min,
    height: HIT.min,
    borderRadius: RADIUS.md,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },

  // premium
  premiumContent: {
    paddingHorizontal: SPACE.md,
    paddingTop: SPACE.md,
    paddingBottom: SPACE.md,
    gap: SPACE.md,
  },
  premiumRow: { flexDirection: 'row', alignItems: 'center', gap: SPACE.md },
  premiumTextCol: { flex: 1, gap: 2 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, flexWrap: 'wrap' },
  titleShadow: {
    textShadowColor: 'rgba(0,0,0,0.55)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 4,
    flexShrink: 1,
  },
  actionsRow: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm },

  // nav
  navRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: SPACE.sm,
    minHeight: 52,
  },
  navSide: { minWidth: HIT.min, alignItems: 'flex-start', justifyContent: 'center' },
  navSideRight: { alignItems: 'flex-end' },
  navCenter: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: SPACE.sm },
  logoRow: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm },
  logo: { width: 22, height: 22 },

  // status strip
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: SPACE.lg,
    paddingVertical: SPACE.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  statusLeft: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm },

  // shared
  dot: { width: 6, height: 6, borderRadius: 3 },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: SPACE.sm,
    paddingVertical: 3,
    borderWidth: 1,
    borderRadius: RADIUS.pill,
  },
  bottomLine: { height: 1 },
});

export { HeaderAction };
export default AppHeader;
