---
summary: "How InfiniBot versions and releases work: CalVer tags trigger npm and Docker publishing"
read_when:
  - Cutting a new release
  - Choosing a version number
  - Debugging a failed npm or Docker publish
---

# Releasing InfiniBot

Releases are **tag-driven**. Nothing is published from ordinary pushes to
`main`. Pushing a version tag (`vYYYY.M.PATCH`) is the one action that publishes
the npm package and the Docker image and creates the GitHub release.

## Version scheme (CalVer)

InfiniBot uses calendar versioning: **`YYYY.M.PATCH`**

| Part | Meaning | Example |
| --- | --- | --- |
| `YYYY` | Year of the release | `2026` |
| `M` | Month of the release, **no leading zero** | `9` |
| `PATCH` | Release counter within that month, starting at `0` | `0`, `1`, `2` … |

Examples: `2026.9.0` is the first release in September 2026, and `2026.9.3` is
the fourth. The first release of the next month resets to `2026.10.0`.

- The `PATCH` number counts releases. It is **not** the day of the month.
- Versions are valid semver, so npm ordering works.
- Pre-releases add a semver suffix: `2026.9.1-beta.1`. They publish to the npm
  `beta` dist-tag and are marked as pre-releases on GitHub.
- Git tags are the version with a `v` prefix: `v2026.9.1`.

There are no API stability guarantees between months. Breaking changes must be
called out under a **Breaking** heading in the changelog.

## What a tag publishes

When a `v*` tag is pushed to the canonical repository, CI:

1. Checks that the tag matches `package.json` `version` (fails otherwise).
2. Installs with the committed lockfile, then builds, type-checks and runs the
   unit tests.
3. Publishes the `infinibot` package to npm: `latest` for stable versions,
   `beta` for pre-releases. The package is published with provenance.
4. Builds and pushes the Docker image to
   `ghcr.io/<owner>/infinibot:<version>`, and also `:latest` for stable
   versions.
5. Creates the GitHub release with the matching `CHANGELOG.md` section as the
   body.

Required repository secrets: `NPM_TOKEN` (npm automation token with publish
rights to `infinibot` and `@infinibot/*`). The GHCR push uses the built-in
`GITHUB_TOKEN`.

## One-time setup (maintainers)

Before the first tagged release:

- [ ] The `publish-npm` and `docker-release` workflows trigger **only** on
      `v*` tags and only run in the canonical repository.
- [ ] The maintainers own the `infinibot` npm package and the `@infinibot` npm
      scope, and `NPM_TOKEN` is set as a repository secret.
- [ ] The GHCR image path (`ghcr.io/<owner>/infinibot`) is set in
      `docker-release.yml`, and the package is public.

## Release checklist

Use `pnpm` (Node 22.12+) from a clean checkout of `main`.

### 1. Prepare

- [ ] `git switch main && git pull` and `git status` is clean.
- [ ] Pick the next version using the scheme above.
- [ ] Bump `version` in `package.json`.
- [ ] `pnpm plugins:sync` to align the bundled plugin versions.
- [ ] If dependencies changed, `pnpm install` and commit `pnpm-lock.yaml`.
- [ ] In `CHANGELOG.md`, rename `## Unreleased` to `## <version> — <YYYY-MM-DD>`
      and add a fresh empty `## Unreleased` above it. Entries stay newest-first.

### 2. Validate locally

- [ ] `pnpm build && pnpm ui:build`
- [ ] `pnpm lint`
- [ ] `pnpm test`
- [ ] `pnpm release:check` (checks the npm pack contents)
- [ ] `npm pack --dry-run` and check that no app bundles, videos or
      `node_modules` are included, and the size is reasonable.
- [ ] Optional: `INFINIBOT_INSTALL_SMOKE_SKIP_NONROOT=1 pnpm test:install:smoke`
      (Docker install smoke test).

### 3. Tag and push

```bash
git commit -am "release: v2026.9.1"
git tag -a v2026.9.1 -m "infinibot 2026.9.1"
git push origin main
git push origin v2026.9.1
```

Pushing the tag starts the release workflows. Watch them with
`gh run list --limit 5` / `gh run watch`.

### 4. Verify

- [ ] `npm view infinibot version` and `npm view infinibot dist-tags` show the
      new version on the right tag.
- [ ] From an empty temp directory: `npx -y infinibot@<version> --version`.
- [ ] `docker pull ghcr.io/<owner>/infinibot:<version>` works.
- [ ] The GitHub release exists, is titled `infinibot <version>`, and its body
      is the changelog section.

## If a release goes wrong

- **CI failed before publishing:** fix on `main`, delete the tag
  (`git push --delete origin vX` and `git tag -d vX`), then tag again.
- **npm already published a bad version:** npm versions can't be reused. Don't
  re-tag. Release the next `PATCH` with the fix, and run
  `npm deprecate infinibot@<bad-version> "<reason>"`.
- **Wrong dist-tag:** `npm dist-tag add infinibot@<version> latest`.

## Plugins (`@infinibot/*`)

Only plugins that are **already on npm** under the `@infinibot` scope are
published. Other bundled plugins ship inside the main package under
`extensions/**`.

1. `npm search @infinibot --json` to list the published names.
2. Compare with the `name` fields in `extensions/*/package.json`.
3. Publish only the names that appear in both lists.

Release notes must call out any **new optional bundled plugins** that are off
by default.

## Desktop and native apps

The Electron desktop app, the macOS app and the mobile apps are released
separately from the npm/Docker release, and signing them needs the owner's
certificates. See `docs/platforms/mac/release.md` for the macOS (Sparkle) flow.
The Electron auto-updater reads GitHub Releases for this repository, so attach
desktop installers to the same GitHub release as the tag.
