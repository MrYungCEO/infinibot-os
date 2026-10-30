/**
 * groupchat.* — agent group chats on the Chat page.
 *
 * Groups are standard sessions (see ../group-chat/store.ts), so listing,
 * history (chat.history), rename (sessions.patch label), pin and delete
 * (sessions.delete) reuse the existing methods. These methods add what a
 * multi-agent room needs: create/update membership + mode, send (which runs
 * the agents' turns), stop, and the conversation workflow builder.
 */
import { secureChatSendBlockReason } from "../../secure-mode/gateway-guards.js";
import { buildAttachmentOcrContext } from "../../ocr/runtime.js";
import { isSecureSessionKey } from "../../secure-mode/session-key.js";
import { resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { loadConfig } from "../../config/config.js";
import { updateSessionStore } from "../../config/sessions/store.js";
import { consumeChatSend } from "../../license/chat-counter.js";
import { gatedError } from "../../license/middleware.js";
import { groupMemberKey, isGroupChatKey } from "../../shared/group-chat/keys.js";
import {
  GROUP_CHAT_EVENT,
  type GroupChatEvent,
  type GroupChatMeta,
  type GroupChatMode,
} from "../../shared/group-chat/types.js";
import { getKanbanStore } from "../../tasks/store.js";
import type { GroupChatBinding } from "../../shared/group-chat/types.js";
import { createGatewayAgentTurnRunner } from "../group-chat/agent-turn.js";
import { profileGroupMembers, resolveOwnerInfo } from "../group-chat/member-profile.js";
import { normalizeBindingPatch, probeRepoCached } from "../group-chat/repo-info.js";
import { parseMessageWithAttachments } from "../chat-attachments.js";
import { applySessionsPatchToStore } from "../sessions-patch.js";
import type { GroupRunSettingsPatch } from "../../shared/group-chat/settings.js";
import type { GroupImageBlock } from "../../shared/group-chat/types.js";
import { GroupChatError, GroupChatService } from "../group-chat/service.js";
import { createSessionGroupChatStore } from "../group-chat/store.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import { listAgentsForGateway, loadSessionEntry } from "../session-utils.js";
import type { GatewayRequestContext, GatewayRequestHandlers, RespondFn } from "./types.js";

export const GROUPCHAT_READ_METHODS = ["groupchat.get"] as const;
export const GROUPCHAT_WRITE_METHODS = [
  "groupchat.create",
  "groupchat.update",
  "groupchat.send",
  "groupchat.abort",
  "groupchat.workflow.save",
  "groupchat.workflow.delete",
  "groupchat.workflow.run",
] as const;

let latestContext: GatewayRequestContext | null = null;
let service: GroupChatService | null = null;

function broadcast(event: string, payload: unknown, dropIfSlow = false) {
  try {
    latestContext?.broadcast(event, payload, dropIfSlow ? { dropIfSlow: true } : undefined);
  } catch {
    /* best effort */
  }
}

function emit(evt: GroupChatEvent) {
  broadcast(GROUP_CHAT_EVENT, evt);
  if (evt.type === "message") {
    // Mirror as a chat.inject-style final so plain chat surfaces (topbar chat
    // sidebar, mobile) that have the group open refresh their transcript.
    const payload = {
      runId: `groupchat-${evt.message.groupChat?.messageId ?? Date.now()}`,
      sessionKey: evt.groupKey,
      seq: 0,
      state: "final" as const,
      message: evt.message,
    };
    broadcast("chat", payload);
    try {
      latestContext?.nodeSendToSession(evt.groupKey, "chat", payload);
    } catch {
      /* best effort */
    }
  }
}

/** Process-wide group chat service (lazy; uses the most recent request context). */
export function getGroupChatService(context?: GatewayRequestContext): GroupChatService {
  if (context) latestContext = context;
  if (!service) {
    service = new GroupChatService({
      store: createSessionGroupChatStore(),
      runTurn: createGatewayAgentTurnRunner(() => latestContext),
      emit,
      onSessionsChanged: (key, reason) => broadcast("sessions.changed", { key, reason }, true),
      log: { warn: (msg) => latestContext?.logGateway.warn(msg) },
      probeRepo: probeRepoCached,
      profileMembers: (members) => profileGroupMembers(loadConfig(), members),
      ownerInfo: () => resolveOwnerInfo(loadConfig()),
      normalizeBinding: (raw, prev) => withProjectDefaults(normalizeBindingPatch(raw, prev)),
      checkSettings,
    });
  }
  return service;
}

/**
 * A binding that links a kanban project but no workdir inherits the project's
 * linked local repo (GitHub sync `githubLocalPath`), when it exists on disk.
 */
function withProjectDefaults(b: GroupChatBinding | undefined): GroupChatBinding | undefined {
  if (!b?.projectId || b.workdir) return b;
  try {
    const meta = getKanbanStore().getAllProjectMeta()[b.projectId] as
      | { githubLocalPath?: string }
      | undefined;
    const local = meta?.githubLocalPath?.trim();
    if (local) return normalizeBindingPatch({ workdir: local }, b) ?? b;
  } catch {
    /* project has no usable repo — keep the binding without a workdir */
  }
  return b;
}

/**
 * A member's background run (claude_coder, sessions_spawn …) finished. The
 * announce normally injects an agent turn into the requester session, but a
 * group member session has no channel — its reply went nowhere. Record the
 * verified outcome in the group transcript instead so every member (and the
 * user) sees whether the run really succeeded.
 */
export function recordGroupMemberRunResult(memberKey: string, text: string): boolean {
  const m = /^agent:([^:]+):gcmember-(.+)$/.exec(memberKey.trim().toLowerCase());
  if (!m) return false;
  const svc = getGroupChatService();
  const cfg = loadConfig();
  const owners = [...new Set(["main", normalizeAgentId(resolveDefaultAgentId(cfg)), m[1]])];
  for (const owner of owners) {
    const key = `agent:${owner}:groupchat-${m[2]}`;
    try {
      svc.getGroup(key);
    } catch {
      continue;
    }
    svc.recordMemberRunResult(key, m[1], text);
    return true;
  }
  return false;
}

/**
 * Reject a model / thinking choice the 1:1 picker would reject: run it through
 * sessions.patch against a scratch store (catalog + allowlist + xhigh rules,
 * judged against the target agent's default model).
 */
async function checkSettings(patch: GroupRunSettingsPatch, agentId?: string): Promise<void> {
  const cfg = loadConfig();
  const owner = normalizeAgentId(agentId || resolveDefaultAgentId(cfg));
  const storeKey = `agent:${owner}:groupchat-settings-check`;
  const res = await applySessionsPatchToStore({
    cfg,
    store: {},
    storeKey,
    patch: { key: storeKey, ...patch } as never,
    loadGatewayModelCatalog: latestContext?.loadGatewayModelCatalog,
  });
  if (!res.ok) throw new GroupChatError(res.error.message);
}

/** chat.send-style attachments → image blocks (same parser + 5 MB cap as chat.send). */
async function parseImages(
  raw: unknown,
  context: GatewayRequestContext,
): Promise<GroupImageBlock[]> {
  if (!Array.isArray(raw) || raw.length === 0) return [];
  const atts = raw
    .map((a) => (a && typeof a === "object" ? (a as Record<string, unknown>) : {}))
    .map((a) => ({
      type: typeof a.type === "string" ? a.type : undefined,
      mimeType: typeof a.mimeType === "string" ? a.mimeType : undefined,
      fileName: typeof a.fileName === "string" ? a.fileName : undefined,
      content: typeof a.content === "string" ? a.content : undefined,
      ocrId: typeof a.ocrId === "string" ? a.ocrId : undefined,
      filePath: typeof a.filePath === "string" ? a.filePath : undefined,
    }))
    .filter((a) => a.content && (a.mimeType ?? "").startsWith("image/"));
  if (!atts.length) return [];
  try {
    const parsed = await parseMessageWithAttachments("", atts, {
      maxBytes: 5_000_000,
      log: context.logGateway,
    });
    return parsed.images.map((i) => ({ type: "image", data: i.data, mimeType: i.mimeType }));
  } catch (err) {
    throw new GroupChatError(err instanceof Error ? err.message : String(err));
  }
}

/** Local auto-OCR text for the attachments, shared with every member's turn. */
async function groupAttachmentContext(
  sessionKey: string,
  raw: unknown,
  context: GatewayRequestContext,
): Promise<string | undefined> {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  try {
    const attachments = raw
      .map((a) => (a && typeof a === "object" ? (a as Record<string, unknown>) : {}))
      .map((a) => ({
        mimeType: typeof a.mimeType === "string" ? a.mimeType : undefined,
        fileName: typeof a.fileName === "string" ? a.fileName : undefined,
        content: typeof a.content === "string" ? a.content : undefined,
        ocrId: typeof a.ocrId === "string" ? a.ocrId : undefined,
        filePath: typeof a.filePath === "string" ? a.filePath : undefined,
      }));
    const { block } = await buildAttachmentOcrContext({
      sessionKey,
      attachments,
      kind: "groupchat",
      waitMs: 10_000,
    });
    return block || undefined;
  } catch (err) {
    context.logGateway.warn(`groupchat attachment OCR failed: ${String(err)}`);
    return undefined;
  }
}

/** Test hook. */
export function resetGroupChatServiceForTest(next: GroupChatService | null = null) {
  service = next;
  latestContext = null;
}

function fail(respond: RespondFn, err: unknown) {
  if (err instanceof GroupChatError) {
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, err.message));
    return;
  }
  respond(
    false,
    undefined,
    errorShape(ErrorCodes.UNAVAILABLE, err instanceof Error ? err.message : String(err)),
  );
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function requireKey(params: Record<string, unknown>): string {
  const key = str(params.key).trim();
  if (!isGroupChatKey(key)) throw new GroupChatError("key must be a group chat session key");
  return key;
}

function knownAgentIds(): Set<string> {
  const { agents } = listAgentsForGateway(loadConfig());
  return new Set(agents.map((a) => a.id));
}

function checkMembers(ids: unknown): string[] | undefined {
  if (ids === undefined) return undefined;
  if (!Array.isArray(ids)) throw new GroupChatError("members must be an array of agent ids");
  const known = knownAgentIds();
  const unknown = ids.filter((id) => typeof id !== "string" || !known.has(normalizeAgentId(id)));
  if (unknown.length) throw new GroupChatError(`Unknown agent(s): ${unknown.join(", ")}`);
  return ids.map((id) => normalizeAgentId(String(id)));
}

/** `chat.send` on a group key → the group orchestrator (so every chat surface works with groups). */
export async function handleGroupChatSend(params: {
  context: GatewayRequestContext;
  sessionKey: string;
  message: string;
  stop: boolean;
  attachments?: unknown;
}): Promise<{
  ok: true;
  agents?: string[];
  aborted?: number;
  messageId?: string;
  command?: { name: string; ok: boolean; reply: string };
}> {
  const svc = getGroupChatService(params.context);
  if (params.stop) return { ok: true, aborted: svc.abort(params.sessionKey).aborted };
  const images = await parseImages(params.attachments, params.context);
  const attachmentContext = await groupAttachmentContext(
    params.sessionKey,
    params.attachments,
    params.context,
  );
  const attachmentNames = Array.isArray(params.attachments)
    ? params.attachments
        .map((attachment) =>
          attachment &&
          typeof attachment === "object" &&
          typeof (attachment as Record<string, unknown>).fileName === "string"
            ? String((attachment as Record<string, unknown>).fileName)
            : "",
        )
        .filter(Boolean)
    : [];
  const displayMessage =
    params.message.trim() ||
    (attachmentNames.length ? `[Attached: ${attachmentNames.join(", ")}]` : "[Attachment]");
  const res = await svc.postUserMessage(params.sessionKey, displayMessage, {
    images,
    attachmentContext,
  });
  return {
    ok: true,
    agents: res.agents,
    messageId: res.message.groupChat?.messageId,
    ...(res.command ? { command: res.command } : {}),
  };
}

/** Remove a deleted group's member sessions (best effort; transcripts are kept on disk). */
export async function cleanupDeletedGroupChat(
  key: string,
  meta: GroupChatMeta | null | undefined,
  context?: GatewayRequestContext,
) {
  if (!isGroupChatKey(key)) return;
  try {
    getGroupChatService(context).abort(key);
  } catch {
    /* ignore */
  }
  const groupId = key.slice(key.indexOf(":groupchat-") + ":groupchat-".length);
  for (const agentId of meta?.members ?? []) {
    const memberKey = groupMemberKey(agentId, groupId);
    try {
      const { storePath, canonicalKey, entry } = loadSessionEntry(memberKey);
      if (!entry) continue;
      await updateSessionStore(storePath, (store) => {
        delete store[canonicalKey];
      });
    } catch {
      /* ignore */
    }
  }
}

export const groupChatHandlers: GatewayRequestHandlers = {
  "groupchat.create": async ({ params, respond, context }) => {
    try {
      const p = (params ?? {}) as Record<string, unknown>;
      const members = checkMembers(p.members) ?? [];
      const cfg = loadConfig();
      const known = knownAgentIds();
      const defaultId = normalizeAgentId(resolveDefaultAgentId(cfg));
      const owner = known.has("main") ? "main" : defaultId;
      const svc = getGroupChatService(context);
      const rec = await svc.createGroup({
        ownerAgentId: owner,
        title: str(p.title),
        members,
        mode: str(p.mode) as GroupChatMode,
        moderatorId: str(p.moderatorId) || undefined,
        binding: p.binding,
        settings: p.settings,
        memberSettings: p.memberSettings,
        secure: p.secure === true,
      });
      respond(true, { key: rec.key, group: svc.describe(rec.key) });
    } catch (err) {
      fail(respond, err);
    }
  },
  "groupchat.get": async ({ params, respond, context }) => {
    try {
      const key = requireKey((params ?? {}) as Record<string, unknown>);
      respond(true, getGroupChatService(context).describe(key));
    } catch (err) {
      fail(respond, err);
    }
  },
  "groupchat.update": async ({ params, respond, context }) => {
    try {
      const p = (params ?? {}) as Record<string, unknown>;
      const key = requireKey(p);
      const svc = getGroupChatService(context);
      await svc.updateGroup(key, {
        title: typeof p.title === "string" ? p.title : undefined,
        members: checkMembers(p.members),
        mode: typeof p.mode === "string" ? (p.mode as GroupChatMode) : undefined,
        moderatorId: typeof p.moderatorId === "string" ? p.moderatorId : undefined,
        binding: p.binding,
        settings: p.settings,
        memberSettings: p.memberSettings,
      });
      respond(true, svc.describe(key));
    } catch (err) {
      fail(respond, err);
    }
  },
  "groupchat.send": async ({ params, respond, context }) => {
    try {
      const p = (params ?? {}) as Record<string, unknown>;
      const key = requireKey(p);
      if (isSecureSessionKey(key)) {
        const blocked = secureChatSendBlockReason({});
        if (blocked) throw new GroupChatError(blocked);
      }
      const message = str(p.message);
      const hasAttachments = Array.isArray(p.attachments) && p.attachments.length > 0;
      if (!message.trim() && !hasAttachments) throw new GroupChatError("message required");
      const gate = consumeChatSend();
      if (!gate.allowed) {
        const err = gatedError(gate.feature ?? "ai_chat_unlimited");
        respond(false, undefined, {
          ...err,
          message: `Free plan is limited to ${gate.cap} AI chat messages per day. Upgrade to ${gate.requiredPlan ?? "starter"} for unlimited chat.`,
        });
        return;
      }
      const res = await handleGroupChatSend({
        context,
        sessionKey: key,
        message,
        stop: false,
        attachments: p.attachments,
      });
      respond(true, res);
    } catch (err) {
      fail(respond, err);
    }
  },
  "groupchat.abort": async ({ params, respond, context }) => {
    try {
      const key = requireKey((params ?? {}) as Record<string, unknown>);
      respond(true, { ok: true, ...getGroupChatService(context).abort(key) });
    } catch (err) {
      fail(respond, err);
    }
  },
  "groupchat.workflow.save": async ({ params, respond, context }) => {
    try {
      const p = (params ?? {}) as Record<string, unknown>;
      const key = requireKey(p);
      const workflow = await getGroupChatService(context).saveWorkflow(key, p.workflow);
      respond(true, { workflow });
    } catch (err) {
      fail(respond, err);
    }
  },
  "groupchat.workflow.delete": async ({ params, respond, context }) => {
    try {
      const p = (params ?? {}) as Record<string, unknown>;
      const key = requireKey(p);
      await getGroupChatService(context).deleteWorkflow(key, str(p.workflowId));
      respond(true, { ok: true });
    } catch (err) {
      fail(respond, err);
    }
  },
  "groupchat.workflow.run": async ({ params, respond, context }) => {
    try {
      const p = (params ?? {}) as Record<string, unknown>;
      const key = requireKey(p);
      const svc = getGroupChatService(context);
      const images = await parseImages(p.attachments, context);
      const { run, done } = await svc.startWorkflow(key, str(p.workflowId), str(p.input), {
        images,
      });
      done.catch((err) => context.logGateway.warn(`groupchat workflow run failed: ${String(err)}`));
      respond(true, { run });
    } catch (err) {
      fail(respond, err);
    }
  },
};
