/**
 * Content Studio pipeline service: resolves the per-tenant store + media dir
 * and builds the board/doc/idea/media views the RPCs, HTTP route and agent
 * tool all share.
 */

import path from "node:path";

import { resolvePluginDataDir } from "../plugins/plugin-data.js";
import { studioBlocksToMarkdown, studioMarkdownToBlocks } from "./blocks.js";
import { ContentStudioMedia, viewMedia, type MediaView } from "./media-files.js";
import { CONTENT_STUDIO_PLUGIN_ID } from "./methods.js";
import {
  ContentPipelineStore,
  type DocOwnerKind,
  type IdeaPage,
  type PipelineItem,
  type PipelineStage,
} from "./pipeline-store.js";

export type ContentStudio = { store: ContentPipelineStore; media: ContentStudioMedia };

const studios = new Map<string, ContentStudio>();

/** Store for the current tenant's plugin data dir (cached per dir). */
export function getContentStudio(
  dataDir = resolvePluginDataDir(CONTENT_STUDIO_PLUGIN_ID),
): ContentStudio {
  let s = studios.get(dataDir);
  if (!s) {
    const store = new ContentPipelineStore(path.join(dataDir, "studio.db"));
    s = { store, media: new ContentStudioMedia(store, path.join(dataDir, "media")) };
    studios.set(dataDir, s);
  }
  return s;
}

/** Test hook: close and forget every cached store. */
export function resetContentStudios(): void {
  for (const s of studios.values()) s.store.close();
  studios.clear();
}

export type BoardItem = PipelineItem & {
  cover: MediaView | null;
  mediaCount: number;
  docWords: number;
  docUpdatedAt: number;
};

export type BoardStage = PipelineStage & { count: number; overWip: boolean };

export type BoardView = { stages: BoardStage[]; items: BoardItem[] };

export function buildBoard(studio: ContentStudio): BoardView {
  const { store } = studio;
  const items = store.listItems();
  const docs = store.docStats("item");
  const media = store.mediaCounts("item");
  const counts = new Map<string, number>();
  for (const it of items) counts.set(it.stageId, (counts.get(it.stageId) ?? 0) + 1);
  return {
    stages: store.listStages().map((s) => {
      const count = counts.get(s.id) ?? 0;
      return { ...s, count, overWip: s.wipLimit !== null && count > s.wipLimit };
    }),
    items: items.map((it) => boardItem(studio, it, docs, media)),
  };
}

export function boardItem(
  studio: ContentStudio,
  it: PipelineItem,
  docs = studio.store.docStats("item"),
  media = studio.store.mediaCounts("item"),
): BoardItem {
  const cover = it.coverMediaId ? studio.store.getMedia(it.coverMediaId) : null;
  const d = docs.get(it.id);
  return {
    ...it,
    cover: cover ? viewMedia(cover) : null,
    mediaCount: media.get(it.id) ?? 0,
    docWords: d?.words ?? 0,
    docUpdatedAt: d?.updatedAt ?? 0,
  };
}

export type IdeaView = IdeaPage & {
  mediaCount: number;
  docWords: number;
  excerpt: string;
};

export function listIdeaViews(studio: ContentStudio): IdeaView[] {
  const { store } = studio;
  const docs = store.docStats("idea");
  const media = store.mediaCounts("idea");
  return store.listIdeas().map((idea) => ideaView(studio, idea, docs, media));
}

export function ideaView(
  studio: ContentStudio,
  idea: IdeaPage,
  docs = studio.store.docStats("idea"),
  media = studio.store.mediaCounts("idea"),
): IdeaView {
  const doc = studio.store.getDoc("idea", idea.id);
  const excerpt = studioBlocksToMarkdown(doc.blocks.slice(0, 6))
    .replace(/[#>*_`[\]!-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
  return {
    ...idea,
    mediaCount: media.get(idea.id) ?? 0,
    docWords: docs.get(idea.id)?.words ?? 0,
    excerpt,
  };
}

export function getDocMarkdown(studio: ContentStudio, kind: DocOwnerKind, id: string) {
  const doc = studio.store.getDoc(kind, id);
  return {
    markdown: studioBlocksToMarkdown(doc.blocks),
    updatedAt: doc.updatedAt,
    blockCount: doc.blocks.length,
  };
}

export function setDocMarkdown(
  studio: ContentStudio,
  kind: unknown,
  id: unknown,
  markdown: string,
  mode: "replace" | "append",
) {
  const appended = studioMarkdownToBlocks(markdown);
  const existing = mode === "append" ? studio.store.getDoc(kind, id).blocks : [];
  const blocks = [...existing, ...appended];
  const res = studio.store.saveDoc(kind, id, blocks);
  return { updatedAt: res.updatedAt, blockCount: blocks.length, appended: appended.length };
}
