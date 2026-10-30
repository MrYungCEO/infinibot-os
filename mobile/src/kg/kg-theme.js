/**
 * Black-gold glass tokens for the native Knowledge Graph chrome — the values
 * of the web graph's `--g-*` variables and `.kg-*` panel styles.
 */
import { StyleSheet } from 'react-native';

import { mixHex, rgba } from './kg-colors';

export const GOLD = '#d4af37';
export const KG = {
  gold: GOLD,
  goldText: mixHex(GOLD, '#ffffff', 0.9),
  goldSoft: mixHex(GOLD, '#ffffff', 0.85),
  bg: '#030207',
  bgDeep: '#08060f',
  panel: 'rgba(8,6,15,0.92)',
  panelSolid: '#0b0915',
  fg: '#e4e4e7',
  fgBright: '#f6f1e4',
  dim: '#a1a1aa',
  dimmer: '#71717a',
  border: rgba(GOLD, 0.26),
  borderSoft: rgba(GOLD, 0.14),
  btnBg: 'rgba(212,175,55,0.06)',
  btnBorder: rgba(GOLD, 0.22),
  onBg: rgba(GOLD, 0.22),
  onBorder: rgba(GOLD, 0.6),
  danger: '#f0525f',
  warn: '#f5a524',
  ok: '#3ddc97',
  cyan: '#5ee7ff',
  sev: { high: '#f0525f', medium: '#f5a524', info: GOLD },
};

/**
 * The web graph's chrome font: the control UI body face, JetBrains Mono
 * (loaded by src/hooks/useFonts). One bundled face per weight — RN picks
 * faces by family name, so text styles name the weight's family and drop
 * `fontWeight` (Android would otherwise synthesise from the wrong face).
 */
export const KG_MONO = {
  400: 'JetBrainsMono-Regular',
  500: 'JetBrainsMono-Medium',
  600: 'JetBrainsMono-SemiBold',
  700: 'JetBrainsMono-Bold',
};
/** Inter faces for the few web chrome texts that set Inter (card titles). */
export const KG_INTER = { 500: 'Inter-Medium', 600: 'Inter-SemiBold', 700: 'Inter-Bold' };

export function monoFamily(weight) {
  const w = Number(weight === 'bold' ? 700 : weight === 'normal' || weight == null ? 400 : weight);
  return KG_MONO[w >= 650 ? 700 : w >= 550 ? 600 : w >= 450 ? 500 : 400];
}

/** One text style → the mono face for its weight (styles that name a family keep it). */
export function withMono(style) {
  if (!style || typeof style !== 'object' || Array.isArray(style)) return style;
  if (style.fontFamily || (style.fontSize == null && style.fontWeight == null)) return style;
  const { fontWeight, ...rest } = style;
  return { ...rest, fontFamily: monoFamily(fontWeight) };
}

/** StyleSheet.create with every text style on the chrome font. */
export function kgSheet(styles) {
  const out = {};
  for (const [k, v] of Object.entries(styles)) out[k] = withMono(v);
  return StyleSheet.create(out);
}

export const kgStyles = kgSheet({
  panel: {
    backgroundColor: KG.panel,
    borderWidth: 1,
    borderColor: KG.border,
    borderRadius: 12,
    padding: 12,
    shadowColor: '#000',
    shadowOpacity: 0.55,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 10 },
    elevation: 12,
  },
  panelTitle: { fontSize: 10, letterSpacing: 3, textTransform: 'uppercase', fontWeight: '700', color: KG.goldText },
  muted: { color: KG.dim, fontSize: 12, lineHeight: 17 },
  btn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    minHeight: 38,
    paddingHorizontal: 11,
    borderRadius: 9,
    borderWidth: 1,
    borderColor: KG.btnBorder,
    backgroundColor: 'rgba(0,0,0,0.35)',
  },
  btnOn: { backgroundColor: KG.onBg, borderColor: KG.onBorder },
  btnPrimary: { backgroundColor: rgba(GOLD, 0.24), borderColor: rgba(GOLD, 0.6) },
  btnDanger: { backgroundColor: 'rgba(240,82,95,0.16)', borderColor: 'rgba(240,82,95,0.55)' },
  btnText: { color: KG.fg, fontSize: 13, fontWeight: '600' },
  btnTextPrimary: { color: '#fff3cf' },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    height: 30,
    paddingHorizontal: 10,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: rgba(GOLD, 0.18),
  },
  chipOn: { backgroundColor: rgba(GOLD, 0.1), borderColor: rgba(GOLD, 0.45) },
  chipOff: { opacity: 0.45 },
  chipText: { color: KG.fg, fontSize: 12 },
  chipCount: { color: KG.dim, fontSize: 10.5, marginLeft: 2, fontVariant: ['tabular-nums'] },
  input: {
    minHeight: 40,
    borderRadius: 9,
    borderWidth: 1,
    borderColor: KG.btnBorder,
    backgroundColor: 'rgba(0,0,0,0.4)',
    color: KG.fg,
    paddingHorizontal: 12,
    fontSize: 14,
  },
  label: { fontSize: 10, letterSpacing: 2, textTransform: 'uppercase', color: rgba(GOLD, 0.8), marginTop: 10, marginBottom: 5, fontWeight: '700' },
  pill: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 999, borderWidth: 1 },
  pillText: { fontSize: 10, letterSpacing: 0.6, textTransform: 'uppercase', fontWeight: '700' },
});
