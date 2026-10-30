---
summary: "Instructions for AI coding agents (Claude Code, Codex, OpenCode, Cursor…) contributing to the InfiniBot repo"
read_when:
  - You are an AI coding agent working in this repository
  - You are setting up a coding agent to contribute to InfiniBot
---

# Guide for AI coding agents

This file is for AI coding agents that change **the InfiniBot source code**.
Humans should read [CONTRIBUTING.md](../../CONTRIBUTING.md) first; everything
there applies to agents too.

> Not to be confused with `docs/reference/templates/AGENTS.md`. That is the
> template InfiniBot copies into a user's *agent workspace* at runtime. It
> tells InfiniBot's own agents how to behave, not how to edit this repo.

## Ground rules

- Keep changes small and focused on the task. Don't reformat or refactor
  unrelated code.
- Read the surrounding code first and match its style, naming and comment
  density.
- Never commit secrets, API keys, tokens, personal paths (`/home/<you>`,
  `C:\Users\<you>`), hostnames, LAN IPs or account IDs, including in tests,
  fixtures, docs and screenshots.
- Don't touch a real InfiniBot install while developing. Point the state
  directory somewhere disposable:
  `export INFINIBOT_STATE_DIR="$(mktemp -d)"`.
- Don't run `git push`, publish packages, or delete branches unless a human
  asked for it.
- Say in the PR description that the change is AI-assisted, and how it was
  tested.

## Stack and layout

- TypeScript, ESM, **Node 22.12+**, **pnpm 10**.
- `src/`: gateway, CLI, agents, channels, stores. Unit tests live next to the
  code as `*.test.ts` (Vitest).
- `src/gateway/server-methods/`: gateway RPC handlers, one file per namespace.
- `src/agents/`: agent runtime, tools (`src/agents/tools/`) and the tool
  registry (`src/agents/infinibot-tools.ts`).
- `ui/`: Control UI, built with Lit web components and Vite. Views are in
  `ui/src/ui/views/`, controllers in `ui/src/ui/controllers/`.
- `extensions/`: bundled plugins. Each has its own `package.json`.
- `skills/`: bundled agent skills, one `SKILL.md` per skill.
- `docs/`: documentation site (Mintlify, `docs/docs.json`).
- Runtime state lives in `~/.infinibot` (or `$INFINIBOT_STATE_DIR`), never
  in the repo.

## Build, test, lint

```bash
pnpm install
pnpm build        # backend → dist/
pnpm ui:build     # Control UI → dist/control-ui/  (always run AFTER pnpm build)
pnpm test         # all unit tests
pnpm vitest run src/path/to/file.test.ts   # one file
pnpm lint         # oxlint
pnpm format       # oxfmt --check   (pnpm format:fix to write)
```

Things that trip agents up:

- **Build order matters.** `pnpm build` starts by cleaning `dist/`, which
  removes the built Control UI. Run `pnpm ui:build` after it, or the dashboard
  returns 503.
- **`tsc` emits even when there are type errors** (`noEmitOnError: false`).
  A successful build doesn't mean the types check. Read the `tsc` output and
  don't add new errors.
- **The running gateway doesn't hot-reload backend code.** New RPC methods or
  agent tools show up only after a rebuild and a gateway restart. Before
  assuming your code is broken, check whether the running gateway predates it.
- **UI changes need visual verification.** Build the UI and look at the page
  in a real browser (a headless screenshot is fine). Don't report a layout fix
  as done just from reading the CSS.

## Common change recipes

### Add a gateway RPC method

1. Add the handler to the namespace file in `src/gateway/server-methods/`
   (or create one), and export its handlers.
2. Register the handlers in `src/gateway/server-methods.ts`
   (`coreGatewayHandlers`) and the method name in
   `src/gateway/server-methods-list.ts`.
3. Classify the method's scope in `src/gateway/server-methods.ts`: add it to
   the read-method or write-method sets, or export `*_READ_METHODS` /
   `*_WRITE_METHODS` from your namespace file and spread them in. An
   unclassified method is rejected or needs admin scope.
4. Add a test next to the handler.

### Add an agent tool

1. Implement it in `src/agents/tools/`.
2. Register it in `createInfiniBotTools` in `src/agents/infinibot-tools.ts`.
3. If agents must be allowed to call it by default, add it to the relevant
   agent's tool allow-list in `src/agents/standard-roster.ts`. Existing
   installs keep their own allow-list in config.

### Add a Control UI page

Add the view in `ui/src/ui/views/`, its route and navigation entry
(`ui/src/ui/navigation.ts`), and lazy-load it. Don't delete existing views or
routes. Saved layouts and deep links depend on them.

### Add or change an environment variable

Prefer a config key (see `src/config/`) over a new env var. If you add an env
var, use the `INFINIBOT_` prefix and document it in
[docs/environment.md](../environment.md).

## Before you finish

- `pnpm build` passes, and so do `pnpm ui:build` for UI changes and `pnpm test`
  for the areas you touched.
- New behaviour has a test where practical.
- User-facing change → add a line under **Unreleased** in `CHANGELOG.md`.
- Commands, config keys or env vars changed → docs updated.
- `git diff` contains only files related to your task.
