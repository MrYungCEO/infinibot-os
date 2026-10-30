/**
 * MeshFx — the web mesh's screen-space overlays, natively:
 *   · FxOverlay          renderFx(): district-tinted highlight pulses on tool /
 *                        spawn / completion beats + the rotating reticle on the
 *                        followed (gold) or broadcast-focused agent
 *                        (agency-world-viz.ts:2604-2740)
 *   · DragAssignOverlay  drag-assign.ts render(): gold drop zones over every
 *                        sector / plugin room (the hovered one lit), the ghost
 *                        agent under the finger, the red reject flash
 *   · MeshToast          <world-interactions> toast()
 */
import React, { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Svg, { Circle, G, Line, Rect, Text as SvgText } from 'react-native-svg';

import { pulseRings, reticleRotation } from '../../lib/mesh/director';
import { MeshIcon } from './MeshIcons';
import { MONO } from './mesh-style';

const FX_FRAME_MS = 33;

/** Agent body centre in screen px (sprites stand on p; the body is ~18 world px up). */
function toScreen(cam, p) {
  return { x: p.x * cam.k + cam.x, y: (p.y - 18) * cam.k + cam.y };
}

export function FxOverlay({ cam, size, fx }) {
  const [now, setNow] = useState(Date.now());
  const pulses = fx.pulses();
  const subject = fx.subject();
  const live = pulses.length > 0 || !!subject;
  useEffect(() => {
    if (!live) return undefined;
    const t = setInterval(() => setNow(Date.now()), FX_FRAME_MS);
    return () => clearInterval(t);
  }, [live]);
  if (!cam || !size.w || !live) return null;
  const rings = [];
  for (const p of pulses) {
    const pos = fx.pos(p.key);
    const r = pos ? pulseRings(p, now) : null;
    if (!r) continue;
    const s = toScreen(cam, pos);
    rings.push(
      <G key={`p-${p.key}-${p.born}`}>
        <Circle cx={s.x} cy={s.y} r={r.halo.r} fill={p.color} opacity={r.halo.opacity} />
        <Circle cx={s.x} cy={s.y} r={r.r1.r} fill="none" stroke={p.color} strokeWidth={2} opacity={r.r1.opacity} />
        {r.r2 ? <Circle cx={s.x} cy={s.y} r={r.r2.r} fill="none" stroke={p.color} strokeWidth={1.5} opacity={r.r2.opacity} /> : null}
      </G>,
    );
  }
  let reticle = null;
  const sp = subject ? fx.pos(subject.key) : null;
  if (sp) {
    const s = toScreen(cam, sp);
    const rot = reticleRotation(now);
    reticle = (
      <G transform={`translate(${s.x} ${s.y}) rotate(${rot})`} testID="mesh-reticle">
        <Circle r={26} fill="none" stroke={subject.color} strokeWidth={2} strokeDasharray="10 8" opacity={0.9} />
        {[0, 90, 180, 270].map((a) => {
          const rad = (a * Math.PI) / 180;
          return <Line key={a} x1={Math.cos(rad) * 30} y1={Math.sin(rad) * 30} x2={Math.cos(rad) * 38} y2={Math.sin(rad) * 38} stroke={subject.color} strokeWidth={2} opacity={0.9} />;
        })}
      </G>
    );
  }
  return (
    <Svg width={size.w} height={size.h} style={StyleSheet.absoluteFill} pointerEvents="none">
      {rings}
      {reticle}
    </Svg>
  );
}

export function DragAssignOverlay({ drag, zones, cam, size, reject }) {
  if ((!drag && !reject) || !cam || !size.w) return null;
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none" testID={drag ? 'mesh-drag-assign' : undefined}>
      {drag ? (
        <Svg width={size.w} height={size.h} style={StyleSheet.absoluteFill}>
          {zones.map((z) => {
            const hot = drag.hovered?.id === z.id;
            const x = (z.x - z.w) * cam.k + cam.x;
            const y = (z.y - z.h) * cam.k + cam.y;
            const w = z.w * 2 * cam.k;
            const h = z.h * 2 * cam.k;
            return (
              <G key={z.id}>
                <Rect x={x} y={y} width={w} height={h} rx={10} fill={hot ? 'rgba(212,175,55,0.22)' : 'rgba(212,175,55,0.08)'} stroke={hot ? '#f5d77a' : '#d4af37'} strokeWidth={hot ? 2.5 : 1.5} strokeDasharray={hot ? undefined : '6 5'} opacity={hot ? 1 : 0.55} />
                <SvgText x={x + w / 2} y={y - 8} textAnchor="middle" fill="#f5d77a" fontFamily={MONO} fontSize={11} fontWeight="600" letterSpacing={0.66} opacity={hot ? 1 : 0.7}>{String(z.name).toUpperCase()}</SvgText>
              </G>
            );
          })}
        </Svg>
      ) : null}
      {drag ? (
        <View style={[styles.ghost, { left: drag.x, top: drag.y }]}>
          <View style={styles.ghostDot} />
          <Text style={styles.ghostLabel} numberOfLines={1}>{drag.label}</Text>
        </View>
      ) : null}
      {reject ? (
        <View style={[styles.reject, { left: reject.x - 14, top: reject.y - 14 }]}>
          <MeshIcon name="close" size={28} color="#ff5c5c" strokeWidth={3} />
        </View>
      ) : null}
    </View>
  );
}

export function MeshToast({ toast, bottom }) {
  if (!toast) return null;
  const err = toast.kind === 'err';
  return (
    <View style={[styles.toast, err ? styles.toastErr : styles.toastOk, { bottom }]} pointerEvents="none" accessibilityRole="alert" testID="mesh-toast">
      <Text style={[styles.toastText, { color: err ? '#ff9b9b' : '#f5d77a' }]}>{toast.message}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  ghost: { position: 'absolute', flexDirection: 'row', alignItems: 'center', gap: 6, transform: [{ translateX: -9 }, { translateY: -9 }] },
  ghostDot: { width: 18, height: 18, borderRadius: 9, backgroundColor: '#e9c46a', borderWidth: 2, borderColor: '#f5d77a', shadowColor: '#d4af37', shadowOpacity: 0.9, shadowRadius: 7, elevation: 6 },
  ghostLabel: { maxWidth: 200, fontSize: 11, color: '#f5e9c8', fontFamily: MONO, paddingHorizontal: 7, paddingVertical: 2, borderRadius: 6, backgroundColor: 'rgba(10,10,14,0.92)', borderWidth: 1, borderColor: 'rgba(212,175,55,0.55)', overflow: 'hidden' },
  reject: { position: 'absolute' },
  toast: { position: 'absolute', alignSelf: 'center', maxWidth: '86%', paddingHorizontal: 14, paddingVertical: 8, borderRadius: 9, borderWidth: 1, backgroundColor: 'rgba(10,10,14,0.92)', shadowColor: '#000', shadowOpacity: 0.6, shadowRadius: 14, elevation: 8 },
  toastOk: { borderColor: '#d4af37' },
  toastErr: { borderColor: '#ff6b6b' },
  toastText: { fontSize: 12, fontFamily: MONO },
});
