# Paid plugin gating and the owner grant

## Rule

- There are **no desktop-only plugins**. Every plugin, Droid Swarm included, runs
  wherever InfiniBot runs. The old `INFINIBOT_DESKTOP` switch, `desktopOnly` field,
  "Desktop" badge and "Get InfiniBot Desktop" upsell are gone.
- The **7 paid first-party plugins** (`src/saas/cloud/marketplace/first-party-pricing.json`
  → `paid`: infinitrade, solatrix, omniclinic, droid-swarm, infinicode,
  products, flypic) load only with an entitlement. The gateway enforces this in two places:
  - at boot, `resolveEnableState` (`src/plugins/config-state.ts`) refuses to load them.
    The config `enabled: true` setting doesn't override this.
  - `plugins.setEnabled` refuses to turn them on.
- The same code runs in the packaged **InfiniBot Desktop** app, which spawns
  `dist/entry.js` through Electron-as-Node. It also runs in npm and source installs.
  No env var or build flag lifts the gate.
- **Hosted cloud tenants** (`SAAS_MODE` + `FLEET_TENANT_ID`) are gated by their cloud
  plan instead (`src/saas/fleet-plugins.ts`).
  - Inside the Electron runtime (`process.versions.electron`) that stand-aside is
    ignored, so setting those env vars on Desktop unlocks nothing.

## What counts as an entitlement

`entitlementFor` (`src/plugins/entitlements/store.ts`) checks these in order:

1. **Owner grant** for this machine (below).
2. **KinglyVault token**: a purchase, or a plan `*` such as CEO.
   - Stored in `<state>/plugin-entitlements.json`.
   - Linked with **Connect KinglyVault** (below), or a pasted key under "Have a license key?".
   - Verified against the embedded KinglyVault public key `360c5ff5…`.
   - Has 7 days of offline grace.

A `*` entitlement never covers a third-party plugin.

## Connect KinglyVault (device code)

One button on Plugins (Installed strip, Purchases tab, a locked plugin's page), onboarding step 7 "Your plan" and Setup › Your setup › Plan · plugins. Component: `ui/src/ui/components/kv-connect.ts`; gateway: `src/plugins/entitlements/kv-connect.ts`.

1. `plugins.kv.connect.start` → KinglyVault `device-start` returns a code like `BCDF-GHJK` and `/infinibot/connect?code=…`.
2. The UI opens that page with `window.open`, so it lands in the normal browser (Desktop: `electron/external-links.js` hands it to `shell.openExternal`; never an in-app window). It shows the same code.
3. The member signs in on KinglyVault and presses Approve. The gateway polls `device-poll` on its own (`plugins.kv.connect.status` only reports), then imports the signed token + device refresh token through `importEntitlementToken` (signature checked against the embedded key). The UI shows "Connected as <email> · Disconnect".
4. Sync: every 12 h, when the Plugins page opens and the last sync is over 15 min old, on **Sync now**, and every 15 s for 10 min after **Buy** (so a purchase unlocks on its own).
5. **Disconnect** calls KinglyVault `device-unlink` with the refresh token, then deletes the local file.

Availability is probed at runtime (`capabilities`, cached 10 min / 1 min when unavailable). Until KinglyVault serves it, `plugins.kv.status` reports `available: false` and the button is disabled with "Connecting a KinglyVault account isn't switched on yet." The key paste stays as the fallback.

Card price tags (exactly one): **Free**, **Included** (plan, admin, owner licence, or a hosted plan), **Owned** (a purchase), or **Buy $N**. Buy is only shown when the plugin isn't owned.

Tests: `src/plugins/entitlements/kv-connect.test.ts`, `ui/src/ui/components/kv-connect-model.test.ts`, `ui/src/ui/views/plugins/purchases.test.ts`. KinglyVault side: branch `feat/infinibot-device-connect`.

## Owner grant

This entitlement lets the owner's own install keep its paid plugins without a
KinglyVault device link.

- **File:** `<state dir>/plugin-owner-grant.json` (mode 0600), containing
  `{ "version": 1, "token": "<JWT>" }`.
- **Token:** RS256, signed with the KinglyVault licence private key. That is the same key
  that signs purchase tokens and licences. Its claims are:
  `iss: "kinglyvault"`, `aud: "infinibot-plugins-owner"`, `role: "owner"`,
  `machine: sha256("infinibot-owner:" + machine id)`, `exp`,
  `ent: [{ p: "*", src: "admin:owner" }]`.
- **Machine id:**
  - Linux: `/etc/machine-id`, falling back to `/var/lib/dbus/machine-id`.
  - macOS: `IOPlatformUUID`.
  - Windows: the `MachineGuid` registry value.
- **UI:**
  - Plugin badges read "Owner".
  - The detail call-out reads "Owner licence".
  - Purchases shows "Owner licence active on this machine".

A customer can't use or forge it:

- Signing needs the private key. It lives only in KinglyVault's server env and the
  owner's KinglyVault `.env`, and never ships.
- The public key is a compiled-in constant. No env var, config key or file can swap it.
- The audience differs from purchase tokens, so:
  - it can't be imported through `plugins.entitlements.import`;
  - a purchase token placed in the grant file is rejected.
- It is bound to one machine id, so a copied file does nothing on another machine.
- `exp` is a hard end, with no grace period and no refresh. Mint a new grant to extend it.

### Mint, renew or revoke

```bash
# On the owner's machine, from an InfiniBot checkout (Node 22):
node --import tsx scripts/mint-owner-plugin-grant.mts \
  --kv-env ~/Desktop/KinglyVault-main/.env \
  --state-dir ~/.infinibot --years 5
```

- The script checks that the key's fingerprint matches before it signs.
- It writes the grant file with mode 0600.
- `--machine-id <id>` mints for another machine the owner controls.
- The gateway reads the grant at boot, so restart it afterwards.
- To revoke, delete the file and restart.

## Tests and checks

- `src/plugins/entitlements/entitlements.test.ts` covers:
  - all 8 paid plugins locked without an entitlement;
  - no env var unlocking anything;
  - the owner grant: valid, wrong machine, forged, wrong audience, expired;
  - Electron ignoring fleet env vars.
- `src/gateway/server-methods/plugins-catalog.test.ts` checks that Droid Swarm is paid and
  carries no desktop badge.
- `scripts/verify-plugin-owner-grant-side-gateway.mts` runs end to end on a side gateway:
  - unentitled: all 8 are refused;
  - owner grant: all 8 are allowed;
  - a copy of the live config with the live grant: the owner's enabled plugins still load.
