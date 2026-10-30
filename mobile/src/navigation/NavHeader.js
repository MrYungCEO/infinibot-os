/**
 * NavHeader — the one navigator header. Every stack and tab navigator uses it
 * (via `screenOptions.header`), so every screen that shows a navigator header
 * gets the same glass bar, the same back affordance in the same place, the
 * same title type, and correct top safe-area padding on phones and tablets.
 *
 * Back behaviour: a back chevron appears whenever there is somewhere to go
 * back to — a previous screen in the stack, or (for a root modal) the tabs.
 */
import React, { useEffect, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { BlurView } from 'expo-blur';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useTheme } from '../theme/ThemeProvider';
import { withAlpha } from '../theme/color-utils';
import { FONT_FAMILY } from '../hooks/useFonts';
import { tap } from '../utils/haptics';

export const NAV_HEADER_HEIGHT = 52;

export function NavHeader({ navigation, route, options, back }) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const title =
    typeof options.headerTitle === 'string' ? options.headerTitle
      : typeof options.title === 'string' ? options.title
        : route?.name || '';
  const canGoBack = Boolean(back);
  const Right = options.headerRight;

  // react-native-web keeps unfocused tab scenes painted, headers included, so
  // another tab's header would show through a transparent screen. Native
  // detaches them; on web, draw the header only for the focused screen.
  const [focused, setFocused] = useState(() => navigation?.isFocused?.() ?? true);
  useEffect(() => {
    if (Platform.OS !== 'web' || !navigation?.addListener) return undefined;
    const a = navigation.addListener('focus', () => setFocused(true));
    const b = navigation.addListener('blur', () => setFocused(false));
    return () => { a(); b(); };
  }, [navigation]);
  if (Platform.OS === 'web' && !focused) return null;

  return (
    <View style={[styles.wrap, { paddingTop: insets.top, paddingLeft: insets.left, paddingRight: insets.right }]}>
      <BlurView intensity={Platform.OS === 'android' ? 60 : 78} tint="dark" style={StyleSheet.absoluteFill} />
      <View style={[StyleSheet.absoluteFill, { backgroundColor: withAlpha(colors.background || '#060406', 0.72) }]} />
      <View style={styles.bar}>
        {canGoBack ? (
          <Pressable
            onPress={() => { tap(); navigation.goBack(); }}
            hitSlop={6}
            style={({ pressed }) => [styles.btn, pressed && { opacity: 0.6 }]}
            accessibilityRole="button"
            accessibilityLabel="Back"
          >
            <Ionicons name="chevron-back" size={24} color={colors.primary} />
          </Pressable>
        ) : (
          <View style={styles.edge} />
        )}
        <Text numberOfLines={1} style={[styles.title, { color: colors.text }]} accessibilityRole="header">
          {title}
        </Text>
        <View style={styles.right}>{Right ? <Right tintColor={colors.primary} /> : null}</View>
      </View>
      <LinearGradient
        colors={['transparent', withAlpha(colors.primary, 0.35), 'transparent']}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 0 }}
        style={styles.line}
      />
    </View>
  );
}

/** `screenOptions` fragment shared by every navigator. */
export const navHeaderOptions = {
  header: (props) => <NavHeader {...props} />,
  headerShadowVisible: false,
};

const styles = StyleSheet.create({
  wrap: { overflow: 'hidden' },
  bar: { height: NAV_HEADER_HEIGHT, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 4 },
  btn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  edge: { width: 12 },
  title: { flex: 1, fontFamily: FONT_FAMILY.semiBold, fontSize: 17, letterSpacing: 0.2, paddingHorizontal: 4 },
  right: { minWidth: 12, paddingRight: 8, flexDirection: 'row', alignItems: 'center' },
  line: { position: 'absolute', left: 0, right: 0, bottom: 0, height: 1 },
});
