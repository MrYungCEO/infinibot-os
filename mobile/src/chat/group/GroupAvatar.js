/**
 * GroupAvatar — an agent's avatar in a group chat, the twin of the web's
 * `.gc-av`: the roster image when there is one, otherwise initials on the
 * agent's own hue (agentHue — same colour as on the web for the same id).
 */
import React, { memo } from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { useChatTokens } from '../chat-tokens';
import { agentColor, initials } from './group-logic';

export const GroupAvatar = memo(function GroupAvatar({ id, name, url, size = 30, ring, style }) {
  const t = useChatTokens();
  const dim = { width: size, height: size, borderRadius: size / 2 };
  if (url && /^https?:\/\//.test(url)) {
    return <Image source={{ uri: url }} style={[dim, styles.img, ring ? { borderColor: t.bg, borderWidth: 2 } : null, style]} accessibilityIgnoresInvertColors />;
  }
  if (id === 'all') {
    return (
      <View style={[dim, styles.mono, { backgroundColor: t.accentSoft, borderColor: t.borderStrong }, style]}>
        <Ionicons name="people" size={Math.round(size * 0.5)} color={t.accent} />
      </View>
    );
  }
  const key = id || name || '?';
  return (
    <View
      style={[
        dim,
        styles.mono,
        { backgroundColor: agentColor(key, { l: 42, s: 45, a: 0.32 }), borderColor: ring ? t.bg : agentColor(key, { l: 60, a: 0.55 }), borderWidth: ring ? 2 : 1 },
        style,
      ]}
      accessibilityElementsHidden
      importantForAccessibility="no"
    >
      <Text style={{ color: agentColor(key, { l: 78, s: 70 }), fontFamily: t.font.semiBold, fontSize: Math.max(9, Math.round(size * 0.36)) }}>
        {initials(name || id || '?')}
      </Text>
    </View>
  );
});

/** Overlapping avatars for a group header / chat row (+N past `max`). */
export function AvatarStack({ members, size = 26, max = 4 }) {
  const t = useChatTokens();
  const shown = (members || []).slice(0, max);
  const more = (members || []).length - shown.length;
  return (
    <View style={styles.stack} accessibilityElementsHidden importantForAccessibility="no">
      {shown.map((m, i) => (
        <GroupAvatar key={m.id} id={m.id} name={m.name} url={m.avatarUrl} size={size} ring style={{ marginLeft: i ? -size * 0.34 : 0, zIndex: max - i }} />
      ))}
      {more > 0 ? (
        <View style={[styles.mono, { width: size, height: size, borderRadius: size / 2, marginLeft: -size * 0.34, backgroundColor: t.surfaceStrong, borderColor: t.bg, borderWidth: 2 }]}>
          <Text style={{ color: t.muted, fontSize: Math.round(size * 0.36), fontFamily: t.font.semiBold }}>+{more}</Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  img: { backgroundColor: '#222' },
  mono: { alignItems: 'center', justifyContent: 'center', borderWidth: 1 },
  stack: { flexDirection: 'row', alignItems: 'center' },
});
