# Contributing to InfiniBot

Thanks for your interest in InfiniBot. Bug reports, fixes, docs and new
features are all welcome.

By taking part you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Links

- **Repository:** <https://github.com/MrYungCEO/infinibot-os>
- **Issues:** <https://github.com/MrYungCEO/infinibot-os/issues>
- **Discussions:** <https://github.com/MrYungCEO/infinibot-os/discussions>
- **Chat:** <!-- OWNER: add community chat link (Discord/Matrix/etc.) or delete this line -->
- **Security reports:** see [SECURITY.md](SECURITY.md). Do not open public issues for vulnerabilities.

## Ways to contribute

1. **Bugs and small fixes:** open a pull request directly. Link the issue if
   there is one.
2. **New features or architecture changes:** open an issue or a Discussion
   first, so we can agree on the approach before you write a lot of code.
3. **Questions:** use GitHub Discussions rather than issues.

Good first issues are labelled `good first issue`.

## Development setup

Requirements: **Node 22.12+** and **pnpm 10** (`corepack enable` gives you the
pinned version).

```bash
git clone https://github.com/MrYungCEO/infinibot-os.git
cd InfiniBot
pnpm install
pnpm build          # backend (TypeScript → dist/)
pnpm ui:build       # Control UI (ui/ → dist/control-ui/); run AFTER pnpm build
```

Run a development gateway that doesn't connect to your real chat channels:

```bash
pnpm gateway:dev    # sets INFINIBOT_SKIP_CHANNELS=1
```

The dashboard is at <http://127.0.0.1:18789/>. Run the UI with hot reload with
`pnpm ui:dev`.

Use a separate state directory so development doesn't touch a real install:

```bash
export INFINIBOT_STATE_DIR="$HOME/.infinibot-dev"
```

See [docs/environment.md](docs/environment.md) for every environment variable.

## Repository layout

| Path | What lives there |
| --- | --- |
| `src/` | Gateway, CLI, agents, channels, stores (TypeScript, ESM) |
| `src/gateway/server-methods/` | Gateway RPC handlers |
| `ui/` | Control UI (Lit web components, built with Vite) |
| `extensions/` | Bundled plugins (channels, providers, tools) |
| `skills/` | Bundled agent skills (`SKILL.md` per skill) |
| `apps/`, `electron/`, `mobile/` | Native, desktop and mobile clients |
| `docs/` | Documentation site sources |
| `test/` | Shared test setup and e2e tests (unit tests sit next to the code as `*.test.ts`) |

## Before you open a pull request

- `pnpm build` passes.
- `pnpm test` passes for the areas you touched (or run a single file with
  `pnpm vitest run path/to/file.test.ts`).
- `pnpm lint` and `pnpm format` are clean (`pnpm lint:fix` fixes most issues).
- UI changes: `pnpm ui:build` passes and you've looked at the result in a
  browser. Include before/after screenshots in the PR.
- New or changed behaviour is covered by a test where practical.
- User-facing changes have a line under **Unreleased** in
  [CHANGELOG.md](CHANGELOG.md).
- Docs are updated if you changed commands, config keys or env vars.
- No secrets, personal paths, hostnames, IP addresses or account IDs in code,
  tests, fixtures or screenshots.

Keep pull requests focused: one change per PR, with a description of what
changed and why.

## Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org/) style:
`feat(scope): …`, `fix(scope): …`, `docs: …`, `refactor: …`, `test: …`,
`chore: …`.

## AI-assisted contributions

Pull requests written with Claude Code, Codex, OpenCode or other AI tools are
welcome. Please:

- Say in the PR description that it is AI-assisted.
- State how it was tested (untested, lightly tested, fully tested).
- Confirm you have read and understand the code you are submitting.

If you point a coding agent at this repo, give it
[docs/contributing/AGENTS-GUIDE.md](docs/contributing/AGENTS-GUIDE.md). It
covers build, test and layout conventions for agents.

## License, CLA and sign-off

InfiniBot is licensed under the Functional Source License 1.1 with an
Apache-2.0 future license (`FSL-1.1-ALv2`). See [LICENSE](LICENSE) and the
plain-English [LICENSING.md](LICENSING.md).

### Contributor License Agreement (CLA)

Before we can merge your first pull request, you need to sign the
[InfiniBot CLA](CLA.md). It takes one comment:

1. Open your pull request. The CLA bot posts a comment with a link to the CLA.
2. Read it, then reply on the pull request with exactly:
   `I have read the CLA Document and I hereby sign the CLA`
3. The check turns green. You only sign once; it covers future contributions.

What the CLA means, in plain words:

- **You keep your copyright.** You give us a license, not ownership.
- We may ship your contribution in the public core **and** in commercial,
  OEM and hosted editions of InfiniBot. That is how the project is funded.
- Everything merged into the public core is released under FSL-1.1-ALv2 (or
  something more permissive) and **becomes Apache-2.0 two years after the
  release that contains it**. See the pledge in
  [LICENSING.md](LICENSING.md#our-pledge).

If you contribute as part of your job, make sure your employer allows it.
<!-- OWNER: add a link to a Corporate CLA here if you publish one. -->

### DCO sign-off

We also ask for a [Developer Certificate of Origin](https://developercertificate.org/)
sign-off on every commit. It records that you wrote the change, or have the
right to submit it. Add it with `-s`:

```bash
git commit -s -m "fix(gateway): handle empty session key"
```

That appends a line like this to the commit message:

```text
Signed-off-by: Your Name <you@example.com>
```

Use your real name and an email you can be reached at. To sign off commits
you already made on your branch: `git rebase --signoff main`.

### Third-party code

Don't paste code from other projects unless its license allows it and you
say so in the pull request (source URL and license). Code under the GPL,
AGPL, SSPL or other copyleft or non-commercial licenses can't be accepted.
The license-compliance CI job checks dependency licenses.
