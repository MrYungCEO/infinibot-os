/**
 * Notes Controller — state management and API calls for notes CRUD.
 */

import type { GatewayBrowserClient } from "../gateway";
import type { AppViewState } from "../app-view-state";
import { annotateFamilies, collapseFamilies } from "../lib/note-versioning";

// ── Types ────────────────────────────────────────────────────

export interface NoteItem {
  id: string;
  name: string;
  description?: string;
  tags?: string[];
  author?: string;
  category?: string;
  pinned?: boolean;
  linkedTo?: string[];
  projectId?: string;
  preview: string;
  bodyLength: number;
  updatedAt: string;
  createdAt: string;
  notionPageId?: string;
  notionSyncedAt?: string;
  // ── Document versioning (optional; absent on non-versioned notes) ──
  documentFamilyId?: string;
  version?: number;
  versionLabel?: string;
  supersededBy?: string;
  supersedes?: string;
  isCurrent?: boolean;
  /** Computed: how many versions exist in this note's family. */
  familyVersionCount?: number;
}

export interface NoteFull extends NoteItem {
  body: string;
}

export interface NotesState {
  notes: NoteItem[];
  /**
   * Every note version returned by the server (uncollapsed). Used to populate
   * version dropdowns / timelines without an extra RPC, so the family UI works
   * even before the gateway is restarted to serve notes.familyList.
   */
  notesAll: NoteItem[];
  /** Family id whose inline version dropdown is currently expanded, if any. */
  openVersionFamily: string | null;
  loading: boolean;
  error: string | null;
  selected: NoteFull | null;
  editorBody: string;
  editorName: string;
  editorDescription: string;
  editorTags: string;
  editorCategory: string;
  editorPinned: boolean;
  editorLinkedTo: string;
  editorProjectId: string;
  isCreating: boolean;
  saving: boolean;
  dirty: boolean;
  searchQuery: string;
  filterCategory: string;
  filterProjectId: string;
  successMessage: string | null;
  /**
   * True when the editor is in raw-markdown edit mode. False renders the
   * note as stylized markdown so the user reads polished output by default
   * and only flips into edit mode on explicit click. New-note creation
   * forces this on because there's nothing to preview yet.
   */
  editing: boolean;
}

export function createInitialNotesState(): NotesState {
  return {
    notes: [],
    notesAll: [],
    openVersionFamily: null,
    loading: false,
    error: null,
    selected: null,
    editorBody: "",
    editorName: "",
    editorDescription: "",
    editorTags: "",
    editorCategory: "",
    editorPinned: false,
    editorLinkedTo: "",
    editorProjectId: "",
    isCreating: false,
    saving: false,
    dirty: false,
    searchQuery: "",
    filterCategory: "",
    filterProjectId: "",
    successMessage: null,
    editing: false,
  };
}

// ── API Functions ────────────────────────────────────────────

export async function loadNotes(
  state: AppViewState,
  client: GatewayBrowserClient,
): Promise<void> {
  const ns = state.notesState;
  if (!ns) return;

  ns.loading = true;
  ns.error = null;

  try {
    const res = (await client.request("notes.list", {
      query: ns.searchQuery || undefined,
      category: ns.filterCategory || undefined,
      projectId: ns.filterProjectId || undefined,
      // Ask for every version; we collapse families client-side so the family
      // UI works whether or not the gateway has been restarted to serve the
      // server-side collapse. (Older gateways ignore the unknown param.)
      includeAllVersions: true,
    })) as any;
    const raw: NoteItem[] = res?.notes ?? [];
    // Annotate with computed family fields, then collapse to one row per family.
    const annotated = annotateFamilies(raw);
    ns.notesAll = annotated;
    ns.notes = collapseFamilies(annotated);
    ns.loading = false;
  } catch (e) {
    ns.error = e instanceof Error ? e.message : String(e);
    ns.loading = false;
  }
}

export async function loadNote(
  state: AppViewState,
  client: GatewayBrowserClient,
  id: string,
): Promise<void> {
  const ns = state.notesState;
  if (!ns) return;

  ns.loading = true;
  try {
    const res = (await client.request("notes.get", { id })) as any;
    if (res) {
      const note = res as NoteFull;
      ns.selected = note;
      ns.editorBody = note.body;
      ns.editorName = note.name;
      ns.editorDescription = note.description || "";
      ns.editorTags = note.tags?.join(", ") || "";
      ns.editorCategory = note.category || "";
      ns.editorPinned = note.pinned || false;
      ns.editorLinkedTo = note.linkedTo?.join(", ") || "";
      ns.editorProjectId = note.projectId || "";
      ns.isCreating = false;
      ns.dirty = false;
      // Default to the polished preview when opening an existing note —
      // the user clicks "Edit" (or the preview body) to switch into raw
      // markdown editing. Avoids dropping people into a wall of "**bold**"
      // syntax when they just wanted to read.
      ns.editing = false;
    }
    ns.loading = false;
  } catch (e) {
    ns.error = e instanceof Error ? e.message : String(e);
    ns.loading = false;
  }
}

export async function createNote(
  state: AppViewState,
  client: GatewayBrowserClient,
): Promise<boolean> {
  const ns = state.notesState;
  if (!ns) return false;

  if (!ns.editorName.trim()) {
    ns.error = "Note name is required";
    return false;
  }

  ns.saving = true;
  ns.error = null;
  try {
    const tags = ns.editorTags
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    const linkedTo = ns.editorLinkedTo
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    const res = (await client.request("notes.create", {
      name: ns.editorName.trim(),
      description: ns.editorDescription.trim() || undefined,
      body: ns.editorBody,
      tags: tags.length ? tags : undefined,
      category: ns.editorCategory.trim() || undefined,
      pinned: ns.editorPinned || undefined,
      linkedTo: linkedTo.length ? linkedTo : undefined,
      projectId: ns.editorProjectId.trim() || undefined,
    })) as any;

    ns.saving = false;
    ns.isCreating = false;
    ns.dirty = false;
    ns.successMessage = `Note "${res.name}" created`;
    setTimeout(() => { if (ns.successMessage) ns.successMessage = null; }, 3000);

    await loadNotes(state, client);
    if (res?.id) await loadNote(state, client, res.id);
    return true;
  } catch (e) {
    ns.error = e instanceof Error ? e.message : String(e);
    ns.saving = false;
    return false;
  }
}

export async function updateNote(
  state: AppViewState,
  client: GatewayBrowserClient,
): Promise<boolean> {
  const ns = state.notesState;
  if (!ns || !ns.selected) return false;

  ns.saving = true;
  ns.error = null;
  try {
    const tags = ns.editorTags
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    const linkedTo = ns.editorLinkedTo
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    const res = (await client.request("notes.update", {
      id: ns.selected.id,
      name: ns.editorName.trim() || undefined,
      description: ns.editorDescription.trim() || undefined,
      body: ns.editorBody,
      tags: tags.length ? tags : undefined,
      category: ns.editorCategory.trim() || undefined,
      pinned: ns.editorPinned,
      linkedTo: linkedTo.length ? linkedTo : undefined,
      projectId: ns.editorProjectId.trim() || undefined,
    })) as any;

    ns.saving = false;
    ns.dirty = false;
    ns.successMessage = `Note "${res?.name || ns.selected.name}" saved`;
    setTimeout(() => { if (ns.successMessage) ns.successMessage = null; }, 3000);

    await loadNotes(state, client);
    if (ns.selected?.id) await loadNote(state, client, ns.selected.id);
    return true;
  } catch (e) {
    ns.error = e instanceof Error ? e.message : String(e);
    ns.saving = false;
    return false;
  }
}

export async function deleteNote(
  state: AppViewState,
  client: GatewayBrowserClient,
  id: string,
): Promise<boolean> {
  const ns = state.notesState;
  if (!ns) return false;

  try {
    await client.request("notes.delete", { id });
    ns.selected = null;
    ns.editorBody = "";
    ns.editorName = "";
    ns.editorDescription = "";
    ns.editorTags = "";
    ns.editorCategory = "";
    ns.editorPinned = false;
    ns.editorLinkedTo = "";
    ns.editorProjectId = "";
    ns.dirty = false;
    ns.successMessage = "Note deleted";
    setTimeout(() => { if (ns.successMessage) ns.successMessage = null; }, 3000);
    await loadNotes(state, client);
    return true;
  } catch (e) {
    ns.error = e instanceof Error ? e.message : String(e);
    return false;
  }
}

/**
 * Create the next version of a note via the notes.newVersion RPC, pre-filled
 * from the current editor body. Falls back gracefully when the RPC is not yet
 * served (gateway not restarted) by surfacing a clear message.
 */
export async function createNewVersion(
  state: AppViewState,
  client: GatewayBrowserClient,
  versionLabel?: string,
): Promise<boolean> {
  const ns = state.notesState;
  if (!ns || !ns.selected) return false;
  ns.saving = true;
  ns.error = null;
  try {
    const res = (await client.request("notes.newVersion", {
      fromNoteId: ns.selected.id,
      body: ns.editorBody,
      versionLabel: versionLabel?.trim() || undefined,
    })) as any;
    ns.saving = false;
    const newId = res?.note?.id;
    ns.successMessage = `New version v${res?.version ?? "?"} created`;
    setTimeout(() => { if (ns.successMessage) ns.successMessage = null; }, 3000);
    await loadNotes(state, client);
    if (newId) await loadNote(state, client, newId);
    return true;
  } catch (e) {
    ns.saving = false;
    const msg = e instanceof Error ? e.message : String(e);
    // notes.newVersion isn't served until the gateway is restarted.
    ns.error = /unknown method|not found|unsupported/i.test(msg)
      ? "Versioning RPC not available yet — restart the gateway to enable 'Create new version'."
      : msg;
    return false;
  }
}

/** Start creating a new note (enter create mode). */
export function startCreateNote(state: AppViewState): void {
  const ns = state.notesState;
  if (!ns) return;
  ns.selected = null;
  ns.isCreating = true;
  ns.editorBody = "# New Note\n\n";
  ns.editorName = "";
  ns.editorDescription = "";
  ns.editorTags = "";
  ns.editorCategory = "";
  ns.editorPinned = false;
  ns.editorLinkedTo = "";
  ns.editorProjectId = "";
  ns.dirty = true;
  // New notes have nothing to preview — drop straight into edit mode so
  // the user can start typing without an extra click.
  // the user can start typing without an extra click.
  ns.editing = true;
}
