/**
 * <voice-live-pipeline> — live STT → LLM → TTS stage indicators for a Robovoice
 * call. A style port of Robovoice's call-page HUD
 * (frontend/components/app/live-pipeline-hud.tsx): same glass card, stage
 * colours, pulsing ring on the running stage, check on finished stages,
 * flowing connector with the per-segment latency, total response time tiered
 * by colour, tool chip on the LLM stage, rolling average.
 *
 * It only renders: the model comes from livePipelineModel() (live-state.ts),
 * which is fed by the LiveKit room (agent state attribute + data topics).
 *
 * Holographic Voice Terminal look (REDESIGN_BRIEF.md): dark navy glass with an
 * ultra-thin gold edge, stages as <pipeline-node>s on a thin luminous signal
 * path. Latency tiers keep their semantic colours.
 */

import { LitElement, css, html, nothing, svg } from "lit";
import { customElement, property } from "lit/decorators.js";
import "./holo-primitives.js";
import { livePipelineModel, type LiveConnector, type LivePipelineInput, type LiveStage } from "./live-state.js";

const ICON = {
  stt: svg`<path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="22"/>`,
  llm: svg`<path d="M9.5 3A2.5 2.5 0 0 0 7 5.5 2.5 2.5 0 0 0 4.5 8a2.5 2.5 0 0 0-1 4.3A2.5 2.5 0 0 0 5 16.5 2.5 2.5 0 0 0 9.5 19 2.5 2.5 0 0 0 12 16.5v-11A2.5 2.5 0 0 0 9.5 3z"/><path d="M14.5 3A2.5 2.5 0 0 1 17 5.5 2.5 2.5 0 0 1 19.5 8a2.5 2.5 0 0 1 1 4.3 2.5 2.5 0 0 1-1.5 4.2 2.5 2.5 0 0 1-4.5 2.5 2.5 2.5 0 0 1-2.5-2.5"/>`,
  tts: svg`<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M19 5a10 10 0 0 1 0 14"/>`,
};

@customElement("voice-live-pipeline")
export class VoiceLivePipeline extends LitElement {
  @property({ attribute: false }) input: LivePipelineInput | null = null;
  /** "panel" sits in the session's System column; "hud" floats over the holographic HUD. */
  @property({ reflect: true }) variant: "panel" | "hud" = "panel";

  render() {
    if (!this.input) return nothing;
    const m = livePipelineModel(this.input);
    return html`<div class="card" role="status" aria-label="Live pipeline" data-testid="voice-live-pipeline" data-active=${m.activeIndex >= 0 ? m.stages[m.activeIndex].id : m.warming ? "warming" : "idle"}>
      <div class="head">
        <div class="title">
          <svg class="bolt" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M13 2 4 14h6l-1 8 9-12h-6z"/></svg>
          <span>live pipeline</span>
        </div>
        <div class="total">
          <span class="total-ms ${m.totalMs == null ? "empty" : ""}" style=${m.totalMs != null ? `color:${m.tier.color}` : ""} data-testid="voice-live-total">${m.totalMs ?? "—"}</span>
          <span class="unit">ms</span>
        </div>
      </div>
      <div class="stages">
        ${m.stages.map((s, i) => html`${this.renderStage(s)}${i < m.connectors.length ? this.renderConnector(m.connectors[i]) : nothing}`)}
      </div>
      ${this.input.inCall && this.input.language
        ? html`<div class="lang"><div class="lang-h">language</div><span class="lang-chip">${this.input.language}</span></div>`
        : nothing}
      <div class="foot">
        <span data-testid="voice-live-footer">${m.footer}</span>
        ${m.avgMs != null ? html`<span class="avg">avg <b>${m.avgMs}ms</b></span>` : html`<span class="avg">— <b>ms</b></span>`}
      </div>
    </div>`;
  }

  private renderStage(s: LiveStage) {
    return html`<div class="stage ${s.lit ? "lit" : ""} ${s.active ? "active" : ""} ${s.done ? "done" : ""}" data-stage=${s.id}>
      <pipeline-node ?lit=${s.lit} ?active=${s.active} ?done=${s.done}>
        ${s.done && !s.active
          ? html`<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm-1.4 14.2-3.8-3.8 1.4-1.4 2.4 2.4 5.2-5.2 1.4 1.4z"/></svg>`
          : html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[s.id]}</svg>`}
      </pipeline-node>
      <div class="meta">
        <div class="label-row">
          <span class="label">${s.label}</span>
          ${s.toolName ? html`<span class="tool" data-testid="voice-live-tool">${s.toolName}</span>` : nothing}
        </div>
        <div class="who"><span class="prov">${s.provider}</span>${s.model ? html`<span class="model"> · ${s.model}</span>` : nothing}</div>
      </div>
    </div>`;
  }

  private renderConnector(c: LiveConnector) {
    return html`<div class="conn">
      <div class="rail-col">
        <div class="rail">
          ${c.flowing ? html`<span class="flow ${c.active ? "fast" : ""}" aria-hidden="true"></span>` : nothing}
        </div>
      </div>
      <div class="seg">${c.ms != null ? html`<span>${c.ms}<i>ms</i></span>` : nothing}</div>
    </div>`;
  }

  static styles = css`
    :host {
      display: block;
      --g2: #d6a62a;
      --g3: #f5c84b;
      --g4: #ffe49a;
      --g5: #fff3cf;
      --meta: rgba(226, 222, 212, 0.5);
      --meta-dim: rgba(226, 222, 212, 0.32);
      --rv-mono: "JetBrains Mono", "SF Mono", ui-monospace, monospace;
      --rv-head: "Rajdhani", "Barlow Condensed", "Oswald", "Roboto Condensed", "Arial Narrow", ui-sans-serif, system-ui, sans-serif;
    }
    :host([variant="hud"]) {
      position: fixed;
      /* Robovoice docks it left-centre; the HUD's insight panels live there, so it docks right-centre. */
      top: 50%;
      right: 20px;
      transform: translateY(-50%);
      width: 248px;
      max-width: calc(100vw - 1.5rem);
      /* Above the holographic HUD (z 9000), below the controls dock (9700). */
      z-index: 9600;
      animation: slide-in 320ms cubic-bezier(0.22, 1, 0.36, 1) both;
    }
    @keyframes slide-in {
      from { opacity: 0; transform: translate(24px, -50%); }
      to { opacity: 1; transform: translate(0, -50%); }
    }
    /* Slightly more present than the other modules: dark navy glass, ultra-thin gold/steel edge. */
    .card {
      position: relative;
      overflow: hidden;
      border-radius: 4px;
      background:
        radial-gradient(120% 60% at 100% 0%, rgba(245, 200, 75, 0.07), transparent 60%),
        linear-gradient(165deg, rgba(12, 16, 26, 0.86) 0%, rgba(7, 9, 15, 0.8) 60%, rgba(5, 6, 9, 0.72) 100%);
      -webkit-backdrop-filter: blur(16px) saturate(130%);
      backdrop-filter: blur(16px) saturate(130%);
      border: 1px solid rgba(214, 166, 42, 0.16);
      box-shadow: inset 0 1px 0 rgba(255, 243, 207, 0.08), 0 22px 50px -30px rgba(0, 0, 0, 0.95);
      color: #fff;
    }
    .card::before, .card::after { content: ""; position: absolute; width: 12px; height: 12px; pointer-events: none; }
    .card::before { top: 0; left: 0; border-top: 1px solid var(--g3); border-left: 1px solid var(--g3); opacity: 0.7; }
    .card::after { bottom: 0; right: 0; border-bottom: 1px solid var(--g3); border-right: 1px solid var(--g3); opacity: 0.7; }
    .head { display: flex; align-items: center; justify-content: space-between; padding: 10px 14px 8px; position: relative; }
    .head::after { content: ""; position: absolute; left: 14px; right: 40%; bottom: 0; height: 1px; background: linear-gradient(90deg, rgba(245, 200, 75, 0.45), transparent); }
    .title { display: flex; align-items: center; gap: 7px; font: 600 11px/1 var(--rv-head); letter-spacing: 0.26em; text-transform: uppercase; color: var(--g4); }
    .bolt { width: 13px; height: 13px; color: var(--g3); filter: drop-shadow(0 0 4px rgba(245, 200, 75, 0.7)); }
    .total { display: flex; align-items: baseline; gap: 4px; font-family: var(--rv-mono); }
    .total-ms { font-size: 15px; font-weight: 600; color: var(--g4); font-variant-numeric: tabular-nums; transition: color 300ms; text-shadow: 0 0 10px currentColor; }
    .total-ms.empty { color: var(--meta-dim); text-shadow: none; font-weight: 400; }
    .unit { font-size: 9px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--meta-dim); }
    .stages { padding: 12px 14px 10px; }
    .stage { display: flex; align-items: center; gap: 12px; }
    .meta { min-width: 0; flex: 1; }
    .label-row { display: flex; align-items: center; gap: 6px; }
    .label { font: 700 12px/1.1 var(--rv-head); letter-spacing: 0.22em; text-transform: uppercase; color: rgba(255, 228, 154, 0.62); transition: color 150ms; }
    .stage.lit .label { color: var(--g5); text-shadow: 0 0 10px rgba(245, 200, 75, 0.6); }
    .tool {
      display: inline-flex; align-items: center; gap: 4px; border-radius: 999px; border: 1px solid rgba(245, 200, 75, 0.4); background: rgba(245, 200, 75, 0.12);
      padding: 1px 6px; font-size: 8px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: var(--g4);
      animation: pop 180ms ease-out both;
    }
    @keyframes pop { from { opacity: 0; transform: scale(0.85); } to { opacity: 1; transform: scale(1); } }
    .who { margin-top: 3px; font: 400 9.5px/1.3 var(--rv-mono); color: var(--meta-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .prov { color: var(--meta); }
    .model { color: var(--meta-dim); }
    /* The signal path: a thin luminous line between nodes; a pulse travels it while a turn flows. */
    .conn { display: flex; align-items: stretch; gap: 12px; }
    .rail-col { width: 34px; flex: none; display: flex; justify-content: center; }
    .rail {
      position: relative; margin: 3px 0; height: 22px; width: 1px; overflow: hidden;
      background: linear-gradient(to bottom, rgba(214, 166, 42, 0.5), rgba(214, 166, 42, 0.18));
      box-shadow: 0 0 6px rgba(245, 200, 75, 0.35);
    }
    .flow { position: absolute; left: 0; top: 0; height: 10px; width: 100%; background: linear-gradient(to bottom, transparent, var(--g5), transparent); animation: flow 1.4s linear infinite; }
    .flow.fast { animation-duration: 0.7s; }
    @keyframes flow { from { transform: translateY(-10px); } to { transform: translateY(22px); } }
    .seg { flex: 1; display: flex; align-items: center; font-family: var(--rv-mono); font-size: 9px; font-variant-numeric: tabular-nums; color: rgba(245, 200, 75, 0.55); }
    .seg i { font-style: normal; color: var(--meta-dim); }
    .lang { padding: 8px 14px; }
    .lang-h { margin-bottom: 6px; font-family: var(--rv-mono); font-size: 9px; font-weight: 500; letter-spacing: 0.2em; text-transform: uppercase; color: var(--meta-dim); }
    .lang-chip { display: inline-flex; border-radius: 999px; border: 1px solid rgba(214, 166, 42, 0.3); background: rgba(245, 200, 75, 0.06); padding: 2px 8px; font-size: 10px; color: var(--g4); }
    .foot { display: flex; align-items: center; justify-content: space-between; border-top: 1px solid rgba(214, 166, 42, 0.09); padding: 8px 14px; font: 500 9px/1 var(--rv-mono); letter-spacing: 0.18em; color: var(--meta); text-transform: uppercase; }
    .avg { letter-spacing: 0.06em; font-variant-numeric: tabular-nums; color: var(--meta-dim); }
    .avg b { font-weight: 500; color: var(--g4); }
    @media (prefers-reduced-motion: reduce) {
      .flow, .tool, :host([variant="hud"]) { animation: none; }
    }
  `;
}

declare global {
  interface HTMLElementTagNameMap {
    "voice-live-pipeline": VoiceLivePipeline;
  }
}
