# Publishing to the marketplace

How to get a plugin package listed in the InfiniBot marketplace, what reviewers check, and how updates and paid plugins work.

See also: [packaging](packaging.md), [registry API](registry-api.md), [updates](updates.md), [security model](security-model.md).

> The marketplace submission service is being built alongside this client. This page describes the package you submit and the rules it is reviewed against. The submission steps (account, upload form) are described on the marketplace site when it opens; nothing here depends on them.

## Before you submit

1. `infinibot plugins validate .` reports no errors, and you have read the warnings.
2. `infinibot plugins pack .` builds the package. Keep the printed SHA-256.
3. You installed the zip on a clean InfiniBot, turned it on, and used every feature.
4. You installed the previous version, then updated to this one, and checked that settings and data survived.

## What you submit

| Item | Notes |
| --- | --- |
| The package zip | Built by `infinibot plugins pack`. One file per version. |
| Its SHA-256 | From the `.sha256` file. The registry publishes it; clients verify it on every download. |
| Release notes | A short changelog for this version, shown to users on update. |
| Pricing | Free, or a price and a purchase URL. |

The registry reads everything else from the manifest inside the zip: id, name, version, publisher, `minHostVersion`, description, category, tags and listing images.

### Listing checklist

| Field | Guidance |
| --- | --- |
| `name` | The product name. No version numbers, no "for InfiniBot". |
| `listing.tagline` | One sentence that says what it does. 140 characters. |
| `listing.description` | What it adds, who it is for, what it needs (accounts, API keys), what it costs to run. Markdown. |
| `listing.category` | `apps`, `channels`, `integrations` or `developer`. |
| `listing.icon` | Square. SVG or PNG. |
| `listing.cover` | 16:9. |
| `listing.screenshots` | Real screenshots of the plugin, up to 8, with captions. |
| `listing.links` | Documentation, support and source links. |
| `README.md` | Setup steps and troubleshooting. |
| `CHANGELOG.md` | One section per version. |
| `LICENSE` | The licence you ship under. |

## Versions

- Every release needs a new semver version. A published version is immutable: never replace the zip of a version that is already out.
- Set `minHostVersion` to the oldest InfiniBot you tested. Clients on older hosts are offered the newest version they can run, so keep older versions available.
- Asking for a new permission makes the update wait for the user's review, and automatic updates skip it. Add permissions only when you need them.

## Publisher identity

- `publisher` in the manifest is your publisher id. It must match your registry account.
- Clients refuse an update whose registry entry names a different publisher than the installed plugin. If you transfer a plugin, the id changes hands in the registry, and users reinstall.
- The **verified** mark means the registry confirmed your identity.
- Only InfiniBot publishes first-party entries. A third-party package cannot replace a plugin that ships with InfiniBot.

## Paid plugins

A paid third-party plugin is **a link**. The marketplace never takes the payment and never serves the zip, and there are no licence keys.

- In the publisher portal, pick **Paid**, set the price and give an https **purchase / download page** (Whop, Gumroad, a Stripe link). It is required, must be https, may not point at a private host or carry credentials, and must pass the same domain allow / deny lists as affiliate links (`AFFILIATE_URL_ALLOWLIST`, `AFFILIATE_URL_DENYLIST`, or the owner's affiliate settings).
- A paid listing is **external** (`distribution: "external"`): the registry entry has your `purchaseUrl`, `downloadUrl: null` and no `sha256`, and the download endpoint answers `404 external_distribution`.
- In the app and on the marketplace site, **Buy** opens your page in a new tab, with a note that you deliver the plugin. The buyer installs the zip you send with **Plugins → Import plugin**, which runs the same validation and permission review as a registry install.
- Upload the zip with the submission anyway: reviewers read the code before the listing goes live.
- If your plugin checks a purchase at run time, do that in your own code, and declare the host you contact under `permissions.network`.

InfiniBot's own full apps are sold differently: bought on the marketplace site through Whop and downloaded from it (see `docs/saas/MARKETPLACE.md`).

## Review guidelines

A submission is checked against these rules. A plugin that breaks them later can be removed.

### Must

1. **Do what the listing says.** No hidden features.
2. **Declare everything.** Every host you contact, every secret you read, command execution, credit spending and every high-risk capability is in `permissions`. High-risk actions (moving money, sending messages on the user's behalf, deleting data, running commands) are **gated** permissions.
3. **Tie contributions to permissions.** A tool, route or method that needs a permission lists it in `requires`, so revoking the permission turns it off.
4. **Stay in your namespace.** RPC methods under `<id>.*`, routes under `/plugins/<id>/`, CSS variables under `--plugin-<id>-*`, data in the plugin data folder.
5. **Authenticate what you expose.** A route in `selfAuthHttp` verifies every request (a signature or a scoped token). A `publicAsset` route serves static code only.
6. **Keep secrets secret.** Settings that hold credentials are marked sensitive. Nothing sensitive in logs, in the package, or sent to hosts the user did not agree to.
7. **Ship prebuilt.** No download-and-run at start-up, no fetching code from the network, no self-update outside the registry.
8. **Be honest in the UI.** Real data only. Show loading, empty and error states; do not invent placeholder results.
9. **Work without a restart loop.** Registration is synchronous and does not throw. A missing setting shows a setup state; it does not crash the plugin.
10. **Respect the user's data.** Say what you store and where. Keep data when the user updates. Support export when the data matters.

### Must not

- Obfuscated or minified-only gateway code without the source available to reviewers.
- Native binaries, unless the listing says which platforms are supported and why they are needed.
- Reading other plugins' data folders, the config file's secrets, or the user's files outside what `permissions.fs` declares.
- Telemetry without clear notice and an off switch.
- Impersonating InfiniBot or another publisher: names, icons, ids.
- Cryptocurrency mining, credential harvesting, or anything illegal in the user's jurisdiction.

### Quality bar

- The UI works at phone width and at desktop width, in the light and dark themes, with keyboard only.
- It follows the [UI guide](ui-guide.md), including the listed pitfalls.
- Error messages say what went wrong and what the user can do.
- The package has a README, a changelog and a licence.

## After publishing

- Users see your plugin in **Setup › Plugins › Marketplace**.
- Installed users see an **Update** chip when you publish a newer version their InfiniBot can run. See [updates](updates.md).
- To withdraw a version, publish a fixed one. Do not edit a published zip.

## Hosting your own registry

Any server that implements the [registry API](registry-api.md) works.

- For one plugin: set `update.registryUrl` in its manifest. Its updates then come from your registry.
- For a whole installation: set `plugins.registryUrl`, or `INFINIBOT_PLUGIN_REGISTRY_URL`. The Marketplace tab then lists your registry.

`scripts/plugins-mock-registry.ts` serves plugin folders or zips over the same API, for testing.
