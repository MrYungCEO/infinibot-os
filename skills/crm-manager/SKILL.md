---
name: crm-manager
description: Drive the InfiniBot CRM (Clients page + underlying database) through the ui_control tool — switching grid/table/kanban views, adding/updating/deleting clients, bulk-importing leads from a scrape or CSV. Trigger when the user asks to "add a client", "switch the CRM to kanban", "import these leads", "show clients in a board", or anything that touches the Clients tab or the clients-role database.
metadata: {"infinibot":{"emoji":"📇","requires":{"servers":["ui_control"]}}}
---

# CRM Manager

The CRM in InfiniBot has two surfaces that look similar but are wired
differently — and getting them mixed up wastes round-trips. This skill is
the cheat sheet.

## The two surfaces

| Surface | View name | Drives | When to use |
|---|---|---|---|
| **Clients page** (top-level "Clients" tab) | `clients` | Its own `viewMode` (`grid` / `table` / `kanban`), its own create/edit dialogs, business-scoped via `business.clients.*` | The user is on the Clients page or asks for the CRM specifically |
| **Databases page** rendering the clients-role db | `databases` | Generic database renderer (`table` / `board` / `gallery` / `calendar`), works on any db | The user is in Databases or you need raw row-level CRUD |

The two **do not share view state**. `databases.set_view` cannot flip the
Clients page to kanban — use `clients.set_view_mode` for that.

## Switching the Clients page view

```
ui_control dispatch view=clients op=set_view_mode args={"mode":"kanban"}
```

Valid modes: `grid`, `table`, `kanban`. For kanban you usually want to set
the grouping column too:

```
ui_control dispatch view=clients op=set_kanban_group_by args={"propertyName":"Status"}
```

## Adding a client (one)

The Clients page talks to the active business's CRM via
`business.clients.create`. Use the `clients` view — it skips the dialog:

```
ui_control dispatch view=clients op=add_client args={"data":{
  "Name": "Acme Coworking",
  "Phone": "02 555 0000",
  "Website": "https://acme.example",
  "Status": "Prospect",
  "Tags": ["Bangkok","Coworking"]
}}
```

Keys are the schema's property **names** (case-sensitive as displayed).
Values are bare strings/arrays — the gateway handles typing.

## Bulk import (CSV → CRM)

For 10+ leads, drive the underlying database directly with `create_rows`.
The friendly value coercion handles property types automatically:

```
ui_control dispatch view=nav op=open_page args={"target":"clients"}
ui_control dispatch view=databases op=create_rows args={"rows":[
  {"title":"Acme Coworking", "values":{
    "Phone":"02 555 0000",
    "Website":"https://acme.example",
    "Tags":["Bangkok","Coworking"],
    "Notes":"Address: ...\nRating: 4.9"
  }},
  {"title":"Beta Workspace", "values":{ ... }}
]}
```

Then flip the Clients page to kanban so the user sees the import land:

```
ui_control dispatch view=clients op=set_view_mode args={"mode":"kanban"}
```

### Value shape — friendly vs typed

Both `create_row` / `create_rows` / `update_row` accept either:

- **Friendly** (preferred): `{"Phone":"02 555 0000", "Website":"https://...", "Tags":["A","B"], "MRR": 1200, "Active": true}`
  Keys may be the property name (case-insensitive) or its id. Bare
  strings/numbers/booleans/arrays are coerced to the right `PropertyValue`
  shape based on the property type. Unknown keys are silently ignored
  (so partial updates work after schema renames).
- **Typed** (still accepted): `{"prop_xxx": {"type":"phone","phone":"02 555 0000"}}`

For select/multiSelect/status, you can pass the option **label** OR id.
Unknown labels pass through as-is so they're visible if/when the option
is created.

## Updating / deleting

```
ui_control dispatch view=clients op=update_client args={"id":"...","data":{"Status":"Customer"}}
ui_control dispatch view=clients op=delete_client args={"id":"..."}
```

For a row in the underlying database (e.g. from a `query_rows` call):

```
ui_control dispatch view=databases op=update_row args={"rowId":"...","values":{"Status":"Customer"}}
```

## Discovery flow

1. `ui_control list_views` — confirm `clients` and `databases` are advertised.
2. `ui_control dispatch view=clients op=get_state` — read `viewMode`,
   `clientCount`, `schemaTitleProperty` to learn the title prop name.
3. `ui_control dispatch view=databases op=get_state` — read `properties[]`
   for the full schema (name → id → type) before composing values.

## Failure modes to avoid

- Passing values without a typed wrapper and **without** going through the
  agent verbs — the raw `db.rows.upsert` gateway call won't coerce.
- Calling `databases.set_view` when the user is on the Clients tab. It
  flips the *databases* page renderer; the visible Clients page won't move.
- Calling `clients.add_client` before the user has loaded a CRM — if there's
  no active business or no clients-role database, the create returns an error.
  Run `clients.refresh` (or `nav.open_page target=clients`) first.
