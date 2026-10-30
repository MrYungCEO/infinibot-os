/**
 * Contrast gate for the mobile UI kit.
 *
 *   node mobile/design-system/verify-contrast.mjs
 *
 * Asserts the MASTER.md accessibility mandate (>= 4.5:1 for all text) holds
 * for every dark palette the master device can broadcast — not just the two we
 * happened to eyeball. Run this after touching palettes.js, Chip.js or
 * contrast.js.
 *
 * Exits non-zero on any failure so it can gate CI.
 */

import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = (p) => path.join(here, '..', 'src', p);

const { resolveColors } = await import(src('theme/palettes.js'));
const { ensureContrast, bestLabelOn, ensureFillOn, contrastRatio, composite, neutralBackdrop, surfaceBackdrop } =
  await import(src('ui-kit/contrast.js'));

// The mobile design system is dark-only. `porcelain` exists in the shared
// palette registry for the web shell; it is intentionally out of scope here.
const PALETTES = ['infinibot-gold', 'noir', 'aurora', 'ember', 'forest'];
const MODES = ['dark', 'hud'];
const CHIP_STATES = [['normal', 0.07], ['solid', 0.1], ['selected', 0.14], ['badge', 0.1]];

let fails = 0;
let checks = 0;
let worst = { r: Infinity };

function check(label, fg, bg, min, ctx) {
  checks += 1;
  const r = contrastRatio(composite(fg, bg), bg);
  if (r < min) {
    fails += 1;
    console.log(`  FAIL ${ctx} ${label}: ${r.toFixed(2)}:1 (need ${min})`);
  }
  if (r < worst.r) worst = { r, label, ctx };
  return r;
}

for (const paletteId of PALETTES) {
  for (const mode of MODES) {
    const c = resolveColors({ mode, paletteId, tokens: {} });
    const ctx = `${paletteId}/${mode}`;
    const bg = c.background;

    // 1. Body text tokens straight on the app background.
    for (const key of ['text', 'textStrong', 'textSecondary', 'textMuted', 'textDim']) {
      check(`colors.${key}`, c[key], bg, 4.5, ctx);
    }
    // textTertiary is icon-only by policy (see ListRow) — 3:1 non-text floor.
    check('colors.textTertiary (icons only)', c.textTertiary, bg, 3, ctx);

    // 2. Semantic tones as text on the app background (StatCard deltas etc.).
    for (const key of ['primary', 'success', 'warning', 'error', 'info']) {
      check(`colors.${key} as text`, c[key], bg, 4.5, ctx);
    }

    // 3. Chip / Badge labels on the neutral fill they actually paint on.
    const tones = {
      neutral: c.text, primary: c.primary, success: c.success,
      warning: c.warning, danger: c.error, info: c.info, accent: c.accent,
    };
    for (const [tone, col] of Object.entries(tones)) {
      for (const [state, alpha] of CHIP_STATES) {
        const chipBg = neutralBackdrop(c, alpha);
        check(`chip ${tone}/${state}`, ensureContrast(col, chipBg, 4.5), chipBg, 4.5, ctx);
      }
    }

    // 4. Primary button label on every stop of the gold gradient. Button
    //    resolves its label against the darkest stop, so check that colour
    //    against all of them.
    const grad = c.goldGradient || [];
    if (grad.length) {
      const btnLabel = bestLabelOn(grad, { min: 4.5, preferred: c.userBubbleText });
      ensureFillOn(grad, btnLabel, 4.5).forEach((stop, i) => {
        check(`primary button label on gradient stop ${i}`, btnLabel, stop, 4.5, ctx);
      });
    }

    // 5. Card interior — body text on the lightest point of the glass stack.
    check('colors.text on card top', c.text, surfaceBackdrop(c), 4.5, ctx);
    check('colors.textSecondary on card top', c.textSecondary, surfaceBackdrop(c), 4.5, ctx);
  }
}

if (fails) {
  console.log(`\n${fails}/${checks} contrast checks FAILED`);
  process.exit(1);
}
console.log(
  `PASS — ${checks} contrast checks clear their thresholds across ` +
  `${PALETTES.length} dark palettes x ${MODES.length} modes.\n` +
  `Tightest pair: ${worst.ctx} ${worst.label} at ${worst.r.toFixed(2)}:1`,
);
