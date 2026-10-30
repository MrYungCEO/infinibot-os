/**
 * Where <voice-terminal-stream> reads from: which terminal / CLI coder run is
 * "selected", what is available, and how its output reaches the browser.
 *
 * Data sources (all existing gateway methods, read-only):
 *   terminal.list              PTY terminals this gateway holds (title, cliType, lastActiveAt)
 *   terminal.listReattachable  every live tmux pane incl. coder runs (`spawn-*`: claude_coder,
 *                              codex_coder, opencode_coder) — label, backend, runId
 *   subagents.list             coder run status + recency (lastUpdateAt) by runId
 *   terminal.peek              tail of one terminal (manager buffer, or tmux capture-pane for
 *                              coder panes the manager does not hold). NEW, read-only:
 *                              src/gateway/server-methods/terminal-peek.ts. Falls back to
 *                              terminal.getBuffer on gateways that don't have it yet.
 *   event "terminal.output"    live PTY chunks {id, data} the gateway broadcasts to every client
 *
 * ── INTEGRATION POINT: the voice terminal's CLI-mode toggle ────────────────
 * The CLI mode toggle (`isCliMode`, owned by a separate change) tells this
 * panel which backend to follow. It integrates by calling
 *
 *     setVoiceCliSelection({ isCliMode, backend?, terminalId? })
 *
 * (or dispatching `VOICE_CLI_MODE_EVENT` on window with the same detail).
 * The value is persisted under `VOICE_CLI_MODE_KEY` in localStorage, so a
 * reload keeps it. Until the toggle exists, readVoiceCliSelection() falls back
 * to <agent-cli-selector>'s persisted choice for the "voice" surface (and its
 * "default" surface), and with nothing chosen the panel follows the most
 * recently active terminal / coder run.
 */

/** <agent-cli-selector>'s persisted value (same key format, read without loading the element). */
function readCliSelector(surfaceId: string, store: StorageLike | null): { kind: string; id: string } | null {
  try {
    const raw = store?.getItem(`infinibot.voice.cli-selector.${surfaceId}`);
    const v = raw ? (JSON.parse(raw) as { kind?: unknown; id?: unknown }) : null;
    return v && typeof v.kind === "string" && typeof v.id === "string" ? { kind: v.kind, id: v.id } : null;
  } catch {
    return null;
  }
}

export type StreamSourceKind = "terminal" | "coder";

export type StreamSource = {
  id: string;
  kind: StreamSourceKind;
  title: string;
  /** CLI / coder backend: claude-code | codex | opencode | gemini | shell … */
  backend: string | null;
  runId?: string;
  sessionKey?: string;
  /** Epoch ms of the last known activity (0 = unknown). */
  lastActiveAt: number;
  /** True for a coder run that is still working. */
  active: boolean;
  /** The gateway's PTY manager holds it (live `terminal.output` events). */
  pty: boolean;
};

export type VoiceCliSelection = {
  /** CLI mode on: voice turns go to a CLI coder; the panel follows that backend. */
  isCliMode: boolean;
  /** Backend id of the selected CLI (claude-code | codex | opencode | gemini). */
  backend?: string | null;
  /** An explicit terminal / run pane to follow. */
  terminalId?: string | null;
};

export const VOICE_CLI_MODE_KEY = "infinibot.voice.cliMode";
export const VOICE_CLI_MODE_EVENT = "infinibot:voice-cli-mode";
/** <agent-cli-selector> surface id the voice terminal uses. */
export const VOICE_SELECTOR_SURFACE = "voice";

type StorageLike = Pick<Storage, "getItem" | "setItem">;

function storage(): StorageLike | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
}

function parseSelection(raw: unknown): VoiceCliSelection | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.isCliMode !== "boolean") return null;
  return {
    isCliMode: r.isCliMode,
    backend: typeof r.backend === "string" && r.backend ? r.backend : null,
    terminalId: typeof r.terminalId === "string" && r.terminalId ? r.terminalId : null,
  };
}

/** What the voice terminal's CLI mode currently selects (see INTEGRATION POINT above). */
export function readVoiceCliSelection(store: StorageLike | null = storage()): VoiceCliSelection {
  try {
    const raw = store?.getItem(VOICE_CLI_MODE_KEY);
    const parsed = raw ? parseSelection(JSON.parse(raw)) : null;
    if (parsed) return parsed;
  } catch {
    /* fall through */
  }
  const v = readCliSelector(VOICE_SELECTOR_SURFACE, store) ?? readCliSelector("default", store);
  if (v?.kind === "cli") return { isCliMode: true, backend: v.id };
  return { isCliMode: false };
}

/** Called by the CLI-mode toggle: persist + notify every open panel. */
export function setVoiceCliSelection(sel: VoiceCliSelection, store: StorageLike | null = storage()): void {
  try {
    store?.setItem(VOICE_CLI_MODE_KEY, JSON.stringify(sel));
  } catch {
    /* private mode */
  }
  try {
    window.dispatchEvent(new CustomEvent<VoiceCliSelection>(VOICE_CLI_MODE_EVENT, { detail: sel }));
  } catch {
    /* no window */
  }
}

/** Subscribe to selection changes (toggle event, another tab's storage write, selector change). */
export function onVoiceCliSelectionChange(cb: (sel: VoiceCliSelection) => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  const onEvent = (e: Event) => cb(parseSelection((e as CustomEvent).detail) ?? readVoiceCliSelection());
  const onStorage = (e: StorageEvent) => {
    if (e.key === VOICE_CLI_MODE_KEY || e.key?.startsWith("infinibot.voice.cli-selector.")) cb(readVoiceCliSelection());
  };
  window.addEventListener(VOICE_CLI_MODE_EVENT, onEvent);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(VOICE_CLI_MODE_EVENT, onEvent);
    window.removeEventListener("storage", onStorage);
  };
}

/** Same id rule as the gateway's sanitizeTerminalId (term-1 ≡ term_1). */
export function canonicalTerminalId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_]/g, "_");
}

/** Normalise backend names from cliType / coderBackend / reattachable kinds. */
export function normalizeBackend(raw: string | null | undefined): string | null {
  const v = raw?.trim().toLowerCase();
  if (!v) return null;
  if (v === "claude" || v === "claude-code" || v === "claude_code" || v === "cloud") return "claude-code";
  if (v.startsWith("codex")) return "codex";
  if (v.startsWith("opencode")) return "opencode";
  if (v.startsWith("gemini")) return "gemini";
  if (v.startsWith("grok")) return "grok";
  return v;
}

/**
 * The source to follow:
 *   1. the one the user pinned in the panel,
 *   2. the toggle's explicit terminalId,
 *   3. CLI mode on → the most recent source of that backend,
 *   4. otherwise the most recently active terminal / coder run.
 */
export function pickStreamSource(sources: StreamSource[], sel: VoiceCliSelection, pinnedId?: string | null): StreamSource | null {
  if (sources.length === 0) return null;
  const byId = (id: string | null | undefined) => (id ? sources.find((s) => canonicalTerminalId(s.id) === canonicalTerminalId(id)) : undefined);
  const pinned = byId(pinnedId);
  if (pinned) return pinned;
  const explicit = byId(sel.terminalId);
  if (explicit) return explicit;
  const ranked = rankSources(sources);
  if (sel.isCliMode && sel.backend) {
    const want = normalizeBackend(sel.backend);
    const match = ranked.find((s) => s.backend === want);
    if (match) return match;
  }
  return ranked[0] ?? null;
}

/** Working coder runs first, then by last activity (newest first). */
export function rankSources(sources: StreamSource[]): StreamSource[] {
  return [...sources].sort((a, b) => Number(b.active) - Number(a.active) || b.lastActiveAt - a.lastActiveAt || a.title.localeCompare(b.title));
}

type Rpc = <T>(method: string, params?: Record<string, unknown>) => Promise<T>;

type ListedTerminal = { id: string; title?: string; cliType?: string; lastActiveAt?: string; createdAt?: string; sessionKey?: string };
type ReattachEntry = { id: string; kind?: string; backend?: string; label?: string; runId?: string; sessionKey?: string };
type SubagentRow = { runId: string; status?: string; lastUpdateAt?: number; endedAt?: number; label?: string; coderBackend?: string };

const WORKING = new Set(["running", "working", "starting", "spawning", "active", "thinking"]);

function ts(v: string | number | undefined): number {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  const n = v ? Date.parse(v) : NaN;
  return Number.isFinite(n) ? n : 0;
}

/** Merge the three listings into one de-duplicated source list. Pure (exported for tests). */
export function mergeStreamSources(terminals: ListedTerminal[], reattachable: ReattachEntry[], runs: SubagentRow[]): StreamSource[] {
  const runById = new Map(runs.map((r) => [r.runId, r]));
  const out = new Map<string, StreamSource>();
  for (const t of terminals) {
    if (!t?.id) continue;
    out.set(canonicalTerminalId(t.id), {
      id: t.id,
      kind: "terminal",
      title: t.title?.trim() || t.id,
      backend: normalizeBackend(t.cliType) ?? "shell",
      sessionKey: t.sessionKey,
      lastActiveAt: ts(t.lastActiveAt) || ts(t.createdAt),
      active: false,
      pty: true,
    });
  }
  for (const e of reattachable) {
    if (!e?.id) continue;
    const key = canonicalTerminalId(e.id);
    const isCoder = e.kind === "cloud" || e.kind === "codex" || Boolean(e.runId);
    const run = e.runId ? runById.get(e.runId) : undefined;
    const prev = out.get(key);
    const backend = normalizeBackend(e.backend ?? run?.coderBackend ?? (e.kind === "codex" ? "codex" : e.kind === "cloud" ? "claude-code" : null));
    out.set(key, {
      id: prev?.id ?? e.id,
      kind: isCoder ? "coder" : (prev?.kind ?? "terminal"),
      title: (isCoder ? run?.label || e.label : prev?.title || e.label)?.trim() || e.id,
      backend: backend ?? prev?.backend ?? null,
      runId: e.runId,
      sessionKey: e.sessionKey ?? prev?.sessionKey,
      lastActiveAt: Math.max(prev?.lastActiveAt ?? 0, run?.lastUpdateAt ?? 0),
      active: run ? WORKING.has(String(run.status ?? "").toLowerCase()) && !run.endedAt : false,
      pty: prev?.pty ?? false,
    });
  }
  return [...out.values()];
}

/** List everything the panel can follow. Each listing is best-effort. */
export async function listStreamSources(rpc: Rpc): Promise<StreamSource[]> {
  const [terms, re, subs] = await Promise.allSettled([
    rpc<{ terminals?: ListedTerminal[] }>("terminal.list", {}),
    rpc<{ entries?: ReattachEntry[] }>("terminal.listReattachable", {}),
    rpc<{ subagents?: SubagentRow[] }>("subagents.list", { compact: true, limit: 50 }),
  ]);
  if (terms.status === "rejected" && re.status === "rejected") throw terms.reason;
  return mergeStreamSources(
    terms.status === "fulfilled" ? (terms.value?.terminals ?? []) : [],
    re.status === "fulfilled" ? (re.value?.entries ?? []) : [],
    subs.status === "fulfilled" ? (subs.value?.subagents ?? []) : [],
  );
}

export type Snapshot = { text: string; source: "pty" | "tmux" | "none"; alive: boolean };

let peekMissing = false;

/** Current tail of one source: terminal.peek, or terminal.getBuffer on older gateways. */
export async function fetchStreamSnapshot(rpc: Rpc, id: string): Promise<Snapshot> {
  if (!peekMissing) {
    try {
      const r = await rpc<{ text?: string; source?: Snapshot["source"]; alive?: boolean }>("terminal.peek", { id, maxChars: 96_000 });
      const source = r?.source ?? "none";
      // A pane capture is the whole screen: drop the empty rows under the prompt.
      const text = source === "tmux" ? (r?.text ?? "").replace(/\s+$/, "") : (r?.text ?? "");
      return { text, source, alive: r?.alive !== false };
    } catch (err) {
      if (!/unknown method|not found|METHOD_NOT_FOUND|INVALID_METHOD/i.test(String((err as Error)?.message ?? err))) throw err;
      peekMissing = true;
    }
  }
  const r = await rpc<{ buffer?: string }>("terminal.getBuffer", { id });
  return { text: r?.buffer ?? "", source: r?.buffer ? "pty" : "none", alive: true };
}

type EventClient = { subscribe?: (h: (evt: { event: string; payload?: unknown }) => void) => () => void };

/** Live PTY chunks for one terminal (the gateway broadcasts `terminal.output` to every client). */
export function subscribeTerminalOutput(client: EventClient | null | undefined, id: string, onData: (data: string) => void): () => void {
  if (!client?.subscribe) return () => undefined;
  const want = canonicalTerminalId(id);
  return client.subscribe((evt) => {
    if (evt.event !== "terminal.output") return;
    const p = evt.payload as { id?: string; terminalId?: string; data?: string } | undefined;
    const tid = p?.terminalId || p?.id;
    if (tid && typeof p?.data === "string" && canonicalTerminalId(tid) === want) onData(p.data);
  });
}
