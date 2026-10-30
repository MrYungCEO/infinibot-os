import type { AgentKind, SpriteAccessory } from "./types";

export const KIND_ACCENTS: Record<AgentKind, string> = {
  "claude-coder": "#d97745",
  "codex-coder": "#14b8a6",
  "opencode-coder": "#8b5cf6",
  "gemini-coder": "#4285f4",
  voice: "#f43f5e",
  federation: "#f59e0b",
  review: "#22c55e",
  mesh: "#38bdf8",
  unknown: "#a1a1aa",
};

export const VARIANT_TABLE: ReadonlyArray<{
  name: string;
  hue: number;
  accessory: SpriteAccessory;
}> = [
  { name: "ember scarf", hue: 18, accessory: "scarf" },
  { name: "sky cap", hue: 198, accessory: "cap" },
  { name: "mint halo", hue: 148, accessory: "halo" },
  { name: "violet visor", hue: 268, accessory: "visor" },
  { name: "gold satchel", hue: 43, accessory: "satchel" },
  { name: "rose antenna", hue: 338, accessory: "antenna" },
  { name: "lime badge", hue: 94, accessory: "badge" },
  { name: "cyan glow", hue: 184, accessory: "glow" },
] as const;

export function hashRunId(value?: string | null): number {
  const input = value || "agent";
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function variantIndexForRunId(runId?: string | null): number {
  return hashRunId(runId) % VARIANT_TABLE.length;
}

export function variantForRun(runId?: string | null, siblingIndex?: number | null) {
  const ordinal =
    typeof siblingIndex === "number" && Number.isFinite(siblingIndex) && siblingIndex >= 0
      ? Math.floor(siblingIndex)
      : variantIndexForRunId(runId);
  const index = ordinal % VARIANT_TABLE.length;
  return {
    index,
    ...VARIANT_TABLE[index],
    numericBadge: ordinal >= VARIANT_TABLE.length ? ordinal + 1 : undefined,
  };
}

export function accentForVariant(kind: AgentKind, runId?: string | null, siblingIndex?: number | null): string {
  const base = KIND_ACCENTS[kind] || KIND_ACCENTS.unknown;
  const variant = variantForRun(runId, siblingIndex);
  if (kind === "unknown") return hslToHex(variant.hue, 10, 70);
  return mixHex(base, hslToHex(variant.hue, 78, 58), 0.42);
}

function hslToHex(h: number, s: number, l: number): string {
  const sat = s / 100;
  const light = l / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = sat * Math.min(light, 1 - light);
  const f = (n: number) => light - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return `#${[f(0), f(8), f(4)]
    .map((v) =>
      Math.round(255 * v)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

function mixHex(a: string, b: string, amount: number): string {
  const left = parseHex(a);
  const right = parseHex(b);
  const mix = (x: number, y: number) => Math.round(x + (y - x) * amount);
  return `#${[mix(left.r, right.r), mix(left.g, right.g), mix(left.b, right.b)]
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("")}`;
}

function parseHex(hex: string): { r: number; g: number; b: number } {
  const clean = hex.replace("#", "");
  return {
    r: Number.parseInt(clean.slice(0, 2), 16),
    g: Number.parseInt(clean.slice(2, 4), 16),
    b: Number.parseInt(clean.slice(4, 6), 16),
  };
}
