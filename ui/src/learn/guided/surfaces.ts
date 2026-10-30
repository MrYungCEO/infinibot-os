/**
 * Build-time surface detection for guided Learn.
 *
 * Some walkthroughs teach UI that only exists in newer builds (the r9 Agents
 * constellation, the mesh Plugin District, the Robovoice voice pipeline).
 * `import.meta.glob` resolves at build time: a key exists only when that file
 * is compiled into this bundle, so `{ kind: "surface" }` conditions are true
 * exactly when the surface ships — no runtime probing, no code from those
 * branches needed here. Nothing is imported (lazy globs are never called).
 */

const FILES = import.meta.glob([
  "../../ui/views/agents-premium.ts",
  "../../ui/views/agent-ops/iso/plugin-district.ts",
  "../../ui/views/robovoice/pipeline-editor.ts",
  "../../ui/components/robovoice-agent-voice.ts",
]);

const has = (suffix: string) => Object.keys(FILES).some((k) => k.endsWith(suffix));

/** Surface id → compiled into this build. */
const SURFACES: Record<string, () => boolean> = {
  "agents-constellation": () => has("views/agents-premium.ts"),
  "mesh-plugin-district": () => has("iso/plugin-district.ts"),
  "voice-robovoice-pipeline": () => has("robovoice/pipeline-editor.ts") && has("components/robovoice-agent-voice.ts"),
};

/** Test/audit override: `window.__learnSurfaces = { id: true }`. */
function override(id: string): boolean | undefined {
  const o = (globalThis as { __learnSurfaces?: Record<string, boolean> }).__learnSurfaces;
  return o && typeof o[id] === "boolean" ? o[id] : undefined;
}

export function hasSurface(id: string): boolean {
  const o = override(id);
  if (o !== undefined) return o;
  return SURFACES[id]?.() ?? false;
}

export function knownSurfaces(): string[] {
  return Object.keys(SURFACES);
}
