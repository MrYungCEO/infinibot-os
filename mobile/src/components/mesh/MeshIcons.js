/**
 * MeshIcons — line icons for the native Agent Mesh chrome (react-native-svg,
 * 24-unit grid, 1.8 stroke, round caps). They stand in for the emoji the web
 * mesh puts in its pills (📡 🎯 ⇄ ⌖ 💰 ⚡ ⚠️ 👁).
 */
import React from 'react';
import Svg, { Circle, Path, Rect } from 'react-native-svg';

const PATHS = {
  // radio mast with waves (BROADCAST)
  broadcast: (c) => [
    <Circle key="d" cx="12" cy="11" r="2" fill={c} stroke="none" />,
    <Path key="m" d="M12 13v8M9.5 21h5" />,
    <Path key="w1" d="M8.2 7.2a5.4 5.4 0 0 0 0 7.6M15.8 7.2a5.4 5.4 0 0 1 0 7.6" />,
    <Path key="w2" d="M5.3 4.3a9.5 9.5 0 0 0 0 13.4M18.7 4.3a9.5 9.5 0 0 1 0 13.4" />,
  ],
  // crosshair (Auto-focus)
  target: () => [
    <Circle key="o" cx="12" cy="12" r="7" />,
    <Circle key="i" cx="12" cy="12" r="2.4" />,
    <Path key="t" d="M12 2v3.5M12 18.5V22M2 12h3.5M18.5 12H22" />,
  ],
  // outward arrows (Spread)
  spread: () => [
    <Path key="l" d="M3 12h7M6 9l-3 3 3 3" />,
    <Path key="r" d="M21 12h-7M18 9l3 3-3 3" />,
    <Path key="c" d="M12 6v12" />,
  ],
  // dashed selection + pointer (Director)
  director: () => [
    <Path key="b" d="M4 9V5a1 1 0 0 1 1-1h4M15 4h4a1 1 0 0 1 1 1v4M4 15v4a1 1 0 0 0 1 1h4" strokeDasharray="2.5 2.5" />,
    <Path key="p" d="M13 13l7.5 2.6-3.3 1.4-1.4 3.3z" />,
  ],
  back: () => [<Path key="a" d="M15 5l-7 7 7 7" />],
  fit: () => [<Path key="a" d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5" />],
  plus: () => [<Path key="a" d="M12 5v14M5 12h14" />],
  minus: () => [<Path key="a" d="M5 12h14" />],
  eye: () => [
    <Path key="a" d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" />,
    <Circle key="b" cx="12" cy="12" r="2.8" />,
  ],
  eyeOff: () => [
    <Path key="a" d="M9.9 5.8A9.6 9.6 0 0 1 12 5.5C18 5.5 21.5 12 21.5 12a17 17 0 0 1-2.7 3.5M6.4 7.4A16.6 16.6 0 0 0 2.5 12S6 18.5 12 18.5a9.3 9.3 0 0 0 4.4-1.1" />,
    <Path key="b" d="M3 3l18 18" />,
  ],
  off: () => [<Circle key="a" cx="12" cy="12" r="7.5" />, <Path key="b" d="M6.7 17.3L17.3 6.7" />],
  coin: () => [
    <Circle key="a" cx="12" cy="12" r="8.5" />,
    <Path key="b" d="M14.8 9.2c-.5-1-1.6-1.6-2.8-1.6-1.6 0-2.8.9-2.8 2.1 0 2.9 5.7 1.6 5.7 4.5 0 1.2-1.3 2.2-2.9 2.2-1.3 0-2.4-.6-2.9-1.6M12 6v1.6M12 16.4V18" />,
  ],
  bolt: () => [<Path key="a" d="M13 2.5L5 13.5h6l-1 8 8-11h-6z" />],
  alert: () => [<Path key="a" d="M12 3.5L2.5 20h19z" />, <Path key="b" d="M12 10v4.5M12 17.2v.3" />],
  check: () => [<Path key="a" d="M4.5 12.5l4.8 4.8L19.5 7" />],
  chevronRight: () => [<Path key="a" d="M9 5l7 7-7 7" />],
  chevronDown: () => [<Path key="a" d="M5 9l7 7 7-7" />],
  more: (c) => [
    <Circle key="a" cx="6" cy="12" r="1.6" fill={c} stroke="none" />,
    <Circle key="b" cx="12" cy="12" r="1.6" fill={c} stroke="none" />,
    <Circle key="c" cx="18" cy="12" r="1.6" fill={c} stroke="none" />,
  ],
  close: () => [<Path key="a" d="M6 6l12 12M18 6L6 18" />],
  live: (c) => [<Circle key="a" cx="12" cy="12" r="5" fill={c} stroke="none" />],
  frame: () => [<Rect key="a" x="4" y="4" width="16" height="16" rx="3" />],
};

export function MeshIcon({ name, size = 14, color = '#e9c46a', strokeWidth = 1.8 }) {
  const draw = PATHS[name];
  if (!draw) return null;
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {draw(color)}
    </Svg>
  );
}

export const MESH_ICON_NAMES = Object.keys(PATHS);
