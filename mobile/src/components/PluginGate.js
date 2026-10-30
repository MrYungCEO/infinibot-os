/**
 * PluginGate — wraps a native screen that a plugin provides (Agency pages,
 * Products, Whiteboard). The web hides these pages when the plugin is off;
 * a deep link / stale launcher tap can still land here, so the screen shows a
 * clear "turned off" state with a one-tap route to the Plugins page instead
 * of firing RPCs the gateway no longer serves.
 *
 *   <PluginGate pluginId="business-agency" title="Agency Today" navigation={navigation}>
 *     {children}
 *   </PluginGate>
 *
 * While plugins.list is still unknown (cold start) the children render — the
 * screen's own RPC error state covers a plugin that turns out to be off.
 */
import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { usePlugins } from '../plugins/plugin-store';
import { isPluginActive } from '../plugins/plugin-nav';
import { useUIKit, SPACE, Button, AppHeader } from '../ui-kit';

/** 'on' | 'off' | 'missing' | 'unknown' for a plugins.list result. */
export function pluginAvailability(list, pluginId) {
  const plugins = Array.isArray(list?.plugins) ? list.plugins : Array.isArray(list) ? list : null;
  if (!plugins) return 'unknown';
  const p = plugins.find((x) => x && x.id === pluginId);
  if (!p) return 'missing';
  return isPluginActive(p) ? 'on' : 'off';
}

export function usePluginAvailability(pluginId) {
  const { list } = usePlugins();
  return pluginAvailability(list, pluginId);
}

export function PluginGate({ pluginId, pluginName, title, navigation, children }) {
  const availability = usePluginAvailability(pluginId);
  const { colors } = useUIKit();
  if (availability === 'on' || availability === 'unknown') return children;
  const name = pluginName || pluginId;
  return (
    <View style={styles.root}>
      <AppHeader
        variant="nav"
        title={title}
        leftIcon="chevron-back"
        leftLabel="Back"
        onLeftPress={() => navigation?.goBack?.()}
      />
      <View style={styles.center}>
        <Ionicons name="extension-puzzle-outline" size={36} color={colors.textMuted || colors.textSecondary} />
        <Text style={[styles.title, { color: colors.text }]}>
          {availability === 'missing' ? `${name} isn't installed` : `${name} is turned off`}
        </Text>
        <Text style={[styles.body, { color: colors.textMuted || colors.textSecondary }]}>
          {title} comes from the {name} plugin. Turn it on in Plugins to use this page.
        </Text>
        <Button
          title="Open Plugins"
          variant="primary"
          onPress={() => navigation?.navigate?.('PluginsModal', { pluginId, reason: availability === 'missing' ? 'unknown' : 'disabled' })}
          accessibilityLabel={`Open Plugins to turn on ${name}`}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: SPACE.xl, gap: SPACE.md },
  title: { fontSize: 18, fontWeight: '700', textAlign: 'center' },
  body: { fontSize: 14, lineHeight: 20, textAlign: 'center', maxWidth: 320 },
});

export default PluginGate;
