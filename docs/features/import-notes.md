# Import your notes (Obsidian + Notion)

Bring an Obsidian vault or a Notion workspace into InfiniBot. Everything lands in
the local **Documents** workspace (the source of truth — Notion is optional and only
mirrors), shows up in the knowledge graph, and is readable by every agent.

## Where

- **Documents → Import** (⤓): tabs for Notion (API), Notion export ZIP, Obsidian,
  **Map to projects · tasks · clients**, and From URL.
- **`infinibot quickstart`**: the *Import notes* step (and a guided *Telegram* step).
- **`infinibot onboard`**: the "Import your notes?" prompt (`--skip-import` to skip).
- **InfiniBot Cloud onboarding**: the *Import notes* step (hosted plans; ZIP uploads
  and the Notion token — a hosted machine can't read your disk).
- **Agents**: the `notes` tool actions `import_obsidian`, `import_notion`,
  `import_notion_zip`, `import_status`, `import_undo`, `import_collections`,
  `import_map_preview`, `import_map`.

Every import is a background job: setup and onboarding never wait on it. A job
started by the standalone setup page or `infinibot onboard` that hasn't finished
when that process exits is picked up by the gateway (on boot, and by a sweep every
two minutes).

## Obsidian

Sources: a vault **folder** (self-hosted), a **.zip** of the vault (everywhere),
or a public **https git** URL (self-hosted; shallow clone, no credentials in URLs).

| Vault | Becomes |
| --- | --- |
| folders | folders (collections) under a `<vault name>` folder |
| notes `*.md` | docs; YAML frontmatter → properties; `aliases` resolve links |
| `#tags`, frontmatter `tags` | doc tags (code, headings and URLs ignored) |
| `[[Note]]`, `[[Note\|alias]]`, `[[Folder/Note#Heading]]` | `[label](doc:<id>)` links (Obsidian resolution: path, shortest basename, alias). Unresolved links stay as `[[…]]` |
| `![[Note]]` embeds | a link to the embedded note |
| `![[image.png]]`, `![](img.png)` | stored images (`/api/documents/assets/…`) |
| PDFs and other files | file nodes with extracted text |
| `YYYY-MM-DD.md` daily notes | `date` property + `daily-note` tag |
| `- [ ] …` checklists | optional kanban tasks (project “<vault> tasks”); `📅 2026-10-15` / `[due:: …]` → due date |

`.obsidian/`, `.trash/` and other dot-folders are skipped. Re-importing is keyed
by vault + path with a content hash: unchanged notes are skipped, edited notes are
updated in place, and notes removed from the vault are reported (never deleted).

## Notion

- **Integration token** (Documents → Notion (API)): pages, sub-pages and databases,
  images/files downloaded locally, relations and mentions rewritten to local links,
  `Sync changes` for incremental re-sync, rate-limit aware, resumable.
- **Export ZIP** (Settings → Export → Markdown & CSV): same layout, no token needed.

Both dedupe on the Notion id, so the API and the ZIP converge on the same docs.

## Map to projects · tasks · clients

An imported database (or an Obsidian folder of notes with frontmatter) can be turned
into real records: **kanban projects**, **kanban tasks**, or **CRM clients**.

1. Pick the collection; the target is suggested from its name/columns.
2. Check the field map (Title, Status, Due date, Priority, Tags, Project relation,
   Email, Phone…) — each target field picks a source column.
3. The preview shows the first rows as they will land and the new/update counts.

Relations are kept: a task's *Project* relation (Notion page ids, or the ZIP
export's `Title (https://notion.so/…)` cells, or a plain name) links the task to the
project imported from that page — map **Projects** first, then **Tasks**. Rows are
deduped through an import ledger, so re-running a mapping after a re-sync updates
records instead of duplicating them.

## Undo

Every import and every mapping run is journaled. **Undo import** (in the job card,
or `documents.import.undo` / the `import_undo` tool action) moves docs it created
to Trash, restores docs it changed to their previous version, and removes the
projects/tasks/clients it created (or restores fields it changed).

## RPCs

`documents.obsidian.import`, `documents.import.undo`, `documents.import.collections`,
`documents.import.mapping.preview`, `documents.import.mapping.apply`, plus the
existing `documents.notion.*` job methods (`jobs.get/list/cancel` cover every import
kind). ZIP uploads: `POST /api/documents/upload?mode=obsidian-zip|notion-zip`
(standalone setup: `POST /api/upload?mode=…`).
