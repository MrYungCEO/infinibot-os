#!/usr/bin/env bash
# window-id-overlay — always-on corner-circle badges with each window's
# reference id (the same id `hyprland_window action=focus address=...` and
# the InfiniBot agent see). Subscribes to Hyprland's event socket and
# pushes the live window list to the overlay daemon on every change.
#
# Usage:
#   ./window-id-overlay.sh start      # start (foreground; logs to stderr)
#   ./window-id-overlay.sh stop       # tells the daemon to drop the badges
#   ./window-id-overlay.sh toggle     # start or stop based on current state
#
# Run on Hyprland session start (e.g. `exec-once = .../window-id-overlay.sh start &`)
# to keep the badges visible whenever you're at the desktop.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"
DAEMON="$REPO_ROOT/overlay-daemon.py"
SOCK="${XDG_RUNTIME_DIR:-/tmp}/infinibot-overlay.sock"
STATE="${XDG_RUNTIME_DIR:-/tmp}/infinibot-window-id-overlay.pid"

ensure_daemon() {
    if [[ ! -S "$SOCK" ]]; then
        echo "[window-id-overlay] starting overlay daemon" >&2
        nohup python3 "$DAEMON" > "${XDG_RUNTIME_DIR:-/tmp}/infinibot-overlay.log" 2>&1 &
        # wait up to 3s for the socket to appear
        for _ in $(seq 1 30); do
            [[ -S "$SOCK" ]] && return 0
            sleep 0.1
        done
        echo "[window-id-overlay] overlay daemon did not come up" >&2
        return 1
    fi
}

send() {
    # one-shot send + read response; tolerant of intermittent failures so a
    # single bad call doesn't kill the event loop. Uses whichever Unix
    # socket client is available on the host (nc, ncat, or socat).
    local NC=""
    if   command -v ncat  >/dev/null 2>&1; then NC=ncat
    elif command -v nc    >/dev/null 2>&1; then NC=nc
    elif command -v socat >/dev/null 2>&1; then NC=socat
    else
        # Pure-Python fallback — keeps the daemon talkable even on slim
        # systems without netcat installed.
        SOCK="$SOCK" python3 - "$1" <<'PY' || true
import os, socket, sys
s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
s.settimeout(1)
try:
    s.connect(os.environ["SOCK"])
    s.sendall((sys.argv[1] + "\n").encode())
    s.recv(4096)
except OSError:
    pass
PY
        return
    fi
    if [[ "$NC" == "socat" ]]; then
        printf '%s\n' "$1" | socat - "UNIX-CONNECT:$SOCK" >/dev/null 2>&1 || true
    else
        # `-q 1` ensures GNU nc / nmap-ncat closes after the response so
        # the pipeline doesn't hang. Falls through silently if -q isn't
        # supported (BSD nc), which is fine for fire-and-forget.
        printf '%s\n' "$1" | "$NC" -U "$SOCK" -q 1 >/dev/null 2>&1 \
            || printf '%s\n' "$1" | "$NC" -U "$SOCK" -w 1 >/dev/null 2>&1 \
            || true
    fi
}

build_window_payload() {
    # Per-window persistent identification — emits FOUR thin layer-shell
    # rectangles per window forming a colored frame (top/bottom/left/
    # right strips). Each window gets a color from the 5-color palette
    # cycled per-monitor (rose/gold/emerald/cyan/violet, wraps at 6th).
    #
    # Why strips: Hyprland 0.54.3 doesn't expose per-window bordercolor,
    # so the compositor only shows one color at a time on its native
    # borders. Drawing 4 narrow click-through surfaces around each window
    # is the only way to show every window's color simultaneously without
    # eating mouse input (the full-window overlay variant we tried earlier
    # did exactly that, and 60×60 corner badges hid color identity).
    local strip=5     # strip thickness in pixels
    local mons clients
    mons=$(hyprctl monitors -j 2>/dev/null)
    clients=$(hyprctl clients -j 2>/dev/null)

    jq -nc \
        --argjson mons "$mons" \
        --argjson clients "$clients" \
        --argjson strip "$strip" '
        ($mons | map({ (.id|tostring): . }) | add) as $mmap
        # Per-monitor sequential palette assignment, wrapping at 5.
        | (
            [ $clients[]
              | select(.mapped == true)
              | select(.workspace.id >= 0)
              | { address: .address,
                  monitor: .monitor,
                  sortkey: (((.focusHistoryID // 99999) | tostring) + "_" + .address) }
            ]
            | group_by(.monitor)
            | map(sort_by(.sortkey) | to_entries | map(.value + {idx: (.key % 5)}))
            | flatten
            | map({ (.address): .idx }) | add
          ) as $color_idx
        # 0=rose 1=gold 2=emerald 3=cyan 4=violet (matches window-color-ids.sh).
        | [ "ff3366", "facc15", "10b981", "06b6d4", "a855f7" ] as $palette
        | [ $clients[]
            | select(.mapped == true)
            | select(.workspace.id >= 0)
            | .address as $addr
            | (.monitor|tostring) as $mid
            | ($mmap[$mid] // null) as $m
            | select($m != null)
            | ($color_idx[$addr] // 0) as $cidx
            | $palette[$cidx] as $hex
            | (.at[0] - $m.x) as $lx
            | (.at[1] - $m.y) as $ly
            | .size[0] as $ww
            | .size[1] as $wh
            | [
                { side: "top",    x: $lx,                    y: $ly,                    w: $ww,    h: $strip },
                { side: "bottom", x: $lx,                    y: ($ly + $wh - $strip),   w: $ww,    h: $strip },
                { side: "left",   x: $lx,                    y: $ly,                    w: $strip, h: $wh },
                { side: "right",  x: ($lx + $ww - $strip),   y: $ly,                    w: $strip, h: $wh }
              ][]
            | {
                id:        ($addr + "/" + .side),
                label:     "",
                color:     ("#" + $hex),
                monitor:   $m.name,
                monitor_x: $m.x,
                monitor_y: $m.y,
                geometry:  { x: .x, y: .y, width: .w, height: .h }
              }
          ]
    '
}

push_sync() {
    local windows
    windows=$(build_window_payload)
    [[ -z "$windows" || "$windows" == "null" ]] && windows="[]"
    # Strips are rendered as opaque solid-color fills. The daemon honors
    # per-window `.color` on each surface (we set it in build_window_payload)
    # so each frame gets its assigned palette hue. We pass `thickness: 0`
    # so no ring outline is drawn on top of the fill.
    local payload
    payload=$(jq -nc --argjson w "$windows" '{
        op: "sync_window_ids",
        windows: $w,
        theme: {
            color: "#ff3366",
            badge_style: "frame_strip",
            fill_alpha: 1.0,
            thickness: 0
        }
    }')
    send "$payload"
}

start() {
    ensure_daemon || exit 1
    push_sync

    echo $$ > "$STATE"
    trap 'send "{\"op\":\"exit_window_ids\"}"; rm -f "$STATE"; exit 0' INT TERM

    # Hyprland event socket path. v2 is the modern event channel and emits
    # one line per event in `event>>arg1,arg2,...` form.
    local sig="${HYPRLAND_INSTANCE_SIGNATURE:-}"
    if [[ -z "$sig" ]]; then
        echo "[window-id-overlay] HYPRLAND_INSTANCE_SIGNATURE not set; staying static" >&2
        sleep infinity
    fi
    local evsock="${XDG_RUNTIME_DIR:-/tmp}/hypr/$sig/.socket2.sock"
    if [[ ! -S "$evsock" ]]; then
        # legacy /tmp/hypr layout
        evsock="/tmp/hypr/$sig/.socket2.sock"
    fi
    if [[ ! -S "$evsock" ]]; then
        echo "[window-id-overlay] Hyprland event socket not found at $evsock" >&2
        sleep infinity
    fi

    echo "[window-id-overlay] subscribing to $evsock" >&2
    # Event listener: use whichever client is available, with a python
    # fallback so we don't depend on socat/ncat being installed.
    listen_cmd=""
    if command -v socat >/dev/null 2>&1; then
        listen_cmd="socat -U - UNIX-CONNECT:$evsock"
    elif command -v ncat >/dev/null 2>&1; then
        listen_cmd="ncat -U $evsock"
    elif command -v nc >/dev/null 2>&1 && nc -h 2>&1 | grep -q ' -U'; then
        listen_cmd="nc -U $evsock"
    fi

    if [[ -n "$listen_cmd" ]]; then
        eval "$listen_cmd" | while IFS= read -r line; do
            case "$line" in
                openwindow*|closewindow*|movewindow*|movewindowv2*|resizewindow*|workspace*|activewindow*|focusedmon*|monitoradded*|monitorremoved*|fullscreen*|changefloatingmode*|togglegroup*|moveintogroup*|moveoutofgroup*|configreloaded*)
                    push_sync
                    ;;
            esac
        done
    else
        # Pure-Python event subscriber. Works on any host with python3.
        EVSOCK="$evsock" python3 - <<'PY' | while IFS= read -r evt; do push_sync; done
import os, socket, sys
ev = os.environ["EVSOCK"]
s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
s.connect(ev)
buf = b""
while True:
    chunk = s.recv(4096)
    if not chunk:
        break
    buf += chunk
    while b"\n" in buf:
        line, buf = buf.split(b"\n", 1)
        head = line.decode(errors="replace").split(">>", 1)[0]
        if head in ("openwindow","closewindow","movewindow","movewindowv2",
                    "resizewindow","workspace","activewindow","focusedmon",
                    "monitoradded","monitorremoved","fullscreen",
                    "changefloatingmode","togglegroup","moveintogroup",
                    "moveoutofgroup","configreloaded"):
            print(head, flush=True)
PY
    fi
}

stop() {
    send '{"op":"exit_window_ids"}'
    if [[ -f "$STATE" ]]; then
        local pid
        pid=$(cat "$STATE")
        kill "$pid" 2>/dev/null || true
        rm -f "$STATE"
    fi
}

toggle() {
    if [[ -f "$STATE" ]] && kill -0 "$(cat "$STATE")" 2>/dev/null; then
        stop
    else
        start
    fi
}

case "${1:-start}" in
    start)  start  ;;
    stop)   stop   ;;
    toggle) toggle ;;
    *)
        echo "Usage: $0 {start|stop|toggle}" >&2
        exit 2
        ;;
esac
