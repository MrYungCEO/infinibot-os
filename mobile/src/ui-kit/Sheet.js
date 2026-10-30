/**
 * BottomSheet + Modal — the two overlay surfaces.
 *
 * BottomSheet slides up from the bottom, respects the bottom safe-area inset,
 * caps at `maxHeightRatio` of the screen, and dismisses on backdrop tap or a
 * downward drag on the grabber. Modal is a centered card for short
 * confirmations.
 *
 * Both:
 *   - exit animates faster than enter (160ms vs 260ms) so dismissal feels
 *     instant while entry still reads as deliberate
 *   - honour reduce-motion by snapping instead of tweening
 *   - handle the Android hardware back button via RN's Modal onRequestClose
 *   - trap the screen reader inside the overlay via accessibilityViewIsModal
 *
 * Props (BottomSheet)
 *   visible / onClose        required
 *   title / subtitle
 *   headerRight              node in the header's right slot
 *   maxHeightRatio           0..1, default 0.85
 *   scroll                   wrap children in a ScrollView (default true)
 *   dismissible              backdrop tap + drag closes (default true)
 *   footer                   pinned action row under the content
 *   side                     true → a full-height sheet docked to the right
 *                            edge (landscape); drag right to dismiss
 *   sideWidth                width of the side sheet (default 420, ≤ 55% of the screen)
 *
 * Both overlays allow every orientation (RN's Modal defaults to portrait on
 * iOS, which would force-rotate a landscape screen); the app-level portrait
 * lock still keeps portrait-only screens portrait.
 */

export const ALL_ORIENTATIONS = ['portrait', 'portrait-upside-down', 'landscape', 'landscape-left', 'landscape-right'];

import React, { useCallback, useEffect, useRef } from 'react';
import {
  View,
  Text,
  Modal as RNModal,
  Animated,
  Pressable,
  ScrollView,
  PanResponder,
  StyleSheet,
  useWindowDimensions,
  Platform,
} from 'react-native';
import { BlurView } from 'expo-blur';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useUIKit, SPACE, RADIUS, MOTION, blurFor } from './tokens';
import { useReducedMotion } from './a11y';
import { Card } from './Card';
import { IconButton } from './Button';
import { withAlpha } from '../theme/color-utils';

function useOverlayAnim(visible, reduceMotion) {
  const progress = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (reduceMotion) {
      progress.setValue(visible ? 1 : 0);
      return undefined;
    }
    const anim = Animated.timing(progress, {
      toValue: visible ? 1 : 0,
      duration: visible ? MOTION.enter : MOTION.exit,
      useNativeDriver: true,
    });
    anim.start();
    return () => anim.stop();
  }, [visible, reduceMotion, progress]);
  return progress;
}

export function BottomSheet({
  visible,
  onClose,
  title,
  subtitle,
  headerRight,
  children,
  footer,
  maxHeightRatio = 0.85,
  scroll = true,
  dismissible = true,
  side = false,
  sideWidth = 420,
  testID,
}) {
  const { colors, type } = useUIKit();
  const insets = useSafeAreaInsets();
  const { height: screenH, width: screenW } = useWindowDimensions();
  const sideW = Math.min(sideWidth, screenW * 0.55);
  const sideRef = useRef(side);
  sideRef.current = side;
  const reduceMotion = useReducedMotion();
  const progress = useOverlayAnim(visible, reduceMotion);
  const drag = useRef(new Animated.Value(0)).current;

  const close = useCallback(() => {
    if (dismissible) onClose?.();
  }, [dismissible, onClose]);

  const pan = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, g) =>
        sideRef.current
          ? dismissible && g.dx > 6 && Math.abs(g.dx) > Math.abs(g.dy)
          : dismissible && g.dy > 6 && Math.abs(g.dy) > Math.abs(g.dx),
      onPanResponderMove: (_, g) => {
        const d = sideRef.current ? g.dx : g.dy;
        if (d > 0) drag.setValue(d);
      },
      onPanResponderRelease: (_, g) => {
        const d = sideRef.current ? g.dx : g.dy;
        const v = sideRef.current ? g.vx : g.vy;
        if (d > 90 || v > 1.2) {
          onClose?.();
          drag.setValue(0);
        } else {
          Animated.spring(drag, { toValue: 0, useNativeDriver: true, bounciness: 0 }).start();
        }
      },
    }),
  ).current;

  useEffect(() => {
    if (visible) drag.setValue(0);
  }, [visible, drag]);

  const translateY = Animated.add(
    progress.interpolate({ inputRange: [0, 1], outputRange: [screenH * 0.35, 0] }),
    drag,
  );
  const translateX = Animated.add(
    progress.interpolate({ inputRange: [0, 1], outputRange: [sideW * 0.6, 0] }),
    drag,
  );

  return (
    <RNModal
      visible={visible}
      transparent
      animationType="none"
      onRequestClose={close}
      statusBarTranslucent
      supportedOrientations={ALL_ORIENTATIONS}
      testID={testID}
    >
      <View style={styles.fill} accessibilityViewIsModal>
        <Animated.View style={[StyleSheet.absoluteFill, { opacity: progress }]}>
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={close}
            accessibilityRole="button"
            accessibilityLabel="Close"
            disabled={!dismissible}
          >
            {Platform.OS === 'ios' ? (
              <BlurView intensity={blurFor(24)} tint="dark" style={StyleSheet.absoluteFill} />
            ) : null}
            <View style={[StyleSheet.absoluteFill, styles.scrim]} />
          </Pressable>
        </Animated.View>

        <Animated.View
          style={[
            side
              ? [
                  styles.sideWrap,
                  {
                    width: sideW + insets.right,
                    paddingTop: Math.max(insets.top, SPACE.sm),
                    paddingBottom: Math.max(insets.bottom, SPACE.sm),
                    paddingRight: insets.right,
                    opacity: progress,
                    transform: [{ translateX }],
                  },
                ]
              : {
                  ...styles.sheetWrap,
                  maxHeight: screenH * maxHeightRatio,
                  paddingBottom: insets.bottom,
                  opacity: progress,
                  transform: [{ translateY }],
                },
          ]}
        >
          <Card
            depth={3}
            radius={RADIUS.xl}
            intensity={70}
            style={[
              side ? [styles.sheet, styles.sideSheet] : [styles.sheet, { maxHeight: screenH * maxHeightRatio }],
              // Only iOS gets a real backdrop blur; elsewhere (web, Android) the
              // glass fill alone let the screen behind show through the options.
              Platform.OS !== 'ios' && colors.background ? { backgroundColor: withAlpha(colors.background, 0.94) } : null,
            ]}
          >
            <View {...pan.panHandlers} style={styles.grabZone}>
              <View style={[styles.grabber, { backgroundColor: withAlpha(colors.text || '#fff', 0.25) }]} />
            </View>

            {title || headerRight ? (
              <View style={styles.header}>
                <View style={styles.headerText}>
                  {title ? (
                    <Text style={[type.h2, { color: colors.text }]} numberOfLines={1} accessibilityRole="header">
                      {title}
                    </Text>
                  ) : null}
                  {subtitle ? (
                    <Text style={[type.caption, { color: colors.textSecondary }]} numberOfLines={2}>
                      {subtitle}
                    </Text>
                  ) : null}
                </View>
                {headerRight}
                {dismissible ? (
                  <IconButton icon="close" onPress={onClose} size="sm" accessibilityLabel="Close" />
                ) : null}
              </View>
            ) : null}

            {scroll ? (
              <ScrollView
                style={side ? [styles.body, styles.sideBody] : styles.body}
                contentContainerStyle={styles.bodyContent}
                keyboardShouldPersistTaps="handled"
                showsVerticalScrollIndicator={false}
              >
                {children}
              </ScrollView>
            ) : (
              <View style={[styles.body, styles.bodyContent]}>{children}</View>
            )}

            {footer ? <View style={styles.footer}>{footer}</View> : null}
          </Card>
        </Animated.View>
      </View>
    </RNModal>
  );
}

/**
 * Modal — centered card. Use for confirmations and short forms; anything
 * scrollable or list-shaped belongs in a BottomSheet.
 */
export function Modal({
  visible,
  onClose,
  title,
  subtitle,
  children,
  footer,
  dismissible = true,
  width = 340,
  testID,
}) {
  const { colors, type } = useUIKit();
  const reduceMotion = useReducedMotion();
  const progress = useOverlayAnim(visible, reduceMotion);

  const scale = progress.interpolate({ inputRange: [0, 1], outputRange: [0.96, 1] });

  return (
    <RNModal
      visible={visible}
      transparent
      animationType="none"
      onRequestClose={dismissible ? onClose : undefined}
      statusBarTranslucent
      supportedOrientations={ALL_ORIENTATIONS}
      testID={testID}
    >
      <View style={[styles.fill, styles.center]} accessibilityViewIsModal>
        <Animated.View style={[StyleSheet.absoluteFill, { opacity: progress }]}>
          <Pressable
            style={[StyleSheet.absoluteFill, styles.scrim]}
            onPress={dismissible ? onClose : undefined}
            accessibilityRole="button"
            accessibilityLabel="Close"
            disabled={!dismissible}
          />
        </Animated.View>

        <Animated.View style={{ opacity: progress, transform: [{ scale }], width, maxWidth: '92%' }}>
          <Card depth={3} radius={RADIUS.lg} padded={SPACE.lg}>
            {title ? (
              <View style={styles.modalHead}>
                <View style={styles.headerText}>
                  <Text style={[type.h2, { color: colors.text }]} accessibilityRole="header">
                    {title}
                  </Text>
                  {subtitle ? (
                    <Text style={[type.caption, { color: colors.textSecondary }]}>{subtitle}</Text>
                  ) : null}
                </View>
                {dismissible ? (
                  <IconButton icon="close" onPress={onClose} size="sm" accessibilityLabel="Close" />
                ) : null}
              </View>
            ) : null}
            {children}
            {footer ? <View style={styles.modalFooter}>{footer}</View> : null}
          </Card>
        </Animated.View>
      </View>
    </RNModal>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, justifyContent: 'flex-end' },
  center: { justifyContent: 'center', alignItems: 'center' },
  scrim: { backgroundColor: 'rgba(0,0,0,0.6)' },
  sheetWrap: { width: '100%' },
  sheet: { marginHorizontal: SPACE.sm, overflow: 'hidden' },
  sideWrap: { position: 'absolute', top: 0, bottom: 0, right: 0 },
  sideSheet: { flex: 1 },
  sideBody: { flexGrow: 1, flexShrink: 1, flexBasis: 0 },
  grabZone: { alignItems: 'center', paddingTop: SPACE.sm, paddingBottom: SPACE.xs },
  grabber: { width: 40, height: 4, borderRadius: 2 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACE.md,
    paddingHorizontal: SPACE.lg,
    paddingBottom: SPACE.md,
  },
  headerText: { flex: 1, gap: 2 },
  body: { flexGrow: 0 },
  bodyContent: { paddingHorizontal: SPACE.lg, paddingBottom: SPACE.lg, gap: SPACE.md },
  footer: {
    flexDirection: 'row',
    gap: SPACE.sm,
    paddingHorizontal: SPACE.lg,
    paddingTop: SPACE.md,
    paddingBottom: SPACE.lg,
  },
  modalHead: { flexDirection: 'row', alignItems: 'center', gap: SPACE.md, marginBottom: SPACE.md },
  modalFooter: { flexDirection: 'row', gap: SPACE.sm, marginTop: SPACE.lg, justifyContent: 'flex-end' },
});

export default BottomSheet;
