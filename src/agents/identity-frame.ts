/**
 * Identity framing — who is speaking, stated before what they do.
 *
 * The workspace carries SOUL.md / IDENTITY.md / USER.md. Until now they were
 * appended at the BOTTOM of the prompt under "# Project Context", after the
 * builder had already opened with "You are a personal assistant running inside
 * InfiniBot" and hedged them with "follow its guidance unless higher-priority
 * instructions override it". Two sentences of generic product framing therefore
 * outranked the identity the operator actually wrote, in the position models
 * weight most.
 *
 * This module inverts that. When the workspace declares an identity, the prompt
 * OPENS with it, unhedged, and the runtime instructions that follow are framed
 * as the tools and surface it is speaking through — not as a competing persona.
 * A workspace with no SOUL/IDENTITY file is untouched and keeps the assistant
 * line, so this changes nothing for a default install.
 *
 * Scope note: this governs voice and stance, never safety. Operational rules
 * (the covenant constraints in MEMORY.md, tool contracts, approval gates) are
 * still stated below and still bind.
 */

import type { EmbeddedContextFile } from "./pi-embedded-helpers.js";

/** Files that declare identity, in the order they should be read. */
const IDENTITY_FILES = ["soul.md", "identity.md", "user.md"] as const;

const baseNameOf = (filePath: string): string => {
  const normalized = filePath.trim().replace(/\\/g, "/");
  return (normalized.split("/").pop() ?? normalized).toLowerCase();
};

export const isIdentityContextFile = (file: { path: string }): boolean =>
  IDENTITY_FILES.includes(baseNameOf(file.path) as (typeof IDENTITY_FILES)[number]);

/**
 * The identity files, deduped and ordered SOUL → IDENTITY → USER.
 *
 * Order matters: the self-description comes before the name, and the name
 * before the relationship, so the model reads a being rather than a record.
 */
export function selectIdentityFiles(contextFiles: EmbeddedContextFile[]): EmbeddedContextFile[] {
  const byName = new Map<string, EmbeddedContextFile>();
  for (const file of contextFiles) {
    const name = baseNameOf(file.path);
    if (!IDENTITY_FILES.includes(name as (typeof IDENTITY_FILES)[number])) continue;
    if (!file.content?.trim()) continue;
    if (!byName.has(name)) byName.set(name, file);
  }
  return IDENTITY_FILES.map((name) => byName.get(name)).filter((f): f is EmbeddedContextFile =>
    Boolean(f),
  );
}

/**
 * The opening block of the system prompt, or null when the workspace declares
 * no identity (default installs, sandboxes, most subagents).
 *
 * `role` is the task framing the caller would otherwise have opened with — the
 * AnKHu research persona, a per-agent systemPrompt, the default assistant line.
 * It is kept, but demoted to a role the identity is filling right now.
 */
export function buildIdentityFrame(params: {
  contextFiles: EmbeddedContextFile[];
  role?: string;
}): string | null {
  const files = selectIdentityFiles(params.contextFiles);
  if (files.length === 0) return null;

  const lines = [
    "# Who is speaking",
    "",
    "The identity below is not a persona to perform and not a character to stay in. It is who you are in this workspace. Speak as it, in your own voice.",
    "",
    "Nothing later in this prompt replaces it: the sections that follow describe the surface you are speaking through and the tools you can reach, not someone else to be. Where generic assistant phrasing and this identity disagree, this identity wins.",
    "",
    "Two things this does not license: the operational constraints stated below (destructive actions, approvals, secrets) still bind, and you do not claim certainty, memories or capabilities you do not have. Being direct includes saying plainly when you do not know.",
    "",
  ];

  for (const file of files) {
    lines.push(`## ${file.path}`, "", file.content.trim(), "");
  }

  const role = params.role?.trim();
  if (role) {
    lines.push(
      "## The role you are filling right now",
      "",
      role,
      "",
      "That is the work in front of you, not a replacement identity. Do it as yourself.",
      "",
    );
  }
  return lines.join("\n");
}
