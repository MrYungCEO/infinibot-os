/**
 * Content Studio pipeline — typed client for the plugin-native RPCs
 * (`content-studio.board/stages/items/docs/ideas/media.*`) and the media
 * upload route. Shapes mirror src/content-studio/studio.ts.
 */

import { gatewayAuthHeaders, gatewayHttpBase } from "../../gateway-http-auth.js";

export interface GatewayCallable {
  request<T = unknown>(method: string, params?: unknown): Promise<T>;
}

export type OwnerKind = "item" | "idea";

export interface MediaView {
  id: string;
  kind: "image" | "video" | "audio" | "file";
  mime: string;
  filename: string;
  size: number;
  source: "upload" | "url" | "flypic" | "agent";
  caption: string;
  url: string;
  createdAt: number;
}

export interface Stage {
  id: string;
  name: string;
  color: string;
  wipLimit: number | null;
  position: number;
  isDone: boolean;
  count: number;
  overWip: boolean;
}

export interface Item {
  id: string;
  stageId: string;
  title: string;
  summary: string;
  platform: string | null;
  format: string | null;
  tags: string[];
  dueAt: number | null;
  assignee: string | null;
  contentPageId: string | null;
  coverMediaId: string | null;
  position: number;
  stageEnteredAt: number;
  createdAt: number;
  updatedAt: number;
  cover: MediaView | null;
  mediaCount: number;
  docWords: number;
  docUpdatedAt: number;
}

export interface Idea {
  id: string;
  title: string;
  icon: string;
  tags: string[];
  pinned: boolean;
  promotedItemId: string | null;
  createdAt: number;
  updatedAt: number;
  mediaCount: number;
  docWords: number;
  excerpt: string;
}

export interface Board {
  stages: Stage[];
  items: Item[];
}

export const PLATFORMS = [
  "instagram",
  "tiktok",
  "youtube",
  "linkedin",
  "x",
  "facebook",
  "newsletter",
  "blog",
  "podcast",
] as const;

export const FORMATS = [
  "reel",
  "short",
  "carousel",
  "post",
  "story",
  "thread",
  "long-form",
  "article",
  "episode",
] as const;

export const STAGE_COLORS = [
  "#a78bfa",
  "#60a5fa",
  "#22d3ee",
  "#34d399",
  "#f59e0b",
  "#f472b6",
  "#f87171",
  "#caa45a",
];

/** Browser URL for gateway-relative media (split-origin safe). */
export function mediaSrc(url: string): string {
  return url.startsWith("/") ? `${gatewayHttpBase()}${url}` : url;
}

export class StudioApi {
  constructor(readonly client: GatewayCallable) {}

  private call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    return this.client.request<T>(`content-studio.${method}`, params);
  }

  board() {
    return this.call<Board>("board.get");
  }
  createStage(p: { name: string; color?: string; wipLimit?: number | null; index?: number }) {
    return this.call<{ stage: Stage }>("stages.create", p);
  }
  updateStage(stageId: string, p: { name?: string; color?: string; wipLimit?: number | null; isDone?: boolean }) {
    return this.call<{ stage: Stage }>("stages.update", { stageId, ...p });
  }
  reorderStages(order: string[]) {
    return this.call<{ stages: Stage[] }>("stages.reorder", { order });
  }
  deleteStage(stageId: string, moveItemsTo?: string) {
    return this.call<{ deleted: string; movedItems: number }>("stages.delete", { stageId, moveItemsTo });
  }
  getItem(itemId: string) {
    return this.call<{ item: Item; stage: Stage | null; media: MediaView[] }>("items.get", { itemId });
  }
  createItem(p: { title: string; stageId?: string; index?: number; platform?: string }) {
    return this.call<{ item: Item }>("items.create", p);
  }
  updateItem(itemId: string, p: Partial<Pick<Item, "title" | "summary" | "platform" | "format" | "tags" | "dueAt" | "assignee" | "coverMediaId">>) {
    return this.call<{ item: Item }>("items.update", { itemId, ...p });
  }
  moveItem(itemId: string, toStageId: string, toIndex?: number) {
    return this.call<{ item: Item }>("items.move", { itemId, toStageId, toIndex });
  }
  deleteItem(itemId: string) {
    return this.call<{ deleted: string }>("items.delete", { itemId });
  }
  ideas() {
    return this.call<{ ideas: Idea[] }>("ideas.list");
  }
  createIdea(p: { title?: string; icon?: string; markdown?: string }) {
    return this.call<{ idea: Idea }>("ideas.create", p);
  }
  updateIdea(ideaId: string, p: Partial<Pick<Idea, "title" | "icon" | "tags" | "pinned">>) {
    return this.call<{ idea: Idea }>("ideas.update", { ideaId, ...p });
  }
  deleteIdea(ideaId: string) {
    return this.call<{ deleted: string }>("ideas.delete", { ideaId });
  }
  promoteIdea(ideaId: string, stageId?: string) {
    return this.call<{ idea: Idea; item: Item }>("ideas.promote", { ideaId, stageId });
  }
  mediaFor(ownerKind: OwnerKind, ownerId: string) {
    return this.call<{ media: MediaView[] }>("media.list", { ownerKind, ownerId });
  }
  capabilities() {
    return this.call<{ flypic: boolean }>("media.capabilities");
  }
  reference(ownerKind: OwnerKind, ownerId: string, url: string, caption = "") {
    return this.call<{ media: MediaView }>("media.reference", { ownerKind, ownerId, url, caption });
  }
  importUrl(ownerKind: OwnerKind, ownerId: string, url: string, source: "url" | "flypic" = "url", caption = "") {
    return this.call<{ media: MediaView }>("media.importUrl", { ownerKind, ownerId, url, source, caption });
  }
  detach(ownerKind: OwnerKind, ownerId: string, mediaId: string) {
    return this.call<{ media: MediaView[] }>("media.detach", { ownerKind, ownerId, mediaId });
  }

  /** Raw-body upload to /plugins/content-studio/media, linked to the owner. */
  async upload(file: File, ownerKind: OwnerKind, ownerId: string): Promise<MediaView> {
    const qs = new URLSearchParams({ filename: file.name, ownerKind, ownerId });
    const res = await fetch(`${gatewayHttpBase()}/plugins/content-studio/media?${qs}`, {
      method: "POST",
      credentials: "include",
      headers: {
        ...(await gatewayAuthHeaders()),
        "Content-Type": file.type || "application/octet-stream",
      },
      body: file,
    });
    const body = (await res.json().catch(() => ({}))) as { media?: MediaView; error?: unknown };
    if (!res.ok || !body.media) {
      const err = body.error;
      const msg = typeof err === "string" ? err : (err as { message?: string } | undefined)?.message;
      throw new Error(msg || `upload failed (${res.status})`);
    }
    return body.media;
  }

  /**
   * FlyPic image → stored studio media. Uses the FlyPic plugin's own RPCs
   * (flypic.generate / flypic.job.get) and imports the output, because FlyPic
   * CDN links expire. Billed on the user's FlyPic account — UI asks first.
   */
  async generateWithFlypic(
    prompt: string,
    ownerKind: OwnerKind,
    ownerId: string,
    onStatus?: (s: string) => void,
  ): Promise<MediaView> {
    type Job = { id: string; status: string; outputs?: Array<{ url: string }>; error?: string };
    let { job } = await this.client.request<{ job: Job }>("flypic.generate", { kind: "image", prompt });
    const started = Date.now();
    while (!["succeeded", "failed", "cancelled"].includes(job.status)) {
      if (Date.now() - started > 5 * 60_000) throw new Error("FlyPic took longer than 5 minutes");
      onStatus?.(`FlyPic: ${job.status}…`);
      await new Promise((r) => setTimeout(r, 2500));
      ({ job } = await this.client.request<{ job: Job }>("flypic.job.get", { jobId: job.id }));
    }
    const url = job.outputs?.[0]?.url;
    if (job.status !== "succeeded" || !url) throw new Error(job.error || `FlyPic job ${job.status}`);
    onStatus?.("Saving image…");
    return (await this.importUrl(ownerKind, ownerId, url, "flypic", prompt.slice(0, 200))).media;
  }
}

export function relTime(ts: number | null | undefined): string {
  if (!ts) return "";
  const d = Date.now() - ts;
  const m = Math.round(d / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.round(h / 24);
  return days < 30 ? `${days}d ago` : new Date(ts).toLocaleDateString();
}

export function dueLabel(ts: number | null): { text: string; tone: "late" | "soon" | "" } | null {
  if (!ts) return null;
  const days = Math.ceil((ts - Date.now()) / 86_400_000);
  const text = new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return { text, tone: days < 0 ? "late" : days <= 2 ? "soon" : "" };
}
