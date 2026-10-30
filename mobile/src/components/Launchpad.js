/**
 * Launchpad — a search-centric page switcher for the whole app.
 *
 * Mobile parity for the web Launchpad (`ui/src/ui/views/launchpad.ts`): a big
 * search field over a grid of stylish cards, one per screen, grouped by the
 * section it belongs to. Type to filter, tap to navigate.
 *
 * The card list is NOT hand-maintained here. It is derived from
 * `src/navigation/screen-registry.js`, which is the same catalogue the More
 * index renders — so a screen added per MASTER.md sec 11 step 4 shows up in
 * both surfaces with no edit to this file.
 *
 * Why a raw RN <Modal> instead of the kit's <BottomSheet>:
 *   the kit sheet caps at 85% height and wraps ALL children in one scroll
 *   view. A launcher has to be search-FIRST — the field pinned while only the
 *   results scroll — and has to stay usable with the keyboard up, which needs
 *   a full-height surface. Everything inside is still kit: useUIKit colors,
 *   SPACE/RADIUS, the type scale, HIT targets, Ionicons (no emoji),
 *   useReducedMotion and a11yPress. No hex literals, no raw gaps.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  Modal,
  Pressable,
  ScrollView,
  TextInput,
  StyleSheet,
  Animated,
  Platform,
  KeyboardAvoidingView,
  useWindowDimensions,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { BlurView } from 'expo-blur';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  useUIKit,
  useReducedMotion,
  a11yPress,
  SPACE,
  RADIUS,
  HIT,
  MOTION,
  ELEVATION,
  blurFor,
  EmptyState,
} from '../ui-kit';
import { withAlpha } from '../theme/color-utils';
import {
  filterScreens,
  navigateToScreen,
  isRoutable,
} from '../navigation/screen-registry';
import { useScreenSections } from '../plugins/plugin-store';
import { launchpadStore, useLaunchpad } from '../services/launchpadStore';

// Two columns on a phone, three once there is room (large phone landscape /
// tablet). Derived from width rather than a Platform check so it follows a
// rotation.
function columnsFor(width) {
  if (width >= 900) return 4;
  if (width >= 640) return 3;
  return 2;
}

// ── One page card ────────────────────────────────────────────────

function LaunchCard({ entry, width, index, onPress, reduceMotion }) {
  const { colors, type } = useUIKit();
  const routable = isRoutable(entry);

  // Enter: 8px rise + fade, staggered. Capped by the kit's stagger window.
  //
  // Runs ONCE per mounted card. `index` is deliberately not a dependency: cards
  // are keyed by entry key, so a card that survives a keystroke keeps its
  // identity while its position in the filtered list shifts — re-running on
  // index would make every surviving card flash on every character typed. The
  // stagger delay is captured at mount instead.
  const anim = useRef(new Animated.Value(reduceMotion ? 1 : 0)).current;
  const delayRef = useRef(Math.min(index * MOTION.stagger.step, MOTION.stagger.max));
  useEffect(() => {
    if (reduceMotion) {
      anim.setValue(1);
      return undefined;
    }
    const a = Animated.timing(anim, {
      toValue: 1,
      duration: MOTION.enter,
      delay: delayRef.current,
      useNativeDriver: true,
    });
    a.start();
    return () => a.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anim, reduceMotion]);

  const iconTint = entry.highlight ? colors.primary : colors.textMuted;
  const iconBg = entry.highlight
    ? withAlpha(colors.primary, 0.12)
    : withAlpha(colors.text, 0.07);

  return (
    <Animated.View
      style={{
        width,
        opacity: anim,
        transform: [
          {
            translateY: anim.interpolate({
              inputRange: [0, 1],
              outputRange: [MOTION.rise, 0],
            }),
          },
        ],
      }}
    >
      <Pressable
        onPress={() => onPress(entry)}
        disabled={!routable}
        style={({ pressed }) => [
          styles.card,
          {
            backgroundColor: withAlpha(colors.text, 0.04),
            borderColor: entry.highlight
              ? withAlpha(colors.primary, 0.28)
              : colors.borderSubtle,
          },
          pressed && { opacity: 0.8, transform: [{ scale: 0.97 }] },
          !routable && styles.cardDisabled,
        ]}
        {...a11yPress({
          label: entry.title,
          hint: entry.desc,
          disabled: !routable,
        })}
      >
        <View style={[styles.cardIcon, { backgroundColor: iconBg }]}>
          <Ionicons name={entry.icon} size={20} color={iconTint} />
        </View>
        <Text
          style={[type.h3, { color: colors.text }, styles.cardTitle]}
          numberOfLines={1}
        >
          {entry.title}
        </Text>
        <Text
          style={[type.caption, { color: colors.textMuted }]}
          numberOfLines={2}
        >
          {entry.desc}
        </Text>
      </Pressable>
    </Animated.View>
  );
}

// ── The overlay ──────────────────────────────────────────────────

/**
 * @param navigationRef  the root NavigationContainer ref. Every catalogue entry
 *                       routes from the root (see navigateToScreen), so the
 *                       Launchpad can live outside the navigator entirely.
 */
export function Launchpad({ navigationRef, gateway, notifications }) {
  const { colors, type } = useUIKit();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const reduceMotion = useReducedMotion();
  const { open, openCount } = useLaunchpad();

  const [query, setQuery] = useState('');
  const inputRef = useRef(null);

  // Every open starts from a clean field and a focused input. Keyed on
  // openCount (not `open`) so a re-open while the exit animation is still
  // settling still resets.
  useEffect(() => {
    if (!open) return undefined;
    setQuery('');
    const t = setTimeout(() => inputRef.current?.focus(), 140);
    return () => clearTimeout(t);
  }, [open, openCount]);

  // Core catalogue + one section per enabled plugin (live: follows
  // plugins.list on every reconnect / plugin toggle).
  const catalogue = useScreenSections();
  const { sections, flat } = useMemo(
    () => filterScreens(query, catalogue),
    [query, catalogue],
  );

  const close = useCallback(() => launchpadStore.close(), []);

  const handleSelect = useCallback(
    (entry) => {
      // Close first so the overlay is not sitting on top of the destination,
      // and so a modal route (TerminalsModal etc.) presents onto a clean stack.
      launchpadStore.close();
      navigateToScreen(navigationRef?.current, entry, { gateway, notifications });
    },
    [navigationRef, gateway, notifications],
  );

  const cols = columnsFor(width);
  // Gutter on both sides + (cols - 1) inter-card gaps.
  const cardWidth =
    (width - SPACE.lg * 2 - SPACE.md * (cols - 1)) / cols;

  // Running index across all sections so the stagger reads as one sweep
  // rather than restarting per group.
  let flatIndex = 0;

  return (
    <Modal
      visible={open}
      transparent
      animationType={reduceMotion ? 'none' : 'fade'}
      onRequestClose={close}
      statusBarTranslucent
    >
      <View style={styles.root} accessibilityViewIsModal>
        {/* Backdrop — tap anywhere outside the panel to dismiss. */}
        <Pressable
          style={StyleSheet.absoluteFill}
          onPress={close}
          {...a11yPress({ label: 'Close launcher' })}
        >
          <BlurView
            intensity={blurFor(40)}
            tint="dark"
            style={StyleSheet.absoluteFill}
          />
          <View
            style={[
              StyleSheet.absoluteFill,
              { backgroundColor: withAlpha(colors.background, 0.82) },
            ]}
          />
        </Pressable>

        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={[
            styles.panel,
            {
              paddingTop: insets.top + SPACE.md,
              paddingBottom: Math.max(insets.bottom, SPACE.sm),
              maxHeight: height,
            },
          ]}
          pointerEvents="box-none"
        >
          {/* ── Search bar ─────────────────────────────────────── */}
          <View
            style={[
              styles.searchWrap,
              {
                backgroundColor: colors.inputBg,
                borderColor: withAlpha(colors.primary, 0.32),
                ...ELEVATION[2],
                shadowColor: '#000',
              },
            ]}
          >
            <Ionicons name="search" size={18} color={colors.primary} />
            <TextInput
              ref={inputRef}
              value={query}
              onChangeText={setQuery}
              placeholder="Search screens…"
              placeholderTextColor={colors.textMuted}
              autoCapitalize="none"
              autoCorrect={false}
              spellCheck={false}
              returnKeyType="go"
              onSubmitEditing={() => {
                if (flat.length) handleSelect(flat[0]);
              }}
              style={[styles.searchInput, type.h2, { color: colors.text }]}
              accessibilityLabel="Search screens"
              accessibilityHint="Type to filter, then tap a card to open that screen"
            />
            {query ? (
              <Pressable
                onPress={() => setQuery('')}
                hitSlop={HIT.slop}
                style={styles.searchAction}
                {...a11yPress({ label: 'Clear search' })}
              >
                <Ionicons name="close-circle" size={18} color={colors.textMuted} />
              </Pressable>
            ) : null}
            <Pressable
              onPress={close}
              hitSlop={HIT.slop}
              style={styles.searchAction}
              {...a11yPress({ label: 'Close launcher' })}
            >
              <Ionicons name="close" size={20} color={colors.textSecondary} />
            </Pressable>
          </View>

          {/* ── Results ────────────────────────────────────────── */}
          {flat.length === 0 ? (
            <View style={styles.emptyWrap}>
              <EmptyState
                icon="search-outline"
                title="No screens match"
                message={`Nothing in the app is called “${query.trim()}”. Try a shorter query — the search also matches a screen's description and route.`}
                actionLabel="Clear search"
                onAction={() => setQuery('')}
              />
            </View>
          ) : (
            <ScrollView
              style={styles.scroll}
              contentContainerStyle={styles.scrollContent}
              keyboardShouldPersistTaps="handled"
              keyboardDismissMode="on-drag"
              showsVerticalScrollIndicator={false}
            >
              {sections.map((section) => (
                <View key={section.title} style={styles.section}>
                  <View style={styles.sectionHead}>
                    <Text
                      style={[type.label, { color: colors.primary }]}
                      numberOfLines={1}
                    >
                      {section.title}
                    </Text>
                    <Text style={[type.monoSmall, { color: colors.textMuted }]}>
                      {section.items.length}
                    </Text>
                  </View>
                  <View style={[styles.grid, { gap: SPACE.md }]}>
                    {section.items.map((entry) => (
                      <LaunchCard
                        key={entry.key}
                        entry={entry}
                        width={cardWidth}
                        index={flatIndex++}
                        onPress={handleSelect}
                        reduceMotion={reduceMotion}
                      />
                    ))}
                  </View>
                </View>
              ))}
            </ScrollView>
          )}

          {/* ── Footer count ───────────────────────────────────── */}
          <View style={styles.foot}>
            <Text style={[type.monoSmall, { color: colors.textMuted }]}>
              {flat.length} {flat.length === 1 ? 'screen' : 'screens'}
              {query.trim() ? ` matching “${query.trim()}”` : ''}
            </Text>
          </View>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  panel: { flex: 1 },

  searchWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACE.sm,
    marginHorizontal: SPACE.lg,
    paddingHorizontal: SPACE.md,
    borderWidth: 1,
    borderRadius: RADIUS.md,
    minHeight: HIT.min + SPACE.sm,
  },
  searchInput: {
    flex: 1,
    // Vertical padding rather than a fixed height so a large system font
    // scales the field instead of clipping the text.
    paddingVertical: SPACE.md,
  },
  searchAction: {
    minWidth: HIT.min - SPACE.md,
    alignItems: 'center',
    justifyContent: 'center',
  },

  scroll: { flex: 1, marginTop: SPACE.lg },
  scrollContent: { paddingBottom: SPACE.xl },

  section: { marginBottom: SPACE.xl },
  sectionHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: SPACE.lg,
    marginBottom: SPACE.md,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    paddingHorizontal: SPACE.lg,
  },

  card: {
    borderWidth: 1,
    borderRadius: RADIUS.lg,
    padding: SPACE.md,
    // Every card is a tap target well past the 44px floor.
    minHeight: 112,
  },
  cardDisabled: { opacity: 0.45 },
  cardIcon: {
    width: 36,
    height: 36,
    borderRadius: RADIUS.md,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: SPACE.sm,
  },
  cardTitle: { marginBottom: SPACE.xs },

  emptyWrap: { flex: 1, justifyContent: 'center', paddingHorizontal: SPACE.lg },

  foot: {
    alignItems: 'center',
    paddingVertical: SPACE.sm,
  },
});

export default Launchpad;
