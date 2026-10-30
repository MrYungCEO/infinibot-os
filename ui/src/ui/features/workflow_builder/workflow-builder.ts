/**
 * <ib-workflow-builder> — conversation workflow builder for an agent group chat.
 *
 * Drag an agent from the palette onto the canvas to add a step; drop it ON a
 * step to make it that step's sub-agent (lead → sub-agents run after the
 * lead, in parallel). Drag a step onto another step to re-parent it. Drag
 * from a step's right handle to another step to chain them in sequence.
 * Tap an agent chip to add it without dragging (touch).
 *
 * Workflows are stored on the group (groupchat.workflow.save, autosaved).
 * Run executes on the gateway (groupchat.workflow.run): each step's output is
 * handed to the next, and status + outputs are posted into the group chat.
 */
import { LitElement, css, html, nothing, svg, type PropertyValues } from "lit";
import { customElement, property, query, state } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import type { GatewayBrowserClient } from "../../gateway";
import { icons } from "../../icons";
import type { WorkflowGraph, WorkflowNode, WorkflowRunRecord } from "../../../../../src/shared/group-chat/types.js";
import { autoLayout, removeEdge, removeNode, setParent, validateWorkflow } from "../../../../../src/shared/group-chat/workflow-graph.js";
import { agentHue, initials, type GroupMemberInfo } from "../group_chat/logic";
import {
  NODE_H,
  NODE_W,
  canvasSize,
  connect,
  describeOrder,
  dropAgent,
  emptyWorkflow,
  links,
  nodeStatuses,
  quickAddAgent,
  releaseNode,
  starterWorkflow,
} from "./builder-logic";

const AGENT_MIME = "application/x-ib-agent";

type Drag =
  | { kind: "move"; nodeId: string; dx: number; dy: number; startX: number; startY: number; moved: boolean; pointerId: number }
  | { kind: "connect"; fromId: string; x: number; y: number; pointerId: number };

@customElement("ib-workflow-builder")
export class WorkflowBuilder extends LitElement {
  @property({ attribute: false }) client: GatewayBrowserClient | null = null;
  @property({ type: Boolean }) connected = false;
  @property() groupKey = "";
  @property({ attribute: false }) members: GroupMemberInfo[] = [];
  @property({ attribute: false }) workflows: WorkflowGraph[] = [];
  @property({ attribute: false }) runs: WorkflowRunRecord[] = [];

  @state() private currentId: string | null = null;
  @state() private graph: WorkflowGraph | null = null;
  @state() private dirty = false;
  @state() private saving = false;
  @state() private selectedNode: string | null = null;
  @state() private selectedEdge: string | null = null;
  @state() private drag: Drag | null = null;
  @state() private livePos: { id: string; x: number; y: number } | null = null;
  @state() private dropHint: string | null = null;
  @state() private runInput = "";
  @state() private starting = false;
  @state() private notice: { text: string; tone: "ok" | "err" } | null = null;

  @query(".wb-canvas") private canvas?: HTMLElement;

  private saveTimer: number | null = null;
  private noticeTimer: number | null = null;

  disconnectedCallback(): void {
    super.disconnectedCallback();
    if (this.dirty) void this.save();
    if (this.saveTimer) window.clearTimeout(this.saveTimer);
    if (this.noticeTimer) window.clearTimeout(this.noticeTimer);
  }

  protected willUpdate(changed: PropertyValues): void {
    if (changed.has("groupKey")) {
      this.currentId = null;
      this.graph = null;
      this.dirty = false;
      this.selectedNode = null;
      this.selectedEdge = null;
    }
    if (changed.has("workflows") || changed.has("groupKey")) {
      const list = this.workflows ?? [];
      if (this.currentId && !list.some((w) => w.id === this.currentId) && !this.dirty) {
        this.currentId = null;
        this.graph = null;
      }
      if (!this.currentId && list.length) this.currentId = list[list.length - 1].id;
      // Adopt the stored copy unless the user has unsaved edits.
      if (this.currentId && !this.dirty) {
        const stored = list.find((w) => w.id === this.currentId);
        if (stored) this.graph = structuredClone(stored);
      }
    }
  }

  private flash(text: string, tone: "ok" | "err" = "ok") {
    this.notice = { text, tone };
    if (this.noticeTimer) window.clearTimeout(this.noticeTimer);
    this.noticeTimer = window.setTimeout(() => (this.notice = null), 3200);
  }

  private memberName(id: string): string {
    return this.members.find((m) => m.id === id)?.name ?? id;
  }

  private stepName(n: WorkflowNode): string {
    return n.label?.trim() || this.memberName(n.agentId);
  }

  // ── persistence ────────────────────────────────────────────────────────

  private update_(next: WorkflowGraph) {
    this.graph = next;
    this.dirty = true;
    if (this.saveTimer) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => void this.save(), 700);
  }

  private async save(): Promise<boolean> {
    if (!this.graph || !this.client || !this.groupKey) return false;
    if (this.saveTimer) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.saving = true;
    const snapshot = this.graph;
    try {
      const res = await this.client.request<{ workflow: WorkflowGraph }>("groupchat.workflow.save", {
        key: this.groupKey,
        workflow: snapshot,
      });
      // Only clear dirty if nothing changed while the request was in flight.
      if (this.graph === snapshot) this.dirty = false;
      this.currentId = res.workflow.id;
      return true;
    } catch (err) {
      this.flash(String((err as Error)?.message ?? err).replace(/^Error:\s*/, ""), "err");
      return false;
    } finally {
      this.saving = false;
    }
  }

  private async newWorkflow(starter: boolean) {
    if (this.dirty) await this.save();
    const ids = this.members.map((m) => m.id);
    const g = starter && ids.length ? starterWorkflow(ids) : emptyWorkflow(`Workflow ${(this.workflows?.length ?? 0) + 1}`);
    this.currentId = g.id;
    this.graph = g;
    this.selectedNode = null;
    this.selectedEdge = null;
    this.dirty = true;
    await this.save();
  }

  private async selectWorkflow(id: string) {
    if (id === this.currentId) return;
    if (this.dirty) await this.save();
    const wf = this.workflows.find((w) => w.id === id);
    if (!wf) return;
    this.currentId = id;
    this.graph = structuredClone(wf);
    this.dirty = false;
    this.selectedNode = null;
    this.selectedEdge = null;
  }

  private async deleteWorkflow() {
    if (!this.graph || !this.client) return;
    if (!window.confirm(`Delete workflow "${this.graph.name}"?`)) return;
    const id = this.graph.id;
    try {
      await this.client.request("groupchat.workflow.delete", { key: this.groupKey, workflowId: id });
      this.dirty = false;
      this.currentId = null;
      this.graph = null;
    } catch (err) {
      this.flash(String((err as Error)?.message ?? err), "err");
    }
  }

  private async run() {
    if (!this.graph || !this.client) return;
    const check = validateWorkflow(this.graph, { members: this.members.map((m) => m.id) });
    if (!check.valid) {
      this.flash(check.errors[0] ?? "Workflow is not valid", "err");
      return;
    }
    this.starting = true;
    try {
      if (this.dirty && !(await this.save())) return;
      const res = await this.client.request<{ run: WorkflowRunRecord }>("groupchat.workflow.run", {
        key: this.groupKey,
        workflowId: this.graph.id,
        input: this.runInput,
      });
      this.runInput = "";
      this.flash("Workflow started — follow it in the chat");
      this.dispatchEvent(new CustomEvent("run-started", { detail: { runId: res.run.id }, bubbles: true, composed: true }));
    } catch (err) {
      this.flash(String((err as Error)?.message ?? err).replace(/^Error:\s*/, ""), "err");
    } finally {
      this.starting = false;
    }
  }

  // ── canvas geometry ────────────────────────────────────────────────────

  /** Client → canvas coordinates (handles scroll and the app's CSS zoom). */
  private toCanvas(clientX: number, clientY: number): { x: number; y: number } {
    const el = this.canvas;
    if (!el) return { x: 0, y: 0 };
    const rect = el.getBoundingClientRect();
    const zoom = el.offsetWidth ? rect.width / el.offsetWidth : 1;
    return {
      x: (clientX - rect.left) / (zoom || 1) + el.scrollLeft,
      y: (clientY - rect.top) / (zoom || 1) + el.scrollTop,
    };
  }

  // ── palette drag & drop ─────────────────────────────────────────────────

  private onPaletteDragStart(e: DragEvent, agentId: string) {
    e.dataTransfer?.setData(AGENT_MIME, agentId);
    e.dataTransfer?.setData("text/plain", `@${agentId}`);
    if (e.dataTransfer) e.dataTransfer.effectAllowed = "copy";
  }

  private onCanvasDragOver(e: DragEvent) {
    if (!e.dataTransfer?.types.includes(AGENT_MIME)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    if (!this.graph) return;
    const p = this.toCanvas(e.clientX, e.clientY);
    const over = this.graph.nodes.find((n) => p.x >= n.x && p.x <= n.x + NODE_W && p.y >= n.y && p.y <= n.y + NODE_H);
    this.dropHint = over?.id ?? null;
  }

  private onCanvasDrop(e: DragEvent) {
    const agentId = e.dataTransfer?.getData(AGENT_MIME);
    this.dropHint = null;
    if (!agentId) return;
    e.preventDefault();
    if (!this.graph) return;
    const res = dropAgent(this.graph, agentId, this.toCanvas(e.clientX, e.clientY));
    this.selectedNode = res.nodeId;
    this.selectedEdge = null;
    this.update_(res.graph);
  }

  private quickAdd(agentId: string) {
    if (!this.graph) return;
    const res = quickAddAgent(this.graph, agentId, this.selectedNode);
    this.selectedNode = res.nodeId;
    this.selectedEdge = null;
    this.update_(res.graph);
  }

  // ── node drag / connect ─────────────────────────────────────────────────

  private onNodePointerDown(e: PointerEvent, node: WorkflowNode) {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest(".wb-handle")) return;
    e.preventDefault();
    const p = this.toCanvas(e.clientX, e.clientY);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    this.drag = { kind: "move", nodeId: node.id, dx: p.x - node.x, dy: p.y - node.y, startX: p.x, startY: p.y, moved: false, pointerId: e.pointerId };
  }

  private onHandlePointerDown(e: PointerEvent, node: WorkflowNode) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const p = this.toCanvas(e.clientX, e.clientY);
    this.drag = { kind: "connect", fromId: node.id, x: p.x, y: p.y, pointerId: e.pointerId };
  }

  private onPointerMove(e: PointerEvent) {
    const d = this.drag;
    if (!d || e.pointerId !== d.pointerId || !this.graph) return;
    const p = this.toCanvas(e.clientX, e.clientY);
    if (d.kind === "move") {
      if (!d.moved && Math.hypot(p.x - d.startX, p.y - d.startY) < 4) return;
      d.moved = true;
      this.livePos = { id: d.nodeId, x: Math.max(0, p.x - d.dx), y: Math.max(0, p.y - d.dy) };
      const over = this.graph.nodes.find(
        (n) => n.id !== d.nodeId && p.x >= n.x && p.x <= n.x + NODE_W && p.y >= n.y && p.y <= n.y + NODE_H,
      );
      this.dropHint = over?.id ?? null;
    } else {
      this.drag = { ...d, x: p.x, y: p.y };
      const over = this.graph.nodes.find(
        (n) => n.id !== d.fromId && p.x >= n.x && p.x <= n.x + NODE_W && p.y >= n.y && p.y <= n.y + NODE_H,
      );
      this.dropHint = over?.id ?? null;
    }
  }

  private onPointerUp(e: PointerEvent) {
    const d = this.drag;
    if (!d || e.pointerId !== d.pointerId || !this.graph) return;
    const p = this.toCanvas(e.clientX, e.clientY);
    this.drag = null;
    this.dropHint = null;
    if (d.kind === "move") {
      const live = this.livePos;
      this.livePos = null;
      if (!d.moved || !live) {
        this.selectedNode = d.nodeId;
        this.selectedEdge = null;
        return;
      }
      const res = releaseNode(this.graph, d.nodeId, { x: live.x, y: live.y }, p);
      if (res.error) this.flash(res.error, "err");
      else if (res.reparentedTo) {
        const lead = this.graph.nodes.find((n) => n.id === res.reparentedTo);
        this.flash(`Now a sub-agent of ${lead ? this.stepName(lead) : "that step"}`);
      }
      this.selectedNode = d.nodeId;
      this.update_(res.graph);
      return;
    }
    const target = this.graph.nodes.find(
      (n) => n.id !== d.fromId && p.x >= n.x && p.x <= n.x + NODE_W && p.y >= n.y && p.y <= n.y + NODE_H,
    );
    if (!target) return;
    const res = connect(this.graph, d.fromId, target.id);
    if (res.error) this.flash(res.error, "err");
    else this.update_(res.graph);
  }

  private onKey(e: KeyboardEvent) {
    if (!this.graph) return;
    const tag = (e.target as HTMLElement).tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    if (e.key === "Delete" || e.key === "Backspace") {
      if (this.selectedNode) this.removeSelected();
      else if (this.selectedEdge) this.removeSelectedEdge();
    }
  }

  private removeSelected() {
    if (!this.graph || !this.selectedNode) return;
    this.update_(removeNode(this.graph, this.selectedNode));
    this.selectedNode = null;
  }

  private removeSelectedEdge() {
    if (!this.graph || !this.selectedEdge) return;
    const id = this.selectedEdge;
    if (id.startsWith("h-")) {
      this.update_(setParent(this.graph, id.slice(2), null));
    } else {
      this.update_(removeEdge(this.graph, id));
    }
    this.selectedEdge = null;
  }

  private patchNode(id: string, patch: Partial<WorkflowNode>) {
    if (!this.graph) return;
    this.update_({ ...this.graph, nodes: this.graph.nodes.map((n) => (n.id === id ? { ...n, ...patch } : n)) });
  }

  // ── render ─────────────────────────────────────────────────────────────

  private avatar(id: string, size = "sm") {
    const m = this.members.find((x) => x.id === id);
    const name = m?.name ?? id;
    if (m?.avatarUrl) return html`<img class="wb-av wb-av--${size}" src=${m.avatarUrl} alt=${name} draggable="false" />`;
    return html`<span class="wb-av wb-av--${size}" style="--h:${agentHue(id)}" aria-hidden="true">${initials(name)}</span>`;
  }

  render() {
    const list = this.workflows ?? [];
    return html`
      <div class="wb" @keydown=${(e: KeyboardEvent) => this.onKey(e)}>
        <div class="wb-bar">
          <div class="wb-tabs" role="tablist" aria-label="Workflows">
            ${list.map(
              (w) => html`<button
                role="tab"
                class="wb-tab ${w.id === this.currentId ? "wb-tab--on" : ""}"
                aria-selected=${w.id === this.currentId ? "true" : "false"}
                @click=${() => void this.selectWorkflow(w.id)}
              >
                ${w.id === this.currentId && this.graph ? this.graph.name : w.name}
              </button>`,
            )}
            ${this.graph && !list.some((w) => w.id === this.graph?.id)
              ? html`<button class="wb-tab wb-tab--on" role="tab" aria-selected="true">${this.graph.name}</button>`
              : nothing}
          </div>
          <button class="wb-btn" @click=${() => void this.newWorkflow(false)} title="New empty workflow">
            ${icons.plus}<span>New</span>
          </button>
        </div>
        ${this.graph ? this.renderEditor(this.graph) : this.renderEmpty()}
        ${this.notice
          ? html`<div class="wb-notice wb-notice--${this.notice.tone}" role="status">${this.notice.text}</div>`
          : nothing}
      </div>
    `;
  }

  private renderEmpty() {
    return html`<div class="wb-empty">
      <div class="wb-empty-ico">${icons.network}</div>
      <div class="wb-empty-title">Build a conversation workflow</div>
      <p>Arrange the group's agents into a lead → sub-agent hierarchy and a sequence of steps. Running it hands each step's output to the next and posts everything in the chat.</p>
      <div class="wb-empty-actions">
        <button class="wb-btn wb-btn--primary" @click=${() => void this.newWorkflow(true)}>${icons.sparkles}<span>Start from a template</span></button>
        <button class="wb-btn" @click=${() => void this.newWorkflow(false)}>${icons.plus}<span>Blank workflow</span></button>
      </div>
    </div>`;
  }

  private renderEditor(graph: WorkflowGraph) {
    const { run, byNode } = nodeStatuses(graph, this.runs ?? []);
    const shown: WorkflowGraph = this.livePos
      ? { ...graph, nodes: graph.nodes.map((n) => (n.id === this.livePos!.id ? { ...n, x: this.livePos!.x, y: this.livePos!.y } : n)) }
      : graph;
    const size = canvasSize(shown);
    const ls = links(shown);
    const order = describeOrder(graph, (n) => this.stepName(n));
    const sel = this.selectedNode ? graph.nodes.find((n) => n.id === this.selectedNode) : null;
    const running = run?.status === "running";
    const d = this.drag;
    const from = d?.kind === "connect" ? graph.nodes.find((n) => n.id === d.fromId) : null;
    return html`
      <div class="wb-head">
        <input
          class="wb-name"
          aria-label="Workflow name"
          .value=${graph.name}
          @change=${(e: Event) => this.update_({ ...graph, name: (e.target as HTMLInputElement).value.trim() || "Untitled workflow" })}
        />
        <span class="wb-save ${this.dirty ? "wb-save--dirty" : ""}">${this.saving ? "Saving…" : this.dirty ? "Unsaved" : "Saved"}</span>
        <span class="wb-spacer"></span>
        <button class="wb-btn" title="Arrange steps by execution order" @click=${() => this.update_(autoLayout(graph))}>${icons.layoutGrid}<span>Tidy</span></button>
        <button class="wb-btn wb-btn--danger" title="Delete workflow" aria-label="Delete workflow" @click=${() => void this.deleteWorkflow()}>${icons.trash}</button>
      </div>
      <div class="wb-palette" aria-label="Agents — drag onto the canvas, or tap to add">
        <span class="wb-palette-lbl">Agents</span>
        ${this.members.map(
          (m) => html`<button
            class="wb-chip"
            draggable="true"
            title="Drag onto the canvas (drop on a step to make it a sub-agent) — or tap to add"
            @dragstart=${(e: DragEvent) => this.onPaletteDragStart(e, m.id)}
            @click=${() => this.quickAdd(m.id)}
          >
            ${this.avatar(m.id)}<span>${m.name}</span>
          </button>`,
        )}
      </div>
      <div
        class="wb-canvas"
        tabindex="0"
        @dragover=${(e: DragEvent) => this.onCanvasDragOver(e)}
        @dragleave=${() => (this.dropHint = null)}
        @drop=${(e: DragEvent) => this.onCanvasDrop(e)}
        @pointermove=${(e: PointerEvent) => this.onPointerMove(e)}
        @pointerup=${(e: PointerEvent) => this.onPointerUp(e)}
        @pointercancel=${() => {
          this.drag = null;
          this.livePos = null;
          this.dropHint = null;
        }}
        @click=${(e: MouseEvent) => {
          if (e.target === e.currentTarget || (e.target as Element).classList?.contains("wb-stage")) {
            this.selectedNode = null;
            this.selectedEdge = null;
          }
        }}
      >
        <div class="wb-stage" style="width:${size.w}px;height:${size.h}px">
          <svg class="wb-links" width=${size.w} height=${size.h} aria-hidden="true">
            <defs>
              <marker id="wb-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M0,0 L10,5 L0,10 z" class="wb-arrowhead"></path>
              </marker>
            </defs>
            ${ls.map(
              (l) => svg`<g class="wb-link wb-link--${l.kind} ${this.selectedEdge === l.id ? "wb-link--sel" : ""}"
                @click=${(e: Event) => {
                  e.stopPropagation();
                  this.selectedEdge = l.id;
                  this.selectedNode = null;
                }}>
                <path class="wb-link-hit" d=${l.path}></path>
                <path class="wb-link-line" d=${l.path} marker-end=${l.kind === "edge" ? "url(#wb-arrow)" : ""}></path>
              </g>`,
            )}
            ${from && d?.kind === "connect"
              ? svg`<path class="wb-link-temp" d=${`M${from.x + NODE_W},${from.y + NODE_H / 2} L${d.x},${d.y}`}></path>`
              : nothing}
          </svg>
          ${repeat(
            shown.nodes,
            (n) => n.id,
            (n) => {
              const st = byNode.get(n.id);
              const lead = n.parentId ? graph.nodes.find((x) => x.id === n.parentId) : null;
              return html`<div
                class="wb-node ${this.selectedNode === n.id ? "wb-node--sel" : ""} ${this.dropHint === n.id ? "wb-node--drop" : ""} ${st ? `wb-node--${st}` : ""} ${this.livePos?.id === n.id ? "wb-node--dragging" : ""}"
                style="left:${n.x}px;top:${n.y}px;width:${NODE_W}px;height:${NODE_H}px"
                data-node=${n.id}
                role="button"
                tabindex="0"
                aria-label=${`${this.stepName(n)} — ${this.memberName(n.agentId)}${lead ? `, sub-agent of ${this.stepName(lead)}` : ""}`}
                @pointerdown=${(e: PointerEvent) => this.onNodePointerDown(e, n)}
                @keydown=${(e: KeyboardEvent) => {
                  if (e.key === "Enter") this.selectedNode = n.id;
                }}
              >
                ${this.avatar(n.agentId, "md")}
                <div class="wb-node-txt">
                  <div class="wb-node-title">${this.stepName(n)}</div>
                  <div class="wb-node-sub">@${n.agentId}${lead ? html` · under ${this.stepName(lead)}` : nothing}</div>
                </div>
                ${st ? html`<span class="wb-node-st wb-node-st--${st}" title=${st}>${st === "running" ? icons.loader : st === "done" ? icons.check : st === "error" ? icons.x : nothing}</span>` : nothing}
                <span
                  class="wb-handle"
                  title="Drag to another step to run it next"
                  @pointerdown=${(e: PointerEvent) => this.onHandlePointerDown(e, n)}
                ></span>
              </div>`;
            },
          )}
          ${shown.nodes.length === 0
            ? html`<div class="wb-drop-hint">Drag agents here to add steps · drop one onto a step to make it a sub-agent</div>`
            : nothing}
        </div>
      </div>
      <div class="wb-legend">
        <span><i class="wb-lg wb-lg--edge"></i>runs next</span>
        <span><i class="wb-lg wb-lg--hier"></i>lead → sub-agent (parallel)</span>
        ${order ? html`<span class="wb-order" title="Execution order">${order}</span>` : nothing}
      </div>
      ${sel ? this.renderInspector(graph, sel) : nothing}
      ${this.selectedEdge && !sel
        ? html`<div class="wb-inspector wb-inspector--row">
            <span>${this.selectedEdge.startsWith("h-") ? "Hierarchy link selected" : "Sequence link selected"}</span>
            <button class="wb-btn wb-btn--danger" @click=${() => this.removeSelectedEdge()}>${icons.trash}<span>${this.selectedEdge.startsWith("h-") ? "Detach" : "Remove link"}</span></button>
          </div>`
        : nothing}
      <div class="wb-run">
        <textarea
          class="wb-run-input"
          rows="2"
          placeholder="Optional input for the first step (e.g. what to build)…"
          .value=${this.runInput}
          @input=${(e: Event) => (this.runInput = (e.target as HTMLTextAreaElement).value)}
        ></textarea>
        <button
          class="wb-btn wb-btn--primary wb-run-btn"
          ?disabled=${this.starting || running || !this.connected || graph.nodes.length === 0}
          @click=${() => void this.run()}
        >
          ${this.starting || running ? icons.loader : icons.play}<span>${running ? "Running…" : "Run"}</span>
        </button>
      </div>
      ${run
        ? html`<div class="wb-last">
            <span class="wb-last-st wb-last-st--${run.status}">${run.status}</span>
            <span>Last run: ${run.steps.filter((s) => s.status === "done").length}/${run.steps.length} steps</span>
            ${run.error ? html`<span class="wb-last-err">${run.error}</span>` : nothing}
            <button
              class="wb-link-btn"
              @click=${() => this.dispatchEvent(new CustomEvent("show-run", { detail: { runId: run.id }, bubbles: true, composed: true }))}
            >
              View in chat ${icons.arrowRight}
            </button>
          </div>`
        : nothing}
    `;
  }

  private renderInspector(graph: WorkflowGraph, n: WorkflowNode) {
    const leads = graph.nodes.filter((x) => x.id !== n.id);
    return html`<div class="wb-inspector">
      <div class="wb-insp-row">
        <label class="wb-field">
          <span>Step name</span>
          <input
            .value=${n.label ?? ""}
            placeholder=${this.memberName(n.agentId)}
            @change=${(e: Event) => this.patchNode(n.id, { label: (e.target as HTMLInputElement).value.trim() || undefined })}
          />
        </label>
        <label class="wb-field">
          <span>Agent</span>
          <select @change=${(e: Event) => this.patchNode(n.id, { agentId: (e.target as HTMLSelectElement).value })}>
            ${this.members.map((m) => html`<option value=${m.id} ?selected=${m.id === n.agentId}>${m.name} (@${m.id})</option>`)}
            ${this.members.some((m) => m.id === n.agentId) ? nothing : html`<option selected value=${n.agentId}>@${n.agentId} (not in group)</option>`}
          </select>
        </label>
        <label class="wb-field">
          <span>Lead</span>
          <select
            @change=${(e: Event) => {
              const v = (e.target as HTMLSelectElement).value;
              try {
                this.update_(setParent(graph, n.id, v || null));
              } catch (err) {
                this.flash(String((err as Error).message), "err");
              }
            }}
          >
            <option value="" ?selected=${!n.parentId}>— none (top level)</option>
            ${leads.map((l) => html`<option value=${l.id} ?selected=${l.id === n.parentId}>${this.stepName(l)}</option>`)}
          </select>
        </label>
      </div>
      <label class="wb-field wb-field--wide">
        <span>Instruction for this step</span>
        <textarea
          rows="3"
          placeholder="What should this agent do? The previous steps' outputs are passed in automatically."
          .value=${n.prompt ?? ""}
          @change=${(e: Event) => this.patchNode(n.id, { prompt: (e.target as HTMLTextAreaElement).value })}
        ></textarea>
      </label>
      <div class="wb-insp-actions">
        <button class="wb-btn wb-btn--danger" @click=${() => this.removeSelected()}>${icons.trash}<span>Remove step</span></button>
        <button class="wb-btn" @click=${() => (this.selectedNode = null)}>Done</button>
      </div>
    </div>`;
  }

  static styles = css`
    :host {
      display: block;
      min-height: 0;
      color: var(--text);
      font-family: var(--glass-font, var(--font-body, inherit));
      --wb-surface: var(--g-surface, var(--card));
      --wb-surface-strong: var(--g-surface-strong, var(--bg-elevated));
      --wb-border: var(--g-border, var(--border));
      --wb-accent: var(--g-primary, var(--accent));
      --wb-muted: var(--muted, #8a8f98);
      --wb-radius: var(--g-radius-sm, 10px);
    }
    .wb { display: flex; flex-direction: column; gap: 10px; position: relative; }
    .wb-bar, .wb-head, .wb-palette, .wb-legend, .wb-run, .wb-last, .wb-insp-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .wb-tabs { display: flex; gap: 6px; flex: 1; min-width: 0; overflow-x: auto; scrollbar-width: none; }
    .wb-tab { white-space: nowrap; border: 1px solid var(--wb-border); background: transparent; color: var(--wb-muted); border-radius: 999px; padding: 6px 12px; font: inherit; font-size: 13px; cursor: pointer; }
    .wb-tab--on { color: var(--text); border-color: var(--wb-accent); background: color-mix(in srgb, var(--wb-accent) 12%, transparent); }
    .wb-btn { display: inline-flex; align-items: center; gap: 6px; min-height: 34px; padding: 6px 12px; border-radius: var(--wb-radius); border: 1px solid var(--wb-border); background: var(--wb-surface); color: var(--text); font: inherit; font-size: 13px; cursor: pointer; }
    .wb-btn svg { width: 15px; height: 15px; }
    .wb-btn:hover:not([disabled]) { border-color: var(--wb-accent); }
    .wb-btn[disabled] { opacity: 0.55; cursor: not-allowed; }
    .wb-btn--primary { background: var(--wb-accent); border-color: var(--wb-accent); color: var(--accent-foreground, #111); font-weight: 600; }
    .wb-btn--danger:hover:not([disabled]) { border-color: var(--danger, #e5484d); color: var(--danger, #e5484d); }
    .wb-name { flex: 1 1 180px; min-width: 0; font: inherit; font-size: 15px; font-weight: 600; color: var(--text); background: transparent; border: 1px solid transparent; border-radius: 8px; padding: 6px 8px; }
    .wb-name:hover, .wb-name:focus { border-color: var(--wb-border); outline: none; }
    .wb-save { font-size: 12px; color: var(--wb-muted); }
    .wb-save--dirty { color: var(--warning, #d9a400); }
    .wb-spacer { flex: 1; }
    .wb-palette-lbl { font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--wb-muted); }
    .wb-chip { display: inline-flex; align-items: center; gap: 6px; min-height: 36px; padding: 4px 12px 4px 4px; border-radius: 999px; border: 1px dashed var(--wb-border); background: var(--wb-surface); color: var(--text); font: inherit; font-size: 13px; cursor: grab; touch-action: manipulation; }
    .wb-chip:hover { border-color: var(--wb-accent); border-style: solid; }
    .wb-av { display: inline-grid; place-items: center; flex: none; border-radius: 50%; font-weight: 700; color: #fff; background: hsl(var(--h, 210) 55% 42%); object-fit: cover; }
    .wb-av--sm { width: 26px; height: 26px; font-size: 11px; }
    .wb-av--md { width: 34px; height: 34px; font-size: 13px; }
    .wb-canvas { position: relative; overflow: auto; border: 1px solid var(--wb-border); border-radius: var(--wb-radius); min-height: 320px; max-height: 56vh; background-color: var(--wb-surface-strong); background-image: radial-gradient(color-mix(in srgb, var(--text) 14%, transparent) 1px, transparent 1px); background-size: 22px 22px; outline: none; touch-action: pan-x pan-y; }
    .wb-stage { position: relative; }
    .wb-links { position: absolute; inset: 0; overflow: visible; }
    .wb-link { cursor: pointer; }
    .wb-link-hit { fill: none; stroke: transparent; stroke-width: 14; pointer-events: stroke; }
    .wb-link-line { fill: none; stroke: color-mix(in srgb, var(--text) 45%, transparent); stroke-width: 2; pointer-events: none; }
    .wb-link--hierarchy .wb-link-line { stroke-dasharray: 6 5; stroke: color-mix(in srgb, var(--wb-accent) 70%, transparent); }
    .wb-link--sel .wb-link-line { stroke: var(--wb-accent); stroke-width: 3; }
    .wb-arrowhead { fill: color-mix(in srgb, var(--text) 55%, transparent); }
    .wb-link-temp { fill: none; stroke: var(--wb-accent); stroke-width: 2; stroke-dasharray: 4 4; }
    .wb-node { position: absolute; box-sizing: border-box; display: flex; align-items: center; gap: 10px; padding: 10px 14px 10px 10px; border-radius: 12px; border: 1px solid var(--wb-border); background: var(--wb-surface); box-shadow: 0 4px 14px rgba(0, 0, 0, 0.18); cursor: grab; user-select: none; touch-action: none; transition: box-shadow 0.15s, border-color 0.15s; }
    .wb-node--dragging { cursor: grabbing; box-shadow: 0 10px 28px rgba(0, 0, 0, 0.3); z-index: 3; opacity: 0.92; }
    .wb-node--sel { border-color: var(--wb-accent); box-shadow: 0 0 0 2px color-mix(in srgb, var(--wb-accent) 35%, transparent); }
    .wb-node--drop { border-color: var(--wb-accent); border-style: dashed; background: color-mix(in srgb, var(--wb-accent) 14%, var(--wb-surface)); }
    .wb-node--running { border-color: var(--info, #3b82f6); }
    .wb-node--done { border-color: var(--ok, #30a46c); }
    .wb-node--error { border-color: var(--danger, #e5484d); }
    .wb-node-txt { min-width: 0; flex: 1; }
    .wb-node-title { font-weight: 600; font-size: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .wb-node-sub { font-size: 12px; color: var(--wb-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .wb-node-st { width: 20px; height: 20px; display: grid; place-items: center; border-radius: 50%; flex: none; }
    .wb-node-st svg { width: 13px; height: 13px; }
    .wb-node-st--running { color: var(--info, #3b82f6); }
    .wb-node-st--running svg { animation: wb-spin 1s linear infinite; }
    .wb-node-st--done { color: #fff; background: var(--ok, #30a46c); }
    .wb-node-st--error { color: #fff; background: var(--danger, #e5484d); }
    .wb-handle { position: absolute; right: -9px; top: 50%; width: 18px; height: 18px; margin-top: -9px; border-radius: 50%; background: var(--wb-accent); border: 3px solid var(--wb-surface-strong); cursor: crosshair; touch-action: none; }
    .wb-drop-hint { position: absolute; inset: 0; display: grid; place-items: center; padding: 24px; text-align: center; color: var(--wb-muted); font-size: 14px; pointer-events: none; }
    .wb-legend { font-size: 12px; color: var(--wb-muted); }
    .wb-lg { display: inline-block; width: 22px; height: 0; margin-right: 6px; vertical-align: middle; border-top: 2px solid color-mix(in srgb, var(--text) 45%, transparent); }
    .wb-lg--hier { border-top: 2px dashed var(--wb-accent); }
    .wb-order { margin-left: auto; color: var(--text); opacity: 0.8; overflow-wrap: anywhere; }
    .wb-inspector { display: flex; flex-direction: column; gap: 10px; padding: 12px; border: 1px solid var(--wb-border); border-radius: var(--wb-radius); background: var(--wb-surface); }
    .wb-inspector--row { flex-direction: row; align-items: center; justify-content: space-between; flex-wrap: wrap; font-size: 13px; }
    .wb-insp-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; }
    .wb-field { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--wb-muted); }
    .wb-field input, .wb-field select, .wb-field textarea, .wb-run-input { font: inherit; font-size: 14px; color: var(--text); background: var(--wb-surface-strong); border: 1px solid var(--wb-border); border-radius: 8px; padding: 8px 10px; min-height: 36px; box-sizing: border-box; width: 100%; }
    .wb-field textarea, .wb-run-input { resize: vertical; }
    .wb-run-input { flex: 1 1 220px; width: auto; }
    .wb-run-btn { min-height: 42px; padding: 0 18px; }
    .wb-run-btn svg { animation: none; }
    .wb-last { font-size: 13px; color: var(--wb-muted); }
    .wb-last-st { text-transform: uppercase; font-size: 11px; letter-spacing: 0.05em; padding: 2px 8px; border-radius: 999px; border: 1px solid var(--wb-border); color: var(--text); }
    .wb-last-st--running { border-color: var(--info, #3b82f6); }
    .wb-last-st--done { border-color: var(--ok, #30a46c); }
    .wb-last-st--error, .wb-last-st--aborted { border-color: var(--danger, #e5484d); }
    .wb-last-err { color: var(--danger, #e5484d); }
    .wb-link-btn { display: inline-flex; align-items: center; gap: 4px; margin-left: auto; background: none; border: none; color: var(--wb-accent); font: inherit; font-size: 13px; cursor: pointer; padding: 6px 2px; }
    .wb-link-btn svg { width: 14px; height: 14px; }
    .wb-empty { display: flex; flex-direction: column; align-items: center; text-align: center; gap: 10px; padding: 36px 16px; border: 1px dashed var(--wb-border); border-radius: var(--wb-radius); }
    .wb-empty p { max-width: 520px; margin: 0; color: var(--wb-muted); font-size: 14px; line-height: 1.5; }
    .wb-empty-ico svg { width: 34px; height: 34px; color: var(--wb-accent); }
    .wb-empty-title { font-size: 17px; font-weight: 600; }
    .wb-empty-actions { display: flex; gap: 8px; flex-wrap: wrap; justify-content: center; }
    .wb-notice { position: sticky; bottom: 8px; align-self: center; padding: 8px 14px; border-radius: 999px; font-size: 13px; background: var(--glass-solid, var(--bg-elevated, #16181d)); border: 1px solid var(--wb-border); box-shadow: 0 6px 18px rgba(0, 0, 0, 0.25); z-index: 5; }
    .wb-notice--err { border-color: var(--danger, #e5484d); color: var(--danger, #e5484d); }
    @keyframes wb-spin { to { transform: rotate(360deg); } }
    @media (max-width: 640px) {
      .wb-canvas { max-height: 46vh; min-height: 260px; }
      .wb-order { margin-left: 0; flex-basis: 100%; }
      .wb-run-btn { flex: 1 1 100%; justify-content: center; }
    }
  `;
}

declare global {
  interface HTMLElementTagNameMap {
    "ib-workflow-builder": WorkflowBuilder;
  }
}
