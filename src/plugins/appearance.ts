/**
 * Per-plugin appearance — declared, typed, themeable settings.
 *
 * A manifest-v2 plugin may declare an `appearance` block (accent, surface
 * tint, density, font scale, icon/monogram, layout options and its own CSS
 * variables). Defaults must reference InfiniBot design tokens
 * (`token:primary`, `token:info`, …) so an untouched plugin looks native. The
 * owner overrides values per plugin (`plugins.entries.<id>.appearance`); every
 * colour an override introduces is checked against WCAG AA for BOTH the dark
 * and the light theme and auto-adjusted (or rejected in strict mode) when it
 * fails.
 *
 * The resolved result is a pair of CSS custom-property maps (dark, light). The
 * control UI applies them on the plugin's scope container only
 * (`[data-plugin-scope="<id>"]`), so they cascade into that plugin's pages,
 * sub-views, widgets and panels and never into core UI or other plugins.
 *
 * Design: docs/plugins/PLUGIN-PLATFORM.md §3.2 (appearance), §3.4.
 */

export type ThemeName = "dark" | "light";
export const THEMES: readonly ThemeName[] = ["dark", "light"];

/** Design tokens a plugin may reference, with the CSS var the UI uses and the
 *  concrete colour per theme (for contrast maths on the gateway side). The
 *  values mirror ui/src/ui/theme-glass.ts + ui/src/styles/base.css. */
export const APPEARANCE_TOKENS: Readonly<
  Record<string, { cssVar: string; dark: string; light: string }>
> = {
  primary: { cssVar: "--g-primary", dark: "#fbbf24", light: "#fbbf24" },
  accent: { cssVar: "--g-accent", dark: "#a855f7", light: "#a855f7" },
  info: { cssVar: "--g-info", dark: "#38bdf8", light: "#0891b2" },
  success: { cssVar: "--g-success", dark: "#22c55e", light: "#16a34a" },
  warning: { cssVar: "--g-warning", dark: "#f59e0b", light: "#d97706" },
  danger: { cssVar: "--g-danger", dark: "#ef4444", light: "#dc2626" },
  neutral: { cssVar: "--g-neutral", dark: "#94a3b8", light: "#64748b" },
  text: { cssVar: "--g-fg", dark: "#f5f5f4", light: "#18181b" },
  muted: { cssVar: "--muted", dark: "#a1a1aa", light: "#71717a" },
  surface: { cssVar: "--card", dark: "#0f0f0f", light: "#ffffff" },
  bg: { cssVar: "--g-bg", dark: "#0a0a0e", light: "#f4f4f5" },
};

export type AppearanceDensity = "compact" | "comfortable";

export type AppearanceLayoutOption = {
  id: string;
  label: string;
  type: "select" | "toggle";
  options?: { value: string; label: string }[];
  default: string | boolean;
};

export type AppearanceVariable = {
  /** Must be namespaced `--plugin-<id>-*`. */
  name: string;
  label: string;
  type: "color" | "length" | "number" | "select";
  default: string | number;
  /** Colour role for the contrast check: "text" needs 4.5:1, "ui" 3:1. */
  role?: "text" | "ui" | "decorative";
  options?: string[];
  min?: number;
  max?: number;
};

/** The manifest's declared appearance (defaults). */
export type PluginAppearanceManifest = {
  accent: string;
  tint: string;
  tintStrength: number;
  density: AppearanceDensity;
  fontScale: number;
  icon?: string;
  monogram?: string;
  layout: AppearanceLayoutOption[];
  variables: AppearanceVariable[];
};

/** Owner overrides stored in plugins.entries.<id>.appearance. */
export type PluginAppearanceOverride = {
  accent?: string;
  tint?: string;
  tintStrength?: number;
  density?: AppearanceDensity;
  fontScale?: number;
  icon?: string;
  monogram?: string;
  layout?: Record<string, string | boolean>;
  variables?: Record<string, string | number>;
};

export type AppearanceAdjustment = {
  theme: ThemeName;
  field: string;
  from: string;
  to: string;
  reason: string;
};

export type ResolvedPluginAppearance = {
  pluginId: string;
  /** Manifest defaults merged with the owner's override. */
  values: Required<Omit<PluginAppearanceOverride, "icon" | "monogram">> & {
    icon?: string;
    monogram?: string;
  };
  defaults: PluginAppearanceManifest;
  /** True when the owner changed anything. */
  customized: boolean;
  /** CSS custom properties per theme, to set on the plugin's scope container. */
  themes: Record<ThemeName, { vars: Record<string, string>; contrast: Record<string, number> }>;
  adjustments: AppearanceAdjustment[];
};

export const DEFAULT_APPEARANCE: PluginAppearanceManifest = {
  accent: "token:primary",
  tint: "none",
  tintStrength: 0.06,
  density: "comfortable",
  fontScale: 1,
  layout: [],
  variables: [],
};

export const FONT_SCALE_RANGE = { min: 0.85, max: 1.3 } as const;
export const TINT_STRENGTH_RANGE = { min: 0, max: 0.3 } as const;
/** WCAG 2.1 AA: 4.5:1 for normal text, 3:1 for large text / UI components. */
export const AA_TEXT = 4.5;
export const AA_UI = 3;

// ── colour maths ──────────────────────────────────────────────────────────

type Rgb = [number, number, number];

const HEX_RE = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

export function isHexColor(value: string): boolean {
  return HEX_RE.test(value.trim());
}

export function parseHex(value: string): Rgb | null {
  const m = HEX_RE.exec(value.trim());
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h.replace(/./g, (c) => c + c);
  return [0, 2, 4].map((i) => Number.parseInt(h.slice(i, i + 2), 16)) as Rgb;
}

export function toHex(rgb: Rgb): string {
  return `#${rgb
    .map((c) =>
      Math.round(Math.max(0, Math.min(255, c)))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

function channel(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance(rgb: Rgb): number {
  return 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);
}

export function contrastRatio(a: string, b: string): number {
  const ra = parseHex(a);
  const rb = parseHex(b);
  if (!ra || !rb) return 1;
  const la = relativeLuminance(ra);
  const lb = relativeLuminance(rb);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
}

/** `top` composited over `bottom` at `alpha`. */
export function mixHex(top: string, bottom: string, alpha: number): string {
  const t = parseHex(top);
  const b = parseHex(bottom);
  if (!t || !b) return bottom;
  return toHex([0, 1, 2].map((i) => t[i] * alpha + b[i] * (1 - alpha)) as Rgb);
}

/**
 * Move `color` toward white (dark theme) or black (light theme) until it
 * reaches `min` contrast against `against`. Keeps the hue; returns the
 * closest passing colour.
 */
export function adjustForContrast(
  color: string,
  against: string,
  min: number,
  theme: ThemeName,
): string {
  if (contrastRatio(color, against) >= min) return color;
  const target = theme === "dark" ? "#ffffff" : "#000000";
  for (let step = 1; step <= 20; step++) {
    const candidate = mixHex(target, color, step / 20);
    if (contrastRatio(candidate, against) >= min) return candidate;
  }
  return target;
}

/** Concrete colour of a value (hex or token:<name>) for a theme. */
export function resolveColor(value: string, theme: ThemeName): string | null {
  const v = value.trim();
  if (isHexColor(v)) return toHex(parseHex(v) as Rgb);
  const token = tokenName(v);
  if (token && APPEARANCE_TOKENS[token]) return APPEARANCE_TOKENS[token][theme];
  return null;
}

function tokenName(value: string): string | null {
  const m = /^token:([a-z][a-z0-9-]*)$/.exec(value.trim());
  return m ? m[1] : null;
}

export function isTokenRef(value: string): boolean {
  const t = tokenName(value);
  return Boolean(t && APPEARANCE_TOKENS[t]);
}

/** CSS expression for a colour value (token → var(), hex → itself). */
function cssColor(value: string, theme: ThemeName): string {
  const token = tokenName(value);
  if (token && APPEARANCE_TOKENS[token]) {
    return `var(${APPEARANCE_TOKENS[token].cssVar}, ${APPEARANCE_TOKENS[token][theme]})`;
  }
  return value;
}

// ── manifest parsing ─────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

const ID_RE = /^[a-z][a-z0-9-]*$/;

/**
 * Parse a manifest `appearance` block. Colour defaults must be token
 * references so an untouched plugin inherits the host theme; anything
 * malformed fails closed (the manifest is a contract).
 */
export function parseAppearanceManifest(
  pluginId: string,
  raw: unknown,
): { ok: true; appearance: PluginAppearanceManifest } | { ok: false; error: string } {
  if (raw === undefined) return { ok: true, appearance: { ...DEFAULT_APPEARANCE } };
  if (!isRecord(raw)) return { ok: false, error: "appearance must be an object" };
  const out: PluginAppearanceManifest = { ...DEFAULT_APPEARANCE, layout: [], variables: [] };

  const colorDefault = (field: "accent" | "tint"): string | { error: string } | undefined => {
    const v = str(raw[field]);
    if (v === undefined) return undefined;
    if (field === "tint" && v === "none") return v;
    if (!isTokenRef(v)) {
      return {
        error: `appearance.${field} default must be an InfiniBot token (token:${Object.keys(APPEARANCE_TOKENS).join("|token:")}), got "${v}"`,
      };
    }
    return v;
  };
  for (const field of ["accent", "tint"] as const) {
    const v = colorDefault(field);
    if (typeof v === "object") return { ok: false, error: v.error };
    if (v) out[field] = v;
  }

  if (raw.tintStrength !== undefined) {
    const n = raw.tintStrength;
    if (typeof n !== "number" || n < TINT_STRENGTH_RANGE.min || n > TINT_STRENGTH_RANGE.max) {
      return { ok: false, error: `appearance.tintStrength must be a number in [0, 0.3]` };
    }
    out.tintStrength = n;
  }
  if (raw.density !== undefined) {
    if (raw.density !== "compact" && raw.density !== "comfortable") {
      return { ok: false, error: 'appearance.density must be "compact" or "comfortable"' };
    }
    out.density = raw.density;
  }
  if (raw.fontScale !== undefined) {
    const n = raw.fontScale;
    if (typeof n !== "number" || n < FONT_SCALE_RANGE.min || n > FONT_SCALE_RANGE.max) {
      return { ok: false, error: `appearance.fontScale must be a number in [0.85, 1.3]` };
    }
    out.fontScale = n;
  }
  const icon = str(raw.icon);
  if (icon) out.icon = icon;
  const monogram = str(raw.monogram);
  if (monogram) {
    if (monogram.length > 3)
      return { ok: false, error: "appearance.monogram is at most 3 characters" };
    out.monogram = monogram;
  }

  for (const l of Array.isArray(raw.layout) ? raw.layout : []) {
    if (!isRecord(l)) return { ok: false, error: "appearance.layout entries must be objects" };
    const id = str(l.id);
    const label = str(l.label) ?? id;
    const type = l.type === "toggle" ? "toggle" : l.type === "select" ? "select" : undefined;
    if (!id || !ID_RE.test(id) || !label || !type) {
      return {
        ok: false,
        error: "appearance.layout entries need id (kebab-case), label, type select|toggle",
      };
    }
    if (type === "toggle") {
      if (typeof l.default !== "boolean") {
        return { ok: false, error: `appearance.layout "${id}" toggle needs a boolean default` };
      }
      out.layout.push({ id, label, type, default: l.default });
    } else {
      const options = (Array.isArray(l.options) ? l.options : [])
        .map((o) =>
          isRecord(o)
            ? { value: str(o.value) ?? "", label: str(o.label) ?? str(o.value) ?? "" }
            : { value: str(o) ?? "", label: str(o) ?? "" },
        )
        .filter((o) => o.value);
      const def = str(l.default);
      if (options.length === 0 || !def || !options.some((o) => o.value === def)) {
        return {
          ok: false,
          error: `appearance.layout "${id}" select needs options and a default among them`,
        };
      }
      out.layout.push({ id, label, type, options, default: def });
    }
  }

  const prefix = `--plugin-${pluginId}-`;
  for (const v of Array.isArray(raw.variables) ? raw.variables : []) {
    if (!isRecord(v)) return { ok: false, error: "appearance.variables entries must be objects" };
    const name = str(v.name);
    if (!name || !name.startsWith(prefix) || !/^--[a-z0-9-]+$/.test(name)) {
      return { ok: false, error: `appearance variable "${name ?? ""}" must be named ${prefix}*` };
    }
    const type = v.type;
    if (type !== "color" && type !== "length" && type !== "number" && type !== "select") {
      return {
        ok: false,
        error: `appearance variable ${name} needs type color|length|number|select`,
      };
    }
    const label = str(v.label) ?? name;
    const role =
      v.role === "text" || v.role === "ui" || v.role === "decorative" ? v.role : undefined;
    let def: string | number;
    if (type === "color") {
      const d = str(v.default);
      if (!d || !isTokenRef(d)) {
        return {
          ok: false,
          error: `appearance variable ${name} default must be an InfiniBot token (token:*)`,
        };
      }
      def = d;
    } else if (type === "number") {
      if (typeof v.default !== "number")
        return { ok: false, error: `appearance variable ${name} needs a number default` };
      def = v.default;
    } else if (type === "length") {
      const d = str(v.default);
      if (!d || !/^-?\d+(\.\d+)?(px|rem|em|%)$/.test(d)) {
        return {
          ok: false,
          error: `appearance variable ${name} needs a length default like "12px"`,
        };
      }
      def = d;
    } else {
      const d = str(v.default);
      const options = Array.isArray(v.options)
        ? v.options.map((o) => str(o)).filter((o): o is string => Boolean(o))
        : [];
      if (!d || !options.includes(d)) {
        return {
          ok: false,
          error: `appearance variable ${name} select needs options and a default among them`,
        };
      }
      out.variables.push({ name, label, type, default: d, options });
      continue;
    }
    out.variables.push({
      name,
      label,
      type,
      default: def,
      role,
      min: typeof v.min === "number" ? v.min : undefined,
      max: typeof v.max === "number" ? v.max : undefined,
    });
  }
  return { ok: true, appearance: out };
}

// ── overrides ────────────────────────────────────────────────────────────

function validColorValue(v: string, allowNone: boolean): boolean {
  return isHexColor(v) || isTokenRef(v) || (allowNone && v === "none");
}

/**
 * Validate + sanitize an owner override against the plugin's declared
 * appearance. Unknown keys are rejected so a typo doesn't silently no-op.
 */
export function validateAppearanceOverride(
  manifest: PluginAppearanceManifest,
  raw: unknown,
): { ok: true; value: PluginAppearanceOverride } | { ok: false; errors: string[] } {
  if (raw === undefined || raw === null) return { ok: true, value: {} };
  if (!isRecord(raw)) return { ok: false, errors: ["appearance must be an object"] };
  const errors: string[] = [];
  const out: PluginAppearanceOverride = {};
  const known = new Set([
    "accent",
    "tint",
    "tintStrength",
    "density",
    "fontScale",
    "icon",
    "monogram",
    "layout",
    "variables",
  ]);
  for (const key of Object.keys(raw))
    if (!known.has(key)) errors.push(`unknown appearance field "${key}"`);

  if (raw.accent !== undefined) {
    const v = str(raw.accent);
    if (!v || !validColorValue(v, false)) errors.push("accent must be a #hex colour or token:*");
    else out.accent = v;
  }
  if (raw.tint !== undefined) {
    const v = str(raw.tint);
    if (!v || !validColorValue(v, true))
      errors.push('tint must be a #hex colour, token:* or "none"');
    else out.tint = v;
  }
  if (raw.tintStrength !== undefined) {
    const n = raw.tintStrength;
    if (typeof n !== "number" || n < TINT_STRENGTH_RANGE.min || n > TINT_STRENGTH_RANGE.max) {
      errors.push("tintStrength must be in [0, 0.3]");
    } else out.tintStrength = n;
  }
  if (raw.density !== undefined) {
    if (raw.density !== "compact" && raw.density !== "comfortable")
      errors.push("density must be compact|comfortable");
    else out.density = raw.density;
  }
  if (raw.fontScale !== undefined) {
    const n = raw.fontScale;
    if (typeof n !== "number" || n < FONT_SCALE_RANGE.min || n > FONT_SCALE_RANGE.max) {
      errors.push("fontScale must be in [0.85, 1.3]");
    } else out.fontScale = n;
  }
  if (raw.icon !== undefined) {
    const v = str(raw.icon);
    if (!v || !/^[a-z0-9-]{1,40}$/.test(v)) errors.push("icon must be an icon name");
    else out.icon = v;
  }
  if (raw.monogram !== undefined) {
    const v = str(raw.monogram);
    if (!v || v.length > 3) errors.push("monogram must be 1-3 characters");
    else out.monogram = v;
  }
  if (raw.layout !== undefined) {
    if (!isRecord(raw.layout)) errors.push("layout must be an object");
    else {
      const layout: Record<string, string | boolean> = {};
      for (const [id, value] of Object.entries(raw.layout)) {
        const decl = manifest.layout.find((l) => l.id === id);
        if (!decl) errors.push(`unknown layout option "${id}"`);
        else if (decl.type === "toggle" && typeof value !== "boolean")
          errors.push(`layout "${id}" must be boolean`);
        else if (decl.type === "select" && !decl.options?.some((o) => o.value === value)) {
          errors.push(
            `layout "${id}" must be one of ${decl.options?.map((o) => o.value).join(", ")}`,
          );
        } else layout[id] = value as string | boolean;
      }
      out.layout = layout;
    }
  }
  if (raw.variables !== undefined) {
    if (!isRecord(raw.variables)) errors.push("variables must be an object");
    else {
      const vars: Record<string, string | number> = {};
      for (const [name, value] of Object.entries(raw.variables)) {
        const decl = manifest.variables.find((v) => v.name === name);
        if (!decl) {
          errors.push(`unknown appearance variable "${name}"`);
          continue;
        }
        if (decl.type === "color") {
          if (typeof value !== "string" || !validColorValue(value, false))
            errors.push(`${name} must be a colour`);
          else vars[name] = value;
        } else if (decl.type === "number") {
          if (typeof value !== "number" || !Number.isFinite(value))
            errors.push(`${name} must be a number`);
          else if (
            (decl.min !== undefined && value < decl.min) ||
            (decl.max !== undefined && value > decl.max)
          ) {
            errors.push(`${name} out of range`);
          } else vars[name] = value;
        } else if (decl.type === "length") {
          if (typeof value !== "string" || !/^-?\d+(\.\d+)?(px|rem|em|%)$/.test(value))
            errors.push(`${name} must be a length`);
          else vars[name] = value;
        } else if (typeof value !== "string" || !decl.options?.includes(value)) {
          errors.push(`${name} must be one of ${decl.options?.join(", ")}`);
        } else vars[name] = value;
      }
      out.variables = vars;
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true, value: out };
}

/** Colour contrast failures an override would cause, per theme (no adjust). */
export function findContrastFailures(
  pluginId: string,
  manifest: PluginAppearanceManifest,
  override: PluginAppearanceOverride,
): AppearanceAdjustment[] {
  return resolvePluginAppearance(pluginId, manifest, override).adjustments;
}

/**
 * Merge defaults + override and compute the per-theme CSS variables.
 * Default token values emit no core-var overrides at all, so an untouched
 * plugin renders exactly like core. Custom colours are contrast-checked per
 * theme and nudged until they pass AA; every nudge is reported.
 */
export function resolvePluginAppearance(
  pluginId: string,
  manifest: PluginAppearanceManifest | undefined,
  override: PluginAppearanceOverride | undefined,
): ResolvedPluginAppearance {
  const defaults = manifest ?? DEFAULT_APPEARANCE;
  const o = override ?? {};
  const layout: Record<string, string | boolean> = {};
  for (const l of defaults.layout) layout[l.id] = o.layout?.[l.id] ?? l.default;
  const variables: Record<string, string | number> = {};
  for (const v of defaults.variables) variables[v.name] = o.variables?.[v.name] ?? v.default;
  const values = {
    accent: o.accent ?? defaults.accent,
    tint: o.tint ?? defaults.tint,
    tintStrength: o.tintStrength ?? defaults.tintStrength,
    density: o.density ?? defaults.density,
    fontScale: o.fontScale ?? defaults.fontScale,
    icon: o.icon ?? defaults.icon,
    monogram: o.monogram ?? defaults.monogram,
    layout,
    variables,
  };
  const customized = Object.keys(o).some((k) => {
    const v = (o as Record<string, unknown>)[k];
    return v !== undefined && !(isRecord(v) && Object.keys(v).length === 0);
  });

  const adjustments: AppearanceAdjustment[] = [];
  const themes = {} as ResolvedPluginAppearance["themes"];
  const ns = `--plugin-${pluginId}`;

  for (const theme of THEMES) {
    const vars: Record<string, string> = {};
    const contrast: Record<string, number> = {};
    const surface = APPEARANCE_TOKENS.surface[theme];
    const text = APPEARANCE_TOKENS.text[theme];

    // Surface tint first: accent contrast is measured on the tinted surface.
    let effectiveSurface = surface;
    if (values.tint !== "none") {
      const tint = resolveColor(values.tint, theme);
      if (tint) {
        let strength = values.tintStrength;
        let tinted = mixHex(tint, surface, strength);
        while (
          strength > 0 &&
          (contrastRatio(text, tinted) < AA_TEXT ||
            contrastRatio(APPEARANCE_TOKENS.muted[theme], tinted) < AA_UI)
        ) {
          strength = Math.max(0, Math.round((strength - 0.01) * 100) / 100);
          tinted = mixHex(tint, surface, strength);
        }
        if (strength !== values.tintStrength) {
          adjustments.push({
            theme,
            field: "tintStrength",
            from: String(values.tintStrength),
            to: String(strength),
            reason: `text on the tinted surface fell below AA (${AA_TEXT}:1)`,
          });
        }
        effectiveSurface = tinted;
        contrast.textOnSurface = contrastRatio(text, tinted);
        const pct = `${Math.round(strength * 100)}%`;
        vars[`${ns}-tint`] =
          `color-mix(in srgb, ${cssColor(values.tint, theme)} ${pct}, transparent)`;
        vars["--plugin-tint"] = vars[`${ns}-tint`];
        vars["--plugin-surface"] = tinted;
      }
    }

    // --plugin-accent is the SDK's text-safe accent: always AA on the theme
    // surface, even when it comes from a token (gold on white is ~1.7:1).
    // Core tokens inside the scope are only re-pointed when the owner
    // customises the accent, so an untouched plugin renders exactly as core.
    const accentIsDefault = values.accent === defaults.accent && isTokenRef(values.accent);
    let accentCss = cssColor(values.accent, theme);
    let coreAccentCss = accentCss;
    const accentHex = resolveColor(values.accent, theme);
    if (accentHex) {
      contrast.accentOnSurface = contrastRatio(accentHex, effectiveSurface);
      const fixed = adjustForContrast(accentHex, effectiveSurface, AA_TEXT, theme);
      if (fixed !== accentHex) {
        adjustments.push({
          theme,
          field: isTokenRef(values.accent) ? `accent (${values.accent})` : "accent",
          from: accentHex,
          to: fixed,
          reason: `accent text contrast ${contrast.accentOnSurface}:1 < ${AA_TEXT}:1 on the ${theme} surface`,
        });
        contrast.accentOnSurface = contrastRatio(fixed, effectiveSurface);
        accentCss = fixed;
        // A custom colour is corrected everywhere in the scope; a token keeps
        // the core look for fills/borders and only the text-safe var moves.
        if (!isTokenRef(values.accent)) coreAccentCss = fixed;
      }
    }
    vars[`${ns}-accent`] = accentCss;
    vars["--plugin-accent"] = accentCss;
    if (!accentIsDefault) {
      // Re-point the core accent tokens *inside the scope only*.
      const c = coreAccentCss;
      for (const v of [
        "--g-primary",
        "--primary",
        "--accent",
        "--c-accent",
        "--ring",
        "--border-hover",
      ]) {
        vars[v] = c;
      }
      vars["--g-primary-soft"] = `color-mix(in srgb, ${c} 8%, transparent)`;
      vars["--g-primary-muted"] = `color-mix(in srgb, ${c} 18%, transparent)`;
      vars["--g-primary-strong"] = `color-mix(in srgb, ${c} 35%, transparent)`;
      vars["--accent-subtle"] = `color-mix(in srgb, ${c} 15%, transparent)`;
      vars["--accent-glow"] = `color-mix(in srgb, ${c} 30%, transparent)`;
      vars["--g-border"] = `color-mix(in srgb, ${c} 18%, rgba(127, 127, 127, 0.12))`;
    }

    const densityScale = values.density === "compact" ? 0.8 : 1;
    vars[`${ns}-density`] = values.density;
    vars["--plugin-density-scale"] = String(densityScale);
    vars["--plugin-space"] = `${Math.round(12 * densityScale)}px`;
    vars[`${ns}-font-scale`] = String(values.fontScale);
    vars["--plugin-font-scale"] = String(values.fontScale);

    for (const decl of defaults.variables) {
      const value = variables[decl.name];
      if (decl.type === "color" && typeof value === "string") {
        let css = cssColor(value, theme);
        const hex = resolveColor(value, theme);
        const min = decl.role === "text" ? AA_TEXT : decl.role === "ui" ? AA_UI : 0;
        if (hex && min > 0 && !isTokenRef(value)) {
          const fixed = adjustForContrast(hex, effectiveSurface, min, theme);
          if (fixed !== hex) {
            adjustments.push({
              theme,
              field: decl.name,
              from: hex,
              to: fixed,
              reason: `contrast ${contrastRatio(hex, effectiveSurface)}:1 < ${min}:1 on the ${theme} surface`,
            });
          }
          css = fixed;
        }
        vars[decl.name] = css;
      } else {
        vars[decl.name] = String(value);
      }
    }
    for (const [id, value] of Object.entries(layout)) vars[`${ns}-layout-${id}`] = String(value);

    themes[theme] = { vars, contrast };
  }

  return { pluginId, values, defaults, customized, themes, adjustments };
}

/**
 * Stylesheet that applies resolved appearances, strictly scoped to each
 * plugin's container. Dark rules are the default (dark + hud themes); light
 * rules win under :root[data-theme="light"].
 */
export function buildAppearanceStylesheet(list: ResolvedPluginAppearance[]): string {
  const safe = (v: string) => v.replace(/[;{}<>]/g, "");
  const block = (vars: Record<string, string>) =>
    Object.entries(vars)
      .map(([k, v]) => `  ${k}: ${safe(v)};`)
      .join("\n");
  const out: string[] = [];
  for (const a of list) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(a.pluginId)) continue;
    const sel = `[data-plugin-scope="${a.pluginId}"]`;
    out.push(`${sel} {\n${block(a.themes.dark.vars)}\n}`);
    out.push(`:root[data-theme="light"] ${sel} {\n${block(a.themes.light.vars)}\n}`);
  }
  return out.join("\n");
}
