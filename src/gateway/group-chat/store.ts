/**
 * Group chat persistence on top of the standard session store.
 *
 * - group metadata → `entry.groupChat` on the group's own session entry
 * - shared transcript → that session's JSONL transcript (same file
 *   chat.history reads), each message stamped with `groupChat` attribution
 * - member agents → ordinary per-agent sessions, labelled for the activity views
 *
 * Nothing here is a parallel database: groups list, rename (label), pin and
 * delete through the regular sessions.* methods and survive gateway restarts.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { CURRENT_SESSION_VERSION } from "@mariozechner/pi-coding-agent";
import { loadConfig } from "../../config/config.js";
import { updateSessionStore } from "../../config/sessions/store.js";
import { mergeSessionEntry, type SessionEntry } from "../../config/sessions/types.js";
import { listAgentsForGateway, loadSessionEntry } from "../session-utils.js";
import { readSessionMessages } from "../session-utils.fs.js";
import type { GroupMember } from "../../shared/group-chat/planner.js";
import type {
  GroupChatMeta,
  GroupImageBlock,
  GroupMessageMeta,
  GroupTranscriptMessage,
} from "../../shared/group-chat/types.js";

export type GroupRecord = {
  key: string;
  title: string;
  meta: GroupChatMeta;
  updatedAt: number;
};

/** Storage operations the group chat service needs (swappable in tests). */
export interface GroupChatStore {
  getGroup(key: string): GroupRecord | null;
  createGroup(key: string, title: string, meta: GroupChatMeta): Promise<GroupRecord>;
  updateGroup(
    key: string,
    fn: (
      meta: GroupChatMeta,
      entry: { label?: string },
    ) => { meta?: GroupChatMeta; label?: string } | void,
  ): Promise<GroupRecord | null>;
  readMessages(key: string): GroupTranscriptMessage[];
  appendMessage(key: string, message: GroupTranscriptMessage): GroupTranscriptMessage;
  ensureMemberSession(memberKey: string, label: string): Promise<void>;
  resolveMembers(ids: string[]): GroupMember[];
}

function asMeta(entry: SessionEntry | undefined): GroupChatMeta | null {
  const raw = (entry as (SessionEntry & { groupChat?: unknown }) | undefined)?.groupChat;
  if (!raw || typeof raw !== "object") return null;
  const m = raw as GroupChatMeta;
  if (!Array.isArray(m.members)) return null;
  return m;
}

function transcriptPathFor(entry: SessionEntry, storePath: string): string {
  return entry.sessionFile || path.join(path.dirname(storePath), `${entry.sessionId}.jsonl`);
}

function ensureTranscript(file: string, sessionId: string): void {
  if (fs.existsSync(file)) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const header = {
    type: "session",
    version: CURRENT_SESSION_VERSION,
    id: sessionId,
    timestamp: new Date().toISOString(),
    cwd: process.cwd(),
  };
  fs.writeFileSync(file, `${JSON.stringify(header)}\n`, "utf-8");
}

export function createSessionGroupChatStore(): GroupChatStore {
  return {
    getGroup(key) {
      const { entry } = loadSessionEntry(key);
      const meta = asMeta(entry);
      if (!entry || !meta) return null;
      return { key, title: entry.label || "Group chat", meta, updatedAt: entry.updatedAt };
    },

    async createGroup(key, title, meta) {
      const { storePath, canonicalKey } = loadSessionEntry(key);
      const entry = await updateSessionStore(storePath, (store) => {
        const next = mergeSessionEntry(store[canonicalKey], {
          label: title,
          chatType: "direct",
        });
        (next as SessionEntry & { groupChat?: GroupChatMeta }).groupChat = meta;
        store[canonicalKey] = next;
        return next;
      });
      ensureTranscript(transcriptPathFor(entry, storePath), entry.sessionId);
      return { key, title, meta, updatedAt: entry.updatedAt };
    },

    async updateGroup(key, fn) {
      const { storePath, canonicalKey } = loadSessionEntry(key);
      return await updateSessionStore(storePath, (store) => {
        const entry = store[canonicalKey];
        const meta = asMeta(entry);
        if (!entry || !meta) return null;
        const res = fn(structuredClone(meta), { label: entry.label }) ?? {};
        const nextMeta = res.meta ?? meta;
        const next: SessionEntry & { groupChat?: GroupChatMeta } = {
          ...entry,
          ...(res.label !== undefined ? { label: res.label } : {}),
          updatedAt: Date.now(),
        };
        next.groupChat = nextMeta;
        store[canonicalKey] = next;
        return {
          key,
          title: next.label || "Group chat",
          meta: nextMeta,
          updatedAt: next.updatedAt,
        };
      });
    },

    readMessages(key) {
      const { storePath, entry } = loadSessionEntry(key);
      if (!entry?.sessionId || !storePath) return [];
      return readSessionMessages(
        entry.sessionId,
        storePath,
        entry.sessionFile,
      ) as GroupTranscriptMessage[];
    },

    appendMessage(key, message) {
      const { storePath, entry } = loadSessionEntry(key);
      if (!entry?.sessionId || !storePath) throw new Error(`group chat not found: ${key}`);
      const file = transcriptPathFor(entry, storePath);
      ensureTranscript(file, entry.sessionId);
      const id = message.groupChat?.messageId ?? randomUUID().slice(0, 8);
      const line = {
        type: "message",
        id,
        timestamp: new Date(message.timestamp).toISOString(),
        message,
      };
      fs.appendFileSync(file, `${JSON.stringify(line)}\n`, "utf-8");
      return message;
    },

    async ensureMemberSession(memberKey, label) {
      const { storePath, canonicalKey, entry } = loadSessionEntry(memberKey);
      if (entry?.label === label) return;
      await updateSessionStore(storePath, (store) => {
        store[canonicalKey] = mergeSessionEntry(store[canonicalKey], { label });
      });
    },

    resolveMembers(ids) {
      const { agents } = listAgentsForGateway(loadConfig());
      return ids.map((id) => {
        const row = agents.find((a) => a.id === id);
        return { id, name: row?.identity?.name || row?.name || id };
      });
    },
  };
}

export function makeGroupMessage(params: {
  role: "user" | "assistant";
  text: string;
  /** Attached images (user messages), stored like chat.send's transcript images. */
  images?: GroupImageBlock[];
  meta: Omit<GroupMessageMeta, "messageId"> & { messageId?: string };
  timestamp?: number;
}): GroupTranscriptMessage {
  const messageId = params.meta.messageId ?? randomUUID().slice(0, 12);
  return {
    role: params.role,
    content: [
      { type: "text", text: params.text },
      ...(params.images ?? []).map((i) => ({
        type: "image" as const,
        data: i.data,
        mimeType: i.mimeType,
      })),
    ],
    timestamp: params.timestamp ?? Date.now(),
    ...(params.role === "assistant"
      ? { stopReason: "injected", usage: { input: 0, output: 0, totalTokens: 0 } }
      : {}),
    groupChat: { ...params.meta, messageId },
  };
}
