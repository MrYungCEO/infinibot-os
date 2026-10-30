# Registry API

The marketplace registry is a small read-only HTTP API. The InfiniBot plugin client (`src/plugins/packages/registry-client.ts`) is written against this contract, and the cloud registry (`src/saas/cloud/marketplace/registry-api.ts`) implements it. A contract test runs the real client against the real cloud handlers on a local Postgres (`src/saas/cloud/marketplace/registry-contract.test.ts`), so this page describes the shape as built. A local mock that serves the same contract from in-memory packages lives in `src/plugins/packages/mock-registry.ts`.

See also: [publishing](publishing.md), [updates](updates.md), [packaging](packaging.md), [security model](security-model.md).

## Where the client looks

`{registry}` is an origin with no trailing slash.

| Source | Value |
| --- | --- |
| Environment | `INFINIBOT_PLUGIN_REGISTRY_URL` (wins over config) |
| Config | `plugins.registryUrl` |
| Default | `https://cloud.infinibotos.com` |

The URL must be `https`. Plain `http` is accepted only for `localhost`, `127.0.0.1` and `[::1]` (local registries and tests). On an InfiniBot Cloud tenant Machine the config value and a plugin's own `update.registryUrl` are ignored: only the environment value or the default is used.

## Contract

This section is the contract, verbatim. Fields marked `?` are optional: a registry may leave them out and the client fills in a default.

- GET {registry}/api/marketplace/index.json → {schemaVersion:1, generatedAt, plugins:[Entry]}
- GET {registry}/api/marketplace/plugins/:id → Entry & {versions:[{version, releasedAt, sha256, sizeBytes, minHostVersion, changelog}]}
- GET {registry}/api/marketplace/plugins/:id/download?version=<semver|latest>&token=<entitlement?> → 302 to zip, or the zip; 402 JSON {error:"payment_required", purchaseUrl} when paid and no valid entitlement; 404 JSON {error:"external_distribution", purchaseUrl, homepageUrl} when the publisher delivers it.
- Entry = {id, name, version, publisher:{id,name,verified}, firstParty:boolean, description, category, tags[], pricing:{model:"free"|"paid", priceCents, currency, purchaseUrl|null, includedPlans?:string[]}, downloadUrl|null, sha256, sizeBytes, minHostVersion, homepageUrl|null, listing:{cover, icon, screenshots:[{src, caption?}], tagline?}, affiliate?:{enabled:boolean}, featured?:boolean, distribution?:"hosted"|"external", cloud?:{availability:"available"|"partial"|"coming-soon"|"self-host-only", note?, selfHostOnly?:[{feature, why}]}}

## Field notes

These notes say how the client reads each part of the contract.

### Entry

| Field | Type | How the client uses it |
| --- | --- | --- |
| `id` | string | Plugin id: lowercase letters, digits, dashes, 2–64 characters. An entry with any other id is dropped. |
| `name` | string | Display name. |
| `version` | semver | Latest published version. An entry without a valid semver is dropped. |
| `publisher.id` | string | Compared with the installed plugin's manifest `publisher`. An update from a different publisher is refused. |
| `publisher.name` | string | Shown on the card. |
| `publisher.verified` | boolean | Shows the verified mark. Only the literal `true` counts. |
| `firstParty` | boolean | Only an entry with `firstParty: true` may update or replace a plugin that ships with InfiniBot. Only the literal `true` counts. |
| `description` | string | Shown on the card (plain text). |
| `category` | string | Shown as a chip. |
| `tags[]` | string[] | Up to 12 are kept. |
| `pricing.model` | `"free"` \| `"paid"` | Anything other than `"paid"` is treated as free. |
| `pricing.priceCents` | integer | Price in the currency's minor unit. |
| `pricing.currency` | string | ISO 4217 code, for example `USD`. |
| `pricing.purchaseUrl` | url \| null | Opened in a new browser tab by the Buy button. For a paid first-party plugin it is the plugin's page on the marketplace site (`/marketplace/<id>?buy=1`), where it is bought through Whop. For a third-party plugin it is the publisher's own purchase / download page. Must be `http(s)`; anything else is treated as null. |
| `pricing.includedPlans` | string[] | Optional. Hosted plan ids whose members get a paid first-party plugin without buying it. Missing means none; the client reads it as `[]`. Up to 16 are kept. |
| `downloadUrl` | url \| null | Informational. The client always downloads through the download endpoint below. |
| `sha256` | hex | SHA-256 of the latest version's zip (64 hex characters). An entry without one is dropped. |
| `sizeBytes` | integer | Size of the latest version's zip. |
| `minHostVersion` | semver | Oldest InfiniBot that runs the latest version. |
| `homepageUrl` | url \| null | Shown as a Website link. |
| `listing.cover`, `listing.icon` | url \| null | Absolute, or relative to the registry origin. `http(s)` only. |
| `listing.screenshots[]` | `{src, caption?}` | The cloud registry sends objects. The client also accepts a bare URL string in place of an object (older registries and the mock), and returns `{src, caption?}` either way. `src` follows the same URL rules as the cover; an entry with a bad `src` is dropped. Up to 8 are kept, captions are cut at 200 characters. |
| `listing.tagline` | string | Optional. One-line summary shown on the card. Missing reads as `""`. |
| `affiliate.enabled` | boolean | Optional. Not used by the gateway client. The marketplace site only shows an affiliate storefront link when it is `true`. |
| `featured` | boolean | Optional. Only the literal `true` counts. Featured plugins sort first. |
| `distribution` | `"hosted"` \| `"external"` | Optional (missing = `hosted`, or `external` when `downloadUrl` is null). `external`: the publisher sells and delivers the plugin; the registry hosts nothing for it. Every paid third-party plugin is external. |

| `cloud` | object | Optional. Whether the plugin works on InfiniBot Cloud (a hosted workspace Machine). `availability` is `available`, `partial` (available, but the features in `selfHostOnly[]` need self-hosted InfiniBot), `coming-soon` or `self-host-only`; `note` says why or what it needs. The cloud registry fills it for every entry from one catalogue (`src/saas/cloud-plugin-catalog.json`, the same data a tenant Machine enforces; third-party plugins are `self-host-only` for now). Older registries leave it out; the client keeps it only when `availability` is one of the four values, up to 12 features. |

A plugin the publisher distributes themselves (`distribution: "external"`, no zip hosted by the registry) has `downloadUrl: null`, an empty `sha256` and `sizeBytes: 0`. The gateway client keeps such an entry as a listing only: the Marketplace tab shows its Buy button (the publisher's page, in a new tab) and says the plugin is installed by importing the zip the publisher sends. It is never installed or updated from the registry. A hosted entry without a valid `sha256` is still dropped.

`GET /api/marketplace/plugins/:id` also returns a `permissions` object (the manifest permissions of the latest version, with home directories shortened to `~/`). The site shows it. The gateway client ignores it: the permission review during install reads the manifest inside the downloaded zip, never the registry's copy.

### Versions

`GET /api/marketplace/plugins/:id` returns the entry plus `versions`, newest first or in any order (the client sorts by semver precedence).

| Field | How the client uses it |
| --- | --- |
| `version` | Semver. |
| `releasedAt` | ISO 8601 timestamp, shown next to the changelog. |
| `sha256` | The download for this version is verified against it before anything is installed. A mismatch aborts the install. |
| `sizeBytes` | Shown to the user. |
| `minHostVersion` | The client only offers versions the running InfiniBot satisfies, and picks the newest of those. |
| `changelog` | Plain text or markdown for this version. The update screen shows the entries newer than the installed version. |

When `versions` is empty, the client treats the entry itself as the only version.

### Download

`GET /api/marketplace/plugins/:id/download?version=<semver|latest>&token=<entitlement?>`

- `200` with the zip bytes, or `302` to the zip. The client follows up to 5 redirects by hand, and every hop must be `https` (or `http` on loopback). The cloud registry always answers `302` to a signed, short-lived URL (`/api/marketplace/files/:id/:version.zip?exp=…&sig=…`, valid for 5 minutes) that streams the zip.
- `402` with `{"error":"payment_required","purchaseUrl":"…"}` when the plugin is a paid first-party plugin and there is no valid entitlement. `purchaseUrl` is the plugin's page on the marketplace site. With a token that was sent but not accepted (tampered, expired, refunded, another plugin), the cloud registry adds `"reason":"invalid_token"`.
- `404` with `{"error":"external_distribution","purchaseUrl","homepageUrl"}` when the publisher distributes the plugin themselves (every paid third-party plugin). There is nothing to download: the buyer gets the zip from the publisher and imports it. (Older registries answered `409`; the client treats both the same.)
- `404` with another error when the plugin or version does not exist.
- **Entitlement tokens.** There are no licence keys. A paid first-party plugin is bought on the marketplace site (Whop checkout). The purchase page then hands out signed tokens: a download link (30 minutes) and an *Install in InfiniBot* link (`/app/plugins?install=<id>&source=marketplace&entitlement=…` or `infinibot://web/plugins?install=<id>&entitlement=…`, 24 hours; not `token=`, which is the control UI's own auth parameter). The gateway passes it to this endpoint as `token`. Tokens are bound to the plugin and to the purchase, which is re-checked on every use, so a refund stops them. The purchase page's receipt link gives fresh ones at any time. See [publishing](publishing.md) and `docs/saas/MARKETPLACE.md`.
- The cloud registry also unlocks a paid download for a signed-in member (an `Authorization: Bearer` Clerk session) whose plan is in `pricing.includedPlans` or who bought the plugin with that account or email. The gateway client never sends a session.
- `?license=` is ignored (licence keys were removed).
- `&ref=<code>` is optional and recorded with the download for affiliate attribution. The gateway client does not send it.
- The token is sent only in this request's query string, never to a redirect target, and is never written to the config, the install record or error messages.
- The response is limited to 100 MB.

## Limits and failure handling

| Limit | Value |
| --- | --- |
| `index.json` size | 5 MB |
| Plugin detail size | 2 MB |
| Package size | 100 MB |
| Request timeout | 20 s (5 min for a download) |

- `schemaVersion` other than `1` is rejected with a clear error.
- A response that is not JSON is rejected.
- An unreachable registry never breaks the Plugins page: the Marketplace tab shows the error, and installed plugins keep working.

## Example

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-10-02T12:00:00.000Z",
  "plugins": [
    {
      "id": "hello",
      "name": "Hello",
      "version": "0.2.0",
      "publisher": { "id": "infinibot-examples", "name": "InfiniBot Examples", "verified": true },
      "firstParty": false,
      "description": "The example plugin the docs walk through.",
      "category": "developer",
      "tags": ["example"],
      "pricing": { "model": "free", "priceCents": 0, "currency": "USD", "purchaseUrl": null },
      "featured": true,
      "downloadUrl": "https://cloud.infinibotos.com/api/marketplace/plugins/hello/download?version=latest",
      "sha256": "f33077f983c00028c3cf52271a9bd028994e9afa08770cbfc794da81d27376ce",
      "sizeBytes": 4981,
      "minHostVersion": "2026.6.30",
      "homepageUrl": null,
      "listing": {
        "cover": null,
        "icon": "/marketplace/hello/icon.svg",
        "screenshots": [{ "src": "/marketplace/hello/shot-1.png", "caption": "The hello page" }],
        "tagline": "Say hello from a plugin"
      },
      "affiliate": { "enabled": false },
      "distribution": "hosted"
    }
  ]
}
```

## Run the mock registry

```bash
# Serve one or more plugin folders (packed on the fly) or .zip packages
node --import tsx scripts/plugins-mock-registry.ts --port 4010 examples/plugin-hello

# Point a gateway or the CLI at it
INFINIBOT_PLUGIN_REGISTRY_URL=http://127.0.0.1:4010 infinibot plugins marketplace
```

Options are listed by `node --import tsx scripts/plugins-mock-registry.ts --help`.
