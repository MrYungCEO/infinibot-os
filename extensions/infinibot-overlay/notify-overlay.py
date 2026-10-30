#!/usr/bin/env python3
"""InfiniBot notification overlay.

A *short-lived* gtk-layer-shell window that renders a single gold-on-black
glass notification panel on Wayland (Hyprland), then exits. Unlike
overlay-daemon.py (a persistent, click-through highlight server) this process:

  - shows ONE panel and runs its own Gtk.main()
  - auto-dismisses after `timeout_ms` (default 12000) or on click, and ESC
    closes it when the surface holds keyboard focus
  - exits 0 when dismissed

Config arrives as a JSON object, resolved in this order:
  1. $INFINIBOT_NOTIFY_JSON   (the TypeScript side uses this — avoids quoting)
  2. argv[1] as inline JSON, or a path to a JSON file
  3. stdin

Shape:
  {
    "title": "Build finished",
    "body": "All 248 tests passed.",
    "timeout_ms": 12000,
    "anchor": "top-right",            # top-right|top-left|bottom-right|bottom-left|top-center
    "priority": "active",            # passive|active|timeSensitive
    "play_sound": true,
    "sound": "message",              # canberra event id (best-effort)
    "accent": "#E8B84B"              # InfiniBot gold
  }

If the gtk-layer-shell typelib is missing the process exits with code 2 and a
distro-specific install hint on stderr — mirroring overlay-daemon.py so the
TypeScript caller can fall back to notify-send (libnotify).

On success it prints `notify-overlay ready\n` to stderr once the panel is
mapped; the caller waits for that marker, then detaches.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from typing import Any, Dict, Optional

try:
    import gi
    gi.require_version("Gtk", "3.0")
    gi.require_version("GtkLayerShell", "0.1")
    from gi.repository import Gtk, GtkLayerShell, Gdk, GLib
except (ImportError, ValueError) as e:
    msg = (
        "infinibot-overlay: gtk-layer-shell typelib not available — install it.\n"
        "  Debian/Ubuntu:  sudo apt install gir1.2-gtklayershell-0.1 python3-gi python3-gi-cairo\n"
        "  Arch:            sudo pacman -S gtk-layer-shell python-gobject\n"
        f"  Underlying error: {e}\n"
    )
    sys.stderr.write(msg)
    sys.exit(2)


DEFAULT_ACCENT = "#E8B84B"  # InfiniBot gold — matches the rest of the HUD theme


def _load_config() -> Dict[str, Any]:
    raw: Optional[str] = os.environ.get("INFINIBOT_NOTIFY_JSON")
    if not raw and len(sys.argv) > 1:
        arg = sys.argv[1]
        if os.path.isfile(arg):
            with open(arg, "r", encoding="utf-8") as fh:
                raw = fh.read()
        else:
            raw = arg
    if not raw:
        raw = sys.stdin.read()
    if not raw or not raw.strip():
        return {}
    try:
        data = json.loads(raw)
    except Exception as e:  # noqa: BLE001
        sys.stderr.write(f"notify-overlay: invalid JSON config: {e}\n")
        sys.exit(1)
    return data if isinstance(data, dict) else {}


def _escape(text: str) -> str:
    return (
        text.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
    )


def _anchor_edges(anchor: str):
    """Return (top, bottom, left, right) booleans for the requested corner."""
    a = (anchor or "top-right").strip().lower()
    if a == "top-left":
        return True, False, True, False
    if a == "bottom-right":
        return False, True, False, True
    if a == "bottom-left":
        return False, True, True, False
    if a == "top-center":
        return True, False, False, False
    # default top-right
    return True, False, False, True


def _build_css(accent: str) -> bytes:
    accent = accent if accent.startswith("#") and len(accent) in (4, 7) else DEFAULT_ACCENT
    return f"""
    .ib-notify-card {{
        background: linear-gradient(135deg, rgba(14,11,4,0.94), rgba(4,4,6,0.96));
        border: 1.5px solid {accent};
        border-radius: 16px;
        padding: 16px 20px;
        box-shadow: 0 12px 40px rgba(0,0,0,0.55);
    }}
    .ib-notify-title {{
        color: {accent};
        font-size: 15px;
        font-weight: 700;
        letter-spacing: 0.3px;
    }}
    .ib-notify-body {{
        color: rgba(245,240,228,0.92);
        font-size: 13px;
    }}
    .ib-notify-rule {{
        background: {accent};
        min-height: 2px;
        margin: 8px 0;
        opacity: 0.55;
    }}
    """.encode("utf-8")


class NotifyWindow(Gtk.Window):
    def __init__(self, cfg: Dict[str, Any]):
        super().__init__(type=Gtk.WindowType.TOPLEVEL)
        self.set_app_paintable(True)
        self.set_decorated(False)
        self.set_resizable(False)

        # Transparent corners — let the rounded card define the shape.
        screen = self.get_screen()
        visual = screen.get_rgba_visual()
        if visual is not None:
            self.set_visual(visual)

        accent = str(cfg.get("accent") or DEFAULT_ACCENT)
        title = _escape(str(cfg.get("title") or "").strip())
        body = _escape(str(cfg.get("body") or "").strip())

        provider = Gtk.CssProvider()
        provider.load_from_data(_build_css(accent))
        Gtk.StyleContext.add_provider_for_screen(
            screen, provider, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION
        )

        card = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=2)
        card.get_style_context().add_class("ib-notify-card")
        card.set_size_request(360, -1)

        if title:
            lbl = Gtk.Label(xalign=0.0)
            lbl.set_markup(f"<b>{title}</b>")
            lbl.get_style_context().add_class("ib-notify-title")
            lbl.set_line_wrap(True)
            lbl.set_max_width_chars(40)
            card.pack_start(lbl, False, False, 0)

        if title and body:
            rule = Gtk.Box()
            rule.get_style_context().add_class("ib-notify-rule")
            card.pack_start(rule, False, False, 0)

        if body:
            blbl = Gtk.Label(xalign=0.0, label=body)
            blbl.get_style_context().add_class("ib-notify-body")
            blbl.set_line_wrap(True)
            blbl.set_max_width_chars(44)
            card.pack_start(blbl, False, False, 0)

        # EventBox so the whole card is clickable to dismiss.
        evt = Gtk.EventBox()
        evt.add(card)
        evt.connect("button-press-event", lambda *_: self._dismiss())
        self.add(evt)

        # Layer-shell placement.
        GtkLayerShell.init_for_window(self)
        GtkLayerShell.set_layer(self, GtkLayerShell.Layer.OVERLAY)
        # ON_DEMAND so ESC works when the surface has focus, without forcibly
        # stealing keyboard from the active app the whole time.
        GtkLayerShell.set_keyboard_mode(self, GtkLayerShell.KeyboardMode.ON_DEMAND)
        top, bottom, left, right = _anchor_edges(str(cfg.get("anchor") or "top-right"))
        GtkLayerShell.set_anchor(self, GtkLayerShell.Edge.TOP, top)
        GtkLayerShell.set_anchor(self, GtkLayerShell.Edge.BOTTOM, bottom)
        GtkLayerShell.set_anchor(self, GtkLayerShell.Edge.LEFT, left)
        GtkLayerShell.set_anchor(self, GtkLayerShell.Edge.RIGHT, right)
        margin = 24
        GtkLayerShell.set_margin(self, GtkLayerShell.Edge.TOP, margin)
        GtkLayerShell.set_margin(self, GtkLayerShell.Edge.BOTTOM, margin)
        GtkLayerShell.set_margin(self, GtkLayerShell.Edge.LEFT, margin)
        GtkLayerShell.set_margin(self, GtkLayerShell.Edge.RIGHT, margin)

        self.connect("key-press-event", self._on_key)
        self.connect("map-event", self._on_map)
        self.connect("destroy", lambda *_: Gtk.main_quit())

        self._dismissed = False

        # Auto-dismiss timer.
        try:
            timeout_ms = int(cfg.get("timeout_ms") or 12000)
        except (TypeError, ValueError):
            timeout_ms = 12000
        if timeout_ms > 0:
            GLib.timeout_add(timeout_ms, self._dismiss)

        # Best-effort sound for active / timeSensitive priorities.
        if cfg.get("play_sound"):
            _play_sound(str(cfg.get("sound") or "message"))

    def _on_map(self, *_):
        sys.stderr.write("notify-overlay ready\n")
        sys.stderr.flush()
        return False

    def _on_key(self, _w, event):
        if event.keyval == Gdk.KEY_Escape:
            self._dismiss()
        return False

    def _dismiss(self, *_):
        if self._dismissed:
            return False
        self._dismissed = True
        try:
            self.destroy()
        except Exception:  # noqa: BLE001
            Gtk.main_quit()
        return False  # don't repeat the timeout


def _play_sound(event_id: str) -> None:
    for cmd in (["canberra-gtk-play", "-i", event_id], ["paplay", "/usr/share/sounds/freedesktop/stereo/message.oga"]):
        try:
            subprocess.Popen(
                cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
            )
            return
        except (FileNotFoundError, OSError):
            continue


def main() -> None:
    cfg = _load_config()
    NotifyWindow(cfg).show_all()
    Gtk.main()


if __name__ == "__main__":
    main()
