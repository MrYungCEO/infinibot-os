/**
 * <CaptureOrb> — quick capture as ONE small "+" orb instead of a row of tiles.
 *
 * Tap the orb → a labelled mini-menu (Note · Idea · Task · Project · Log)
 * fans up from it with a short stagger; tap an item → onPick(kind). The "+"
 * turns into "×" while open; tapping outside (a light scrim), the orb again,
 * or Android back closes it. Geometry comes from infini/layout.js (`orb`,
 * `menu`, `buttons`), so the menu never collides with the dock or header.
 *
 * Cheap by design: the menu is only mounted while open (or closing), its
 * pills skip the blur, and the open/close is one Reanimated timing on the UI
 * thread (each pill reads it with an offset). Reduce Motion: instant.
 *
 * Accessibility: the orb is a button with expanded state; each item is a
 * ≥ 44pt button labelled "Capture a note by voice", etc.
 */
import React, { useEffect, useState } from 'react';
import { BackHandler, Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, { Easing, runOnJS, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';

import { GLASS, GlassButton } from './Glass';
import { CAPTURE_ICONS, PlusIcon } from './icons';

function MenuItem({ t, index, count, kind, label, rect, onPick, reduced, textStyle }) {
  // Items nearest the orb (the bottom of the stack) arrive first.
  const order = count - 1 - index;
  const style = useAnimatedStyle(() => {
    const local = Math.max(0, Math.min(1, t.value * 1.6 - order * 0.15));
    return { opacity: local, transform: [{ translateY: (1 - local) * 14 }, { scale: 0.92 + 0.08 * local }] };
  });
  const Icon = CAPTURE_ICONS[kind];
  return (
    <Animated.View style={[{ position: 'absolute', left: rect.left, top: rect.top, width: rect.width, height: rect.height }, style]}>
      {/* Solid backing instead of a blur: the pill stays legible over the face and status text. */}
      <View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.itemBacking, { borderRadius: rect.height / 2 }]} />
      <GlassButton
        onPress={() => onPick(kind)}
        reduced={reduced}
        blur={false}
        tone="glass"
        radius={rect.height / 2}
        style={StyleSheet.absoluteFill}
        contentStyle={styles.itemInner}
        accessibilityRole="button"
        accessibilityLabel={`Capture a ${label.toLowerCase()} by voice`}
        testID={`orbit-${kind}`}
      >
        <Icon size={18} color={GLASS.goldHi} strokeWidth={1.7} />
        <Text style={[textStyle, styles.itemLabel]} numberOfLines={1}>
          {label}
        </Text>
      </GlassButton>
    </Animated.View>
  );
}

export function CaptureOrb({ layout, kinds, open, onToggle, onClose, onPick, reduced = false, textStyle, width, height }) {
  const [mounted, setMounted] = useState(open);
  const t = useSharedValue(open ? 1 : 0);

  useEffect(() => {
    if (open) setMounted(true);
    const dur = reduced ? 0 : open ? 260 : 160;
    t.value = withTiming(open ? 1 : 0, { duration: dur, easing: Easing.out(Easing.cubic) }, (done) => {
      if (done && !open) runOnJS(setMounted)(false);
    });
  }, [open, reduced]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open) return undefined;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      onClose();
      return true;
    });
    return () => sub.remove();
  }, [open, onClose]);

  const plus = useAnimatedStyle(() => ({ transform: [{ rotate: `${t.value * 45}deg` }] }));
  const scrim = useAnimatedStyle(() => ({ opacity: t.value }));
  const o = layout.orb;

  return (
    <>
      {mounted ? (
        <Animated.View style={[styles.scrim, { width, height }, scrim]} pointerEvents={open ? 'auto' : 'none'}>
          <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityRole="button" accessibilityLabel="Close quick capture" testID="infini-capture-scrim" />
        </Animated.View>
      ) : null}
      {mounted
        ? kinds.map(({ kind, label }, i) =>
            layout.buttons[kind] ? (
              <MenuItem key={kind} t={t} index={i} count={kinds.length} kind={kind} label={label} rect={layout.buttons[kind]} onPick={onPick} reduced={reduced} textStyle={textStyle} />
            ) : null,
          )
        : null}
      <GlassButton
        onPress={onToggle}
        reduced={reduced}
        tone={open ? 'gold' : 'glass'}
        active={open}
        style={{ position: 'absolute', left: o.left, top: o.top, width: o.width, height: o.height }}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={open ? 'Close quick capture' : 'Quick capture: note, idea, task, project or log'}
        testID="infini-capture-orb"
      >
        <Animated.View style={plus}>
          <PlusIcon size={22} color={GLASS.goldHi} strokeWidth={2} />
        </Animated.View>
      </GlassButton>
    </>
  );
}

const styles = StyleSheet.create({
  scrim: { position: 'absolute', left: 0, top: 0, backgroundColor: 'rgba(0,0,0,0.38)' },
  itemBacking: { backgroundColor: 'rgba(10, 8, 5, 0.9)' },
  itemInner: { justifyContent: 'flex-start', gap: 10, paddingHorizontal: 16 },
  itemLabel: { color: GLASS.text, letterSpacing: 0.3 },
});
