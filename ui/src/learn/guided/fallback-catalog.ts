/**
 * Bundled guided-Learn catalog, used only when the gateway predates
 * `learn.guided.catalog`. Core tracks come straight from src/learn/guided/core;
 * first-party plugin tracks from extensions/<id>/learn.json (validated with the
 * same parser the gateway uses) and gated on the plugin being enabled.
 * Loaded lazily — never part of the main bundle.
 */

import { CORE_MISSIONS, CORE_TRACKS } from "../../../../src/learn/guided/core/index.js";
import { buildGuidedCatalog, type CatalogPlugin } from "../../../../src/learn/guided/catalog.js";
import { stripQuizAnswers, type LearnMissionRef, type PublicLearnTrack } from "../../../../src/learn/guided/types.js";
import { parseLearnContribution } from "../../../../src/learn/guided/validate.js";
import { pluginLinkInfo } from "../../ui/plugin-host";

const FILES = import.meta.glob("../../../../extensions/*/learn.json", { eager: true, import: "default" }) as Record<
  string,
  unknown
>;
/** Folder names differ from plugin ids (extensions/mcp-excalidraw → "whiteboard"). */
const MANIFESTS = import.meta.glob("../../../../extensions/*/infinibot.plugin.json", {
  eager: true,
  import: "id",
}) as Record<string, unknown>;

function pluginIdOf(learnPath: string): string | undefined {
  const dir = /extensions\/([^/]+)\/learn\.json$/.exec(learnPath)?.[1];
  if (!dir) return undefined;
  const id = Object.entries(MANIFESTS).find(([p]) => p.includes(`/extensions/${dir}/`))?.[1];
  return typeof id === "string" ? id : dir;
}

export async function buildFallbackCatalog(enabled: (pluginId: string) => boolean): Promise<{
  tracks: PublicLearnTrack[];
  plugins: CatalogPlugin[];
  missions: LearnMissionRef[];
  answers: Record<string, number[]>;
}> {
  const list = pluginLinkInfo() ?? [];
  const inputs = Object.entries(FILES).flatMap(([path, raw]) => {
    const id = pluginIdOf(path);
    if (!id) return [];
    const parsed = parseLearnContribution(id, raw);
    if (!parsed.ok) {
      console.warn(`[learn] bundled learn.json for ${id} is invalid: ${parsed.error}`);
      return [];
    }
    const meta = list.find((p) => p.id === id);
    return [
      {
        id,
        name: meta?.name ?? id,
        enabled: enabled(id),
        status: enabled(id) ? "loaded" : "disabled",
        learn: parsed.learn,
        disabledContributions: meta?.disabledContributions ?? [],
        monogram: meta?.appearance?.monogram,
        icon: meta?.appearance?.icon,
        accent: meta?.appearance
          ? {
              dark: meta.appearance.themes?.dark?.vars?.["--g-accent"],
              light: meta.appearance.themes?.light?.vars?.["--g-accent"],
            }
          : undefined,
      },
    ];
  });
  const cat = buildGuidedCatalog(inputs, { tracks: CORE_TRACKS, missions: CORE_MISSIONS });
  const answers: Record<string, number[]> = {};
  for (const t of cat.tracks) answers[t.id] = t.quiz.map((q) => q.answer);
  return { tracks: cat.tracks.map(stripQuizAnswers), plugins: cat.plugins, missions: cat.missions, answers };
}
