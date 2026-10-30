# Plugin updates

One update system covers every plugin the registry manages: packages you installed, and the first-party plugins that ship with InfiniBot.

See also: [packaging](packaging.md), [registry API](registry-api.md), [security model](security-model.md), [publishing](publishing.md).

## Which plugins are managed

| Plugin | Updated by the registry |
| --- | --- |
| Installed as a package (zip, URL or marketplace) | Yes |
| Ships with InfiniBot (bundled) | Yes, from first-party registry entries only |
| Installed with npm, or linked from a path | No. `infinibot plugins update <id>` still updates npm installs through npm. |
| Loaded from a workspace or `plugins.load.paths` | No |

## How an update is found

1. The gateway reads the registry index (`GET /api/marketplace/index.json`).
2. For each managed plugin it compares the registry version with the installed version by semver precedence.
3. When the registry is newer, it reads the plugin's version list and picks the newest version whose `minHostVersion` this InfiniBot satisfies.
4. The result is cached in `plugin-packages/updates.json`. The Plugins page reads the cache, so it never waits on the network.

An update is refused, with the reason shown in the Versions section, when:

- the registry entry has a different `publisher.id` than the installed plugin;
- the plugin ships with InfiniBot and the registry entry is not marked first-party;
- every newer version needs a newer InfiniBot. The message names the version you need.

### Which registry

In order: the plugin's own `update.registryUrl` (manifest), the registry the package was installed from, `INFINIBOT_PLUGIN_REGISTRY_URL`, `plugins.registryUrl`, then the default. On InfiniBot Cloud only the platform registry is used.

## When checks happen

| Trigger | Behaviour |
| --- | --- |
| Background | About 90 seconds after the gateway starts, then every `plugins.updates.intervalHours` (default 12, minimum 1). |
| Opening Setup › Plugins | Uses the cached result if it is under 10 minutes old; otherwise checks. |
| **Check for updates** button, or `infinibot plugins updates` | Checks now. |

Turn the background check off with `plugins.updates.check: false`, or the environment variable `INFINIBOT_SKIP_PLUGIN_UPDATE_CHECK=1`. It is always off on InfiniBot Cloud tenant Machines, where plugin updates arrive with the platform image.

## What the user sees

- A green **Update x.y.z** chip on the plugin's card, and a count on the **Installed** tab.
- In the plugin's **Versions** section: the installed version, its source and checksum, the new version, and the changelog entries newer than the installed version.
- **Update to x.y.z**, **Roll back to x.y.z** and **Check now** buttons, and the **Update automatically** switch.

## What an update does

1. Downloads the version from the registry.
2. Verifies the SHA-256 the registry published for that version. A mismatch stops the update.
3. Runs every check a zip import runs (see [packaging](packaging.md)).
4. Compares the permissions the new version asks for with the ones you already reviewed.
5. Swaps the new version in, and keeps the current one for rollback.

What is kept:

| Kept | Where it lives |
| --- | --- |
| The plugin's data | `plugin-data/<id>/` |
| Whether it is on or off | `plugins.entries.<id>.enabled` |
| Its settings | `plugins.entries.<id>.config` |
| Permissions you granted or revoked | `plugins.entries.<id>.permissions` |
| Contribution switches and appearance | `plugins.entries.<id>` |

If the plugin is running, the gateway restarts to load the new version, and the app asks first. If the plugin is off, nothing restarts.

### New permissions

You are asked again only when the new version requests a permission you have not reviewed. The review lists just the new ones.

- Until you accept, nothing is installed and the current version keeps running.
- A new gated permission still starts off after you accept the update. You grant it separately.
- From the command line, `infinibot plugins update <id>` prints the review and asks. `--yes` accepts.

## Rollback

One previous version is kept per plugin.

```bash
infinibot plugins rollback <id>
```

- Rollback puts the previous version back and keeps the version you are leaving, so you can roll forward again.
- Data, settings and permissions are untouched.
- If the previous version was the copy that ships with InfiniBot, rollback removes your installed package and the bundled copy loads again.
- Rollback does not migrate data backwards. If a plugin changed its data format, check its changelog before rolling back.

## Automatic updates

Off by default, per plugin.

```bash
infinibot plugins auto-update <id> on
```

Or use the **Update automatically** switch in the plugin's Versions section. The setting is `plugins.entries.<id>.autoUpdate`.

With it on, the background check installs a new version when all of these hold:

- the checksum verifies;
- the version asks for no new permissions;
- the plugin is free, or (paid first-party) the registry still lets this gateway download it. Nothing is stored for paid plugins, so a paid plugin's update usually needs a fresh **Install in InfiniBot** link from its purchase page (or a zip import).

A version that asks for new permissions is never installed automatically. It waits for you, and the plugin's log says why.

The background check never restarts the gateway. If the plugin is running, the new version is on disk and takes effect at the next restart; the Versions section says so.

## Bundled plugins and packages

A first-party plugin ships inside InfiniBot. A newer package of the same plugin can be installed over it:

- from the registry, when the entry is marked first-party and the checksum verifies;
- from a zip, only with your explicit confirmation.

The newer of the two versions loads. After you upgrade InfiniBot, a newer bundled version takes over from an older installed package automatically.

## The `update` block

Optional, in `infinibot.plugin.json`:

```json
"update": {
  "registryUrl": "https://plugins.example.com",
  "changelog": "CHANGELOG.md"
}
```

| Field | Meaning |
| --- | --- |
| `registryUrl` | A registry that implements the [registry API](registry-api.md), used for this plugin's updates. Must be https. |
| `changelog` | The changelog file inside the package, shown in the install review. Default `CHANGELOG.md`. |

## Gateway methods and commands

| Gateway method | Command | Purpose |
| --- | --- | --- |
| `plugins.updates.check` `{ force? }` | `infinibot plugins updates` | Check the registry. |
| `plugins.updates.status` | | Read the cached result. |
| `plugins.update` `{ id, version?, token? }` | `infinibot plugins update <id>` | Update, or return a review when there are new permissions. |
| `plugins.rollback` `{ id }` | `infinibot plugins rollback <id>` | Return to the previous version. |
| `plugins.updates.setAuto` `{ id, auto }` | `infinibot plugins auto-update <id> on\|off` | Automatic updates for one plugin. |

All of these need the admin scope.
