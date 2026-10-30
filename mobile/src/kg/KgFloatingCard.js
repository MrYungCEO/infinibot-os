/**
 * The tap card floating beside its node (the web's `.kg-hovercard`): placed
 * by kg-float's port of the web maths, re-placed every frame while the
 * camera / map moves, kept on screen at the edges, hidden while the node is
 * off screen. Works for both renderers (stage.screenOf is the same API).
 */
import React, { useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { KgPeekCard } from './KgCards';
import { cardWidthFor, floatCardPos } from './kg-float';

export function KgFloatingCard({ c, id, stage, host, insets, onRect }) {
  const [card, setCard] = useState(null);
  const [pos, setPos] = useState(null);
  const posRef = useRef(null);
  const hostRef = useRef(host);
  hostRef.current = host;
  const cardRef = useRef(card);
  cardRef.current = card;
  const insetsRef = useRef(insets);
  insetsRef.current = insets;
  const onRectRef = useRef(onRect);
  onRectRef.current = onRect;

  useEffect(() => {
    let raf = null;
    let alive = true;
    const tick = () => {
      if (!alive) return;
      const p = stage?.screenOf?.(id) || null;
      const h = hostRef.current;
      const cd = cardRef.current;
      let next = null;
      if (p && h?.w && cd) {
        const off = p.x < -p.r || p.y < -p.r || p.x > h.w + p.r || p.y > h.h + p.r;
        next = off ? { hidden: true } : floatCardPos(p, cd, h, insetsRef.current);
      }
      const prev = posRef.current;
      const same = prev && next && prev.hidden === next.hidden && Math.abs((prev.x ?? 0) - (next.x ?? 0)) < 0.5 && Math.abs((prev.y ?? 0) - (next.y ?? 0)) < 0.5;
      if (!same && (prev || next)) {
        posRef.current = next;
        setPos(next);
        if (next && !next.hidden && cd) onRectRef.current?.({ x: next.x, y: next.y, w: cd.w, h: cd.h });
        else onRectRef.current?.(null);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      alive = false;
      if (raf != null) cancelAnimationFrame(raf);
      onRectRef.current?.(null);
    };
  }, [stage, id]);

  const width = cardWidthFor(host?.w || 390);
  const shown = pos && !pos.hidden;
  // Taller than the stage (short phone stage): the card's body scrolls inside.
  const maxH = Math.max(140, (host?.h || 600) - 16 - (insets?.top || 0) - (insets?.bottom || 0));
  return (
    <View
      pointerEvents={shown ? 'box-none' : 'none'}
      style={[styles.wrap, { width, maxHeight: maxH }, shown ? { left: pos.x, top: pos.y, opacity: 1 } : styles.hidden]}
      onLayout={(e) => {
        const { width: w, height: h } = e.nativeEvent.layout;
        if (!cardRef.current || Math.abs(cardRef.current.w - w) > 0.5 || Math.abs(cardRef.current.h - h) > 0.5) setCard({ w, h });
      }}
      testID="kg-float-card"
    >
      {/* Height-capped: the details scroll, the header and the action row stay in view. */}
      <KgPeekCard c={c} id={id} style={[styles.card, { maxHeight: maxH }]} scrollBody />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', borderRadius: 12, overflow: 'hidden' },
  hidden: { left: 0, top: 0, opacity: 0 },
  card: { width: '100%' },
});
