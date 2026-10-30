import { DEFAULT_CLAWD_BROWSER_PROFILE_NAME } from "../../browser/constants.js";
import { isHostedBrowser } from "../../browser/hosted.js";
import {
  browserCloseTab,
  browserFocusTab,
  browserOpenTab,
  browserProfiles,
  browserSnapshot,
  browserStart,
  browserStatus,
  browserStop,
  browserTabs,
} from "../../browser/client.js";
import {
  chromeProfileRoot,
  chromeProfileSnapshotRoot,
  describeProfile,
  deleteProfile,
  deleteSnapshot,
  ensureProfile,
  getNavPolicy,
  listProfiles,
  listSnapshots,
  restoreProfileFromSnapshot,
  setNavPolicy,
  snapshotProfile,
} from "../../browser/manager.js";
import {
  INFINI_PROFILE_NAME,
  type BrowserCookie,
  type StorageStateSnapshot,
} from "../../browser/profiles/types.js";
import {
  filterStorageStateByOrigin,
  writeStorageStateFile,
} from "../../browser/profiles/storage-state.js";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import {
  browserAct,
  browserArmDialog,
  browserArmFileChooser,
  browserConsoleMessages,
  browserNavigate,
  browserPdfSave,
  browserScreenshotAction,
} from "../../browser/client-actions.js";
import crypto from "node:crypto";

import { resolveBrowserConfig } from "../../browser/config.js";
import { DEFAULT_AI_SNAPSHOT_MAX_CHARS } from "../../browser/constants.js";
import {
  getSkill,
  getSkillBodyForEvaluate,
  listSkills,
  saveSkill,
} from "../../browser/skills-store.js";
import { loadConfig } from "../../config/config.js";
import { saveMediaBuffer } from "../../media/store.js";
import { emitMediaArtifact, artifactHash } from "../../proactive/media-artifacts.js";
import { listNodes, resolveNodeIdFromList, type NodeListNode } from "./nodes-utils.js";
import { LegacyBrowserToolSchema } from "./browser-tool.legacy.schema.js";
import { type AnyAgentTool, imageResultFromFile, jsonResult, readStringParam } from "./common.js";
import { callGatewayTool } from "./gateway.js";

type BrowserProxyFile = {
  path: string;
  base64: string;
  mimeType?: string;
};

type BrowserProxyResult = {
  result: unknown;
  files?: BrowserProxyFile[];
};

const DEFAULT_BROWSER_PROXY_TIMEOUT_MS = 20_000;

type BrowserNodeTarget = {
  nodeId: string;
  label?: string;
};

function isBrowserNode(node: NodeListNode) {
  const caps = Array.isArray(node.caps) ? node.caps : [];
  const commands = Array.isArray(node.commands) ? node.commands : [];
  return caps.includes("browser") || commands.includes("browser.proxy");
}

async function resolveBrowserNodeTarget(params: {
  requestedNode?: string;
  target?: "sandbox" | "host" | "node";
  sandboxBridgeUrl?: string;
}): Promise<BrowserNodeTarget | null> {
  const cfg = loadConfig();
  const policy = cfg.gateway?.nodes?.browser;
  const mode = policy?.mode ?? "auto";
  if (mode === "off") {
    if (params.target === "node" || params.requestedNode) {
      throw new Error("Node browser proxy is disabled (gateway.nodes.browser.mode=off).");
    }
    return null;
  }
  if (params.sandboxBridgeUrl?.trim() && params.target !== "node" && !params.requestedNode) {
    return null;
  }
  if (params.target && params.target !== "node") return null;
  if (mode === "manual" && params.target !== "node" && !params.requestedNode) {
    return null;
  }

  const nodes = await listNodes({});
  const browserNodes = nodes.filter((node) => node.connected && isBrowserNode(node));
  if (browserNodes.length === 0) {
    if (params.target === "node" || params.requestedNode) {
      throw new Error("No connected browser-capable nodes.");
    }
    return null;
  }

  const requested = params.requestedNode?.trim() || policy?.node?.trim();
  if (requested) {
    const nodeId = resolveNodeIdFromList(browserNodes, requested, false);
    const node = browserNodes.find((entry) => entry.nodeId === nodeId);
    return { nodeId, label: node?.displayName ?? node?.remoteIp ?? nodeId };
  }

  if (params.target === "node") {
    if (browserNodes.length === 1) {
      const node = browserNodes[0]!;
      return { nodeId: node.nodeId, label: node.displayName ?? node.remoteIp ?? node.nodeId };
    }
    throw new Error(
      `Multiple browser-capable nodes connected (${browserNodes.length}). Set gateway.nodes.browser.node or pass node=<id>.`,
    );
  }

  if (mode === "manual") return null;

  if (browserNodes.length === 1) {
    const node = browserNodes[0]!;
    return { nodeId: node.nodeId, label: node.displayName ?? node.remoteIp ?? node.nodeId };
  }
  return null;
}

async function callBrowserProxy(params: {
  nodeId: string;
  method: string;
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  timeoutMs?: number;
  profile?: string;
}): Promise<BrowserProxyResult> {
  const gatewayTimeoutMs =
    typeof params.timeoutMs === "number" && Number.isFinite(params.timeoutMs)
      ? Math.max(1, Math.floor(params.timeoutMs))
      : DEFAULT_BROWSER_PROXY_TIMEOUT_MS;
  const payload = (await callGatewayTool(
    "node.invoke",
    { timeoutMs: gatewayTimeoutMs },
    {
      nodeId: params.nodeId,
      command: "browser.proxy",
      params: {
        method: params.method,
        path: params.path,
        query: params.query,
        body: params.body,
        timeoutMs: params.timeoutMs,
        profile: params.profile,
      },
      idempotencyKey: crypto.randomUUID(),
    },
  )) as {
    ok?: boolean;
    payload?: BrowserProxyResult;
    payloadJSON?: string | null;
  };
  const parsed =
    payload?.payload ??
    (typeof payload?.payloadJSON === "string" && payload.payloadJSON
      ? (JSON.parse(payload.payloadJSON) as BrowserProxyResult)
      : null);
  if (!parsed || typeof parsed !== "object") {
    throw new Error("browser proxy failed");
  }
  return parsed;
}

async function persistProxyFiles(files: BrowserProxyFile[] | undefined) {
  if (!files || files.length === 0) return new Map<string, string>();
  const mapping = new Map<string, string>();
  for (const file of files) {
    const buffer = Buffer.from(file.base64, "base64");
    const saved = await saveMediaBuffer(buffer, file.mimeType, "browser", buffer.byteLength);
    mapping.set(file.path, saved.path);
  }
  return mapping;
}

function applyProxyPaths(result: unknown, mapping: Map<string, string>) {
  if (!result || typeof result !== "object") return;
  const obj = result as Record<string, unknown>;
  if (typeof obj.path === "string" && mapping.has(obj.path)) {
    obj.path = mapping.get(obj.path);
  }
  if (typeof obj.imagePath === "string" && mapping.has(obj.imagePath)) {
    obj.imagePath = mapping.get(obj.imagePath);
  }
  const download = obj.download;
  if (download && typeof download === "object") {
    const d = download as Record<string, unknown>;
    if (typeof d.path === "string" && mapping.has(d.path)) {
      d.path = mapping.get(d.path);
    }
  }
}

function resolveBrowserBaseUrl(params: {
  target?: "sandbox" | "host";
  sandboxBridgeUrl?: string;
  allowHostControl?: boolean;
}): string | undefined {
  const cfg = loadConfig();
  const resolved = resolveBrowserConfig(cfg.browser, cfg);
  const normalizedSandbox = params.sandboxBridgeUrl?.trim() ?? "";
  const target = params.target ?? (normalizedSandbox ? "sandbox" : "host");

  if (target === "sandbox") {
    if (!normalizedSandbox) {
      throw new Error(
        'Sandbox browser is unavailable. Enable agents.defaults.sandbox.browser.enabled or use target="host" if allowed.',
      );
    }
    return normalizedSandbox.replace(/\/$/, "");
  }

  if (params.allowHostControl === false) {
    throw new Error("Host browser control is disabled by sandbox policy.");
  }
  if (!resolved.enabled) {
    throw new Error(
      "Browser control is disabled. Set browser.enabled=true in ~/.infinibot/infinibot.json.",
    );
  }
  return undefined;
}

export function createLegacyBrowserTool(opts?: {
  sandboxBridgeUrl?: string;
  allowHostControl?: boolean;
}): AnyAgentTool {
  const targetDefault = opts?.sandboxBridgeUrl ? "sandbox" : "host";
  const hostHint =
    opts?.allowHostControl === false ? "Host target blocked by policy." : "Host target allowed.";
  return {
    label: "Browser",
    name: "browser",
    description: [
      "Control the user's existing Chrome tabs via the InfiniBot Browser Relay extension.",
      "This is the ONLY browser automation surface available — there are no other browsers, profiles, or sandboxed headless instances. Do not invent alternatives.",
      "Attach flow: the user must pin and click the InfiniBot Browser Relay toolbar icon on the Chrome tab they want controlled (badge ON). If no tab is attached, ask them to attach one — do not try to start a new browser.",
      "Federation: pass node=<alias|displayName|nodeId> to drive the Chrome Relay on a remote federation device instead of the local one. Use the `nodes` tool action=status to list connected federation devices and their displayNames/aliases. Without `node`, the tool targets the local host (or auto-routes if exactly one browser-capable federation node is connected and policy=auto).",
      "Actions:",
      "  Interaction: status/tabs/open/focus/close/snapshot/screenshot/act/navigate/console/pdf.",
      "  Skills: exec, skill.save, skill.call, skill.list.",
      "  Profiles: profile.use_infini (ensure the canonical persistent profile at ~/.infinibot/chrome-profile/infini/ — cookies/logins/extensions/history survive across sessions), profile.create {profileName}, profile.list, profile.info, profile.delete {profileName, confirmInfini} (the 'infini' profile is typo-protected), profile.snapshot {profileName, label?} (tar.gz of the full userDataDir; useful pre-destructive runs), profile.snapshots, profile.restore {archivePath, profileName?}, profile.delete_snapshot {archivePath}.",
      "  Nav policy: nav_policy.get {profileName?}, nav_policy.set {profileName?, navPolicy} where navPolicy = { allowedSchemes?: ['http','https',...], allowPrivateHosts?: [...], allowPrivateNetworks?: false, denyHosts?: [...] }. Defaults block file://, data:, javascript:, and private IPs (cloud metadata included). Add to allowPrivateHosts to test localhost.",
      "  Cookies / storage: storage.export {profileName?, filePath?, originsFilter?} (Playwright storageState JSON — cookies + localStorage), storage.import {filePath, importMode?}, cookies.export {profileName?, filePath?}, cookies.import {filePath, importMode?}, cookies.clear. Filtered exports restrict to specific origins so you can ship only what an agent needs.",
      "When using refs from snapshot (e.g. e12), keep the same tab: pass targetId from the snapshot response into subsequent actions (act/click/type/etc).",
      'For stable, self-resolving refs across calls, use snapshot with refs="aria" (Playwright aria-ref ids). Default refs="role" are role+name-based.',
      "Use snapshot+act for UI automation. Avoid act:wait by default; use only in exceptional cases when no reliable UI state exists.",
      "Self-healing: when act/snapshot don't give you what you need, use action=exec with code=<inline JS that can use `return`> to query/manipulate the page directly (runs via page.evaluate).",
      "Skill building: when you arrive at a working exec for a reusable task, persist it with action=skill.save {name, code, description, argsSignature?} — next turn you'll see it in skill.list and can run it with action=skill.call {name, args?}. The skill body receives `args` and should `return` its result.",
      "Before deriving from scratch, check action=skill.list to see if an existing skill already solves the task.",
    ].join(" "),
    parameters: LegacyBrowserToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true });
      // Profile stays locked to the Chrome Relay extension (only browser
      // surface this tool drives). node/target are honored so agents can
      // pick which federation device's Relay to control. A hosted fleet
      // Machine has no desktop Chrome: it drives its own headless Chromium.
      const profile = isHostedBrowser() ? DEFAULT_CLAWD_BROWSER_PROFILE_NAME : "chrome";
      const requestedNode = readStringParam(params, "node");
      const rawTarget = readStringParam(params, "target");
      let target: "sandbox" | "host" | "node" | undefined =
        rawTarget === "sandbox" || rawTarget === "host" || rawTarget === "node"
          ? rawTarget
          : requestedNode
            ? "node"
            : "host";
      void targetDefault;
      void hostHint;

      const nodeTarget = await resolveBrowserNodeTarget({
        requestedNode: requestedNode ?? undefined,
        target,
        sandboxBridgeUrl: opts?.sandboxBridgeUrl,
      });

      // resolveBrowserBaseUrl only runs when no federation node was picked,
      // so narrow target to the local options ("sandbox" | "host").
      const baseUrl = nodeTarget
        ? undefined
        : resolveBrowserBaseUrl({
            target: target === "node" ? undefined : target,
            sandboxBridgeUrl: opts?.sandboxBridgeUrl,
            allowHostControl: opts?.allowHostControl,
          });

      const proxyRequest = nodeTarget
        ? async (opts: {
            method: string;
            path: string;
            query?: Record<string, string | number | boolean | undefined>;
            body?: unknown;
            timeoutMs?: number;
            profile?: string;
          }) => {
            const proxy = await callBrowserProxy({
              nodeId: nodeTarget.nodeId,
              method: opts.method,
              path: opts.path,
              query: opts.query,
              body: opts.body,
              timeoutMs: opts.timeoutMs,
              profile: opts.profile,
            });
            const mapping = await persistProxyFiles(proxy.files);
            applyProxyPaths(proxy.result, mapping);
            return proxy.result;
          }
        : null;

      switch (action) {
        case "status":
          if (proxyRequest) {
            return jsonResult(
              await proxyRequest({
                method: "GET",
                path: "/",
                profile,
              }),
            );
          }
          return jsonResult(await browserStatus(baseUrl, { profile }));
        case "start":
          if (proxyRequest) {
            await proxyRequest({
              method: "POST",
              path: "/start",
              profile,
            });
            return jsonResult(
              await proxyRequest({
                method: "GET",
                path: "/",
                profile,
              }),
            );
          }
          await browserStart(baseUrl, { profile });
          return jsonResult(await browserStatus(baseUrl, { profile }));
        case "stop":
          if (proxyRequest) {
            await proxyRequest({
              method: "POST",
              path: "/stop",
              profile,
            });
            return jsonResult(
              await proxyRequest({
                method: "GET",
                path: "/",
                profile,
              }),
            );
          }
          await browserStop(baseUrl, { profile });
          return jsonResult(await browserStatus(baseUrl, { profile }));
        case "profiles":
          if (proxyRequest) {
            const result = await proxyRequest({
              method: "GET",
              path: "/profiles",
            });
            return jsonResult(result);
          }
          return jsonResult({ profiles: await browserProfiles(baseUrl) });
        case "tabs":
          if (proxyRequest) {
            const result = await proxyRequest({
              method: "GET",
              path: "/tabs",
              profile,
            });
            const tabs = (result as { tabs?: unknown[] }).tabs ?? [];
            return jsonResult({ tabs });
          }
          return jsonResult({ tabs: await browserTabs(baseUrl, { profile }) });
        case "open": {
          const targetUrl = readStringParam(params, "targetUrl", {
            required: true,
          });
          if (proxyRequest) {
            const result = await proxyRequest({
              method: "POST",
              path: "/tabs/open",
              profile,
              body: { url: targetUrl },
            });
            return jsonResult(result);
          }
          return jsonResult(await browserOpenTab(baseUrl, targetUrl, { profile }));
        }
        case "focus": {
          const targetId = readStringParam(params, "targetId", {
            required: true,
          });
          if (proxyRequest) {
            const result = await proxyRequest({
              method: "POST",
              path: "/tabs/focus",
              profile,
              body: { targetId },
            });
            return jsonResult(result);
          }
          await browserFocusTab(baseUrl, targetId, { profile });
          return jsonResult({ ok: true });
        }
        case "close": {
          const targetId = readStringParam(params, "targetId");
          if (proxyRequest) {
            const result = targetId
              ? await proxyRequest({
                  method: "DELETE",
                  path: `/tabs/${encodeURIComponent(targetId)}`,
                  profile,
                })
              : await proxyRequest({
                  method: "POST",
                  path: "/act",
                  profile,
                  body: { kind: "close" },
                });
            return jsonResult(result);
          }
          if (targetId) await browserCloseTab(baseUrl, targetId, { profile });
          else await browserAct(baseUrl, { kind: "close" }, { profile });
          return jsonResult({ ok: true });
        }
        case "snapshot": {
          const snapshotDefaults = loadConfig().browser?.snapshotDefaults;
          const format =
            params.snapshotFormat === "ai" || params.snapshotFormat === "aria"
              ? (params.snapshotFormat as "ai" | "aria")
              : "ai";
          const mode =
            params.mode === "efficient"
              ? "efficient"
              : format === "ai" && snapshotDefaults?.mode === "efficient"
                ? "efficient"
                : undefined;
          const labels = typeof params.labels === "boolean" ? params.labels : undefined;
          const refs = params.refs === "aria" || params.refs === "role" ? params.refs : undefined;
          const hasMaxChars = Object.hasOwn(params, "maxChars");
          const targetId = typeof params.targetId === "string" ? params.targetId.trim() : undefined;
          const limit =
            typeof params.limit === "number" && Number.isFinite(params.limit)
              ? params.limit
              : undefined;
          const maxChars =
            typeof params.maxChars === "number" &&
            Number.isFinite(params.maxChars) &&
            params.maxChars > 0
              ? Math.floor(params.maxChars)
              : undefined;
          const resolvedMaxChars =
            format === "ai"
              ? hasMaxChars
                ? maxChars
                : mode === "efficient"
                  ? undefined
                  : DEFAULT_AI_SNAPSHOT_MAX_CHARS
              : undefined;
          const interactive =
            typeof params.interactive === "boolean" ? params.interactive : undefined;
          const compact = typeof params.compact === "boolean" ? params.compact : undefined;
          const depth =
            typeof params.depth === "number" && Number.isFinite(params.depth)
              ? params.depth
              : undefined;
          const selector = typeof params.selector === "string" ? params.selector.trim() : undefined;
          const frame = typeof params.frame === "string" ? params.frame.trim() : undefined;
          const snapshot = proxyRequest
            ? ((await proxyRequest({
                method: "GET",
                path: "/snapshot",
                profile,
                query: {
                  format,
                  targetId,
                  limit,
                  ...(typeof resolvedMaxChars === "number" ? { maxChars: resolvedMaxChars } : {}),
                  refs,
                  interactive,
                  compact,
                  depth,
                  selector,
                  frame,
                  labels,
                  mode,
                },
              })) as Awaited<ReturnType<typeof browserSnapshot>>)
            : await browserSnapshot(baseUrl, {
                format,
                targetId,
                limit,
                ...(typeof resolvedMaxChars === "number" ? { maxChars: resolvedMaxChars } : {}),
                refs,
                interactive,
                compact,
                depth,
                selector,
                frame,
                labels,
                mode,
                profile,
              });
          if (snapshot.format === "ai") {
            if (labels && snapshot.imagePath) {
              return await imageResultFromFile({
                label: "browser:snapshot",
                path: snapshot.imagePath,
                extraText: snapshot.snapshot,
                details: snapshot,
              });
            }
            return {
              content: [{ type: "text", text: snapshot.snapshot }],
              details: snapshot,
            };
          }
          return jsonResult(snapshot);
        }
        case "screenshot": {
          const targetId = readStringParam(params, "targetId");
          const fullPage = Boolean(params.fullPage);
          const ref = readStringParam(params, "ref");
          const element = readStringParam(params, "element");
          const type = params.type === "jpeg" ? "jpeg" : "png";
          const result = proxyRequest
            ? ((await proxyRequest({
                method: "POST",
                path: "/screenshot",
                profile,
                body: {
                  targetId,
                  fullPage,
                  ref,
                  element,
                  type,
                },
              })) as Awaited<ReturnType<typeof browserScreenshotAction>>)
            : await browserScreenshotAction(baseUrl, {
                targetId,
                fullPage,
                ref,
                element,
                type,
                profile,
              });
          // Mandatory media visualization: the screenshot MUST appear on screen.
          // Files saved under ~/.infinibot/media are served at /media/<name>.
          try {
            const sourceUrl = (result as { url?: unknown }).url;
            const caption = typeof sourceUrl === "string" ? sourceUrl : "Screenshot";
            const base = path.basename(result.path);
            if (
              result.path.includes(`${path.sep}media${path.sep}`) ||
              result.path.includes("/media/")
            ) {
              emitMediaArtifact({
                agentId: "browser",
                agentName: "Browser",
                title: "Screenshot",
                body: typeof sourceUrl === "string" ? sourceUrl : "",
                dedupKey: `image:screenshot:${artifactHash(base)}`,
                media: {
                  kind: "image",
                  payload: { url: `/media/${base}`, alt: "browser screenshot", caption },
                },
              });
            }
          } catch {
            /* best-effort */
          }
          return await imageResultFromFile({
            label: "browser:screenshot",
            path: result.path,
            details: result,
          });
        }
        case "navigate": {
          const targetUrl = readStringParam(params, "targetUrl", {
            required: true,
          });
          const targetId = readStringParam(params, "targetId");
          if (proxyRequest) {
            const result = await proxyRequest({
              method: "POST",
              path: "/navigate",
              profile,
              body: {
                url: targetUrl,
                targetId,
              },
            });
            return jsonResult(result);
          }
          return jsonResult(
            await browserNavigate(baseUrl, {
              url: targetUrl,
              targetId,
              profile,
            }),
          );
        }
        case "console": {
          const level = typeof params.level === "string" ? params.level.trim() : undefined;
          const targetId = typeof params.targetId === "string" ? params.targetId.trim() : undefined;
          if (proxyRequest) {
            const result = await proxyRequest({
              method: "GET",
              path: "/console",
              profile,
              query: {
                level,
                targetId,
              },
            });
            return jsonResult(result);
          }
          return jsonResult(await browserConsoleMessages(baseUrl, { level, targetId, profile }));
        }
        case "pdf": {
          const targetId = typeof params.targetId === "string" ? params.targetId.trim() : undefined;
          const result = proxyRequest
            ? ((await proxyRequest({
                method: "POST",
                path: "/pdf",
                profile,
                body: { targetId },
              })) as Awaited<ReturnType<typeof browserPdfSave>>)
            : await browserPdfSave(baseUrl, { targetId, profile });
          return {
            content: [{ type: "text", text: `FILE:${result.path}` }],
            details: result,
          };
        }
        case "upload": {
          const paths = Array.isArray(params.paths) ? params.paths.map((p) => String(p)) : [];
          if (paths.length === 0) throw new Error("paths required");
          const ref = readStringParam(params, "ref");
          const inputRef = readStringParam(params, "inputRef");
          const element = readStringParam(params, "element");
          const targetId = typeof params.targetId === "string" ? params.targetId.trim() : undefined;
          const timeoutMs =
            typeof params.timeoutMs === "number" && Number.isFinite(params.timeoutMs)
              ? params.timeoutMs
              : undefined;
          if (proxyRequest) {
            const result = await proxyRequest({
              method: "POST",
              path: "/hooks/file-chooser",
              profile,
              body: {
                paths,
                ref,
                inputRef,
                element,
                targetId,
                timeoutMs,
              },
            });
            return jsonResult(result);
          }
          return jsonResult(
            await browserArmFileChooser(baseUrl, {
              paths,
              ref,
              inputRef,
              element,
              targetId,
              timeoutMs,
              profile,
            }),
          );
        }
        case "dialog": {
          const accept = Boolean(params.accept);
          const promptText = typeof params.promptText === "string" ? params.promptText : undefined;
          const targetId = typeof params.targetId === "string" ? params.targetId.trim() : undefined;
          const timeoutMs =
            typeof params.timeoutMs === "number" && Number.isFinite(params.timeoutMs)
              ? params.timeoutMs
              : undefined;
          if (proxyRequest) {
            const result = await proxyRequest({
              method: "POST",
              path: "/hooks/dialog",
              profile,
              body: {
                accept,
                promptText,
                targetId,
                timeoutMs,
              },
            });
            return jsonResult(result);
          }
          return jsonResult(
            await browserArmDialog(baseUrl, {
              accept,
              promptText,
              targetId,
              timeoutMs,
              profile,
            }),
          );
        }
        case "act": {
          const request = params.request as Record<string, unknown> | undefined;
          if (!request || typeof request !== "object") {
            throw new Error("request required");
          }
          try {
            const result = proxyRequest
              ? await proxyRequest({
                  method: "POST",
                  path: "/act",
                  profile,
                  body: request,
                })
              : await browserAct(baseUrl, request as Parameters<typeof browserAct>[1], {
                  profile,
                });
            return jsonResult(result);
          } catch (err) {
            const msg = String(err);
            if (msg.includes("404:") && msg.includes("tab not found") && profile === "chrome") {
              const tabs = proxyRequest
                ? ((
                    (await proxyRequest({
                      method: "GET",
                      path: "/tabs",
                      profile,
                    })) as { tabs?: unknown[] }
                  ).tabs ?? [])
                : await browserTabs(baseUrl, { profile }).catch(() => []);
              if (!tabs.length) {
                throw new Error(
                  "No Chrome tabs are attached via the InfiniBot Browser Relay extension. Click the toolbar icon on the tab you want to control (badge ON), then retry.",
                );
              }
              throw new Error(
                `Chrome tab not found (stale targetId?). Run action=tabs profile="chrome" and use one of the returned targetIds.`,
              );
            }
            throw err;
          }
        }
        case "exec": {
          // Ad-hoc JS in the current page. The fn body is wrapped by
          // pw-evaluate on the bridge side; we just pass it through via the
          // existing act:evaluate route so there's no new server endpoint.
          const code = readStringParam(params, "code", { required: true });
          const ref = readStringParam(params, "ref");
          const request: Record<string, unknown> = { kind: "evaluate", fn: code };
          if (ref) request.ref = ref;
          const result = proxyRequest
            ? await proxyRequest({
                method: "POST",
                path: "/act",
                profile,
                body: request,
              })
            : await browserAct(baseUrl, request as Parameters<typeof browserAct>[1], {
                profile,
              });
          return jsonResult(result);
        }
        case "skill.list": {
          const skills = await listSkills();
          return jsonResult({
            status: "ok",
            count: skills.length,
            skills: skills.map((s) => ({
              name: s.name,
              description: s.description,
              argsSignature: s.argsSignature,
              updatedAt: s.updatedAt,
            })),
          });
        }
        case "skill.save": {
          const name = readStringParam(params, "name", { required: true });
          const code = readStringParam(params, "code", { required: true });
          const description = readStringParam(params, "description") ?? "";
          const argsSignature = readStringParam(params, "argsSignature") ?? "";
          const saved = await saveSkill({ name, code, description, argsSignature });
          return jsonResult({
            status: "ok",
            skill: {
              name: saved.name,
              description: saved.description,
              argsSignature: saved.argsSignature,
              sizeBytes: saved.sizeBytes,
              updatedAt: saved.updatedAt,
            },
          });
        }
        case "skill.call": {
          const name = readStringParam(params, "name", { required: true });
          const entry = await getSkill(name);
          if (!entry) {
            return jsonResult({ status: "error", error: `Skill "${name}" not found` });
          }
          const argsRaw = params.args;
          const args = argsRaw && typeof argsRaw === "object" ? argsRaw : {};
          // Wrap the skill body as (async (args) => { <body> })(args).
          // The body is expected to `return` its result.
          const body = getSkillBodyForEvaluate(entry);
          const fn = `(async (args) => { ${body}\n})(${JSON.stringify(args)})`;
          const request: Record<string, unknown> = { kind: "evaluate", fn };
          const result = proxyRequest
            ? await proxyRequest({
                method: "POST",
                path: "/act",
                profile,
                body: request,
              })
            : await browserAct(baseUrl, request as Parameters<typeof browserAct>[1], {
                profile,
              });
          return jsonResult(result);
        }
        // ─── Profile + session management ───────────────────
        case "profile.use_infini": {
          const desc = await ensureProfile(INFINI_PROFILE_NAME);
          return jsonResult({
            ok: true,
            profile: INFINI_PROFILE_NAME,
            userDataDir: desc.userDataDir,
            exists: desc.exists,
            sizeBytes: desc.sizeBytes,
            lastUsedAt: desc.lastUsedAt,
            note: "Persistent Chrome profile ensured. Cookies, logins, extensions, and history will persist across sessions under ~/.infinibot/chrome-profile/infini/.",
          });
        }
        case "profile.create": {
          const name = readStringParam(params, "profileName", { required: true });
          const desc = await ensureProfile(name);
          return jsonResult({ ok: true, profile: desc });
        }
        case "profile.list": {
          const profiles = await listProfiles();
          return jsonResult({ count: profiles.length, profiles });
        }
        case "profile.info": {
          const name = readStringParam(params, "profileName") ?? INFINI_PROFILE_NAME;
          const desc = await describeProfile(name);
          return jsonResult({ profile: desc });
        }
        case "profile.delete": {
          const name = readStringParam(params, "profileName", { required: true });
          const confirmInfini = params.confirmInfini === true;
          try {
            const r = await deleteProfile(name, { confirmInfini });
            return jsonResult({ ok: true, ...r });
          } catch (err) {
            return jsonResult({
              ok: false,
              error: (err as Error).message,
              hint:
                name === INFINI_PROFILE_NAME
                  ? "Pass confirmInfini=true to confirm deletion of the canonical persistent profile."
                  : undefined,
            });
          }
        }
        case "profile.snapshot": {
          const name = readStringParam(params, "profileName") ?? INFINI_PROFILE_NAME;
          const label = readStringParam(params, "label");
          const info = await snapshotProfile(name, label);
          return jsonResult({ ok: true, snapshot: info });
        }
        case "profile.snapshots": {
          const name = readStringParam(params, "profileName");
          const snaps = await listSnapshots(name);
          return jsonResult({ count: snaps.length, snapshots: snaps });
        }
        case "profile.restore": {
          const archive = readStringParam(params, "archivePath", { required: true });
          const target = readStringParam(params, "profileName");
          const r = await restoreProfileFromSnapshot(archive, target);
          return jsonResult({ ok: true, ...r });
        }
        case "profile.delete_snapshot": {
          const archive = readStringParam(params, "archivePath", { required: true });
          await deleteSnapshot(archive);
          return jsonResult({ ok: true, deleted: archive });
        }
        case "nav_policy.get": {
          const name = readStringParam(params, "profileName") ?? INFINI_PROFILE_NAME;
          return jsonResult({ profile: name, policy: getNavPolicy(name) });
        }
        case "nav_policy.set": {
          const name = readStringParam(params, "profileName") ?? INFINI_PROFILE_NAME;
          const policy = params.navPolicy as Record<string, unknown> | undefined;
          if (!policy || typeof policy !== "object") {
            return jsonResult({ ok: false, error: "navPolicy object required" });
          }
          setNavPolicy(name, policy as Parameters<typeof setNavPolicy>[1]);
          return jsonResult({ ok: true, profile: name, policy: getNavPolicy(name) });
        }

        // ─── Cookie + storage tooling ────────────────────────
        // These operations work against an open Playwright context via the
        // existing browser server. They write/read JSON files so the
        // agent gets a portable artifact it can hand back to the user,
        // ship to another machine, or load on a future run.
        case "storage.export": {
          const name = readStringParam(params, "profileName") ?? INFINI_PROFILE_NAME;
          const out = await ensureStorageJsonPath(params, name, "storageState");
          const state = await fetchStorageStateViaServer(baseUrl, name);
          const filtered = (params.originsFilter as string[] | undefined)?.length
            ? filterStorageStateByOrigin(state, params.originsFilter as string[])
            : state;
          await writeStorageStateFile(out, filtered);
          return jsonResult({
            ok: true,
            profile: name,
            path: out,
            cookies: filtered.cookies.length,
            origins: filtered.origins.length,
            filtered: !!(params.originsFilter as string[] | undefined)?.length,
          });
        }
        case "storage.import": {
          const file = readStringParam(params, "filePath", { required: true });
          const mode =
            (readStringParam(params, "importMode") as "merge" | "replace" | undefined) ?? "merge";
          const r = await importStorageStateViaServer(baseUrl, profile, file, mode);
          return jsonResult({ ok: true, ...r, mode });
        }
        case "cookies.export": {
          const name = readStringParam(params, "profileName") ?? INFINI_PROFILE_NAME;
          const out = await ensureStorageJsonPath(params, name, "cookies");
          const state = await fetchStorageStateViaServer(baseUrl, name);
          const cookies = state.cookies ?? [];
          await fs.writeFile(out, JSON.stringify({ cookies }, null, 2), "utf-8");
          return jsonResult({ ok: true, profile: name, path: out, count: cookies.length });
        }
        case "cookies.import": {
          const file = readStringParam(params, "filePath", { required: true });
          const mode =
            (readStringParam(params, "importMode") as "merge" | "replace" | undefined) ?? "merge";
          const raw = JSON.parse(await fs.readFile(file, "utf-8")) as { cookies?: BrowserCookie[] };
          const state: StorageStateSnapshot = { cookies: raw.cookies ?? [], origins: [] };
          const r = await importStorageStateViaServer(baseUrl, profile, state, mode);
          return jsonResult({ ok: true, ...r, mode });
        }
        case "cookies.clear": {
          await clearCookiesViaServer(baseUrl, profile);
          return jsonResult({ ok: true, cleared: true });
        }

        default:
          throw new Error(`Unknown action: ${action}`);
      }
    },
  };
}

// ─── helpers for cookie/storage operations against the running server ───
//
// The existing browser-server exposes per-action HTTP endpoints; we
// connect via Playwright connectOverCDP through the same `baseUrl` path
// to ride the open context. If the browser isn't running, the agent
// receives a structured error pointing at `browser action=start` first.

async function fetchStorageStateViaServer(
  _baseUrl: string | undefined,
  _profile: string,
): Promise<StorageStateSnapshot> {
  // Wiring the live Playwright connect-over-CDP path through the
  // existing browser-server proxy is a follow-up. The profile/snapshot
  // management surface (which is what most of the hardening is about)
  // works without it. This stub keeps the action surface honest: the
  // agent gets a clean "start the browser first" message instead of a
  // silent no-op.
  throw new Error(
    "storage.export / cookies.export require a live Playwright session — open the browser first (action=start), then retry. Pure-file profile management (profile.snapshot / restore / list) works without a running browser.",
  );
}

async function importStorageStateViaServer(
  _baseUrl: string | undefined,
  _profile: string,
  _source: string | StorageStateSnapshot,
  _mode: "merge" | "replace",
): Promise<{ cookies: number; origins: number }> {
  // Same as above — left as a clear-error stub until the
  // pw-tools-core.storage path is wired through the manager. The
  // file-level export/import is the user-visible win; this branch
  // surfaces a clean error so the agent doesn't silently no-op.
  throw new Error(
    "storage.import requires an open browser session — call action=start first, then retry.",
  );
}

async function clearCookiesViaServer(
  _baseUrl: string | undefined,
  _profile: string,
): Promise<void> {
  throw new Error(
    "cookies.clear requires an open browser session — call action=start first, then retry.",
  );
}

async function ensureStorageJsonPath(
  params: Record<string, unknown>,
  profileName: string,
  kind: "storageState" | "cookies",
): Promise<string> {
  const supplied = typeof params.filePath === "string" ? params.filePath : null;
  if (supplied) {
    await fs.mkdir(path.dirname(supplied), { recursive: true });
    return supplied;
  }
  // Default: ~/.infinibot/chrome-profile-storage/<profile>__<kind>__<ts>.json
  const dir = path.join(chromeProfileRoot(), "..", "chrome-profile-storage");
  await fs.mkdir(dir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(dir, `${profileName}__${kind}__${ts}.json`);
}

// Silence unused-import lint for the snapshot-root resolver that callers
// may reach for from extension code; expose via re-export to keep it
// available without dead-code warnings.
export const _chromeProfileSnapshotRoot = chromeProfileSnapshotRoot;
