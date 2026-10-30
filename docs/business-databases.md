---
title: Business + CRM Databases
description: How InfiniBot's local-first databases work — Notion-compatible schemas with no Notion account required. Optional Notion sync if you have one.
---

# Business + CRM Databases

InfiniBot ships with a built-in database engine that powers the Projects, Tasks, Clients, Leads, Companies, Deals, Contacts, and Notes views in the UI — and the same engine is what agent tools (`db.*`, kanban, focus, vision) read from and write to.

The engine is **Notion-compatible by design but not Notion-dependent**. Out of the box you get a fully working CRM/project workspace stored locally in a single SQLite file. If and when you want to mirror to Notion, the schemas line up 1:1, so the import / sync flow is straightforward.

This page walks through the model, what's auto-seeded on first run, the Notion compatibility story, and how to (optionally) connect your Notion workspace later.

## What you get on first run

The first time the gateway boots in a fresh state directory, it creates these databases automatically with sensible Notion-style schemas:

| Database | Icon | System role | What it's for |
|---|---|---|---|
| **Projects** | 📁 | `projects` | Things you're shipping. Status, priority, description. |
| **Tasks** | ✅ | `tasks` | Work items. Status, priority, project relation, assignee, due date. |
| **Clients** | 👥 | `clients` | Active customer relationships. Tier, MRR, owner, contact info, deals. |
| **Leads** | 🎯 | `leads` | Pipeline. Stage, source, value, probability, next-step, owner. |
| **Companies** | 🏢 | — | Organizations behind your contacts and deals. Industry, size, country. |
| **Deals** | 💼 | — | Active sales opportunities. Stage, amount, probability, close date. |
| **Contacts** | 📇 | — | People you talk to — title, relationship, company, last-contact. |
| **Notes** | 📝 | `notes` | Long-form notes. Each row's body is a markdown page. |

You can rename them, change the schema, add columns, drop columns, hide them — they're just rows. If you delete one and want it back, the auto-seed only fires when no `native`-source database with that name already exists, so deleting + restarting won't recreate it (treats it as user intent).

## How the schema maps to Notion

Every property type the InfiniBot engine supports has a 1:1 Notion equivalent:

| InfiniBot type | Notion type | Notes |
|---|---|---|
| `title` | Title | Mandatory, exactly one per database. |
| `richText` | Rich text | Markdown serialized. |
| `select` | Select | Single-choice with named options + colors. |
| `multiSelect` | Multi-select | Multiple options. |
| `status` | Status | Same as `select` but UI treats it as a workflow state. |
| `date` | Date | ISO-8601. |
| `dateRange` | Date (with end) | Start + end. |
| `number` | Number | Format: number, percent, currency. |
| `checkbox` | Checkbox | Boolean. |
| `url` | URL | |
| `email` | Email | |
| `phone` | Phone | |
| `files` | Files & media | URL refs (no blob storage yet). |
| `relation` | Relation | Loose row-id strings, no FK enforcement (matches Notion). |
| `person` | Person | User-id strings. |
| `createdAt` / `updatedAt` | Created / Last edited time | Auto. |

So a property called `Status` of type `status` with options `New / Qualified / Contacted / …` round-trips to a Notion Status column with the same options. Same for select, multi-select, dates, numbers, etc.

Where InfiniBot diverges from Notion (deliberately):

- **No formulas / rollups yet.** The `extra` config field on `PropertyConfig` reserves space for them, but evaluation isn't implemented.
- **No databases-as-views.** A view in InfiniBot is filter+sort over a single database. No "linked database" yet.
- **Files are URL refs.** Notion stores blobs; InfiniBot stores pointers. If you need real file storage, point at S3 / R2 / a local upload endpoint.

For 90% of CRM / project / notes use cases, the property model is the same.

## Without Notion: it just works

You don't need a Notion API key, you don't need a Notion workspace, you don't need an internet connection. The local SQLite database (at `state/databases.db` or `~/.infinibot/databases.db` depending on your config) **is** the system of record.

What that means concretely:

- **All UI views** (Projects, Clients, Leads, etc.) read from + write to the local DB.
- **Agent tools** (`db.row.create`, `db.row.list`, `db.row.update`, `db.system.set` etc.) operate on the same store.
- **Kanban Projects + Tasks** are projected from the same DB through the legacy `kanban-projects` / `kanban-tasks` source types.
- **Backups** are a single file copy. `cp ~/.infinibot/databases.db ~/databases-backup.db` and you have a snapshot.
- **Migration** between machines is a file copy + restart.

Run InfiniBot for years without ever signing into Notion and you'll never know the import path exists.

## With Notion: opt-in mirror

If you already have CRM data in Notion (or you want to keep editing in both UIs), set up the optional sync:

### 1. Get a Notion API key

In your Notion workspace: **Settings & Members → Connections → Develop or manage integrations → New integration**. Copy the `secret_…` token.

### 2. Set the env var

```
NOTION_API_KEY=secret_…
```

In `.env`, your shell profile, or your gateway launch command. Restart the gateway.

### 3. Share the databases with your integration

In Notion, open each database you want to sync, click `…` → **Connections → <your integration>**. Notion's API can only see databases the integration has been granted access to.

### 4. Import once, sync ongoing

From the agent or CLI:

- **`db.import.notion`** — one-shot pull of a Notion database into a new InfiniBot `notion-import` database. Property types, options, and rows all mapped.
- **`db.sync.notion`** — bidirectional sync between an InfiniBot database and a Notion one, keyed by `ExternalRef` on each row. Detects local + remote changes by content hash and reconciles.

Either flow is **additive** — nothing about your local DB changes unless you tell it to. If sync breaks, your local data is intact.

### 5. Pick which database plays which role

System roles (`projects`, `tasks`, `clients`, `leads`, `notes`) decouple "what database" from "what role". After importing a Notion database, you can reassign:

```
db.system.set { role: "clients", databaseId: "<notion-imported-clients-db-id>" }
```

Now every agent tool that reads "the clients database" reads the Notion-mirrored one. Or keep the local one as the source of truth and use the imported one as a read-only mirror.

## Schema-evolution model

Adding / renaming / removing properties doesn't require a migration. Rows store their property values as a JSON blob keyed by `propertyId`, and queries evaluate filters in JS over the filtered row set. So:

- **Add a column** — `db.property.create`. Existing rows have no value for it (treated as empty).
- **Rename a column** — `db.property.update name=…`. The propertyId is stable; rows still resolve.
- **Delete a column** — `db.property.delete`. Values are dropped from the row JSON; ids freed.
- **Reorder** — `db.property.move` updates `sortOrder`. Fractional ordering keeps inserts cheap.

For very large databases (>10k rows per table) we'd materialize hot columns into a side table, but at typical CRM scale (hundreds to low thousands of rows) the JSON-blob model wins on simplicity.

## Cross-references between databases

The `relation` property type is how you link Clients ↔ Companies, Leads ↔ Companies, Deals ↔ Clients, etc. Loosely enforced — values are arrays of row-ids — so deleting a target doesn't cascade. This matches Notion's behavior. The `DatabaseLink` table stores additional ad-hoc links (project ↔ session, row ↔ file, etc.) for cases where a relation column isn't enough.

## TL;DR

- Out of the box: working CRM + project workspace, all in local SQLite, Notion-compatible schemas.
- No Notion account needed. Ever.
- If you want Notion: drop in an API key, run `db.import.notion`, optionally turn on `db.sync.notion`. Local DB stays the source of truth unless you explicitly hand the role over.
- Schemas evolve without migrations.
- One-file backups; one-file machine moves.

Build on it like you'd build on Airtable or Notion — except it's yours, on your machine.
