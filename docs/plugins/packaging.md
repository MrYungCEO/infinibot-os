# InfiniBot Plugin Package

A plugin package is one zip file that holds a plugin exactly as it runs. This page is the format specification, plus the versioning rules and the `pack` and `validate` commands.

See also: [getting started](getting-started.md), [manifest reference](manifest-reference.md), [updates](updates.md), [security model](security-model.md), [publishing](publishing.md), [registry API](registry-api.md).

## Format

| Property | Rule |
| --- | --- |
| Container | A ZIP archive. ZIP64 is not accepted. |
| File name | `<id>-<version>.ibplugin.zip` is what `pack` writes. Any `.zip` is accepted on install. |
| Format id | `infinibot-plugin-package@1` |
| Manifest | `infinibot.plugin.json` at the zip root, or inside exactly one top-level folder. |
| Runtime files | Prebuilt. Nothing is compiled or installed on the user's machine: there is no `npm install` step and no install script. |
| Entry file | `package.json` → `infinibot.extensions` (paths inside the package), or `index.ts` / `index.js` / `index.mjs` / `index.cjs` at the package root. |
| Optional files | `CHANGELOG.md`, `README.md`, `LICENSE`, and assets such as `assets/icon.svg`. |

A typical package:

```
infinibot.plugin.json     required
package.json              names the entry file
index.js                  entry (gateway side)
ui.js                     UI module the plugin serves
assets/icon.svg           listing images
CHANGELOG.md              shown in the install review and on update
README.md
LICENSE
```

Archiver leftovers (`__MACOSX/`, `.DS_Store`, `Thumbs.db`) are ignored when a package is read.

### Dependencies

Packages are installed without running a package manager. Bundle your dependencies into your build output, or pack `node_modules` with `--include-node-modules`. The host provides `infinibot/plugin-sdk` to every plugin, so do not bundle it.

## Required manifest fields

On top of what the loader needs, a manifest must have these fields to be packed, installed or published. The [manifest reference](manifest-reference.md) marks them "For packages".

| Field | Rule |
| --- | --- |
| `manifestVersion` | `2` |
| `id` | Lowercase letters, digits and dashes, 2–64 characters. Not a reserved id (`infinibot`, `core`, `gateway`, `system`, `plugins`, `plugin`, `config`, `chat`, `sessions`, `agents`, `agent`, `auth`, `admin`, `api`, `marketplace`, `registry`, `update`, `updates`). |
| `name` | 64 characters or fewer. |
| `version` | Semver: `MAJOR.MINOR.PATCH`, optional `-prerelease` and `+build`. |
| `publisher` | Your publisher id (same character rules as `id`). |
| `minHostVersion` | Semver. The oldest InfiniBot release that runs the plugin. |
| `engines["infinibot-plugin-api"]` | Semver range of the plugin API, for example `^2.0.0`. |
| `permissions` | An object. Use `{}` when the plugin needs none. |
| `listing` | At least `tagline` and `description`. Every listed image must be in the package. |
| `configSchema` | A JSON Schema object. |
| `update` | Optional. See [updates](updates.md). |

`minHostVersion` and `engines["infinibot-plugin-api"]` are both checked. The first says which product release you tested on; the second says which plugin API you were built for.

## Limits

These limits apply whenever a package is read: by `validate`, by `install`, and by the gateway.

| Limit | Value |
| --- | --- |
| Zip size | 100 MB |
| Unpacked size (all files) | 500 MB |
| One file, unpacked | 100 MB |
| Number of files | 10,000 |
| Compression ratio | 200:1, checked once the package unpacks to more than 1 MB |
| Path length | 255 characters |
| Folder depth | 16 |
| Manifest size | 1 MB |

A package is refused when any entry:

- has an absolute path, a drive letter, a backslash, a `.` or `..` segment, an empty segment or a control character;
- is a symlink or another special file (device, FIFO, socket);
- has the same path as another entry, ignoring case;
- sits "inside" another entry that is a file.

## Versioning

- Versions are compared by semver precedence. `1.10.0` is newer than `1.9.0`, and `2.0.0-beta.1` is older than `2.0.0`. Build metadata (`+…`) is ignored.
- InfiniBot's own versions (`2026.6.30`) are valid semver, so `minHostVersion` uses the same comparison.
- Publish a new version number for every change. The registry and the installer treat a version as immutable: the checksum of a published version must never change.
- Raise the major version when you remove or rename an RPC method, a tool or a setting.
- Asking for a new permission is allowed in any version. Users are asked again, and only about the new permission. See [updates](updates.md).

## Pack

```bash
infinibot plugins pack <dir> [--out <file-or-folder>] [--include-node-modules] [--json]
```

`pack` validates the folder, then writes `<id>-<version>.ibplugin.zip` and a `<file>.sha256` sidecar (`<hex>  <file name>`).

Packing is deterministic. The same folder contents always give the same bytes and the same SHA-256, on any machine:

- entries are sorted by path;
- every entry is stamped 1980-01-01 00:00:00 UTC with mode `0644`;
- entries are stored as UNIX entries and deflated at level 9;
- file timestamps, permissions and directory order on disk do not affect the result.

What is left out:

| Left out | Why |
| --- | --- |
| `.git/`, `.hg/`, `.svn/` | Version control data. |
| `node_modules/` | Unless `--include-node-modules`. |
| `.DS_Store`, `Thumbs.db` | Archiver leftovers. |
| `*.zip` at the plugin root | Earlier pack output. |
| Anything matched by `.ibpluginignore` | Your own exclusions. |

`.ibpluginignore` holds one pattern per line (`#` starts a comment):

```
# a folder
test/
# an extension, anywhere
*.map
# one file
docs/draft.md
```

`pack` refuses to continue when the folder contains:

- a symlink (unless it is ignored);
- a file that looks like a credential (`.env`, `*.pem`, `*.p12`, `*.keystore`, `id_rsa`, `id_ed25519`, `.npmrc`);
- a listing image, an entry file or a `contributes.agents` file that is missing.

## Validate

```bash
infinibot plugins validate <dir-or-zip> [--json]
```

- For a folder: the same checks `pack` runs.
- For a zip: the same checks the installer runs, including the zip safety checks. It also prints the SHA-256.

The command exits with status 1 when there is at least one error. Warnings do not fail it.

## Install a package

```bash
infinibot plugins install ./my-plugin-1.0.0.ibplugin.zip
infinibot plugins install https://example.com/my-plugin-1.0.0.ibplugin.zip --sha256 <hex>
infinibot plugins install my-plugin --marketplace
```

- A `<file>.sha256` sidecar next to a local zip is verified automatically. `--sha256` overrides it.
- The command prints the permission review and asks before it installs. Use `--yes` in scripts.
- The plugin is installed off. Turn it on with `infinibot plugins enable <id>` and restart the gateway.

In the app, open Setup › Plugins and use **Import plugin**, drop a zip on the page, or use **From URL**.

What the installer does, in order:

1. Checks the size, then the SHA-256 when one was supplied.
2. Opens the zip with the safety checks above. Nothing is extracted.
3. Reads the manifest from the zip and validates it.
4. Checks `minHostVersion` and the plugin API range.
5. Applies the cloud tenant policy and the denylist.
6. Applies the id collision rules below.
7. Shows the permission review. Nothing is installed until it is accepted.
8. Extracts into a staging folder, re-validates what landed on disk, then moves it into place with a rename.
9. Writes the install record (`plugins.installs.<id>`): source, version, SHA-256, size, install time, the permissions that were reviewed, and the previous version.

If any step fails, the previous state is restored and the staging folder is removed.

### Id collision rules

| The id belongs to | Result |
| --- | --- |
| Nothing | Installed as a new plugin, off. |
| A package you installed, older version | Update. The current version is kept for rollback. |
| A package you installed, same version, the very same file | Nothing to install: the review says it is already installed and offers **Enable** (the CLI prints `infinibot plugins enable <id>`). |
| A package you installed, same version, different bytes | Refused, unless `--reinstall`. |
| A package you installed, newer version | Refused, unless `--allow-downgrade`. Prefer `infinibot plugins rollback <id>`. |
| A folder in `extensions/` that was not installed as a package | Refused. Uninstall it first. |
| A plugin loaded from a workspace or from `plugins.load.paths` | Refused. Remove that plugin first. |
| A plugin that ships with InfiniBot, same or older version | Not an error. The review says "<name> is already included" and offers **Enable it** (or Buy / Connect KinglyVault when it is a paid plugin you don't own yet). Nothing is written. |
| A plugin that ships with InfiniBot, newer version | Upgrade. It needs your explicit confirmation (`--override-bundled`, or the checkbox in the review), unless it comes from the registry as a first-party entry with a verified checksum. |

Ways to import on the Plugins page: **Import from file** (a `.zip`), **From folder** (a plugin folder, zipped in the browser; `node_modules` and `.git` are skipped), dropping a `.zip` or a folder anywhere on the page, and **From URL / GitHub**. A GitHub link may be the repository (its latest release's `.ibplugin.zip` asset, else the default branch), `/tree/<branch>`, `/releases/tag/<tag>` or a release download link; a link into a sub-folder of a repository is refused because the plugin must be the repository root. Refusals are worded plainly first (damaged file, wrong fingerprint, unsafe paths, not a plugin, needs a newer InfiniBot), followed by the technical detail.

When both an installed package and a bundled copy exist, the newer version loads. If you later upgrade InfiniBot and it ships a newer bundled version than your installed package, the bundled one loads again.

## Where things are stored

| Path (under the InfiniBot config folder) | Content |
| --- | --- |
| `extensions/<id>/` | The installed version. |
| `plugin-packages/versions/<id>/` | The one previous version, for rollback. |
| `plugin-packages/staging/` | Extraction in progress. |
| `plugin-packages/uploads/` | Uploads in progress. |
| `plugin-packages/updates.json` | Result of the last update check. |
| `plugin-data/<id>/` | The plugin's own data. Never touched by install, update or rollback. |
