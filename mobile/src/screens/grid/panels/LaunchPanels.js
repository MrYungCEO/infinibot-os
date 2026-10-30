/**
 * LaunchPanels — grid tiles whose web body is a whole page or a device feature.
 * On the phone each is a compact native card that hands off to the native
 * screen (never a WebView):
 *   voice   web <voice-grid-panel> (voice call controls)    → InfiniCall
 *   video   web <video-grid-panel> (camera feed)             → Video / Glasses
 *   canvas  web <canvas-grid-panel> (Excalidraw whiteboard)  → Whiteboard (plugin)
 *   view    web view-adapter tiles (notes, reports, CRM ...)  → that page
 *           (agentActivity renders the native Activity feed inline)
 */
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { Button, SPACE, useUIKit } from '../../../ui-kit';
import { withAlpha } from '../../../theme/color-utils';
import { VOICE_ENTRY, navigateToScreen } from '../../../navigation/screen-registry';
import { usePluginAvailability } from '../../../components/PluginGate';
import { VIEW_KINDS } from '../grid-model';
import { PanelEmpty } from '../panel-kit';
import { ActivityPanel } from './ActivityPanel';

function LaunchCard({ icon, title, message, status, actions }) {
  const { colors, type } = useUIKit();
  return (
    <View style={styles.card}>
      <View style={[styles.icon, { borderColor: withAlpha(colors.primary, 0.3), backgroundColor: withAlpha(colors.primary, 0.08) }]}>
        <Ionicons name={icon} size={24} color={colors.primary} />
      </View>
      <Text style={[type.h3, { color: colors.text, textAlign: 'center' }]}>{title}</Text>
      {status ? (
        <View style={[styles.pill, { borderColor: withAlpha(status.color || colors.primary, 0.4) }]}>
          <View style={[styles.pip, { backgroundColor: status.color || colors.primary }]} />
          <Text style={[type.caption, { color: colors.textSecondary }]}>{status.label}</Text>
        </View>
      ) : null}
      <Text style={[type.caption, { color: colors.textMuted, textAlign: 'center', maxWidth: 320 }]}>{message}</Text>
      <View style={styles.actions}>
        {actions.map((a, i) => (
          <Button key={a.label} title={a.label} icon={a.icon} size="sm" variant={i === 0 ? 'primary' : 'secondary'} onPress={a.onPress} />
        ))}
      </View>
    </View>
  );
}

export function VoicePanel({ gateway, navigation }) {
  const { colors } = useUIKit();
  return (
    <LaunchCard
      icon="mic-outline"
      title="Voice"
      status={{ label: gateway?.status === 'connected' ? 'Ready' : 'Offline', color: gateway?.status === 'connected' ? colors.success : colors.textMuted }}
      message="Calls run on your voice pipeline: speech-to-text, model and voice are set on the Voice page."
      actions={[
        { label: 'Start call', icon: 'call-outline', onPress: () => navigateToScreen(navigation, VOICE_ENTRY, { gateway }) },
      ]}
    />
  );
}

export function VideoPanel({ gateway, navigation }) {
  return (
    <LaunchCard
      icon="videocam-outline"
      title="Video feed"
      message="Stream this phone's camera to your agent, or point the camera and ask a question."
      actions={[
        { label: 'Open Video', icon: 'videocam-outline', onPress: () => navigateToScreen(navigation, { screen: 'VideoScreen' }, { gateway }) },
        { label: 'Glasses', icon: 'glasses-outline', onPress: () => navigateToScreen(navigation, { screen: 'GlassesScreen' }, { gateway }) },
      ]}
    />
  );
}

export function CanvasPanel({ gateway, navigation }) {
  const avail = usePluginAvailability('whiteboard');
  if (avail === 'off' || avail === 'missing') {
    return <PanelEmpty icon="brush-outline" title="Whiteboard is turned off" message="Turn on the Whiteboard plugin to draw on a canvas." actionLabel="Plugins" onAction={() => navigateToScreen(navigation, { screen: 'PluginsScreen' }, { gateway })} />;
  }
  return (
    <LaunchCard
      icon="brush-outline"
      title="Canvas"
      message="Freeform diagrams and sketches on the shared whiteboard: the same boards as the web canvas."
      actions={[{ label: 'Open Whiteboard', icon: 'brush-outline', onPress: () => navigateToScreen(navigation, { screen: 'WhiteboardScreen' }, { gateway }) }]}
    />
  );
}

export function ViewPanel({ panel, gateway, navigation, refreshSignal }) {
  const kind = VIEW_KINDS[panel.viewKind];
  const avail = usePluginAvailability(kind?.plugin || '__none__');
  if (!kind) return <PanelEmpty icon="help-circle-outline" title="Unknown panel" />;
  if (panel.viewKind === 'agentActivity') return <ActivityPanel gateway={gateway} navigation={navigation} refreshSignal={refreshSignal} />;
  if (kind.plugin && (avail === 'off' || avail === 'missing')) {
    return <PanelEmpty icon={kind.icon} title={`${kind.title} is turned off`} message="Its plugin is off on this gateway." actionLabel="Plugins" onAction={() => navigateToScreen(navigation, { screen: 'PluginsScreen' }, { gateway })} />;
  }
  return (
    <LaunchCard
      icon={kind.icon}
      title={kind.title}
      message={kind.description}
      actions={[{ label: `Open ${kind.title}`, icon: 'open-outline', onPress: () => navigateToScreen(navigation, { ...kind.open, title: kind.title }, { gateway }) }]}
    />
  );
}

const styles = StyleSheet.create({
  card: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: SPACE.sm, padding: SPACE.lg },
  icon: { width: 52, height: 52, borderRadius: 16, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  pill: { flexDirection: 'row', alignItems: 'center', gap: SPACE.xs, borderWidth: 1, borderRadius: 999, paddingHorizontal: SPACE.sm, paddingVertical: 2 },
  pip: { width: 6, height: 6, borderRadius: 3 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: SPACE.sm, marginTop: SPACE.sm },
});
