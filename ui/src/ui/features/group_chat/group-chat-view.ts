/**
 * <ib-group-chat> — an agent group conversation (Chat page, Grid panel).
 *
 * Data: the group is a standard session. History comes from chat.history on
 * the group key; membership/mode/workflows/runs from groupchat.get. Live
 * updates arrive as `groupchat` events (messages, turn start/end, workflow
 * run status) plus ordinary `chat` delta events on each member's session for
 * token streaming. Sending goes through groupchat.send; Stop → groupchat.abort.
 *
 * Composer parity with the 1:1 chat: the same <webchat-model-picker> (group
 * model + thinking, per-member overrides in <ib-group-run-settings>), image
 * attachments (button / paste, same wire shape as chat.send), group slash
 * commands with suggestions, and the chat panels (show_panel / plugin cards →
 * <chat-panel-card>, expandable to <chat-panel-modal>) each member's run made.
 */
import { LitElement, css, html, nothing, type PropertyValues } from "lit";
import { customElement, property, query, state } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import type { GatewayBrowserClient, GatewayEventFrame } from "../../gateway";
import type { GatewayAgentRow } from "../../types";
import { icons } from "../../icons";
import { toSanitizedMarkdownHtml } from "../../markdown";
import { GROUP_CHAT_EVENT, type GroupChatEvent, type WorkflowRunRecord } from "../../../../../src/shared/group-chat/types.js";
import "../workflow_builder/workflow-builder";
import "../../components/webchat-model-picker";
import { renderChatPanelRef } from "../../chat-panels";
import type { ChatAttachment } from "../../ui-types";
import { generateUUID } from "../../uuid";
import "./group-chat-dialog";
import "./group-context-ui";
import "./group-run-settings";
import "../../chat/chat-view-controls";
import type { GroupSettingsChange } from "./group-run-settings";
import type { GroupDialogValue } from "./group-chat-dialog";
import {
  MODE_LABELS,
  agentHue,
  applyChatEvent,
  applyMention,
  filterMessages,
  initials,
  loadViewState,
  mentionQueryAt,
  mergeMessages,
  runLabel,
  saveViewState,
  settingsSummary,
  shortModel,
  slashSuggestions,
  suggestMembers,
  supportsComposerParity,
  toApiAttachments,
  toDisplayMessages,
  type DisplayMessage,
  type GroupDescription,
  type GroupMemberInfo,
  type LiveTurn,
} from "./logic";

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

import { isSecureSessionKey, SecureModeController } from "../../secure-mode";
import {
  CHAT_ATTACHMENT_ACCEPT,
  isSupportedChatFile,
  normalizedFileMime,
  prepareChatAttachment,
  type AttachmentPreparationProgress,
} from "../../chat/attachments";
import {
  handleSnippetCopy,
  markdownToPlainText,
  withSnippetCopyButtons,
} from "../../chat/snippet-copy";
import "../../components/chat-attachment-chip";
import "../../components/response-actions";

@customElement("ib-group-chat")
export class GroupChatView extends LitElement {
  @property({ attribute: false }) client: GatewayBrowserClient | null = null;
  @property({ type: Boolean }) connected = false;
  @property() sessionKey = "";
  /** agents.list rows (names, avatars, the member picker). */
  @property({ attribute: false }) agents: GatewayAgentRow[] = [];
  /** Show a sidebar toggle in the header (Chat page with the chat list collapsed). */
  @property({ type: Boolean }) showMenuButton = false;
  /**
   * Header width/zoom controls (shared chat-view-prefs). Set by the Chat page;
   * the grid panel leaves it off and keeps the default column.
   */
  @property({ type: String, reflect: true }) viewControls: "" | "full" | "compact" = "";
  /** Compact header for small Grid panels. */
  @property({ type: Boolean }) compact = false;

  @state() private group: GroupDescription | null = null;
  /** Composer Secure Mode switch was pressed in a normal group: explain + offer a new secure group. */
  @state() private secureNote: "normal" | "secure" | null = null;
  private secureMode = new SecureModeController(this);
  @state() private messages: DisplayMessage[] = [];
  @state() private loading = false;
  @state() private error: string | null = null;
  @state() private live: Map<string, LiveTurn> = new Map();
  @state() private draft = "";
  @state() private tab: "chat" | "workflows" = "chat";
  @state() private runFilter: string | null = null;
  @state() private mention: { start: number; query: string; index: number } | null = null;
  @state() private renaming = false;
  @state() private editOpen = false;
  @state() private editBusy = false;
  @state() private editError: string | null = null;
  @state() private sending = false;
  @state() private roundActive = false;
  @state() private attachments: ChatAttachment[] = [];
  @state() private copiedId: string | null = null;
  @state() private settingsOpen = false;
  @state() private settingsError: string | null = null;
  @state() private slashIndex = 0;

  @query(".gc-scroll") private scroller?: HTMLElement;
  @query("textarea.gc-input") private input?: HTMLTextAreaElement;
  @query("input.gc-file") private fileInput?: HTMLInputElement;

  private unsub: (() => void) | null = null;
  private subscribedClient: GatewayBrowserClient | null = null;
  private loadedKey: string | null = null;
  private stick = true;
  private pendingScrollRestore: number | null = null;
  private saveTimer: number | null = null;
  private endedTurns = new Map<string, number>();
  private refreshTimer: number | null = null;

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.persistView();
    this.unsub?.();
    this.unsub = null;
    this.subscribedClient = null;
    if (this.saveTimer) window.clearTimeout(this.saveTimer);
    if (this.refreshTimer) window.clearTimeout(this.refreshTimer);
    this.resizeObs?.disconnect();
    this.resizeObs = null;
    this.observedCol = null;
  }

  connectedCallback(): void {
    super.connectedCallback();
    // Re-attached (e.g. tab switch) — resubscribe and reload.
    if (this.client && !this.unsub) this.subscribe();
    if (this.loadedKey) {
      this.loadedKey = null;
      this.requestUpdate();
    }
  }

  private subscribe() {
    this.unsub?.();
    this.unsub = null;
    this.subscribedClient = this.client;
    if (this.client && typeof this.client.subscribe === "function") {
      this.unsub = this.client.subscribe((evt) => this.onEvent(evt));
    }
  }

  protected willUpdate(changed: PropertyValues): void {
    if (changed.has("client") && this.client !== this.subscribedClient) this.subscribe();
    if (changed.has("sessionKey")) {
      this.secureNote = null;
      const prev = changed.get("sessionKey") as string | undefined;
      if (prev) this.persistView(prev);
      const v = loadViewState(this.sessionKey, storage());
      this.draft = v.draft;
      this.runFilter = v.runFilter;
      this.tab = v.tab;
      this.pendingScrollRestore = v.scrollTop;
      this.stick = v.scrollTop == null;
      this.group = null;
      this.messages = [];
      this.live = new Map();
      this.error = null;
      this.mention = null;
      this.renaming = false;
      this.loadedKey = null;
    }
    const served = !this.client?.supports || this.client.supports("groupchat.get");
    if (this.client && this.connected && served && this.sessionKey && this.loadedKey !== this.sessionKey) {
      this.loadedKey = this.sessionKey;
      void this.load();
    }
  }

  /** Chat panel cards and images load after render — keep a stuck transcript at the bottom as they grow. */
  private resizeObs: ResizeObserver | null = null;
  private observedCol: Element | null = null;

  protected updated(): void {
    const el = this.scroller;
    if (!el) return;
    const col = el.firstElementChild;
    if (col && col !== this.observedCol && typeof ResizeObserver !== "undefined") {
      this.resizeObs ??= new ResizeObserver(() => {
        const s = this.scroller;
        if (s && this.stick && this.pendingScrollRestore == null) s.scrollTop = s.scrollHeight;
      });
      if (this.observedCol) this.resizeObs.unobserve(this.observedCol);
      this.resizeObs.observe(col);
      this.observedCol = col;
    }
    if (this.pendingScrollRestore != null && this.messages.length > 0) {
      el.scrollTop = this.pendingScrollRestore;
      this.pendingScrollRestore = null;
      return;
    }
    if (this.stick) el.scrollTop = el.scrollHeight;
  }

  private persistView(key = this.sessionKey) {
    if (!key) return;
    const el = this.scroller;
    const atBottom = !el || el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    saveViewState(
      key,
      { draft: this.draft, scrollTop: atBottom || !el ? null : el.scrollTop, runFilter: this.runFilter, tab: this.tab },
      storage(),
    );
  }

  private schedulePersist() {
    if (this.saveTimer) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => this.persistView(), 400);
  }

  // ── data ───────────────────────────────────────────────────────────────

  private async load() {
    const key = this.sessionKey;
    if (!this.client || !key) return;
    this.loading = true;
    try {
      const [g, h] = await Promise.all([
        this.client.request<GroupDescription>("groupchat.get", { key }),
        this.client.request<{ messages?: unknown[] }>("chat.history", { sessionKey: key, limit: 1000 }),
      ]);
      if (key !== this.sessionKey) return;
      this.group = g;
      this.messages = toDisplayMessages(Array.isArray(h?.messages) ? h.messages : []);
      this.roundActive = g.busy;
      // Turns already running when the view opened (reload mid-round).
      const live = new Map<string, LiveTurn>();
      for (const t of g.activeTurns ?? []) live.set(t.runId, { ...t, text: "" });
      this.live = live;
      if (this.runFilter && !g.runs.some((r) => r.id === this.runFilter)) this.runFilter = null;
      this.error = null;
    } catch (err) {
      if (key === this.sessionKey) this.error = String((err as Error)?.message ?? err).replace(/^Error:\s*/, "");
    } finally {
      if (key === this.sessionKey) this.loading = false;
    }
  }

  private async refreshGroup() {
    if (!this.client || !this.sessionKey) return;
    try {
      const g = await this.client.request<GroupDescription>("groupchat.get", { key: this.sessionKey });
      this.group = g;
      this.roundActive = g.busy;
    } catch {
      /* transient */
    }
  }

  private scheduleRefresh(ms = 250) {
    if (this.refreshTimer) window.clearTimeout(this.refreshTimer);
    this.refreshTimer = window.setTimeout(() => void this.refreshGroup(), ms);
  }

  private onEvent(evt: GatewayEventFrame) {
    if (evt.event === "chat") {
      if (this.live.size === 0) return;
      const next = applyChatEvent(this.live, evt.payload as Parameters<typeof applyChatEvent>[1]);
      if (next !== this.live) this.live = next;
      return;
    }
    if (evt.event !== GROUP_CHAT_EVENT) return;
    const e = evt.payload as GroupChatEvent | undefined;
    if (!e || e.groupKey !== this.sessionKey) return;
    switch (e.type) {
      case "message": {
        const msgs = toDisplayMessages([e.message]);
        this.messages = mergeMessages(this.messages, msgs);
        const agentId = e.message.groupChat?.agentId;
        if (agentId) {
          // The reply landed — drop that agent's finished streaming bubble.
          const next = new Map(this.live);
          for (const [id, t] of next) if (t.agentId === agentId && this.endedTurns.has(id)) next.delete(id);
          this.live = next;
        }
        break;
      }
      case "turn.start": {
        const next = new Map(this.live);
        next.set(e.runId, { runId: e.runId, agentId: e.agentId, memberKey: e.memberKey, text: "", workflowRunId: e.workflowRunId });
        this.live = next;
        this.roundActive = true;
        break;
      }
      case "turn.end": {
        this.endedTurns.set(e.runId, Date.now());
        // Keep the bubble until the reply message arrives (or briefly, if the agent passed).
        window.setTimeout(() => {
          if (!this.live.has(e.runId)) return;
          const next = new Map(this.live);
          next.delete(e.runId);
          this.live = next;
          this.endedTurns.delete(e.runId);
        }, e.ok ? 2500 : 300);
        break;
      }
      case "round.start":
        this.roundActive = true;
        break;
      case "round.end":
        this.scheduleRefresh(150);
        break;
      case "workflow": {
        if (!this.group) break;
        const runs = this.group.runs.filter((r) => r.id !== e.run.id);
        this.group = { ...this.group, runs: [...runs, e.run] };
        if (e.run.status === "running") this.roundActive = true;
        else this.scheduleRefresh(150);
        break;
      }
      case "meta":
        this.scheduleRefresh(50);
        break;
    }
  }

  // ── members ────────────────────────────────────────────────────────────

  private memberInfos(): GroupMemberInfo[] {
    return (this.group?.members ?? []).map((m) => {
      const row = this.agents.find((a) => a.id === m.id);
      return { id: m.id, name: row?.identity?.name || row?.name || m.name, avatarUrl: row?.identity?.avatarUrl ?? null };
    });
  }

  private agentName(id: string | undefined, fallback?: string): string {
    if (!id) return fallback ?? "Agent";
    const row = this.agents.find((a) => a.id === id);
    return row?.identity?.name || row?.name || this.group?.members.find((m) => m.id === id)?.name || fallback || id;
  }

  private avatar(id: string | undefined, name: string, cls = "gc-av") {
    const url = id ? this.agents.find((a) => a.id === id)?.identity?.avatarUrl : null;
    if (url) return html`<img class=${cls} src=${url} alt="" draggable="false" />`;
    return html`<span class=${cls} style="--h:${agentHue(id ?? name)}" aria-hidden="true">${initials(name)}</span>`;
  }

  // ── actions ────────────────────────────────────────────────────────────

  private async send(textOverride?: string) {
    const text = (textOverride ?? this.draft).trim();
    const atts = textOverride === undefined ? this.attachments : [];
    if (atts.some((a) => ["reading", "uploading"].includes(a.extractionStatus ?? ""))) {
      this.error = "Wait for attachments to finish uploading.";
      return;
    }
    if (atts.some((a) => a.extractionStatus === "failed")) {
      this.error = "Retry or remove failed attachments before sending.";
      return;
    }
    if ((!text && atts.length === 0) || !this.client || !this.connected || this.sending) return;
    this.sending = true;
    this.stick = true;
    try {
      const res = await this.client.request<{ agents?: string[]; command?: { ok: boolean; reply: string } }>("groupchat.send", {
        key: this.sessionKey,
        message: text,
        ...(atts.length ? { attachments: toApiAttachments(atts) } : {}),
      });
      if (textOverride === undefined) {
        this.draft = "";
        this.attachments = [];
      }
      this.mention = null;
      if (this.input) this.input.style.height = "";
      if (res?.command) {
        // /model, /think, /mode: the group changed — pull the new settings.
        this.scheduleRefresh(50);
        if (!res.command.ok) this.error = res.command.reply;
      } else this.roundActive = true;
      this.persistView();
      this.dispatchEvent(new CustomEvent("group-activity", { bubbles: true, composed: true }));
    } catch (err) {
      this.error = String((err as Error)?.message ?? err).replace(/^Error:\s*/, "");
    } finally {
      this.sending = false;
    }
  }

  private async stop() {
    if (!this.client) return;
    try {
      await this.client.request("groupchat.abort", { key: this.sessionKey });
    } catch (err) {
      this.error = String((err as Error)?.message ?? err);
    }
    this.scheduleRefresh(300);
  }

  private async setMode(mode: GroupDescription["mode"]) {
    if (!this.client || !this.group || mode === this.group.mode) return;
    const prev = this.group;
    this.group = { ...prev, mode };
    try {
      this.group = await this.client.request<GroupDescription>("groupchat.update", { key: this.sessionKey, mode });
    } catch (err) {
      this.group = prev;
      this.error = String((err as Error)?.message ?? err);
    }
  }

  private async changeSettings(c: GroupSettingsChange) {
    if (!this.client || !this.group) return;
    this.settingsError = null;
    const params: Record<string, unknown> = { key: this.sessionKey };
    if (c.agentId) params.memberSettings = { [c.agentId]: c.patch };
    else params.settings = c.patch ?? { model: null, thinkingLevel: null };
    try {
      this.group = await this.client.request<GroupDescription>("groupchat.update", params);
    } catch (err) {
      const msg = String((err as Error)?.message ?? err).replace(/^Error:\s*/, "");
      if (this.settingsOpen) this.settingsError = msg;
      else this.error = msg;
    }
  }

  private agentModels(): Record<string, string | null> {
    const out: Record<string, string | null> = {};
    for (const m of this.group?.members ?? []) {
      const row = this.agents.find((a) => a.id === m.id) as (GatewayAgentRow & { model?: string | null }) | undefined;
      out[m.id] = row?.model ?? null;
    }
    return out;
  }

  private updateAttachment(id: string, patch: Partial<ChatAttachment>) {
    this.attachments = this.attachments.map((attachment) =>
      attachment.id === id ? { ...attachment, ...patch } : attachment,
    );
  }

  private async prepareFile(file: File, id = generateUUID()) {
    if (!this.client) return;
    if (!this.attachments.some((attachment) => attachment.id === id)) {
      this.attachments = [
        ...this.attachments,
        {
          id,
          dataUrl: "",
          mimeType: normalizedFileMime(file),
          fileName: file.name,
          size: file.size,
          sourceFile: file,
          extractionStatus: "reading",
          uploadProgress: 0,
        },
      ];
    } else {
      this.updateAttachment(id, {
        extractionStatus: "reading",
        uploadProgress: 0,
        error: undefined,
      });
    }
    const onProgress = (progress: AttachmentPreparationProgress) => {
      this.updateAttachment(id, {
        extractionStatus: progress.phase === "error" ? "failed" : progress.phase,
        uploadProgress: progress.total
          ? Math.round((progress.loaded / progress.total) * 100)
          : undefined,
        error: progress.message,
      });
    };
    try {
      const ready = await prepareChatAttachment({
        file,
        client: this.client,
        sessionKey: this.sessionKey,
        onProgress,
      });
      this.attachments = this.attachments.map((attachment) =>
        attachment.id === id ? { ...ready, id } : attachment,
      );
    } catch (error) {
      this.updateAttachment(id, {
        extractionStatus: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
      this.error = error instanceof Error ? error.message : String(error);
    }
  }

  private addFiles(files: FileList | File[] | null) {
    if (!files) return;
    for (const file of Array.from(files)) {
      if (!isSupportedChatFile(file)) {
        this.error = `Unsupported file: ${file.name}. Use PDF, DOCX, XLSX, PPTX, TXT/MD, CSV, image, or video.`;
        continue;
      }
      void this.prepareFile(file);
    }
  }

  private onPaste(e: ClipboardEvent) {
    const files = Array.from(e.clipboardData?.files ?? []).filter(isSupportedChatFile);
    if (files.length) {
      e.preventDefault();
      this.addFiles(files);
    }
  }

  private async copyMessage(markdown: string, id: string) {
    const text = markdownToPlainText(markdown, toSanitizedMarkdownHtml(markdown));
    try {
      await navigator.clipboard.writeText(text);
      this.copiedId = id;
      window.setTimeout(() => {
        if (this.copiedId === id) this.copiedId = null;
      }, 1500);
    } catch {
      this.error = "Copy failed.";
    }
  }

  private pickSlash(name: string) {
    this.draft = `/${name} `;
    this.slashIndex = 0;
    void this.updateComplete.then(() => {
      const el = this.input;
      el?.focus();
      el?.setSelectionRange(this.draft.length, this.draft.length);
    });
  }

  private async rename(title: string) {
    this.renaming = false;
    const t = title.trim();
    if (!this.client || !this.group || !t || t === this.group.title) return;
    this.group = { ...this.group, title: t };
    try {
      await this.client.request("sessions.patch", { key: this.sessionKey, label: t });
      this.dispatchEvent(new CustomEvent("group-renamed", { detail: { key: this.sessionKey, title: t }, bubbles: true, composed: true }));
    } catch (err) {
      this.error = String((err as Error)?.message ?? err);
      void this.refreshGroup();
    }
  }

  private async saveMembers(v: GroupDialogValue) {
    if (!this.client) return;
    this.editBusy = true;
    this.editError = null;
    try {
      this.group = await this.client.request<GroupDescription>("groupchat.update", {
        key: this.sessionKey,
        members: v.members,
        mode: v.mode,
        moderatorId: v.moderatorId,
        settings: { model: v.settings?.model ?? null, thinkingLevel: v.settings?.thinkingLevel ?? null },
        ...(v.title ? { title: v.title } : {}),
        // Only send the binding when it changed (null clears it).
        ...(JSON.stringify(v.binding ?? null) !== JSON.stringify(this.group?.binding ?? null)
          ? { binding: v.binding }
          : {}),
      });
      this.editOpen = false;
      if (v.title) {
        this.dispatchEvent(new CustomEvent("group-renamed", { detail: { key: this.sessionKey, title: v.title }, bubbles: true, composed: true }));
      }
    } catch (err) {
      this.editError = String((err as Error)?.message ?? err).replace(/^Error:\s*/, "");
    } finally {
      this.editBusy = false;
    }
  }

  private showRun(runId: string | null) {
    this.runFilter = runId;
    this.tab = "chat";
    this.stick = true;
    this.persistView();
  }

  // ── composer ───────────────────────────────────────────────────────────

  private onInput(e: Event) {
    const el = e.target as HTMLTextAreaElement;
    this.draft = el.value;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
    const q = mentionQueryAt(el.value, el.selectionStart ?? el.value.length);
    this.mention = q ? { ...q, index: 0 } : null;
    this.slashIndex = 0;
    this.schedulePersist();
  }

  private pickMention(id: string) {
    const el = this.input;
    if (!el || !this.mention) return;
    const caret = el.selectionStart ?? this.draft.length;
    const res = applyMention(this.draft, this.mention.start, caret, id);
    this.draft = res.text;
    this.mention = null;
    void this.updateComplete.then(() => {
      el.focus();
      el.setSelectionRange(res.caret, res.caret);
    });
  }

  private insertMention(id: string) {
    const d = this.draft;
    const sep = d && !/\s$/.test(d) ? " " : "";
    this.draft = `${d}${sep}@${id} `;
    void this.updateComplete.then(() => {
      const el = this.input;
      el?.focus();
      el?.setSelectionRange(this.draft.length, this.draft.length);
    });
  }

  private onKey(e: KeyboardEvent) {
    const cmds = supportsComposerParity(this.group) ? slashSuggestions(this.draft) : [];
    if (cmds.length) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const d = e.key === "ArrowDown" ? 1 : -1;
        this.slashIndex = (this.slashIndex + d + cmds.length) % cmds.length;
        return;
      }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey && cmds[this.slashIndex]?.name !== this.draft.slice(1))) {
        e.preventDefault();
        this.pickSlash(cmds[this.slashIndex]?.name ?? cmds[0].name);
        return;
      }
    }
    const sugg = this.mention ? suggestMembers(this.memberInfos(), this.mention.query) : [];
    if (this.mention && sugg.length) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const d = e.key === "ArrowDown" ? 1 : -1;
        this.mention = { ...this.mention, index: (this.mention.index + d + sugg.length) % sugg.length };
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        this.pickMention(sugg[this.mention.index]?.id ?? sugg[0].id);
        return;
      }
      if (e.key === "Escape") {
        this.mention = null;
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      void this.send();
    }
  }

  /** Last wheel / touch / key / pointer gesture on the transcript (ms). */
  private userScrollAt = 0;

  private onScroll() {
    const el = this.scroller;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    // Only the user may unstick the transcript. Content that mounts late (chat
    // panel cards, images) can move scrollTop on its own; snap back instead.
    if (!atBottom && this.stick && Date.now() - this.userScrollAt > 800) {
      el.scrollTop = el.scrollHeight;
      return;
    }
    this.stick = atBottom;
    this.schedulePersist();
  }

  // ── render ─────────────────────────────────────────────────────────────

  /** Lock badge + compact Secure Mode switch in the group composer. */
  private renderSecureComposerBits() {
    if (this.secureMode.state.supported === false) return nothing;
    const secure = isSecureSessionKey(this.sessionKey);
    const active = this.secureMode.active;
    return html`
      ${secure
        ? html`<span class="gc-secure-badge ${active ? "" : "gc-secure-badge--locked"}" data-secure-composer-badge>
            ${icons.lock}<span>${active ? "Secure group" : "Secure group locked"}</span>
          </span>`
        : nothing}
      <ib-secure-toggle
        compact
        mode="custom"
        class="gc-secure-toggle"
        data-secure-surface="group-chat"
        .on=${secure}
        @secure-toggle=${() => (this.secureNote = this.secureNote ? null : secure ? "secure" : "normal")}
      ></ib-secure-toggle>
    `;
  }

  private renderSecureNote() {
    if (!this.secureNote) return nothing;
    const secure = this.secureNote === "secure";
    return html`<div class="gc-secure-note" role="status">
      <span class="gc-secure-note-ico">${icons.lock}</span>
      <span class="gc-secure-note-txt">${secure
        ? html`This group is in the Secure Mode lane for good: local models only, encrypted, no network tools.${this.secureMode.active ? nothing : html` Turn Secure Mode on to send.`}`
        : html`A group's lane is fixed when it is created. Secure groups are created separately — this one stays normal.`}</span>
      ${secure
        ? nothing
        : html`<button class="gc-btn" data-secure-new-group @click=${() => {
            this.secureNote = null;
            this.dispatchEvent(new CustomEvent("secure-group-new", { bubbles: true, composed: true }));
          }}>${icons.plus}<span>New secure group</span></button>`}
      <button class="gc-secure-note-x" aria-label="Dismiss" @click=${() => (this.secureNote = null)}>${icons.x}</button>
    </div>`;
  }

  render() {
    if (!this.sessionKey) return nothing;
    if (this.client?.supports && !this.client.supports("groupchat.get")) {
      return html`<div class="gc"><div class="gc-empty">
        <div class="gc-empty-title">Group chats need a gateway update</div>
        <p>This gateway was started before group chats were installed. Restart the gateway to open this group.</p>
      </div></div>`;
    }
    const g = this.group;
    const busy = this.roundActive || this.live.size > 0 || Boolean(g?.runs.some((r) => r.status === "running"));
    return html`
      <div class="gc ${this.compact ? "gc--compact" : ""}">
        ${this.renderHeader(g, busy)}
        ${this.error ? html`<div class="gc-error" role="alert">${this.error}<button aria-label="Dismiss" @click=${() => (this.error = null)}>${icons.x}</button></div>` : nothing}
        ${this.tab === "workflows" && g
          ? html`<div class="gc-wf-wrap">
              <ib-workflow-builder
                .client=${this.client}
                .connected=${this.connected}
                .groupKey=${this.sessionKey}
                .members=${this.memberInfos()}
                .workflows=${g.workflows}
                .runs=${g.runs}
                @show-run=${(e: CustomEvent<{ runId: string }>) => this.showRun(e.detail.runId)}
                @run-started=${(e: CustomEvent<{ runId: string }>) => this.showRun(e.detail.runId)}
              ></ib-workflow-builder>
            </div>`
          : this.renderChat(g, busy)}
        ${this.editOpen && g
          ? html`<ib-group-chat-dialog
              heading="Edit group"
              .secureOption=${false}
              submitLabel="Save"
              .agents=${this.agents}
              .initial=${{ title: g.title, members: g.members.map((m) => m.id), mode: g.mode, moderatorId: g.moderatorId, binding: g.binding ?? null, settings: g.settings }}
              .client=${this.client}
              .connected=${this.connected}
              .repo=${g.repo ?? null}
              .busy=${this.editBusy}
              .error=${this.editError}
              @cancel=${() => (this.editOpen = false)}
              @submit=${(e: CustomEvent<GroupDialogValue>) => void this.saveMembers(e.detail)}
            ></ib-group-chat-dialog>`
          : nothing}
        ${this.settingsOpen && g
          ? html`<ib-group-run-settings
              .client=${this.client}
              .connected=${this.connected}
              .group=${g}
              .members=${this.memberInfos()}
              .agentModels=${this.agentModels()}
              .mobile=${typeof window !== "undefined" && window.innerWidth <= 640}
              .error=${this.settingsError}
              @close=${() => (this.settingsOpen = false)}
              @settings-change=${(e: CustomEvent<GroupSettingsChange>) => void this.changeSettings(e.detail)}
            ></ib-group-run-settings>`
          : nothing}
      </div>
    `;
  }

  private renderHeader(g: GroupDescription | null, busy: boolean) {
    const members = this.memberInfos();
    return html`
      <header class="gc-head">
        ${this.showMenuButton
          ? html`<button class="gc-icon" title="Open chats" aria-label="Open chats" @click=${() => this.dispatchEvent(new CustomEvent("toggle-sidebar", { bubbles: true, composed: true }))}>${icons.menu}</button>`
          : nothing}
        <div class="gc-stack" aria-hidden="true">
          ${members.slice(0, 4).map((m) => this.avatar(m.id, m.name, "gc-av gc-av--stack"))}
          ${members.length > 4 ? html`<span class="gc-av gc-av--stack gc-av--more">+${members.length - 4}</span>` : nothing}
        </div>
        <div class="gc-title-wrap">
          ${this.renaming
            ? html`<input
                class="gc-rename"
                aria-label="Group name"
                .value=${g?.title ?? ""}
                @keydown=${(e: KeyboardEvent) => {
                  if (e.key === "Enter") void this.rename((e.target as HTMLInputElement).value);
                  if (e.key === "Escape") this.renaming = false;
                }}
                @blur=${(e: Event) => void this.rename((e.target as HTMLInputElement).value)}
              />`
            : html`<button class="gc-title" title="Rename group" @click=${() => {
                this.renaming = true;
                void this.updateComplete.then(() => this.renderRoot.querySelector<HTMLInputElement>(".gc-rename")?.select());
              }}>${g?.title ?? "Group chat"}</button>`}
          <div class="gc-sub">
            ${members.length} agent${members.length === 1 ? "" : "s"}
            ${g && g.binding !== undefined
              ? html`<ib-group-binding-chip
                  .binding=${g.binding ?? null}
                  .repo=${g.repo ?? null}
                  @edit-binding=${() => {
                    this.editError = null;
                    this.editOpen = true;
                  }}
                ></ib-group-binding-chip>`
              : nothing}
            ${busy ? html`<span class="gc-live"><i></i>${this.live.size ? `${[...this.live.values()].map((t) => this.agentName(t.agentId)).join(", ")} replying` : "working"}</span>` : nothing}
          </div>
        </div>
        <div class="gc-head-actions">
          ${this.viewControls
            ? html`<ib-chat-view-controls ?compact=${this.viewControls === "compact"}></ib-chat-view-controls>`
            : nothing}
          ${g
            ? html`<label class="gc-mode" title=${MODE_LABELS[g.mode].hint}>
                <span class="gc-sr">Who replies</span>
                <select aria-label="Who replies" @change=${(e: Event) => void this.setMode((e.target as HTMLSelectElement).value as GroupDescription["mode"])}>
                  ${(Object.keys(MODE_LABELS) as GroupDescription["mode"][]).map((m) => html`<option value=${m} ?selected=${g.mode === m}>${MODE_LABELS[m].label}</option>`)}
                </select>
              </label>`
            : nothing}
          ${g && supportsComposerParity(g)
            ? html`<webchat-model-picker
                class="gc-picker"
                compact
                align="end"
                data-learn-id="group-model-picker"
                .client=${this.client}
                .connected=${this.connected}
                .value=${g.settings?.model ?? null}
                .defaultModel=${null}
                .defaultLabel=${"Each agent's model"}
                .overridden=${Boolean(g.settings?.model)}
                .thinkingLevel=${g.settings?.thinkingLevel ?? null}
                .mobile=${typeof window !== "undefined" && window.innerWidth <= 640}
                @model-select=${(e: CustomEvent<{ model: string | null }>) => void this.changeSettings({ patch: { model: e.detail.model } })}
                @thinking-select=${(e: CustomEvent<{ level: string | null }>) => void this.changeSettings({ patch: { thinkingLevel: e.detail.level } })}
              ></webchat-model-picker>
              <button class="gc-icon gc-icon--settings ${Object.keys(g.memberSettings ?? {}).length ? "gc-icon--dot" : ""}" title=${`Models & thinking — ${settingsSummary(g)}`} aria-label="Models and thinking per member" data-testid="gc-run-settings" @click=${() => {
                this.settingsError = null;
                this.settingsOpen = true;
              }}>${icons.sliders}</button>`
            : nothing}
          <button class="gc-icon" title="Members & settings" aria-label="Members and settings" @click=${() => {
            this.editError = null;
            this.editOpen = true;
          }}>${icons.users}</button>
        </div>
        <div class="gc-tabs" role="tablist">
          <button role="tab" class="gc-tab ${this.tab === "chat" ? "gc-tab--on" : ""}" aria-selected=${this.tab === "chat" ? "true" : "false"} @click=${() => {
            this.tab = "chat";
            this.stick = true;
            this.persistView();
          }}>${icons.messageSquare}<span>Chat</span></button>
          <button role="tab" class="gc-tab ${this.tab === "workflows" ? "gc-tab--on" : ""}" aria-selected=${this.tab === "workflows" ? "true" : "false"} @click=${() => {
            this.persistView();
            this.tab = "workflows";
            this.persistView();
          }}>${icons.network}<span>Workflows</span>${g?.workflows.length ? html`<b class="gc-count">${g.workflows.length}</b>` : nothing}</button>
        </div>
      </header>
    `;
  }

  private renderRunCard(run: WorkflowRunRecord) {
    return html`<div class="gc-run gc-run--${run.status}">
      <div class="gc-run-top">
        <span class="gc-run-ico">${run.status === "running" ? icons.loader : run.status === "done" ? icons.checkCircle : icons.alertCircle}</span>
        <span class="gc-run-name">${run.workflowName}</span>
        <span class="gc-run-st">${run.status}</span>
      </div>
      <ol class="gc-steps">
        ${run.steps.map(
          (s) => html`<li class="gc-step gc-step--${s.status}" title=${s.error ?? s.status}>
            ${this.avatar(s.agentId, this.agentName(s.agentId), "gc-av gc-av--xs")}
            <span>${s.label || this.agentName(s.agentId)}</span>
          </li>`,
        )}
      </ol>
    </div>`;
  }

  private renderChat(g: GroupDescription | null, busy: boolean) {
    const runs = g?.runs ?? [];
    const filtered = filterMessages(this.messages, this.runFilter ? { runId: this.runFilter } : null);
    const filterRun = this.runFilter ? runs.find((r) => r.id === this.runFilter) : null;
    const runningRun = [...runs].reverse().find((r) => r.status === "running");
    const cardRun = filterRun ?? runningRun ?? null;
    const liveTurns = [...this.live.values()].filter((t) => !this.runFilter || t.workflowRunId === this.runFilter);
    const members = this.memberInfos();
    const sugg = this.mention ? suggestMembers(members, this.mention.query) : [];
    const parity = supportsComposerParity(g);
    const cmds = parity ? slashSuggestions(this.draft) : [];
    const attachmentsReady = this.attachments.every(
      (attachment) =>
        !["reading", "uploading", "failed"].includes(attachment.extractionStatus ?? ""),
    );
    return html`
      ${runs.length
        ? html`<div class="gc-filter">
            <span class="gc-filter-lbl">${icons.filter}</span>
            <select aria-label="Filter by workflow run" @change=${(e: Event) => this.showRun((e.target as HTMLSelectElement).value || null)}>
              <option value="" ?selected=${!this.runFilter}>All messages</option>
              ${[...runs].reverse().map((r) => html`<option value=${r.id} ?selected=${r.id === this.runFilter}>${runLabel(r)}</option>`)}
            </select>
            ${this.runFilter ? html`<button class="gc-chip" @click=${() => this.showRun(null)}>${icons.x}<span>Clear</span></button>` : nothing}
          </div>`
        : nothing}
      <div
        class="gc-scroll"
        @scroll=${() => this.onScroll()}
        @wheel=${() => (this.userScrollAt = Date.now())}
        @touchmove=${() => (this.userScrollAt = Date.now())}
        @pointerdown=${() => (this.userScrollAt = Date.now())}
        @keydown=${() => (this.userScrollAt = Date.now())}
      >
        <div class="gc-col">
          ${cardRun ? this.renderRunCard(cardRun) : nothing}
          ${this.loading && this.messages.length === 0
            ? html`<div class="gc-skel"><div></div><div></div><div></div></div>`
            : nothing}
          ${!this.loading && filtered.length === 0 && liveTurns.length === 0
            ? html`<div class="gc-empty">
                <div class="gc-empty-stack">${members.slice(0, 5).map((m) => this.avatar(m.id, m.name, "gc-av gc-av--lg"))}</div>
                <div class="gc-empty-title">${this.runFilter ? "No messages for this run yet" : `Say hello to ${members.map((m) => m.name).join(", ") || "the group"}`}</div>
                ${this.runFilter
                  ? nothing
                  : html`<p>${g ? MODE_LABELS[g.mode].hint : ""} @mention an agent to ask just them.</p>`}
              </div>`
            : nothing}
          ${repeat(filtered, (m) => m.id, (m) => this.renderMessage(m))}
          ${liveTurns.map(
            (t) => html`<div class="gc-msg gc-msg--agent gc-msg--live">
              ${this.avatar(t.agentId, this.agentName(t.agentId))}
              <div class="gc-msg-body">
                <div class="gc-msg-head"><span class="gc-name">${this.agentName(t.agentId)}</span>${
                  t.workflowRunId
                    ? html`
                        <span class="gc-tag">workflow</span>
                      `
                    : nothing
                }</div>
                ${
                  t.text
                    ? html`<div class="gc-md" @click=${handleSnippetCopy}>${unsafeHTML(
                        withSnippetCopyButtons(toSanitizedMarkdownHtml(t.text)),
                      )}</div><span class="gc-caret"></span>`
                    : html`<div class="gc-typing" aria-label="${this.agentName(t.agentId)} is thinking"><i></i><i></i><i></i></div>`
                }
              </div>
            </div>`,
          )}
        </div>
      </div>
      <div class="gc-dock">
        <div class="gc-col">
          ${members.length > 1
            ? html`<div class="gc-quick" aria-label="Mention an agent">
                ${members.map((m) => html`<button class="gc-chip" title=${`Ask only ${m.name}`} @click=${() => this.insertMention(m.id)}>@${m.id}</button>`)}
              </div>`
            : nothing}
          ${this.renderSecureNote()}
          <div
            class="gc-composer ${isSecureSessionKey(this.sessionKey) ? "gc-composer--secure" : ""}"
            @dragover=${(e: DragEvent) => {
              if (e.dataTransfer?.types.includes("Files")) {
                e.preventDefault();
                e.dataTransfer.dropEffect = "copy";
              }
            }}
            @drop=${(e: DragEvent) => {
              if (e.dataTransfer?.files?.length) {
                e.preventDefault();
                this.addFiles(e.dataTransfer.files);
              }
            }}
          >
            ${
              cmds.length
                ? html`<div class="gc-suggest gc-suggest--cmd" role="listbox" aria-label="Group commands">
                  ${cmds.map(
                    (c, i) => html`<button
                      role="option"
                      aria-selected=${i === this.slashIndex ? "true" : "false"}
                      class="gc-sugg ${i === this.slashIndex ? "gc-sugg--on" : ""}"
                      @mousedown=${(e: Event) => {
                        e.preventDefault();
                        this.pickSlash(c.name);
                      }}
                    >
                      <span class="gc-cmd-ico">${icons.terminal}</span>
                      <span class="gc-cmd-txt"><span class="gc-cmd-usage">${c.usage}</span><span class="gc-cmd-desc">${c.description}</span></span>
                    </button>`,
                  )}
                </div>`
              : nothing}
            ${this.attachments.length
              ? html`<div class="gc-atts">
                  ${this.attachments.map(
                    (a) => html`<ib-chat-attachment-chip
                      .attachment=${a}
                      .client=${this.client}
                      .sessionKey=${this.sessionKey}
                      @attachment-remove=${() => (this.attachments = this.attachments.filter((x) => x.id !== a.id))}
                      @attachment-update=${(e: CustomEvent<ChatAttachment>) => this.updateAttachment(a.id, e.detail)}
                      @attachment-status=${(e: CustomEvent<ChatAttachment>) => this.updateAttachment(a.id, e.detail)}
                      @attachment-retry=${() => a.sourceFile && void this.prepareFile(a.sourceFile, a.id)}
                    ></ib-chat-attachment-chip>`,
                  )}
                </div>`
              : nothing}
            ${sugg.length
              ? html`<div class="gc-suggest" role="listbox">
                  ${sugg.map(
                    (m, i) => html`<button
                      role="option"
                      aria-selected=${i === this.mention?.index ? "true" : "false"}
                      class="gc-sugg ${i === this.mention?.index ? "gc-sugg--on" : ""}"
                      @mousedown=${(e: Event) => {
                        e.preventDefault();
                        this.pickMention(m.id);
                      }}
                    >
                      ${m.id === "all" ? html`<span class="gc-av gc-av--xs gc-av--all">${icons.users}</span>` : this.avatar(m.id, m.name, "gc-av gc-av--xs")}
                      <span>${m.name}</span><span class="gc-sugg-id">@${m.id}</span>
                    </button>`,
                  )}
                </div>`
              : nothing}
            <textarea
              class="gc-input"
              rows="1"
              aria-label="Message the group"
              placeholder=${this.connected ? (parity ? "Message the group · @ to direct · / for commands" : "Message the group — @mention to direct") : "Connecting to gateway…"}
              .value=${this.draft}
              @input=${(e: Event) => this.onInput(e)}
              @keydown=${(e: KeyboardEvent) => this.onKey(e)}
              @paste=${(e: ClipboardEvent) => parity && this.onPaste(e)}
              @blur=${() => window.setTimeout(() => (this.mention = null), 150)}
            ></textarea>
            <div class="gc-composer-row">
              ${
                parity
                  ? html`<button class="gc-tool" title="Attach document, image, or video" aria-label="Attach document, image, or video" @click=${() => this.fileInput?.click()}>${icons.paperclip}</button>
              <input
                class="gc-file"
                type="file"
                accept=${CHAT_ATTACHMENT_ACCEPT}
                multiple
                hidden
                @change=${(e: Event) => {
                  const el = e.target as HTMLInputElement;
                  this.addFiles(el.files);
                  el.value = "";
                }}
              />
              <button class="gc-tool" title="Group commands" aria-label="Group commands" @click=${() => {
                this.draft = "/";
                this.slashIndex = 0;
                void this.updateComplete.then(() => this.input?.focus());
              }}>${icons.terminal}</button>`
                : nothing}
              ${this.renderSecureComposerBits()}
              <span class="gc-hint">${busy ? "You can keep typing — agents see new messages on their next turn." : "Enter to send · Shift+Enter for newline"}</span>
              ${
                busy
                  ? html`<button class="gc-btn gc-btn--stop" title="Stop all agents" @click=${() => void this.stop()}>${icons.stop}<span>Stop</span></button>`
                  : nothing
              }
              <button class="gc-send" title="Send" aria-label="Send" ?disabled=${(!this.draft.trim() && this.attachments.length === 0) || !this.connected || this.sending || !attachmentsReady} @click=${() => void this.send()}>${icons.arrowUp}</button>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  private renderMessage(m: DisplayMessage) {
    if (m.kind === "status") {
      return html`<div class="gc-status">
        <span>${m.text}</span>
        ${m.activity || m.unverified ? html`<ib-group-activity class="gc-ledger" .activity=${m.activity ?? []} .unverified=${m.unverified ?? []}></ib-group-activity>` : nothing}
        ${m.workflowRunId && this.runFilter !== m.workflowRunId
          ? html`<button class="gc-linkbtn" @click=${() => this.showRun(m.workflowRunId!)}>Show run</button>`
          : nothing}
      </div>`;
    }
    if (m.kind === "user") {
      return html`<div class="gc-msg gc-msg--user">
        <div class="gc-user-col">
          ${m.images.length ? html`<div class="gc-user-imgs">${m.images.map(
            (src) => html`<span class="gc-img-wrap"><img src=${src} alt="attachment" /><button
                type="button"
                class="gc-img-ocr"
                title="Extracted text and description (local OCR)"
                aria-label="Show extracted text and description"
                @click=${() =>
                  void import("../../components/file-context-panel").then((mod) =>
                    mod.openAttachmentContext(src, "Group chat attachment", this.sessionKey),
                  )}
              >${icons.scrollText}<span>Text</span></button></span>`,
          )}</div>` : nothing}
          ${m.text ? html`<div class="gc-bubble ${m.text.startsWith("/") ? "gc-bubble--cmd" : ""}">${m.text}</div>` : nothing}
        </div>
      </div>`;
    }
    const name = this.agentName(m.agentId, m.agentName);
    const time = m.ts ? new Date(m.ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "";
    return html`<div class="gc-msg gc-msg--agent ${m.error ? "gc-msg--err" : ""}">
      ${this.avatar(m.agentId, name)}
      <div class="gc-msg-body">
        <div class="gc-msg-head">
          <span class="gc-name">${name}</span>
          <span class="gc-handle">@${m.agentId ?? "agent"}</span>
          ${m.workflowRunId ? html`<button class="gc-tag" title="Show this workflow run" @click=${() => this.showRun(m.workflowRunId!)}>workflow</button>` : nothing}
          ${m.model ? html`<span class="gc-model" title=${`Replied with ${m.model}`}>${shortModel(m.model)}</span>` : nothing}
          <span class="gc-time">${time}</span>
        </div>
        ${
          m.text
            ? html`
          <div class="gc-md" @click=${handleSnippetCopy}>${unsafeHTML(
            withSnippetCopyButtons(toSanitizedMarkdownHtml(m.text)),
          )}</div>
          <div class="gc-response-actions">
            <button class="gc-copy" type="button" title="Copy as plain text" aria-label="Copy as plain text" @click=${() => void this.copyMessage(m.text, m.id)}>${this.copiedId === m.id ? icons.check : icons.copy}</button>
            <ib-response-actions
              .markdown=${m.text}
              .sessionKey=${this.sessionKey}
              .secure=${isSecureSessionKey(this.sessionKey)}
              .client=${this.client}
            ></ib-response-actions>
          </div>`
            : nothing
        }
        ${m.panels.length ? html`<div class="gc-panels">${m.panels.map((ref) => renderChatPanelRef(ref))}</div>` : nothing}
        ${m.activity || m.unverified ? html`<ib-group-activity .activity=${m.activity ?? []} .unverified=${m.unverified ?? []}></ib-group-activity>` : nothing}
      </div>
    </div>`;
  }

  static styles = css`
    :host {
      display: block;
      height: 100%;
      min-height: 0;
      color: var(--text);
      font-family: var(--glass-font, var(--font-body, inherit));
      --gc-surface: var(--g-surface, var(--card));
      --gc-surface-strong: var(--g-surface-strong, var(--bg-elevated));
      --gc-border: var(--g-border, var(--border));
      --gc-accent: var(--g-primary, var(--accent));
      --gc-muted: var(--muted, #8a8f98);
      --gc-radius: var(--g-radius, 14px);
    }
    .gc { display: flex; flex-direction: column; height: 100%; min-height: 0; position: relative; }
    .gc-head { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 10px; padding: 10px 16px; border-bottom: 1px solid var(--gc-border); }
    .gc-icon { width: 38px; height: 38px; display: grid; place-items: center; flex: none; border-radius: 10px; border: 1px solid transparent; background: transparent; color: var(--text); cursor: pointer; }
    .gc-icon:hover { border-color: var(--gc-border); background: var(--gc-surface); }
    .gc-icon svg { width: 18px; height: 18px; }
    .gc-stack { display: flex; flex: none; }
    .gc-av { width: 34px; height: 34px; flex: none; border-radius: 50%; display: inline-grid; place-items: center; font-size: 12px; font-weight: 700; color: #fff; background: hsl(var(--h, 210) 55% 42%); object-fit: cover; user-select: none; }
    .gc-av--stack { width: 30px; height: 30px; font-size: 11px; border: 2px solid var(--bg, #0d0f12); margin-left: -8px; }
    .gc-av--stack:first-child { margin-left: 0; }
    .gc-av--more { background: var(--gc-surface-strong); color: var(--gc-muted); }
    .gc-av--xs { width: 22px; height: 22px; font-size: 9px; }
    .gc-av--lg { width: 44px; height: 44px; font-size: 15px; margin-left: -10px; border: 3px solid var(--bg, #0d0f12); }
    .gc-av--lg:first-child { margin-left: 0; }
    .gc-av--all { background: var(--gc-accent); color: var(--accent-foreground, #111); }
    .gc-av--all svg { width: 13px; height: 13px; }
    .gc-title-wrap { flex: 1 1 160px; min-width: 0; }
    .gc-title { display: block; max-width: 100%; padding: 0; border: none; background: none; color: var(--text); font: inherit; font-size: 16px; font-weight: 650; text-align: left; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; cursor: text; }
    .gc-rename { width: 100%; font: inherit; font-size: 16px; font-weight: 650; color: var(--text); background: var(--gc-surface); border: 1px solid var(--gc-accent); border-radius: 8px; padding: 4px 8px; box-sizing: border-box; }
    .gc-sub { display: flex; align-items: center; flex-wrap: wrap; gap: 4px 10px; font-size: 12px; color: var(--gc-muted); min-width: 0; }
    .gc-live { display: inline-flex; align-items: center; gap: 6px; color: var(--gc-accent); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .gc-live i { width: 7px; height: 7px; border-radius: 50%; background: currentColor; animation: gc-pulse 1.2s ease-in-out infinite; }
    .gc-head-actions { display: flex; align-items: center; gap: 6px; }
    .gc-mode select { font: inherit; font-size: 13px; color: var(--text); background: var(--gc-surface); border: 1px solid var(--gc-border); border-radius: 10px; padding: 0 10px; min-height: 38px; cursor: pointer; }
    .gc-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
    .gc-tabs { display: flex; gap: 4px; flex-basis: 100%; }
    .gc-tab { display: inline-flex; align-items: center; gap: 6px; min-height: 36px; padding: 0 14px; border-radius: 999px; border: 1px solid transparent; background: transparent; color: var(--gc-muted); font: inherit; font-size: 13px; cursor: pointer; }
    .gc-tab svg { width: 15px; height: 15px; }
    .gc-tab--on { color: var(--text); background: var(--gc-surface); border-color: var(--gc-border); }
    .gc-count { font-size: 11px; padding: 1px 7px; border-radius: 999px; background: color-mix(in srgb, var(--gc-accent) 22%, transparent); color: var(--text); }
    .gc-error { display: flex; align-items: center; gap: 8px; justify-content: space-between; margin: 8px 16px 0; padding: 8px 12px; border-radius: 10px; border: 1px solid var(--danger, #e5484d); color: var(--danger, #e5484d); font-size: 13px; }
    .gc-error button { border: none; background: none; color: inherit; cursor: pointer; width: 28px; height: 28px; display: grid; place-items: center; }
    .gc-error svg { width: 14px; height: 14px; }
    .gc-filter { display: flex; align-items: center; gap: 8px; padding: 8px 16px 0; }
    .gc-filter-lbl svg { width: 15px; height: 15px; color: var(--gc-muted); }
    .gc-filter select { flex: 0 1 360px; min-width: 0; font: inherit; font-size: 13px; color: var(--text); background: var(--gc-surface); border: 1px solid var(--gc-border); border-radius: 10px; padding: 0 10px; min-height: 36px; }
    .gc-scroll { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; }
    .gc-col { width: 100%; max-width: 860px; margin: 0 auto; padding: 14px 16px; box-sizing: border-box; display: flex; flex-direction: column; gap: 14px; }
    .gc-wf-wrap { flex: 1; min-height: 0; overflow: auto; padding: 14px 16px; }
    .gc-msg { display: flex; gap: 10px; align-items: flex-start; min-width: 0; }
    .gc-msg--user { justify-content: flex-end; }
    .gc-bubble { max-width: min(78%, 620px); padding: 10px 14px; border-radius: 18px 18px 4px 18px; background: color-mix(in srgb, var(--gc-accent) 16%, var(--gc-surface)); border: 1px solid color-mix(in srgb, var(--gc-accent) 28%, transparent); white-space: pre-wrap; overflow-wrap: anywhere; font-size: 15px; line-height: 1.5; }
    .gc-msg-body { min-width: 0; flex: 1; }
    .gc-msg-head { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; margin-bottom: 2px; }
    .gc-name { font-weight: 650; font-size: 14px; }
    .gc-handle, .gc-time { font-size: 12px; color: var(--gc-muted); }
    .gc-time { margin-left: auto; }
    .gc-tag { font: inherit; font-size: 11px; padding: 1px 8px; border-radius: 999px; border: 1px solid var(--gc-border); background: transparent; color: var(--gc-muted); cursor: pointer; }
    .gc-md { font-size: 15px; line-height: 1.6; overflow-wrap: anywhere; }
    .gc-md > :first-child { margin-top: 0; }
    .gc-md > :last-child { margin-bottom: 0; }
    .gc-md pre { overflow-x: auto; padding: 10px 12px; border-radius: 10px; background: var(--gc-surface-strong); border: 1px solid var(--gc-border); font-size: 13px; }
    .gc-md code { font-size: 0.92em; }
    .md-copyable--block { display: block; position: relative; }
    .md-copyable--block > pre { padding-top: 36px; }
    .md-copyable--inline { display: inline-flex; align-items: center; gap: 4px; }
    .md-copy-button { position: absolute; top: 6px; right: 6px; z-index: 1; padding: 3px 9px; border: 1px solid var(--gc-border); border-radius: 6px; background: var(--gc-surface); color: var(--gc-muted); font: inherit; font-size: 10px; cursor: pointer; }
    .md-copy-button:hover, .md-copy-button:focus-visible, .md-copy-button[data-copied="1"] { color: var(--gc-accent); border-color: var(--gc-accent); outline: none; }
    .md-copy-button--inline { position: static; padding: 1px 5px; font-size: 9px; opacity: .18; }
    .md-copyable--inline:hover .md-copy-button--inline, .md-copy-button--inline:focus-visible, .md-copy-button--inline[data-copied="1"] { opacity: 1; }
    .gc-md table { display: block; overflow-x: auto; border-collapse: collapse; }
    .gc-md td, .gc-md th { border: 1px solid var(--gc-border); padding: 4px 8px; }
    .gc-msg--err .gc-md { color: var(--danger, #e5484d); }
    .gc-status { display: flex; align-items: center; justify-content: center; gap: 8px; flex-wrap: wrap; text-align: center; font-size: 12px; color: var(--gc-muted); }
    .gc-ledger { flex-basis: 100%; text-align: left; max-width: 640px; }
    .gc-status > span { padding: 4px 12px; border-radius: 999px; border: 1px dashed var(--gc-border); }
    .gc-linkbtn { font: inherit; font-size: 12px; border: none; background: none; color: var(--gc-accent); cursor: pointer; padding: 4px; }
    .gc-typing { display: inline-flex; gap: 4px; padding: 10px 0; }
    .gc-typing i { width: 7px; height: 7px; border-radius: 50%; background: var(--gc-muted); animation: gc-bounce 1.2s infinite; }
    .gc-typing i:nth-child(2) { animation-delay: 0.15s; }
    .gc-typing i:nth-child(3) { animation-delay: 0.3s; }
    .gc-caret { display: inline-block; width: 7px; height: 15px; background: var(--gc-accent); vertical-align: text-bottom; animation: gc-pulse 1s steps(2) infinite; }
    .gc-run { border: 1px solid var(--gc-border); border-radius: 12px; padding: 10px 12px; background: var(--gc-surface); }
    .gc-run--running { border-color: color-mix(in srgb, var(--info, #3b82f6) 60%, transparent); }
    .gc-run--done { border-color: color-mix(in srgb, var(--ok, #30a46c) 60%, transparent); }
    .gc-run--error, .gc-run--aborted { border-color: color-mix(in srgb, var(--danger, #e5484d) 60%, transparent); }
    .gc-run-top { display: flex; align-items: center; gap: 8px; font-size: 14px; }
    .gc-run-ico svg { width: 16px; height: 16px; }
    .gc-run--running .gc-run-ico svg { animation: gc-spin 1s linear infinite; color: var(--info, #3b82f6); }
    .gc-run--done .gc-run-ico { color: var(--ok, #30a46c); }
    .gc-run-name { font-weight: 600; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .gc-run-st { font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--gc-muted); }
    .gc-steps { display: flex; flex-wrap: wrap; gap: 6px; list-style: none; margin: 8px 0 0; padding: 0; counter-reset: step; }
    .gc-step { display: inline-flex; align-items: center; gap: 6px; padding: 3px 10px 3px 3px; border-radius: 999px; border: 1px solid var(--gc-border); font-size: 12px; }
    .gc-step--running { border-color: var(--info, #3b82f6); }
    .gc-step--done { border-color: var(--ok, #30a46c); }
    .gc-step--error { border-color: var(--danger, #e5484d); }
    .gc-step--pending, .gc-step--skipped { opacity: 0.6; }
    .gc-empty { display: flex; flex-direction: column; align-items: center; text-align: center; gap: 8px; padding: 48px 12px; color: var(--gc-muted); }
    .gc-empty-stack { display: flex; margin-bottom: 4px; }
    .gc-empty-title { color: var(--text); font-size: 18px; font-weight: 600; }
    .gc-empty p { margin: 0; max-width: 460px; font-size: 14px; }
    .gc-skel { display: flex; flex-direction: column; gap: 10px; }
    .gc-skel div { height: 54px; border-radius: 12px; background: var(--gc-surface); animation: gc-pulse 1.4s ease-in-out infinite; }
    .gc-dock { border-top: 1px solid var(--gc-border); padding-bottom: env(safe-area-inset-bottom, 0); }
    .gc-dock .gc-col { padding-top: 10px; padding-bottom: 12px; gap: 8px; }
    .gc-quick { display: flex; gap: 6px; overflow-x: auto; scrollbar-width: none; }
    .gc-chip { display: inline-flex; align-items: center; gap: 4px; flex: none; min-height: 32px; padding: 0 12px; border-radius: 999px; border: 1px solid var(--gc-border); background: var(--gc-surface); color: var(--gc-muted); font: inherit; font-size: 13px; cursor: pointer; }
    .gc-chip:hover { color: var(--text); border-color: var(--gc-accent); }
    .gc-chip svg { width: 13px; height: 13px; }
    .gc-picker { flex: none; max-width: 260px; }
    .gc-icon--dot { position: relative; }
    .gc-icon--dot::after { content: ""; position: absolute; top: 7px; right: 7px; width: 7px; height: 7px; border-radius: 50%; background: var(--gc-accent); box-shadow: 0 0 0 2px var(--bg, #0d0f12); }
    .gc-tool { width: 34px; height: 34px; flex: none; display: grid; place-items: center; border-radius: 9px; border: 1px solid transparent; background: transparent; color: var(--gc-muted); cursor: pointer; }
    .gc-tool:hover { color: var(--text); border-color: var(--gc-border); background: var(--gc-surface-strong); }
    .gc-tool svg { width: 17px; height: 17px; }
    .gc-atts { display: flex; flex-wrap: wrap; gap: 8px; padding: 2px 0 8px; }
    .gc-att { position: relative; width: 64px; height: 64px; border-radius: 10px; overflow: hidden; border: 1px solid var(--gc-border); }
    .gc-att img { width: 100%; height: 100%; object-fit: cover; display: block; }
    .gc-att-x { position: absolute; top: 3px; right: 3px; width: 22px; height: 22px; display: grid; place-items: center; border-radius: 50%; border: none; background: rgba(0, 0, 0, 0.65); color: #fff; cursor: pointer; }
    .gc-att-x svg { width: 12px; height: 12px; }
    .gc-user-col { display: flex; flex-direction: column; align-items: flex-end; gap: 6px; max-width: min(78%, 620px); }
    .gc-user-col .gc-bubble { max-width: 100%; }
    .gc-user-imgs { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 6px; }
    .gc-img-wrap { position: relative; display: inline-flex; }
    .gc-img-ocr { position: absolute; right: 6px; bottom: 6px; display: inline-flex; align-items: center; gap: 4px; height: 24px; padding: 0 8px; border-radius: 999px; border: 1px solid color-mix(in srgb, var(--wg-gold, #d9b45a) 45%, transparent); background: rgba(10, 11, 15, 0.72); color: var(--wg-gold, #d9b45a); font-size: 11px; font-weight: 600; cursor: pointer; }
    .gc-img-ocr svg { width: 12px; height: 12px; }
    .gc-img-ocr:focus-visible { outline: 2px solid var(--wg-gold, #d9b45a); outline-offset: 2px; }
    .gc-user-imgs img { min-width: 72px; min-height: 72px; max-width: 220px; max-height: 220px; border-radius: 12px; border: 1px solid var(--gc-border); object-fit: cover; background: var(--gc-surface-strong); }
    .gc-bubble--cmd { font-family: var(--font-mono, ui-monospace, monospace); font-size: 13px; }
    .gc-model { font-size: 11px; padding: 1px 8px; border-radius: 999px; color: var(--gc-muted); border: 1px solid var(--gc-border); background: var(--gc-surface); max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .gc-panels { display: flex; flex-direction: column; gap: 8px; margin-top: 8px; }
    .gc-cmd-ico svg { width: 14px; height: 14px; color: var(--gc-accent); }
    .gc-cmd-txt { display: flex; flex-direction: column; min-width: 0; flex: 1; padding: 3px 0; }
    .gc-cmd-usage, .gc-cmd-desc { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .gc-cmd-usage { font-family: var(--font-mono, ui-monospace, monospace); font-size: 12px; }
    .gc-cmd-desc { font-size: 12px; color: var(--gc-muted); }
    .gc-suggest--cmd { right: 8px; }
    .gc-composer { position: relative; border: 1px solid var(--gc-border); border-radius: var(--gc-radius); background: var(--gc-surface); padding: 8px 10px; }
    .gc-composer:focus-within { border-color: var(--gc-accent); }
    .gc-input { width: 100%; box-sizing: border-box; resize: none; border: none; outline: none; background: transparent; color: var(--text); font: inherit; font-size: 16px; line-height: 1.5; min-height: 26px; max-height: 200px; padding: 4px 2px; }
    .gc-composer-row { display: flex; align-items: center; gap: 8px; }
    .gc-composer--secure, .gc-composer--secure:focus-within { border-color: var(--ib-secure-ring, rgba(52, 211, 153, 0.5)); box-shadow: var(--ib-secure-glow, 0 0 0 1px rgba(52, 211, 153, 0.35)); }
    .gc-secure-badge { display: inline-flex; align-items: center; gap: 5px; flex: none; padding: 2px 9px; border-radius: 999px; font-size: 11.5px; font-weight: 600; white-space: nowrap; color: var(--ib-secure, #34d399); background: var(--ib-secure-soft, rgba(52, 211, 153, 0.13)); border: 1px solid var(--ib-secure-ring, rgba(52, 211, 153, 0.5)); }
    .gc-secure-badge svg { width: 12px; height: 12px; }
    .gc-secure-badge--locked { color: var(--gc-muted); background: transparent; border-style: dashed; }
    .gc-secure-toggle { flex: none; }
    .gc-secure-note { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; padding: 8px 10px; border-radius: 12px; font-size: 12.5px; line-height: 1.4; border: 1px solid var(--ib-secure-ring, rgba(52, 211, 153, 0.5)); background: var(--ib-secure-soft, rgba(52, 211, 153, 0.13)); }
    .gc-secure-note-ico { display: inline-flex; color: var(--ib-secure, #34d399); }
    .gc-secure-note-ico svg, .gc-secure-note-x svg { width: 14px; height: 14px; }
    .gc-secure-note-txt { flex: 1; min-width: 0; }
    .gc-secure-note-x { display: inline-flex; background: none; border: 0; padding: 4px; cursor: pointer; color: inherit; }
    .gc-hint { flex: 1; font-size: 12px; color: var(--gc-muted); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .gc-btn { display: inline-flex; align-items: center; gap: 6px; min-height: 36px; padding: 0 12px; border-radius: 10px; border: 1px solid var(--gc-border); background: transparent; color: var(--text); font: inherit; font-size: 13px; cursor: pointer; }
    .gc-btn svg { width: 14px; height: 14px; }
    .gc-btn--stop:hover { border-color: var(--danger, #e5484d); color: var(--danger, #e5484d); }
    .gc-send { width: 40px; height: 40px; display: grid; place-items: center; border-radius: 50%; border: none; background: var(--gc-accent); color: var(--accent-foreground, #111); cursor: pointer; flex: none; }
    .gc-send[disabled] { opacity: 0.4; cursor: not-allowed; }
    .gc-send svg { width: 18px; height: 18px; }
    .gc-suggest { position: absolute; left: 8px; bottom: calc(100% + 6px); min-width: 220px; max-width: calc(100% - 16px); padding: 4px; border-radius: 12px; border: 1px solid var(--gc-border); background: var(--glass-solid, var(--bg-elevated, #16181d)); box-shadow: 0 12px 30px rgba(0, 0, 0, 0.45); z-index: 5; display: flex; flex-direction: column; }
    .gc-sugg { display: flex; align-items: center; gap: 8px; min-height: 38px; padding: 4px 10px; border: none; border-radius: 8px; background: transparent; color: var(--text); font: inherit; font-size: 14px; text-align: left; cursor: pointer; }
    .gc-sugg--on, .gc-sugg:hover { background: color-mix(in srgb, var(--gc-accent) 16%, transparent); }
    .gc-sugg-id { margin-left: auto; color: var(--gc-muted); font-size: 12px; }
    .gc--compact .gc-head { padding: 6px 10px; }
    .gc--compact .gc-col { padding: 10px; }
    /* Width + text zoom from the Chat page (chat/chat-view-prefs.ts). The
       vars are unset in the grid panel, so the defaults keep that layout. */
    .gc-col { max-width: var(--chat-col-max, 860px); }
    @media (min-width: 641px) {
      :host([viewcontrols="full"]) .gc-col { padding-left: clamp(20px, 2vw, 32px); padding-right: clamp(20px, 2vw, 32px); }
      :host([viewcontrols="full"]) .gc-bubble { max-width: min(78%, calc(960px * var(--chat-tz, 1))); }
    }
    .gc-bubble, .gc-md { font-size: calc(15px * var(--chat-tz, 1)); }
    .gc-bubble--cmd, .gc-md pre { font-size: calc(13px * var(--chat-tz, 1)); }
    .gc-name { font-size: calc(14px * var(--chat-tz, 1)); }
    .gc-handle, .gc-time { font-size: calc(12px * var(--chat-tz, 1)); }
    .gc-input { font-size: calc(16px * var(--chat-tz, 1)); }
    @keyframes gc-pulse { 50% { opacity: 0.35; } }
    @keyframes gc-bounce { 0%, 80%, 100% { transform: translateY(0); opacity: 0.5; } 40% { transform: translateY(-4px); opacity: 1; } }
    @keyframes gc-spin { to { transform: rotate(360deg); } }
    @media (max-width: 640px) {
      .gc-head { padding: 8px 12px; }
      .gc-stack { display: none; }
      .gc-mode select { max-width: 150px; }
      .gc-col { padding: 12px; }
      .gc-wf-wrap { padding: 12px; }
      .gc-bubble { max-width: 88%; }
      .gc-hint { display: none; }
      .gc-composer-row { justify-content: flex-end; }
      .gc-composer-row .gc-file + .gc-tool { margin-right: auto; }
      .gc-picker { max-width: 150px; }
      .gc-user-imgs img { max-width: 160px; max-height: 160px; }
    }
  `;
}

declare global {
  interface HTMLElementTagNameMap {
    "ib-group-chat": GroupChatView;
  }
}
