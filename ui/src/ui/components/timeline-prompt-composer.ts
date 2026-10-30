/**
 * TimelinePromptComposer — Phase 8 addendum
 *
 * Visual editor for a TimelinePromptingProject:
 *  - horizontal time-scaled rail with colored beat blocks
 *  - draggable start/end handles
 *  - per-beat editor panel below the rail (action, camera, audio, override)
 *
 * Each text field renders a <mention-input-fallback> shim so the mentions
 * agent can drop in the real component later without touching this file.
 *
 * Emits:
 *   - "timeline-beats-changed" { value: TimelinePromptingProject }
 *   - "timeline-beats-resolved" { prompt, refs }
 */

import { LitElement, html, css, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type {
  TimelinePromptingProject,
  TimelineBeat,
  Scene,
  StoryboardMode,
  StoryboardProject,
} from "../../../../src/storyboard/types.js";
import {
  resolveTimelinePrompts,
  validateBeats,
  emptyTimelinePlan,
  newBeat,
  describePlan,
} from "../controllers/timeline-prompt-resolver.js";
import "./mention-input-fallback.js";

const BEAT_COLORS = [
  "#d4af37", "#7c9eff", "#ff8c5a", "#5eead4",
  "#c084fc", "#fb7185", "#facc15", "#34d399",
];

@customElement("timeline-prompt-composer")
export class TimelinePromptComposer extends LitElement {
  @property({ type: String }) projectId = "";
  @property({ type: String }) mode: StoryboardMode = "timeline-prompting";
  @property({ type: Array }) scenes: Scene[] = [];
  @property({ type: Object }) value: TimelinePromptingProject = emptyTimelinePlan();
  @property({ type: Object }) project: StoryboardProject | null = null;
  @property({ type: Boolean }) compact = false;

  @state() private expanded = false;
  @state() private selectedBeatId: string | null = null;
  @state() private dragState: { beatId: string; edge: "start" | "end" | "move"; originX: number; origStart: number; origEnd: number } | null = null;

  static styles = css`
    :host { display: block; font-family: ui-monospace, "JetBrains Mono", Menlo, monospace; }

    .wrap {
      background: rgba(20, 20, 24, 0.7);
      border: 1px solid rgba(212, 175, 55, 0.25);
      border-radius: 8px;
      padding: 10px 12px;
      margin: 8px 0;
    }
    .header {
      display: flex; align-items: center; justify-content: space-between;
      gap: 8px;
      cursor: pointer;
      user-select: none;
    }
    .title {
      color: #d4af37; font-size: 13px; font-weight: 600;
      display: flex; align-items: center; gap: 6px;
    }
    .summary { color: rgba(245, 245, 245, 0.6); font-size: 11px; }
    .chev { color: #d4af37; transition: transform 0.15s; }
    .chev.open { transform: rotate(180deg); }

    .body { margin-top: 10px; }

    .toolbar {
      display: flex; gap: 6px; margin-bottom: 8px;
    }
    .btn {
      background: rgba(212, 175, 55, 0.1);
      border: 1px solid rgba(212, 175, 55, 0.4);
      color: #d4af37;
      border-radius: 4px; padding: 4px 10px; font-size: 11px;
      cursor: pointer; font-family: inherit;
    }
    .btn:hover { background: rgba(212, 175, 55, 0.2); }
    .btn.danger { color: #fb7185; border-color: rgba(251, 113, 133, 0.4); }

    .rail-wrap {
      position: relative;
      height: 56px;
      background: rgba(0, 0, 0, 0.4);
      border-radius: 4px;
      border: 1px solid rgba(212, 175, 55, 0.15);
      margin-bottom: 10px;
      overflow: hidden;
    }
    .ruler {
      position: absolute; inset: 0 0 auto 0;
      height: 14px;
      color: rgba(245, 245, 245, 0.4);
      font-size: 9px;
      display: flex; align-items: center;
      pointer-events: none;
    }
    .tick {
      position: absolute; top: 0;
      width: 1px; height: 100%;
      background: rgba(212, 175, 55, 0.1);
      padding-left: 2px;
    }
    .beat-block {
      position: absolute;
      top: 18px;
      height: 36px;
      border-radius: 4px;
      cursor: grab;
      opacity: 0.85;
      display: flex; align-items: center; justify-content: center;
      color: #000; font-size: 10px; font-weight: 600;
      overflow: hidden;
      border: 1px solid rgba(0, 0, 0, 0.4);
      user-select: none;
    }
    .beat-block.selected { outline: 2px solid #d4af37; opacity: 1; }
    .handle {
      position: absolute; top: 0; bottom: 0; width: 6px;
      background: rgba(0, 0, 0, 0.4);
      cursor: ew-resize;
    }
    .handle.start { left: 0; }
    .handle.end { right: 0; }

    .editor {
      background: rgba(0, 0, 0, 0.35);
      border: 1px solid rgba(212, 175, 55, 0.2);
      border-radius: 6px;
      padding: 10px;
    }
    .field { margin-bottom: 8px; }
    .field label {
      display: block;
      color: rgba(212, 175, 55, 0.8);
      font-size: 10px;
      margin-bottom: 2px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .row { display: flex; gap: 8px; }
    .row .field { flex: 1; }
    input[type="number"] {
      width: 80px;
      background: rgba(0, 0, 0, 0.4);
      color: #f5f5f5;
      border: 1px solid rgba(212, 175, 55, 0.25);
      border-radius: 4px; padding: 4px 6px;
      font: inherit; font-size: 12px;
    }

    .errors {
      background: rgba(251, 113, 133, 0.1);
      border: 1px solid rgba(251, 113, 133, 0.3);
      color: #fda4af; font-size: 11px;
      padding: 6px 10px; border-radius: 4px;
      margin-top: 8px;
    }
    .errors ul { margin: 2px 0 0; padding-left: 16px; }
  `;

  connectedCallback() {
    super.connectedCallback();
    if (!this.compact) this.expanded = true;
    window.addEventListener("mousemove", this.onMouseMove);
    window.addEventListener("mouseup", this.onMouseUp);
  }
  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener("mousemove", this.onMouseMove);
    window.removeEventListener("mouseup", this.onMouseUp);
  }

  private get plan(): TimelinePromptingProject {
    return this.value ?? emptyTimelinePlan();
  }

  private get totalDuration(): number {
    return this.plan.totalDurationSec
      || this.scenes.reduce((s, sc) => s + sc.durationSeconds, 0)
      || 30;
  }

  private emitChange() {
    this.dispatchEvent(new CustomEvent("timeline-beats-changed", {
      detail: { value: this.plan },
      bubbles: true,
      composed: true,
    }));
    if (this.project) {
      const { prompt, refs } = resolveTimelinePrompts(this.plan.beats, this.project);
      this.dispatchEvent(new CustomEvent("timeline-beats-resolved", {
        detail: { prompt, refs },
        bubbles: true,
        composed: true,
      }));
    }
  }

  private updatePlan(patch: Partial<TimelinePromptingProject>) {
    this.value = { ...this.plan, ...patch };
    this.emitChange();
    this.requestUpdate();
  }

  private updateBeat(id: string, patch: Partial<TimelineBeat>) {
    const beats = this.plan.beats.map(b => b.id === id ? { ...b, ...patch } : b);
    this.updatePlan({ beats });
  }

  private addBeat() {
    const lastEnd = this.plan.beats.reduce((m, b) => Math.max(m, b.endSec), 0);
    const start = lastEnd;
    const end = Math.min(this.totalDuration, start + 3);
    const beat = newBeat(start, end);
    const beats = [...this.plan.beats, beat];
    this.value = { ...this.plan, beats, totalDurationSec: Math.max(this.plan.totalDurationSec, end) };
    this.selectedBeatId = beat.id;
    this.emitChange();
  }

  private deleteBeat(id: string) {
    const beats = this.plan.beats.filter(b => b.id !== id);
    this.updatePlan({ beats });
    if (this.selectedBeatId === id) this.selectedBeatId = null;
  }

  private onBeatMouseDown(e: MouseEvent, beat: TimelineBeat, edge: "start" | "end" | "move") {
    e.preventDefault();
    e.stopPropagation();
    this.selectedBeatId = beat.id;
    this.dragState = {
      beatId: beat.id,
      edge,
      originX: e.clientX,
      origStart: beat.startSec,
      origEnd: beat.endSec,
    };
  }

  private onMouseMove = (e: MouseEvent) => {
    if (!this.dragState) return;
    const rail = this.renderRoot.querySelector(".rail-wrap") as HTMLElement | null;
    if (!rail) return;
    const railWidth = rail.clientWidth;
    const dxPx = e.clientX - this.dragState.originX;
    const dxSec = (dxPx / railWidth) * this.totalDuration;
    const beat = this.plan.beats.find(b => b.id === this.dragState!.beatId);
    if (!beat) return;
    let start = beat.startSec;
    let end = beat.endSec;
    if (this.dragState.edge === "start") {
      start = Math.max(0, Math.min(this.dragState.origStart + dxSec, end - 0.5));
    } else if (this.dragState.edge === "end") {
      end = Math.max(start + 0.5, Math.min(this.totalDuration, this.dragState.origEnd + dxSec));
    } else {
      const len = this.dragState.origEnd - this.dragState.origStart;
      start = Math.max(0, Math.min(this.totalDuration - len, this.dragState.origStart + dxSec));
      end = start + len;
    }
    this.updateBeat(beat.id, { startSec: round1(start), endSec: round1(end) });
  };

  private onMouseUp = () => { this.dragState = null; };

  private renderRail() {
    const total = this.totalDuration;
    const beats = this.plan.beats;
    const tickInterval = total <= 30 ? 5 : total <= 120 ? 15 : 60;
    const ticks: number[] = [];
    for (let t = 0; t <= total; t += tickInterval) ticks.push(t);

    return html`
      <div class="rail-wrap">
        ${ticks.map(t => {
          const left = (t / total) * 100;
          return html`<div class="tick" style="left:${left}%">${t}s</div>`;
        })}
        ${beats.map((b, i) => {
          const left = (b.startSec / total) * 100;
          const width = ((b.endSec - b.startSec) / total) * 100;
          const color = BEAT_COLORS[i % BEAT_COLORS.length];
          const selected = b.id === this.selectedBeatId;
          return html`
            <div
              class="beat-block ${selected ? "selected" : ""}"
              style="left:${left}%; width:${width}%; background:${color};"
              @mousedown=${(e: MouseEvent) => this.onBeatMouseDown(e, b, "move")}
              title="Beat ${i + 1}: ${b.startSec}–${b.endSec}s"
            >
              <div class="handle start" @mousedown=${(e: MouseEvent) => this.onBeatMouseDown(e, b, "start")}></div>
              ${b.action ? b.action.slice(0, 20) : `Beat ${i + 1}`}
              <div class="handle end" @mousedown=${(e: MouseEvent) => this.onBeatMouseDown(e, b, "end")}></div>
            </div>
          `;
        })}
      </div>
    `;
  }

  private renderEditor() {
    const beat = this.plan.beats.find(b => b.id === this.selectedBeatId);
    if (!beat) {
      return html`<div class="editor" style="color: rgba(245,245,245,0.5); font-size: 11px;">
        Select a beat above, or click + Add Beat to begin.
      </div>`;
    }
    const onField = (field: keyof TimelineBeat) => (e: CustomEvent) => {
      this.updateBeat(beat.id, { [field]: e.detail.value } as any);
    };
    return html`
      <div class="editor">
        <div class="row">
          <div class="field">
            <label>Start (s)</label>
            <input type="number" step="0.1" .value=${String(beat.startSec)}
              @change=${(e: Event) => this.updateBeat(beat.id, { startSec: Number((e.target as HTMLInputElement).value) })} />
          </div>
          <div class="field">
            <label>End (s)</label>
            <input type="number" step="0.1" .value=${String(beat.endSec)}
              @change=${(e: Event) => this.updateBeat(beat.id, { endSec: Number((e.target as HTMLInputElement).value) })} />
          </div>
          <div class="field" style="flex: 2;">
            <label>On-screen text</label>
            <input type="number" style="width: 100%;" .value=${beat.onScreenText || ""}
              @input=${(e: Event) => this.updateBeat(beat.id, { onScreenText: (e.target as HTMLInputElement).value })} />
          </div>
        </div>
        <div class="field">
          <label>Action (supports @mentions)</label>
          <mention-input-fallback
            .value=${beat.action}
            field="action"
            placeholder="@founder hands @shea-bottle to @customer"
            @value-changed=${onField("action")}
          ></mention-input-fallback>
        </div>
        <div class="row">
          <div class="field">
            <label>Camera</label>
            <mention-input-fallback
              .value=${beat.camera}
              field="camera"
              placeholder="close-up, tracking @founder"
              @value-changed=${onField("camera")}
            ></mention-input-fallback>
          </div>
          <div class="field">
            <label>Audio notes</label>
            <mention-input-fallback
              .value=${beat.audioNotes}
              field="audioNotes"
              placeholder="ambient kitchen, @founder voiceover"
              @value-changed=${onField("audioNotes")}
            ></mention-input-fallback>
          </div>
        </div>
        <div class="field">
          <label>Manual override (replaces all above when set)</label>
          <mention-input-fallback
            .value=${beat.manualOverride}
            field="manualOverride"
            placeholder="full prompt override..."
            @value-changed=${onField("manualOverride")}
          ></mention-input-fallback>
        </div>
        <div style="display:flex; justify-content: flex-end;">
          <button class="btn danger" @click=${() => this.deleteBeat(beat.id)}>Delete beat</button>
        </div>
      </div>
    `;
  }

  render() {
    const beats = this.plan.beats;
    const slots = {
      characters: this.plan.characterSlots,
      assets: this.plan.assetSlots,
      locations: this.plan.locationSlots,
    };
    const { errors } = validateBeats(beats, slots, this.scenes, this.totalDuration, this.mode);
    const summary = describePlan(beats, this.mode);

    return html`
      <div class="wrap">
        <div class="header" @click=${() => (this.expanded = !this.expanded)}>
          <div class="title">
            <span>⏱ Author timeline prompt</span>
            <span class="summary">— ${summary}</span>
          </div>
          <div class="chev ${this.expanded ? "open" : ""}">⌄</div>
        </div>
        ${this.expanded ? html`
          <div class="body">
            <div class="toolbar">
              <button class="btn" @click=${() => this.addBeat()}>+ Add beat</button>
              <button class="btn" @click=${() => this.updatePlan({ beats: [] })} ?disabled=${!beats.length}>Clear</button>
            </div>
            ${this.renderRail()}
            ${this.renderEditor()}
            ${errors.length ? html`
              <div class="errors">
                <strong>${errors.length} validation issue${errors.length === 1 ? "" : "s"}:</strong>
                <ul>${errors.slice(0, 5).map(e => html`<li>${e.message}</li>`)}</ul>
              </div>
            ` : nothing}
          </div>
        ` : nothing}
      </div>
    `;
  }
}

function round1(n: number): number { return Math.round(n * 10) / 10; }
