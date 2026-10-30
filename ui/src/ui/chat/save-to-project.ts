/**
 * Save-to-Project button + modal for chat messages.
 * Copies assistant response markdown to a Notion project page (as appended blocks or subpage).
 */

import { html, nothing, type TemplateResult } from "lit";
import { icons } from "../icons";

// ── Types ────────────────────────────────────────────────────

interface NotionProject {
  id: string;
  notionId?: string;
  name: string;
  description?: string;
  status?: string;
}

interface SaveModalState {
  open: boolean;
  loading: boolean;
  saving: boolean;
  projects: NotionProject[];
  selectedProjectId: string | null;
  saveMode: "append" | "subpage";
  subpageTitle: string;
  error: string | null;
  success: string | null;
  markdown: string;
  searchQuery: string;
}

// ── Singleton modal state (one modal at a time) ──────────────

let modalState: SaveModalState = {
  open: false,
  loading: false,
  saving: false,
  projects: [],
  selectedProjectId: null,
  saveMode: "append",
  subpageTitle: "",
  error: null,
  success: null,
  markdown: "",
  searchQuery: "",
};

// Re-render callback — set by the app
let requestUpdate: (() => void) | null = null;

export function setSaveModalUpdateCallback(cb: () => void) {
  requestUpdate = cb;
}

function update() {
  requestUpdate?.();
}

// ── Gateway interaction ──────────────────────────────────────

async function gwRequest(method: string, params: Record<string, unknown> = {}): Promise<any> {
  // Use the global gateway client (available on window in InfiniBot UI)
  const client = (window as any).__infinibotGatewayClient;
  if (!client?.request) throw new Error("Gateway client not available");
  return client.request(method, params);
}

async function loadProjects(): Promise<NotionProject[]> {
  try {
    const projects = await gwRequest("kanban.projects.list");
    if (Array.isArray(projects)) return projects;
    if (projects?.projects && Array.isArray(projects.projects)) return projects.projects;
    return [];
  } catch {
    return [];
  }
}

function markdownToNotionBlocks(md: string): any[] {
  const blocks: any[] = [];
  const lines = md.split("\n");
  let codeBlock: { lang: string; lines: string[] } | null = null;

  // Helper to create code blocks with chunking for Notion's 2000 char limit
  const pushCodeBlock = (content: string, lang: string) => {
    const chunks = chunkText(content, 2000);
    // If content fits in one chunk, use single rich_text entry
    if (chunks.length === 1) {
      blocks.push({
        object: "block",
        type: "code",
        code: {
          rich_text: [{ type: "text", text: { content: chunks[0] } }],
          language: lang || "plain text",
        },
      });
    } else {
      // Split into multiple code blocks for very long code
      for (const chunk of chunks) {
        blocks.push({
          object: "block",
          type: "code",
          code: {
            rich_text: [{ type: "text", text: { content: chunk } }],
            language: lang || "plain text",
          },
        });
      }
    }
  };

  for (const line of lines) {
    // Code block handling
    if (line.startsWith("```")) {
      if (codeBlock) {
        const content = codeBlock.lines.join("\n");
        pushCodeBlock(content, codeBlock.lang);
        codeBlock = null;
      } else {
        codeBlock = { lang: line.slice(3).trim() || "plain text", lines: [] };
      }
      continue;
    }
    if (codeBlock) {
      codeBlock.lines.push(line);
      continue;
    }

    // Headings
    if (line.startsWith("### ")) {
      blocks.push({
        object: "block",
        type: "heading_3",
        heading_3: { rich_text: [{ type: "text", text: { content: line.slice(4) } }] },
      });
    } else if (line.startsWith("## ")) {
      blocks.push({
        object: "block",
        type: "heading_2",
        heading_2: { rich_text: [{ type: "text", text: { content: line.slice(3) } }] },
      });
    } else if (line.startsWith("# ")) {
      blocks.push({
        object: "block",
        type: "heading_1",
        heading_1: { rich_text: [{ type: "text", text: { content: line.slice(2) } }] },
      });
    }
    // Bullet lists
    else if (line.match(/^[-*] /)) {
      blocks.push({
        object: "block",
        type: "bulleted_list_item",
        bulleted_list_item: { rich_text: [{ type: "text", text: { content: line.slice(2) } }] },
      });
    }
    // Numbered lists
    else if (line.match(/^\d+\. /)) {
      const content = line.replace(/^\d+\.\s*/, "");
      blocks.push({
        object: "block",
        type: "numbered_list_item",
        numbered_list_item: { rich_text: [{ type: "text", text: { content } }] },
      });
    }
    // Blockquotes
    else if (line.startsWith("> ")) {
      blocks.push({
        object: "block",
        type: "quote",
        quote: { rich_text: [{ type: "text", text: { content: line.slice(2) } }] },
      });
    }
    // Dividers
    else if (line.match(/^---+$/)) {
      blocks.push({ object: "block", type: "divider", divider: {} });
    }
    // Empty lines → skip (Notion handles spacing)
    else if (line.trim() === "") {
      continue;
    }
    // Paragraph
    else {
      // Notion has a 2000 char limit per rich_text block
      const chunks = chunkText(line, 2000);
      blocks.push({
        object: "block",
        type: "paragraph",
        paragraph: { rich_text: chunks.map(c => ({ type: "text", text: { content: c } })) },
      });
    }
  }

  // Close any open code block
  if (codeBlock) {
    const content = codeBlock.lines.join("\n");
    pushCodeBlock(content, codeBlock.lang);
  }

  return blocks;
}

function filteredProjects(s: SaveModalState): NotionProject[] {
  if (!s.searchQuery.trim()) return s.projects;
  const q = s.searchQuery.toLowerCase().trim();
  return s.projects.filter(p =>
    p.name.toLowerCase().includes(q) ||
    (p.description?.toLowerCase().includes(q) ?? false)
  );
}

function chunkText(text: string, maxLen: number): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += maxLen) {
    chunks.push(text.slice(i, i + maxLen));
  }
  return chunks.length ? chunks : [""];
}

async function appendToNotionPage(pageId: string, markdown: string): Promise<void> {
  // Add a divider + timestamp header first
  const timestamp = new Date().toLocaleString();
  const headerBlock = {
    object: "block",
    type: "callout",
    callout: {
      rich_text: [{ type: "text", text: { content: `Saved from chat — ${timestamp}` } }],
      icon: { type: "emoji", emoji: "💬" },
    },
  };

  const contentBlocks = markdownToNotionBlocks(markdown);
  const allBlocks = [
    { object: "block", type: "divider", divider: {} },
    headerBlock,
    ...contentBlocks,
  ];

  // Notion API: append blocks to page — batch in groups of 100
  for (let i = 0; i < allBlocks.length; i += 100) {
    const batch = allBlocks.slice(i, i + 100);
    await gwRequest("notion.blocks.append", { blockId: pageId, children: batch });
  }
}

async function createSubpage(parentPageId: string, title: string, markdown: string): Promise<void> {
  const contentBlocks = markdownToNotionBlocks(markdown);

  await gwRequest("notion.pages.create", {
    parentPageId,
    title,
    children: contentBlocks.slice(0, 100), // Notion limits 100 blocks on create
  });
}

// ── Open / Close ─────────────────────────────────────────────

export function openSaveModal(markdown: string) {
  modalState = {
    ...modalState,
    open: true,
    loading: true,
    saving: false,
    error: null,
    success: null,
    markdown,
    searchQuery: "",
    subpageTitle: `Chat response — ${new Date().toLocaleDateString()}`,
  };
  update();

  // Load projects
  loadProjects().then((projects) => {
    modalState.projects = projects;
    modalState.loading = false;
    if (projects.length > 0 && !modalState.selectedProjectId) {
      modalState.selectedProjectId = projects[0].notionId || projects[0].id;
    }
    update();
  }).catch((e) => {
    modalState.loading = false;
    modalState.error = `Failed to load projects: ${e.message || e}`;
    update();
  });
}

export function closeSaveModal() {
  modalState.open = false;
  modalState.error = null;
  modalState.success = null;
  update();
}

async function doSave() {
  if (!modalState.selectedProjectId || modalState.saving) return;

  modalState.saving = true;
  modalState.error = null;
  modalState.success = null;
  update();

  try {
    if (modalState.saveMode === "append") {
      await appendToNotionPage(modalState.selectedProjectId, modalState.markdown);
    } else {
      await createSubpage(
        modalState.selectedProjectId,
        modalState.subpageTitle || "Chat response",
        modalState.markdown,
      );
    }
    modalState.saving = false;
    modalState.success = modalState.saveMode === "append"
      ? "✅ Appended to project page!"
      : "✅ Created subpage!";
    update();

    // Auto-close after success
    setTimeout(() => {
      if (modalState.success) closeSaveModal();
    }, 1500);
  } catch (e: any) {
    modalState.saving = false;
    modalState.error = `Save failed: ${e.message || e}`;
    update();
  }
}

// ── Styles ───────────────────────────────────────────────────

const MS = {
  overlay: "position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.7);z-index:9999;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(4px);",
  modal: "background:#111;border:1px solid #333;border-radius:12px;padding:1.5rem;width:90%;max-width:480px;max-height:80vh;overflow-y:auto;color:#e5e5e5;font-family:system-ui,-apple-system,sans-serif;",
  header: "display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem;",
  title: "font-size:1.1rem;font-weight:700;color:var(--g-primary);",
  closeBtn: "background:none;border:none;color:#666;cursor:pointer;font-size:1.2rem;padding:0.2rem;line-height:1;",
  label: "display:block;font-size:0.7rem;color:#666;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:0.3rem;",
  select: "background:#0a0a0a;border:1px solid #333;border-radius:6px;padding:0.5rem;color:#e5e5e5;font-size:0.85rem;width:100%;font-family:inherit;outline:none;cursor:pointer;",
  input: "background:#0a0a0a;border:1px solid #333;border-radius:6px;padding:0.5rem;color:#e5e5e5;font-size:0.85rem;width:100%;box-sizing:border-box;font-family:inherit;outline:none;",
  modeBar: "display:flex;gap:0;margin-bottom:1rem;",
  modeBtn: (active: boolean) => `flex:1;padding:0.4rem 0.8rem;border:1px solid ${active ? "var(--g-primary)" : "#333"};background:${active ? "#1a1a0a" : "#0a0a0a"};color:${active ? "var(--g-primary)" : "#888"};cursor:pointer;font-size:0.78rem;font-family:inherit;transition:all 0.15s;`,
  modeBtnLeft: "border-radius:6px 0 0 6px;",
  modeBtnRight: "border-radius:0 6px 6px 0;",
  saveBtn: "background:var(--g-primary);color:#000;border:none;border-radius:6px;padding:0.5rem 1.2rem;cursor:pointer;font-weight:700;font-size:0.85rem;font-family:inherit;width:100%;transition:opacity 0.15s;",
  saveBtnDisabled: "background:#333;color:#666;border:none;border-radius:6px;padding:0.5rem 1.2rem;cursor:not-allowed;font-weight:700;font-size:0.85rem;font-family:inherit;width:100%;",
  error: "background:#1a0a0a;border:1px solid #ef4444;border-radius:6px;padding:0.4rem 0.6rem;color:#ef4444;font-size:0.8rem;margin-bottom:0.8rem;",
  success: "background:#0a1a0a;border:1px solid #22c55e;border-radius:6px;padding:0.4rem 0.6rem;color:#22c55e;font-size:0.8rem;margin-bottom:0.8rem;",
  preview: "background:#0a0a0a;border:1px solid #222;border-radius:6px;padding:0.6rem;max-height:100px;overflow:hidden;position:relative;font-size:0.75rem;color:#666;line-height:1.4;white-space:pre-wrap;margin-bottom:1rem;",
  previewFade: "position:absolute;bottom:0;left:0;right:0;height:40px;background:linear-gradient(transparent,#0a0a0a);",
  projectItem: (selected: boolean) => `padding:0.6rem 0.8rem;border:1px solid ${selected ? "var(--g-primary)" : "#222"};border-radius:6px;cursor:pointer;margin-bottom:0.4rem;background:${selected ? "#1a1a0a" : "#0a0a0a"};transition:all 0.15s;`,
  projectName: "font-weight:600;font-size:0.85rem;color:#e5e5e5;",
  projectDesc: "font-size:0.7rem;color:#666;margin-top:0.15rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;",
  group: "margin-bottom:1rem;",
};

// ── Render: Save Button (inline on message) ──────────────────

export function renderSaveToProjectButton(markdown: string): TemplateResult {
  return html`
    <button
      class="chat-save-btn"
      type="button"
      title="Save to project"
      aria-label="Save to project"
      @click=${(e: Event) => {
        e.stopPropagation();
        openSaveModal(markdown);
      }}
    >
      <span class="chat-save-btn__icon" aria-hidden="true">
        ${icons.folder}
      </span>
    </button>
  `;
}

// ── Render: Modal ────────────────────────────────────────────

export function renderSaveToProjectModal(): TemplateResult | typeof nothing {
  if (!modalState.open) return nothing;

  const s = modalState;
  const canSave = !s.saving && !s.loading && s.selectedProjectId;
  const previewText = s.markdown.length > 300 ? s.markdown.slice(0, 300) + "…" : s.markdown;

  return html`
    <div style=${MS.overlay} @click=${(e: Event) => { if (e.target === e.currentTarget) closeSaveModal(); }}>
      <div style=${MS.modal} @click=${(e: Event) => e.stopPropagation()}>
        <div style=${MS.header}>
          <span style=${MS.title}>💾 Save to Project</span>
          <button style=${MS.closeBtn} @click=${closeSaveModal}>✕</button>
        </div>

        ${s.error ? html`<div style=${MS.error}>⚠️ ${s.error}</div>` : nothing}
        ${s.success ? html`<div style=${MS.success}>${s.success}</div>` : nothing}

        <!-- Preview -->
        <div style=${MS.preview}>
          ${previewText}
          ${s.markdown.length > 300 ? html`<div style=${MS.previewFade}></div>` : nothing}
        </div>

        <!-- Mode selector -->
        <div style=${MS.modeBar}>
          <button style="${MS.modeBtn(s.saveMode === "append")}${MS.modeBtnLeft}"
            @click=${() => { modalState.saveMode = "append"; update(); }}>
            📄 Append to Page
          </button>
          <button style="${MS.modeBtn(s.saveMode === "subpage")}${MS.modeBtnRight}"
            @click=${() => { modalState.saveMode = "subpage"; update(); }}>
            📑 Create Subpage
          </button>
        </div>

        ${s.saveMode === "subpage" ? html`
          <div style=${MS.group}>
            <label style=${MS.label}>Subpage Title</label>
            <input style=${MS.input}
              .value=${s.subpageTitle}
              @input=${(e: Event) => { modalState.subpageTitle = (e.target as HTMLInputElement).value; update(); }}
              placeholder="Subpage title..." />
          </div>
        ` : nothing}

        <!-- Project list -->
        <div style=${MS.group}>
          <label style=${MS.label}>Select Project</label>
          <input style="${MS.input};margin-bottom:0.5rem;"
            .value=${s.searchQuery}
            @input=${(e: Event) => { modalState.searchQuery = (e.target as HTMLInputElement).value; update(); }}
            placeholder="🔍 Search projects..." />
          ${s.loading ? html`<div style="color:#666;font-size:0.82rem;padding:1rem;text-align:center;">Loading projects...</div>` :
            s.projects.length === 0 ? html`<div style="color:#666;font-size:0.82rem;padding:1rem;text-align:center;">No projects found</div>` :
            html`
              <div style="max-height:200px;overflow-y:auto;">
                ${filteredProjects(s).map(p => {
                  const pid = p.notionId || p.id;
                  const selected = pid === s.selectedProjectId;
                  return html`
                    <div style=${MS.projectItem(selected)}
                      @click=${() => { modalState.selectedProjectId = pid; update(); }}>
                      <div style=${MS.projectName}>${p.name}</div>
                      ${p.description ? html`<div style=${MS.projectDesc}>${p.description}</div>` : nothing}
                    </div>
                  `;
                })}
                ${filteredProjects(s).length === 0 ? html`<div style="color:#555;font-size:0.78rem;padding:0.5rem;text-align:center;">No projects match "${s.searchQuery}"</div>` : nothing}
              </div>
            `}
        </div>

        <!-- Save button -->
        <button
          style=${canSave ? MS.saveBtn : MS.saveBtnDisabled}
          ?disabled=${!canSave}
          @click=${doSave}>
          ${s.saving ? "Saving..." :
            s.saveMode === "append" ? "Append to Project Page" : "Create Subpage"}
        </button>
      </div>
    </div>
  `;
}
