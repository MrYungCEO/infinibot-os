/**
 * PremiumHeader + glass control primitives.
 *
 * ⚠️  PremiumHeader itself is now a BACK-COMPAT WRAPPER over the canonical
 *     `AppHeader` in mobile/src/ui-kit. New screens must import AppHeader
 *     from '../ui-kit' instead of PremiumHeader from here.
 *
 * Still canonical in this file (not yet folded into the kit — they are the
 * screen-level composites the kit's Tabs/Field/Chip primitives compose into):
 *   GlassTabBar      pill tab bar with a sliding underline
 *   GlassSearchBar   glass search input
 *   GlassFilterChips horizontal filter-chip row
 *
 * See mobile/design-system/MASTER.md § "Consolidated header mapping".
 */

import React, { useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  TextInput,
  Animated,
  Platform,
} from 'react-native';
import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../theme/ThemeProvider';
import { withAlpha, innerTopHighlight } from '../theme/color-utils';
import { AppHeader } from '../ui-kit/AppHeader';

// ─── PremiumHeader (back-compat re-export) ──────────────────────────
//
// The canonical header is now `AppHeader` in mobile/src/ui-kit. This wrapper
// forwards the original prop surface to <AppHeader variant="premium" /> so
// existing callers (SessionsScreen, AgentsScreen, CronScreen,
// TaskActivityScreen) keep working unchanged.
//
// NEW CODE SHOULD IMPORT AppHeader FROM '../ui-kit' DIRECTLY.
//
// One deliberate behaviour difference: AppHeader applies the top safe-area
// inset by default. The original PremiumHeader did not (its callers render it
// below a navigator header that already consumed the inset), so this wrapper
// pins safeArea={false} to preserve the existing layout.

export function PremiumHeader(props) {
  return <AppHeader variant="premium" safeArea={false} {...props} />;
}

// ─── GlassTabBar ────────────────────────────────────────────────────

/**
 * Glass pill tab bar with an animated underline that slides between tabs.
 * Pass tabs as `[{ key, label, icon?, count? }, ...]`.
 */
export function GlassTabBar({ tabs, active, onSelect, style }) {
  const { colors } = useTheme();
  const accent = colors.primary;
  const indicator = useRef(new Animated.Value(0)).current;
  const widthsRef = useRef([]);
  const offsetsRef = useRef([]);
  const [, force] = useState(0);

  const activeIdx = Math.max(
    0,
    tabs.findIndex((t) => t.key === active),
  );

  useEffect(() => {
    const w = widthsRef.current[activeIdx];
    const x = offsetsRef.current[activeIdx];
    if (typeof w === 'number' && typeof x === 'number') {
      Animated.timing(indicator, {
        toValue: x,
        duration: 220,
        useNativeDriver: false,
      }).start();
    }
  }, [activeIdx, indicator]);

  const activeWidth = widthsRef.current[activeIdx] || 0;

  return (
    <View style={[styles.tabBarOuter, style]}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.tabBarInner}
      >
        {tabs.map((t, i) => {
          const isActive = t.key === active;
          return (
            <TouchableOpacity
              key={t.key}
              onPress={() => onSelect(t.key)}
              activeOpacity={0.75}
              onLayout={(e) => {
                widthsRef.current[i] = e.nativeEvent.layout.width;
                offsetsRef.current[i] = e.nativeEvent.layout.x;
                if (i === activeIdx) force((n) => n + 1);
              }}
              style={[
                styles.tabBtn,
                {
                  backgroundColor: isActive
                    ? withAlpha(accent, 0.18)
                    : withAlpha('#ffffff', 0.04),
                  borderColor: isActive
                    ? withAlpha(accent, 0.45)
                    : withAlpha('#ffffff', 0.08),
                },
              ]}
            >
              {t.icon ? (
                <Ionicons
                  name={t.icon}
                  size={14}
                  color={isActive ? accent : withAlpha(colors.text || '#fff', 0.55)}
                />
              ) : null}
              <Text
                style={[
                  styles.tabText,
                  {
                    color: isActive
                      ? accent
                      : withAlpha(colors.text || '#fff', 0.6),
                    fontWeight: isActive ? '700' : '600',
                  },
                ]}
              >
                {t.label}
              </Text>
              {typeof t.count === 'number' ? (
                <View
                  style={[
                    styles.tabCount,
                    {
                      backgroundColor: isActive
                        ? withAlpha(accent, 0.25)
                        : withAlpha('#ffffff', 0.07),
                    },
                  ]}
                >
                  <Text
                    style={[
                      styles.tabCountText,
                      {
                        color: isActive
                          ? accent
                          : withAlpha(colors.text || '#fff', 0.6),
                      },
                    ]}
                  >
                    {t.count}
                  </Text>
                </View>
              ) : null}
            </TouchableOpacity>
          );
        })}
        <Animated.View
          pointerEvents="none"
          style={[
            styles.tabIndicator,
            {
              left: indicator,
              width: activeWidth,
              backgroundColor: accent,
              shadowColor: accent,
            },
          ]}
        />
      </ScrollView>
    </View>
  );
}

// ─── GlassSearchBar ────────────────────────────────────────────────

export function GlassSearchBar({
  value,
  onChange,
  placeholder = 'Search…',
  icon = 'search-outline',
  style,
}) {
  const { colors } = useTheme();
  const accent = colors.primary;

  return (
    <View
      style={[
        styles.searchOuter,
        {
          backgroundColor: withAlpha('#000', 0.32),
          borderColor: withAlpha(accent, 0.22),
        },
        style,
      ]}
    >
      <Ionicons
        name={icon}
        size={16}
        color={withAlpha(colors.text || '#fff', 0.55)}
      />
      <TextInput
        style={[styles.searchInput, { color: colors.text || '#fff' }]}
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={withAlpha(colors.text || '#fff', 0.4)}
        underlineColorAndroid="transparent"
      />
      {value ? (
        <TouchableOpacity onPress={() => onChange('')} hitSlop={8}>
          <Ionicons
            name="close-circle"
            size={18}
            color={withAlpha(colors.text || '#fff', 0.45)}
          />
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

// ─── GlassFilterChips ──────────────────────────────────────────────

/**
 * Pass `filters` as `[{ key, label, dot? }, ...]`. The active chip gets an
 * accent fill with dark text; idle chips are translucent.
 */
export function GlassFilterChips({ filters, active, onSelect, style }) {
  const { colors } = useTheme();
  const accent = colors.primary;

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={[styles.chipsRow, style]}
      contentContainerStyle={styles.chipsContent}
    >
      {filters.map((f) => {
        const isActive = active === f.key;
        return (
          <TouchableOpacity
            key={f.key}
            onPress={() => onSelect(f.key)}
            activeOpacity={0.75}
            style={[
              styles.chip,
              isActive
                ? {
                    backgroundColor: accent,
                    borderColor: accent,
                  }
                : {
                    backgroundColor: withAlpha('#ffffff', 0.05),
                    borderColor: withAlpha('#ffffff', 0.1),
                  },
            ]}
          >
            {f.dot ? (
              <View
                style={[
                  styles.chipDot,
                  { backgroundColor: isActive ? '#000' : f.dot },
                ]}
              />
            ) : null}
            <Text
              style={[
                styles.chipText,
                {
                  color: isActive
                    ? colors.background || '#000'
                    : withAlpha(colors.text || '#fff', 0.7),
                },
              ]}
            >
              {f.label}
            </Text>
          </TouchableOpacity>
        );
      })}
    </ScrollView>
  );
}

// ─── Styles ────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  // GlassTabBar
  tabBarOuter: {
    minHeight: 44,
  },
  tabBarInner: {
    flexDirection: 'row',
    gap: 8,
    paddingVertical: 4,
    position: 'relative',
  },
  tabBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderRadius: 999,
    borderWidth: 1,
    minHeight: 36,
  },
  tabText: {
    fontSize: 12,
    letterSpacing: 0.3,
  },
  tabCount: {
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 999,
    minWidth: 18,
    alignItems: 'center',
  },
  tabCountText: {
    fontSize: 10,
    fontWeight: '700',
  },
  tabIndicator: {
    position: 'absolute',
    bottom: 0,
    height: 2,
    borderRadius: 1,
    shadowOpacity: 0.6,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 0 },
  },

  // GlassSearchBar
  searchOuter: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: Platform.OS === 'ios' ? 10 : 6,
    borderRadius: 999,
    borderWidth: 1,
    minHeight: 42,
  },
  searchInput: {
    flex: 1,
    fontSize: 14,
    padding: 0,
  },

  // GlassFilterChips
  chipsRow: {
    flexGrow: 0,
  },
  chipsContent: {
    gap: 6,
    paddingVertical: 2,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 999,
    borderWidth: 1,
  },
  chipDot: { width: 6, height: 6, borderRadius: 3 },
  chipText: {
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 0.3,
  },
});

export default PremiumHeader;
