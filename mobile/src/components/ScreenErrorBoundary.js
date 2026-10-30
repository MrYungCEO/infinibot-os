/**
 * ScreenErrorBoundary — keeps one screen's render error from unmounting the
 * whole app. Wrapped around every screen by the navigators (`screenLayout`).
 * Shows what failed, lets the user retry or leave.
 */
import React from 'react';
import { KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { COLORS } from '../constants/theme';

export class ScreenErrorBoundary extends React.Component {
  state = { error: null };

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.warn('[screen-error]', this.props.name || '', error?.message, info?.componentStack?.split('\n').slice(0, 4).join(' '));
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    const { navigation } = this.props;
    return (
      <View style={styles.wrap} accessibilityRole="alert">
        <View style={styles.badge}>
          <Ionicons name="alert-circle-outline" size={28} color={COLORS.primary} />
        </View>
        <Text style={styles.title}>This screen hit a problem</Text>
        <Text style={styles.text} numberOfLines={4}>{String(error?.message || error)}</Text>
        <View style={styles.row}>
          <Pressable style={[styles.btn, styles.primary]} onPress={() => this.setState({ error: null })} accessibilityRole="button">
            <Text style={styles.primaryText}>Try again</Text>
          </Pressable>
          {navigation?.canGoBack?.() ? (
            <Pressable style={styles.btn} onPress={() => navigation.goBack()} accessibilityRole="button">
              <Text style={styles.btnText}>Go back</Text>
            </Pressable>
          ) : null}
        </View>
      </View>
    );
  }
}

// Full-bleed surfaces that own their keyboard behaviour (terminal emulator,
// WebViews, pan/zoom canvases): the wrapper below must not resize them.
const SELF_MANAGED_KEYBOARD = new Set(['TerminalsModal', 'WebSurfaceModal', 'GridModal', 'NeuralMeshModal', 'MainTabs']);

/**
 * `screenLayout` for the stack navigators: error boundary + keyboard
 * avoidance. Many screens have inputs low on the page and no keyboard handling
 * of their own; padding the screen by the keyboard height (edge-to-edge Android
 * does not resize the window) keeps the focused field visible everywhere. A
 * screen with its own KeyboardAvoidingView is unaffected — once this one has
 * shrunk the frame, the inner one finds no overlap left.
 */
export function screenErrorLayout({ children, navigation, route }) {
  const boundary = (
    <ScreenErrorBoundary navigation={navigation} name={route?.name}>
      {children}
    </ScreenErrorBoundary>
  );
  if (Platform.OS === 'web' || SELF_MANAGED_KEYBOARD.has(route?.name)) return boundary;
  return (
    <KeyboardAvoidingView style={styles.scene} behavior="padding">
      {boundary}
    </KeyboardAvoidingView>
  );
}

/**
 * Tab scenes are transparent (the ambient background shows through). Native
 * detaches inactive tabs; react-native-web keeps them painted, so on web the
 * previous tab would show through the current one. Hide unfocused tab scenes.
 */
function TabScene({ navigation, route, children }) {
  const [focused, setFocused] = React.useState(() => navigation.isFocused());
  React.useEffect(() => {
    const a = navigation.addListener('focus', () => setFocused(true));
    const b = navigation.addListener('blur', () => setFocused(false));
    return () => { a(); b(); };
  }, [navigation]);
  return (
    <View style={[styles.scene, Platform.OS === 'web' && !focused ? styles.hidden : null]}>
      <ScreenErrorBoundary navigation={navigation} name={route?.name}>
        {children}
      </ScreenErrorBoundary>
    </View>
  );
}

export function tabScreenLayout(props) {
  return <TabScene {...props} />;
}

const styles = StyleSheet.create({
  scene: { flex: 1 },
  hidden: { display: 'none' },
  wrap: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 28, gap: 10 },
  badge: { width: 56, height: 56, borderRadius: 28, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.06)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.12)' },
  title: { color: '#fff', fontSize: 17, fontWeight: '700', marginTop: 6 },
  text: { color: 'rgba(255,255,255,0.6)', fontSize: 13, lineHeight: 19, textAlign: 'center', maxWidth: 320 },
  row: { flexDirection: 'row', gap: 10, marginTop: 10 },
  btn: { minHeight: 44, paddingHorizontal: 18, borderRadius: 12, borderWidth: 1, borderColor: 'rgba(255,255,255,0.16)', alignItems: 'center', justifyContent: 'center' },
  btnText: { color: '#fff', fontSize: 14, fontWeight: '600' },
  primary: { backgroundColor: 'rgba(255,255,255,0.08)' },
  primaryText: { color: '#fff', fontSize: 14, fontWeight: '700' },
});
