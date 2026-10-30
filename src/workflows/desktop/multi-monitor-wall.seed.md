---
id: multi-monitor-wall
name: Multi-Monitor InfiniBot Wall
description: Open the InfiniBot control UI across all connected monitors — one route per screen, each in its own fullscreen Chrome --app window. The widest monitor gets the live activity map; the rest get voice, dashboard, discipline, and projects in a stable order.
tags:
  - desktop
  - multi-monitor
  - chrome
  - control-ui
  - workspace
author: main
agent: main
timeoutSeconds: 180
inputs:
  - name: gatewayUrl
    label: Gateway base URL
    description: Base URL of the InfiniBot gateway UI. Default works on the host machine.
    type: string
    required: false
    default: "http://localhost:18789"
    placeholder: "http://localhost:18789"
  - name: browserBin
    label: Browser binary
    description: Path to the Brave (or Chrome) binary. Defaults to the snap-installed Brave; falls back to the InfiniBot chrome wrapper.
    type: string
    required: false
    default: "/snap/bin/brave"
    placeholder: "/snap/bin/brave"
  - name: classPrefix
    label: Auto-class prefix
    description: WM class prefix Brave/Chrome gives to --app windows. Brave uses brave-localhost__, Chrome uses {{classPrefix}}.
    type: string
    required: false
    default: "brave-localhost__"
    placeholder: "brave-localhost__"
  - name: classSuffix
    label: Auto-class suffix
    description: WM class suffix derived from the active browser profile. Brave default profile → -Default, InfiniBot chrome wrapper → {{classSuffix}}.
    type: string
    required: false
    default: "-Default"
    placeholder: "-Default"
  - name: closeExisting
    label: Close existing InfiniBot --app windows first
    description: Kill any pre-existing chrome --app windows pointing at the gateway URL before launching the wall.
    type: boolean
    required: false
    default: false
requires:
  - kind: tool
    name: Bash
    reason: Workflow shells out to xrandr, chrome, and wmctrl/xdotool to position + fullscreen windows.
---

# Multi-Monitor InfiniBot Wall

Open the InfiniBot control UI across every connected monitor — one route per screen — and fullscreen each one. The widest monitor (largest pixel width in xrandr's `WxH+X+Y`) gets the live **activity map**. The remaining monitors get **voice**, **dashboard**, **discipline**, and **projects**, assigned in a stable left-to-right order (by x-offset).

You are running on Linux. Do NOT prompt the user; follow this script end-to-end and report success.

**Detect the display server first.** On Wayland compositors (Hyprland, Sway, GNOME-Wayland, KDE-Wayland) Chrome's `--window-position` and `--class` flags are IGNORED — you must use the compositor's own window-placement RPC. The current target compositor is Hyprland, so the rest of this workflow uses `hyprctl`. If `$XDG_SESSION_TYPE` is `x11`, fall back to the old `--window-position` + `wmctrl` path.

## Step 1 — Enumerate connected monitors

On Hyprland:

```bash
hyprctl monitors -j
```

Each entry gives you `name`, `width`, `height`, `x`, `y`, and `activeWorkspace.id` — that workspace id is the stable per-monitor handle you'll use for placement.

X11 fallback (only if `$XDG_SESSION_TYPE = x11`):

```bash
xrandr --query | awk '/ connected/ {print $1, $3, $4}'
```

For each connected output, parse the geometry token (the first token shaped like `WxH+X+Y` — it may appear in column 3 OR 4 if the output is `primary`). Build a list of records:

```
{ name, width, height, x, y }
```

Skip any output that has no `WxH+X+Y` token (disconnected or off).

If there are fewer than 5 connected monitors, proceed anyway — assign as many routes as you have monitors in the order below and skip the rest (report which routes were skipped).

## Step 2 — Detect an existing "voice home" window and assign routes

Before assigning monitors, check whether the user already has a voice-bearing InfiniBot window open (the master terminal they're talking to right now). If found, **leave that window where it is**, fullscreen it in place, and do NOT spawn a new `/voice` window — the user explicitly does not want their active voice session covered.

```bash
EXISTING=$(hyprctl clients -j | python3 -c "
import json,sys
for c in json.load(sys.stdin):
    cl=c.get('class','')
    t=c.get('title','')
    # Match either a previously-spawned wall voice window or the user's main
    # InfiniBot browser window (Master Terminal). The Master Terminal is the
    # one the voice orchestrator runs in.
    if cl.startswith(('brave-localhost__voice-','chrome-localhost__voice-')) \
       or (cl in ('google-chrome','brave-browser','Brave-browser','chromium','Chromium') and 'InfiniBot' in t):
        print(f\"{c['address']}|{c['monitor']}|{c['workspace']['id']}\"); break
")
```

Assignment rules:

- **If `EXISTING` is set**: that monitor is the voice home — skip it entirely (do NOT spawn `/voice`, do NOT spawn `/activity` onto it). From the remaining 4 monitors: the widest → `/activity`, then the other 3 by x-offset ASC → `/dashboard`, `/discipline`, `/projects`. Total spawned windows: 4. The existing voice window stays fullscreen on its current monitor.
- **If `EXISTING` is empty**: standard 5-way layout — widest monitor → `/activity`, remaining 4 by x-offset ASC → `/voice`, `/dashboard`, `/discipline`, `/projects`.

CRITICAL: after each focus+fullscreen storm, re-fullscreen the EXISTING window one final time. The parallel `focuswindow` dispatches on newly-mapped wall windows can race-toggle the existing window's fullscreen state off.

Always fullscreen the existing voice window (whether spawned by us or pre-existing):

```bash
if [ -n "$EXISTING" ]; then
  addr=${EXISTING%%|*}
  hyprctl --batch "dispatch focuswindow address:$addr ; dispatch fullscreen 1" >/dev/null
fi
```

Print the mapping (monitor name → route, plus whether voice was pre-existing) before launching anything, so the user sees it in the run log.

## Step 3 — (Optional) Close existing InfiniBot --app windows

If the user's `{{closeExisting}}` is `true`, run:

```bash
pkill -f "chrome.*--app=.*{{gatewayUrl}}" || true
sleep 1
```

Do NOT kill the entire chrome process tree — only `--app=` windows pointing at the gateway URL.

## Step 3.5 — Seed the profile-gate bypass (skip the profile-picker)

Each `--app` window is a fresh page load. The InfiniBot profile-picker shows whenever `localStorage["infinibot.profiles.gateEnabled.v1"] != "0"`. Seed that flag on the gateway origin BEFORE launching the wall so every window lands directly on its route.

```bash
node "$HOME/.infinibot/workflows/seed-profile-gate.mjs" "{{browserBin}}" "{{gatewayUrl}}"
```

The seeder script spawns a one-off browser window with `--remote-debugging-port`, attaches via CDP, sets `localStorage["infinibot.profiles.gateEnabled.v1"] = "0"` + `sessionStorage["infinibot.profiles.gatePassed"] = "1"`, then closes itself. localStorage persists in the browser's Default profile, so once seeded all subsequent --app windows skip the gate.

If the seeder fails (CDP target not found, browser missing) continue anyway — the wall will still open, just with the picker visible on each window.

## Step 4 — Install Hyprland window rules BEFORE launching

On Wayland, Chrome's `--class` flag is IGNORED — Chrome auto-assigns its app window a deterministic class derived from the URL: `chrome-<host-with-underscores>__<path>-<profile-name>`. For routes hosted at `localhost:18789` under the InfiniBot profile, the classes are:

- `{{classPrefix}}activity{{classSuffix}}`
- `{{classPrefix}}voice{{classSuffix}}`
- `{{classPrefix}}dashboard{{classSuffix}}`
- `{{classPrefix}}discipline{{classSuffix}}`
- `{{classPrefix}}projects{{classSuffix}}`

Install `windowrulev2` rules so each app window is sent to its target workspace and fullscreened the moment it's mapped — this is what makes the placement instant rather than animated:

```bash
# Hyprland 0.45+ removed the `windowrulev2` keyword (v2 is the only form).
# Calling `hyprctl keyword windowrulev2 ...` on 0.45+ poisons the in-memory
# config — any subsequent reload drops Hyprland to its default config.
hypr_major=$(hyprctl version 2>/dev/null | awk '/^Hyprland/ {print $2; exit}' | awk -F. '{print $1*100+$2}')
if [ -n "$hypr_major" ] && [ "$hypr_major" -ge 45 ]; then
  RULE_KW="windowrule"
else
  RULE_KW="windowrulev2"
fi

declare -A WS=( [activity]=<ws> [voice]=<ws> [dashboard]=<ws> [discipline]=<ws> [projects]=<ws> )
for slug in activity voice dashboard discipline projects; do
  ws=${WS[$slug]}
  cls="{{classPrefix}}${slug}{{classSuffix}}"
  hyprctl keyword "$RULE_KW" "workspace $ws silent, class:^(${cls})$"
  hyprctl keyword "$RULE_KW" "fullscreen, class:^(${cls})$"
done
```

The `<ws>` values come from Step 2's monitor→route mapping (each monitor's `activeWorkspace.id` from `hyprctl monitors -j`).

## Step 5 — Disable Hyprland animations, then launch + place each window in parallel

The visible "windows spawn on one screen and slide to the right one" is Hyprland's window-move animation. The class-based `windowrulev2` from Step 4 fires too late because Chrome announces a generic class first (`google-chrome`) and renames to `{{classPrefix}}<path>{{classSuffix}}` AFTER the window is mapped. So we kill animations during placement, launch each chrome in parallel, poll for its mapped window, then move+fullscreen it — the move is instantaneous because animations are off.

```bash
CHROME="{{browserBin}}"
GW="{{gatewayUrl}}"

hyprctl keyword animations:enabled 0

launch_and_place() {
  local slug=$1 route=$2 ws=$3
  local cls="{{classPrefix}}${slug}{{classSuffix}}"
  # Snapshot existing addresses for this class so we don't re-grab a stale window
  local before
  before=$(hyprctl clients -j | python3 -c "import json,sys;print(','.join(c['address'] for c in json.load(sys.stdin) if c.get('class','')=='$cls'))")
  # DO NOT pass --user-data-dir — the chrome wrapper at {{browserBin}} bakes in
  # --profile-directory=InfiniBot (the already-logged-in profile). Per-window
  # data dirs would land each window on the auth gate.
  setsid "$CHROME" --new-window --app="${GW}${route}" \
    --no-first-run --no-default-browser-check \
    >/dev/null 2>&1 < /dev/null &
  for i in $(seq 1 60); do
    new_addr=$(hyprctl clients -j | python3 -c "
import json,sys
before=set('$before'.split(',')) if '$before' else set()
for c in json.load(sys.stdin):
  if c.get('class','')=='$cls' and c['address'] not in before:
    print(c['address']); break
")
    if [ -n "$new_addr" ]; then
      hyprctl dispatch movetoworkspacesilent "$ws,address:$new_addr" >/dev/null
      hyprctl --batch "dispatch focuswindow address:$new_addr ; dispatch fullscreen 1" >/dev/null
      return
    fi
    sleep 0.1
  done
}

launch_and_place activity   /activity   ${WS[activity]} &
launch_and_place voice      /voice      ${WS[voice]} &
launch_and_place dashboard  /dashboard  ${WS[dashboard]} &
launch_and_place discipline /discipline ${WS[discipline]} &
launch_and_place projects   /projects   ${WS[projects]} &
wait

# Re-enable animations
hyprctl keyword animations:enabled 1
```

Per-route `--user-data-dir` is required so Chrome spawns independent processes — without it later launches consolidate onto a single existing chrome process and the placement loop never finds a new window.

## Step 6 — Verify fullscreen state and reconcile any stragglers

`focuswindow … ; fullscreen 1` can race when called in parallel — a later focus dispatch can land on a window that was about to be fullscreened, leaving one route un-fullscreen. After placement, sweep:

```bash
for slug in activity voice dashboard discipline projects; do
  cls="{{classPrefix}}${slug}{{classSuffix}}"
  is_fs=$(hyprctl clients -j | python3 -c "import json,sys;cs=json.load(sys.stdin);m=[c for c in cs if c.get('class','')=='$cls'];print(m[0].get('fullscreen') if m else 0)")
  if [ "$is_fs" = "0" ] || [ "$is_fs" = "False" ]; then
    hyprctl --batch "dispatch focuswindow class:^(${cls})$ ; dispatch fullscreen 1" >/dev/null
  fi
done
```

X11 fallback (only if `$XDG_SESSION_TYPE = x11`): use `--window-position`/`--window-size` sized to each monitor's geometry, plus `wmctrl -b add,fullscreen` per window.

## Step 6 — Verify and report

Run `wmctrl -lx | grep InfiniBotWall` and print the result. The report should include:

- the monitor → route mapping table,
- the launched window IDs,
- any monitors that were skipped (fewer than 5 connected),
- any fullscreen fallback that was used.

If any window failed to launch or did not end up on the expected monitor, retry that single window once before reporting failure.

## Why this layout

- The widest monitor is the natural home for the **agent activity map** — it benefits from horizontal pixels for the world map.
- `/voice`, `/dashboard`, `/discipline`, `/projects` are the four routes the user runs continuously in parallel.
- Routes are assigned left-to-right by x-offset so the same physical monitor always gets the same route across runs (stable muscle memory).
