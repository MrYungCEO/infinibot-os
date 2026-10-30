/**
 * Chat panels — shared types for agent-invokable UI panels.
 *
 * A "panel" is a live, interactive card/modal an agent can answer with instead
 * of plain text (the agent mesh, a project, a task, an agent run, business
 * data …). Generalised from the OmniTrade `show_panel` system: one registry of
 * kinds, one resolver, one gateway RPC pair, one UI host.
 */

/** Injected RPC transport. Resolves to the RPC payload, or throws on error. */
export type PanelCaller = (method: string, params: Record<string, unknown>) => Promise<unknown>;

export type PanelQuery = Record<string, unknown>;

/** Where the full-page version of a panel lives in the control UI. */
export interface PanelLink {
  /** Control-UI tab id (see ui/src/ui/navigation.ts). */
  tab: string;
  /** Optional entity deep link (e.g. `/projects/<id>`), preferred over `tab`. */
  path?: string;
  /** Button label, e.g. "Open full map". */
  label: string;
  /** Special client-side action instead of a route hop (e.g. agent focus modal). */
  action?: "agent-focus";
  /** Params for `action`. */
  actionParams?: Record<string, unknown>;
}

/** What a kind's resolver returns (the registry fills in the rest). */
export interface PanelKindOutput {
  data: unknown;
  summary: string;
  count: number;
  empty: boolean;
  /** Optional title derived from the data (e.g. the project's name). */
  title?: string;
  /** Optional per-result link override (e.g. resolved entity id). */
  link?: PanelLink;
  /** Optional per-result live interval, ms (e.g. 0 once a tracked job is
   *  finished, so the card stops polling). Defaults to the kind's refreshMs. */
  refreshMs?: number;
}

export interface PanelKindDef {
  id: string;
  /** Default header title. */
  title: string;
  /** One-line description (fed into the agent tool description). */
  description: string;
  /** Query params the kind understands (documentation for the model). */
  queryHelp: string;
  /** Live re-query interval for the UI, ms (0 = manual refresh only). */
  refreshMs: number;
  /** Gateway RPCs this kind may call (the in-process caller allowlist). */
  methods: readonly string[];
  resolve(query: PanelQuery, call: PanelCaller): Promise<PanelKindOutput>;
  /** Plain-text/markdown rendering for non-UI channels (Telegram etc.). */
  toText(data: unknown): string;
  /** Deep link to the full page. */
  link(query: PanelQuery): PanelLink;
}

export interface PanelResult {
  kind: string;
  title: string;
  data: unknown;
  summary: string;
  count: number;
  empty: boolean;
  /** Real error reason from a backing RPC, or null. Never a generic string. */
  error: string | null;
  /** Markdown fallback for channels that cannot render UI. */
  text: string;
  link: PanelLink;
  refreshMs: number;
  fetchedAt: number;
}

export type PanelDisplay = "inline" | "modal";

/**
 * The reference a chat transcript carries (inside the show_panel tool result)
 * so every chat surface can render the panel inline — including on history
 * reload. Carries NO data: the card re-queries live via `chat.panel.refresh`.
 */
export interface ChatPanelRef {
  v: 1;
  panelId: string;
  kind: string;
  query: PanelQuery;
  title: string;
  display: PanelDisplay;
  summary: string;
  count: number;
  empty: boolean;
  error: string | null;
  link: PanelLink;
  refreshMs: number;
  ts: number;
}
