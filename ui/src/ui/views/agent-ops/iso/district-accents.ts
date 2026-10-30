/**
 * Per-district accent palette for the Galactic HQ world map.
 *
 * Phase 1 of the holographic revamp. Each sector gets ONE low-saturation,
 * neon-tinged accent colour. The colour is used for:
 *   - a faint ground tint inside the district (drawn in-world, behind agents)
 *   - a thin accent border + label underline on the district
 *   - the halo / pulse / reticule colour for any agent currently inside it
 *
 * Agent sprites themselves are NEVER recoloured — only the surrounding glow.
 *
 * Contrast: the world background is #0a0e1a (relative luminance ≈ 0.005). Every
 * accent below has relative luminance > 0.30, giving a text contrast ratio well
 * above 6:1 against that background (WCAG AA for normal text is 4.5:1).
 */

import { SECTORS } from "./sector-defs";

/** sectorId → accent colour (0xRRGGBB). */
export const DISTRICT_ACCENTS: Record<string, number> = {
  observatory: 0x38bdf8, // sky cyan — analytics / bridge
  "mission-control": 0xfb923c, // orange — autonomy + cron
  "comms-deck": 0xf472b6, // pink — channels / comms array
  "agent-quarters": 0xa78bfa, // violet — agents + sessions
  "command-atrium": 0xfbbf24, // amber — federation hub (atrium = amber)
  "broadcast-studio": 0xe879f9, // fuchsia — media + voice
  "the-vault": 0x34d399, // emerald — security + config
  "engineering-bay": 0x2dd4bf, // teal — terminals / tools
  "gateway-concourse": 0x60a5fa, // soft blue — gateway concourse
  "canvas-atrium": 0xc084fc, // purple — canvas + design
};

/** Neutral fallback (steel) for any sector without an explicit accent. */
export const DISTRICT_ACCENT_FALLBACK = 0x94a3b8;

/** Accent colour for a sector id, falling back to a readable neutral. */
export function accentForSector(sectorId: string | null | undefined): number {
  if (!sectorId) return DISTRICT_ACCENT_FALLBACK;
  return DISTRICT_ACCENTS[sectorId] ?? DISTRICT_ACCENT_FALLBACK;
}

/** "#rrggbb" CSS string for a sector accent (for DOM/SVG overlays). */
export function accentCss(sectorId: string | null | undefined): string {
  return "#" + accentForSector(sectorId).toString(16).padStart(6, "0");
}

/** "#rrggbb" for any 0xRRGGBB colour. */
export function hexCss(color: number): string {
  return "#" + (color >>> 0).toString(16).padStart(6, "0").slice(-6);
}

/**
 * Which sector grid-rect contains a station-grid cell. The map's iso projection
 * is anchored on the station grid (STATION_GRID cols/rows), so callers pass grid
 * coordinates, not world pixels. Returns the sector id or null.
 */
export function sectorIdAtGrid(col: number, row: number): string | null {
  for (const s of SECTORS) {
    if (col >= s.c && col < s.c + s.w && row >= s.r && row < s.r + s.h) return s.id;
  }
  return null;
}
