# Clock sections (`contributes.clockSections`)

A manifest-v2 plugin can add a section to the **expanded topbar clock** (click
the clock in the centre of the control bar). Infinitrade uses it for
**Trading sessions**.

## What the user sees

- The clock panel's **Clock** tab lists one switch per contributed section,
  labelled with the section's `label` and the plugin's name.
- Switched on, the section's body renders under the switches and updates with
  the clock (1 Hz).
- The switch is remembered **per user** in the browser
  (`localStorage["infinibot.clock.sections.v1"]`, keyed by the signed-in user
  id, `default` before login). Until the user chooses, `defaultEnabled`
  applies.
- If the plugin is disabled, errors, or the owner switches the contribution
  off in Setup › Plugins (`clockSection:<id>`), the switch and the section
  disappear on the next `plugins.list` sync. Nothing else in the clock
  changes.

## Manifest

```json
"contributes": {
  "clockSections": [
    {
      "id": "trading-sessions",
      "label": "Trading sessions",
      "description": "Sydney, Tokyo, London and New York sessions in your local time.",
      "builtin": "infinitrade-sessions",
      "defaultEnabled": true
    }
  ]
}
```

| Field | Required | Notes |
| --- | --- | --- |
| `id` | yes | Plugin-local, `^[a-z0-9][a-z0-9-]{0,39}$`. Catalog key `clockSection:<id>`. |
| `label` | yes | Switch label. |
| `builtin` | yes | Key of a first-party renderer compiled into the control UI. |
| `description` | no | Tooltip on the switch. |
| `defaultEnabled` | no | Boolean, default `true`. |

Parsing is strict (`src/plugins/manifest-v2.ts` → `parseClockSections`): a
malformed entry fails the manifest, like every other v2 contribution. The
contribution catalog (`src/plugins/contributions.ts`) lists each section as
kind `clockSection`, toggleable and live.

## Host side

| Piece | File |
| --- | --- |
| Manifest parse + type | `src/plugins/manifest-v2.ts` (`PluginClockSectionContribution`) |
| Catalog kind | `src/plugins/contributions.ts` (`clockSection`) |
| UI derivation | `ui/src/ui/plugin-host.ts` — `derivePluginClockSections`, `pluginClockSections()` |
| Renderer registry, per-user switches | `ui/src/ui/components/clock-sections.ts` — `FIRST_PARTY_CLOCK_SECTIONS` |
| Mount point | `ui/src/ui/components/terminal-clock.ts` (`ClockProps.renderSections`), wired in `app-render.ts` |

Only **loaded** plugins contribute. A section whose `builtin` has no renderer
in this UI build is skipped (an older UI simply ignores a newer plugin's
section).

## Writing a first-party section

1. Put the body in the plugin, e.g. `extensions/<id>/ui/clock-<name>.ts`,
   exporting:

   ```ts
   export function renderClockSection(ctx: {
     now: Date;
     client: { request<T>(method: string, params?: unknown): Promise<T> } | null;
     requestUpdate(): void;
   }): TemplateResult;
   ```

   Keep pure logic in a separate module and unit test it. Use theme tokens
   (`--text`, `--muted`, `--border`, `--g-primary`, `--ok`, …) and give the
   light theme (`:root[data-theme="light"]`) its own values where contrast
   needs it. Honour `prefers-reduced-motion`.
2. Register the lazy import in `FIRST_PARTY_CLOCK_SECTIONS`
   (`ui/src/ui/components/clock-sections.ts`).
3. Declare it in the manifest's `contributes.clockSections`.

Only use **read** RPCs from a clock section; it renders whenever the clock is
open.

Marketplace (entry-module) sections are not supported yet; `builtin` is
required.

## Infinitrade: Trading sessions

- Math: `extensions/infinitrade/src/sessions.ts` (pure, tested in
  `extensions/infinitrade/test/sessions.test.ts`). Sessions are defined in
  local exchange time in their IANA zones — Sydney 07:00–16:00
  (`Australia/Sydney`), Tokyo 09:00–18:00 (`Asia/Tokyo`), London 08:00–17:00
  (`Europe/London`), New York 08:00–17:00 (`America/New_York`) — Monday to
  Friday in each zone, so DST is exact. Ported from the OmniTrade fork's
  topbar session clock.
- Body: `extensions/infinitrade/ui/clock-sessions.ts` — session list in the
  viewer's local time with live open state and countdowns, the current or next
  overlap (London–New York is 5 h between the US and UK DST switches, 4 h
  otherwise), a 24-hour timeline of the viewer's day with a now-marker, and
  weekend + public-holiday awareness. Holidays come from the plugin's read-only
  `infinitrade.calendar` RPC (Nager.Date: US, GB, JP, DE), refreshed at most
  every 6 hours; Sydney has no holiday feed.
