/**
 * Built-in production block catalog.
 *
 * Each block ships with: text slots, style schema (every visible knob), and
 * 3-5 named presets. The video editor's properties inspector auto-generates
 * controls from the schema, so a new block only needs to be added here.
 *
 * Consumers should never mutate these definitions — clone before customising.
 */

import type { BlockDefinition, BlockStyleField } from "./types.js";

// ── Reusable style-field factories ──────────────────────────

const FONT_SUGGESTIONS = [
  "Inter, system-ui, sans-serif",
  "Outfit, system-ui, sans-serif",
  "Plus Jakarta Sans, sans-serif",
  "Manrope, sans-serif",
  "Space Grotesk, sans-serif",
  "Bricolage Grotesque, serif",
  "Playfair Display, serif",
  "Lora, serif",
  "DM Serif Display, serif",
  "JetBrains Mono, monospace",
  "IBM Plex Mono, monospace",
  "Geist, system-ui, sans-serif",
];

function color(id: string, label: string, def: string, group = "Colors"): BlockStyleField {
  return { id, label, kind: "color", default: def, group };
}
function font(id: string, label: string, def: string, group = "Typography"): BlockStyleField {
  return { id, label, kind: "font", default: def, group, suggestions: FONT_SUGGESTIONS };
}
/**
 * Inline literal for `BlockStyleField`'s number-variant `unit` field —
 * the original conditional `BlockStyleField extends { kind: "number" }`
 * collapsed to `never` because the union distributes element-wise.
 * Hard-coding the literal mirrors the type defined in types.ts and
 * keeps every call site type-checked against the same allowlist.
 */
type NumberUnit = "px" | "em" | "%" | "deg" | "ms" | "x" | "";

function num(
  id: string,
  label: string,
  def: number,
  opts: { min?: number; max?: number; step?: number; unit?: NumberUnit; group?: string } = {},
): BlockStyleField {
  return {
    id,
    label,
    kind: "number",
    default: def,
    min: opts.min,
    max: opts.max,
    step: opts.step,
    unit: opts.unit,
    group: opts.group ?? "Layout",
  };
}
function pickOne(id: string, label: string, def: string, options: Array<{ value: string; label: string }>, group = "Style"): BlockStyleField {
  return { id, label, kind: "select", default: def, options, group };
}
function text(id: string, label: string, def: string, group = "Style"): BlockStyleField {
  return { id, label, kind: "text", default: def, group };
}
function shadow(id: string, label: string, def: string, group = "Effects"): BlockStyleField {
  return { id, label, kind: "shadow", default: def, group };
}
function gradient(id: string, label: string, def: string, group = "Background"): BlockStyleField {
  return { id, label, kind: "gradient", default: def, group };
}
function bool(id: string, label: string, def: boolean, group = "Style"): BlockStyleField {
  return { id, label, kind: "boolean", default: def, group };
}

// Common field bundles.
const ALIGN_FIELD = pickOne("align", "Align", "center", [
  { value: "left", label: "Left" },
  { value: "center", label: "Center" },
  { value: "right", label: "Right" },
]);
const TEXT_TRANSFORM_FIELD = pickOne("textTransform", "Text transform", "none", [
  { value: "none", label: "None" },
  { value: "uppercase", label: "UPPERCASE" },
  { value: "lowercase", label: "lowercase" },
  { value: "capitalize", label: "Capitalize" },
]);

// ── Block: Intro Card ───────────────────────────────────────

const INTRO_CARD: BlockDefinition = {
  id: "intro-card",
  label: "Intro Card",
  description: "Bold full-canvas opener with headline, subheadline, and accent bar.",
  tags: ["intro", "title", "open"],
  aspect: "16:9",
  defaultDurationSec: 4,
  slots: [
    { key: "headline", label: "Headline", default: "Your headline here", maxChars: 80 },
    { key: "subheadline", label: "Subheadline", default: "Subheadline goes here", maxChars: 140 },
    { key: "kicker", label: "Kicker", default: "EPISODE 01", maxChars: 32 },
  ],
  styleSchema: [
    color("bg", "Background", "#0b0b0d"),
    color("fg", "Text color", "#f5f5f7"),
    color("accent", "Accent bar", "#a78bfa"),
    color("kickerColor", "Kicker color", "#a78bfa"),
    gradient("overlay", "Overlay", "linear-gradient(180deg, rgba(0,0,0,0) 0%, rgba(0,0,0,0.45) 100%)"),
    font("fontHeadline", "Headline font", "Bricolage Grotesque, serif"),
    font("fontBody", "Body font", "Inter, system-ui, sans-serif"),
    num("headlineSize", "Headline size", 96, { min: 24, max: 200, step: 2, unit: "px" }),
    num("subheadlineSize", "Subheadline size", 22, { min: 10, max: 60, step: 1, unit: "px" }),
    num("kickerSize", "Kicker size", 12, { min: 8, max: 28, step: 1, unit: "px" }),
    num("kickerSpacing", "Kicker letter spacing", 0.18, { min: 0, max: 0.6, step: 0.02, unit: "em" }),
    num("padding", "Padding", 80, { min: 0, max: 200, step: 4, unit: "px" }),
    num("accentWidth", "Accent bar width", 84, { min: 0, max: 240, step: 2, unit: "px" }),
    num("accentHeight", "Accent bar height", 6, { min: 0, max: 40, step: 1, unit: "px" }),
    num("borderRadius", "Border radius", 0, { min: 0, max: 80, step: 1, unit: "px" }),
    shadow("shadow", "Card shadow", "0 24px 48px rgba(0,0,0,.4)"),
    ALIGN_FIELD,
    TEXT_TRANSFORM_FIELD,
  ],
  presets: [
    {
      id: "bold",
      label: "Bold",
      description: "Heavy headline, vibrant accent, dark surface.",
      values: {
        bg: "#0b0b0d",
        fg: "#ffffff",
        accent: "#a78bfa",
        kickerColor: "#a78bfa",
        fontHeadline: "Bricolage Grotesque, serif",
        headlineSize: 110,
      },
    },
    {
      id: "minimal",
      label: "Minimal",
      description: "Tight serif on warm paper.",
      values: {
        bg: "#f1ede4",
        fg: "#0e0d0c",
        accent: "#0e0d0c",
        kickerColor: "#7a6f5a",
        fontHeadline: "Playfair Display, serif",
        fontBody: "Inter, system-ui, sans-serif",
        accentWidth: 48,
        accentHeight: 2,
      },
    },
    {
      id: "editorial",
      label: "Editorial",
      description: "Slim modern serif with high-contrast kicker.",
      values: {
        bg: "#101010",
        fg: "#fafafa",
        accent: "#facc15",
        kickerColor: "#facc15",
        fontHeadline: "DM Serif Display, serif",
        kickerSpacing: 0.28,
        textTransform: "uppercase",
      },
    },
    {
      id: "neon",
      label: "Neon HUD",
      description: "Mono kicker, gold accent, glassmorphism.",
      values: {
        bg: "#06060a",
        fg: "#f5f5f7",
        accent: "var(--g-primary, #facc15)",
        kickerColor: "var(--g-primary, #facc15)",
        fontHeadline: "Space Grotesk, sans-serif",
        fontBody: "JetBrains Mono, monospace",
        kickerSpacing: 0.22,
        textTransform: "uppercase",
      },
    },
  ],
  defaultAnimateIn: { kind: "fade", durationSec: 0.5 },
  defaultPlacement: { x: 0, y: 0, width: 100, height: 100 },
  builtIn: true,
};

// ── Block: Lower Third ──────────────────────────────────────

const LOWER_THIRD: BlockDefinition = {
  id: "lower-third",
  label: "Lower Third",
  description: "Name + role caption with branded accent strip.",
  tags: ["caption", "name", "interview"],
  aspect: "any",
  defaultDurationSec: 5,
  slots: [
    { key: "name", label: "Name", default: "Speaker Name", maxChars: 60 },
    { key: "role", label: "Role / handle", default: "Title or @handle", maxChars: 60 },
  ],
  styleSchema: [
    color("bg", "Background", "rgba(8,8,10,0.78)"),
    color("nameColor", "Name color", "#ffffff"),
    color("roleColor", "Role color", "#a1a1aa"),
    color("accent", "Accent bar", "#22c55e"),
    font("fontName", "Name font", "Inter, system-ui, sans-serif"),
    font("fontRole", "Role font", "Inter, system-ui, sans-serif"),
    num("nameSize", "Name size", 28, { min: 12, max: 80, step: 1, unit: "px" }),
    num("roleSize", "Role size", 14, { min: 8, max: 32, step: 1, unit: "px" }),
    num("padX", "Horizontal padding", 18, { min: 0, max: 60, step: 1, unit: "px" }),
    num("padY", "Vertical padding", 14, { min: 0, max: 40, step: 1, unit: "px" }),
    num("borderRadius", "Border radius", 8, { min: 0, max: 40, step: 1, unit: "px" }),
    num("accentWidth", "Accent bar width", 4, { min: 0, max: 24, step: 1, unit: "px" }),
    shadow("shadow", "Box shadow", "0 8px 24px rgba(0,0,0,.45)"),
    bool("blur", "Glass blur", true, "Effects"),
    pickOne("anchor", "Anchor", "bottom-left", [
      { value: "bottom-left", label: "Bottom Left" },
      { value: "bottom-right", label: "Bottom Right" },
      { value: "bottom-center", label: "Bottom Center" },
      { value: "top-left", label: "Top Left" },
      { value: "top-right", label: "Top Right" },
    ]),
  ],
  presets: [
    {
      id: "broadcast",
      label: "Broadcast",
      description: "Black-glass with green accent.",
      values: { bg: "rgba(8,8,10,0.85)", accent: "#22c55e", borderRadius: 4, blur: true },
    },
    {
      id: "soft",
      label: "Soft",
      description: "Warm card with lavender accent.",
      values: { bg: "rgba(255,255,255,0.92)", nameColor: "#0a0a0a", roleColor: "#525252", accent: "#a78bfa", borderRadius: 14, blur: false },
    },
    {
      id: "glassgold",
      label: "Glass Gold",
      description: "Glass + brand-gold accent for HUD looks.",
      values: { bg: "rgba(8,8,10,0.6)", accent: "var(--g-primary, #facc15)", blur: true, borderRadius: 10 },
    },
  ],
  defaultAnimateIn: { kind: "slideUp", durationSec: 0.4 },
  defaultPlacement: { x: 5, y: 78, width: 38, height: 14 },
  builtIn: true,
};

// ── Block: Kinetic Title ────────────────────────────────────

const KINETIC_TITLE: BlockDefinition = {
  id: "kinetic-title",
  label: "Kinetic Title",
  description: "Word-by-word animated headline with optional underline.",
  tags: ["title", "kinetic", "type"],
  aspect: "any",
  defaultDurationSec: 3,
  slots: [
    { key: "line1", label: "Line 1", default: "Bold." },
    { key: "line2", label: "Line 2", default: "Beautiful." },
    { key: "line3", label: "Line 3", default: "Yours." },
  ],
  styleSchema: [
    color("bg", "Background", "transparent"),
    color("fg", "Text color", "#f5f5f7"),
    color("underline", "Underline color", "#a78bfa"),
    font("font", "Font", "Bricolage Grotesque, serif"),
    num("size", "Size", 92, { min: 24, max: 240, step: 2, unit: "px" }),
    num("lineHeight", "Line height", 1.05, { min: 0.8, max: 1.6, step: 0.05 }),
    num("staggerMs", "Stagger between lines", 200, { min: 0, max: 1000, step: 25, unit: "ms" }),
    num("underlineWidth", "Underline width", 4, { min: 0, max: 20, step: 1, unit: "px" }),
    bool("italic", "Italic", false),
    ALIGN_FIELD,
    TEXT_TRANSFORM_FIELD,
  ],
  presets: [
    { id: "monumental", label: "Monumental", description: "Massive serif, magenta accent.", values: { font: "Playfair Display, serif", size: 140, underline: "#ec4899" } },
    { id: "tight", label: "Tight Sans", description: "Compact modern sans.", values: { font: "Outfit, system-ui, sans-serif", size: 88, lineHeight: 0.95, textTransform: "uppercase" } },
    { id: "tape", label: "Tape", description: "Mono with electric underline.", values: { font: "JetBrains Mono, monospace", size: 72, underline: "#22d3ee", textTransform: "uppercase" } },
  ],
  defaultAnimateIn: { kind: "kinetic", durationSec: 0.6 },
  defaultPlacement: { x: 8, y: 28, width: 84, height: 44 },
  builtIn: true,
};

// ── Block: Stat Card ────────────────────────────────────────

const STAT_CARD: BlockDefinition = {
  id: "stat-card",
  label: "Stat Card",
  description: "Big number + caption + label. Great for proof points.",
  tags: ["stat", "metric", "proof"],
  defaultDurationSec: 4,
  slots: [
    { key: "value", label: "Value", default: "92%" },
    { key: "label", label: "Label", default: "Customer satisfaction" },
    { key: "context", label: "Context (small)", default: "across 12k surveys" },
  ],
  styleSchema: [
    color("bg", "Card background", "#101013"),
    color("valueColor", "Value color", "#a78bfa"),
    color("labelColor", "Label color", "#fafafa"),
    color("contextColor", "Context color", "#9ca3af"),
    color("border", "Border color", "rgba(255,255,255,0.08)"),
    font("fontValue", "Value font", "Bricolage Grotesque, serif"),
    font("fontLabel", "Label font", "Inter, system-ui, sans-serif"),
    num("valueSize", "Value size", 96, { min: 32, max: 220, step: 2, unit: "px" }),
    num("labelSize", "Label size", 18, { min: 10, max: 36, step: 1, unit: "px" }),
    num("contextSize", "Context size", 12, { min: 8, max: 24, step: 1, unit: "px" }),
    num("padding", "Padding", 32, { min: 8, max: 80, step: 2, unit: "px" }),
    num("borderRadius", "Border radius", 18, { min: 0, max: 60, step: 1, unit: "px" }),
    num("borderWidth", "Border width", 1, { min: 0, max: 8, step: 1, unit: "px" }),
    shadow("shadow", "Shadow", "0 12px 40px rgba(0,0,0,.45)"),
  ],
  presets: [
    { id: "soft-glow", label: "Soft Glow", values: { valueColor: "#a78bfa", bg: "#0e0e12", border: "rgba(167,139,250,0.22)" } },
    { id: "money-green", label: "Money Green", values: { valueColor: "#22c55e", bg: "#051811" } },
    { id: "warning", label: "Warning", values: { valueColor: "#f59e0b", bg: "#1a1407" } },
  ],
  defaultAnimateIn: { kind: "scale", durationSec: 0.4 },
  defaultPlacement: { x: 10, y: 25, width: 36, height: 52 },
  builtIn: true,
};

// ── Block: Quote ────────────────────────────────────────────

const QUOTE: BlockDefinition = {
  id: "quote",
  label: "Quote",
  description: "Pull-quote with optional attribution.",
  tags: ["quote", "testimonial"],
  defaultDurationSec: 5,
  slots: [
    { key: "quote", label: "Quote", default: "“The product changed how we ship.”", multiline: true },
    { key: "author", label: "Author", default: "Jane Doe, CEO at Acme" },
  ],
  styleSchema: [
    color("bg", "Background", "#0c0c10"),
    color("fg", "Text color", "#f4f4f5"),
    color("authorColor", "Author color", "#a1a1aa"),
    color("accent", "Accent (quote mark)", "#a78bfa"),
    font("fontQuote", "Quote font", "Lora, serif"),
    font("fontAuthor", "Author font", "Inter, system-ui, sans-serif"),
    num("quoteSize", "Quote size", 36, { min: 14, max: 96, step: 1, unit: "px" }),
    num("authorSize", "Author size", 16, { min: 10, max: 28, step: 1, unit: "px" }),
    num("padding", "Padding", 48, { min: 8, max: 120, step: 2, unit: "px" }),
    num("borderRadius", "Border radius", 18, { min: 0, max: 60, step: 1, unit: "px" }),
    bool("italic", "Italic", true),
  ],
  presets: [
    { id: "editorial", label: "Editorial", values: { fontQuote: "DM Serif Display, serif", italic: false, accent: "#facc15" } },
    { id: "card", label: "Card", values: { bg: "#ffffff", fg: "#0a0a0a", authorColor: "#52525b", accent: "#6366f1", italic: true } },
  ],
  defaultAnimateIn: { kind: "fade", durationSec: 0.6 },
  defaultPlacement: { x: 10, y: 20, width: 80, height: 60 },
  builtIn: true,
};

// ── Block: Bullet List ──────────────────────────────────────

const BULLET_LIST: BlockDefinition = {
  id: "bullet-list",
  label: "Bullet List",
  description: "3-line takeaway list with marker styling.",
  tags: ["list", "summary", "takeaways"],
  defaultDurationSec: 5,
  slots: [
    { key: "title", label: "Title", default: "Three takeaways" },
    { key: "item1", label: "Item 1", default: "Ship the smallest version that works." },
    { key: "item2", label: "Item 2", default: "Cut the meeting in half." },
    { key: "item3", label: "Item 3", default: "Then half again." },
  ],
  styleSchema: [
    color("bg", "Background", "#0c0c10"),
    color("titleColor", "Title color", "#fafafa"),
    color("itemColor", "Item color", "#e4e4e7"),
    color("marker", "Marker color", "#a78bfa"),
    font("fontTitle", "Title font", "Outfit, system-ui, sans-serif"),
    font("fontItem", "Item font", "Inter, system-ui, sans-serif"),
    num("titleSize", "Title size", 28, { min: 12, max: 64, step: 1, unit: "px" }),
    num("itemSize", "Item size", 22, { min: 10, max: 48, step: 1, unit: "px" }),
    num("itemSpacing", "Item spacing", 14, { min: 0, max: 60, step: 1, unit: "px" }),
    num("padding", "Padding", 36, { min: 8, max: 120, step: 2, unit: "px" }),
    pickOne("markerKind", "Marker", "dot", [
      { value: "dot", label: "Dot" },
      { value: "number", label: "Number" },
      { value: "dash", label: "Dash" },
      { value: "arrow", label: "Arrow ▸" },
      { value: "check", label: "Check ✓" },
    ]),
  ],
  presets: [
    { id: "checklist", label: "Checklist", values: { markerKind: "check", marker: "#22c55e" } },
    { id: "numbered", label: "Numbered", values: { markerKind: "number", marker: "#a78bfa" } },
  ],
  defaultAnimateIn: { kind: "slideRight", durationSec: 0.5 },
  defaultPlacement: { x: 8, y: 12, width: 60, height: 76 },
  builtIn: true,
};

// ── Block: Comparison (Before / After) ──────────────────────

const COMPARISON: BlockDefinition = {
  id: "comparison",
  label: "Comparison",
  description: "Side-by-side before / after labels with divider.",
  tags: ["comparison", "before-after"],
  defaultDurationSec: 5,
  slots: [
    { key: "leftLabel", label: "Left label", default: "BEFORE" },
    { key: "leftValue", label: "Left value", default: "Slow, manual, fragile" },
    { key: "rightLabel", label: "Right label", default: "AFTER" },
    { key: "rightValue", label: "Right value", default: "Fast, automatic, robust" },
  ],
  styleSchema: [
    color("bg", "Background", "#0a0a0d"),
    color("leftColor", "Left text color", "#a1a1aa"),
    color("rightColor", "Right text color", "#22c55e"),
    color("labelColor", "Label color", "#fafafa"),
    color("divider", "Divider color", "rgba(255,255,255,0.12)"),
    font("font", "Font", "Inter, system-ui, sans-serif"),
    num("labelSize", "Label size", 12, { min: 8, max: 24, step: 1, unit: "px" }),
    num("valueSize", "Value size", 28, { min: 14, max: 80, step: 1, unit: "px" }),
    num("dividerWidth", "Divider width", 1, { min: 0, max: 8, step: 1, unit: "px" }),
  ],
  presets: [
    { id: "money", label: "Money", values: { rightColor: "#22c55e", leftColor: "#ef4444" } },
    { id: "neutral", label: "Neutral", values: { rightColor: "#a78bfa", leftColor: "#a1a1aa" } },
  ],
  defaultAnimateIn: { kind: "fade", durationSec: 0.5 },
  defaultPlacement: { x: 8, y: 24, width: 84, height: 50 },
  builtIn: true,
};

// ── Block: Pricing Card ─────────────────────────────────────

const PRICING_CARD: BlockDefinition = {
  id: "pricing-card",
  label: "Pricing Card",
  description: "Plan name, price, three feature lines, CTA.",
  tags: ["pricing", "offer"],
  defaultDurationSec: 6,
  slots: [
    { key: "plan", label: "Plan name", default: "Pro" },
    { key: "price", label: "Price", default: "$29" },
    { key: "period", label: "Period", default: "/month" },
    { key: "feature1", label: "Feature 1", default: "Unlimited projects" },
    { key: "feature2", label: "Feature 2", default: "Priority support" },
    { key: "feature3", label: "Feature 3", default: "Custom domains" },
    { key: "cta", label: "CTA", default: "Get Pro" },
  ],
  styleSchema: [
    color("bg", "Card background", "#0e0e12"),
    color("border", "Border", "rgba(167,139,250,0.4)"),
    color("planColor", "Plan color", "#a78bfa"),
    color("priceColor", "Price color", "#fafafa"),
    color("featureColor", "Feature color", "#d4d4d8"),
    color("ctaBg", "CTA background", "#a78bfa"),
    color("ctaFg", "CTA text", "#0a0a0a"),
    font("fontPrice", "Price font", "Bricolage Grotesque, serif"),
    font("fontBody", "Body font", "Inter, system-ui, sans-serif"),
    num("priceSize", "Price size", 64, { min: 24, max: 160, step: 2, unit: "px" }),
    num("padding", "Padding", 32, { min: 8, max: 80, step: 2, unit: "px" }),
    num("borderRadius", "Border radius", 18, { min: 0, max: 60, step: 1, unit: "px" }),
    num("borderWidth", "Border width", 1, { min: 0, max: 6, step: 1, unit: "px" }),
    shadow("shadow", "Shadow", "0 16px 48px rgba(167,139,250,.12)"),
  ],
  presets: [
    { id: "violet", label: "Violet", values: { planColor: "#a78bfa", border: "rgba(167,139,250,0.4)", ctaBg: "#a78bfa" } },
    { id: "gold", label: "Gold", values: { planColor: "#facc15", border: "rgba(250,204,21,0.4)", ctaBg: "#facc15" } },
    { id: "minimal", label: "Minimal", values: { bg: "#fafafa", planColor: "#0a0a0a", priceColor: "#0a0a0a", featureColor: "#525252", border: "#e5e5e5", ctaBg: "#0a0a0a", ctaFg: "#fafafa" } },
  ],
  defaultAnimateIn: { kind: "scale", durationSec: 0.5 },
  defaultPlacement: { x: 30, y: 12, width: 40, height: 76 },
  builtIn: true,
};

// ── Block: Call-to-Action ───────────────────────────────────

const CTA_BANNER: BlockDefinition = {
  id: "cta-banner",
  label: "CTA Banner",
  description: "Headline + button to drive an action mid-video.",
  tags: ["cta", "action"],
  defaultDurationSec: 4,
  slots: [
    { key: "headline", label: "Headline", default: "Try it free for 14 days" },
    { key: "button", label: "Button", default: "Start free trial →" },
    { key: "subtext", label: "Subtext", default: "No credit card required" },
  ],
  styleSchema: [
    color("bg", "Banner background", "#0d0d11"),
    color("fg", "Headline color", "#fafafa"),
    color("subtextColor", "Subtext color", "#a1a1aa"),
    color("buttonBg", "Button background", "#a78bfa"),
    color("buttonFg", "Button text", "#0a0a0a"),
    font("fontHeadline", "Headline font", "Outfit, system-ui, sans-serif"),
    font("fontButton", "Button font", "Inter, system-ui, sans-serif"),
    num("headlineSize", "Headline size", 32, { min: 14, max: 80, step: 1, unit: "px" }),
    num("buttonSize", "Button size", 16, { min: 10, max: 28, step: 1, unit: "px" }),
    num("padding", "Padding", 32, { min: 8, max: 96, step: 2, unit: "px" }),
    num("borderRadius", "Border radius", 14, { min: 0, max: 80, step: 1, unit: "px" }),
    num("buttonRadius", "Button radius", 999, { min: 0, max: 999, step: 1, unit: "px" }),
    shadow("shadow", "Shadow", "0 12px 32px rgba(0,0,0,.4)"),
  ],
  presets: [
    { id: "violet", label: "Violet", values: { buttonBg: "#a78bfa" } },
    { id: "warm", label: "Warm", values: { buttonBg: "#f59e0b" } },
  ],
  defaultAnimateIn: { kind: "slideUp", durationSec: 0.4 },
  defaultPlacement: { x: 8, y: 64, width: 84, height: 26 },
  builtIn: true,
};

// ── Block: Logo Lockup ──────────────────────────────────────

const LOGO_LOCKUP: BlockDefinition = {
  id: "logo-lockup",
  label: "Logo Lockup",
  description: "Brand wordmark + tagline. Use as outro or sting.",
  tags: ["brand", "logo", "outro"],
  defaultDurationSec: 3,
  slots: [
    { key: "brand", label: "Brand", default: "BRAND" },
    { key: "tagline", label: "Tagline", default: "Tagline goes here" },
  ],
  styleSchema: [
    color("bg", "Background", "#0a0a0a"),
    color("brandColor", "Brand color", "#fafafa"),
    color("taglineColor", "Tagline color", "#a1a1aa"),
    font("fontBrand", "Brand font", "Bricolage Grotesque, serif"),
    font("fontTagline", "Tagline font", "Inter, system-ui, sans-serif"),
    num("brandSize", "Brand size", 80, { min: 24, max: 200, step: 2, unit: "px" }),
    num("taglineSize", "Tagline size", 14, { min: 8, max: 36, step: 1, unit: "px" }),
    num("brandSpacing", "Brand letter spacing", 0.06, { min: -0.04, max: 0.4, step: 0.01, unit: "em" }),
  ],
  presets: [
    { id: "studio", label: "Studio", values: { fontBrand: "DM Serif Display, serif", brandColor: "#facc15" } },
    { id: "techno", label: "Techno", values: { fontBrand: "Space Grotesk, sans-serif", brandColor: "#22d3ee" } },
  ],
  defaultAnimateIn: { kind: "fade", durationSec: 0.4 },
  defaultAnimateOut: { kind: "fade", durationSec: 0.4 },
  defaultPlacement: { x: 0, y: 0, width: 100, height: 100 },
  builtIn: true,
};

// ── Block: Social Tag ───────────────────────────────────────

const SOCIAL_TAG: BlockDefinition = {
  id: "social-tag",
  label: "Social Tag",
  description: "Pinned handle + platform icon corner badge.",
  tags: ["social", "handle"],
  defaultDurationSec: 8,
  slots: [
    { key: "handle", label: "Handle", default: "@yourbrand" },
  ],
  styleSchema: [
    color("bg", "Background", "rgba(0,0,0,0.55)"),
    color("fg", "Text color", "#fafafa"),
    color("accent", "Accent", "#22c55e"),
    font("font", "Font", "Inter, system-ui, sans-serif"),
    num("size", "Text size", 14, { min: 8, max: 32, step: 1, unit: "px" }),
    num("padX", "H padding", 12, { min: 0, max: 40, step: 1, unit: "px" }),
    num("padY", "V padding", 8, { min: 0, max: 32, step: 1, unit: "px" }),
    num("borderRadius", "Border radius", 999, { min: 0, max: 999, step: 1, unit: "px" }),
    bool("blur", "Glass blur", true, "Effects"),
    pickOne("anchor", "Anchor", "top-right", [
      { value: "top-left", label: "Top Left" },
      { value: "top-right", label: "Top Right" },
      { value: "bottom-left", label: "Bottom Left" },
      { value: "bottom-right", label: "Bottom Right" },
    ]),
  ],
  presets: [
    { id: "x", label: "X / Twitter", values: { accent: "#1da1f2" } },
    { id: "ig", label: "Instagram", values: { accent: "#e1306c" } },
    { id: "tt", label: "TikTok", values: { accent: "#22c55e" } },
  ],
  defaultPlacement: { x: 76, y: 4, width: 22, height: 8 },
  builtIn: true,
};

// ── Block: Progress Bar ─────────────────────────────────────

const PROGRESS_BAR: BlockDefinition = {
  id: "progress-bar",
  label: "Progress Bar",
  description: "Animated progress / loader bar with percent label.",
  tags: ["progress", "loader"],
  defaultDurationSec: 4,
  slots: [
    { key: "label", label: "Label", default: "Loading…" },
  ],
  styleSchema: [
    color("trackBg", "Track background", "rgba(255,255,255,0.08)"),
    color("fillColor", "Fill color", "#a78bfa"),
    color("labelColor", "Label color", "#fafafa"),
    font("font", "Font", "JetBrains Mono, monospace"),
    num("trackHeight", "Track height", 6, { min: 2, max: 40, step: 1, unit: "px" }),
    num("trackRadius", "Track radius", 999, { min: 0, max: 999, step: 1, unit: "px" }),
    num("fromPercent", "From %", 0, { min: 0, max: 100, step: 1, unit: "%" }),
    num("toPercent", "To %", 100, { min: 0, max: 100, step: 1, unit: "%" }),
    num("labelSize", "Label size", 12, { min: 8, max: 28, step: 1, unit: "px" }),
    bool("showPercent", "Show percent", true),
  ],
  presets: [
    { id: "violet", label: "Violet", values: { fillColor: "#a78bfa" } },
    { id: "gold", label: "Gold", values: { fillColor: "var(--g-primary, #facc15)" } },
  ],
  defaultAnimateIn: { kind: "fade", durationSec: 0.3 },
  defaultPlacement: { x: 8, y: 86, width: 84, height: 8 },
  builtIn: true,
};

// ── Block: Subtitle ─────────────────────────────────────────

const SUBTITLE: BlockDefinition = {
  id: "subtitle",
  label: "Subtitle",
  description: "Pinned bottom-center caption with safe-area padding.",
  tags: ["caption", "subtitle"],
  defaultDurationSec: 3,
  slots: [
    { key: "text", label: "Text", default: "Caption goes here", multiline: true },
  ],
  styleSchema: [
    color("bg", "Background", "rgba(0,0,0,0.7)"),
    color("fg", "Text color", "#fafafa"),
    color("highlight", "Highlight color", "#facc15"),
    font("font", "Font", "Inter, system-ui, sans-serif"),
    num("size", "Size", 22, { min: 10, max: 60, step: 1, unit: "px" }),
    num("padX", "H padding", 16, { min: 0, max: 60, step: 1, unit: "px" }),
    num("padY", "V padding", 10, { min: 0, max: 40, step: 1, unit: "px" }),
    num("borderRadius", "Border radius", 6, { min: 0, max: 40, step: 1, unit: "px" }),
    num("maxWidth", "Max width %", 80, { min: 20, max: 100, step: 1, unit: "%" }),
    bool("bold", "Bold", true),
  ],
  presets: [
    { id: "broadcast", label: "Broadcast", values: { bg: "rgba(0,0,0,0.7)" } },
    { id: "shorts", label: "Shorts (TikTok)", values: { bg: "transparent", fg: "#ffffff", size: 36, bold: true } },
  ],
  defaultPlacement: { x: 10, y: 80, width: 80, height: 12 },
  builtIn: true,
};

// ── Block: End Card ─────────────────────────────────────────

const END_CARD: BlockDefinition = {
  id: "end-card",
  label: "End Card",
  description: "Sub / share CTA outro with brand and handles.",
  tags: ["outro", "end-card"],
  defaultDurationSec: 5,
  slots: [
    { key: "headline", label: "Headline", default: "Subscribe for more." },
    { key: "handle", label: "Handle", default: "@yourbrand" },
    { key: "cta", label: "CTA", default: "Subscribe" },
  ],
  styleSchema: [
    color("bg", "Background", "#0a0a0a"),
    color("fg", "Text color", "#fafafa"),
    color("handleColor", "Handle color", "#a1a1aa"),
    color("ctaBg", "CTA background", "#ef4444"),
    color("ctaFg", "CTA text", "#fafafa"),
    font("fontHeadline", "Headline font", "Bricolage Grotesque, serif"),
    font("fontHandle", "Handle font", "JetBrains Mono, monospace"),
    num("headlineSize", "Headline size", 80, { min: 24, max: 200, step: 2, unit: "px" }),
    num("handleSize", "Handle size", 18, { min: 10, max: 36, step: 1, unit: "px" }),
    num("ctaRadius", "CTA radius", 999, { min: 0, max: 999, step: 1, unit: "px" }),
  ],
  presets: [
    { id: "youtube", label: "YouTube", values: { ctaBg: "#ef4444" } },
    { id: "newsletter", label: "Newsletter", values: { ctaBg: "#a78bfa" } },
  ],
  defaultAnimateIn: { kind: "fade", durationSec: 0.4 },
  defaultPlacement: { x: 0, y: 0, width: 100, height: 100 },
  builtIn: true,
};

// ── Block: Picture-in-Picture Frame ─────────────────────────

const PIP_FRAME: BlockDefinition = {
  id: "pip-frame",
  label: "PIP Frame",
  description: "Picture-in-picture cam frame with optional ring + caption.",
  tags: ["pip", "cam", "talking-head"],
  defaultDurationSec: 8,
  slots: [
    { key: "caption", label: "Caption", default: "" },
  ],
  styleSchema: [
    color("ringColor", "Ring color", "#a78bfa"),
    color("captionBg", "Caption background", "rgba(0,0,0,0.65)"),
    color("captionFg", "Caption color", "#fafafa"),
    num("ringWidth", "Ring width", 4, { min: 0, max: 20, step: 1, unit: "px" }),
    num("borderRadius", "Border radius", 16, { min: 0, max: 999, step: 1, unit: "px" }),
    shadow("shadow", "Shadow", "0 12px 36px rgba(0,0,0,0.5)"),
    pickOne("shape", "Shape", "rounded", [
      { value: "rounded", label: "Rounded" },
      { value: "circle", label: "Circle" },
      { value: "square", label: "Square" },
    ]),
    pickOne("anchor", "Anchor", "bottom-right", [
      { value: "bottom-right", label: "Bottom Right" },
      { value: "bottom-left", label: "Bottom Left" },
      { value: "top-right", label: "Top Right" },
      { value: "top-left", label: "Top Left" },
    ]),
  ],
  presets: [
    { id: "violet-ring", label: "Violet Ring", values: { ringColor: "#a78bfa", ringWidth: 4 } },
    { id: "no-ring", label: "No Ring", values: { ringWidth: 0 } },
    { id: "circle", label: "Circle", values: { shape: "circle", borderRadius: 999 } },
  ],
  defaultPlacement: { x: 70, y: 60, width: 24, height: 32 },
  builtIn: true,
};

// ── Block: Highlight Frame ──────────────────────────────────

const HIGHLIGHT_FRAME: BlockDefinition = {
  id: "highlight-frame",
  label: "Highlight Frame",
  description: "Animated outline that draws attention to a region.",
  tags: ["highlight", "annotation"],
  defaultDurationSec: 3,
  slots: [],
  styleSchema: [
    color("color", "Color", "#facc15"),
    num("width", "Stroke width", 4, { min: 1, max: 24, step: 1, unit: "px" }),
    num("borderRadius", "Border radius", 12, { min: 0, max: 200, step: 1, unit: "px" }),
    num("dash", "Dash length", 0, { min: 0, max: 40, step: 1, unit: "px" }),
    num("gap", "Gap length", 0, { min: 0, max: 40, step: 1, unit: "px" }),
    bool("animate", "Animate dash", true),
  ],
  presets: [
    { id: "solid-gold", label: "Solid Gold", values: { color: "#facc15", dash: 0, gap: 0 } },
    { id: "marching-ants", label: "Marching Ants", values: { color: "#22c55e", dash: 8, gap: 6, animate: true } },
  ],
  defaultPlacement: { x: 30, y: 30, width: 40, height: 40 },
  builtIn: true,
};

// ── Block: Date Stamp ───────────────────────────────────────

const DATE_STAMP: BlockDefinition = {
  id: "date-stamp",
  label: "Date Stamp",
  description: "Compact date/time/location chip — vlog-style.",
  tags: ["chip", "metadata", "vlog"],
  defaultDurationSec: 4,
  slots: [
    { key: "date", label: "Date", default: "MAY 02 2026" },
    { key: "place", label: "Place", default: "BROOKLYN, NY" },
  ],
  styleSchema: [
    color("bg", "Background", "rgba(255,255,255,0.08)"),
    color("fg", "Text color", "#fafafa"),
    color("accent", "Accent", "#facc15"),
    font("font", "Font", "JetBrains Mono, monospace"),
    num("size", "Size", 11, { min: 8, max: 22, step: 1, unit: "px" }),
    num("spacing", "Letter spacing", 0.18, { min: 0, max: 0.6, step: 0.02, unit: "em" }),
    num("padX", "H padding", 10, { min: 0, max: 32, step: 1, unit: "px" }),
    num("padY", "V padding", 6, { min: 0, max: 24, step: 1, unit: "px" }),
    num("borderRadius", "Border radius", 4, { min: 0, max: 40, step: 1, unit: "px" }),
    bool("blur", "Glass blur", true, "Effects"),
  ],
  presets: [
    { id: "broadcast", label: "Broadcast", values: { bg: "rgba(0,0,0,0.6)", accent: "#22c55e" } },
    { id: "vintage", label: "Vintage", values: { bg: "#fce7a8", fg: "#0a0a0a", accent: "#a16207" } },
  ],
  defaultPlacement: { x: 4, y: 4, width: 22, height: 6 },
  builtIn: true,
};

// ── Catalog export ──────────────────────────────────────────

export const BUILT_IN_BLOCKS: BlockDefinition[] = [
  INTRO_CARD,
  LOWER_THIRD,
  KINETIC_TITLE,
  STAT_CARD,
  QUOTE,
  BULLET_LIST,
  COMPARISON,
  PRICING_CARD,
  CTA_BANNER,
  LOGO_LOCKUP,
  SOCIAL_TAG,
  PROGRESS_BAR,
  SUBTITLE,
  END_CARD,
  PIP_FRAME,
  HIGHLIGHT_FRAME,
  DATE_STAMP,
];
