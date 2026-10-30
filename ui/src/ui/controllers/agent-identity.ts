/**
 * Agent Identity Controller
 *
 * Front-end state + actions for managing per-agent identity files
 * (SOUL.md / MEMORY.md / USER.md / AGENTS.md / IDENTITY.md / TOOLS.md /
 * HEARTBEAT.md). Talks to agent.identity.* gateway methods.
 *
 * Three things this drives:
 *   1. List + edit + delete current identity files for the selected agent.
 *   2. Drag-drop / file-picker upload — collects pending imports the user
 *      reviews per-file (replace / skip / append) before committing.
 *   3. Bundle export (download JSON) and import-from-peer (pull a bundle
 *      from another moltbot/infinibot gateway URL).
 */

import type { GatewayBrowserClient } from "../gateway.js";
import type { AppViewState } from "../app-view-state.js";

// ── Types ────────────────────────────────────────────────────

export type IdentityFilename =
  | "SOUL.md"
  | "USER.md"
  | "AGENTS.md"
  | "IDENTITY.md"
  | "MEMORY.md"
  | "TOOLS.md"
  | "HEARTBEAT.md";

export const IDENTITY_FILENAMES: IdentityFilename[] = [
  "SOUL.md",
  "USER.md",
  "AGENTS.md",
  "IDENTITY.md",
  "MEMORY.md",
  "TOOLS.md",
  "HEARTBEAT.md",
];

export interface IdentityFileMeta {
  filename: string;
  exists: boolean;
  size: number;
  modified: number;
  /** Read-only from the operator UI (e.g. SOUL.md — preserved for agent
   *  sovereignty). The gateway will reject writes to these. */
  readOnly?: boolean;
}

export interface IdentityAgent {
  id: string;
  name: string;
  workspace: string;
  isDefault: boolean;
  filesPresent: number;
  filesTotal: number;
}

export type ImportAction = "replace" | "skip" | "append";

export interface PendingImport {
  filename: string;
  /** Content from the source (uploaded file or remote bundle). */
  incomingContent: string;
  /** Snapshot of the current file content on this gateway. */
  currentContent: string | null;
  action: ImportAction;
}

export interface AgentIdentityState {
  loading: boolean;
  saving: boolean;
  importing: boolean;
  pulling: boolean;
  error: string | null;
  agents: IdentityAgent[];
  selectedAgentId: string;
  files: IdentityFileMeta[];
  /** filename → cached content. Populated on demand. */
  contents: Record<string, string>;
  /** filename currently open in the editor pane. */
  editing: string | null;
  /** Local edit buffer for the currently-edited file. */
  editorBuffer: string;
  pendingImports: PendingImport[];
  importDialogOpen: boolean;
  /** URL of a peer gateway for pull-from-federation flow. */
  peerUrl: string;
  peerToken: string;
  /** Last operation status message — surfaced as a transient banner. */
  status: string | null;
}

export function defaultAgentIdentityState(): AgentIdentityState {
  return {
    loading: false,
    saving: false,
    importing: false,
    pulling: false,
    error: null,
    agents: [],
    selectedAgentId: "",
    files: [],
    contents: {},
    editing: null,
    editorBuffer: "",
    pendingImports: [],
    importDialogOpen: false,
    peerUrl: "",
    peerToken: "",
    status: null,
  };
}

// ── Helpers ──────────────────────────────────────────────────

function getOrInitState(state: AppViewState): AgentIdentityState {
  if (!state.agentIdentityState) {
    state.agentIdentityState = defaultAgentIdentityState();
  }
  return state.agentIdentityState;
}

function setStatus(state: AppViewState, message: string | null) {
  const s = getOrInitState(state);
  s.status = message;
  state.requestUpdate?.();
  if (message) {
    setTimeout(() => {
      if (s.status === message) {
        s.status = null;
        state.requestUpdate?.();
      }
    }, 4000);
  }
}

function setError(state: AppViewState, error: string | null) {
  const s = getOrInitState(state);
  s.error = error;
  state.requestUpdate?.();
}

// ── Agents + file listing ────────────────────────────────────

export async function loadIdentityAgents(
  state: AppViewState,
  client: GatewayBrowserClient,
): Promise<void> {
  const s = getOrInitState(state);
  s.loading = true;
  setError(state, null);
  try {
    const res = (await client.request("agent.identity.agents.list", {})) as {
      agents: IdentityAgent[];
      defaultAgentId: string;
    };
    s.agents = res.agents ?? [];
    if (!s.selectedAgentId) {
      s.selectedAgentId = res.defaultAgentId || (s.agents[0]?.id ?? "");
    }
    if (s.selectedAgentId) {
      await loadIdentityFiles(state, client);
    }
  } catch (e) {
    setError(state, (e as Error).message);
  } finally {
    s.loading = false;
    state.requestUpdate?.();
  }
}

export async function loadIdentityFiles(
  state: AppViewState,
  client: GatewayBrowserClient,
): Promise<void> {
  const s = getOrInitState(state);
  if (!s.selectedAgentId) return;
  try {
    const res = (await client.request("agent.identity.files.list", {
      agentId: s.selectedAgentId,
    })) as { files: IdentityFileMeta[] };
    s.files = res.files ?? [];
    state.requestUpdate?.();
  } catch (e) {
    setError(state, (e as Error).message);
  }
}

export async function selectIdentityAgent(
  state: AppViewState,
  client: GatewayBrowserClient,
  agentId: string,
): Promise<void> {
  const s = getOrInitState(state);
  s.selectedAgentId = agentId;
  s.editing = null;
  s.editorBuffer = "";
  s.contents = {};
  await loadIdentityFiles(state, client);
}

// ── Read / edit / write ──────────────────────────────────────

export async function openIdentityFile(
  state: AppViewState,
  client: GatewayBrowserClient,
  filename: string,
): Promise<void> {
  const s = getOrInitState(state);
  if (!s.selectedAgentId) return;
  try {
    const res = (await client.request("agent.identity.files.read", {
      agentId: s.selectedAgentId,
      filename,
    })) as { content: string | null };
    const content = res.content ?? "";
    s.contents[filename] = content;
    s.editing = filename;
    s.editorBuffer = content;
    state.requestUpdate?.();
  } catch (e) {
    setError(state, (e as Error).message);
  }
}

export function setEditorBuffer(state: AppViewState, value: string): void {
  const s = getOrInitState(state);
  s.editorBuffer = value;
  state.requestUpdate?.();
}

export function closeEditor(state: AppViewState): void {
  const s = getOrInitState(state);
  s.editing = null;
  s.editorBuffer = "";
  state.requestUpdate?.();
}

export async function saveIdentityFile(
  state: AppViewState,
  client: GatewayBrowserClient,
): Promise<void> {
  const s = getOrInitState(state);
  if (!s.selectedAgentId || !s.editing) return;
  s.saving = true;
  state.requestUpdate?.();
  try {
    await client.request("agent.identity.files.write", {
      agentId: s.selectedAgentId,
      filename: s.editing,
      content: s.editorBuffer,
      mode: "replace",
      backup: true,
    });
    s.contents[s.editing] = s.editorBuffer;
    setStatus(state, `Saved ${s.editing}`);
    await loadIdentityFiles(state, client);
  } catch (e) {
    setError(state, (e as Error).message);
  } finally {
    s.saving = false;
    state.requestUpdate?.();
  }
}

export async function deleteIdentityFile(
  state: AppViewState,
  client: GatewayBrowserClient,
  filename: string,
): Promise<void> {
  const s = getOrInitState(state);
  if (!s.selectedAgentId) return;
  if (!confirm(`Delete ${filename}? A .bak copy will be kept.`)) return;
  try {
    await client.request("agent.identity.files.delete", {
      agentId: s.selectedAgentId,
      filename,
      backup: true,
    });
    delete s.contents[filename];
    if (s.editing === filename) {
      s.editing = null;
      s.editorBuffer = "";
    }
    setStatus(state, `Deleted ${filename} (kept .bak)`);
    await loadIdentityFiles(state, client);
  } catch (e) {
    setError(state, (e as Error).message);
  }
}

// ── Bundle export (download as JSON) ─────────────────────────

export async function exportIdentityBundle(
  state: AppViewState,
  client: GatewayBrowserClient,
): Promise<void> {
  const s = getOrInitState(state);
  if (!s.selectedAgentId) return;
  try {
    const bundle = await client.request("agent.identity.bundle.export", {
      agentId: s.selectedAgentId,
    });
    const json = JSON.stringify(bundle, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `infinibot-identity-${s.selectedAgentId}-${Date.now()}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    setStatus(state, `Exported identity bundle for ${s.selectedAgentId}`);
  } catch (e) {
    setError(state, (e as Error).message);
  }
}

// ── Drag-drop / file picker import ───────────────────────────

/**
 * Read a list of dropped/selected files and stage them as pending imports.
 * Two accepted formats:
 *   - Individual .md files with one of the IDENTITY_FILENAMES (case-insensitive
 *     match). Filename in pending import normalizes to canonical case.
 *   - A single .json bundle (as produced by exportIdentityBundle) — its
 *     `files` map gets unpacked into pending imports.
 *
 * Files outside the allowlist are ignored. After this call the import dialog
 * opens so the user can choose action per file.
 */
export async function stageImportFiles(
  state: AppViewState,
  client: GatewayBrowserClient,
  files: FileList | File[],
): Promise<void> {
  const s = getOrInitState(state);
  const list = Array.from(files);
  if (list.length === 0) return;

  // Snapshot current file contents so the dialog can show diffs.
  const currentContents: Record<string, string | null> = {};
  for (const f of IDENTITY_FILENAMES) {
    try {
      const res = (await client.request("agent.identity.files.read", {
        agentId: s.selectedAgentId,
        filename: f,
      })) as { content: string | null };
      currentContents[f] = res.content;
    } catch {
      currentContents[f] = null;
    }
  }

  const pending: PendingImport[] = [];

  for (const file of list) {
    const lower = file.name.toLowerCase();
    if (lower.endsWith(".json")) {
      try {
        const text = await file.text();
        const parsed = JSON.parse(text) as { files?: Record<string, string> };
        if (parsed.files && typeof parsed.files === "object") {
          for (const [fname, content] of Object.entries(parsed.files)) {
            const canonical = canonicalizeIdentityFilename(fname);
            if (!canonical || typeof content !== "string") continue;
            pending.push({
              filename: canonical,
              incomingContent: content,
              currentContent: currentContents[canonical] ?? null,
              action: "replace",
            });
          }
        }
      } catch (e) {
        setError(state, `Failed to parse bundle ${file.name}: ${(e as Error).message}`);
      }
      continue;
    }

    // Treat as individual identity file
    const canonical = canonicalizeIdentityFilename(file.name);
    if (!canonical) continue; // not in allowlist
    const text = await file.text();
    pending.push({
      filename: canonical,
      incomingContent: text,
      currentContent: currentContents[canonical] ?? null,
      action: "replace",
    });
  }

  if (pending.length === 0) {
    setError(state, "None of the dropped files match the identity allowlist.");
    return;
  }

  // De-dupe — last occurrence wins for any given filename.
  const map = new Map<string, PendingImport>();
  for (const p of pending) map.set(p.filename, p);
  s.pendingImports = Array.from(map.values());
  s.importDialogOpen = true;
  state.requestUpdate?.();
}

/**
 * Stage a single uploaded file as a replacement for a specific identity
 * filename, then open the import dialog so the user can review the diff and
 * confirm. Skips the drag-drop allowlist (the user picked a target filename
 * explicitly via the per-card Replace button).
 */
export async function replaceIdentityFile(
  state: AppViewState,
  client: GatewayBrowserClient,
  filename: IdentityFilename,
  file: File,
): Promise<void> {
  const s = getOrInitState(state);
  if (!s.selectedAgentId) return;

  let currentContent: string | null = null;
  try {
    const res = (await client.request("agent.identity.files.read", {
      agentId: s.selectedAgentId,
      filename,
    })) as { content: string | null };
    currentContent = res.content;
  } catch {
    currentContent = null;
  }

  const incomingContent = await file.text();
  s.pendingImports = [
    {
      filename,
      incomingContent,
      currentContent,
      action: "replace",
    },
  ];
  s.importDialogOpen = true;
  state.requestUpdate?.();
}

export function setPendingAction(
  state: AppViewState,
  filename: string,
  action: ImportAction,
): void {
  const s = getOrInitState(state);
  const p = s.pendingImports.find((x) => x.filename === filename);
  if (p) p.action = action;
  state.requestUpdate?.();
}

export function cancelPendingImport(state: AppViewState): void {
  const s = getOrInitState(state);
  s.pendingImports = [];
  s.importDialogOpen = false;
  state.requestUpdate?.();
}

export async function commitPendingImport(
  state: AppViewState,
  client: GatewayBrowserClient,
): Promise<void> {
  const s = getOrInitState(state);
  if (s.pendingImports.length === 0) return;
  s.importing = true;
  state.requestUpdate?.();
  try {
    const filesPayload: Record<string, string> = {};
    const actionsPayload: Record<string, ImportAction> = {};
    for (const p of s.pendingImports) {
      filesPayload[p.filename] = p.incomingContent;
      actionsPayload[p.filename] = p.action;
    }
    const res = (await client.request("agent.identity.bundle.import", {
      agentId: s.selectedAgentId,
      files: filesPayload,
      actions: actionsPayload,
      autoBackup: true,
    })) as { results: Array<{ filename: string; status: string; error?: string }> };

    const written = res.results.filter((r) => r.status === "written").length;
    const skipped = res.results.filter((r) => r.status === "skipped").length;
    const errors = res.results.filter((r) => r.status === "error" || r.status === "rejected");
    if (errors.length > 0) {
      setError(state, `${errors.length} file(s) failed: ${errors.map((e) => `${e.filename}: ${e.error}`).join("; ")}`);
    } else {
      setStatus(state, `Imported ${written} file(s)${skipped ? `, skipped ${skipped}` : ""}.`);
    }

    s.pendingImports = [];
    s.importDialogOpen = false;
    await loadIdentityFiles(state, client);
  } catch (e) {
    setError(state, (e as Error).message);
  } finally {
    s.importing = false;
    state.requestUpdate?.();
  }
}

// ── Pull from peer gateway (federation master or arbitrary) ──

/**
 * Open a transient WebSocket to a remote gateway URL, fetch its identity
 * bundle for the same agentId, and stage it for per-file import. This is the
 * client-side path for the "pull from federation master" flow — works against
 * any moltbot/infinibot gateway, not just configured federation peers.
 *
 * Imported lazily so the bundled control-ui doesn't pull GatewayBrowserClient
 * twice into the same scope.
 */
export async function pullIdentityFromPeer(
  state: AppViewState,
  localClient?: GatewayBrowserClient,
): Promise<void> {
  const s = getOrInitState(state);
  if (!s.peerUrl.trim()) {
    setError(state, "Enter a peer gateway URL first.");
    return;
  }
  // Fall back to the singleton on window if the caller didn't pass one — the
  // app-gateway.ts onHello handler stores a reference there for cross-module
  // access. Either path works; we just need to read local file contents to
  // build the per-file diff.
  const client = localClient
    ?? (window as unknown as { __infinibotGatewayClient?: GatewayBrowserClient })
       .__infinibotGatewayClient;
  if (!client) {
    setError(state, "Local gateway client not ready.");
    return;
  }
  s.pulling = true;
  state.requestUpdate?.();
  try {
    const { GatewayBrowserClient } = await import("../gateway.js");
    // Transient connection just to fetch a bundle — uses default client
    // identifiers since we drop it as soon as the request resolves.
    const peer = new GatewayBrowserClient({
      url: s.peerUrl.trim(),
      token: s.peerToken.trim() || undefined,
      onHello: () => {},
      onClose: () => {},
    });
    peer.start();

    // GatewayBrowserClient.request() queues until hello, so this also acts as
    // the connection probe.
    const bundle = (await peer.request("agent.identity.bundle.export", {
      agentId: s.selectedAgentId,
    })) as { files?: Record<string, string> };

    peer.stop();

    if (!bundle?.files || Object.keys(bundle.files).length === 0) {
      setError(state, "Peer gateway returned no identity files.");
      return;
    }

    const fileObjects: File[] = Object.entries(bundle.files).map(
      ([filename, content]) =>
        new File([content], filename, { type: "text/markdown" }),
    );
    await stageImportFiles(state, client, fileObjects);
    setStatus(state, `Fetched ${fileObjects.length} file(s) from peer`);
  } catch (e) {
    setError(state, `Pull failed: ${(e as Error).message}`);
  } finally {
    s.pulling = false;
    state.requestUpdate?.();
  }
}

/**
 * In federation satellite mode, ask the master to push a fresh identity
 * snapshot. The master writes files into our workspace via the existing
 * identity.sync channel, so the UI just has to wait briefly and re-fetch
 * the file list. Also prefills the peer URL field with the master URL so
 * the user can fall back to a manual peer pull if they prefer.
 *
 * In master/standalone mode this surfaces a clear error.
 */
export async function pullFromFederationMaster(
  state: AppViewState,
  client: GatewayBrowserClient,
): Promise<void> {
  const s = getOrInitState(state);
  s.pulling = true;
  state.requestUpdate?.();
  try {
    const res = (await client.request("agent.identity.federation.pull", {})) as {
      mode?: string;
      masterUrl?: string | null;
      requested?: boolean;
      message?: string;
    };
    if (res.masterUrl) {
      s.peerUrl = res.masterUrl;
    }
    if (res.requested) {
      setStatus(state, "Identity sync requested from master — refreshing…");
      // Master push lands via the federation websocket — give it a beat to
      // arrive before we re-list. The IdentitySyncManager writes files
      // synchronously once the message arrives, so 1.5s covers normal
      // round-trip + write latency comfortably.
      setTimeout(() => {
        loadIdentityFiles(state, client).catch(() => {});
      }, 1500);
    } else if (res.message) {
      setStatus(state, res.message);
    }
  } catch (e) {
    setError(state, (e as Error).message);
  } finally {
    s.pulling = false;
    state.requestUpdate?.();
  }
}

/** @deprecated Use pullFromFederationMaster — this name lives on for older callers. */
export const prefillFederationMasterUrl = pullFromFederationMaster;

export function setPeerUrl(state: AppViewState, value: string): void {
  const s = getOrInitState(state);
  s.peerUrl = value;
  state.requestUpdate?.();
}

export function setPeerToken(state: AppViewState, value: string): void {
  const s = getOrInitState(state);
  s.peerToken = value;
  state.requestUpdate?.();
}

// ── Internal ─────────────────────────────────────────────────

function canonicalizeIdentityFilename(name: string): IdentityFilename | null {
  const base = name.split(/[\\/]/).pop() ?? name; // strip any path
  const upper = base.toUpperCase();
  for (const allowed of IDENTITY_FILENAMES) {
    if (upper === allowed.toUpperCase()) return allowed;
  }
  return null;
}
