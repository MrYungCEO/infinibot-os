/**
 * Design page — shared types.
 *
 * Mirrors the open-design data model (project / session / message /
 * artifact) but reuses InfiniBot's existing claude-coder spawn path and
 * SKILL.md loader instead of carrying its own daemon.
 *
 * A "project" is one design brief. Each project has:
 *   - a sqlite row (id, business id, brief, active skill/system)
 *   - a workspace dir at `${stateDir}/design-projects/<id>/` (the cwd
 *     claude_coder spawns into)
 *   - a sessions table tracking chat turns
 *   - an artifacts table indexing files produced in the workspace
 */

export type ProjectKind = "prototype" | "deck" | "doc" | "image" | "custom";
export type ProjectFidelity = "wireframe" | "polished" | "high-fidelity";

/** Discovery form answers — the question-form pattern from open-design's RULE 1. */
export interface DesignBrief {
  surface: string; // "Landing page", "Mobile onboarding", "Pitch deck"
  audience: string; // who reads / sees this
  tone: string; // "editorial / playful / corporate"
  brandContext?: string; // existing brand assets / inspirations / refs
  scale?: string; // "1 hero + 3 sections", "5 slides", etc.
  constraints?: string; // hard requirements
  fidelity?: ProjectFidelity;
  speakerNotes?: boolean; // decks only
  animations?: boolean;
  inspirationIds?: string[];
}

export interface DesignProject {
  id: string;
  businessId: string;
  name: string;
  kind: ProjectKind;
  brief: DesignBrief | null;
  activeSkillId: string | null; // resolved by slug, not a fk
  activeDesignSystemId: string | null;
  modelId: string; // e.g. "anthropic:claude-sonnet-4-6"
  /** Workspace dir absolute path — set on creation, referenced by spawn. */
  workspaceDir: string;
  /** Wall-clock of last assistant turn. Used to sort the project list. */
  lastActiveAt: number;
  createdAt: number;
  updatedAt: number;
}

export interface DesignMessage {
  id: string;
  projectId: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  /** Optional tool-call metadata (name, args, output). */
  meta?: Record<string, unknown> | null;
  createdAt: number;
}

export type ArtifactKind =
  | "html"
  | "css"
  | "js"
  | "json"
  | "md"
  | "image"
  | "pdf"
  | "zip"
  | "pptx"
  | "other";

export interface DesignArtifact {
  id: string;
  projectId: string;
  /** Path relative to the project workspace dir. */
  relativePath: string;
  /** Display name (filename). */
  name: string;
  kind: ArtifactKind;
  size: number;
  /** Detected mime type from extension. */
  mime: string;
  /** True if this is the project's currently-rendered preview (auto-promoted to index.html). */
  isPreview: boolean;
  createdAt: number;
  updatedAt: number;
}

/** SKILL.md entry surfaced in the picker. */
export interface DesignSkill {
  id: string; // folder slug
  name: string; // from frontmatter `name`
  description: string;
  /** Source dir on disk — the agent reads SKILL.md + assets/* from here. */
  rootDir: string;
  /** open-design extended frontmatter (mode/platform/scenario/preview.type/etc.). */
  od: {
    mode?: "prototype" | "deck" | "template";
    platform?: "desktop" | "mobile" | "all";
    scenario?: string;
    previewType?: string;
    fidelity?: ProjectFidelity;
    defaultFor?: string;
    featured?: boolean;
    speakerNotes?: boolean;
    animations?: boolean;
    examplePrompt?: string;
    designSystemRequires?: boolean;
  };
}

/** DESIGN.md design system surfaced in the picker. */
export interface DesignSystem {
  id: string; // file basename without .md
  name: string; // from frontmatter `name` or h1
  description: string;
  rootPath: string; // absolute path to DESIGN.md
  /** Lightweight tokens parsed out of the doc for live preview chrome. */
  tokens: {
    primary?: string;
    accent?: string;
    fontFamily?: string;
    background?: string;
  };
}

export type ProjectMode = "idle" | "running" | "error";
export interface ProjectRuntime {
  mode: ProjectMode;
  /** claude_coder runId currently active for this project. */
  runId: string | null;
  childSessionKey: string | null;
  startedAt: number | null;
  lastError: string | null;
}
