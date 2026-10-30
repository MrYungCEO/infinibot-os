// mesh-style.js — the web mesh's visual constants (activity-map.ts STATUS
// colours, world-map-coder-builds.ts backend colours, heatmap ramp, HUD pill
// styles from agency-world-viz.ts) for the native Agent Mesh.
import { Platform } from 'react-native';

export const MONO = Platform.select({ ios: 'Menlo', android: 'monospace', default: '"JetBrains Mono","SF Mono",ui-monospace,monospace' });

/** activity-map.ts:121 */
export const STATUS_COLOR = {
  starting: '#3b82f6',
  idle: '#6a8a6a',
  running: '#ffd700',
  working: '#ffd700',
  blocked: '#e74c3c',
  finishing: '#f59e0b',
  completed: '#22c55e',
  failed: '#ef4444',
};

/** world-map-coder-builds.ts */
export const BUILD_COLOR = { 'claude-code': '#d4af37', codex: '#5ec8e0', opencode: '#a78bfa', gemini: '#4ade80', grok: '#f43f5e', done: '#7ee2a8', failed: '#f87171' };
export const BACKEND_NAME = { 'claude-code': 'Claude Code', codex: 'Codex CLI', opencode: 'OpenCode', gemini: 'Gemini CLI', grok: 'Grok Build' };

/** resolveAgentSpriteSlot (activity-map.ts:837) */
export function spriteSlot(a) {
  switch (a?.coderBackend) {
    case 'claude-code': return 'claude';
    case 'opencode': return 'opencode';
    case 'codex': return 'codex';
    case 'gemini': return 'gemini';
    default: return 'default';
  }
}

/** providerLogoFor → badge file letter (provider-logos.ts). */
export function badgeFor(a) {
  switch (a?.coderBackend) {
    case 'claude-code': return 'c';
    case 'codex': return 'x';
    case 'gemini': return 'g';
    case 'opencode': return 'o';
    default: return 'infinibot';
  }
}

/** heatmap-layer.ts ramp: gold → amber → crimson. */
export function heatColor(t) {
  const c = Math.max(0, Math.min(1, t));
  const lerp = (a, b, k) => Math.round(a + (b - a) * k);
  const [g, am, cr] = [[212, 175, 55], [255, 158, 44], [220, 38, 38]];
  const [x, y, k] = c < 0.5 ? [g, am, c / 0.5] : [am, cr, (c - 0.5) / 0.5];
  return `rgb(${lerp(x[0], y[0], k)},${lerp(x[1], y[1], k)},${lerp(x[2], y[2], k)})`;
}

/** .bx-btn (agency-world-viz.ts) */
export const BX_BTN = {
  backgroundColor: 'rgba(10,14,26,0.72)',
  borderColor: 'rgba(255,255,255,0.14)',
  borderWidth: 1,
  borderRadius: 8,
  paddingHorizontal: 10,
  minHeight: 36,
  justifyContent: 'center',
  alignItems: 'center',
  flexDirection: 'row',
};
export const BX_TEXT = { color: '#d4d4d8', fontFamily: MONO, fontSize: 11, letterSpacing: 0.6, fontWeight: '600' };

export const GOLD = '#d4af37';
export const GOLD_LT = '#e9c46a';
export const PANEL_BG = 'rgba(7,7,10,0.66)';
export const GOLD_BORDER = 'rgba(212,175,55,0.45)';
