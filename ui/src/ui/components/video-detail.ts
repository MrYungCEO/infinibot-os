/**
 * <ib-video-detail> — video analysis for one video file: player (360p proxy,
 * served by RPC in both lanes), a timeline of keyframes and findings (click
 * to seek), the analyst picker (Archaeologist & co. or any agent), and tabs
 * for the overview, the transcript and one tab per agent analysis with
 * "look again" follow-ups.
 *
 * `compact` renders a short card for narrow panes (Files preview) with an
 * "Open video analysis" button; openVideoDetailDialog() shows the full view
 * (full-screen on phones).
 */
import { LitElement, css, html, nothing, svg, type PropertyValues } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { icons } from "../icons";
import { OCR_WINDOW_EVENT, sha256OfBase64 } from "../file-ocr";
import {
  analysisColor,
  formatTimecode,
  parseTimecodeInput,
  type VideoAnalysisInfo,
  type VideoAnalystOption,
  type VideoGetResult,
} from "../video-analysis";

interface RequestClient {
  request<T = unknown>(method: string, params?: unknown): Promise<T>;
}

type Tab = "overview" | "transcript" | string;

const ANALYST_ICONS: Record<string, ReturnType<typeof svg>> = {
  trowel: svg`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 3.5 20.5 9.5 12 13l-1-1z"/><path d="m11 12-6.5 6.5"/><path d="M3.5 20.5 5 19"/><path d="M14.5 3.5 12 13"/></svg>`,
  whistle: svg`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="8.5" cy="14.5" r="5"/><path d="M12.5 11.5 21 8v4l-6.5 2"/><circle cx="8.5" cy="14.5" r="1.4"/><path d="M5 5.5 6.5 7M9 4v2M12.5 5.5 11 7"/></svg>`,
};

function analystIcon(key: string) {
  if (ANALYST_ICONS[key]) return ANALYST_ICONS[key];
  const map: Record<string, keyof typeof icons> = {
    shield: "shield",
    scissors: "scissors",
    eye: "eye",
    bot: "bot",
  };
  return icons[map[key] ?? "bot"];
}

const styles = css`
  :host {
    display: block;
    color: var(--wg-fg, #e9e6df);
    font-size: 12.5px;
    --vd-gold: var(--wg-gold, #d9b45a);
    --vd-stroke: var(--glass-stroke, rgba(255, 255, 255, 0.1));
    --vd-well: color-mix(in srgb, var(--glass-base, #14161c) 62%, transparent);
    --vd-fg2: var(--wg-fg-2, #c9c5bb);
    --vd-fg3: var(--wg-fg-3, #9a968c);
  }
  * { box-sizing: border-box; }
  svg { width: 14px; height: 14px; flex: none; }
  button { font: inherit; }
  .vd { display: grid; gap: 14px; }
  .head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .eyebrow {
    display: inline-flex; align-items: center; gap: 6px; font-size: 11px; letter-spacing: 0.08em;
    text-transform: uppercase; color: var(--vd-fg3);
  }
  .eyebrow svg { color: var(--vd-gold); }
  .sp { flex: 1; }
  .badge {
    display: inline-flex; align-items: center; gap: 5px; height: 22px; padding: 0 9px; border-radius: 999px;
    font-size: 11px; font-weight: 600; border: 1px solid var(--vd-stroke); background: rgba(255, 255, 255, 0.04);
    color: var(--vd-fg2); white-space: nowrap;
  }
  .badge svg { width: 12px; height: 12px; }
  .badge[data-s="done"] { color: #8fdcaa; border-color: rgba(120, 210, 150, 0.35); background: rgba(80, 190, 120, 0.1); }
  .badge[data-s="failed"] { color: #ff9a8a; border-color: rgba(255, 120, 100, 0.35); background: rgba(255, 110, 90, 0.1); }
  .badge[data-s="queued"], .badge[data-s="running"], .badge[data-s="processing"] {
    color: var(--vd-gold); border-color: color-mix(in srgb, var(--vd-gold) 40%, transparent);
    background: color-mix(in srgb, var(--vd-gold) 10%, transparent);
  }
  .badge[data-s="running"] svg, .badge[data-s="processing"] svg, .spin { animation: spin 1.1s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .grid { display: grid; grid-template-columns: minmax(0, 1.05fr) minmax(0, 1fr); gap: 16px; align-items: start; }
  .col { display: grid; gap: 12px; min-width: 0; }
  .card {
    border-radius: 14px; border: 1px solid var(--vd-stroke); background: var(--vd-well); padding: 12px;
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.03);
  }
  .player { position: relative; border-radius: 12px; overflow: hidden; background: #050608; aspect-ratio: 16 / 9; display: grid; place-items: center; }
  .player video { width: 100%; height: 100%; display: block; background: #000; object-fit: contain; }
  .player .ph { color: var(--vd-fg3); display: grid; justify-items: center; gap: 8px; font-size: 12px; text-align: center; padding: 12px; }
  .player .ph svg { width: 28px; height: 28px; color: var(--vd-gold); opacity: 0.8; }
  .tl { margin-top: 10px; display: grid; gap: 6px; }
  .tl-track {
    position: relative; height: 34px; border-radius: 9px; cursor: pointer;
    background: linear-gradient(180deg, rgba(255, 255, 255, 0.05), rgba(255, 255, 255, 0.02));
    border: 1px solid var(--vd-stroke); overflow: hidden;
  }
  .tl-tick { position: absolute; top: 6px; bottom: 6px; width: 1px; background: rgba(255, 255, 255, 0.16); }
  .tl-dot {
    position: absolute; top: 50%; width: 12px; height: 12px; margin: -6px 0 0 -6px; border-radius: 50%;
    border: 2px solid rgba(8, 9, 12, 0.9); box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.25), 0 0 10px currentColor;
    background: currentColor; padding: 0; cursor: pointer;
  }
  .tl-dot:hover, .tl-dot:focus-visible { transform: scale(1.35); outline: none; }
  .tl-head { position: absolute; top: 0; bottom: 0; width: 2px; background: var(--vd-gold); box-shadow: 0 0 8px var(--vd-gold); pointer-events: none; }
  .tl-legend { display: flex; flex-wrap: wrap; gap: 4px 12px; color: var(--vd-fg3); font-size: 11px; }
  .tl-legend i { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 5px; vertical-align: 0; }
  .tl-scale { display: flex; justify-content: space-between; color: var(--vd-fg3); font-size: 10.5px; font-variant-numeric: tabular-nums; }
  .meta { display: flex; flex-wrap: wrap; gap: 6px 14px; color: var(--vd-fg3); font-size: 11.5px; }
  .meta b { color: var(--vd-fg2); font-weight: 600; }
  .progress { height: 4px; border-radius: 99px; background: rgba(255, 255, 255, 0.07); overflow: hidden; }
  .progress > div { height: 100%; background: linear-gradient(90deg, var(--vd-gold), #f3dc9b); transition: width 0.4s ease; }
  .section-title { display: flex; align-items: center; gap: 6px; font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--vd-fg3); margin: 0 0 8px; }
  .section-title svg { color: var(--vd-gold); }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; }
  .chip {
    all: unset; cursor: pointer; display: inline-flex; align-items: center; gap: 7px; min-height: 32px; padding: 4px 11px 4px 8px;
    border-radius: 10px; border: 1px solid var(--vd-stroke); background: rgba(255, 255, 255, 0.03); color: var(--vd-fg2);
    font-size: 12px; max-width: 100%;
  }
  .chip .ic { width: 22px; height: 22px; border-radius: 7px; display: grid; place-items: center; background: rgba(255, 255, 255, 0.05); color: var(--vd-gold); flex: none; }
  .chip .ic svg { width: 14px; height: 14px; }
  .chip .lbl { display: grid; line-height: 1.2; min-width: 0; }
  .chip .lbl small { color: var(--vd-fg3); font-size: 10.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 220px; }
  .chip[aria-pressed="true"] {
    color: #fff; border-color: color-mix(in srgb, var(--vd-gold) 60%, transparent);
    background: color-mix(in srgb, var(--vd-gold) 14%, transparent); box-shadow: 0 0 0 1px color-mix(in srgb, var(--vd-gold) 30%, transparent) inset;
  }
  .chip[aria-pressed="true"] .ic { background: var(--vd-gold); color: #17140c; }
  .chip:focus-visible, .btn:focus-visible, .tabs button:focus-visible { outline: 2px solid var(--vd-gold); outline-offset: 1px; }
  .btn {
    all: unset; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; gap: 6px; height: 32px; padding: 0 12px;
    border-radius: 9px; border: 1px solid var(--vd-stroke); background: rgba(255, 255, 255, 0.04); color: var(--vd-fg2); font-size: 12px; font-weight: 600;
    white-space: nowrap;
  }
  .btn:hover { background: rgba(255, 255, 255, 0.08); color: #fff; }
  .btn.primary { background: linear-gradient(180deg, #e9c66f, #c99b3a); color: #17140c; border-color: rgba(255, 220, 140, 0.5); }
  .btn.primary:hover { filter: brightness(1.06); }
  .btn.ghost { background: transparent; }
  .btn[disabled] { opacity: 0.45; pointer-events: none; }
  .row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  input[type="text"], textarea {
    width: 100%; min-height: 34px; padding: 8px 10px; border-radius: 9px; border: 1px solid var(--vd-stroke);
    background: rgba(0, 0, 0, 0.22); color: var(--wg-fg, #eee); font: inherit; font-size: 12.5px; resize: vertical;
  }
  input:focus, textarea:focus { outline: none; border-color: color-mix(in srgb, var(--vd-gold) 60%, transparent); }
  .tabs { display: flex; gap: 2px; padding: 3px; border-radius: 11px; border: 1px solid var(--vd-stroke); background: rgba(0, 0, 0, 0.18); overflow-x: auto; scrollbar-width: none; }
  .tabs::-webkit-scrollbar { display: none; }
  .tabs button {
    all: unset; cursor: pointer; padding: 6px 10px; border-radius: 8px; font-size: 12px; color: var(--vd-fg3);
    display: inline-flex; gap: 6px; align-items: center; white-space: nowrap; flex: none;
  }
  .tabs button[aria-selected="true"] { color: var(--wg-fg, #eee); background: rgba(255, 255, 255, 0.08); box-shadow: inset 0 0 0 1px var(--vd-stroke); }
  .tabs .dot { width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
  .pane { max-height: var(--vd-pane-h, 62vh); overflow: auto; display: grid; gap: 12px; align-content: start; padding-right: 2px; }
  .prose { white-space: pre-wrap; line-height: 1.55; color: var(--vd-fg2); }
  .sheet { width: 100%; border-radius: 10px; border: 1px solid var(--vd-stroke); display: block; }
  .seg { display: grid; grid-template-columns: auto 1fr; gap: 10px; align-items: baseline; padding: 6px 8px; border-radius: 8px; cursor: pointer; }
  .seg:hover { background: rgba(255, 255, 255, 0.04); }
  .seg[data-active="true"] { background: color-mix(in srgb, var(--vd-gold) 10%, transparent); box-shadow: inset 2px 0 0 var(--vd-gold); }
  .tc {
    all: unset; cursor: pointer; font-variant-numeric: tabular-nums; font-size: 11px; font-weight: 600; color: var(--vd-gold);
    padding: 2px 6px; border-radius: 6px; background: color-mix(in srgb, var(--vd-gold) 10%, transparent); white-space: nowrap;
  }
  .seg .txt { color: var(--vd-fg2); line-height: 1.5; }
  .seg .txt em { color: var(--vd-fg3); font-style: normal; font-size: 11px; margin-right: 4px; }
  .moments { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 10px; }
  .moment { all: unset; cursor: pointer; display: grid; gap: 6px; border-radius: 11px; border: 1px solid var(--vd-stroke); background: rgba(255, 255, 255, 0.02); overflow: hidden; }
  .moment:hover, .moment:focus-visible { border-color: color-mix(in srgb, var(--vd-gold) 50%, transparent); outline: none; }
  .moment .thumb { aspect-ratio: 16 / 9; background: #07080a center / cover no-repeat; position: relative; }
  .moment .thumb .tc { position: absolute; left: 6px; bottom: 6px; background: rgba(8, 9, 12, 0.82); }
  .moment .body { padding: 0 9px 9px; display: grid; gap: 3px; }
  .moment b { font-size: 12px; color: var(--wg-fg, #eee); font-weight: 600; }
  .moment span { font-size: 11.5px; color: var(--vd-fg3); line-height: 1.4; }
  .ent { display: inline-flex; align-items: center; gap: 6px; padding: 4px 9px; border-radius: 8px; border: 1px solid var(--vd-stroke); background: rgba(255, 255, 255, 0.03); font-size: 12px; color: var(--vd-fg2); }
  .ent small { color: var(--vd-fg3); font-size: 10.5px; }
  ul.list { margin: 0; padding: 0; list-style: none; display: grid; gap: 6px; }
  ul.list li { display: flex; gap: 8px; align-items: baseline; color: var(--vd-fg2); line-height: 1.5; }
  ul.list li::before { content: ""; width: 5px; height: 5px; border-radius: 50%; background: var(--vd-gold); flex: none; transform: translateY(-2px); }
  ul.list.q li::before { background: #8fb7ff; }
  .conf { display: flex; align-items: center; gap: 8px; color: var(--vd-fg3); font-size: 11.5px; }
  .conf .bar { width: 120px; height: 5px; border-radius: 99px; background: rgba(255, 255, 255, 0.08); overflow: hidden; }
  .conf .bar > div { height: 100%; background: linear-gradient(90deg, #c99b3a, #8fdcaa); }
  .fu { display: grid; gap: 8px; padding: 10px; border-radius: 11px; border: 1px solid var(--vd-stroke); background: rgba(255, 255, 255, 0.02); }
  .fu .q { color: var(--wg-fg, #eee); font-weight: 600; display: flex; gap: 6px; align-items: flex-start; }
  .fu .a { color: var(--vd-fg2); white-space: pre-wrap; line-height: 1.5; }
  .fu .frames { display: flex; gap: 6px; overflow-x: auto; }
  .fu .frames button { all: unset; cursor: pointer; width: 92px; flex: none; aspect-ratio: 16 / 9; border-radius: 7px; background: #07080a center / cover no-repeat; border: 1px solid var(--vd-stroke); position: relative; }
  .fu .frames .tc { position: absolute; left: 3px; bottom: 3px; font-size: 10px; background: rgba(8, 9, 12, 0.82); }
  .empty { color: var(--vd-fg3); }
  .err { color: #ff9a8a; font-size: 12px; }
  .warn { color: var(--vd-fg3); font-size: 11.5px; }
  .ask-row { display: flex; gap: 8px; }
  .ask-row input { flex: 1; }
  .skel { height: 10px; border-radius: 6px; margin: 6px 0; background: linear-gradient(90deg, rgba(255,255,255,0.04), rgba(255,255,255,0.09), rgba(255,255,255,0.04)); background-size: 200% 100%; animation: sh 1.4s infinite; }
  @keyframes sh { to { background-position: -200% 0; } }
  .compact { display: grid; gap: 10px; }
  .compact .player { aspect-ratio: 16 / 9; }
  .mini-analyses { display: grid; gap: 6px; }
  .mini { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--vd-fg2); }
  .mini i { width: 8px; height: 8px; border-radius: 50%; flex: none; }
  .mini span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  @media (max-width: 860px) {
    .grid { grid-template-columns: minmax(0, 1fr); }
    .pane { max-height: none; }
  }
  @media (max-width: 520px) {
    .moments { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .chip .lbl small { max-width: 240px; }
    .chips .chip { flex: 1 1 100%; }
    .btn { height: 36px; }
    .chip { min-height: 38px; }
    .tl-track { height: 40px; }
    .tl-dot { width: 16px; height: 16px; margin: -8px 0 0 -8px; }
  }
`;

@customElement("ib-video-detail")
export class VideoDetail extends LitElement {
  static styles = styles;

  @property({ attribute: false }) client: RequestClient | null = null;
  @property() fileId: string | null = null;
  @property() filePath: string | null = null;
  @property() sha256: string | null = null;
  @property() fileName: string | null = null;
  @property({ type: Boolean }) secure = false;
  @property({ type: Boolean }) compact = false;
  /** Preselect these analysts (chat attachment flow). */
  @property({ attribute: false }) preselect: string[] = [];

  @state() private data: VideoGetResult | null = null;
  @state() private loading = false;
  @state() private error: string | null = null;
  @state() private tab: Tab = "overview";
  @state() private analysts: VideoAnalystOption[] = [];
  @state() private selected = new Set<string>();
  @state() private showAllAgents = false;
  @state() private instructions = "";
  @state() private submitting = false;
  @state() private creating = false;
  @state() private newName = "";
  @state() private newFocus = "";
  @state() private question = "";
  @state() private asking = false;
  @state() private videoUrl: string | null = null;
  @state() private mediaState: "idle" | "loading" | "ready" | "none" = "idle";
  @state() private currentTime = 0;
  @state() private frames = new Map<string, string>();

  private seq = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private frameLoads = new Set<string>();

  private onOcrEvent = () => void this.load(true);

  connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener(OCR_WINDOW_EVENT, this.onOcrEvent);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    window.removeEventListener(OCR_WINDOW_EVENT, this.onOcrEvent);
    if (this.timer) clearTimeout(this.timer);
    if (this.videoUrl) URL.revokeObjectURL(this.videoUrl);
  }

  protected willUpdate(changed: PropertyValues<this>): void {
    if (changed.has("preselect") && this.preselect.length) this.selected = new Set(this.preselect);
    if (changed.has("fileId") || changed.has("filePath") || changed.has("sha256") || changed.has("secure") || changed.has("client")) {
      if (changed.has("fileId") || changed.has("filePath") || changed.has("sha256")) {
        this.data = null;
        this.tab = "overview";
        this.frames = new Map();
        this.frameLoads.clear();
        if (this.videoUrl) URL.revokeObjectURL(this.videoUrl);
        this.videoUrl = null;
        this.mediaState = "idle";
      }
      void this.load();
      if (!this.compact) void this.loadAnalysts();
    }
  }

  private ref(): Record<string, unknown> {
    const base = this.fileId
      ? { id: this.fileId }
      : this.filePath
        ? { path: this.filePath }
        : this.sha256
          ? { sha256: this.sha256 }
          : {};
    return this.secure ? { ...base, secure: true } : base;
  }

  /** Stable id-based ref once the entry is known. */
  private idRef(): Record<string, unknown> {
    const id = this.data?.entry?.id;
    return id ? { id, ...(this.secure ? { secure: true } : {}) } : this.ref();
  }

  private busy(d: VideoGetResult | null): boolean {
    if (!d?.found) return false;
    const st = d.entry?.status;
    if (st === "queued" || st === "processing") return true;
    if ((d.jobs ?? []).some((j) => j.status === "queued" || j.status === "running")) return true;
    return (d.analyses ?? []).some(
      (a) =>
        a.data?.status === "queued" ||
        a.data?.status === "running" ||
        (a.data?.followUps ?? []).some((f) => f.status === "queued" || f.status === "running"),
    );
  }

  async load(quiet = false): Promise<void> {
    const client = this.client;
    const ref = this.data?.entry?.id ? this.idRef() : this.ref();
    if (!client || Object.keys(ref).filter((k) => k !== "secure").length === 0) return;
    const seq = ++this.seq;
    if (!quiet && !this.data) this.loading = true;
    try {
      const res = await client.request<VideoGetResult>("files.video.get", ref);
      if (seq !== this.seq) return;
      this.error = null;
      this.data = res;
      if (res?.found && res.video?.proxy && this.mediaState === "idle") void this.loadMedia();
      if (res?.found && this.tab.startsWith("a:") && !res.analyses?.some((a) => `a:${a.id}` === this.tab)) this.tab = "overview";
    } catch (err) {
      if (seq === this.seq) this.error = err instanceof Error ? err.message : String(err);
    } finally {
      if (seq === this.seq) this.loading = false;
    }
    if (this.timer) clearTimeout(this.timer);
    if (this.isConnected && this.busy(this.data)) {
      this.timer = setTimeout(() => void this.load(true), 3000);
    }
  }

  private async loadAnalysts() {
    if (!this.client) return;
    try {
      const res = await this.client.request<{ analysts: VideoAnalystOption[] }>("files.video.analysts", {});
      this.analysts = res?.analysts ?? [];
    } catch {
      this.analysts = [];
    }
  }

  private async loadMedia() {
    if (!this.client || this.mediaState !== "idle") return;
    this.mediaState = "loading";
    try {
      const parts: BlobPart[] = [];
      let offset = 0;
      for (let i = 0; i < 400; i++) {
        const r = await this.client.request<{ found: boolean; content?: string; done?: boolean; size?: number }>(
          "files.video.media",
          { ...this.idRef(), offset },
        );
        if (!r?.found || !r.content) break;
        const bin = Uint8Array.from(atob(r.content), (c) => c.charCodeAt(0));
        parts.push(bin);
        offset += bin.length;
        if (r.done) break;
      }
      if (!parts.length) {
        this.mediaState = "none";
        return;
      }
      if (this.videoUrl) URL.revokeObjectURL(this.videoUrl);
      this.videoUrl = URL.createObjectURL(new Blob(parts, { type: "video/mp4" }));
      this.mediaState = "ready";
    } catch {
      this.mediaState = "none";
    }
  }

  private frameUrl(name: string | undefined): string | null {
    if (!name) return null;
    const hit = this.frames.get(name);
    if (hit) return hit;
    if (!this.frameLoads.has(name) && this.client && this.data?.entry?.id) {
      this.frameLoads.add(name);
      void this.client
        .request<{ found: boolean; mime?: string; content?: string }>("files.video.frame", { ...this.idRef(), frame: name })
        .then((r) => {
          if (r?.found && r.content) {
            const next = new Map(this.frames);
            next.set(name, `data:${r.mime ?? "image/jpeg"};base64,${r.content}`);
            this.frames = next;
          }
        })
        .catch(() => {});
    }
    return null;
  }

  private get videoEl(): HTMLVideoElement | null {
    return this.renderRoot.querySelector("video");
  }

  seek(t: number) {
    const v = this.videoEl;
    this.currentTime = t;
    if (v) {
      v.currentTime = Math.max(0, t);
      void v.play().catch(() => {});
    } else if (this.compact) {
      this.openFull();
    }
  }

  private toggle(id: string) {
    const next = new Set(this.selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    this.selected = next;
  }

  private async analyze() {
    if (!this.client || !this.selected.size) return;
    this.submitting = true;
    this.error = null;
    try {
      const res = await this.client.request<{ analyses: Array<{ analysisId: string }> }>("files.video.analyze", {
        ...this.idRef(),
        agentIds: [...this.selected],
        ...(this.instructions.trim() ? { instructions: this.instructions.trim() } : {}),
      });
      this.selected = new Set();
      this.instructions = "";
      await this.load(true);
      const first = res?.analyses?.[0]?.analysisId;
      if (first) this.tab = `a:${first}`;
      void this.loadAnalysts();
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
    } finally {
      this.submitting = false;
    }
  }

  private async createAnalyst(e: Event) {
    e.preventDefault();
    if (!this.client || !this.newName.trim() || !this.newFocus.trim()) return;
    try {
      const r = await this.client.request<{ agentId: string }>("files.video.analysts.create", {
        name: this.newName.trim(),
        focus: this.newFocus.trim(),
      });
      this.creating = false;
      this.newName = "";
      this.newFocus = "";
      await this.loadAnalysts();
      if (r?.agentId) this.selected = new Set([...this.selected, r.agentId]);
      this.showAllAgents = true;
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
    }
  }

  private async ask(e: Event, a: VideoAnalysisInfo) {
    e.preventDefault();
    if (!this.client || !this.question.trim()) return;
    this.asking = true;
    try {
      const times = parseTimecodeInput(this.question);
      await this.client.request("files.video.ask", {
        ...this.idRef(),
        analysisId: a.id,
        question: this.question.trim(),
        ...(times.length ? { times } : {}),
      });
      this.question = "";
      await this.load(true);
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
    } finally {
      this.asking = false;
    }
  }

  private async processNow() {
    if (!this.client) return;
    try {
      await this.client.request("files.video.process", { ...this.ref(), force: true });
      await this.load(true);
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
    }
  }

  private openFull() {
    openVideoDetailDialog({
      client: this.client!,
      fileId: this.data?.entry?.id ?? this.fileId,
      filePath: this.filePath,
      sha256: this.sha256,
      fileName: this.data?.entry?.name ?? this.fileName,
      secure: this.secure,
    });
  }

  // ── render pieces ──────────────────────────────────────────────────

  private statusBadge() {
    const e = this.data?.entry;
    if (!e) return nothing;
    const p = e.progress;
    const label =
      e.status === "done"
        ? "Processed"
        : e.status === "failed"
          ? "Failed"
          : e.status === "processing"
            ? p?.total
              ? `Processing ${Math.min(p.done, p.total)}/${p.total}`
              : "Processing"
            : "Queued";
    const ic = e.status === "done" ? icons.checkCircle : e.status === "failed" ? icons.alertCircle : e.status === "processing" ? icons.loader : icons.clock;
    return html`<span class="badge" data-s=${e.status}>${ic}${label}</span>`;
  }

  private renderPlayer() {
    const v = this.data?.video;
    return html`<div class="player">
      ${this.videoUrl
        ? html`<video
            src=${this.videoUrl}
            poster=${this.frameUrl(v?.keyframes?.[1]?.id ?? v?.keyframes?.[0]?.id) ?? ""}
            controls
            playsinline
            preload="metadata"
            @timeupdate=${(ev: Event) => (this.currentTime = (ev.target as HTMLVideoElement).currentTime)}
          ></video>`
        : html`<div class="ph">
            ${this.mediaState === "loading" ? html`<span class="spin">${icons.loader}</span>Loading player…` : html`${icons.filmStrip}${v ? (v.proxy ? "Preparing player…" : "Player available once processing finishes") : "Processing video locally…"}`}
          </div>`}
    </div>`;
  }

  private renderTimeline() {
    const v = this.data?.video;
    const dur = v?.meta?.duration ?? 0;
    if (!v || !dur) return nothing;
    const analyses = this.data?.analyses ?? [];
    // Inset 8px each side so markers at 00:00 / the end are not clipped by the track edge.
    const pct = (t: number) => `calc(8px + (100% - 16px) * ${Math.min(1, Math.max(0, t / dur))})`;
    const onTrack = (ev: MouseEvent) => {
      const el = ev.currentTarget as HTMLElement;
      const r = el.getBoundingClientRect();
      this.seek(Math.min(1, Math.max(0, (ev.clientX - r.left - 8) / Math.max(1, r.width - 16))) * dur);
    };
    return html`<div class="tl" data-testid="video-timeline">
      <div class="tl-track" @click=${onTrack} role="slider" aria-label="Video timeline" aria-valuemin="0" aria-valuemax=${dur} aria-valuenow=${this.currentTime}>
        ${v.keyframes.map((k) => html`<span class="tl-tick" style="left:${pct(k.t)}"></span>`)}
        ${analyses.flatMap((a, i) =>
          (a.data?.moments ?? []).map(
            (m) => html`<button
              class="tl-dot"
              style="left:${pct(m.t)};color:${analysisColor(i)}"
              title="${formatTimecode(m.t)} · ${a.data?.agentName ?? a.agentId}: ${m.label}"
              aria-label="${formatTimecode(m.t)} ${m.label}"
              @click=${(ev: Event) => {
                ev.stopPropagation();
                this.tab = `a:${a.id}`;
                this.seek(m.t);
              }}
            ></button>`,
          ),
        )}
        <span class="tl-head" style="left:${pct(this.currentTime)}"></span>
      </div>
      <div class="tl-scale"><span>00:00</span><span>${formatTimecode(dur / 2)}</span><span>${formatTimecode(dur)}</span></div>
      ${analyses.length
        ? html`<div class="tl-legend">${analyses.map((a, i) => html`<span><i style="background:${analysisColor(i)}"></i>${a.data?.agentName ?? a.agentId}</span>`)}<span><i style="background:rgba(255,255,255,.3);border-radius:1px;width:2px"></i>Keyframes</span></div>`
        : nothing}
    </div>`;
  }

  private renderMeta() {
    const v = this.data?.video;
    const e = this.data?.entry;
    if (!e) return nothing;
    const p = e.progress;
    return html`
      ${e.status === "processing" && p?.total
        ? html`<div class="progress" aria-label="Processing progress"><div style="width:${Math.round((p.done / p.total) * 100)}%"></div></div>`
        : nothing}
      <div class="meta">
        ${v ? html`<span>Length <b>${formatTimecode(v.meta.duration)}</b></span>
          <span>Size <b>${v.meta.width}×${v.meta.height}</b></span>
          <span>Keyframes <b>${v.keyframes.length}</b></span>
          <span>Chunks <b>${v.chunks.filter((c) => c.done).length}/${v.chunks.length}</b></span>
          <span title=${v.transcript.model ?? ""}>Speech <b>${v.transcript.engine ? `Whisper (local)${v.transcript.language ? ` · ${v.transcript.language}` : ""}` : v.meta.hasAudio ? "—" : "no audio"}</b></span>` : nothing}
        <span>Models <b>local only</b></span>
      </div>
      ${e.status === "failed" && e.error ? html`<div class="err" role="alert">${e.error}</div>` : nothing}`;
  }

  private renderPicker() {
    const opts = this.analysts;
    const templates = opts.filter((o) => o.kind === "template");
    const others = opts.filter((o) => o.kind === "agent");
    const chip = (o: VideoAnalystOption) => html`<button
      class="chip"
      aria-pressed=${this.selected.has(o.agentId)}
      title=${o.tagline}
      data-agent=${o.agentId}
      @click=${() => this.toggle(o.agentId)}
    >
      <span class="ic">${analystIcon(o.icon)}</span>
      <span class="lbl">${titleCase(o.name)}<small>${o.tagline}</small></span>
    </button>`;
    return html`<div class="card" data-testid="analyst-picker">
      <div class="section-title">${icons.users}Analyze with</div>
      <div class="chips">${templates.map(chip)}${this.showAllAgents ? others.map(chip) : nothing}</div>
      <div class="row" style="margin-top:8px">
        ${others.length
          ? html`<button class="btn ghost" @click=${() => (this.showAllAgents = !this.showAllAgents)}>${this.showAllAgents ? icons.chevronUp : icons.chevronDown}${this.showAllAgents ? "Fewer agents" : `All agents (${others.length})`}</button>`
          : nothing}
        <button class="btn ghost" @click=${() => (this.creating = !this.creating)}>${icons.personPlus}New analyst</button>
      </div>
      ${this.creating
        ? html`<form class="col" style="margin-top:8px" @submit=${this.createAnalyst} data-testid="new-analyst">
            <input type="text" placeholder="Name, e.g. Geologist" aria-label="Analyst name" .value=${this.newName} @input=${(e: Event) => (this.newName = (e.target as HTMLInputElement).value)} />
            <textarea rows="2" placeholder="What should they look for? One focus per line or separated by ;" aria-label="Analyst focus" .value=${this.newFocus} @input=${(e: Event) => (this.newFocus = (e.target as HTMLTextAreaElement).value)}></textarea>
            <div class="row"><span class="sp"></span><button class="btn primary" type="submit" ?disabled=${!this.newName.trim() || !this.newFocus.trim()}>${icons.plus}Create analyst</button></div>
          </form>`
        : nothing}
      <div class="col" style="margin-top:10px">
        <input type="text" placeholder="Optional focus for this run, e.g. date the coin" aria-label="Instructions for the analysts" .value=${this.instructions} @input=${(e: Event) => (this.instructions = (e.target as HTMLInputElement).value)} />
        <div class="row">
          <span class="warn">${this.selected.size ? `${this.selected.size} selected · runs on the local vision model` : "Pick one or more analysts"}</span>
          <span class="sp"></span>
          <button class="btn primary" data-testid="run-analysis" ?disabled=${!this.selected.size || this.submitting || !this.data?.found} @click=${this.analyze}>${this.submitting ? icons.loader : icons.sparkles}Analyze</button>
        </div>
      </div>
    </div>`;
  }

  private renderTabs() {
    const analyses = this.data?.analyses ?? [];
    return html`<div class="tabs" role="tablist" aria-label="Video analysis views">
      <button role="tab" aria-selected=${this.tab === "overview"} @click=${() => (this.tab = "overview")}>${icons.eye}Overview</button>
      <button role="tab" aria-selected=${this.tab === "transcript"} @click=${() => (this.tab = "transcript")}>${icons.scrollText}Transcript</button>
      ${analyses.map(
        (a, i) => html`<button role="tab" data-analysis=${a.agentId ?? ""} aria-selected=${this.tab === `a:${a.id}`} @click=${() => (this.tab = `a:${a.id}`)}>
          <span class="dot" style="color:${analysisColor(i)}"></span>${titleCase(a.data?.agentName ?? a.agentId ?? "Analysis")}
          ${a.data?.status === "running" || a.data?.status === "queued" ? html`<span class="spin">${icons.loader}</span>` : nothing}
        </button>`,
      )}
    </div>`;
  }

  private renderOverview() {
    const d = this.data!;
    const v = d.video;
    const sheet = v?.contactSheet ? this.frameUrl(v.contactSheet.id) : null;
    return html`<div class="pane">
      ${d.description
        ? html`<div><div class="section-title">${icons.sparkles}Local vision summary</div><div class="prose">${d.description.replace(/^##\s*/gm, "").trim()}</div></div>`
        : html`<div class="empty">${d.entry?.status === "done" ? "No vision summary for this video." : "The local pipeline is sampling keyframes, transcribing and reading on-screen text…"}</div>`}
      ${v?.contactSheet
        ? html`<div><div class="section-title">${icons.gallery}Contact sheet</div>${sheet ? html`<img class="sheet" src=${sheet} alt="Contact sheet of keyframes" />` : html`<div class="skel" style="height:120px"></div>`}</div>`
        : nothing}
      ${(d.warnings ?? []).length ? html`<div class="warn">${d.warnings.join(" · ")}</div>` : nothing}
    </div>`;
  }

  private renderTranscript() {
    const v = this.data?.video;
    const segs = v?.transcript?.segments ?? [];
    const onScreen = (v?.keyframes ?? []).filter((k) => k.ocr?.text);
    const active = segs.findIndex((s, i) => this.currentTime >= s.start && (i === segs.length - 1 || this.currentTime < segs[i + 1].start));
    return html`<div class="pane" data-testid="video-transcript">
      ${segs.length
        ? segs.map(
            (s, i) => html`<div class="seg" data-active=${i === active} @click=${() => this.seek(s.start)}>
              <span class="tc">${formatTimecode(s.start)}</span><span class="txt">${s.text}</span>
            </div>`,
          )
        : html`<div class="empty">${v?.meta?.hasAudio === false ? "This video has no audio track." : "No speech transcribed yet."}</div>`}
      ${onScreen.length
        ? html`<div class="section-title" style="margin-top:6px">${icons.fileText}On-screen text</div>
            ${onScreen.map(
              (k) => html`<div class="seg" @click=${() => this.seek(k.t)}><span class="tc">${formatTimecode(k.t)}</span><span class="txt"><em>OCR</em>${k.ocr!.text}</span></div>`,
            )}`
        : nothing}
    </div>`;
  }

  private renderAnalysis(a: VideoAnalysisInfo) {
    const d = a.data;
    const st = d?.status ?? "queued";
    if (st === "queued" || st === "running") {
      return html`<div class="pane">
        <div class="row"><span class="badge" data-s=${st}>${icons.loader}${st === "queued" ? "Queued" : "Analyzing"}</span><span class="warn">${d?.agentName ?? a.agentId} is looking at the keyframes and transcript on the local vision model…</span></div>
        ${[90, 70, 84, 60].map((w) => html`<div class="skel" style="width:${w}%"></div>`)}
      </div>`;
    }
    if (st === "failed") {
      return html`<div class="pane"><div class="err" role="alert">${d?.error ?? "Analysis failed"}</div></div>`;
    }
    const conf = d?.confidence;
    return html`<div class="pane" data-testid="analysis-pane">
      <div class="row">
        <span class="badge" data-s="done">${icons.checkCircle}${titleCase(d?.agentName ?? a.agentId ?? "")}</span>
        ${conf != null ? html`<span class="conf">Confidence <span class="bar"><div style="width:${Math.round(conf * 100)}%"></div></span>${Math.round(conf * 100)}%</span>` : nothing}
        <span class="sp"></span>
        <span class="warn">${a.model ?? ""} · ${new Date(a.createdAt).toLocaleString()}</span>
      </div>
      <div><div class="section-title">${icons.fileText}Summary</div><div class="prose">${a.summary}</div></div>
      ${(d?.moments ?? []).length
        ? html`<div><div class="section-title">${icons.star}Notable moments</div><div class="moments">
            ${d!.moments!.map((m) => {
              const url = this.frameUrl(m.frameId);
              return html`<button class="moment" @click=${() => this.seek(m.t)} aria-label="Seek to ${formatTimecode(m.t)}: ${m.label}">
                <div class="thumb" style=${url ? `background-image:url(${url})` : ""}><span class="tc">${formatTimecode(m.t)}</span></div>
                <div class="body"><b>${m.label}</b>${m.detail ? html`<span>${m.detail}</span>` : nothing}</div>
              </button>`;
            })}</div></div>`
        : nothing}
      ${(d?.entities ?? []).length
        ? html`<div><div class="section-title">${icons.tag}Identified objects &amp; entities</div><div class="chips">
            ${d!.entities!.map(
              (e) => html`<span class="ent" title=${e.t != null ? `Seen at ${formatTimecode(e.t)}` : ""}>${e.name}${e.type ? html`<small>${e.type}</small>` : nothing}${e.confidence != null ? html`<small>${Math.round(e.confidence * 100)}%</small>` : nothing}${e.t != null ? html`<button class="tc" @click=${() => this.seek(e.t!)}>${formatTimecode(e.t)}</button>` : nothing}</span>`,
            )}</div></div>`
        : nothing}
      ${(d?.observations ?? []).length
        ? html`<div><div class="section-title">${icons.eye}Observations</div><ul class="list">
            ${d!.observations!.map((o) => html`<li>${o.t != null ? html`<button class="tc" @click=${() => this.seek(o.t!)}>${formatTimecode(o.t)}</button>` : nothing}<span>${o.text}</span></li>`)}
          </ul></div>`
        : nothing}
      ${(d?.openQuestions ?? []).length
        ? html`<div><div class="section-title">${icons.lightbulb}Open questions</div><ul class="list q">${d!.openQuestions!.map((q) => html`<li><span>${q}</span></li>`)}</ul></div>`
        : nothing}
      <div>
        <div class="section-title">${icons.messageSquare}Follow-ups</div>
        <div class="col">
          ${(d?.followUps ?? []).map(
            (f) => html`<div class="fu" data-testid="follow-up">
              <div class="q">${icons.search}<span>${f.question}</span></div>
              ${f.frames?.length
                ? html`<div class="frames">${f.frames.map((fr) => {
                    const url = this.frameUrl(fr.frameId);
                    return html`<button style=${url ? `background-image:url(${url})` : ""} @click=${() => this.seek(fr.t)} aria-label="Seek to ${formatTimecode(fr.t)}"><span class="tc">${formatTimecode(fr.t)}</span></button>`;
                  })}</div>`
                : nothing}
              ${f.status === "done"
                ? html`<div class="a">${f.answer}</div>`
                : f.status === "failed"
                  ? html`<div class="err">${f.error ?? "Follow-up failed"}</div>`
                  : html`<div class="row"><span class="badge" data-s="running">${icons.loader}Looking again${f.times?.length ? ` at ${f.times.map(formatTimecode).join(", ")}` : ""}…</span></div>`}
            </div>`,
          )}
          <form class="ask-row" @submit=${(e: Event) => this.ask(e, a)}>
            <input type="text" data-testid="follow-up-input" placeholder="Ask ${titleCase(d?.agentName ?? "the analyst")}… e.g. look at 01:23 — what is it?" aria-label="Follow-up question" .value=${this.question} @input=${(e: Event) => (this.question = (e.target as HTMLInputElement).value)} />
            <button class="btn primary" type="submit" ?disabled=${this.asking || !this.question.trim()}>${this.asking ? icons.loader : icons.send}Ask</button>
          </form>
        </div>
      </div>
    </div>`;
  }

  private renderTabBody() {
    if (this.tab === "transcript") return this.renderTranscript();
    if (this.tab.startsWith("a:")) {
      const a = this.data?.analyses?.find((x) => `a:${x.id}` === this.tab);
      if (a) return this.renderAnalysis(a);
    }
    return this.renderOverview();
  }

  private renderCompact() {
    const d = this.data;
    const analyses = d?.analyses ?? [];
    return html`<div class="compact" data-testid="video-compact">
      <div class="head">
        <span class="eyebrow">${icons.filmStrip}Video analysis</span>
        ${this.secure ? html`<span class="badge">${icons.lock}Secure lane</span>` : nothing}
        <span class="sp"></span>
        ${this.statusBadge()}
      </div>
      ${this.renderPlayer()}
      ${this.renderMeta()}
      ${analyses.length
        ? html`<div class="mini-analyses">${analyses.map(
            (a, i) => html`<div class="mini"><i style="background:${analysisColor(i)}"></i><b>${titleCase(a.data?.agentName ?? a.agentId ?? "")}</b><span>${a.data?.status === "done" ? a.summary : a.data?.status}</span></div>`,
          )}</div>`
        : nothing}
      <div class="row">
        ${d?.found
          ? html`<button class="btn primary" data-testid="open-video-analysis" @click=${() => this.openFull()}>${icons.maximize}Open video analysis</button>`
          : html`<button class="btn primary" @click=${this.processNow}>${icons.filmStrip}Process video</button>`}
      </div>
      ${this.error ? html`<div class="err">${this.error}</div>` : nothing}
    </div>`;
  }

  render() {
    if (this.compact) return this.renderCompact();
    const d = this.data;
    if (this.loading && !d) {
      return html`<div class="vd">${[70, 90, 60].map((w) => html`<div class="skel" style="width:${w}%"></div>`)}</div>`;
    }
    if (d && !d.found) {
      return html`<div class="vd"><div class="row"><span class="warn">This video has not been processed yet.</span><span class="sp"></span><button class="btn primary" @click=${this.processNow}>${icons.filmStrip}Process video</button></div>${this.error ? html`<div class="err">${this.error}</div>` : nothing}</div>`;
    }
    return html`<div class="vd" data-testid="video-detail">
      <div class="head">
        <span class="eyebrow">${icons.filmStrip}Video analysis</span>
        ${this.secure ? html`<span class="badge">${icons.lock}Secure lane · stays encrypted</span>` : nothing}
        <span class="sp"></span>
        ${this.statusBadge()}
      </div>
      <div class="grid">
        <div class="col">
          <div class="card">${this.renderPlayer()}${this.renderTimeline()}</div>
          ${this.renderMeta()}
          ${this.renderPicker()}
        </div>
        <div class="col">
          ${this.renderTabs()}
          ${d ? this.renderTabBody() : nothing}
        </div>
      </div>
      ${this.error ? html`<div class="err" role="alert">${this.error}</div>` : nothing}
    </div>`;
  }
}

function titleCase(s: string): string {
  if (!s) return s;
  return s === s.toUpperCase() ? s.toLowerCase().replace(/(^|[\s-])([a-z])/g, (_m, p, c) => `${p}${c.toUpperCase()}`) : s;
}

@customElement("ib-video-detail-dialog")
export class VideoDetailDialog extends LitElement {
  static styles = css`
    :host { position: fixed; inset: 0; z-index: 2000; display: grid; place-items: center; }
    .scrim { position: absolute; inset: 0; background: rgba(4, 5, 8, 0.62); backdrop-filter: blur(6px); }
    .card {
      box-sizing: border-box; position: relative; width: min(1220px, calc(100vw - 32px)); max-height: calc(100vh - 40px); overflow: auto;
      padding: 18px 20px 18px; border-radius: 20px; border: 1px solid var(--glass-stroke, rgba(255,255,255,0.12));
      background: var(--glass-sheen, none), color-mix(in srgb, var(--glass-base, #121419) 94%, transparent);
      box-shadow: 0 24px 80px rgba(0, 0, 0, 0.55), var(--glass-specular, none); color: var(--wg-fg, #eee);
    }
    header { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
    ib-video-detail { --vd-pane-h: calc(100vh - 210px); }
    h3 { margin: 0; font-size: 15px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
    button.x { all: unset; cursor: pointer; width: 34px; height: 34px; display: grid; place-items: center; border-radius: 9px; color: var(--wg-fg-3, #999); }
    button.x:hover { background: rgba(255, 255, 255, 0.08); color: #fff; }
    button.x svg { width: 16px; height: 16px; }
    @media (max-width: 640px) {
      :host { place-items: stretch; }
      .card { width: 100vw; max-height: 100dvh; height: 100dvh; border-radius: 0; padding: 12px 12px calc(16px + env(safe-area-inset-bottom)); }
    }
  `;

  @property({ attribute: false }) client: RequestClient | null = null;
  @property() fileId: string | null = null;
  @property() filePath: string | null = null;
  @property() sha256: string | null = null;
  @property() fileName: string | null = null;
  @property({ type: Boolean }) secure = false;
  @property({ attribute: false }) preselect: string[] = [];

  private onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") this.remove();
  };

  connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener("keydown", this.onKey);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    window.removeEventListener("keydown", this.onKey);
  }

  render() {
    return html`<div class="scrim" @click=${() => this.remove()}></div>
      <div class="card" role="dialog" aria-modal="true" aria-label="Video analysis">
        <header>
          <h3>${this.fileName || "Video"}</h3>
          <button class="x" aria-label="Close" @click=${() => this.remove()}>${icons.x}</button>
        </header>
        <ib-video-detail
          .client=${this.client}
          .fileId=${this.fileId}
          .filePath=${this.filePath}
          .sha256=${this.sha256}
          .fileName=${this.fileName}
          .secure=${this.secure}
          .preselect=${this.preselect}
        ></ib-video-detail>
      </div>`;
  }
}

export function openVideoDetailDialog(opts: {
  client: RequestClient;
  fileId?: string | null;
  filePath?: string | null;
  sha256?: string | null;
  fileName?: string | null;
  secure?: boolean;
  preselect?: string[];
}): VideoDetailDialog {
  document.querySelectorAll("ib-video-detail-dialog").forEach((d) => d.remove());
  const el = document.createElement("ib-video-detail-dialog") as VideoDetailDialog;
  el.client = opts.client;
  el.fileId = opts.fileId ?? null;
  el.filePath = opts.filePath ?? null;
  el.sha256 = opts.sha256 ?? null;
  el.fileName = opts.fileName ?? null;
  el.secure = Boolean(opts.secure);
  el.preselect = opts.preselect ?? [];
  document.body.appendChild(el);
  return el;
}

/**
 * <ib-video-attach-picker> — compact analyst chips on a chat video attachment.
 * Emits `analysts-change` with { detail: string[] }.
 */
@customElement("ib-video-attach-picker")
export class VideoAttachPicker extends LitElement {
  static styles = css`
    :host { display: block; --vd-gold: var(--wg-gold, #d9b45a); }
    .wrap { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; }
    .lbl { font-size: 10.5px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--wg-fg-3, #9a968c); margin-right: 2px; }
    button, select {
      all: unset; cursor: pointer; display: inline-flex; align-items: center; gap: 5px; height: 26px; padding: 0 8px;
      border-radius: 8px; font-size: 11.5px; color: var(--wg-fg-2, #c9c5bb);
      border: 1px solid var(--glass-stroke, rgba(255, 255, 255, 0.12)); background: rgba(255, 255, 255, 0.04);
    }
    select { padding-right: 6px; max-width: 140px; }
    button svg { width: 13px; height: 13px; color: var(--vd-gold); }
    button[aria-pressed="true"] { color: #fff; border-color: color-mix(in srgb, var(--vd-gold) 60%, transparent); background: color-mix(in srgb, var(--vd-gold) 16%, transparent); }
    button:focus-visible, select:focus-visible { outline: 2px solid var(--vd-gold); outline-offset: 1px; }
  `;
  @property({ attribute: false }) client: RequestClient | null = null;
  @property({ attribute: false }) selected: string[] = [];
  @state() private options: VideoAnalystOption[] = [];

  private loadedFor: RequestClient | null = null;

  protected willUpdate(changed: PropertyValues<this>): void {
    // The client often arrives after the element upgrades (lazy import in the composer).
    if (changed.has("client") && this.client && this.loadedFor !== this.client) {
      this.loadedFor = this.client;
      void this.client
        .request<{ analysts: VideoAnalystOption[] }>("files.video.analysts", {})
        .then((r) => (this.options = r?.analysts ?? []))
        .catch(() => {});
    }
  }

  private emit(next: string[]) {
    this.selected = next;
    this.dispatchEvent(new CustomEvent("analysts-change", { detail: next, bubbles: true, composed: true }));
  }

  render() {
    const sel = new Set(this.selected);
    const templates = this.options.filter((o) => o.kind === "template");
    const others = this.options.filter((o) => o.kind === "agent" && !sel.has(o.agentId));
    const extra = this.options.filter((o) => o.kind === "agent" && sel.has(o.agentId));
    const toggle = (id: string) => this.emit(sel.has(id) ? this.selected.filter((x) => x !== id) : [...this.selected, id]);
    return html`<div class="wrap" data-testid="chat-video-analysts">
      <span class="lbl">Analyze with</span>
      ${[...templates, ...extra].map(
        (o) => html`<button aria-pressed=${sel.has(o.agentId)} title=${o.tagline} data-agent=${o.agentId} @click=${() => toggle(o.agentId)}>${analystIcon(o.icon)}${titleCase(o.name)}</button>`,
      )}
      ${others.length
        ? html`<select aria-label="Add another agent" @change=${(e: Event) => {
            const v = (e.target as HTMLSelectElement).value;
            (e.target as HTMLSelectElement).value = "";
            if (v) toggle(v);
          }}>
            <option value="">+ Agent</option>
            ${others.map((o) => html`<option value=${o.agentId}>${titleCase(o.name)}</option>`)}
          </select>`
        : nothing}
    </div>`;
  }
}

/**
 * Chat flow: after a message with a video attachment is sent, queue the picked
 * analysts once the gateway has registered the video (matched by content hash)
 * and open the video analysis view.
 */
export async function startAttachmentVideoAnalysis(opts: {
  client: RequestClient;
  dataUrl: string;
  fileName?: string;
  analysts: string[];
  secure?: boolean;
}): Promise<boolean> {
  const b64 = opts.dataUrl.replace(/^data:[^,]*,/, "");
  const sha256 = await sha256OfBase64(b64);
  if (!sha256) return false;
  const secure = opts.secure ? { secure: true } : {};
  if (opts.analysts.length) {
    let ok = false;
    for (let i = 0; i < 25 && !ok; i++) {
      try {
        await opts.client.request("files.video.analyze", { sha256, agentIds: opts.analysts, ...secure });
        ok = true;
      } catch (err) {
        if (!/not found|not registered/i.test(String(err))) throw err;
        await new Promise((r) => setTimeout(r, 1500));
      }
    }
    if (!ok) return false;
  }
  openVideoDetailDialog({ client: opts.client, sha256, fileName: opts.fileName, secure: opts.secure });
  return true;
}

declare global {
  interface HTMLElementTagNameMap {
    "ib-video-detail": VideoDetail;
    "ib-video-detail-dialog": VideoDetailDialog;
    "ib-video-attach-picker": VideoAttachPicker;
  }
}
