import { LitElement, css, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { GatewayBrowserClient } from "../gateway";
import { icons } from "../icons";
import { generateUUID } from "../uuid";

type RequestClient = Pick<GatewayBrowserClient, "request">;
type Project = { id: string; name?: string; title?: string };
type Workflow = { id: string; name: string; body?: string };
type Folder = { path: string; name: string; isDirectory?: boolean };
type View = "menu" | "workspace" | "workflow" | "run" | "custom";

const AI_ACTIONS: Array<{ id: string; label: string; prompt: string }> = [
  {
    id: "summarize",
    label: "Summarize",
    prompt: "Summarize the response below clearly and concisely.",
  },
  {
    id: "tasks",
    label: "Turn into tasks",
    prompt:
      "Turn the response below into actionable Kanban tasks. Use the kanban tool to create them, then link me to the created tasks.",
  },
  {
    id: "draft",
    label: "Draft email/message",
    prompt:
      "Turn the response below into a polished email or message. Ask one concise question only if the audience or tone is genuinely ambiguous.",
  },
  {
    id: "translate",
    label: "Translate",
    prompt:
      "Translate the response below. If no target language was specified in the conversation, ask which language to use.",
  },
  {
    id: "checklist",
    label: "Make checklist",
    prompt: "Turn the response below into a practical markdown checklist.",
  },
];

function responseTitle(markdown: string): string {
  const first = markdown
    .split("\n")
    .map((line) =>
      line
        .replace(/^\s{0,3}#{1,6}\s+/, "")
        .replace(/[*_`>#-]/g, "")
        .trim(),
    )
    .find(Boolean);
  return (first || "Agent response").slice(0, 90);
}

function slug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 70) || `agent-response-${Date.now()}`
  );
}

@customElement("ib-response-actions")
export class ResponseActions extends LitElement {
  static styles = css`
    :host {
      display: inline-flex;
    }
    button,
    input,
    select,
    textarea {
      font: inherit;
    }
    .plus {
      width: 30px;
      height: 30px;
      display: grid;
      place-items: center;
      border: 1px solid var(--g-border, rgba(255, 255, 255, 0.14));
      border-radius: 8px;
      background: var(--g-surface, rgba(18, 18, 22, 0.86));
      color: var(--muted, #aaa);
      cursor: pointer;
      font-size: 18px;
      line-height: 1;
    }
    .plus:hover,
    .plus:focus-visible {
      color: var(--g-primary, #d6b35a);
      border-color: color-mix(in srgb, var(--g-primary, #d6b35a) 55%, transparent);
      outline: none;
    }
    .scrim {
      position: fixed;
      inset: 0;
      z-index: 2500;
      background: rgba(0, 0, 0, 0.76);
      display: grid;
      place-items: center;
      padding: 18px;
    }
    .modal {
      width: min(620px, 100%);
      max-height: min(760px, 90vh);
      overflow: auto;
      border: 1px solid color-mix(in srgb, var(--g-primary, #d6b35a) 28%, rgba(255, 255, 255, 0.12));
      border-radius: 18px;
      background:
        linear-gradient(180deg, rgba(214, 179, 90, 0.035), transparent 110px),
        #111217;
      box-shadow:
        0 30px 90px rgba(0, 0, 0, 0.65),
        inset 0 1px rgba(255, 255, 255, 0.05);
      color: var(--text, #eee);
    }
    header {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 16px 18px;
      border-bottom: 1px solid var(--g-border, rgba(255, 255, 255, 0.1));
      position: sticky;
      top: 0;
      background: inherit;
      z-index: 1;
    }
    header h2 {
      margin: 0;
      flex: 1;
      font-size: 15px;
      letter-spacing: 0.02em;
    }
    .close,
    .back {
      width: 31px;
      height: 31px;
      display: grid;
      place-items: center;
      border: 0;
      border-radius: 8px;
      background: transparent;
      color: var(--muted, #aaa);
      cursor: pointer;
    }
    .close:hover,
    .back:hover {
      background: rgba(255, 255, 255, 0.07);
      color: white;
    }
    .close svg,
    .back svg {
      width: 15px;
      height: 15px;
    }
    .body {
      padding: 16px 18px 20px;
      display: grid;
      gap: 16px;
    }
    .section {
      display: grid;
      gap: 8px;
    }
    .label {
      font-size: 11px;
      font-weight: 750;
      text-transform: uppercase;
      letter-spacing: 0.11em;
      color: var(--g-primary, #d6b35a);
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px;
    }
    .action {
      min-height: 48px;
      display: flex;
      align-items: center;
      gap: 9px;
      padding: 9px 11px;
      text-align: left;
      border: 1px solid var(--g-border, rgba(255, 255, 255, 0.12));
      border-radius: 11px;
      background: rgba(255, 255, 255, 0.035);
      color: inherit;
      cursor: pointer;
    }
    .action:hover,
    .action:focus-visible {
      border-color: color-mix(in srgb, var(--g-primary, #d6b35a) 50%, transparent);
      background: color-mix(in srgb, var(--g-primary, #d6b35a) 8%, transparent);
      outline: none;
    }
    .action[disabled] {
      cursor: not-allowed;
      opacity: 0.45;
    }
    .action svg {
      width: 16px;
      height: 16px;
      color: var(--g-primary, #d6b35a);
    }
    .secure-note {
      display: flex;
      gap: 8px;
      padding: 10px 12px;
      border: 1px solid rgba(52, 211, 153, 0.3);
      border-radius: 10px;
      background: rgba(52, 211, 153, 0.08);
      color: #9be5ba;
      font-size: 12px;
      line-height: 1.45;
    }
    .secure-note svg {
      width: 15px;
      height: 15px;
      flex: none;
    }
    label {
      display: grid;
      gap: 6px;
      color: var(--muted, #aaa);
      font-size: 11px;
    }
    input,
    select,
    textarea {
      width: 100%;
      box-sizing: border-box;
      border: 1px solid var(--g-border, rgba(255, 255, 255, 0.14));
      border-radius: 9px;
      padding: 9px 10px;
      background: rgba(0, 0, 0, 0.24);
      color: var(--text, #eee);
      outline: none;
    }
    textarea {
      min-height: 100px;
      resize: vertical;
    }
    input:focus,
    select:focus,
    textarea:focus {
      border-color: var(--g-primary, #d6b35a);
    }
    .primary {
      justify-self: end;
      min-width: 120px;
      min-height: 38px;
      border: 0;
      border-radius: 9px;
      padding: 0 14px;
      background: linear-gradient(180deg, #ead184, var(--g-primary, #d6b35a));
      color: #171204;
      font-weight: 750;
      cursor: pointer;
    }
    .primary[disabled] {
      opacity: 0.55;
      cursor: wait;
    }
    .error {
      color: #ff9b8c;
      font-size: 12px;
    }
    .toast {
      position: fixed;
      right: 22px;
      bottom: 22px;
      z-index: 2600;
      display: flex;
      align-items: center;
      gap: 10px;
      max-width: min(430px, calc(100vw - 44px));
      padding: 11px 13px;
      border: 1px solid rgba(110, 220, 150, 0.35);
      border-radius: 11px;
      background: #17231c;
      color: #c9f3d7;
      box-shadow: 0 18px 45px rgba(0, 0, 0, 0.5);
      font-size: 12px;
    }
    .toast a {
      color: #f1d57e;
      font-weight: 700;
    }
    @media (max-width: 520px) {
      .grid {
        grid-template-columns: 1fr;
      }
      .scrim {
        padding: 8px;
      }
      .modal {
        border-radius: 14px;
      }
    }
  `;

  @property() markdown = "";
  @property() sessionKey = "";
  @property({ type: Boolean }) secure = false;
  @property({ attribute: false }) client: RequestClient | null = null;
  @state() private open = false;
  @state() private view: View = "menu";
  @state() private busy = false;
  @state() private error: string | null = null;
  @state() private projects: Project[] = [];
  @state() private workflows: Workflow[] = [];
  @state() private folders: Folder[] = [];
  @state() private responseName = "";
  @state() private destination = "workspace";
  @state() private workflowId = "";
  @state() private workflowMode: "create" | "append" = "create";
  @state() private customPrompt = "";
  @state() private toast: { text: string; href?: string; label?: string } | null = null;
  private toastTimer: number | null = null;

  private gateway(): RequestClient {
    const globalClient = (window as unknown as { __infinibotGatewayClient?: RequestClient })
      .__infinibotGatewayClient;
    const client = this.client ?? globalClient;
    if (!client?.request) throw new Error("Gateway client is not available.");
    return client;
  }

  private showToast(text: string, href?: string, label?: string) {
    this.toast = { text, href, label };
    if (this.toastTimer) window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => (this.toast = null), 7000);
  }

  private async loadChoices() {
    if (this.secure) return;
    try {
      const [projects, workflows, folders] = await Promise.all([
        this.gateway().request<unknown>("kanban.projects.list", {}),
        this.gateway().request<{ workflows?: Workflow[] }>("workflows.list", { limit: 200 }),
        this.gateway().request<{ items?: Folder[] }>("files.list", { path: "" }),
      ]);
      this.projects = Array.isArray(projects)
        ? (projects as Project[])
        : ((projects as { projects?: Project[] } | null)?.projects ?? []);
      this.workflows = workflows?.workflows ?? [];
      this.folders = (folders?.items ?? []).filter((item) => item.isDirectory);
      if (!this.workflowId && this.workflows[0]) this.workflowId = this.workflows[0].id;
    } catch {
      // Individual actions surface a precise error if a picker is needed.
    }
  }

  private launch(view: View) {
    this.view = view;
    this.error = null;
    this.responseName ||= responseTitle(this.markdown);
  }

  private async run<T>(action: () => Promise<T>): Promise<T | null> {
    this.busy = true;
    this.error = null;
    try {
      return await action();
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
      return null;
    } finally {
      this.busy = false;
    }
  }

  private async saveReport() {
    if (this.secure) return;
    const title = responseTitle(this.markdown);
    const result = await this.run(() =>
      this.gateway().request<{ id?: string }>("reports.render", {
        payload: {
          title,
          subtitle: "Saved from an InfiniBot agent response",
          sections: [{ heading: "Agent response", body: this.markdown }],
          footer: "Saved from chat",
        },
        register: true,
        sourceSession: this.sessionKey,
      }),
    );
    if (!result) return;
    this.open = false;
    this.showToast("Report saved.", "/reports", "Open reports");
  }

  private async saveWorkspace() {
    if (this.secure) return;
    const title = this.responseName.trim() || responseTitle(this.markdown);
    const result = await this.run(async () => {
      if (this.destination.startsWith("project:")) {
        const projectId = this.destination.slice("project:".length);
        return this.gateway().request("kanban.projects.content.createNote", {
          projectId,
          title,
          content: this.markdown,
        });
      }
      if (this.destination.startsWith("folder:")) {
        const folder = this.destination.slice("folder:".length);
        const path = `${folder ? `${folder}/` : ""}${slug(title)}.md`;
        return this.gateway().request("files.write", {
          path,
          content: `# ${title}\n\n${this.markdown}`,
        });
      }
      return this.gateway().request("notes.create", {
        name: title,
        body: this.markdown,
        category: "agent-response",
        tags: ["chat", "agent-response"],
      });
    });
    if (!result) return;
    this.open = false;
    const href = this.destination.startsWith("project:")
      ? "/kanban"
      : this.destination.startsWith("folder:")
        ? "/files"
        : "/notes";
    this.showToast("Saved to workspace.", href, "Open item");
  }

  private async saveWorkflow() {
    if (this.secure) return;
    const title = this.responseName.trim() || responseTitle(this.markdown);
    const result = await this.run(async () => {
      if (this.workflowMode === "append") {
        if (!this.workflowId) throw new Error("Choose a workflow.");
        const current = await this.gateway().request<Workflow>("workflows.get", {
          id: this.workflowId,
        });
        return this.gateway().request("workflows.update", {
          id: current.id,
          body: `${current.body ?? ""}\n\n## Step: ${title}\n\n${this.markdown}`.trim(),
        });
      }
      return this.gateway().request("workflows.create", {
        name: title,
        description: "Created from an InfiniBot agent response.",
        body: this.markdown,
        tags: ["chat", "agent-response"],
      });
    });
    if (!result) return;
    this.open = false;
    this.showToast("Workflow saved.", "/workflows", "Open workflows");
  }

  private async runWorkflow() {
    if (this.secure || !this.workflowId) return;
    const result = await this.run(() =>
      this.gateway().request<{ runId?: string }>("workflows.run.start", {
        id: this.workflowId,
        inputs: { response: this.markdown, input: this.markdown, content: this.markdown },
      }),
    );
    if (!result) return;
    this.open = false;
    this.showToast("Workflow started.", "/workflows", "View run");
  }

  private async sendAiAction(instruction: string) {
    const prompt = `${instruction}\n\n<agent_response>\n${this.markdown}\n</agent_response>`;
    const result = await this.run(() =>
      this.gateway().request("chat.send", {
        sessionKey: this.sessionKey,
        message: prompt,
        deliver: false,
        idempotencyKey: generateUUID(),
      }),
    );
    if (!result) return;
    this.open = false;
    this.showToast("Action sent to the agent.");
  }

  private renderMenu() {
    const locked = this.secure;
    return html`
      ${locked ? html`<div class="secure-note">${icons.lock}<span>Secure session: actions that write outside the secure lane are disabled. AI actions stay in this secure conversation.</span></div>` : nothing}
      <div class="section">
        <span class="label">Save or run</span>
        <div class="grid">
          <button class="action" ?disabled=${locked || this.busy} @click=${this.saveReport}>${icons.fileText}<span>Save as Report</span></button>
          <button class="action" ?disabled=${locked} @click=${() => this.launch("workspace")}>${icons.folder}<span>Save to Workspace</span></button>
          <button class="action" ?disabled=${locked} @click=${() => this.launch("workflow")}>${icons.layers}<span>Save to Workflow</span></button>
          <button class="action" ?disabled=${locked || !this.workflows.length} @click=${() => this.launch("run")}>${icons.play}<span>Run Workflow</span></button>
        </div>
      </div>
      <div class="section">
        <span class="label">AI actions</span>
        <div class="grid">
          ${AI_ACTIONS.map((action) => html`<button class="action" ?disabled=${this.busy} @click=${() => this.sendAiAction(action.prompt)}>${icons.sparkles}<span>${action.label}</span></button>`)}
          <button class="action" @click=${() => this.launch("custom")}>${icons.edit}<span>Do something with this…</span></button>
        </div>
      </div>`;
  }

  private renderView() {
    if (this.view === "menu") return this.renderMenu();
    if (this.view === "workspace")
      return html`
      <label>Title<input .value=${this.responseName} @input=${(e: Event) => (this.responseName = (e.target as HTMLInputElement).value)} /></label>
      <label>Destination<select .value=${this.destination} @change=${(e: Event) => (this.destination = (e.target as HTMLSelectElement).value)}>
        <option value="workspace">Workspace notes</option>
        ${this.projects.map((project) => html`<option value=${`project:${project.id}`}>Project · ${project.name ?? project.title ?? project.id}</option>`)}
        <option value="folder:">Files · root folder</option>
        ${this.folders.map((folder) => html`<option value=${`folder:${folder.path}`}>Folder · ${folder.name}</option>`)}
      </select></label>
      <button class="primary" ?disabled=${this.busy} @click=${this.saveWorkspace}>${this.busy ? "Saving…" : "Save"}</button>`;
    if (this.view === "workflow")
      return html`
      <label>Save mode<select .value=${this.workflowMode} @change=${(e: Event) => (this.workflowMode = (e.target as HTMLSelectElement).value as "create" | "append")}><option value="create">Create a workflow</option><option value="append">Append as a step</option></select></label>
      ${
        this.workflowMode === "create"
          ? html`<label>Workflow name<input .value=${this.responseName} @input=${(e: Event) => (this.responseName = (e.target as HTMLInputElement).value)} /></label>`
          : html`<label>Workflow<select .value=${this.workflowId} @change=${(e: Event) => (this.workflowId = (e.target as HTMLSelectElement).value)}>${this.workflows.map((workflow) => html`<option value=${workflow.id}>${workflow.name}</option>`)}</select></label>`
      }
      <button class="primary" ?disabled=${this.busy} @click=${this.saveWorkflow}>${this.busy ? "Saving…" : "Save workflow"}</button>`;
    if (this.view === "run")
      return html`
      <label>Workflow<select .value=${this.workflowId} @change=${(e: Event) => (this.workflowId = (e.target as HTMLSelectElement).value)}>${this.workflows.map((workflow) => html`<option value=${workflow.id}>${workflow.name}</option>`)}</select></label>
      <button class="primary" ?disabled=${this.busy || !this.workflowId} @click=${this.runWorkflow}>${this.busy ? "Starting…" : "Run with response"}</button>`;
    return html`<label>Instruction<textarea placeholder="What should the agent do with this response?" .value=${this.customPrompt} @input=${(e: Event) => (this.customPrompt = (e.target as HTMLTextAreaElement).value)}></textarea></label><button class="primary" ?disabled=${this.busy || !this.customPrompt.trim()} @click=${() => this.sendAiAction(this.customPrompt.trim())}>${this.busy ? "Sending…" : "Send action"}</button>`;
  }

  render() {
    return html`
      <button class="plus" type="button" title="Response actions" aria-label="Open response actions" @click=${() => {
        this.open = true;
        this.view = "menu";
        this.responseName = responseTitle(this.markdown);
        void this.loadChoices();
      }}>+</button>
      ${
        this.open
          ? html`<div class="scrim" @click=${(e: Event) => {
              if (e.target === e.currentTarget) this.open = false;
            }} @keydown=${(e: KeyboardEvent) => {
              if (e.key === "Escape") this.open = false;
            }}>
        <section class="modal" role="dialog" aria-modal="true" aria-label="Response actions">
          <header>${
            this.view !== "menu"
              ? html`<button class="back" type="button" aria-label="Back" @click=${() => {
                  this.view = "menu";
                  this.error = null;
                }}>${icons.arrowLeft}</button>`
              : nothing
          }<h2>${this.view === "menu" ? "Response actions" : this.view === "workspace" ? "Save to Workspace" : this.view === "workflow" ? "Save to Workflow" : this.view === "run" ? "Run Workflow" : "Custom AI action"}</h2><button class="close" type="button" aria-label="Close" @click=${() => (this.open = false)}>${icons.x}</button></header>
          <div class="body">${this.renderView()}${this.error ? html`<div class="error" role="alert">${this.error}</div>` : nothing}</div>
        </section>
      </div>`
          : nothing
      }
      ${this.toast ? html`<div class="toast" role="status">${icons.checkCircle}<span>${this.toast.text}</span>${this.toast.href ? html`<a href=${this.toast.href}>${this.toast.label ?? "Open"}</a>` : nothing}</div>` : nothing}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ib-response-actions": ResponseActions;
  }
}
