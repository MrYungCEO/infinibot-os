# InfiniBot npm publish checklist

`infinibot` on npm: <https://www.npmjs.com/package/infinibot>

Versioning is **calver** `YYYY.M.PATCH`, for example `2026.10.0`. The month is not zero-padded. PATCH starts at `0` each month and increments per release.

Publishing is automated. You almost never run `npm publish` by hand.

## How a release happens

`.github/workflows/publish-npm.yml` runs on every push to `main` (and on manual `workflow_dispatch`, which defaults to a dry run):

1. Checkout, pnpm 10.23.0, Node 22.
2. `pnpm install --frozen-lockfile`. `pnpm-lock.yaml` is committed, so CI builds exactly what was tested.
3. `node scripts/next-release-version.mjs` picks the version (see below), then `npm version` and `pnpm plugins:sync` apply it.
4. `pnpm typecheck`, then `pnpm build:all` (backend, then control UI).
5. `pnpm release:check` validates the pack contents.
6. `npm pack --ignore-scripts`, then a **smoke test**: the tarball is installed into a clean prefix with a clean `HOME`, `infinibot --version` must print the new version, non-interactive onboarding must succeed, and the gateway must boot and serve the UI and `/install.sh`.
7. npm is upgraded to `^11.5.1`, then `npm publish <tarball> --access public --tag latest`. Authentication is npm trusted publishing (OIDC, no stored token); the `NPM_TOKEN` secret is only a fallback. Provenance is added only when the repository is public (npm rejects provenance from private repos).
8. Commits `release: v<version> [skip publish]`, tags `v<version>`, and pushes both. A rejected branch push is a warning, not a failure: the package is already published and the next run recomputes the version from npm.
9. Calls the federation self-update webhook, if `FEDERATION_UPDATE_WEBHOOK` is set.

The `v<version>` tag also triggers `docker-release.yml`.

### Publish authentication

`npm publish` failing with `E404 Not Found - PUT https://registry.npmjs.org/infinibot` after every other step passed means npm did not accept the credentials (npm answers 404, not 401, on a write it cannot authorize).

Preferred: trusted publishing (one-time, by a maintainer of the npm package):

1. npmjs.com → sign in as a maintainer → package `infinibot` → **Settings** → **Trusted Publisher** → **GitHub Actions**.
2. Organization or user `MrYungCEO`, repository `InfiniBot`, workflow filename `publish-npm.yml`, environment empty. Save.
3. Optional hardening, once a release has gone through: in the same Settings page set publishing access to "Require two-factor authentication and disallow tokens", then delete the `NPM_TOKEN` secret.

Requirements, all met by the workflow: GitHub-hosted runner, `permissions: id-token: write`, npm >= 11.5.1, Node >= 22.14.

Fallback: a granular access token. npmjs.com → avatar → **Access Tokens** → **Generate New Token** → **Granular Access Token**, permissions *Read and write*, packages: only `infinibot`, with an expiry. Then `gh secret set NPM_TOKEN -R MrYungCEO/InfiniBot` and paste it.

### Version selection

`scripts/next-release-version.mjs` (`pnpm release:version`):

- base = max(npm `latest`, `package.json` version)
- if `package.json` is ahead of npm and in the current month, it is used as-is (a deliberate bump)
- otherwise the next patch after the base, or `YYYY.M.0` when the month rolled over
- the candidate is advanced until npm has no such version

So a stale `package.json`, a manual publish that was never committed back, or a version published under another dist-tag cannot cause `403 cannot publish over existing version`.

```bash
pnpm -s release:version --json
# {"local":"2026.10.0","latest":"2026.6.29","next":"2026.10.0","publishedCount":79}
```

### What `release:check` guards

`pnpm release:check` (`scripts/release-check.ts`) fails when:

- an `extensions/*/package.json` version differs from the root version (fix: `pnpm plugins:sync`)
- the served installer copies drifted from `scripts/install-infinibot.*` (fix: `pnpm install-scripts:sync`)
- a required file is missing (`dist/entry.js`, `dist/control-ui/index.html`, `scripts/postinstall.js`, the installers, ...)
- any compiled top-level `dist/<dir>/` is absent from the pack
- the pack contains `.env*`, keys or keystores, databases, logs, nested `node_modules`, test files, source maps, or the marketing site
- a shipped text file contains something shaped like a credential
- the tarball is larger than 160 MB

`files[]` in `package.json` ships `dist/**` minus test helpers, so a new `src/<dir>/` needs no packaging change.

## Releasing

1. Open a PR into `main`. `ci.yml` and `install-smoke.yml` run on it.
2. Optional preview: Actions → **Publish npm** → Run workflow on the PR branch with `dry-run` checked. It does everything except publish, tag and push.
3. Merge. The push to `main` publishes.
4. Verify:

```bash
npm view infinibot version dist-tags
npx -y infinibot@latest --version
```

5. If the installer scripts changed, deploy the landing site so `https://infinibotos.com/install.sh` and `/install.ps1` serve the new copies. See [Installer internals](install/installer.md#where-the-scripts-are-hosted).

To skip publishing for a push to `main`, put `[skip publish]` in the head commit message.

## Dry run locally

Use Node 22. A plain `npm pack` runs `prepack` (`pnpm build && pnpm ui:build`) and rebuilds `dist/`; add `--ignore-scripts` to pack what is already built.

```bash
pnpm install --frozen-lockfile
pnpm build:all
pnpm release:check

rm -rf /tmp/ib-pub && mkdir -p /tmp/ib-pub/{prefix,home}
npm pack --ignore-scripts --pack-destination /tmp/ib-pub
cd /tmp/ib-pub
HOME=/tmp/ib-pub/home NPM_CONFIG_PREFIX=/tmp/ib-pub/prefix npm install -g ./infinibot-*.tgz
HOME=/tmp/ib-pub/home ./prefix/bin/infinibot --version
HOME=/tmp/ib-pub/home ./prefix/bin/infinibot onboard --non-interactive --accept-risk \
  --skip-daemon --skip-health --skip-channels --skip-skills --skip-ui --auth-choice skip \
  --gateway-port 18990 --gateway-auth password --gateway-password smoke-test-only
HOME=/tmp/ib-pub/home INFINIBOT_SKIP_CHANNELS=1 ./prefix/bin/infinibot gateway --port 18990 &
curl -fsS http://127.0.0.1:18990/ | grep -i "<title>"
kill %1          # stop it by job/PID; never pkill by process name
```

Run the installed CLI from a directory outside the repo. That is how a real user runs it, and it catches code that resolves modules relative to the current directory.

To exercise the installer against the local tarball instead of npm:

```bash
INFINIBOT_NPM_SPEC=/tmp/ib-pub/infinibot-<version>.tgz bash scripts/install-infinibot.sh --no-onboard
```

## Manual publish (fallback)

Only when CI is unavailable.

```bash
npm whoami                                   # must succeed; otherwise npm login
npm version "$(pnpm -s release:version)" --no-git-tag-version --allow-same-version
pnpm plugins:sync
pnpm build:all && pnpm release:check
npm pack --ignore-scripts
npm publish ./infinibot-<version>.tgz --access public --tag latest
git commit -am "release: v<version> [skip publish]" && git tag v<version>
git push origin HEAD v<version>
```

## Rollback

npm never lets a version be overwritten or reused.

- `npm dist-tag add infinibot@<good> latest` points `latest` back at a known-good version.
- `npm deprecate infinibot@<bad> "broken release, use <good>"` warns installers.
- Fix forward with the next patch. `npm unpublish` works only within 72 hours and is a last resort.
- A bad release has already been announced to federation satellites by the webhook, so publish the fix promptly.

## Package facts (2026.10.0)

- 5,390 files, 45.5 MB packed, 105 MB unpacked (CI build). The control UI (`dist/control-ui`) is 46 MB unpacked. The agent avatars are 640px WebP (1 MB in total; they were 58 MB of PNG).
- A local pack from a worktree whose `node_modules` is a symlink carries 57 extra files: Vite bundles the Mermaid diagram chunks twice there. The CI tarball is the reference; nothing in it is missing.
- Installing needs Node 22.12+ and git. One transitive dependency (`libsignal`, via the WhatsApp library) is a GitHub reference, so npm shells out to git. The installer scripts install git; `overrides` cannot fix this for a globally installed package.
- `postinstall` (`scripts/postinstall.js`) fixes the bin mode, sets up git hooks only inside a git checkout, runs `scripts/fix-hyperframes-esm.mjs`, and applies `patches/` under non-pnpm package managers. Every script it calls must be listed in `files[]`.

## Scrub rules (what must not ship)

The package and the repository must not contain the maintainer's home paths, LAN or tailnet addresses, tailnet hostnames, personal email addresses or secrets. Before a release:

```bash
gitleaks git --log-opts="origin/main..HEAD" -c .github/gitleaks.toml .
gitleaks dir -c .github/gitleaks.toml .
git grep -nIE "/home/[a-z]+/(Desktop|\\.infinibot)|~/Desktop|tail[0-9a-f]{6}\\.ts\\.net" -- . ':!pnpm-lock.yaml'
```

Values that used to be hard-coded are now read from the environment. Set these on a machine that relied on the old defaults:

| Variable | Used by | Old hard-coded value |
| --- | --- | --- |
| `SOLATRIX_LEGACY_ROOT` | Solatrix one-time legacy import (`extensions/solatrix/src/core.ts`) and its vendor scripts | the folder holding the `solatrix-*` app directories |
| `CHROME_PATH` | screenshot and verification scripts under `scripts/`, `ui/src/dev/`, `extensions/*/scripts` | absolute path to Chrome. Unset means Puppeteer's own browser |
| `ANDROID_OPS_BASE_URL` | `scripts/android-ops-email-setup-report.mts` | origin of the Android Ops dashboard |
| `NOTES_SOURCE_DIR` | `scripts/restore-3-notes.mts` | folder of notes to restore |
| `SHOTS_OUT` | `scripts/focus-shots*.mjs` | screenshot output folder |
| `INFINIBOT_LIVE_NAV_SIDEBAR` | `ui/src/ui/controllers/nav-sidebar-favorites.test.ts` (optional live-layout test) | path to a live `nav-sidebar.json` |

Example addresses in docs, placeholders and tests use `192.168.1.x`, `100.64.x.x` and `*.example-tailnet.ts.net` / `*.tail1234.ts.net`.

## Lint

`pnpm lint` runs `scripts/lint-ratchet.mjs`: it fails only when a file has more violations of a rule than `.oxlint-baseline.json` records. `pnpm lint:full` prints every violation. When you clean a file up, run `pnpm lint:baseline` and commit the smaller baseline. Never raise it.
