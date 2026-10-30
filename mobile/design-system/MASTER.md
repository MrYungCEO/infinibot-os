# InfiniBot Mobile — Design System MASTER

**Status:** canonical. Every mobile revamp / KIS-parity agent reads this file
before writing a screen.
**Branch of origin:** `feat/mobile-revamp-foundation` (off `feat/kis-phase1-complete`)
**Kit location:** `mobile/src/ui-kit/` — single barrel at `mobile/src/ui-kit/index.js`

---

## 0. The five rules

If you remember nothing else:

1. **Never write a hex literal.** Colors come from `useUIKit().colors`, which is
   driven by the live theme runtime. The user can re-palette the whole app from
   the web shell; a hardcoded hex silently opts your screen out.
2. **Never write a raw pixel gap.** Use `SPACE` (4/8/12/16/24/32) and `RADIUS`.
3. **Gold is edges, not area.** Borders, hairlines, dots, labels, 7–14% washes.
   The only two sanctioned gold fills in the entire app are `Button
   variant="primary"` and the fill of a determinate `ProgressBar`.
4. **44×44 and a label.** Every interactive element resolves to ≥44×44 of tap
   area, ≥8px from its neighbour, and carries an `accessibilityLabel`.
5. **No text below 12px. Ever.** And data is monospaced; prose is not.

---

## 1. Style & density

**Style:** Data-Dense Dashboard. **Density: 8.** Dark-only, gold-on-obsidian
luxury.

The app is an operations console, not a marketing site. A screen should fit
more real rows than feels comfortable at first glance, and earn its air through
hierarchy (type weight, tone, hairlines) rather than padding.

### Spacing scale — `SPACE`

| token | px | use |
|---|---|---|
| `xs` | 4 | icon↔label, chip internals, tight meta rows |
| `sm` | 8 | between sibling chips/buttons; the minimum gap between tap targets |
| `md` | 12 | row padding, card interior on dense surfaces, header gutters |
| `lg` | 16 | screen horizontal gutter, card interior on roomy surfaces |
| `xl` | 24 | between sections (`SectionTitle` applies this itself) |
| `xxl` | 32 | above/below a full-screen empty state |

Need something in between? Compose two steps. Do not add a seventh value.

### Radii — `RADIUS`
`sm 8` (inner rows, segments) · `md 12` (buttons, inputs, icon buttons) ·
`lg 16` (cards — the default) · `xl 20` (bottom sheets) · `pill 999` (chips).

### Elevation — `ELEVATION`
`0` flush (a row inside a card) · `1` card · `2` panel · `3` modal / sheet.
Three tiers only. If you reach for a fourth, the layout is wrong.

---

## 2. Color

Colors are **not** defined in the kit. They resolve from
`mobile/src/theme/palettes.js` → `resolveColors()`, fed by the master device's
branding broadcast. `useUIKit()` hands you the live map.

### The tokens you will actually use

| token | use |
|---|---|
| `colors.background` | app background (usually left transparent — `AnimatedBackground` sits behind) |
| `colors.text` | primary text |
| `colors.textSecondary` | supporting text, subtitles |
| `colors.textMuted` | captions, helper text, counts, timestamps |
| `colors.textTertiary` | **icons and glyphs only** — see the note below |
| `colors.primary` | brand accent (gold). Borders, labels, focus rings |
| `colors.success` / `warning` / `error` / `info` | semantic tones |
| `colors.border` / `borderSubtle` | outer surface hairline / interior separator |
| `colors.surface` / `surfaceDeep` / `inputBg` | fills |

### Contrast — the mandate is enforced, not assumed

Every text token clears **4.5:1**. This is verified by a script, across every
dark palette the master can broadcast:

```bash
node mobile/design-system/verify-contrast.mjs
```

440 checks, 5 dark palettes × 2 modes. **Run it after touching `palettes.js`,
`Chip.js` or `contrast.js`.** It exits non-zero on failure, so it can gate CI.

Three findings from building it, encoded in the kit so you inherit the fix:

- **`colors.textTertiary` measures 3.48–3.60:1** — under the 4.5:1 text floor,
  over the 3:1 non-text floor. The kit uses it for the `ListRow` disclosure
  chevron and nothing else. **Do not put text in `textTertiary`.** Use
  `textMuted` (5.8:1).
- **Chips use a NEUTRAL fill, not a tone-tinted one.** A tone-tinted fill lifts
  the backdrop by an amount that scales with the tone's own lightness, so the
  label loses contrast exactly where it needs it (`error` and `info` measured
  ~3.9:1 inside their own chip, and no lighter label recovers it). The fill is
  `colors.text` @ 7/10/14%; the tone owns the border, the dot and the text.
  This is also strictly truer to rule 3.
- **The primary Button resolves its label against every gradient stop** via
  `bestLabelOn`, and deepens the fill via `ensureFillOn` when no label can
  clear (Aurora's mid-purple tops out at 4.23:1 against pure white). On the
  gold palette both are no-ops.

If you build a component that paints a tone-colored label on a tone-colored
fill, use `ensureContrast(tone, backdrop, 4.5)` from `ui-kit/contrast.js`.
Do not hand-pick a lighter hex — it fixes one palette and breaks the other five.

---

## 3. Typography

Fonts stay as the app has them (`mobile/src/hooks/useFonts.js`): **Inter** for
UI, **Space Grotesk** for display. The kit adds the scale and the mono face.

`makeType(fonts)` (via `useUIKit().type`):

| token | size/line | face | use |
|---|---|---|---|
| `display` | 26/30, −0.6 | Space Grotesk Bold | hero numerals, splash |
| `h1` | 22/27, −0.4 | Inter Bold | screen title (`AppHeader` premium) |
| `h2` | 18/23, −0.3 | Inter Bold | sheet title, nav title |
| `h3` | 15/20, −0.1 | Inter SemiBold | card title, empty-state title |
| `body` | 15/21 | Inter Regular | prose |
| `bodyStrong` | 15/21 | Inter SemiBold | `ListRow` title |
| `small` / `smallStrong` | 13/18 | Inter Reg/Med | secondary rows, tab labels |
| `caption` | 12/16 | Inter Medium | **the floor.** helper, meta, chip labels |
| `label` | 12/15, +1.1, UPPER | Inter SemiBold | section titles, eyebrows |
| `mono` | 13/18, +0.2 | Menlo / monospace | IDs, values, terminal |
| `monoSmall` | 12/16, +0.3 | Menlo / monospace | counts, inline data |
| `metric` / `metricSmall` | 24/28 · 18/22 | Menlo / monospace | KPI numerals |

**Headings get tight (negative) tracking; all-caps labels and mono get positive
tracking.**

**Mono is a real requirement, not decoration.** Use `type.mono` /
`type.monoSmall` / `type.metric` for anything the user compares or scans
vertically: object IDs, counts, currency, percentages, durations, terminal
output, hashes. A column of KPI tiles whose digits don't align reads as noise.

> `FONT_FAMILY.mono` in the theme runtime is the literal string `'monospace'`,
> which resolves on Android and silently falls back to the system sans on iOS.
> The kit exports `MONO_FAMILY` (`Menlo` on iOS) and every mono style uses it.
> **Do not use `FONT_FAMILY.mono` directly.**

### Deliberate deviation from the pre-kit headers

`PremiumHeader` rendered its eyebrow and status-pill text at **9px** and
`StatusBarHeader` its labels at 10px. The kit renders both at **12px** per rule
5. Four screens (Sessions, Agents, Cron, TaskActivity) will show slightly
larger kickers. This is intended.

---

## 4. Icons

**SVG only. No emoji in the UI.**

Use `@expo/vector-icons` → `Ionicons` (the app's existing approach; it is
already a dependency and every kit component takes Ionicons names). For custom
glyphs, `react-native-svg` 15.12 is available.

Emoji is still fine in *content* (a chat message, a note body) — never in
chrome, labels, buttons, empty states or status.

> `GlowButton` accepted an emoji string as `icon`. The back-compat shim folds
> anything that isn't an Ionicons name into the label rather than dropping it,
> but new code passes an icon name.

---

## 5. Touch & interaction

- **≥44×44** of tappable area, always. Components smaller than that visually
  (`IconButton size="sm"` is a 36px box, `Chip`) apply `hitSlop={HIT.slop}`
  to reach it.
- **≥8px** (`SPACE.sm`) between adjacent tap targets.
- **Press feedback is mandatory**: opacity (0.7–0.9) and/or a 0.97 scale. The
  kit does this for you; if you build a bare `Pressable`, do it yourself.
- **Loading and disabled are explicit states**, never just a dead handler.
  `Button` has `loading` (spinner, blocks press) and `disabled` (0.45 opacity,
  blocks press) and they are visually distinct.
- **`accessibilityLabel` on every interactive element.** `IconButton` warns in
  `__DEV__` when it's missing, because an icon has no text for a screen reader.

---

## 6. Safe area

`react-native-safe-area-context` insets on **every** screen wrapper. Never
hardcode a status-bar height, never `Platform.OS === 'ios' ? 44 : 0`.

Use `<Screen>` — it applies insets, the scroll container, refresh control and
keyboard avoidance. If you can't (an existing screen with its own layout),
call `useSafeAreaInsets()` directly.

`AppHeader` applies the top inset itself (`safeArea` defaults `true`). Pass
`safeArea={false}` when it renders *below* a navigator header that already
consumed it — this is what the `PremiumHeader` back-compat shim does.

---

## 7. Motion

**Subtle. Dense data must not bounce.**

- List stagger: `staggerDelay(index)` → 28ms/item, clamped to **420ms** total.
  Inside the mandated 300–450ms window regardless of list length.
- Enter **260ms**, exit **160ms**. Exits are faster than enters so dismissal
  feels instant.
- **No `back.out` / overshoot springs.** Every spring in the kit is
  `bounciness: 0`.
- Enter translate distance is **8px** (`MOTION.rise`). Small on purpose.
- **Reduce-motion is respected everywhere.** `useReducedMotion()` from
  `ui-kit/a11y`; every animated kit component snaps to its final state instead
  of tweening. If you animate, check it.
- Prefer the **native driver**. `Skeleton` pulses opacity only —
  never translate a shimmer bar across a long list.

---

## 8. Navigation

- Bottom nav (`FloatingDock`) is capped at **≤5 primary destinations**.
  Everything else lives under **More** or inside a stack.
- Back is predictable: a stack screen goes back to its parent, a modal
  dismisses. Don't re-root the navigator on a detail tap.
- Deep links are preserved — don't rename an existing route. Add new ones.

---

## 9. The kit — component inventory

Import from the barrel:

```js
import { Screen, AppHeader, Card, ListRow, StatCard, Chip, Button } from '../ui-kit';
```

### Layout

**`<Screen>`** — safe-area + scroll wrapper. Root of every screen.
`scroll` (bool, default true — pass false when the screen owns a FlatList) ·
`padded` (bool, default true — SPACE.lg gutters) · `edges` (array, default
`['top','bottom']`) · `dockSpace` (bool — clears the FloatingDock) ·
`refreshing` + `onRefresh` (pull-to-refresh) · `keyboardAvoiding` (bool) ·
`header` / `footer` (node, outside the padding) · `opaque` (bool) ·
`style` · `contentStyle` · `testID`. Also exports `DOCK_SPACE` (96).

**`<AppHeader>`** — the one header. See §10 for the consolidation mapping.
`variant` `'premium' | 'nav' | 'status'` (default premium) · `title` ·
`eyebrow` · `subtitle` · `statusPill` `{label, color, dot?}` ·
`status` `'connected'|'connecting'|'disconnected'|'error'` · `statusMeta` ·
`leftIcon` + `onLeftPress` + `leftLabel` · `rightIcon` + `onRightPress` +
`rightLabel` · `rightComponent` (node) · `rightActions`
`[{key?, icon, onPress, color?, busy?, disabled?, label?}]` · `showLogo` +
`logoSource` · `transparent` · `shimmer` (default true) · `bottomLine`
(default true) · `safeArea` (default true) · `children` (extra row below the
title — tabs, search) · `style` · `testID`.
Also exports **`<HeaderAction>`** (the 44×44 icon action).

**`<SectionTitle>`** — all-caps section header. Applies its own `SPACE.xl`
top margin. `title` · `count` · `subtitle` · `actionLabel` + `onAction` ·
`actionIcon` · `right` (node) · `style` · `testID`.

**`<Divider>`** — hairline. `inset` (bool — indents past a leading icon) ·
`spacing` · `vertical` · `style`. Uses `borderSubtle`, not gold: interior
separators recede.

### Surfaces

**`<Card>`** — the canonical glass surface (was GlassCard + GlassSurface).
`tint` `'primary'|'neutral'|'success'|'warning'|'danger'|'info'|'accent'` ·
`depth` `0|1|2|3` (default 1) · `radius` (default 16) · `intensity` (blur
override) · `glow` (bool) · `cornerAccents` (bool) · `padded` (bool→SPACE.lg,
or a number) · `animated` + `delay` · `onPress` / `onLongPress` / `disabled`
(makes the card a button — `accessibilityLabel` required) · `style` · `testID`.
Also exports `resolveTint(tint, colors)`.

**`<StatCard>`** — a KPI tile. Monospaced numeral, all-caps eyebrow, signed
delta. `label` · `value` · `unit` · `delta` (number|string — sign drives arrow
and tone) · `deltaLabel` · `tone` · `icon` · `footnote` · `loading` (renders a
Skeleton) · `compact` (for 3-up grids) · `onPress` · `style` · plus any `Card`
prop.

**`<ListRow>`** — the dense data row; the workhorse.
`title` (string|node) · `subtitle` · `meta` (node — the chips row) ·
`leading` (node) or `icon` + `iconTone` · `value` (right-aligned, **monospaced**)
+ `valueTone` · `trailing` (node) · `chevron` (defaults to `!!onPress`) ·
`onPress` / `onLongPress` · `selected` · `disabled` · `dense` · `style` ·
`accessibilityLabel` / `accessibilityHint` · `testID`.
Separate rows inside a Card with `<Divider inset />`, not per-row borders.

`iconTone` / `valueTone` accept **either a tone name** (`'primary'` `'success'`
`'warning'` `'danger'` `'info'` `'accent'` `'neutral'`) **or an explicit color**.
They were originally colors only, which made `ListRow` the one component where
`tone="danger"` was accepted and rendered *black* — measured at **1.05:1** on the
obsidian surface, i.e. an invisible value. They now run through the same
`toneColor()` the rest of the kit uses, so the tone vocabulary is uniform and
existing color-passing callers are unaffected.

### Controls

**`<Button>`** — `title` · `onPress` / `onLongPress` · `icon` / `iconRight`
(Ionicons names) · `variant` `'primary'|'secondary'|'outline'|'ghost'|'danger'`
· `size` `'sm'|'md'|'lg'` (36/44/52, all ≥44 tap) · `disabled` · `loading` ·
`fullWidth` · `style` · `textStyle` · `accessibilityLabel` /
`accessibilityHint` · `testID`.
**At most one `variant="primary"` per visible screen region** — it is a gold
fill.

**`<IconButton>`** — `icon` · `onPress` / `onLongPress` · `variant`
`'ghost'|'solid'|'outline'` · `size` `'sm'|'md'|'lg'` · `tone` · `disabled` ·
`loading` · `badge` (number|string) · `accessibilityLabel` (**required**) ·
`style` · `testID`.

**`<Field>`** (alias **`<Input>`**) — `label` · `helper` · `error` · `value` +
`onChangeText` · `icon` · `rightIcon` + `onRightPress` + `rightLabel` ·
`mono` (monospaced entry — use for IDs/keys/URLs) · `multiline` + `rows` ·
`required` · `disabled` · `style` · `inputStyle` · `testID` · plus any
`TextInput` prop. Focus ring in `primary`; error state sets a red border, a
message and the a11y state.

**`<Tabs>`** — scrollable pill row. `tabs` `[{key, label, icon?, count?}]` ·
`active` · `onSelect` · `scrollable` (default true) · `style` · `contentStyle`.
Use when the tab count is unbounded.

**`<SegmentedControl>`** — fixed equal segments in a recessed track.
`options` (`[{key,label,icon?}]` or `['a','b']`) · `value` · `onChange` ·
`size` `'sm'|'md'` · `style`. Use for 2–4 mutually exclusive view modes.

### Status vocabulary

**`<Chip>`** — `label` · `tone`
`'neutral'|'primary'|'accent'|'info'|'success'|'warning'|'danger'` · `color`
(override) · `icon` · `dot` · `size` `'sm'|'md'` · `solid` · `selected` ·
`onPress` (makes it a filter chip) · `count` · `style` · `textStyle` ·
`accessibilityLabel` · `testID`.

**`<Badge>`** — `value` · `tone` · `color` · `style` · `testID`. Monospaced.

**`<StatusChip>`** — `status` (any string from any object — tone resolves
automatically) · `label` (override) · `size` · `dot` (default true) · `style`.
Unknown statuses fall back to neutral rather than throwing; status strings come
from Notion and remote objects and **will** drift.

**`<PriorityChip>`** — `priority` · `size` · `full` (long label) · `style`.
Implements **§26 P0–P3** verbatim. Accepts `'P0'..'P3'` *or* the legacy words
(`critical`/`immediate`/`urgent` → P0, `high` → P1, `medium`/`normal` → P2,
`low` → P3). Renders **nothing** for an unrecognised value rather than
inventing a priority.

| | label | tone |
|---|---|---|
| `P0` | Critical | danger |
| `P1` | High | warning |
| `P2` | Normal | info |
| `P3` | Low | neutral |

Helpers: `PRIORITY_META` · `normalizePriority(value)` · `toneForStatus(status)`
· `toneColor(tone, colors)`.

`toneForStatus` already maps: kanban lifecycle (`backlog`/`todo`/`not started`,
`in_progress`, `review`/`awaiting response`/`revisit`/`pending`,
`done`/`complete`/`shipped`/`won`, `blocked`/`failed`/`lost`/`overdue`,
`paused`/`archived`/`cancelled`/`draft`), connection states, and the **§35 data
quality** vocabulary (`Verified`, `FounderReported`, `OperationsEstimated`,
`Unknown`) — so an estimate never looks like a fact. Add to `STATUS_TONES` in
`Chip.js` rather than branching at the call site.

It also now maps every **KIS Phase 1 object status**: opportunity pipeline stages
(`New` … `Negotiation`, `Hold`), product status + validation stage (`Development`,
`Idea` … `Scaled`, `Retired`), decision lifecycle (`Preparing`,
`Ready for Decision`, `CEO Review`, `Decided`, `Deferred`), risk lifecycle
(`Open`, `Monitoring`, `Mitigated`, `Closed`) and commitment lifecycle
(`Expected`, `Invoiced`, `Partially Paid`, `Paid`). `Open` is deliberately
**warning, not danger** — severity on a risk is carried by its P×I band chip, and
`open` is a generic issue status elsewhere.

### Feedback

**`<ProgressBar>`** — `value` (0..1, or 0..100 — anything >1 is a percentage;
`null`/`undefined` → indeterminate) · `tone` · `height` (default 6) · `label` ·
`showValue` · `trackTone` · `style` · `testID`.
Indeterminate degrades to a static 35% fill under reduce-motion.

**`<Skeleton>`** — `width` · `height` · `radius` · `count` (stacked lines, last
one shortened) · `gap` · `style`. Opacity-only pulse.
**`<SkeletonRow>`** — a `ListRow`-shaped placeholder. `avatar` · `style`.

**`<EmptyState>`** — also the error state. `icon` · `title` · `message` ·
`actionLabel` + `onAction` · `secondaryLabel` + `onSecondary` · `tone` (pass
`'danger'` for errors) · `compact` · `style` · `testID`.
An empty list is never a blank screen: say what would be here, why it isn't,
and give the one action that changes it.

### Overlays

**`<BottomSheet>`** — `visible` + `onClose` (required) · `title` · `subtitle` ·
`headerRight` · `children` · `footer` · `maxHeightRatio` (default 0.85) ·
`scroll` (default true) · `dismissible` (default true) · `testID`.
Backdrop tap + downward drag dismiss; bottom safe-area inset applied; Android
back handled.

**`<Modal>`** — centered card for confirmations. `visible` + `onClose` ·
`title` · `subtitle` · `children` · `footer` · `dismissible` · `width`
(default 340) · `testID`.
Anything scrollable or list-shaped belongs in a `BottomSheet`.

### Tokens & helpers

`useUIKit()` → `{ colors, fonts, mode, isReady, type, space, radius, motion,
elevation, hit, alpha }` — **the one hook every screen calls.**
`SPACE` · `RADIUS` · `HIT` · `MOTION` · `ELEVATION` · `MIN_FONT_SIZE` ·
`MONO_FAMILY` · `makeType(fonts)` · `staggerDelay(index)` · `blurFor(intensity)`
· `useReducedMotion()` · `a11yPress({label, hint, role, disabled, selected, busy})`.

`ui-kit/contrast.js` (not in the barrel — import directly if you need it):
`ensureContrast(color, backdrop, min)` · `contrastRatio(a, b)` ·
`composite(fg, bg)` · `luminance(c)` · `surfaceBackdrop(colors)` ·
`neutralBackdrop(colors, alpha)` · `washBackdrop(colors, tone, alpha)` ·
`bestLabelOn(stops, {min, preferred})` · `ensureFillOn(stops, label, min)`.

---

## 10. Consolidated header mapping

Three headers became one. **All three old files still exist as thin
back-compat re-exports, so no existing import breaks.**

| old | new | notes |
|---|---|---|
| `components/PremiumHeader.js` → `PremiumHeader` | `<AppHeader variant="premium" safeArea={false} />` | Same prop surface, forwarded verbatim. `safeArea={false}` is pinned in the shim because the original never applied the top inset (its callers sit below a navigator header). Callers: SessionsScreen, AgentsScreen, CronScreen, TaskActivityScreen. |
| `components/SleekHeader.js` → `SleekHeader` | `<AppHeader variant="nav" />` | `statusIndicator` → `status`, `showGradientLine` → `bottomLine`. Was already `@deprecated` and unused by screens. |
| `components/StatusBarHeader.js` → `StatusBarHeader` | `<AppHeader variant="status" safeArea={false} bottomLine={false} />` | Was already `@deprecated`; chat connection status lives in `ChatHeader`. |
| `components/GlassCard.js` → `GlassCard` | `<Card depth={1} />` | Prop surface identical. |
| `components/GlassSurface.js` → `GlassSurface` | `<Card />` | `depth`/`radius` defaults preserved. |
| `components/GlowButton.js` → `GlowButton` | `<Button />` | Non-Ionicons `icon` values fold into the label. |

**Still canonical in `PremiumHeader.js`** (not folded into the kit — they are
screen-level composites the kit's primitives compose into, and folding them
would have been a behaviour change to 4 live screens):
`GlassTabBar`, `GlassSearchBar`, `GlassFilterChips`.
New screens should prefer `<Tabs>`, `<Field>` and a `<Chip onPress>` row.

**`ChatHeader.js` is untouched** — it is the chat surface's own canonical
header and was already the designated replacement for Sleek/StatusBar.

### Migration policy for parity agents

Do **not** bulk-rewrite existing screens onto the kit as a side effect of your
ticket. Use the kit for **new** screens and for screens your ticket already
rewrites. The shims exist so the two can coexist indefinitely.

---

## 11. Add-a-screen convention

Follow this exactly so parallel agents don't collide.

### Step 1 — the screen file

`mobile/src/screens/<Name>Screen.js`. One screen per file. It receives
`gateway` as a prop (the app's existing pattern — do not reach for a context).

```jsx
import React from 'react';
import { View } from 'react-native';
import {
  Screen, AppHeader, Card, ListRow, SectionTitle, Divider,
  StatusChip, PriorityChip, EmptyState, SkeletonRow, useUIKit, SPACE,
} from '../ui-kit';
import { useOpportunities } from '../hooks/useOpportunities';

export function OpportunitiesScreen({ navigation, gateway }) {
  const { colors } = useUIKit();
  const { items, loading, error, refresh } = useOpportunities(gateway.sendReq);

  return (
    <Screen
      scroll
      refreshing={loading}
      onRefresh={refresh}
      header={
        <AppHeader
          eyebrow="Operations"
          title="Opportunities"
          subtitle={`${items.length} open`}
          leftIcon="chevron-back"
          leftLabel="Back"
          onLeftPress={() => navigation.goBack()}
          rightActions={[{ icon: 'add', label: 'New opportunity', onPress: onCreate }]}
        />
      }
    >
      <SectionTitle title="Pipeline" count={items.length} />

      {error ? (
        <EmptyState
          tone="danger"
          icon="alert-circle"
          title="Couldn't load opportunities"
          message={error}
          actionLabel="Retry"
          onAction={refresh}
        />
      ) : loading && !items.length ? (
        <Card><SkeletonRow /><Divider inset /><SkeletonRow /></Card>
      ) : !items.length ? (
        <EmptyState
          icon="briefcase-outline"
          title="No opportunities yet"
          message="Opportunities you create or convert from a lead show up here."
          actionLabel="New opportunity"
          onAction={onCreate}
        />
      ) : (
        <Card>
          {items.map((item, i) => (
            <React.Fragment key={item.id}>
              {i > 0 && <Divider inset />}
              <ListRow
                icon="briefcase"
                title={item.name}
                subtitle={item.nextAction}
                meta={<><PriorityChip priority={item.priority} size="sm" />
                       <StatusChip status={item.stage} size="sm" /></>}
                value={item.financialValue ? `$${item.financialValue}` : undefined}
                onPress={() => navigation.navigate('OpportunityDetail', { id: item.id })}
                accessibilityLabel={item.name}
              />
            </React.Fragment>
          ))}
        </Card>
      )}
    </Screen>
  );
}

export default OpportunitiesScreen;
```

Every list screen must handle **all four** states: error, first-load, empty,
loaded. The kit gives you a component for each; there is no excuse for a blank
screen.

### Step 2 — the data hook

`mobile/src/hooks/use<Thing>.js`. **Mirror `useKanban.js`'s shape**: the hook
takes `sendReq` (never the whole gateway), owns its own `loading`/`error`, and
returns loaders plus mutators.

The kit ships a generalised version — prefer it over hand-rolling:

```js
// mobile/src/hooks/useOpportunities.js
import { useGatewayResource } from './useGatewayResource';

export function useOpportunities(sendReq, params) {
  const { items, loading, error, refresh, mutate } = useGatewayResource(sendReq, {
    method: 'opportunity.list',
    params,
    select: (res) => res?.opportunities ?? res ?? [],
  });

  const update = (id, patch) =>
    mutate('opportunity.update', { id, ...patch }, {
      optimistic: (list) => list.map((o) => (o.id === id ? { ...o, ...patch } : o)),
    });

  return { opportunities: items, loading, error, refresh, update };
}
```

`useGatewayResource(sendReq, opts)` → `{ items, setItems, loading, error,
loadedAt, refresh, mutate }`. Options: `method` · `params` (compared by JSON
identity, so inline literals are fine) · `select` · `enabled` · `auto` ·
`fallback` (async, tried when `method` throws — this is `useKanban`'s
`notion.*` → `kanban.*` pattern) · `initial`.

It guards against a stale response overwriting a newer one, and degrades an
unregistered RPC to `error` + empty items instead of an unhandled rejection.
**That last part matters:** new gateway methods routinely need a restart before
they exist, and your screen must not white-screen in the meantime.

For live updates: `useGatewayEvent(gateway.subscribeEvent, 'kanban:changed', refresh)`.

### Step 3 — register the route in `App.js`

Add a `<Stack.Screen>` to the stack that owns your domain. **Do not create a
new stack** unless you're adding a whole new tab, and **do not add a tab**
(the dock is capped at 5 — see §8).

Existing stacks: `DashboardStackScreen`, `BusinessStackScreen`,
`KnowledgeStackScreen`, `DisciplineStackScreen`, `AutonomyStackScreen`.
KIS object screens belong in **`BusinessStackScreen`**.

```jsx
<Stack.Screen name="Opportunities" options={{ headerTitle: 'Opportunities', headerShown: false }}>
  {(props) => <OpportunitiesScreen {...props} gateway={gateway} />}
</Stack.Screen>
```

Use `headerShown: false` when your screen renders its own `<AppHeader>` — which
it should.

### Step 4 — make it reachable

Add an entry to `MoreScreen`'s `moreSections` in `App.js` (the canonical
"All Items" index) so the screen isn't orphaned. This repo has a documented
history of orphaned views that were built and never mounted — an unreachable
screen is an unshipped screen.

### Collision avoidance (read this before you start)

`App.js` is the one file every parity agent touches. To avoid conflicts:

- Add your `<Stack.Screen>` **at the end** of the target stack's list, and your
  `moreSections` item **at the end** of its section.
- Keep the `App.js` diff to exactly those two additions plus one import.
- Never reorder, reformat or re-indent existing entries.
- Never rename an existing route (deep links).

---

## 12. KIS Phase 1 surface (what parity screens target)

Six core business objects landed on `feat/kis-phase1-complete`, each with a
gateway RPC namespace already registered:

| object | RPCs |
|---|---|
| Opportunity | `opportunity.` list · get · search · create · update · delete · **convert** |
| Product | `product.` list · get · search · **graph** · create · update · delete |
| Decision | `decision.` list · get · search · **ceoQueue** · create · update · delete · **guideTask** |
| Risk | `risk.` list · get · search · **overdue** · **links** · create · update · delete · **impacts** · **unimpacts** |
| Commitment | `commitment.` list · get · search · **aggregates** · create · update · delete |
| Person | `person.` list · get · search · **workload** · create · update · delete · **assignTask** · **unassignTask** |

Operations agents (read-only, observe/recommend):
`opsagent.ceoBriefing` · `opsagent.monitor` · `opsagent.projectHealth`.

> `product.*` is the KIS product **registry** — distinct from the pre-existing
> `products` catalog. The web UI routes it at `/product-registry` for exactly
> this reason. Don't conflate them.

### Shared field vocabulary (`src/business-objects/common.ts`, §25)

Every object carries these, so your screens can render them uniformly:

- **Ownership** — `owner` (exactly one accountable; *"a record without one is a
  wish"*), `supportingOwner`, `ceoRequired`
- **Execution** — `status`, `priority` (**P0–P3**), `nextAction`,
  `nextActionOwner`, `nextActionDate`
- **Relationships** — `clientId`, `opportunityId`, `projectId`, `productId`
- **Management** — `riskLevel`, `financialValue`, `blocked`, `blocker`,
  `escalationRequired`, `lastUpdated`
- **Meta** — `id`, `dataQuality` (§35 Verified / FounderReported /
  OperationsEstimated / Unknown), `authorityLevel` (§32 L0–L5)

`<PriorityChip>` and `<StatusChip>` already speak the priority and data-quality
vocabularies. **Use them — do not re-map these enums per screen.**

### Wave M1 — what the object-parity screens added

Shared, reusable by any screen that touches a KIS object:

- **`mobile/src/kis/vocab.js`** — every enum transcribed from the TS source
  (pipeline stages, validation stages, decision/risk/commitment/person statuses,
  categories, types), the P×I helpers (`computeRiskScore`, `riskBand`,
  `riskBandTone`), the object-type/edge label + icon maps, and the formatters
  (`formatMoney`, `formatDate`, `formatAge`, `shortId`, `isPastDue`).
  **Import enums from here rather than retyping them** — a picker that offers a
  value the store rejects is worse than no picker.
- **`mobile/src/kis/ui.js`** — `MetaChips` (the shared §25 chip row),
  `ChipRow`, `DetailRows`, `CommonFieldsDetail`, `ChipPicker` (a chip-based enum
  picker), and `listPlaceholder()`.
  `listPlaceholder()` is a **plain function, not a component**, on purpose: as
  `<ListStates/>` it is a React element, always truthy, so the idiomatic
  `{placeholder || rows.map(...)}` silently swallowed every row. Keep it a
  function.
  `MetaChips` returns a **fragment**, not a wrapped row — `ListRow`'s `meta` slot
  already wraps, and an inner `View` made the chips one unwrappable flex item
  that overflowed the row. Standalone callers wrap it in `<ChipRow>`.
- **`mobile/src/components/RelatedPanel.js`** — the `objrel.*` graph panel.
  Groups typed edges by neighbour type, shows edge direction, and **re-roots on
  tap** with a breadcrumb, so Client → Opportunity → Project → Task → People is
  walkable from any object. It resolves a node's name only through the host's
  `resolveLabel(type, id)`; with no resolver it shows the type plus a monospaced
  short id rather than inventing a label.
- **Hooks** — `useOpportunities`, `useProducts`, `useDecisions`, `useRisks`,
  `useCommitments`, `usePeople`, `useObjectRelations` (+ `useObjectLinks`), all
  on `useGatewayResource`.
- **Screens** — `OpportunitiesScreen`, `ProductsScreen` (route
  `ProductRegistry`), `DecisionsScreen`, `RisksScreen`, `CommitmentsScreen`,
  `PeopleScreen`, in `BusinessStackScreen`, reachable from the More index's
  **Business Control Layer** section via a `businessScreen` item key.

Server-derived values are rendered as given, never recomputed client-side:
`commitment.aggregates`' five money surfaces, `person.workload`, `riskScore` /
`riskLevel`, and a commitment's `remainingBalance` / `overdue`. Re-deriving them
would drift from the spec's definitions the moment a status or type is added.

---

## 13. Verification checklist

Before you call a mobile screen done:

- [ ] `node mobile/design-system/verify-contrast.mjs` passes
- [ ] The screen renders all four list states (error / loading / empty / loaded)
- [ ] No hex literals, no raw pixel gaps, no text under 12px
- [ ] Every interactive element has an `accessibilityLabel` and ≥44×44 tap area
- [ ] Data (IDs, counts, currency, percentages) uses a mono style
- [ ] Safe-area insets applied (via `<Screen>` or `useSafeAreaInsets`)
- [ ] The route is registered **and** reachable from `MoreScreen`
- [ ] The `App.js` diff is additive only

### Verifying the kit itself renders

There is no Expo typecheck in this repo, and `mobile/` has no lint config. The
foundation was verified three ways, all reproducible:

```bash
# 1. Every file parses under the app's real babel config
node -e "…" # babel-preset-expo transformSync over src/ui-kit/*.js

# 2. The whole module graph + every named export resolves
npx esbuild mobile/App.js --bundle --format=esm --outfile=/tmp/check.js \
  --loader:.js=jsx --loader:.png=dataurl --jsx=automatic \
  --platform=neutral --packages=external

# 3. The kit renders headlessly under react-native-web with zero page errors
#    (stub expo-blur / expo-linear-gradient / @expo/vector-icons /
#     react-native-safe-area-context, alias react-native → react-native-web,
#     screenshot in puppeteer with executablePath /opt/google/chrome/google-chrome)
```

(3) is the one worth repeating for a visual change — it produced the screenshots
that caught the chip contrast problem.
