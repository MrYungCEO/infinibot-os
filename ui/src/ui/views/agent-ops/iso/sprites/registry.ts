import { accentForVariant, variantForRun } from "./palette";
import { AGENT_KINDS, type AgentKind, type SpriteLookupInput, type SpriteMotion } from "./types";

const KIND_SET = new Set<string>(AGENT_KINDS);

export function normalizeAgentKind(kind?: string | null): AgentKind {
  if (!kind) return "unknown";
  const value = kind.toLowerCase().trim();
  if (KIND_SET.has(value)) return value as AgentKind;
  if (value.includes("claude")) return "claude-coder";
  if (value.includes("codex") || value.includes("openai")) return "codex-coder";
  if (value.includes("opencode")) return "opencode-coder";
  if (value.includes("gemini") || value.includes("google")) return "gemini-coder";
  if (value.includes("voice") || value.includes("call")) return "voice";
  if (value.includes("federation") || value.includes("node") || value.includes("satellite")) return "federation";
  if (value.includes("review")) return "review";
  if (value.includes("mesh") || value.includes("orchestrator")) return "mesh";
  return "unknown";
}

export function getSpriteForAgent(input: SpriteLookupInput = {}) {
  const kind = normalizeAgentKind(input.kind);
  const variant = variantForRun(input.runId, input.siblingIndex);
  const preferredMotion = motionForStatus(input.status);
  const sheet = `/assets/sprites/agents/${kind}.svg`;
  const frameKey = preferredMotion === "walk" ? "walk-a-se" : "idle-se";

  return {
    kind,
    textureKey: `${sheet}#${frameKey}`,
    accentColor: accentForVariant(kind, input.runId, input.siblingIndex),
    accessory: variant.accessory,
    scale: kind === "mesh" || kind === "federation" ? 1.06 : 1,
    anim: {
      sheet,
      directions: ["ne", "nw", "se", "sw"] as const,
      frames: {
        idle: ["idle-ne", "idle-nw", "idle-se", "idle-sw"] as const,
        walk: [
          "walk-a-ne",
          "walk-a-nw",
          "walk-a-se",
          "walk-a-sw",
          "walk-b-ne",
          "walk-b-nw",
          "walk-b-se",
          "walk-b-sw",
        ] as const,
        badge: "badge",
      },
      preferredMotion,
      defaultDirection: "se" as const,
      frameMs: preferredMotion === "walk" ? 130 : 650,
      cell: { width: 32, height: 32 },
    },
    variant: {
      index: variant.index,
      hue: variant.hue,
      name: variant.name,
      accessory: variant.accessory,
      numericBadge: variant.numericBadge,
    },
  };
}

function motionForStatus(status?: string | null): SpriteMotion {
  switch ((status || "").toLowerCase()) {
    case "running":
    case "working":
    case "starting":
    case "finishing":
      return "walk";
    default:
      return "idle";
  }
}

export type { AgentKind, SpriteDescriptor, SpriteLookupInput } from "./types";

// Per-agent variant resolver (Quick Win #1). Backward compatible: existing
// getSpriteForAgent callers are untouched; new callers can adopt this directly.
export {
  resolveAgentSprite,
  numericBadgeDataUri,
  VARIANT_DEFS,
  VARIANT_COUNT,
  type ResolvedAgentSprite,
  type ResolveSpriteOptions,
} from "./variants";
