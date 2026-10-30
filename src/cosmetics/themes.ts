/**
 * Cosmetic theme registry for the Agency World map.
 *
 * A theme is a flat map of `--world-*` CSS custom properties. The world
 * environment / atmosphere / overlay / emote / audio layers read these via a
 * cascade rooted at `:root[data-world-theme="<id>"]` (see ../cosmetics/index).
 * Adding a theme here is enough — the CSS block is generated from this data, so
 * the tokens and the stylesheet can never drift apart.
 */

export interface CosmeticTheme {
  id: string;
  label: string;
  description: string;
  /** Two representative colours for the picker swatch ring. */
  preview: [string, string];
  /** `--world-*` token → value. */
  tokens: {
    bg: string;
    surface: string;
    "surface-2": string;
    border: string;
    text: string;
    muted: string;
    accent: string;
    "accent-strong": string;
    grid: string;
    beam: string;
    "status-running": string;
    "status-idle": string;
    "status-error": string;
    "status-complete": string;
  };
}

export const DEFAULT_THEME_ID = "black-gold";

export const COSMETIC_THEMES: CosmeticTheme[] = [
  {
    id: "black-gold",
    label: "Black & Gold",
    description: "The signature InfiniBot palette — obsidian world, molten-gold accents.",
    preview: ["#0a0a0a", "#f5c451"],
    tokens: {
      bg: "#050505",
      surface: "#0f0f0f",
      "surface-2": "#161310",
      border: "rgba(245,196,81,0.22)",
      text: "#efe8d6",
      muted: "#9a9182",
      accent: "#f5c451",
      "accent-strong": "#ffd773",
      grid: "rgba(245,196,81,0.12)",
      beam: "#f5c451",
      "status-running": "#f5c451",
      "status-idle": "#6b6456",
      "status-error": "#ef4444",
      "status-complete": "#22c55e",
    },
  },
  {
    id: "midnight",
    label: "Midnight Blue & Silver",
    description: "Deep navy void with cool silver-blue light — calm, technical, nocturnal.",
    preview: ["#0e1626", "#c7d4ea"],
    tokens: {
      bg: "#060a14",
      surface: "#0e1626",
      "surface-2": "#141f33",
      border: "rgba(143,166,201,0.26)",
      text: "#d8e0ee",
      muted: "#8794ab",
      accent: "#8fa6c9",
      "accent-strong": "#c7d4ea",
      grid: "rgba(143,166,201,0.14)",
      beam: "#6ea8ff",
      "status-running": "#6ea8ff",
      "status-idle": "#475569",
      "status-error": "#f87171",
      "status-complete": "#34d399",
    },
  },
  {
    id: "emerald",
    label: "Forest Emerald & Cream",
    description: "Mossy forest-floor darks lit by emerald glow over a warm cream type.",
    preview: ["#0f1f17", "#6ee7b7"],
    tokens: {
      bg: "#07120d",
      surface: "#0f1f17",
      "surface-2": "#15291f",
      border: "rgba(46,207,143,0.24)",
      text: "#eef3e6",
      muted: "#8aa093",
      accent: "#2ecf8f",
      "accent-strong": "#6ee7b7",
      grid: "rgba(46,207,143,0.14)",
      beam: "#3ddc97",
      "status-running": "#2ecf8f",
      "status-idle": "#5b6b60",
      "status-error": "#e07a5f",
      "status-complete": "#a3e635",
    },
  },
  {
    id: "crimson",
    label: "Crimson Noir",
    description: "Black-wine noir with arterial crimson light — high-drama, cinematic.",
    preview: ["#170a0d", "#ff6b81"],
    tokens: {
      bg: "#0a0405",
      surface: "#170a0d",
      "surface-2": "#220f13",
      border: "rgba(226,59,84,0.26)",
      text: "#f1dcdf",
      muted: "#a3848a",
      accent: "#e23b54",
      "accent-strong": "#ff6b81",
      grid: "rgba(226,59,84,0.14)",
      beam: "#ff4d6d",
      "status-running": "#e23b54",
      "status-idle": "#5c4146",
      "status-error": "#ff8585",
      "status-complete": "#f59e0b",
    },
  },
];

export function getTheme(id: string): CosmeticTheme | undefined {
  return COSMETIC_THEMES.find((t) => t.id === id);
}
