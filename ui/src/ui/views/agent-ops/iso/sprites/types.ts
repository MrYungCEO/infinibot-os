export const AGENT_KINDS = [
  "claude-coder",
  "codex-coder",
  "opencode-coder",
  "gemini-coder",
  "voice",
  "federation",
  "review",
  "mesh",
  "unknown",
] as const;

export type AgentKind = (typeof AGENT_KINDS)[number];

export type SpriteDirection = "ne" | "nw" | "se" | "sw";

export type SpriteMotion = "idle" | "walk";

export type SpriteAccessory =
  | "scarf"
  | "cap"
  | "halo"
  | "visor"
  | "satchel"
  | "antenna"
  | "badge"
  | "glow";

export type SpriteStatus =
  | "starting"
  | "idle"
  | "running"
  | "working"
  | "blocked"
  | "finishing"
  | "completed"
  | "failed"
  | string;

export interface SpriteAnimationDescriptor {
  sheet: string;
  directions: readonly SpriteDirection[];
  frames: {
    idle: readonly string[];
    walk: readonly string[];
    badge: string;
  };
  preferredMotion: SpriteMotion;
  defaultDirection: SpriteDirection;
  frameMs: number;
  cell: {
    width: number;
    height: number;
  };
}

export interface SpriteDescriptor {
  kind: AgentKind;
  textureKey: string;
  accentColor: string;
  accessory?: SpriteAccessory;
  scale?: number;
  anim?: SpriteAnimationDescriptor;
  variant: {
    index: number;
    hue: number;
    name: string;
    accessory: SpriteAccessory;
    numericBadge?: number;
  };
}

export interface SpriteLookupInput {
  kind?: AgentKind | string | null;
  runId?: string | null;
  status?: SpriteStatus | null;
  /**
   * Optional zero-based index among same-kind siblings. When provided, indexes
   * 0-7 use the variant table directly; indexes 8+ cycle colors and request a
   * numeric overlay so crowded parallel runs stay unambiguous.
   */
  siblingIndex?: number | null;
}
