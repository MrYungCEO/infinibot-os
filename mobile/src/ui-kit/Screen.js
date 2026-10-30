/**
 * Screen — the safe-area + scroll wrapper every screen mounts as its root.
 *
 * Owns the three things screens kept re-implementing (and drifting on):
 *   1. safe-area insets via react-native-safe-area-context (never hardcoded
 *      status-bar heights, never `Platform.OS === 'ios' ? 44 : 0`)
 *   2. the scroll container + refresh control + keyboard avoidance
 *   3. bottom padding that clears the floating dock on tabbed screens
 *
 * The app renders an AnimatedBackground behind the navigator, so Screen is
 * transparent by default. Pass `opaque` when a screen must not show it.
 *
 * Props
 *   scroll        boolean   wrap children in a ScrollView (default true).
 *                           Pass false when the screen owns a FlatList.
 *   padded        boolean   apply horizontal SPACE.lg gutters (default true)
 *   edges         array     safe-area edges to apply, default ['top','bottom']
 *   dockSpace     boolean   add bottom padding for the FloatingDock (default
 *                           false — tab screens already get it from the
 *                           navigator's contentStyle)
 *   refreshing    boolean   drives the pull-to-refresh spinner
 *   onRefresh     fn        enables pull-to-refresh when provided
 *   keyboardAvoiding boolean  wrap in KeyboardAvoidingView (default false)
 *   header        node      rendered above the scroll area, outside the pad
 *   footer        node      rendered below the scroll area, outside the pad
 *   opaque        boolean   paint colors.background instead of transparent
 *   contentStyle  style     applied to the ScrollView contentContainer
 */

import React from 'react';
import {
  View,
  ScrollView,
  RefreshControl,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useUIKit, SPACE } from './tokens';

// Height the FloatingDock occupies. Kept here so screens never guess.
export const DOCK_SPACE = 96;

export function Screen({
  children,
  scroll = true,
  padded = true,
  edges = ['top', 'bottom'],
  dockSpace = false,
  refreshing = false,
  onRefresh,
  keyboardAvoiding = false,
  header,
  footer,
  opaque = false,
  style,
  contentStyle,
  testID,
  ...scrollProps
}) {
  const { colors } = useUIKit();
  const insets = useSafeAreaInsets();

  const inset = {
    paddingTop: edges.includes('top') ? insets.top : 0,
    paddingBottom: edges.includes('bottom') ? insets.bottom : 0,
    paddingLeft: edges.includes('left') ? insets.left : 0,
    paddingRight: edges.includes('right') ? insets.right : 0,
  };

  const rootStyle = [
    styles.root,
    opaque && { backgroundColor: colors.background },
    inset,
    style,
  ];

  const padStyle = [
    padded && { paddingHorizontal: SPACE.lg },
    { paddingBottom: dockSpace ? DOCK_SPACE : SPACE.lg },
    contentStyle,
  ];

  const body = scroll ? (
    <ScrollView
      style={styles.flex}
      contentContainerStyle={padStyle}
      keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator={false}
      refreshControl={
        onRefresh ? (
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={colors.primary}
            colors={[colors.primary]}
            progressBackgroundColor={colors.surface}
          />
        ) : undefined
      }
      {...scrollProps}
    >
      {children}
    </ScrollView>
  ) : (
    <View style={[styles.flex, padded && { paddingHorizontal: SPACE.lg }]}>{children}</View>
  );

  const inner = (
    <>
      {header}
      {body}
      {footer}
    </>
  );

  return (
    <View style={rootStyle} testID={testID}>
      {keyboardAvoiding ? (
        <KeyboardAvoidingView
          style={styles.flex}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          keyboardVerticalOffset={insets.top}
        >
          {inner}
        </KeyboardAvoidingView>
      ) : (
        inner
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: 'transparent' },
  flex: { flex: 1 },
});

export default Screen;
