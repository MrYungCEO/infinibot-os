# MCP↔UI split-brain state stores

## Symptom

Data written through an MCP or agent tool (e.g. a client added by an agent, a
kanban card, a note) does not appear in the control UI — and vice-versa. No
error is thrown. Restarting doesn't help. It looks like data loss or a flaky
save, but nothing is actually lost: the writer and the reader are looking at
**two different state directories**.

## Root cause

InfiniBot keeps all mutable state (SQLite DBs, agent memory, business profile,
config) under a single **state directory**, resolved by
[`resolveStateDir()`](../src/config/paths.ts) — `~/.infinibot` by default, or
`$INFINIBOT_STATE_DIR` when overridden.

The gateway and the MCP/agent tool surface must resolve the **same** dir:

- **Gateway** opens its stores under `resolveStateDir()` (config under
  `resolveSharedDir()` / `resolveConfigPath()`).
- **MCP stdio entry** ([`src/cli/mcp-stdio.ts`](../src/cli/mcp-stdio.ts)) does
  *not* open its own store. It connects to the **running gateway** over
  WebSocket (`MOLTBOT_GATEWAY_URL`, default `ws://127.0.0.1:18789`) and forwards
  every read/write. So it inherits the gateway's state dir *by construction* —
  as long as it keeps delegating.

The brain splits when a code path resolves a **different** dir than the gateway.
Two ways this has happened:

1. **Repo-local fallback.** A module used
   `process.env.INFINIBOT_STATE_DIR || "state"`, which resolves to `<cwd>/state`
   — a directory that moves with the process's launch directory and that
   nothing else reads. Real incident: Whop payment credentials were written to
   `<cwd>/state/business/income.json` while the reader looked at
   `~/.infinibot/business/income.json`; every payment link failed with "API key
   not configured".
2. **Override drift.** The daemon env carried a stray `INFINIBOT_STATE_DIR` (or
   a non-default user profile) while a fully-populated `~/.infinibot` sat
   untouched. Reads landed in a new/empty dir and the UI "lost" everything.

## The fix

- All state resolution goes through `resolveStateDir()` /
  `resolveSharedDir()` / `resolveConfigPath()` in `src/config/paths.ts`. Never
  reintroduce the `|| "state"` repo-local fallback.
- The MCP entry keeps delegating to the gateway over WS — it must never open a
  local store.

## Reconcile an install that already split

If data looks missing after the state dir was realigned, don't panic — the old
copy is still on disk. Reconcile it forward:

1. **Find both dirs.** The active one is whatever the gateway logs at boot (or
   `echo "$INFINIBOT_STATE_DIR"`; unset ⇒ `~/.infinibot`). The stray copy is
   usually `~/.infinibot` (if an override is now set) or a repo-local
   `<repo>/state/`.
2. **Stop the gateway** so nothing writes mid-copy.
3. **Copy forward, never clobber.** The codebase already ships conservative,
   copy-then-keep migrators that run at boot:
   - `backfillStateFromRepo()` — pulls a stale repo-local `state/business.json`
     and `state/databases.db` into the canonical dir *only when the target is
     missing them*.
   - `migrateLegacyStateDir()` — rescues a previous brand's `~/.moltbot` /
     `~/.clawdbot` store.
   - `stateFilePathWithLegacyMigration()` — migrates an individual file forward
     on first access.
   For anything they don't cover, copy by hand and **never overwrite a
   newer/larger target** (the home copy is almost always authoritative):
   ```bash
   # example: rescue a repo-local store into the canonical dir
   rsync -av --ignore-existing <repo>/state/ ~/.infinibot/
   ```
4. **Restart the gateway** and confirm the UI and MCP tools now agree.

## The guard (so it can't silently return)

Three layers, added under `src/config/` and `docs/`:

1. **Regression test** — `src/config/state-dir-split-brain.test.ts`
   Asserts the gateway path and the MCP-side path resolve the **same** state dir
   across an env/HOME matrix, that resolution is deterministic, and that
   `mcp-stdio.ts` still delegates to the gateway (opens no local store). Fails
   if a future change re-splits them.
2. **Hygiene test** — `src/config/state-dir-hygiene.test.ts` (pre-existing)
   Caps the number of files using the deprecated `<cwd>/state` fallback; any new
   offender fails the build.
3. **Boot self-check** — `src/config/state-dir-selfcheck.ts`
   `runStateDirSelfCheck()` logs a clear `WARNING` at boot if the active state
   dir has none of the canonical store markers, or if a populated `~/.infinibot`
   exists while the process resolved a *different* active dir. It only logs —
   never throws, never blocks boot.

   **Wiring (not done automatically):** call `runStateDirSelfCheck()` once at
   gateway boot, right after `migrateLegacyStateDir()` / `backfillStateFromRepo()`
   run and before any store opens — e.g. in `src/entry.ts`:

   ```ts
   migrateLegacyStateDir();
   backfillStateFromRepo();
   runStateDirSelfCheck();   // ← add this line
   ```

## Run the tests

```bash
# just the split-brain guards
npx vitest run src/config/state-dir-split-brain.test.ts src/config/state-dir-selfcheck.test.ts

# with the existing hygiene guard too
npx vitest run src/config/state-dir-split-brain.test.ts \
  src/config/state-dir-selfcheck.test.ts \
  src/config/state-dir-hygiene.test.ts
```
