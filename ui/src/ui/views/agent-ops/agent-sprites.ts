/**
 * Per-backend robot-ninja sprite sources.
 *
 * These PNGs live in `ui/public/agent-sprites/` and are served at the public
 * URLs below. They were generated once with a media provider as 128×192 crisp
 * character art with a transparent background, then baked into the galactic
 * asset registry at runtime (see iso/galactic-assets.ts).
 *
 * The map is keyed by SPRITE SLOT — the slot a coderBackend resolves to via
 * resolveAgentSpriteSlot() in activity-map.ts:
 *   claude-code → claude · opencode → opencode · codex → codex ·
 *   gemini → gemini · (unknown / unset) → default
 */
export const AGENT_SPRITE_SRC: Record<string, string> = {
  claude: '/agent-sprites/claude.png',
  opencode: '/agent-sprites/opencode.png',
  codex: '/agent-sprites/codex.png',
  gemini: '/agent-sprites/gemini.png',
  default: '/agent-sprites/default.png',
};

/** Stable list of sprite slots, in load order. */
export const AGENT_SPRITE_SLOTS = ['claude', 'opencode', 'codex', 'gemini', 'default'] as const;

export type AgentSpriteSlot = (typeof AGENT_SPRITE_SLOTS)[number];
