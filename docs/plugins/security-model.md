# Plugin security model

What InfiniBot guarantees when a plugin is installed and run, and what it does not.

See also: [packaging](packaging.md), [updates](updates.md), [API reference](api-reference.md), [publishing](publishing.md).

## The short version

- A plugin is code that runs **inside the gateway process**, with the gateway's access to the machine. There is no sandbox today. Install plugins only from publishers you trust.
- Installing a package is safe: a package cannot write outside its own folder, cannot run code during install, and is never turned on by installing it.
- Running a plugin is a trust decision. Permissions tell you what the plugin says it does and let you switch parts of it off. They are not an operating-system barrier.

## Trust tiers

| Tier | Meaning |
| --- | --- |
| First-party | Ships with InfiniBot. |
| Verified | Published by InfiniBot outside the bundle. |
| Community | Everyone else. |

The marketplace also marks **verified publishers**. That mark means the registry confirmed who the publisher is. It is not a review of the code.

## Installing a package

Every package goes through the same checks, whether it comes from an upload, a URL, the marketplace or the command line.

### The zip is read defensively

Nothing is written to disk until the whole archive has passed:

| Attack | Defence |
| --- | --- |
| Path traversal ("zip slip") | Entry names are checked as stored in the archive, before any normalisation. Absolute paths, drive letters, backslashes, `.` and `..` segments, empty segments and control characters are refused. The resolved path is checked again at write time. |
| Symlinks and special files | Refused. Symlinks, devices, FIFOs and sockets are never created. |
| Zip bombs | Caps on zip size, total unpacked size, per-file size, file count and compression ratio. Each file is streamed with a byte counter, so an entry that inflates past the size it declared is cut off. ZIP64 is refused. |
| Overwriting files | Extraction goes to a new empty staging folder. Files are opened in exclusive-create mode, with mode `0644`. |
| Case tricks | Two entries that differ only by case, or a file nested under another file, are refused. |

### The manifest is validated before extraction

The manifest is read from the zip in memory. The package is refused when the manifest is invalid, the id is reserved, the version is not semver, the entry file is missing, or `minHostVersion` / the plugin API range does not match this InfiniBot.

After extraction, what landed on disk is checked against what was reviewed. If the id or version differ, the install stops.

### The checksum is verified when one is given

- Marketplace installs and updates always verify the SHA-256 the registry published for that exact version.
- URL installs verify the SHA-256 you supply.
- Local installs verify a `<file>.sha256` sidecar when one sits next to the zip, or `--sha256`.

A checksum protects against a corrupted or swapped download. It does not tell you who wrote the plugin. Packages are not signed yet.

### Nothing runs at install time

No `npm install`, no install script, no build step. The plugin's code first runs when you turn it on.

### You review before it installs

The review shows, before anything is installed:

- name, version, publisher, size, file count and SHA-256;
- every permission the plugin requests, in plain language;
- which permissions are gated (off until you grant them);
- warnings, such as replacing a built-in plugin.

The install is refused unless every listed permission is accepted.

### It is installed off

- A new package is never turned on by installing it. You turn it on in Setup › Plugins.
- A leftover "on" switch or old permission grants from an earlier install with the same id are cleared.
- Gated permissions are never granted by installing or updating. You grant each one yourself.

### Failures roll back

The new version is moved into place with a rename. If anything fails, the previous version is put back and the staging folder is removed. If saving the config fails afterwards, the disk change is undone.

## Id collisions and impersonation

A zip can claim any id, so the id alone proves nothing.

| Situation | Rule |
| --- | --- |
| The id is a reserved core name | Refused. |
| The id belongs to a plugin that ships with InfiniBot | Same or older version: nothing is installed; the review offers to turn on the copy that ships with InfiniBot. Newer version: accepted only with your explicit confirmation, or when the registry lists it as first-party and the checksum verifies. |
| The id belongs to a plugin from a workspace or a config path | Refused. |
| An update comes from a different publisher than the installed plugin | Refused. |
| The folder exists but was not installed as a package | Refused. |

## Downloads

- Only `https` URLs are fetched. `http` is allowed for loopback addresses only.
- URLs with embedded credentials are refused.
- Redirects are followed by hand, at most five, and each hop is checked.
- An entitlement token from a marketplace purchase page (paid first-party plugins) is sent to the registry only, is held in memory for that one install, and is never written to the config file, install record or error messages. There are no licence keys.
- Registry responses are size-limited and shape-checked. Entries that do not match the contract are dropped. Links from the registry are opened only when they are `http(s)`.

## Permissions

Declared in the manifest under `permissions`. See the [manifest reference](manifest-reference.md).

| Permission | Key | What it means |
| --- | --- | --- |
| Network | `network:<host>` | Connects to that host. |
| Files | `fs:<path>` | Reads or writes that path, outside its data folder. |
| Commands | `exec` | Runs programs or commands. |
| Secrets | `secrets:<NAME>` | Reads that secret. |
| Channels | `channels:<id>` | Sends through that channel. |
| Credits | `credits` | Spends credits. |
| Gated | `gated:<id>` | A high-risk capability that is off until you grant it. |

### What the host enforces

- **Declarations.** A v2 plugin can only register the RPC methods, HTTP routes, tools and panel kinds its manifest declares, under its own namespace (`<id>.*`, `/plugins/<id>/`). Anything else is rejected at load.
- **Switches.** Each contribution can name the permissions it `requires`. Revoking a permission switches off every contribution that requires it, immediately. A gated permission counts as revoked until you grant it.
- **RPC scopes.** Each declared RPC method has a scope (`read`, `write` or `admin`). The default is `admin`.
- **HTTP authentication.** Plugin routes sit behind the gateway's authentication. The exceptions are routes listed in `selfAuthHttp` (the plugin must authenticate them itself) and static UI modules registered as `publicAsset`.
- **Listing images.** Only the image files the listing declares are served, from inside the plugin folder.

### What the host does not enforce

- Network, file, command and secret permissions are **not** enforced by a sandbox. A plugin that does not declare `network:example.com` is not technically prevented from connecting to it. The permission list is the publisher's declaration, and the basis for the switches above.
- A plugin runs with the same operating-system user as the gateway.

Treat a third-party plugin like any other program you install on that machine.

## Updates

- An update goes through every install check again.
- You are asked again only when the new version requests a permission you have not reviewed, and only about those.
- Your data, settings, on/off switch and granted permissions are kept. One previous version is kept for rollback.
- Automatic updates are off by default and never install a version that asks for new permissions.

Details: [updates](updates.md).

## InfiniBot Cloud

On a hosted tenant Machine the platform decides what may run, whatever the tenant's config says:

- Only plugins in the cloud catalogue, and allowed by the tenant's plan, can be installed or turned on.
- Third-party plugins are refused.
- Packages are installed from the platform registry only. Uploads and URL installs are refused, and the tenant cannot point the gateway at another registry.
- Some gated permissions are never granted in the cloud.
- The background update check is off; plugin updates arrive with the platform image.

## Who can install

The plugin methods (`plugins.install.*`, `plugins.update`, `plugins.rollback`, `plugins.marketplace.*`) need the gateway's admin scope.

## Reporting a problem

Report a security issue in a plugin to its publisher, and to InfiniBot as described in `SECURITY.md`. A plugin that breaks the [review guidelines](publishing.md#review-guidelines) can be removed from the marketplace.
