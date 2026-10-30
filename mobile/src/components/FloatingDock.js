/**
 * FloatingDock — glassmorphic floating tab bar.
 *
 * Drop this in as the `tabBar` prop of Tab.Navigator:
 *   <Tab.Navigator tabBar={(props) => <FloatingDock {...props} />}>
 *
 * The dock is absolutely positioned so it floats above content.
 * Import DOCK_BOTTOM_SPACE and add it as scrollView contentContainerStyle
 * paddingBottom on screens whose content would otherwise hide behind the dock.
 *
 * Design:
 *  - Pill shape, 24px gap from all 3 screen edges
 *  - BlurView + dark tint + top-highlight gradient + asymmetric border
 *  - Outer gold glow ring (low opacity)
 *  - Each tab icon in a circular button; active → gold ring + scale-up (Reanimated spring)
 *  - Android: blur capped at 65; glow reduced
 */

import { CHAT_TABLET_MIN, CHAT_SIDE_WIDTH } from '../chat/layout';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View,
  TouchableOpacity,
  StyleSheet,
  Platform,
  useWindowDimensions,
  Vibration,
} from 'react-native';
import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { COLORS } from '../constants/theme';
import { useTheme } from '../theme/ThemeProvider';
import { DockCustomizeModal, tabLabel } from './DockCustomizeModal';
import { launchpadStore } from '../services/launchpadStore';
import { InfinityGlyph } from '../infini/icons';

// ─── persistence ────────────────────────────────────────────────────────────
// Ordered array of route names that should appear in the dock. `null` (or
// missing) means "fall back to the default order — every registered route".
export const DOCK_SELECTION_STORAGE_KEY = '@infinibot/dock/quickNavItems';
const DOCK_MAX_ITEMS = 5;

// ── rgba helper ─────────────────────────────────────────────────────────────
// Theme colors arrive as `#rrggbb` (most palettes), but a few tokens come
// through as `rgb(...)` / `rgba(...)`. Both must be alpha-able here so the
// dock tint follows the live palette without crashing on edge formats.
function withAlpha(color, alpha) {
  if (!color) return `rgba(255,255,255,${alpha})`;
  if (color.startsWith('#')) {
    let hex = color.slice(1);
    if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('');
    const num = parseInt(hex, 16);
    const r = (num >> 16) & 0xff;
    const g = (num >> 8) & 0xff;
    const b = num & 0xff;
    return `rgba(${r},${g},${b},${alpha})`;
  }
  const rgbMatch = color.match(/^rgba?\(([^)]+)\)$/);
  if (rgbMatch) {
    const [r, g, b] = rgbMatch[1].split(',').map((p) => p.trim());
    return `rgba(${r},${g},${b},${alpha})`;
  }
  return color;
}

// ─── sizing constants (exported so screens can add scroll padding) ──────────
export const DOCK_HEIGHT         = 66;
export const DOCK_H_MARGIN       = 22;   // left + right gap from screen edge
export const DOCK_V_MARGIN_BASE  = 20;   // minimum gap below dock from safe area
export const DOCK_RADIUS         = 34;   // pill shape

// Total bottom space a scrollable screen should pad by
// (actual safe-area insets are added at render time, so this is the fixed part)
export const DOCK_BOTTOM_SPACE = DOCK_HEIGHT + DOCK_V_MARGIN_BASE + 12;

// ─── icon map ────────────────────────────────────────────────────────────────
// Exported so DockCustomizeModal can render the same icons for each route.
export const TAB_ICONS = {
  Chat:      { lib: 'ion', active: 'chatbubble-ellipses',         inactive: 'chatbubble-ellipses-outline' },
  Board:     { lib: 'mci', active: 'view-column',                 inactive: 'view-column-outline' },
  Dashboard: { lib: 'ion', active: 'grid',                        inactive: 'grid-outline' },
  Business:  { lib: 'ion', active: 'briefcase',                   inactive: 'briefcase-outline' },
  VoiceCall: { lib: 'ion', active: 'mic',                         inactive: 'mic-outline' }, // InfiniBot call page (drawn as the gold ∞ orb)
  Knowledge: { lib: 'ion', active: 'library',                     inactive: 'library-outline' },
  More:      { lib: 'ion', active: 'apps',                        inactive: 'apps-outline' },
};

// ─── single tab button ───────────────────────────────────────────────────────
function DockTab({ route, isFocused, onPress, onLongPress, primary }) {
  // The call button is the app's front door to InfiniBot: a gold ∞ orb.
  if (route.name === 'VoiceCall') {
    return (
      <TouchableOpacity
        onPress={onPress}
        onLongPress={onLongPress}
        activeOpacity={0.72}
        style={styles.tabTouch}
        accessibilityRole="button"
        accessibilityLabel="Talk to InfiniBot"
        testID="dock-infinibot"
      >
        <View style={styles.tabInner}>
          <LinearGradient
            colors={['#fbe6a2', '#e9b949', '#a8762c']}
            start={{ x: 0.2, y: 0 }}
            end={{ x: 0.8, y: 1 }}
            style={styles.infiniOrb}
          >
            <InfinityGlyph size={24} color="#1a1206" strokeWidth={2.4} />
          </LinearGradient>
        </View>
      </TouchableOpacity>
    );
  }
  const cfg   = TAB_ICONS[route.name] || { lib: 'ion', active: 'ellipse', inactive: 'ellipse-outline' };

  const IconLib = cfg.lib === 'mci' ? MaterialCommunityIcons : Ionicons;
  const iconName = isFocused ? cfg.active : cfg.inactive;
  const iconColor = isFocused ? primary : 'rgba(255,255,255,0.38)';

  return (
    <TouchableOpacity
      onPress={onPress}
      onLongPress={onLongPress}
      activeOpacity={0.72}
      style={styles.tabTouch}
      accessibilityRole="tab"
      accessibilityState={{ selected: isFocused }}
      accessibilityLabel={tabLabel(route.name)}
    >
      <View style={styles.tabInner}>
        {isFocused && (
          <View style={styles.activeRing}>
            <LinearGradient
              colors={[
                withAlpha(primary, 0.32),
                withAlpha(primary, 0.10),
              ]}
              start={{ x: 0.5, y: 0 }}
              end={{ x: 0.5, y: 1 }}
              style={StyleSheet.absoluteFill}
            />
            <View style={[styles.activeRingBorder, { borderColor: withAlpha(primary, 0.65) }]} />
          </View>
        )}

        <View style={isFocused ? styles.iconFocused : null}>
          <IconLib name={iconName} size={22} color={iconColor} />
        </View>
      </View>
    </TouchableOpacity>
  );
}

// ─── launcher button ─────────────────────────────────────────────────────────
/**
 * Opens the Launchpad (the search-centric page switcher). It sits in the dock
 * pill but OUTSIDE the tab row, behind a hairline divider, because it is an
 * ACTION and not a destination — the dock's <=5 destination cap
 * (design-system/MASTER.md sec 8) counts tabs, and burning one of them on a
 * launcher would cost the user a real screen.
 */
function DockLauncher({ primary, onPress }) {
  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.72}
      style={styles.launcherTouch}
      accessibilityRole="button"
      accessibilityLabel="Open launcher"
      accessibilityHint="Search every screen in the app and jump to one"
    >
      <View style={[styles.launcherDivider, { backgroundColor: withAlpha(primary, 0.22) }]} />
      <View style={[styles.launcherInner, { borderColor: withAlpha(primary, 0.45) }]}>
        <LinearGradient
          colors={[withAlpha(primary, 0.26), withAlpha(primary, 0.06)]}
          start={{ x: 0.5, y: 0 }}
          end={{ x: 0.5, y: 1 }}
          style={StyleSheet.absoluteFill}
        />
        <Ionicons name="search" size={19} color={primary} />
      </View>
    </TouchableOpacity>
  );
}

// ─── dock container ──────────────────────────────────────────────────────────
export function FloatingDock({ state, descriptors, navigation }) {
  const insets = useSafeAreaInsets();
  const blurIntensity = Platform.OS === 'android' ? 62 : 82;
  // Live theme primary — re-renders when the palette swaps via branding.update.
  const { colors } = useTheme();
  const primary = colors?.primary || COLORS.primary;

  // Position: safe area bottom + fixed margin
  const dockBottom = Math.max(insets.bottom, 8) + DOCK_V_MARGIN_BASE;
  // Width follows the window (rotation, split view, tablets) instead of the
  // size the screen had at launch.
  const { width: windowWidth } = useWindowDimensions();
  // On tablets the Chat tab docks its chats list on the left; centre the dock
  // in the conversation pane so it never covers that list.
  const sideInset =
    windowWidth >= CHAT_TABLET_MIN && state.routes[state.index]?.name === 'Chat' ? CHAT_SIDE_WIDTH : 0;
  const lane = windowWidth - insets.left - insets.right - sideInset;
  const dockWidth = Math.min(lane - DOCK_H_MARGIN * 2, DOCK_MAX_WIDTH);
  const dockLeft = insets.left + sideInset + (lane - dockWidth) / 2;

  // ─── customize: persisted ordered list of route names to show ──────────────
  // `null` until we load (or if nothing is saved), in which case we render
  // every registered route in its default order.
  const [selection, setSelection] = useState(null);
  const [modalVisible, setModalVisible] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const raw = await AsyncStorage.getItem(DOCK_SELECTION_STORAGE_KEY);
        if (!alive || !raw) return;
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0) {
          setSelection(parsed.filter((n) => typeof n === 'string'));
        }
      } catch (_) {
        // Corrupt entry — ignore and use defaults.
      }
    })();
    return () => { alive = false; };
  }, []);

  // Routes actually rendered in the dock: filter + reorder by `selection`.
  // Any saved name that's no longer a registered route is dropped silently
  // so removing a Tab.Screen doesn't leave a phantom slot.
  const visibleRoutes = useMemo(() => {
    if (!selection || selection.length === 0) return state.routes;
    const byName = new Map(state.routes.map((r) => [r.name, r]));
    const filtered = selection.map((n) => byName.get(n)).filter(Boolean);
    return filtered.length > 0 ? filtered : state.routes;
  }, [state.routes, selection]);

  // What the modal treats as "currently selected" — derived so it reflects
  // any future renames of the underlying routes.
  const effectiveSelection = useMemo(
    () => visibleRoutes.map((r) => r.name),
    [visibleRoutes],
  );

  const persistSelection = useCallback(async (next) => {
    setSelection(next);
    try {
      await AsyncStorage.setItem(DOCK_SELECTION_STORAGE_KEY, JSON.stringify(next));
    } catch (_) {}
  }, []);

  const handleReset = useCallback(async () => {
    setSelection(null);
    try {
      await AsyncStorage.removeItem(DOCK_SELECTION_STORAGE_KEY);
    } catch (_) {}
  }, []);

  const openCustomize = useCallback(() => {
    // Light tactile cue — Vibration ships with react-native (no extra dep).
    try { Vibration.vibrate(12); } catch (_) {}
    setModalVisible(true);
  }, []);

  const iconForRoute = useCallback((routeName) => TAB_ICONS[routeName] || null, []);

  // Track the focused route by key so filtering doesn't desync the highlight.
  const focusedRouteKey = state.routes[state.index]?.key;

  // A screen can go immersive (React Navigation convention): the focused tab
  // sets tabBarStyle.display = 'none' — e.g. the Knowledge Graph in landscape.
  if (descriptors?.[focusedRouteKey]?.options?.tabBarStyle?.display === 'none') return null;

  return (
    // pointerEvents="box-none" lets taps on the transparent surroundings
    // fall through to the screen content behind the dock.
    <View
      style={[styles.positioner, { bottom: dockBottom, width: dockWidth, left: dockLeft }]}
      pointerEvents="box-none"
    >
      {/* Outer glow ring — tinted by the active palette */}
      <View
        style={[styles.outerGlow, { shadowColor: primary }]}
        pointerEvents="none"
      />

      {/* Shadow wrapper: has iOS shadow + elevation but NO overflow clip */}
      <View style={styles.shadowWrap}>
        {/* Clip wrapper: rounded pill, clips the BlurView blur effect */}
        <View style={styles.clipWrap}>
          <BlurView intensity={blurIntensity} tint="dark" style={StyleSheet.absoluteFill} />

          {/* Dark tint overlay */}
          <View style={[StyleSheet.absoluteFill, styles.tintOverlay]} />

          {/* Theme-primary fill gradient — top-down wash that re-tints with the
              active palette. Sits behind the highlight + inner shadow so the
              glass effect stays intact. */}
          <LinearGradient
            colors={[
              withAlpha(primary, 0.18),
              withAlpha(primary, 0.04),
              'rgba(0,0,0,0.6)',
            ]}
            start={{ x: 0, y: 0 }}
            end={{ x: 0, y: 1 }}
            style={StyleSheet.absoluteFill}
          />

          {/* Top-edge highlight gradient — creates glass "lift" */}
          <LinearGradient
            colors={['rgba(255,255,255,0.09)', 'rgba(255,255,255,0.00)']}
            start={{ x: 0, y: 0 }}
            end={{ x: 0, y: 0.6 }}
            style={StyleSheet.absoluteFill}
          />

          {/* Bottom inner shadow for depth */}
          <LinearGradient
            colors={['rgba(0,0,0,0.00)', 'rgba(0,0,0,0.30)']}
            start={{ x: 0, y: 0.5 }}
            end={{ x: 0, y: 1 }}
            style={StyleSheet.absoluteFill}
          />

          {/* Asymmetric border */}
          <View style={[StyleSheet.absoluteFill, styles.border]} />

          {/* Tab row */}
          <View style={styles.tabRow}>
            {visibleRoutes.map((route) => {
              const isFocused = focusedRouteKey === route.key;

              const onPress = () => {
                const event = navigation.emit({
                  type: 'tabPress',
                  target: route.key,
                  canPreventDefault: true,
                });
                if (!isFocused && !event.defaultPrevented) {
                  navigation.navigate({ name: route.name, merge: true });
                }
              };

              // Long-press on any tab opens the customize modal. The original
              // `tabLongPress` emit had no listeners, so repurposing it here
              // is safe.
              return (
                <DockTab
                  key={route.key}
                  route={route}
                  isFocused={isFocused}
                  onPress={onPress}
                  onLongPress={openCustomize}
                  primary={primary}
                />
              );
            })}

            {/* Page launcher — an action, not a destination (see DockLauncher). */}
            <DockLauncher primary={primary} onPress={() => launchpadStore.open()} />
          </View>
        </View>
      </View>

      <DockCustomizeModal
        visible={modalVisible}
        onClose={() => setModalVisible(false)}
        allRoutes={state.routes}
        selection={effectiveSelection}
        onChange={persistSelection}
        onReset={handleReset}
        maxItems={DOCK_MAX_ITEMS}
        iconForRoute={iconForRoute}
      />
    </View>
  );
}

// Widest the dock grows on tablets / landscape; it stays centred.
export const DOCK_MAX_WIDTH = 560;

const styles = StyleSheet.create({
  infiniOrb: {
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#e9b949',
    shadowOpacity: 0.55,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 0 },
    elevation: 6,
  },
  positioner: {
    position: 'absolute',
  },

  outerGlow: {
    position: 'absolute',
    top:    -6,
    left:   -6,
    right:  -6,
    bottom: -6,
    borderRadius: DOCK_RADIUS + 6,
    // A very soft gold ring using shadow on iOS; not visible on Android.
    shadowColor:   COLORS.primary,
    shadowOffset:  { width: 0, height: 0 },
    shadowOpacity: Platform.OS === 'ios' ? 0.18 : 0,
    shadowRadius:  12,
  },

  shadowWrap: {
    borderRadius: DOCK_RADIUS,
    shadowColor:   '#000',
    shadowOffset:  { width: 0, height: 14 },
    shadowOpacity: 0.55,
    shadowRadius:  28,
    elevation:     22,
  },

  clipWrap: {
    height:       DOCK_HEIGHT,
    borderRadius: DOCK_RADIUS,
    overflow:     'hidden',
    // Android fallback background (shown when BlurView renders dimly)
    backgroundColor: Platform.OS === 'android' ? 'rgba(10,10,16,0.88)' : 'transparent',
  },

  tintOverlay: {
    backgroundColor: 'rgba(10,10,18,0.52)',
  },

  border: {
    borderWidth:        1,
    borderTopColor:     'rgba(255,255,255,0.14)',
    borderLeftColor:    'rgba(255,255,255,0.05)',
    borderRightColor:   'rgba(255,255,255,0.05)',
    borderBottomColor:  'rgba(255,255,255,0.03)',
    borderRadius:       DOCK_RADIUS,
  },

  tabRow: {
    flexDirection: 'row',
    flex:          1,
    alignItems:    'center',
    paddingHorizontal: 8,
  },

  tabTouch: {
    flex: 1,
    alignItems:  'center',
    justifyContent: 'center',
    height: DOCK_HEIGHT,
  },

  tabInner: {
    width:  48,
    height: 48,
    alignItems:     'center',
    justifyContent: 'center',
    position: 'relative',
  },

  activeRing: {
    position:     'absolute',
    width:  48,
    height: 48,
    borderRadius: 24,
    overflow:     'hidden',
  },

  iconFocused: {
    transform: [{ scale: 1.18 }],
  },

  // ── Launcher (trailing action) ──
  launcherTouch: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    // Fixed width (not flex) so adding the launcher never squeezes the tabs.
    width: 52,
    height: DOCK_HEIGHT,
    paddingLeft: 4,
  },
  launcherDivider: {
    width: 1,
    height: 24,
    marginRight: 8,
    borderRadius: 1,
  },
  launcherInner: {
    width: 36,
    height: 36,
    borderRadius: 18,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },

  activeRingBorder: {
    ...StyleSheet.absoluteFillObject,
    borderWidth: 1.5,
    borderColor: COLORS.primaryStrong,
    borderRadius: 24,
  },
});

export default FloatingDock;
