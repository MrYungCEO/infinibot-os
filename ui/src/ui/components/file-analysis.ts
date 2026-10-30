/**
 * <ib-file-analysis> — the styled analysis side panel of the Files viewer.
 *
 * Reads the OCR/vision sidecar (files.context.get) and, for videos, the video
 * analysis (files.video.get), then renders them as a designed panel instead
 * of raw text: title + summary card, key findings with icons, entity chips
 * (click → search), tags, confidence meters, a seekable findings timeline and
 * per-analyst tabs for video, the extracted text in a collapsible section, and
 * actions (re-analyse, analyse with…, ask an agent, open on the graph).
 *
 * Events (bubbling, composed):
 *   file-seek      { t }          video timestamp clicked
 *   file-search    { query }      entity / tag chip clicked
 *   file-ask-agent { item, prompt }
 *   file-open-kg   { item }
 */
import { LitElement, css, html, nothing, type PropertyValues } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { icons } from "../icons";
import { toSanitizedMarkdownHtml } from "../markdown";
import { formatConfidence, isOcrPending, OCR_WINDOW_EVENT, type OcrEntryInfo, type OcrSidecarInfo } from "../file-ocr";
import {
  type BrowserItem,
  type ParsedAnalysis,
  displayName,
  isPdfName,
  parseFileAnalysis,
  splitMarkdownSections,
  firstSentences,
} from "../files-organize";
import {
  analysisColor,
  formatTimecode,
  type VideoAnalysisInfo,
  type VideoAnalystOption,
  type VideoGetResult,
} from "../video-analysis";

interface RequestClient {
  request<T = unknown>(method: string, params?: unknown): Promise<T>;
}

type SidecarWithAnalyses = OcrSidecarInfo & { analyses?: Parameters<typeof parseFileAnalysis>[0]["analyses"] };

/** Ephemeral "Analyze with…" result for images/PDFs (files.inspect). */
interface InspectRun {
  id: string;
  agentName: string;
  status: "running" | "done" | "failed";
  markdown?: string;
  model?: string;
  error?: string;
}

interface TimelineMark {
  t: number;
  label: string;
  color: string;
  analysisId: string;
}

const md = (s: string) => unsafeHTML(toSanitizedMarkdownHtml(s));

@customElement("ib-file-analysis")
export class FileAnalysisPanel extends LitElement {
  static styles = css`
    :host {
      display: block; color: var(--wg-fg, #ebe7de); font-size: 13px; line-height: 1.5;
      --fa-gold: var(--wg-gold, #d9b45a); --fa-gold-hi: var(--wg-gold-hi, #ecd28a);
      --fa-stroke: var(--glass-stroke, rgba(255, 255, 255, 0.1));
      --fa-card: color-mix(in srgb, var(--glass-base, #14161c) 70%, transparent);
      --fa-fg2: var(--wg-fg-2, #c9c5bb); --fa-fg3: var(--wg-fg-3, #9a968c);
    }
    svg { width: 15px; height: 15px; flex: none; }
    .stack { display: grid; gap: 14px; }
    .eyebrow { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 10.5px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--fa-fg3); }
    .eyebrow .k { display: inline-flex; align-items: center; gap: 6px; color: var(--fa-gold); }
    .pill { display: inline-flex; align-items: center; gap: 5px; height: 22px; padding: 0 9px; border-radius: 999px; font-size: 10.5px; letter-spacing: 0.04em; text-transform: none; font-weight: 600; border: 1px solid var(--fa-stroke); color: var(--fa-fg2); background: rgba(255,255,255,0.04); }
    .pill svg { width: 12px; height: 12px; }
    .pill.lock { color: var(--fa-gold); border-color: color-mix(in srgb, var(--fa-gold) 45%, transparent); background: color-mix(in srgb, var(--fa-gold) 10%, transparent); }
    .pill[data-s="done"] { color: #8fdcaa; border-color: rgba(120, 210, 150, 0.35); background: rgba(80, 190, 120, 0.1); }
    .pill[data-s="failed"] { color: #ff9a8a; border-color: rgba(255, 120, 100, 0.35); }
    .pill[data-s="pending"] { color: var(--fa-gold); }
    .pill[data-s="pending"] svg { animation: spin 1.1s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    h2 { margin: 2px 0 0; font-size: 19px; line-height: 1.25; font-weight: 650; letter-spacing: -0.01em; color: var(--wg-fg, #f3efe6); overflow-wrap: anywhere; }
    .fname { font-size: 11.5px; color: var(--fa-fg3); font-family: var(--font-mono, ui-monospace, monospace); overflow-wrap: anywhere; }
    .summary {
      position: relative; padding: 14px 16px 14px 18px; border-radius: 14px; font-size: 13.5px; line-height: 1.55; color: var(--wg-fg, #f1ede4);
      background: linear-gradient(135deg, color-mix(in srgb, var(--fa-gold) 13%, transparent), color-mix(in srgb, var(--fa-gold) 3%, transparent) 60%), var(--fa-card);
      border: 1px solid color-mix(in srgb, var(--fa-gold) 32%, var(--fa-stroke));
      box-shadow: inset 0 1px 0 rgba(255,255,255,0.06), 0 10px 28px rgba(0,0,0,0.25);
    }
    .summary::before { content: ""; position: absolute; left: 0; top: 12px; bottom: 12px; width: 3px; border-radius: 3px; background: linear-gradient(180deg, var(--fa-gold-hi), var(--fa-gold)); }
    .summary .lbl { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; font-size: 10.5px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--fa-gold); }
    .summary.muted { color: var(--fa-fg3); font-style: italic; }
    .sec { display: grid; gap: 8px; }
    .sec-h { display: flex; align-items: center; gap: 7px; font-size: 10.5px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--fa-fg3); }
    .sec-h svg { color: var(--fa-gold); width: 13px; height: 13px; }
    .sec-h .n { margin-left: auto; letter-spacing: 0; font-variant-numeric: tabular-nums; }
    ul.findings { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
    ul.findings li { display: grid; grid-template-columns: 28px minmax(0, 1fr); gap: 10px; align-items: start; padding: 8px 10px; border-radius: 11px; background: rgba(255,255,255,0.025); border: 1px solid color-mix(in srgb, var(--fa-stroke) 70%, transparent); }
    ul.findings li .ic { width: 28px; height: 28px; border-radius: 9px; display: grid; place-items: center; color: var(--fa-gold); background: color-mix(in srgb, var(--fa-gold) 11%, transparent); border: 1px solid color-mix(in srgb, var(--fa-gold) 26%, transparent); }
    ul.findings li[data-sev="high"] .ic, ul.findings li[data-sev="medium"] .ic { color: #ffb38a; background: rgba(255, 150, 100, 0.1); border-color: rgba(255, 150, 100, 0.3); }
    ul.findings li .t { color: var(--wg-fg, #eee); overflow-wrap: anywhere; }
    ul.findings li .d { display: block; margin-top: 2px; font-size: 12px; color: var(--fa-fg3); overflow-wrap: anywhere; }
    .ts { all: unset; cursor: pointer; display: inline-flex; align-items: center; gap: 4px; margin-right: 6px; padding: 0 7px; height: 20px; border-radius: 6px; font: 600 11px/20px var(--font-mono, ui-monospace, monospace); color: #1a1406; background: linear-gradient(180deg, var(--fa-gold-hi), var(--fa-gold)); }
    .ts:focus-visible, .chip:focus-visible, .btn:focus-visible, .tab:focus-visible, summary:focus-visible { outline: 2px solid var(--fa-gold); outline-offset: 2px; }
    .groups { display: grid; gap: 10px; }
    .grp-l { display: flex; align-items: center; gap: 6px; font-size: 11.5px; color: var(--fa-fg2); margin-bottom: 5px; }
    .grp-l svg { width: 13px; height: 13px; color: var(--fa-gold); }
    .chips { display: flex; flex-wrap: wrap; gap: 6px; }
    .chip { all: unset; cursor: pointer; display: inline-flex; align-items: center; gap: 5px; max-width: 100%; padding: 4px 10px; border-radius: 999px; font-size: 12px; color: var(--wg-fg, #eee); border: 1px solid var(--fa-stroke); background: rgba(255,255,255,0.045); transition: border-color 0.15s, background 0.15s; }
    .chip span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .chip:hover { border-color: color-mix(in srgb, var(--fa-gold) 55%, transparent); background: color-mix(in srgb, var(--fa-gold) 10%, transparent); }
    .chip svg { width: 12px; height: 12px; color: var(--fa-fg3); }
    .chip.tag { color: var(--fa-gold); border-color: color-mix(in srgb, var(--fa-gold) 30%, transparent); background: color-mix(in srgb, var(--fa-gold) 7%, transparent); }
    .meters { display: grid; gap: 9px; }
    .meter { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 4px 10px; font-size: 12px; color: var(--fa-fg2); }
    .meter b { font-variant-numeric: tabular-nums; color: var(--wg-fg, #eee); }
    .bar { grid-column: 1 / -1; height: 6px; border-radius: 6px; background: rgba(255,255,255,0.07); overflow: hidden; }
    .bar i { display: block; height: 100%; border-radius: 6px; background: linear-gradient(90deg, color-mix(in srgb, var(--fa-gold) 55%, #6b5520), var(--fa-gold-hi)); box-shadow: 0 0 12px color-mix(in srgb, var(--fa-gold) 45%, transparent); }
    .timeline { position: relative; height: 46px; margin: 2px 6px 0; }
    .timeline .rail { position: absolute; left: 0; right: 0; top: 15px; height: 4px; border-radius: 4px; background: rgba(255,255,255,0.08); }
    .timeline .mk { all: unset; cursor: pointer; position: absolute; top: 7px; width: 7px; height: 20px; margin-left: -3.5px; border-radius: 4px; box-shadow: 0 0 0 2px rgba(10,10,12,0.85); }
    .timeline .mk:hover, .timeline .mk:focus-visible { transform: scaleY(1.2); outline: none; box-shadow: 0 0 0 2px rgba(10,10,12,0.85), 0 0 12px currentColor; }
    .timeline .end { position: absolute; top: 31px; font: 10.5px var(--font-mono, ui-monospace, monospace); color: var(--fa-fg3); }
    .tabs { display: flex; gap: 4px; padding: 3px; border-radius: 11px; border: 1px solid var(--fa-stroke); background: rgba(0,0,0,0.2); overflow-x: auto; scrollbar-width: none; }
    .tab { all: unset; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; flex: none; padding: 6px 11px; border-radius: 8px; font-size: 12px; color: var(--fa-fg3); white-space: nowrap; }
    .tab .dot { width: 8px; height: 8px; border-radius: 50%; }
    .tab[aria-selected="true"] { color: var(--wg-fg, #fff); background: rgba(255,255,255,0.08); box-shadow: inset 0 0 0 1px var(--fa-stroke); }
    .card { padding: 12px 14px; border-radius: 13px; border: 1px solid var(--fa-stroke); background: var(--fa-card); }
    .md { font-size: 13px; line-height: 1.6; color: var(--fa-fg2); overflow-wrap: anywhere; }
    .md :first-child { margin-top: 0; }
    .md :last-child { margin-bottom: 0; }
    .md h1, .md h2, .md h3, .md h4 { color: var(--wg-fg, #f3efe6); line-height: 1.3; margin: 14px 0 6px; }
    .md h1 { font-size: 16px; } .md h2 { font-size: 14.5px; } .md h3, .md h4 { font-size: 13px; color: var(--fa-gold); }
    .md ul, .md ol { padding-left: 20px; margin: 6px 0; }
    .md li::marker { color: var(--fa-gold); }
    .md a { color: var(--fa-gold-hi); }
    .md code { font-size: 12px; padding: 1px 5px; border-radius: 5px; background: rgba(255,255,255,0.07); }
    .md pre { padding: 10px; border-radius: 9px; background: rgba(0,0,0,0.3); overflow: auto; }
    .md table { width: 100%; border-collapse: collapse; margin: 8px 0; font-size: 12px; display: block; overflow-x: auto; }
    .md th, .md td { padding: 6px 8px; border: 1px solid var(--fa-stroke); text-align: left; vertical-align: top; }
    .md th { color: var(--fa-gold); background: color-mix(in srgb, var(--fa-gold) 7%, transparent); font-weight: 600; }
    .md tr:nth-child(even) td { background: rgba(255,255,255,0.02); }
    details.text { border-radius: 13px; border: 1px solid var(--fa-stroke); background: var(--fa-card); }
    details.text summary { list-style: none; cursor: pointer; display: flex; align-items: center; gap: 8px; padding: 11px 14px; font-size: 12.5px; color: var(--fa-fg2); }
    details.text summary::-webkit-details-marker { display: none; }
    details.text summary .chev { transition: transform 0.2s; color: var(--fa-fg3); }
    details.text[open] summary .chev { transform: rotate(90deg); }
    details.text summary .sp { flex: 1; }
    details.text .body { padding: 0 14px 14px; max-height: 46vh; overflow: auto; }
    .btn { all: unset; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; height: 30px; padding: 0 12px; border-radius: 9px; font-size: 12px; font-weight: 550; border: 1px solid var(--fa-stroke); background: rgba(255,255,255,0.05); color: var(--fa-fg2); white-space: nowrap; }
    .btn:hover { background: rgba(255,255,255,0.09); color: var(--wg-fg, #fff); }
    .btn[disabled] { opacity: 0.45; pointer-events: none; }
    .btn.primary { color: #1a1406; border-color: transparent; background: linear-gradient(180deg, var(--fa-gold-hi), var(--fa-gold)); }
    .btn.sm { height: 24px; padding: 0 8px; font-size: 11.5px; }
    .actions { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
    .actions .btn { justify-content: center; }
    .menu-wrap { position: relative; }
    .menu-wrap > .btn { width: 100%; box-sizing: border-box; justify-content: center; }
    .menu { position: absolute; z-index: 5; bottom: calc(100% + 6px); left: 0; min-width: 240px; max-height: 300px; overflow: auto; padding: 6px; border-radius: 12px; border: 1px solid var(--fa-stroke); background: color-mix(in srgb, var(--glass-base, #121419) 96%, transparent); box-shadow: 0 18px 50px rgba(0,0,0,0.55); }
    .menu button { all: unset; cursor: pointer; display: grid; gap: 1px; width: 100%; box-sizing: border-box; padding: 8px 10px; border-radius: 8px; }
    .menu button:hover, .menu button:focus-visible { background: color-mix(in srgb, var(--fa-gold) 10%, transparent); }
    .menu b { font-size: 12.5px; color: var(--wg-fg, #eee); font-weight: 600; }
    .menu small { font-size: 11px; color: var(--fa-fg3); }
    .ask { display: flex; gap: 6px; }
    .ask input { flex: 1; min-width: 0; height: 32px; padding: 0 11px; border-radius: 9px; border: 1px solid var(--fa-stroke); background: rgba(0,0,0,0.25); color: inherit; font: inherit; font-size: 12.5px; }
    .ask input:focus { outline: none; border-color: color-mix(in srgb, var(--fa-gold) 60%, transparent); }
    .answer { padding: 11px 13px; border-radius: 11px; border: 1px solid color-mix(in srgb, var(--fa-gold) 30%, transparent); background: color-mix(in srgb, var(--fa-gold) 6%, transparent); }
    .answer small { display: block; margin-top: 6px; color: var(--fa-fg3); font-size: 11px; }
    .err { color: #ff9a8a; font-size: 12px; }
    .muted { color: var(--fa-fg3); font-size: 12px; }
    .working { display: flex; align-items: center; gap: 8px; color: var(--fa-gold); font-size: 12.5px; }
    .working svg { animation: spin 1.1s linear infinite; }
    .skel { height: 11px; border-radius: 6px; margin: 7px 0; background: linear-gradient(90deg, rgba(255,255,255,0.05), rgba(255,255,255,0.12), rgba(255,255,255,0.05)); background-size: 200% 100%; animation: sh 1.4s ease infinite; }
    @keyframes sh { to { background-position: -200% 0; } }
    @media (prefers-reduced-motion: reduce) { .skel, .working svg, .pill[data-s="pending"] svg { animation: none; } }
  `;

  @property({ attribute: false }) client: RequestClient | null = null;
  @property({ attribute: false }) item: BrowserItem | null = null;
  /** Current video time (from the viewer's player) to highlight the nearest moment. */
  @property({ type: Number }) currentTime = 0;

  @state() private entry: OcrEntryInfo | null = null;
  @state() private sidecar: SidecarWithAnalyses | null = null;
  @state() private video: VideoGetResult | null = null;
  @state() private loading = false;
  @state() private error: string | null = null;
  @state() private tab = "overview";
  @state() private analysts: VideoAnalystOption[] = [];
  @state() private menuOpen = false;
  @state() private runs: InspectRun[] = [];
  @state() private busyAction: string | null = null;
  @state() private copied = false;
  @state() private question = "";
  @state() private answer: { text: string; model: string } | null = null;

  private seq = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private onOcr = (e: Event) => {
    const d = (e as CustomEvent<{ id?: string }>).detail;
    if (!d?.id || d.id === this.entry?.id) void this.load(true);
  };

  connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener(OCR_WINDOW_EVENT, this.onOcr);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    window.removeEventListener(OCR_WINDOW_EVENT, this.onOcr);
    if (this.timer) clearTimeout(this.timer);
  }

  protected willUpdate(changed: PropertyValues<this>): void {
    if (changed.has("item") || changed.has("client")) {
      const prev = changed.get("item") as BrowserItem | null | undefined;
      if (changed.has("item") && prev?.key !== this.item?.key) {
        this.entry = null;
        this.sidecar = null;
        this.video = null;
        this.tab = "overview";
        this.runs = [];
        this.answer = null;
        this.question = "";
        this.menuOpen = false;
        this.error = null;
      }
      void this.load();
    }
  }

  private ref(): Record<string, unknown> | null {
    const it = this.item;
    if (!it) return null;
    if (it.secure) return it.ocrId ? { id: it.ocrId, secure: true } : null;
    return it.ocrId ? { id: it.ocrId } : it.path ? { path: it.path } : null;
  }

  private get isVideo() {
    return this.item?.kind === "video";
  }

  async load(quiet = false) {
    const client = this.client;
    const ref = this.ref();
    if (!client || !ref) return;
    const seq = ++this.seq;
    if (!quiet && !this.sidecar) this.loading = true;
    try {
      const [ctx, vid] = await Promise.all([
        client.request<{ found: boolean; entry?: OcrEntryInfo; sidecar?: SidecarWithAnalyses | null }>("files.context.get", ref),
        this.isVideo ? client.request<VideoGetResult>("files.video.get", ref).catch(() => null) : Promise.resolve(null),
      ]);
      if (seq !== this.seq) return;
      this.entry = ctx?.entry ?? null;
      this.sidecar = ctx?.sidecar ?? null;
      this.video = vid;
      this.error = null;
      if (this.tab.startsWith("a:") && !this.video?.analyses?.some((a) => `a:${a.id}` === this.tab) && !this.runs.some((r) => `r:${r.id}` === this.tab)) this.tab = "overview";
    } catch (err) {
      if (seq === this.seq) this.error = err instanceof Error ? err.message : String(err);
    } finally {
      if (seq === this.seq) this.loading = false;
    }
    if (this.timer) clearTimeout(this.timer);
    if (this.isConnected && this.busy()) this.timer = setTimeout(() => void this.load(true), 3000);
    if (!this.analysts.length) void this.loadAnalysts();
  }

  private busy(): boolean {
    if (isOcrPending(this.entry?.status)) return true;
    if (this.entry?.status === "done" && this.sidecar && !this.sidecar.complete) return true;
    const v = this.video;
    if (!v?.found) return false;
    if ((v.jobs ?? []).some((j) => j.status === "queued" || j.status === "running")) return true;
    return (v.analyses ?? []).some((a) => a.data?.status === "queued" || a.data?.status === "running");
  }

  private async loadAnalysts() {
    try {
      const r = await this.client?.request<{ analysts: VideoAnalystOption[] }>("files.video.analysts", {});
      this.analysts = r?.analysts ?? [];
    } catch {
      this.analysts = [];
    }
  }

  private emit(name: string, detail: unknown) {
    this.dispatchEvent(new CustomEvent(name, { detail, bubbles: true, composed: true }));
  }

  // ── Actions ───────────────────────────────────────────────────────────

  private async reanalyze() {
    const ref = this.ref();
    if (!this.client || !ref) return;
    this.busyAction = "rerun";
    this.error = null;
    try {
      if (this.isVideo) await this.client.request("files.video.process", { ...ref, force: true });
      else await this.client.request("files.ocr.rerun", ref);
      await this.load(true);
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
    } finally {
      this.busyAction = null;
    }
  }

  private canAnalyzeWith(): boolean {
    const it = this.item;
    if (!it) return false;
    return it.kind === "video" || it.kind === "image" || isPdfName(it.name);
  }

  private async analyzeWith(a: VideoAnalystOption) {
    this.menuOpen = false;
    const ref = this.ref();
    if (!this.client || !ref || !this.item) return;
    this.error = null;
    if (this.isVideo) {
      this.busyAction = "analyze";
      try {
        const res = await this.client.request<{ analyses: Array<{ analysisId: string }> }>("files.video.analyze", { ...ref, agentIds: [a.agentId] });
        await this.load(true);
        const first = res?.analyses?.[0]?.analysisId;
        if (first) this.tab = `a:${first}`;
      } catch (err) {
        this.error = err instanceof Error ? err.message : String(err);
      } finally {
        this.busyAction = null;
      }
      return;
    }
    // Images / PDFs: a local, one-off specialist read through the vision model.
    if (!this.entry) return;
    const run: InspectRun = { id: `${a.agentId}-${Date.now().toString(36)}`, agentName: a.name, status: "running" };
    this.runs = [...this.runs, run];
    this.tab = `r:${run.id}`;
    const kind = this.item.kind === "image" ? "image" : "document";
    const question = [
      `You are ${a.name}${a.tagline ? ` — ${a.tagline}` : ""}.`,
      `Analyse this ${kind} from that perspective. Answer in markdown with exactly these sections:`,
      "## Summary",
      "One or two sentences.",
      "## Findings",
      "Bullet list of concrete observations, each one line.",
      "Only describe what is visible.",
    ].join("\n");
    try {
      const r = await this.client.request<{ answer: string; model: string }>("files.inspect", {
        id: this.entry.id,
        question,
        ...(this.item.secure ? { secure: true } : {}),
      });
      this.runs = this.runs.map((x) => (x.id === run.id ? { ...x, status: "done", markdown: r?.answer ?? "", model: r?.model } : x));
    } catch (err) {
      this.runs = this.runs.map((x) => (x.id === run.id ? { ...x, status: "failed", error: err instanceof Error ? err.message : String(err) } : x));
    }
  }

  private async ask(e: Event) {
    e.preventDefault();
    const q = this.question.trim();
    if (!q || !this.client || !this.entry) return;
    this.busyAction = "ask";
    this.answer = null;
    try {
      const r = await this.client.request<{ answer: string; model: string }>("files.inspect", {
        id: this.entry.id,
        question: q,
        ...(this.item?.secure ? { secure: true } : {}),
      });
      this.answer = { text: r?.answer ?? "", model: r?.model ?? "" };
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
    } finally {
      this.busyAction = null;
    }
  }

  private askAgent(model: ParsedAnalysis) {
    const it = this.item;
    if (!it) return;
    const ref = it.secure ? `secure file id ${it.ocrId}` : `file id ${it.ocrId ?? "?"}${it.path ? `, path ${it.path}` : ""}`;
    const prompt = [
      `About the file “${it.name}” (${ref}${it.secure ? ", Secure Mode lane" : ""}):`,
      model.summary ? `Summary: ${model.summary}` : "",
      "Use file_context to read its extracted text and analysis, then: ",
    ]
      .filter(Boolean)
      .join("\n");
    this.emit("file-ask-agent", { item: it, prompt });
  }

  private async copyText(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      this.copied = true;
      setTimeout(() => (this.copied = false), 1400);
    } catch {
      /* clipboard blocked */
    }
  }

  // ── Render helpers ────────────────────────────────────────────────────

  private statusPill() {
    const st = this.entry?.status;
    if (!st) return this.item?.ocrId || this.loading ? nothing : html`<span class="pill">${icons.minus}Not analysed</span>`;
    const s = st === "done" ? "done" : st === "failed" ? "failed" : "pending";
    const label = st === "done" ? "Analysed" : st === "failed" ? "Failed" : st === "processing" ? (this.entry?.progress?.total ? `Reading ${this.entry.progress.done}/${this.entry.progress.total}` : "Reading") : "Queued";
    return html`<span class="pill" data-s=${s}>${s === "done" ? icons.checkCircle : s === "failed" ? icons.alertCircle : icons.loader}${label}</span>`;
  }

  private marks(): TimelineMark[] {
    const out: TimelineMark[] = [];
    (this.video?.analyses ?? []).forEach((a, i) => {
      const color = analysisColor(i);
      const name = a.data?.agentName ?? a.agentId ?? "Analyst";
      for (const m of a.data?.moments ?? []) out.push({ t: m.t, label: `${name}: ${m.label}`, color, analysisId: a.id });
      for (const o of a.data?.observations ?? []) if (typeof o.t === "number") out.push({ t: o.t, label: `${name}: ${o.text}`, color, analysisId: a.id });
    });
    out.sort((a, b) => a.t - b.t);
    if (out.length) return out;
    // No analyst yet: the pipeline's scene keyframes still make a useful, seekable map.
    return (this.video?.video?.keyframes ?? []).map((k) => ({
      t: k.t,
      label: k.ocr?.text ? `Scene — “${k.ocr.text.slice(0, 60)}”` : "Scene change",
      color: "rgba(236, 210, 138, 0.55)",
      analysisId: "",
    }));
  }

  private renderTimeline() {
    const dur = this.video?.video?.meta?.duration ?? 0;
    const marks = this.marks().filter((m) => dur > 0 && m.t <= dur + 1);
    if (!dur) return nothing;
    return html`<div class="sec">
      <div class="sec-h">${icons.filmStrip}Findings timeline<span class="n">${marks.length} ${marks.some((m) => m.analysisId) ? "moments" : "scenes"} · ${formatTimecode(dur)}</span></div>
      ${marks.length && !marks.some((m) => m.analysisId) ? html`<div class="muted">Scene changes from the local pipeline — run an analyst for findings.</div>` : nothing}
      <div class="timeline" data-testid="fa-timeline">
        <div class="rail"></div>
        ${marks.map(
          (m) => html`<button
            class="mk"
            style="left:${Math.min(100, (m.t / dur) * 100)}%;background:${m.color};color:${m.color}"
            title="${formatTimecode(m.t)} — ${m.label}"
            aria-label="Seek to ${formatTimecode(m.t)}: ${m.label}"
            @click=${() => this.emit("file-seek", { t: m.t })}
          ></button>`,
        )}
        <span class="end" style="left:0">00:00</span>
        <span class="end" style="right:0">${formatTimecode(dur)}</span>
      </div>
    </div>`;
  }

  private ts(t: number | undefined) {
    if (typeof t !== "number") return nothing;
    return html`<button class="ts" title="Seek to ${formatTimecode(t)}" @click=${() => this.emit("file-seek", { t })}>${icons.play}${formatTimecode(t)}</button>`;
  }

  private renderAnalystTab(a: VideoAnalysisInfo, i: number) {
    const d = a.data;
    const st = d?.status ?? "done";
    if (st === "queued" || st === "running") {
      return html`<div class="card"><div class="working">${icons.loader}${d?.agentName ?? "The analyst"} is ${st === "queued" ? "waiting for the GPU" : "watching the video"}…</div></div>`;
    }
    if (st === "failed") return html`<div class="card err">${d?.error ?? "This analysis failed."}</div>`;
    const summary = d?.summary ?? a.summary ?? "";
    const { sections } = splitMarkdownSections(summary);
    const moments = d?.moments ?? [];
    const obs = d?.observations ?? [];
    const ents = d?.entities ?? [];
    const conf = typeof d?.confidence === "number" ? d.confidence : null;
    return html`<div class="stack" data-testid="fa-analyst-tab">
      ${summary
        ? html`<div class="summary" style="--fa-gold:${analysisColor(i)}"><div class="lbl">${icons.sparkles}${d?.agentName ?? "Analyst"} · summary</div>${sections.length ? html`<div class="md">${md(summary)}</div>` : firstSentences(summary, 3, 600)}</div>`
        : nothing}
      ${moments.length
        ? html`<div class="sec"><div class="sec-h">${icons.target}Key moments<span class="n">${moments.length}</span></div>
            <ul class="findings">${moments.map((m) => html`<li><span class="ic">${icons.clock}</span><span class="t">${this.ts(m.t)}${m.label}${m.detail ? html`<span class="d">${m.detail}</span>` : nothing}</span></li>`)}</ul></div>`
        : nothing}
      ${obs.length
        ? html`<div class="sec"><div class="sec-h">${icons.eye}Observations<span class="n">${obs.length}</span></div>
            <ul class="findings">${obs.map((o) => html`<li><span class="ic">${icons.lightbulb}</span><span class="t">${this.ts(o.t)}${o.text}</span></li>`)}</ul></div>`
        : nothing}
      ${ents.length
        ? html`<div class="sec"><div class="sec-h">${icons.tag}Spotted<span class="n">${ents.length}</span></div>
            <div class="chips">${ents.map((e) => html`<button class="chip" title=${e.type ?? ""} @click=${() => (typeof e.t === "number" ? this.emit("file-seek", { t: e.t }) : this.emit("file-search", { query: e.name }))}>${icons.tag}<span>${e.name}</span>${typeof e.t === "number" ? html`<small class="muted">${formatTimecode(e.t)}</small>` : nothing}</button>`)}</div></div>`
        : nothing}
      ${(d?.openQuestions ?? []).length
        ? html`<div class="sec"><div class="sec-h">${icons.alertCircle}Open questions</div><ul class="findings">${d!.openQuestions!.map((q) => html`<li><span class="ic">${icons.search}</span><span class="t">${q}</span></li>`)}</ul></div>`
        : nothing}
      ${conf !== null ? this.renderMeters([{ label: `${d?.agentName ?? "Analyst"} confidence`, value: conf > 1 ? conf / 100 : conf }]) : nothing}
      ${a.model ? html`<div class="muted">Ran locally on ${a.model}</div>` : nothing}
    </div>`;
  }

  private renderRun(r: InspectRun) {
    if (r.status === "running") return html`<div class="card"><div class="working">${icons.loader}${r.agentName} is looking at this file…</div></div>`;
    if (r.status === "failed") return html`<div class="card err">${r.error}</div>`;
    const parsed = parseFileAnalysis({ name: this.item?.name ?? "", description: r.markdown ?? "" });
    return html`<div class="stack" data-testid="fa-run-tab">
      ${parsed.summary ? html`<div class="summary"><div class="lbl">${icons.sparkles}${r.agentName} · summary</div>${parsed.summary}</div>` : nothing}
      <div class="card md">${md(r.markdown ?? "")}</div>
      ${r.model ? html`<div class="muted">Answered locally by ${r.model} · not saved</div>` : nothing}
    </div>`;
  }

  private renderMeters(meters: Array<{ label: string; value: number }>) {
    if (!meters.length) return nothing;
    return html`<div class="sec">
      <div class="sec-h">${icons.activity}Confidence</div>
      <div class="meters">
        ${meters.map(
          (m) => html`<div class="meter" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow=${Math.round(m.value * 100)} aria-label=${m.label}>
            <span>${m.label}</span><b>${formatConfidence(m.value)}</b>
            <span class="bar"><i style="width:${Math.round(m.value * 100)}%"></i></span>
          </div>`,
        )}
      </div>
    </div>`;
  }

  private renderOverview(model: ParsedAnalysis) {
    const pending = isOcrPending(this.entry?.status);
    return html`
      ${model.summary
        ? html`<div class="summary" data-testid="fa-summary"><div class="lbl">${icons.sparkles}Summary</div>${model.summary}</div>`
        : html`<div class="summary muted">${pending ? "Reading this file locally — the summary appears in a moment." : this.entry ? "No description yet for this file." : "This file has not been analysed yet."}</div>`}
      ${model.findings.length
        ? html`<div class="sec">
            <div class="sec-h">${icons.lightbulb}Key findings<span class="n">${model.findings.length}</span></div>
            <ul class="findings" data-testid="fa-findings">
              ${model.findings.map(
                (f) => html`<li data-sev=${f.severity ?? ""}><span class="ic">${icons[f.icon]}</span><span class="t">${this.ts(f.at)}${f.text}${f.detail ? html`<span class="d">${f.detail}</span>` : nothing}</span></li>`,
              )}
            </ul>
          </div>`
        : nothing}
      ${model.entityGroups.length
        ? html`<div class="sec">
            <div class="sec-h">${icons.users}Detected<span class="n">${model.entityGroups.reduce((n, g) => n + g.items.length, 0)}</span></div>
            <div class="groups" data-testid="fa-entities">
              ${model.entityGroups.map(
                (g) => html`<div>
                  <div class="grp-l">${icons[g.icon]}${g.label}</div>
                  <div class="chips">
                    ${g.items.map((it) => html`<button class="chip" title="Find files that mention “${it}”" @click=${() => this.emit("file-search", { query: it })}>${icons.search}<span>${it}</span></button>`)}
                  </div>
                </div>`,
              )}
            </div>
          </div>`
        : nothing}
      ${model.tags.length
        ? html`<div class="sec"><div class="sec-h">${icons.tag}Tags</div>
            <div class="chips">${model.tags.map((t) => html`<button class="chip tag" @click=${() => this.emit("file-search", { query: t })}>${icons.tag}<span>${t}</span></button>`)}</div></div>`
        : nothing}
      ${this.renderMeters(model.meters)}
      ${model.sections.map((s) => html`<div class="sec"><div class="sec-h">${icons.fileText}${s.heading}</div><div class="card md">${md(s.body)}</div></div>`)}
    `;
  }

  render() {
    const it = this.item;
    if (!it) return nothing;
    const sc = this.sidecar;
    const vid = this.video;
    const model = parseFileAnalysis({
      name: it.name,
      description: sc?.description ?? vid?.description ?? null,
      markdown: sc?.markdown ?? null,
      entities: sc?.entities ?? vid?.entities ?? [],
      summary: this.entry?.summary ?? it.summary ?? null,
      confidence: sc?.confidence ?? this.entry?.confidence ?? null,
      pageCount: sc?.pageCount,
      analyses: this.isVideo ? undefined : sc?.analyses,
    });
    const analyses = vid?.analyses ?? [];
    const tabs = [
      ...analyses.map((a, i) => ({ id: `a:${a.id}`, label: a.data?.agentName ?? a.agentId ?? "Analyst", color: analysisColor(i) })),
      ...this.runs.map((r, i) => ({ id: `r:${r.id}`, label: r.agentName, color: analysisColor(analyses.length + i) })),
    ];
    const activeAnalysis = analyses.findIndex((a) => `a:${a.id}` === this.tab);
    const activeRun = this.runs.find((r) => `r:${r.id}` === this.tab);
    const text = model.text;
    return html`<div class="stack" data-testid="file-analysis">
      <div class="eyebrow">
        <span class="k">${it.kind === "video" ? icons.video : it.kind === "image" ? icons.image : icons.fileText}${it.kind === "other" ? "File" : it.kind}</span>
        ${it.secure ? html`<span class="pill lock" data-testid="fa-lock">${icons.lock}Secure · decrypted in memory</span>` : nothing}
        ${this.statusPill()}
      </div>
      <div>
        <h2>${this.loading ? html`<div class="skel" style="width:70%;height:16px"></div>` : model.title}</h2>
        <div class="fname">${displayName(it.name)}</div>
      </div>

      ${this.error ? html`<div class="err" role="alert">${this.error}</div>` : nothing}
      ${this.entry?.status === "failed" && this.entry.error ? html`<div class="err">${this.entry.error}</div>` : nothing}

      ${this.isVideo ? this.renderTimeline() : nothing}

      ${tabs.length
        ? html`<div class="tabs" role="tablist" aria-label="Analysts">
            <button class="tab" role="tab" aria-selected=${this.tab === "overview"} @click=${() => (this.tab = "overview")}>${icons.layers}Overview</button>
            ${tabs.map((t) => html`<button class="tab" role="tab" data-testid="fa-tab" aria-selected=${this.tab === t.id} @click=${() => (this.tab = t.id)}><span class="dot" style="background:${t.color}"></span>${t.label}</button>`)}
          </div>`
        : nothing}

      ${this.loading
        ? html`<div class="card">${[90, 70, 80, 55].map((w) => html`<div class="skel" style="width:${w}%"></div>`)}</div>`
        : activeAnalysis >= 0
          ? this.renderAnalystTab(analyses[activeAnalysis], activeAnalysis)
          : activeRun
            ? this.renderRun(activeRun)
            : this.renderOverview(model)}

      ${text
        ? html`<details class="text" data-testid="fa-text">
            <summary>
              <span class="chev">${icons.chevronRight}</span>${icons.scrollText}<span>Text in this file</span>
              <span class="muted">${text.length.toLocaleString()} chars</span><span class="sp"></span>
              <button class="btn sm" @click=${(e: Event) => { e.preventDefault(); e.stopPropagation(); void this.copyText(text); }} aria-label="Copy the text">${this.copied ? icons.check : icons.copy}${this.copied ? "Copied" : "Copy"}</button>
            </summary>
            <div class="body md">${md(text)}</div>
          </details>`
        : nothing}

      ${this.entry && (it.kind === "image" || isPdfName(it.name))
        ? html`<form class="ask" @submit=${this.ask}>
            <input type="text" placeholder="Ask the local vision model about this file…" aria-label="Question about this file" .value=${this.question} @input=${(e: Event) => (this.question = (e.target as HTMLInputElement).value)} />
            <button class="btn primary" type="submit" ?disabled=${this.busyAction === "ask" || !this.question.trim()}>${this.busyAction === "ask" ? icons.loader : icons.send}${this.busyAction === "ask" ? "Looking…" : "Ask"}</button>
          </form>
          ${this.answer ? html`<div class="answer md">${md(this.answer.text)}<small>Answered locally by ${this.answer.model}</small></div>` : nothing}`
        : nothing}

      <div class="actions" data-testid="fa-actions">
        <button class="btn" @click=${this.reanalyze} ?disabled=${this.busyAction === "rerun" || this.busy()} title="Run the local OCR + vision${this.isVideo ? " + video" : ""} pipeline again">${icons.refresh}Re-analyze</button>
        <div class="menu-wrap">
          <button class="btn" aria-haspopup="menu" aria-expanded=${String(this.menuOpen)} ?disabled=${!this.canAnalyzeWith() || !this.entry} @click=${() => (this.menuOpen = !this.menuOpen)} title=${this.canAnalyzeWith() ? "Pick an analyst agent" : "Analysts read images, PDFs and videos"}>${icons.sparkles}Analyze with…</button>
          ${this.menuOpen
            ? html`<div class="menu" role="menu">
                ${this.analysts.length
                  ? this.analysts.map((a) => html`<button role="menuitem" @click=${() => void this.analyzeWith(a)}><b>${a.name}</b><small>${a.tagline || (a.kind === "agent" ? "Your agent" : "Specialist")}</small></button>`)
                  : html`<div class="muted" style="padding:8px">No analyst agents found.</div>`}
              </div>`
            : nothing}
        </div>
        <button class="btn" @click=${() => this.askAgent(model)} title="Open a chat with this file's context">${icons.messageSquare}Ask an agent</button>
        <button class="btn" title=${it.secure ? "Find this file on the Secure Graph" : "Find this file on the Knowledge Graph"} @click=${() => this.emit("file-open-kg", { item: it })}>${icons.network}Knowledge Graph</button>
      </div>
    </div>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ib-file-analysis": FileAnalysisPanel;
  }
}
