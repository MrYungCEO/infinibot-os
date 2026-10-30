/**
 * Learn › Certification — the guided certification ladder (Apprentice /
 * Practitioner / Master) + plugin mastery badges.
 * (web: renderCertification in views/learn.ts; certificate via learn.guided.certificate)
 */
import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useUIKit, SPACE, RADIUS, HIT, Card, Button, SectionTitle, EmptyState } from '../../ui-kit';
import { withAlpha } from '../../theme/color-utils';
import { certView, pluginAccent } from './learn-model';
import { Ring, Monogram } from './parts';

export function CertTab({ tracks, progress, plugins, source, onOpenTrack, onViewCert, busyTier }) {
  const { colors, type } = useUIKit();
  const { rungs, mastery } = certView(tracks, progress, source);
  return (
    <View>
      <SectionTitle title="Certification path" subtitle="InfiniBot AI Agent Systems certification — awarded automatically" />
      {rungs.map((r) => (
        <Card key={r.tier} padded tint={r.eligible ? 'primary' : 'neutral'} glow={r.eligible} style={{ marginTop: SPACE.sm }}>
          <View style={styles.head}>
            <View style={{ flex: 1 }}>
              <Text style={[type.h3, { color: colors.text }]}>{r.title}</Text>
              <Text style={[type.caption, { color: colors.textMuted }]}>{r.blurb}</Text>
            </View>
            <Ring percent={r.percent} />
          </View>
          <View style={{ marginTop: SPACE.sm }}>
            {r.items.map((it) => {
              const body = (
                <>
                  <Ionicons
                    name={it.done ? 'checkmark-circle' : 'ellipse-outline'}
                    size={16}
                    color={it.done ? colors.success : colors.textMuted}
                  />
                  <Text style={[type.small, { color: it.trackId ? colors.primary : colors.text, flex: 1 }]}>{it.title}</Text>
                </>
              );
              return it.trackId ? (
                <Pressable
                  key={it.id}
                  onPress={() => onOpenTrack(it.trackId)}
                  accessibilityRole="link"
                  accessibilityLabel={`${it.title}, ${it.done ? 'done' : 'not done'}`}
                  style={({ pressed }) => [styles.item, pressed && { opacity: 0.75 }]}
                >
                  {body}
                </Pressable>
              ) : (
                <View key={it.id} style={styles.item}>{body}</View>
              );
            })}
          </View>
          {r.canView ? (
            <Button
              title="View certificate"
              icon="ribbon-outline"
              variant="outline"
              onPress={() => onViewCert(r.tier)}
              loading={busyTier === r.tier}
              style={{ marginTop: SPACE.sm }}
            />
          ) : null}
        </Card>
      ))}

      <SectionTitle title="Plugin mastery badges" subtitle="Finish a plugin's track to earn its badge" />
      {mastery.length === 0 ? (
        <EmptyState compact icon="extension-puzzle-outline" title="No plugin tracks" message="Enable a plugin to unlock its mastery track." />
      ) : null}
      <View style={styles.badges}>
        {mastery.map(({ track, earned }) => {
          const p = plugins.find((x) => x.id === track.pluginId);
          const accent = pluginAccent(p) || colors.primary;
          return (
            <Pressable
              key={track.id}
              onPress={() => onOpenTrack(track.id)}
              accessibilityRole="button"
              accessibilityLabel={`${track.badge?.label}, ${earned ? 'earned' : 'locked'}`}
              style={({ pressed }) => [
                styles.badge,
                {
                  borderColor: earned ? accent : colors.border,
                  backgroundColor: withAlpha(colors.text, 0.03),
                  opacity: earned ? 1 : 0.7,
                },
                pressed && { opacity: 0.6 },
              ]}
            >
              <Monogram plugin={p} pluginId={track.pluginId} />
              <View style={{ flex: 1 }}>
                <Text style={[type.smallStrong, { color: colors.text }]} numberOfLines={2}>{track.badge?.label}</Text>
                <Text style={[type.caption, { color: colors.textMuted }]}>{earned ? 'Earned' : 'Locked'}</Text>
              </View>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', gap: SPACE.md },
  item: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, minHeight: HIT.min },
  badges: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.sm, marginTop: SPACE.sm },
  badge: {
    flexBasis: '47%',
    flexGrow: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACE.sm,
    padding: SPACE.md,
    borderRadius: RADIUS.md,
    borderWidth: 1,
    minHeight: 56,
  },
});
