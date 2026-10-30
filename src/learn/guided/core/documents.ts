import type { LearnTrack } from "../types.js";

/**
 * Documents & Notion import — the Documents workspace (/notes, alias
 * /documents): folder tree, rich editor, uploads with text extraction, the
 * Notes mirror and the Notion API / ZIP importers.
 */
export const track: LearnTrack = {
  id: "documents",
  title: "Documents & Notion import",
  summary:
    "Organise docs, folders and uploaded files, write in the rich editor and bring your Notion workspace across.",
  overview: [
    "**Documents** is your knowledge base. It holds docs you write, folders, uploaded files (PDF, Office, images, audio, video) and anything you import from Notion. It opens from **Work › Documents** (`/notes`, or `/documents`).",
    "",
    "Agents use the same store. The notes tool can list, read, search, create and update docs, upload files and run Notion imports, so what you write here is context your agents can use.",
    "",
    "This track covers:",
    "- **The workspace.** Tree, search, sort, trash, and list / table / grid views.",
    "- **The rich editor.** Slash blocks, `[[wiki links]]`, Markdown mode, autosave and version history.",
    "- **Notion import.** The API importer, the export-ZIP importer and how re-imports avoid duplicates.",
    "- **Files and your old notes.** Uploads, text extraction, and how Notes stay mirrored with Documents.",
  ].join("\n"),
  category: "Work",
  level: "beginner",
  certRequired: true,
  order: 60,
  routes: ["/notes", "/documents"],
  signals: ["notes"],
  badge: { id: "documents", label: "Librarian", icon: "📚" },
  walkthroughs: [
    {
      id: "tour-documents",
      title: "Tour the Documents workspace",
      summary: "The tree, search, sort, trash and folder views.",
      estMinutes: 3,
      steps: [
        {
          id: "sidebar",
          title: "Your document tree",
          body: "Everything lives in this tree: docs, folders and uploaded files. Drag rows to reorder them or drop one onto a folder to move it. Favourites and recently opened docs are listed above the tree.",
          route: "/notes",
          target: ["learn:documents-sidebar", "learn:documents-sidebar-toggle"],
          placement: "right",
        },
        {
          id: "side-actions",
          title: "Create, upload, import",
          body: "The four icons create a **doc**, a **folder**, **upload** files and **import** from Notion, a ZIP or a URL. New items go into the folder you have open.",
          target: "learn:documents-side-actions",
          placement: "bottom",
        },
        {
          id: "sort",
          title: "Sort the tree",
          body: "**Manual** keeps your drag-and-drop order. **Name** and **Updated** sort automatically. Your choice is remembered in this browser.",
          target: "learn:documents-sort",
        },
        {
          id: "search",
          title: "Search everything",
          body: "Type **roadmap**. Search covers titles, doc text and the text extracted from uploaded PDFs and Office files. Press **Esc** to clear it.",
          target: "learn:documents-search",
          action: { kind: "input", sample: "roadmap" },
        },
        {
          id: "trash",
          title: "Trash, not gone",
          body: "Deleting moves a doc to **Trash**. Open it here to restore an item or remove it for good.",
          target: "learn:documents-trash",
          placement: "top",
        },
        {
          id: "folder-bar",
          title: "The folder view",
          body: "The main area shows the open folder: its item count, **New doc**, **New folder** and **Upload**. Imported Notion databases show up as folders with a property table.",
          target: "learn:documents-folder-bar",
          placement: "bottom",
          skipIf: { kind: "viewport", maxWidth: 820 },
        },
        {
          id: "view-table",
          title: "Switch to the table view",
          body: "Click **Table**. Each folder remembers its own view: **List**, **Table** (sortable columns, including database properties) or **Grid** cards.",
          target: "learn:documents-view-table",
          action: { kind: "click" },
          skipIf: { kind: "viewport", maxWidth: 820 },
        },
      ],
    },
    {
      id: "rich-editor",
      title: "Write in the rich editor",
      summary: "Blocks, wiki links, Markdown mode, autosave and version history.",
      estMinutes: 3,
      steps: [
        {
          id: "new-doc",
          title: "Start a document",
          body: "**＋📄** in the sidebar (or **New doc**) creates an Untitled doc in the open folder and opens it in the editor. Give it a title in the big title field.",
          route: "/notes",
          target: ["learn:documents-side-actions", "learn:documents-new-doc"],
          placement: "bottom",
        },
        {
          id: "blocks",
          title: "Type / for blocks",
          body: "In the editor, type **/** for the block menu: headings, lists, checklists, callouts, toggles, tables, code, math and embeds. Type **[[** to link to another doc by title. Linked docs show a **Linked from** list.",
        },
        {
          id: "markdown",
          title: "Rich or Markdown",
          body: "The editor has a **rich** mode and a plain **Markdown** mode. Switching between them doesn't lose anything, because both use the same Markdown dialect that agents and the Notion importer use.",
        },
        {
          id: "autosave",
          title: "Autosave and versions",
          body: "Edits save automatically and the toolbar shows **Saving… / Saved**. **⟲** opens version history, where you can preview and restore earlier versions. There's also **.md** and **PDF** export, and **✦** asks an agent about the doc.",
          target: ["learn:documents-sidebar", "main"],
          placement: "right",
        },
      ],
    },
    {
      id: "import-notion",
      title: "Import from Notion",
      summary: "Open the importer, see the API and ZIP flows, and how re-imports avoid duplicates.",
      estMinutes: 4,
      steps: [
        {
          id: "open-import",
          title: "Open the importer",
          body: "Click **⤓** (Import from Notion / ZIP / URL).",
          route: "/notes",
          target: "learn:documents-import-icon",
          action: { kind: "click" },
        },
        {
          id: "sources",
          title: "Three sources",
          body: "**Notion (API)** pulls pages live, **Notion export ZIP** reads an export file, and **From URL** downloads a single file. Imports go into the folder you have open (**Into:**).",
          target: "learn:documents-dialog-import",
          placement: "center",
        },
        {
          id: "api-search",
          title: "Find pages to import",
          body: "Type a page name. With no saved Notion connection, paste an internal-integration token (used for this import only) and share the pages with that integration in Notion. Press **Search** to list the pages and databases it can see, then tick the ones you want.",
          target: "learn:documents-notion-search",
          action: { kind: "input", sample: "Roadmap" },
        },
        {
          id: "run-import",
          title: "Running an import",
          body: "**Import** starts a background job on the gateway. You can close the dialog, leave the page or even restart, and it picks up where it left off. Re-importing matches pages by Notion id, so docs are updated rather than duplicated, and **Sync changes** fetches only pages edited since the last sync.",
          target: "learn:documents-dialog-import",
          placement: "center",
          practice: {
            mode: "explain",
            note: "The tour doesn't start an import. An import reads from your Notion workspace and writes docs into this one.",
          },
        },
        {
          id: "zip-tab",
          title: "Or use an export ZIP",
          body: "Click **Notion export ZIP**. This option needs no token.",
          target: "learn:documents-import-tab-zip",
          action: { kind: "click" },
        },
        {
          id: "zip-flow",
          title: "Export, then drop",
          body: "In Notion, go to **Settings → Export → Markdown & CSV** (include subpages), then drop the .zip here. Pages become docs, subpages become folders, databases become folders with a property table, and images are stored locally.",
          target: "learn:documents-zip-drop",
        },
        {
          id: "close",
          title: "Close the importer",
          body: "Click **✕**. A running import keeps going, and a chip in the sidebar shows its progress.",
          target: "learn:documents-dialog-close",
          action: { kind: "click" },
        },
      ],
    },
    {
      id: "files-and-notes",
      title: "Files, extraction and your notes",
      summary: "What happens to uploads, and how Notes stay in sync with Documents.",
      estMinutes: 3,
      steps: [
        {
          id: "upload",
          title: "Upload any file",
          body: "Use **⇪** or drop files anywhere on the page: PDF, DOCX, XLSX, PPTX, images, audio, video, ZIP and more. Originals are stored as they are and never executed.",
          route: "/notes",
          target: "learn:documents-side-actions",
          placement: "bottom",
        },
        {
          id: "extraction",
          title: "Text you can search",
          body: "InfiniBot pulls text out of each upload: PDF pages, Word paragraphs, spreadsheet tables and slide text. A file shows an inline **Preview** plus an **Extracted text** tab. That text is what search and your agents read.",
          target: ["learn:documents-search", "learn:documents-sidebar"],
        },
        {
          id: "notes-mirror",
          title: "Your notes live here too",
          body: "Existing notes are copied into a **Notes** folder without touching the originals, and a JSON backup is written first. After that they stay in sync both ways: an agent editing a note updates the doc, and editing the doc writes back to the note. If you map a database to the notes role, its rows are the source.",
          target: ["learn:documents-tree", "learn:documents-sidebar"],
          placement: "right",
        },
        {
          id: "agents",
          title: "Agents share the same docs",
          body: "The **notes** tool gives agents the same workspace: tree, read, search, create, update, upload and Notion import. Ask an agent to “save this as a doc in Research” and it shows up here live.",
          target: "learn:documents-sidebar",
          placement: "right",
        },
      ],
    },
  ],
  quiz: [
    {
      id: "reimport",
      prompt: "You import the same Notion pages twice. What happens the second time?",
      options: [
        "You get a second copy of every page",
        "Existing docs are updated, matched by Notion id",
        "The import is refused",
        "The first import is deleted",
      ],
      answer: 1,
      explain:
        "Imports match pages by their Notion id, so running one again updates docs instead of duplicating them.",
    },
    {
      id: "zip",
      prompt: "Which import needs no Notion integration token?",
      options: ["Notion (API)", "Notion export ZIP", "Sync changes", "Full re-sync"],
      answer: 1,
      explain:
        "Export Markdown & CSV from Notion's settings and drop the .zip. No token is needed.",
    },
    {
      id: "search-pdf",
      prompt: "Can Documents search find a word inside an uploaded PDF?",
      options: [
        "No, only titles are searched",
        "Yes, extracted text is searched along with titles and doc text",
        "Only after converting it to a doc by hand",
        "Only through Notion",
      ],
      answer: 1,
      explain: "Uploads get a text companion (PDF, DOCX, XLSX, PPTX…) that search and agents read.",
    },
    {
      id: "notes",
      prompt: "What happened to your old Notes when Documents arrived?",
      options: [
        "They were deleted",
        "They were copied into a Notes folder and stay in sync both ways",
        "They are read-only forever",
        "They moved to Projects",
      ],
      answer: 1,
      explain:
        "The migration is non-destructive (with a JSON backup), and edits flow both ways between a note and its doc.",
    },
  ],
};
