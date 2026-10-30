/**
 * Per-agent sprite VARIANT resolver.
 *
 * Goal: when several agents share the same backend (e.g. five parallel
 * claude-coder runs) they should stay visually distinct while keeping the
 * backend silhouette readable. We do that procedurally — base sheet + a hue
 * tint + a small accessory overlay + an optional numeric badge — so no
 * pre-rendered per-variant asset is required.
 *
 * ── Viz integration (one line, no edits needed inside this module) ──────────
 * The single public entrypoint is `resolveAgentSprite(agentId, backend, opts?)`.
 * In `agency-world-viz.ts` (or the Pixi `ActivityMap.addAgent` site) adopt it as:
 *
 *   const v = resolveAgentSprite(agent.agentId, agent.coderBackend || agent.kind, { siblingIndex });
 *   // v.url           → base SVG sheet            (set as texture)
 *   // v.tint          → "#rrggbb" accent          (PIXI sprite.tint / CSS color)
 *   // v.hueRotate     → deg for CSS filter        (DOM/WebView path)
 *   // v.accessoryUrl  → small overlay SVG above head (optional sprite)
 *   // v.badgeNumber   → draw "N" badge when >5 duplicates (optional)
 *
 * `opts.siblingIndex` is preferred when the viz knows the agent's ordinal among
 * same-backend siblings (guarantees 5 distinct looks for the first 5). When it
 * is omitted the variant is derived deterministically from `agentId` via
 * FNV-1a hash-mod, so the same agent always renders identically across reloads.
 *
 * Nothing here mutates the render loop, projection, or camera — it is a pure
 * data resolver. Existing callers of `getSpriteForAgent` keep working unchanged.
 */

import { accentForVariant, hashRunId } from "./palette";
import { normalizeAgentKind } from "./registry";
import type { AgentKind, SpriteAccessory } from "./types";

export const VARIANT_COUNT = 5;

const ACCESSORY_BASE = "/assets/sprites/agents/accessories";

/**
 * Five deterministic variants. Silhouette is always the backend base sheet;
 * only the hue tint + a small accessory overlay change so duplicates read as
 * "same role, different individual".
 */
export interface VariantDef {
  index: number;
  name: string;
  /** Degrees for CSS `filter: hue-rotate()` on the DOM/WebView render path. */
  hueRotate: number;
  accessory: SpriteAccessory;
  accessoryFile: string;
}

export const VARIANT_DEFS: readonly VariantDef[] = [
  { index: 0, name: "halo", hueRotate: 0, accessory: "halo", accessoryFile: "halo.svg" },
  { index: 1, name: "sky cap", hueRotate: 28, accessory: "cap", accessoryFile: "cap.svg" },
  { index: 2, name: "antenna", hueRotate: 196, accessory: "antenna", accessoryFile: "antenna.svg" },
  { index: 3, name: "scarf", hueRotate: 330, accessory: "scarf", accessoryFile: "scarf.svg" },
  { index: 4, name: "star badge", hueRotate: 264, accessory: "badge", accessoryFile: "star-badge.svg" },
] as const;

export interface ResolveSpriteOptions {
  /**
   * Zero-based ordinal among same-backend siblings. When provided, indexes
   * 0-4 map directly to the five variants; index 5+ cycles the variants and
   * sets `badgeNumber` so crowded fleets stay unambiguous. When omitted the
   * variant is hashed from `agentId`.
   */
  siblingIndex?: number | null;
}

export interface ResolvedAgentSprite {
  /** Base sprite sheet for the backend silhouette. */
  url: string;
  /** Accent color "#rrggbb" — backend base mixed with the variant hue. */
  tint: string;
  /** Degrees for CSS `filter: hue-rotate()` (DOM/WebView path). */
  hueRotate: number;
  /** Small accessory overlay SVG to draw above the head (optional). */
  accessoryUrl?: string;
  /** Render a numeric badge ("6", "7"…) for the 6th+ same-backend duplicate. */
  badgeNumber?: number;
  // ── extra metadata (safe to ignore) ──
  kind: AgentKind;
  variantIndex: number;
  variantName: string;
  accessory: SpriteAccessory;
}

/**
 * Resolve the full visual variant for one agent.
 *
 * @param agentId  Stable per-agent id (sessionKey / runId / agentId).
 * @param backend  Backend or kind string ("claude", "codex", "voice", …).
 * @param opts     Optional sibling ordinal for guaranteed distinctness.
 */
export function resolveAgentSprite(
  agentId: string | null | undefined,
  backend: string | null | undefined,
  opts: ResolveSpriteOptions = {},
): ResolvedAgentSprite {
  const kind = normalizeAgentKind(backend ?? agentId ?? undefined);

  const ordinal =
    typeof opts.siblingIndex === "number" && Number.isFinite(opts.siblingIndex) && opts.siblingIndex >= 0
      ? Math.floor(opts.siblingIndex)
      : hashRunId(agentId) % VARIANT_COUNT;

  const variantIndex = ordinal % VARIANT_COUNT;
  const def = VARIANT_DEFS[variantIndex];
  const badgeNumber = ordinal >= VARIANT_COUNT ? ordinal + 1 : undefined;

  return {
    url: `/assets/sprites/agents/${kind}.svg`,
    tint: accentForVariant(kind, agentId, ordinal),
    hueRotate: def.hueRotate,
    accessoryUrl: `${ACCESSORY_BASE}/${def.accessoryFile}`,
    badgeNumber,
    kind,
    variantIndex,
    variantName: def.name,
    accessory: def.accessory,
  };
}

/**
 * Inline data-URI for a numeric "+N" badge — handy for the DOM/WebView path
 * which can't easily reuse the in-sheet badge cell. Deterministic, no asset.
 */
export function numericBadgeDataUri(n: number, color = "#0b1220"): string {
  const label = String(n);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24">` +
    `<circle cx="12" cy="12" r="10" fill="${color}" stroke="#ffffff" stroke-width="1.5"/>` +
    `<text x="12" y="16" text-anchor="middle" font-size="11" font-family="ui-monospace,monospace" font-weight="900" fill="#ffffff">${label}</text>` +
    `</svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}
