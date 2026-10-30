/**
 * chat-tokens — the chat surface's design tokens, resolved from the web UI's
 * CSS variables (theme/web-tokens.generated.js) and the LIVE mobile palette.
 *
 * The web derives every shade from `--g-primary`; mobile gets the same accent
 * from the branding sync (ThemeProvider), so we apply the web's alpha recipes
 * to the live accent rather than freezing the stock gold.
 */
import { useMemo } from 'react';
import { Platform } from 'react-native';

import { WEB_TOKENS } from '../theme/web-tokens.generated';
import { useTheme } from '../theme/ThemeProvider';
import { withAlpha } from '../theme/color-utils';
import { FONT_FAMILY } from '../hooks/useFonts';

const W = WEB_TOKENS;

export function resolveChatTokens(colors = {}) {
  const accent = colors.primary || W.color.accent;
  const dark = colors.isLight !== true;
  const text = dark ? W.color.text : colors.text || '#3f3f46';
  const textStrong = dark ? W.color.textStrong : colors.text || '#18181b';
  return {
    accent,
    accentForeground: W.color.accentForeground,
    accentSoft: withAlpha(accent, W.recipe.accentSoftAlpha),
    bg: dark ? W.color.bg : colors.background,
    side: dark ? W.color.bgElevated : colors.surface,
    surface: dark ? W.recipe.surface : withAlpha('#000000', 0.03),
    surfaceStrong: dark ? W.recipe.surfaceStrong : withAlpha('#000000', 0.06),
    codeBg: dark ? '#0a0a0a' : '#f5f5f5',
    border: dark ? withAlpha(accent, W.recipe.borderAccentMix * 0.9) : withAlpha('#000000', 0.1),
    borderStrong: withAlpha(accent, W.recipe.borderStrongAlpha),
    borderNeutral: dark ? W.recipe.borderBase : withAlpha('#000000', 0.08),
    text,
    textStrong,
    muted: dark ? W.color.muted : '#71717a',
    mutedStrong: dark ? W.color.mutedStrong : '#52525b',
    rowHover: withAlpha(text, W.recipe.rowHover),
    activeRow: [withAlpha(accent, W.recipe.activeRowFrom), withAlpha(accent, W.recipe.activeRowTo)],
    activeRowBorder: withAlpha(accent, W.recipe.activeRowBorder),
    ok: W.color.ok,
    warn: W.color.warn,
    danger: W.color.danger,
    dangerSubtle: W.color.dangerSubtle,
    radius: W.radius,
    size: W.size,
    type: W.type,
    motion: W.motion,
    font: {
      regular: FONT_FAMILY.regular,
      medium: FONT_FAMILY.medium,
      semiBold: FONT_FAMILY.semiBold,
      bold: FONT_FAMILY.bold,
      mono: Platform.select({ ios: 'Menlo', android: 'monospace', default: `"${W.type.mono}", ui-monospace, Menlo, monospace` }),
    },
  };
}

export function useChatTokens() {
  const { colors } = useTheme();
  return useMemo(() => resolveChatTokens(colors), [colors]);
}
