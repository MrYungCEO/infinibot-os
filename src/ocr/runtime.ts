/**
 * Gateway wiring for the OCR service: the per-state-dir singleton, the agent
 * memory mirror, the Documents backfill, and the upload hooks used by
 * files.upload / chat.send / group chat / documents / channel media.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { loadConfig } from "../config/io.js";
import { resolveStateDir } from "../config/paths.js";
import {
  acquireRuntimeForEndpoint,
  isLocalRuntimeInteractiveBusy,
  onLocalRuntimeInteractive,
  pickActiveVisionRuntime,
  runtimeIdForEndpoint,
} from "../local-runtimes/runtime.js";
import { setExternalInteractiveSource } from "./interactive-gate.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveAgentIdFromSessionKey } from "../routing/session-key.js";
import { isSaasMode } from "../saas/config.js";
import { getSecureModeRuntime } from "../secure-mode/runtime.js";
import { isSecureSessionKey } from "../secure-mode/session-key.js";
import { createLocalEngines } from "./engines.js";
import { isOcrCandidate, ocrKindForExt } from "./extract.js";
import { resolveOcrConfig } from "./local-only.js";
import { attachmentContextBlock, OcrService, sha256, type OcrChangeEvent } from "./service.js";
import { sidecarMarkdown } from "./store.js";
import type { OcrEntry, OcrLane, OcrSidecar, OcrSource } from "./types.js";

const log = createSubsystemLogger("ocr");

export const OCR_CHANGED_EVENT = "files.ocr.changed";

let broadcastFn: ((event: string, payload: unknown) => void) | null = null;
const services = new Map<string, OcrService>();
let override: OcrService | null = null;

export function setOcrBroadcast(fn: ((event: string, payload: unknown) => void) | null) {
  broadcastFn = fn;
}

/** Same resolution as files.ts (INFINIBOT_FILES_ROOT → <stateDir>/files). */
export function resolveFilesRoot(env: NodeJS.ProcessEnv = process.env): string {
  const o = env.INFINIBOT_FILES_ROOT?.trim();
  if (o) return o;
  const stateDir = env.INFINIBOT_STATE_DIR?.trim() || path.join(os.homedir(), ".infinibot");
  return path.join(stateDir, "files");
}

function ocrDisabled(): boolean {
  if (process.env.INFINIBOT_OCR_DISABLED === "1") return true;
  // Hosted tenants have no local GPU/OCR venv; the pipeline is a local-install feature.
  if (isSaasMode()) return true;
  if (process.env.VITEST && !override && process.env.INFINIBOT_OCR_TEST_ENABLE !== "1") return true;
  return false;
}

/** Agent memory mirror: <workspace>/memory/files-ocr/<id>.md (memory_search indexes memory/**). */
export function memoryMirrorTargets(entry: OcrEntry): string[] {
  try {
    const cfg = loadConfig();
    const agents = new Set<string>([resolveDefaultAgentId(cfg)]);
    if (entry.source.agentId) agents.add(entry.source.agentId);
    if (entry.source.sessionKey) agents.add(resolveAgentIdFromSessionKey(entry.source.sessionKey));
    return [...agents].map((a) =>
      path.join(resolveAgentWorkspaceDir(cfg, a), "memory", "files-ocr", `${entry.id}.md`),
    );
  } catch {
    return [];
  }
}

function mirrorToMemory(entry: OcrEntry, sc: OcrSidecar | null) {
  if (entry.lane !== "normal") return;
  for (const file of memoryMirrorTargets(entry)) {
    if (!sc) {
      fs.rmSync(file, { force: true });
      continue;
    }
    const head = [
      `<!-- infinibot:file-ocr id=${entry.id} -->`,
      `File: ${entry.path ?? entry.name}`,
      `File id: ${entry.id} (file_context get / inspect)`,
      "",
    ].join("\n");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${head}${sidecarMarkdown(sc)}`);
  }
}

async function backfillDocument(entry: OcrEntry, sc: OcrSidecar) {
  if (entry.source.kind !== "documents" || !entry.source.docId) return;
  const { applyOcrToDocument } = await import("../documents/service.js");
  const md = [
    sc.markdown.trim(),
    sc.description ? `\n\n## Description (local vision model)\n\n${sc.description.trim()}` : "",
  ]
    .join("")
    .trim();
  applyOcrToDocument(entry.source.docId, md);
}

export function getOcrService(): OcrService {
  if (override) return override;
  const stateDir = resolveStateDir(process.env, os.homedir);
  let svc = services.get(stateDir);
  if (!svc) {
    const cfg = resolveOcrConfig();
    if (cfg.ollamaRefused) log.warn(cfg.ollamaRefused);
    svc = new OcrService({
      stateDir,
      cfg,
      engines: createLocalEngines({
        cfg,
        stateDir,
        // GPU shared with vLLM: wait for Ollama to own it (never swap mid-chat),
        // or use an already-running vision runtime.
        visionGate: cfg.ollamaUrl
          ? {
              acquire: (model) =>
                acquireRuntimeForEndpoint({ url: cfg.ollamaUrl!, model, reason: "ocr/vision" }),
              alternate: () => pickActiveVisionRuntime(cfg.ollamaUrl!),
            }
          : undefined,
      }),
      secureVault: () => {
        const rt = getSecureModeRuntime();
        return rt.isUnlocked() ? rt.requireVault() : null;
      },
      emit: (e: OcrChangeEvent) => broadcastFn?.(OCR_CHANGED_EVENT, e),
      indexNormal: mirrorToMemory,
      onDone: (entry, sc) => {
        void backfillDocument(entry, sc).catch((err) =>
          log.warn(`documents backfill failed: ${String(err)}`),
        );
      },
      log: { info: (m) => log.info(m), warn: (m) => log.warn(m) },
    });
    services.set(stateDir, svc);
  }
  return svc;
}

export function setOcrServiceForTests(svc: OcrService | null) {
  override = svc;
}

export function startOcrWorker(broadcast?: (event: string, payload: unknown) => void) {
  if (broadcast) setOcrBroadcast(broadcast);
  if (ocrDisabled()) return;
  const svc = getOcrService();
  svc.start();
  // Interactive-first: a chat turn holding the OCR runtime in the GPU runtime
  // manager pauses the background queue too (alongside the run's own hold).
  if (svc.cfg.ollamaUrl) wireRuntimeManagerPause(svc.cfg.ollamaUrl);
  // One-time: bring files uploaded before auto-OCR existed into the index.
  setTimeout(() => {
    try {
      backfillWorkspace();
    } catch (err) {
      log.warn(`backfill failed: ${String(err)}`);
    }
  }, 15_000).unref?.();
  // Secure jobs wait while the lane is locked; unlocking wakes the worker.
  try {
    getSecureModeRuntime().onChange(() => svc.kick());
  } catch {
    /* secure mode unavailable */
  }
}

function wireRuntimeManagerPause(url: string) {
  try {
    setExternalInteractiveSource({
      isBusy: () => {
        const id = runtimeIdForEndpoint(url);
        return id ? isLocalRuntimeInteractiveBusy(id) : false;
      },
      subscribe: (onChange) =>
        onLocalRuntimeInteractive((e) => {
          if (e.runtimeId === runtimeIdForEndpoint(url)) onChange();
        }),
    });
  } catch (err) {
    log.warn(`runtime-manager pause hook unavailable: ${String(err)}`);
  }
}

const BACKFILL_SKIP = new Set([".trash", ".ocr", "node_modules", ".git", "chat-uploads-tmp"]);

/**
 * Queue every OCR-able file already in the workspace (files root + Documents
 * originals) that the registry does not know yet. Low priority, so new
 * uploads and chat attachments still go first. Returns the number queued.
 */
export function backfillWorkspace(opts: { maxFiles?: number; force?: boolean } = {}): {
  queued: number;
  scanned: number;
} {
  if (ocrDisabled()) return { queued: 0, scanned: 0 };
  const svc = getOcrService();
  const stateDir = resolveStateDir(process.env, os.homedir);
  const marker = path.join(stateDir, "ocr", "backfill.json");
  if (!opts.force && fs.existsSync(marker)) return { queued: 0, scanned: 0 };
  const max = opts.maxFiles ?? 5_000;
  const known = new Set(Object.values(svc.stores.normal.loadRegistry()).map((e) => e.path));
  let queued = 0;
  let scanned = 0;
  const visit = (dir: string, depth: number, source: (abs: string) => OcrSource) => {
    if (depth > 10 || scanned >= max) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (scanned >= max) return;
      if (BACKFILL_SKIP.has(ent.name)) continue;
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        visit(abs, depth + 1, source);
        continue;
      }
      if (!ent.isFile() || !isOcrCandidate(ent.name)) continue;
      scanned++;
      if (known.has(abs)) continue;
      try {
        if (fs.statSync(abs).size > 200 * 1024 * 1024) continue;
        if (svc.enqueuePath({ absPath: abs, source: source(abs), priority: -10 })) queued++;
      } catch {
        /* unreadable: skip */
      }
    }
  };
  visit(resolveFilesRoot(), 0, () => ({ kind: "files" }));
  const docsFiles = path.join(stateDir, "documents", "files");
  visit(docsFiles, 0, (abs) => ({ kind: "documents", docId: path.basename(path.dirname(abs)) }));
  try {
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(marker, JSON.stringify({ at: Date.now(), queued, scanned }));
  } catch {
    /* marker is best effort */
  }
  if (queued) log.info(`backfill queued ${queued} of ${scanned} workspace files`);
  return { queued, scanned };
}

/** files.upload hook (normal lane). Never throws; never waits for extraction. */
export function enqueueUploadedPath(
  absPath: string,
  source: OcrSource,
  priority = 0,
): OcrEntry | null {
  if (ocrDisabled() || !isOcrCandidate(absPath)) return null;
  try {
    return getOcrService().enqueuePath({ absPath, source, priority });
  } catch (err) {
    log.warn(`enqueue failed for ${path.basename(absPath)}: ${String(err)}`);
    return null;
  }
}

export function laneForSession(sessionKey: string | undefined | null): OcrLane {
  return isSecureSessionKey(sessionKey) ? "secure" : "normal";
}

export interface RawAttachment {
  mimeType?: string;
  fileName?: string;
  /** base64 */
  content?: string;
  /** Existing OCR entry created by the chat composer upload step. */
  ocrId?: string;
  /** Files-root relative path for a normal-lane upload. */
  filePath?: string;
}

const EXT_FOR_MIME: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/webp": ".webp",
  "image/heic": ".heic",
  "image/heif": ".heif",
  "image/gif": ".gif",
  "application/pdf": ".pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
};

function safeName(raw: string | undefined, mime: string | undefined, digest: string): string {
  let name =
    (raw ?? "")
      .split(/[\\/]/)
      .pop()
      ?.replace(/[^\w.\- ]+/g, "_")
      .trim() ?? "";
  const ext = path.extname(name).toLowerCase() || EXT_FOR_MIME[(mime ?? "").toLowerCase()] || "";
  if (!name || name === ext) name = `attachment-${digest.slice(0, 8)}${ext}`;
  else if (!path.extname(name) && ext) name = `${name}${ext}`;
  return name.slice(0, 120);
}

/**
 * Persist chat attachments and queue them (secure sessions → the vault).
 * Returns the registered entries (unsupported types are skipped).
 */
export function persistChatAttachments(params: {
  sessionKey: string;
  attachments: RawAttachment[];
  kind: "chat" | "groupchat";
  maxBytes?: number;
}): OcrEntry[] {
  if (ocrDisabled() || !params.attachments.length) return [];
  const lane = laneForSession(params.sessionKey);
  const svc = getOcrService();
  const out: OcrEntry[] = [];
  const max = params.maxBytes ?? 25 * 1024 * 1024;
  for (const a of params.attachments) {
    try {
      if (a.ocrId) {
        const existing = svc.find(lane, { id: a.ocrId });
        // Secure sessions fail closed: an id from the normal registry never
        // crosses into the vault lane (and vice versa).
        if (existing) out.push(existing);
        continue;
      }
      if (!a.content) continue;
      const b64 = a.content.replace(/^data:[^,]*,/, "");
      const data = Buffer.from(b64, "base64");
      if (!data.length || data.length > max) continue;
      const digest = sha256(data);
      const name = safeName(a.fileName, a.mimeType, digest);
      if (!ocrKindForExt(path.extname(name))) continue;
      const source: OcrSource = {
        kind: params.kind,
        sessionKey: params.sessionKey,
        agentId: resolveAgentIdFromSessionKey(params.sessionKey),
      };
      if (lane === "secure") {
        if (!svc.laneAvailable("secure")) continue; // locked: never fall back to plaintext disk
        out.push(svc.enqueueSecure({ name, data, source, priority: 10 }));
        continue;
      }
      const day = new Date().toISOString().slice(0, 10);
      const dir = path.join(resolveFilesRoot(), "chat-uploads", day);
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${digest.slice(0, 8)}-${name}`);
      if (!fs.existsSync(file)) fs.writeFileSync(file, data);
      const e = svc.enqueuePath({ absPath: file, source, priority: 10 });
      if (e) out.push(e);
    } catch (err) {
      log.warn(`attachment persist failed: ${String(err)}`);
    }
  }
  return out;
}

/**
 * Persist + OCR attachments and wait (bounded) for their text so the agent
 * turn gets it inline. Returns "" when there is nothing to add.
 */
export async function buildAttachmentOcrContext(params: {
  sessionKey: string;
  attachments: RawAttachment[];
  kind: "chat" | "groupchat";
  waitMs?: number;
}): Promise<{ block: string; entries: OcrEntry[] }> {
  const entries = persistChatAttachments(params);
  if (!entries.length) return { block: "", entries };
  const svc = getOcrService();
  const deadline = Date.now() + (params.waitMs ?? 10_000);
  const items: Array<{ entry: OcrEntry; sidecar: OcrSidecar | null }> = [];
  for (const e of entries) {
    const sc = await svc.waitForText(e.lane, e.id, Math.max(0, deadline - Date.now()));
    const latest = svc.find(e.lane, { id: e.id }) ?? e;
    items.push({ entry: latest, sidecar: sc });
  }
  return { block: attachmentContextBlock(items), entries };
}

/** Channel media (Telegram/WhatsApp/…): copy out of the 2-minute media cache and queue. */
export function enqueueChannelMedia(params: {
  paths: string[];
  sessionKey?: string;
  channel?: string;
}) {
  if (ocrDisabled()) return;
  if (isSecureSessionKey(params.sessionKey)) return;
  for (const p of params.paths) {
    try {
      if (!p || !isOcrCandidate(p) || !fs.existsSync(p)) continue;
      const data = fs.readFileSync(p);
      const digest = sha256(data);
      const day = new Date().toISOString().slice(0, 10);
      const dir = path.join(resolveFilesRoot(), "inbox-media", day);
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(
        dir,
        `${digest.slice(0, 8)}-${path.basename(p).replace(/[^\w.\- ]+/g, "_")}`,
      );
      if (!fs.existsSync(file)) fs.writeFileSync(file, data);
      getOcrService().enqueuePath({
        absPath: file,
        source: {
          kind: "channel",
          channel: params.channel,
          sessionKey: params.sessionKey,
          agentId: params.sessionKey ? resolveAgentIdFromSessionKey(params.sessionKey) : undefined,
        },
      });
    } catch (err) {
      log.warn(`channel media enqueue failed: ${String(err)}`);
    }
  }
}
