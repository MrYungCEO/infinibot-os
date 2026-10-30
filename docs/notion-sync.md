---
title: Notion sync
description: Connecting Notion as an optional mirror for kanban
---

InfiniBot can mirror its kanban data to Notion. This is opt-in. The local SQLite store is always the source of truth — Notion is a one-way or two-way mirror controlled by a sync mode.

If you do not use Notion, skip this entirely. Kanban works without it.

## Sync modes

Set in `notion.syncMode` in your config. Read by every kanban code path through `getNotionConfig()` in `src/databases/notion-config.ts`.

| Mode           | Behaviour                                                                                       |
|----------------|--------------------------------------------------------------------------------------------------|
| `off`          | No Notion calls at all. Kanban runs on local SQLite only. Default for fresh installs.            |
| `mirror`       | Local SQLite is canonical. Every kanban write fires a best-effort mirror call to Notion.         |
| `import-once`  | One-shot import from Notion into local SQLite. After import the mode flips to `off` automatically. Useful for migrating in. |

Switching modes:

```bash
# Via the wizard
infinibot quickstart   # walks you through token + verify + finalize

# Via the API (programmatic)
# notion.wizard.finalize({ apiKey, syncMode: "mirror", projectsDbId, tasksDbId })

# Via config edit
# Edit ~/.infinibot/infinibot.json:
#   "notion": { "syncMode": "off" }
# then restart the gateway
```

## The setup wizard

The Notion step in [quickstart](/cli/quickstart) is the cleanest way to wire Notion. Five steps, each with verification and inline error recovery.

### Step 1: paste your integration token

The wizard sends a `GET /users/me` request to Notion. If that succeeds you see the workspace name and the integration name. If it fails:

| Failure        | Cause                                              | Fix                                                                     |
|----------------|----------------------------------------------------|-------------------------------------------------------------------------|
| `unauthorized` | Token is wrong or expired                          | Re-copy from Notion: Settings → Connections → Develop or manage integrations → your integration → Show secret. The token starts with `secret_` or `ntn_`. |
| `request_failed` | Notion is unreachable                            | Check your network. The wizard times out after 30 seconds.              |

The token is held in memory (runtime override) until you finalize. Closing the wizard before finalize discards it.

### Step 2: pick a parent page

The wizard calls `POST /search` filtered to pages and lists what your integration can see. The page you pick is where InfiniBot creates its `Projects` and `Tasks` databases.

If the list is empty:
1. Open the desired parent page in Notion.
2. Click the **...** menu in the top right.
3. Choose **Connections** → **Add connections** → invite **InfiniBot Sync** (or whatever you named your integration).
4. Click **Reload** in the wizard.

### Step 3: create system databases

The wizard sends two `POST /databases` calls.

The Projects database is created with these properties:

| Property      | Type      | Notes                                                  |
|---------------|-----------|--------------------------------------------------------|
| Project       | Title     | Required.                                              |
| Status        | Status    | Default Notion options.                                |
| Priority      | Select    | Options: Immediate, High, Medium, Low.                 |
| Description   | Rich text | Markdown body of the page is also synced.              |
| Due Date      | Date      |                                                        |

The Tasks database is created with these properties:

| Property         | Type             | Notes                                              |
|------------------|------------------|----------------------------------------------------|
| Task Name        | Title            | Required.                                          |
| Status Update    | Status           |                                                    |
| Priority Level   | Select           | Same options as Projects.                          |
| Description      | Rich text        |                                                    |
| Due Date         | Date             |                                                    |
| Project          | Relation         | Targets the Projects DB. Single-property relation. |
| Done             | Checkbox         |                                                    |

The wizard saves the new database IDs into `notion.projectsDbId` and `notion.tasksDbId`. These are then used by every code path that talks to Notion.

### Step 4: run verification

Five checks, all surfaced in the UI with pass/fail and a fix-it hint if anything fails.

1. **Token still works** — `GET /users/me`.
2. **Projects database reachable** — `GET /databases/<projectsDbId>`. Catches the case where the integration was uninvited from the page after step 1.
3. **Tasks database reachable** — same for tasks.
4. **Tasks to Projects relation wired** — fetches the Tasks DB schema and checks that `properties.Project.relation.database_id` matches the Projects DB ID. Catches the case where the relation broke during creation.
5. **Write probe** — creates a temp page in Projects titled "InfiniBot setup probe (safe to delete)" then archives it. Catches the case where the integration has read but not write permission.

If any check fails you can click **Retry** to re-run the pass after fixing things in Notion. No need to start over.

### Step 5: finalize

Persists `notion.apiKey`, `notion.syncMode`, `notion.projectsDbId`, `notion.tasksDbId`, `notion.parentPageId`, `notion.integrationName` to `~/.infinibot/infinibot.json`. Also sets the runtime override so the new config is visible to in-flight callers without a restart.

## Configuration reference

The `notion` block in `infinibot.json`:

```jsonc
{
  "notion": {
    "apiKey": "secret_...",
    "syncMode": "mirror",
    "projectsDbId": "abc-...-def",
    "tasksDbId": "ghi-...-jkl",
    "parentPageId": "mno-...-pqr",
    "integrationName": "InfiniBot Sync"
  }
}
```

| Field             | Type     | Required                | Notes                                                                |
|-------------------|----------|-------------------------|----------------------------------------------------------------------|
| `apiKey`          | string   | yes (when sync != off)  | Notion integration secret. Falls back to `NOTION_API_KEY` env var.   |
| `syncMode`        | string   | yes                     | `off`, `mirror`, or `import-once`. Default `off`.                    |
| `projectsDbId`    | string   | yes (when sync != off)  | Notion DB ID for Projects.                                           |
| `tasksDbId`       | string   | yes (when sync != off)  | Notion DB ID for Tasks.                                              |
| `parentPageId`    | string   | optional                | The page where InfiniBot created its DBs. Used by re-verification.   |
| `integrationName` | string   | optional                | Display name shown in the wizard.                                    |

### Env-var compatibility

These environment variables are still honoured for back-compat:

| Env var               | Maps to             |
|-----------------------|---------------------|
| `NOTION_API_KEY`      | `notion.apiKey`     |
| `NOTION_PROJECTS_DB`  | `notion.projectsDbId` |
| `NOTION_TASKS_DB`     | `notion.tasksDbId`  |

When `NOTION_API_KEY` is set but no `notion.syncMode` is configured, the system defaults to `mirror` mode so existing setups keep working unchanged.

## Manual disconnect

To turn off Notion sync entirely:

```bash
# Re-run the wizard and click "Skip Notion"
infinibot quickstart

# Or call the disconnect RPC directly
# notion.wizard.disconnect({})

# Or edit your config:
# "notion": { "syncMode": "off" }
```

After disconnect, kanban continues to work from local SQLite. No data is lost.

## Re-importing from Notion

If you want to pull data down again after sync was off:

1. Run `infinibot quickstart` and finish the Notion wizard with `syncMode: import-once` (or set it manually in config).
2. Restart the gateway. The next kanban read triggers the import.
3. After import completes, the system flips `syncMode` back to `off` automatically.

For the legacy hardcoded-UUID kanban DBs (pre-revamp setups), use the migration step instead — open quickstart, go to the **Kanban** step, click **Import legacy Notion kanban**. The migration is idempotent and safe to re-run.

## RPC reference

These RPCs power the wizard. You can call them yourself if you are integrating Notion setup into a custom UI.

### `notion.wizard.status`

Returns the current state. Used by the entry screen to skip already-completed steps.

```ts
{
  notion: {
    configured: boolean
    syncMode: "off" | "mirror" | "import-once"
    projectsDbId: string | null
    tasksDbId: string | null
    parentPageId: string | null
    integrationName: string | null
    reachable?: boolean   // true iff /users/me succeeds with the saved key
  }
  kanban: {
    syncMode: "off" | "mirror" | "import-once"
    notionConfigured: boolean
    projects: { databaseId: string, source: string }
    tasks: { databaseId: string, source: string }
  }
}
```

### `notion.wizard.verifyToken`

```ts
// params
{ apiKey: string }

// response (always returns ok: true at the RPC level; the body has its own ok flag)
{
  ok: boolean
  integrationName?: string
  workspace?: string
  botId?: string
  error?: string
  hint?: string
}
```

### `notion.wizard.listPages`

```ts
// params
{ apiKey: string }

// response
{
  pages: Array<{
    id: string
    title: string
    kind: "page"
    url?: string
    parentTitle?: string
    lastEditedAt: number
  }>
}
```

### `notion.wizard.createSystemDbs`

```ts
// params
{ apiKey: string, parentPageId: string, projectsTitle?: string, tasksTitle?: string }

// response
{
  projectsDbId: string
  tasksDbId: string
  projectsUrl?: string
  tasksUrl?: string
}
```

### `notion.wizard.verifySetup`

```ts
// params
{ apiKey: string, projectsDbId: string, tasksDbId: string }

// response
{
  ok: boolean
  checks: Array<{
    id: string
    label: string
    ok: boolean
    detail?: string
    hint?: string
  }>
}
```

### `notion.wizard.finalize`

```ts
// params
{
  apiKey: string
  syncMode: "off" | "mirror" | "import-once"
  parentPageId?: string
  projectsDbId?: string
  tasksDbId?: string
  integrationName?: string
}

// response
{ ok: true, syncMode: "off" | "mirror" | "import-once" }
```

### `notion.wizard.disconnect`

Equivalent to `finalize` with `syncMode: "off"`.

```ts
// params: none
// response
{ ok: true }
```

## Internals

For contributors:

- `src/databases/notion-config.ts` — the single source of truth for "is Notion configured?". Every caller goes through `getNotionConfig()`, `getNotionApiKeyOrNull()`, `isNotionEnabled()`, `resolveNotionDbId(source)`. Never throw on missing config; fall back to local store.
- `src/databases/notion-wizard.ts` — pure functions for each wizard step. Testable in isolation.
- `src/databases/notion-kanban-migration.ts` — the legacy importer. Stamps `__legacyNotionMigrationCompletedAt` into the database `meta` field so re-runs are no-ops.
- `src/gateway/server-methods/notion-wizard.ts` — RPC handlers that wrap the wizard module.

The mirror layer in `src/databases/kanban-store-ops.ts` (functions `mirrorProjectToNotion` and `mirrorTaskToNotion`) reads `notion.syncMode` and the API key on every call, so mode changes take effect immediately without a restart.

## See also

- [Quickstart](/cli/quickstart) — the web setup that drives the wizard
- [Kanban](/kanban) — what the synced data looks like locally
