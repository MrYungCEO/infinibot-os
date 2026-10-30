#!/usr/bin/env python3
"""InfiniBot overlay daemon.

Renders layer-shell surfaces on Wayland (Hyprland) for window-pick badges and
visual highlights (panels, regions, waybar modules). Listens on a Unix socket
for JSON commands, one per line.

Protocol (each line is a JSON object):
  {"op":"ping"}
  {"op":"add_highlight","id":"h1","geometry":{"x":0,"y":0,"width":100,"height":50},"style":{"type":"ring","color":"#fbbf24","thickness":4,"label":"hello"}}
  {"op":"clear_highlight","id":"h1"}
  {"op":"clear_all"}
  {"op":"enter_pick_mode","windows":[{"id":"1","label":"1","geometry":{"x":..,"y":..,"width":..,"height":..}},...]}
  {"op":"exit_pick_mode"}
  {"op":"shutdown"}

Each command response is one line of JSON: {"ok":true,...} or {"ok":false,"error":"..."}.

Requires:
  - python3-gi (PyGObject)
  - python3-gi-cairo
  - gir1.2-gtklayershell-0.1   (Debian/Ubuntu)  OR  gtk-layer-shell  (Arch)
  - gir1.2-gtk-3.0

If gtk-layer-shell typelib is missing, the daemon exits with code 2 and a
clear hint pointing at the install command for the host distro. The
TypeScript-side overlay client treats exit code 2 as "install required" and
returns a structured error to the agent.
"""

from __future__ import annotations

import json
import os
import socket
import sys
import threading
from dataclasses import dataclass
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


# -- per-highlight surface --------------------------------------------------

@dataclass
class HighlightStyle:
    style_type: str  # "ring" | "fill" | "label" | "pulse"
    color: str = "#fbbf24"  # InfiniBot Gold — matches the rest of the HUD theme
    thickness: int = 4
    label: Optional[str] = None
    fill_alpha: float = 0.15
    # Where the label/badge sits when label is set. "corner" puts a compact
    # pill in the top-left of the target — good for numbered pickers because
    # it doesn't cover content. "center" is the legacy full-overlay caption,
    # used when the highlight IS a label primarily (kind="label" tools).
    badge_position: str = "corner"
    # Style of the badge container. "pill" = rounded glass + gradient stroke
    # (InfiniBot premium look). "flat" = the old translucent rectangle.
    badge_style: str = "pill"


class HighlightWindow(Gtk.Window):
    """A click-through layer-shell window painted at an absolute geometry."""

    def __init__(self, hid: str, geometry: dict, style: HighlightStyle, monitor_name: Optional[str] = None, monitor_origin: Optional[tuple] = None):
        super().__init__(type=Gtk.WindowType.TOPLEVEL)
        self.hid = hid
        self.geometry_dict = geometry
        self.style = style
        self.monitor_name = monitor_name
        self.monitor_origin = monitor_origin

        self.set_app_paintable(True)
        self.set_decorated(False)
        self.set_resizable(False)
        self.set_accept_focus(False)

        screen = self.get_screen()
        visual = screen.get_rgba_visual()
        if visual is not None:
            self.set_visual(visual)

        # Layer-shell config: top layer, anchor top+left, position via margin.
        GtkLayerShell.init_for_window(self)
        GtkLayerShell.set_layer(self, GtkLayerShell.Layer.OVERLAY)
        # Pin the surface to its target monitor BEFORE the first commit so
        # the compositor places it on the right output. Without this every
        # surface defaults to the focused output and the margins (which are
        # per-output) land off-screen for windows on other monitors.
        if monitor_name or monitor_origin:
            gdk_mon = _find_gdk_monitor(name=monitor_name, origin=monitor_origin)
            if gdk_mon is not None:
                GtkLayerShell.set_monitor(self, gdk_mon)
        GtkLayerShell.set_anchor(self, GtkLayerShell.Edge.TOP, True)
        GtkLayerShell.set_anchor(self, GtkLayerShell.Edge.LEFT, True)
        GtkLayerShell.set_margin(self, GtkLayerShell.Edge.TOP, int(geometry["y"]))
        GtkLayerShell.set_margin(self, GtkLayerShell.Edge.LEFT, int(geometry["x"]))
        # Click-through: empty input region.
        GtkLayerShell.set_keyboard_mode(self, GtkLayerShell.KeyboardMode.NONE)

        self.set_size_request(int(geometry["width"]), int(geometry["height"]))

        self.connect("realize", self._on_realize)
        self.connect("draw", self._on_draw)

    def _on_realize(self, *_):
        # Make the input region empty so every click + motion event passes
        # straight through to the windows underneath. The right shape is
        # an empty cairo.Region — Gdk.Region() (the GTK2 API) doesn't
        # exist anymore and pre-GTK3 code that passes None just leaves the
        # default opaque region in place, which is what was eating mouse
        # events and "glitching" the cursor.
        win = self.get_window()
        if win is None:
            return
        import cairo  # type: ignore
        # Click-through: combine an empty input region. PyGObject's
        # introspection for `Gdk.Window.input_shape_combine_region` has
        # mismatched signatures across versions, so try the modern 3-arg
        # form first and fall back to the 1-arg variant. We also call
        # `input_shape_combine_mask(None, 0, 0)` so any prior mask-based
        # state is reset.
        empty = cairo.Region()
        for call in (
            lambda: win.input_shape_combine_region(empty, 0, 0),
            lambda: win.input_shape_combine_region(empty),
        ):
            try:
                call()
                break
            except Exception:
                continue
        else:
            sys.stderr.write("input_shape_combine_region: no compatible signature\n")
        # The 60×60 badge surfaces are so small that even if input shape
        # clearing didn't take, the dead zone is just the top-right corner
        # of each window — well outside where users actually click.

    def _on_draw(self, _widget, ctx):
        try:
            return self._do_draw(ctx)
        except Exception:
            import traceback
            sys.stderr.write("HighlightWindow draw error:\n" + traceback.format_exc())
            sys.stderr.flush()
            return False

    def _do_draw(self, ctx):
        import math
        w = int(self.geometry_dict["width"])
        h = int(self.geometry_dict["height"])
        r, g, b = _hex_to_rgb(self.style.color)

        # Reset to fully transparent so we composite cleanly each frame.
        ctx.set_operator(1)  # cairo.OPERATOR_SOURCE
        ctx.set_source_rgba(0, 0, 0, 0)
        ctx.paint()
        ctx.set_operator(0)  # cairo.OPERATOR_OVER

        # ── 1. Window-sized fill / ring (existing semantics) ──
        # "label" style_type skips the window-sized chrome and goes
        # straight to the badge — used by the always-on corner-circle mode
        # where we don't want to overlay the full window.
        if self.style.style_type in ("fill", "pulse"):
            ctx.set_source_rgba(r, g, b, self.style.fill_alpha)
            ctx.rectangle(0, 0, w, h)
            ctx.fill()

        if self.style.style_type in ("ring", "fill", "pulse"):
            ctx.set_source_rgba(r, g, b, 0.95)
            ctx.set_line_width(self.style.thickness)
            inset = self.style.thickness / 2.0
            ctx.rectangle(inset, inset, w - 2 * inset, h - 2 * inset)
            ctx.stroke()

        # ── 2. Numerical / text badge ──
        # The badge is the actual "panel number" you see during pick mode.
        # Two layouts:
        #   "corner" (default) — compact rounded pill anchored top-left
        #     of the target window. Won't cover what you're trying to read.
        #     Used by hyprland_pick to label every visible window.
        #   "center" — legacy full-window centered caption. Kept for the
        #     `kind="label"` highlight where the label IS the point.
        if self.style.label:
            label = self.style.label
            position = getattr(self.style, "badge_position", "corner")
            style_name = getattr(self.style, "badge_style", "pill")

            # Size scales with label length. Single/double-digit panel
            # numbers get the big stylish badge; long captions tighten.
            if len(label) <= 2:
                font_size = 30
                pad_x, pad_y = 18, 12
            elif len(label) <= 4:
                font_size = 22
                pad_x, pad_y = 14, 10
            else:
                font_size = 16
                pad_x, pad_y = 12, 8

            ctx.select_font_face("Sans", 0, 1)  # bold
            ctx.set_font_size(font_size)
            extents = ctx.text_extents(label)

            badge_w = extents.width + 2 * pad_x
            badge_h = extents.height + 2 * pad_y

            if position == "center":
                bx = (w - badge_w) / 2
                by = (h - badge_h) / 2
            else:
                # Corner placement: 14px inset from the top-left. Stays
                # readable on any window, doesn't compete with titlebars
                # at the top edge.
                bx = 14
                by = 14

            if style_name == "flat":
                # Legacy: flat translucent rectangle, gold text.
                ctx.set_source_rgba(0, 0, 0, 0.72)
                ctx.rectangle(bx, by, badge_w, badge_h)
                ctx.fill()
                ctx.set_source_rgba(r, g, b, 1.0)
                ctx.move_to(bx + pad_x - extents.x_bearing,
                            by + pad_y + extents.height - extents.height / 2 - extents.y_bearing / 2)
                ctx.show_text(label)
                return False

            if style_name == "corner_circle":
                # Compact "screen-id"-style circle anchored to a window
                # corner. Designed for an always-on reference badge so the
                # user can call out windows by id when speaking to the
                # agent. Defaults to top-right; respects badge_position
                # values "tl", "tr" (default), "bl", "br" or "center".
                pos = (getattr(self.style, "badge_position", "corner") or "tr").lower()
                # `corner` is the historical alias from pick mode and means
                # top-left; honor that for back-compat. New callers pass
                # cardinals.
                if pos == "corner":
                    pos = "tl"

                # Diameter scales with label length so 1-2 char ids fit the
                # neat 36px target, but "10"/"123" still read cleanly.
                diameter = 38 if len(label) <= 2 else 46 if len(label) <= 3 else 56
                inset = 10
                if pos == "tl":
                    cx_, cy_ = inset + diameter / 2, inset + diameter / 2
                elif pos == "tr":
                    cx_, cy_ = w - inset - diameter / 2, inset + diameter / 2
                elif pos == "bl":
                    cx_, cy_ = inset + diameter / 2, h - inset - diameter / 2
                elif pos == "br":
                    cx_, cy_ = w - inset - diameter / 2, h - inset - diameter / 2
                else:  # center
                    cx_, cy_ = w / 2, h / 2

                radius = diameter / 2

                # 1. Drop shadow (two layers for soft falloff).
                for offset, alpha in ((6, 0.22), (2, 0.40)):
                    ctx.set_source_rgba(0, 0, 0, alpha)
                    ctx.arc(cx_, cy_ + offset, radius, 0, 2 * math.pi)
                    ctx.fill()

                # 2. Glass fill — radial gradient that picks up the accent
                # color (red by default for the corner-circle mode) as a
                # warm tint at the top-left.
                fill_grad = cairo_pattern_radial(
                    ctx,
                    cx_ - radius * 0.4, cy_ - radius * 0.4, radius * 0.1,
                    cx_, cy_, radius,
                )
                fill_grad.add_color_stop_rgba(0.0, min(1, r * 1.10), g * 0.30, b * 0.30, 0.92)
                fill_grad.add_color_stop_rgba(0.7, r * 0.32, 0.04, 0.06, 0.92)
                fill_grad.add_color_stop_rgba(1.0, 0.05, 0.0, 0.0, 0.95)
                ctx.set_source(fill_grad)
                ctx.arc(cx_, cy_, radius, 0, 2 * math.pi)
                ctx.fill()

                # 3. Red gradient stroke — bright top-left to deep crimson
                # bottom-right, exactly the look the user asked for.
                stroke_grad = cairo_pattern_linear(
                    ctx,
                    cx_ - radius, cy_ - radius,
                    cx_ + radius, cy_ + radius,
                )
                stroke_grad.add_color_stop_rgba(0.0, 1.0, 0.42, 0.45, 1.0)   # rose
                stroke_grad.add_color_stop_rgba(0.5, min(1, r), g * 0.30, b * 0.32, 1.0)  # accent
                stroke_grad.add_color_stop_rgba(1.0, r * 0.55, 0.02, 0.05, 1.0)  # crimson
                ctx.set_source(stroke_grad)
                ctx.set_line_width(2.5)
                ctx.arc(cx_, cy_, radius - 1.25, 0, 2 * math.pi)
                ctx.stroke()

                # 4. Inner highlight — glossy "premium" edge.
                ctx.set_source_rgba(1, 1, 1, 0.12)
                ctx.set_line_width(1.0)
                ctx.arc(cx_, cy_, radius - 3.0, 0, 2 * math.pi)
                ctx.stroke()

                # 5. Label. Pick font size so the id sits in the middle of
                # the disc with comfortable padding even at small sizes.
                circle_font = 18 if len(label) <= 2 else 14 if len(label) <= 3 else 11
                ctx.select_font_face("Sans", 0, 1)  # bold
                ctx.set_font_size(circle_font)
                c_extents = ctx.text_extents(label)
                tx = cx_ - c_extents.width / 2 - c_extents.x_bearing
                ty = cy_ + c_extents.height / 2 - (c_extents.height + c_extents.y_bearing) / 2

                # Text drop-shadow for legibility on a busy window beneath.
                ctx.set_source_rgba(0, 0, 0, 0.65)
                ctx.move_to(tx + 1, ty + 1)
                ctx.show_text(label)
                # Bright cream-tinted text on top.
                ctx.set_source_rgba(1.0, 0.94, 0.92, 1.0)
                ctx.move_to(tx, ty)
                ctx.show_text(label)
                return False

            # InfiniBot pill: rounded rect, dark glass fill, gold gradient
            # stroke, soft drop shadow, gold text. Mirrors the .notes-glass
            # +.notes-md-body styling shipped in the notes UI rework.
            radius = min(14, badge_h / 2)

            # Drop shadow — paint twice with growing blur via stroke width.
            shadow_layers = ((6, 0.22), (3, 0.32))
            for offset, alpha in shadow_layers:
                ctx.set_source_rgba(0, 0, 0, alpha)
                _rounded_rect(ctx, bx, by + offset, badge_w, badge_h, radius)
                ctx.fill()

            # Glass fill (near-black with a faint gold cast at the top).
            grad = cairo_pattern_linear(ctx, bx, by, bx, by + badge_h)
            grad.add_color_stop_rgba(0.0, r * 0.18, g * 0.16, b * 0.10, 0.88)
            grad.add_color_stop_rgba(1.0, 0.02, 0.02, 0.04, 0.92)
            ctx.set_source(grad)
            _rounded_rect(ctx, bx, by, badge_w, badge_h, radius)
            ctx.fill()

            # Gradient stroke (gold → amber-honey) for the premium ring.
            stroke = cairo_pattern_linear(ctx, bx, by, bx + badge_w, by + badge_h)
            stroke.add_color_stop_rgba(0.0, min(1, r * 1.10), min(1, g * 1.05), min(1, b * 0.95), 1.0)
            stroke.add_color_stop_rgba(0.5, r, g, b, 1.0)
            stroke.add_color_stop_rgba(1.0, r * 0.85, g * 0.65, b * 0.45, 1.0)
            ctx.set_source(stroke)
            ctx.set_line_width(2.0)
            _rounded_rect(ctx, bx + 1, by + 1, badge_w - 2, badge_h - 2, radius - 1)
            ctx.stroke()

            # Inner highlight — a thin lighter top stroke for the "premium"
            # glossy edge you see on the rest of the InfiniBot HUD.
            ctx.set_source_rgba(1, 1, 1, 0.08)
            ctx.set_line_width(1.0)
            _rounded_rect(ctx, bx + 2, by + 2, badge_w - 4, badge_h - 4, max(1, radius - 2))
            ctx.stroke()

            # Gold text. Drop shadow first for legibility on busy windows.
            tx = bx + pad_x - extents.x_bearing
            ty = by + pad_y + extents.height - extents.y_bearing - extents.height / 2 - extents.height / 2
            # Cairo's text origin is bottom-left of the visual baseline —
            # the math above pulls the glyph cap to badge center.
            ty = by + (badge_h + extents.height) / 2 - extents.y_bearing - extents.height / 2
            ctx.set_source_rgba(0, 0, 0, 0.55)
            ctx.move_to(tx + 1, ty + 1)
            ctx.show_text(label)
            # Bright gold fill on top.
            ctx.set_source_rgba(min(1, r + 0.05), min(1, g + 0.03), min(1, b * 0.9), 1.0)
            ctx.move_to(tx, ty)
            ctx.show_text(label)

        return False


# -- overlay manager --------------------------------------------------------

def _rounded_rect(ctx, x: float, y: float, w: float, h: float, r: float) -> None:
    """Stroke/fill helper — appends a rounded-rect subpath to the current
    Cairo path. Caller decides whether to fill() or stroke() after."""
    import math
    r = max(0.0, min(r, w / 2, h / 2))
    ctx.new_sub_path()
    ctx.arc(x + w - r, y + r, r, -math.pi / 2, 0)
    ctx.arc(x + w - r, y + h - r, r, 0, math.pi / 2)
    ctx.arc(x + r, y + h - r, r, math.pi / 2, math.pi)
    ctx.arc(x + r, y + r, r, math.pi, 3 * math.pi / 2)
    ctx.close_path()


def cairo_pattern_linear(_ctx, x0: float, y0: float, x1: float, y1: float):
    """Convenience wrapper around cairo.LinearGradient via the GI bindings."""
    import cairo  # type: ignore
    return cairo.LinearGradient(x0, y0, x1, y1)


def cairo_pattern_radial(_ctx, cx0: float, cy0: float, r0: float, cx1: float, cy1: float, r1: float):
    """Convenience wrapper around cairo.RadialGradient.

    Lives at module scope so its `import cairo` runs in a clean namespace —
    inline `cairo.RadialGradient(...)` calls inside `_on_draw` hit a PyGI
    foreign-struct conversion bug on some host setups (the same code path
    that LinearGradient uses works fine when isolated like this).
    """
    import cairo  # type: ignore
    return cairo.RadialGradient(cx0, cy0, r0, cx1, cy1, r1)


def _find_gdk_monitor(name: Optional[str] = None, origin: Optional[tuple[int, int]] = None):
    """Map a Hyprland monitor reference to a GdkMonitor.

    Tries by global origin (x, y) first — most reliable because Hyprland
    output names (e.g. 'HDMI-A-5') don't match Gdk's physical model names
    (e.g. '27G1G4') on most setups, but the global placement is identical.
    Falls back to model/manufacturer string matching when no origin given.
    """
    try:
        display = Gdk.Display.get_default()
        if display is None:
            return None
        n_monitors = display.get_n_monitors()
        # Position-based match (best).
        if origin is not None:
            ox, oy = int(origin[0]), int(origin[1])
            for i in range(n_monitors):
                mon = display.get_monitor(i)
                try:
                    g = mon.get_geometry()
                except Exception:
                    continue
                if g.x == ox and g.y == oy:
                    return mon
        # Name-based fallback.
        if name:
            for i in range(n_monitors):
                mon = display.get_monitor(i)
                try:
                    model = mon.get_model()
                except Exception:
                    model = None
                try:
                    manufacturer = mon.get_manufacturer()
                except Exception:
                    manufacturer = None
                for candidate in (model, manufacturer):
                    if candidate and (candidate == name or candidate.startswith(name) or name.startswith(candidate)):
                        return mon
    except Exception:
        return None
    return None


def _hex_to_rgb(hexstr: str) -> tuple[float, float, float]:
    s = hexstr.strip().lstrip("#")
    if len(s) == 3:
        s = "".join(c * 2 for c in s)
    if len(s) != 6:
        return (0.984, 0.749, 0.141)
    try:
        return (
            int(s[0:2], 16) / 255.0,
            int(s[2:4], 16) / 255.0,
            int(s[4:6], 16) / 255.0,
        )
    except ValueError:
        return (0.984, 0.749, 0.141)


class Overlay:
    def __init__(self):
        self.windows: Dict[str, HighlightWindow] = {}
        self.pick_ids: list[str] = []
        # Persistent "always-on" window-id mode. Survives between updates
        # (managed via sync_window_ids → just diffs the visible set).
        self.window_id_active: bool = False
        self.window_id_ids: set[str] = set()

    def add(self, hid: str, geometry: dict, style: HighlightStyle, monitor: Optional[str] = None, monitor_origin: Optional[tuple] = None) -> dict:
        if hid in self.windows:
            self.remove(hid)
        win = HighlightWindow(hid, geometry, style, monitor_name=monitor, monitor_origin=monitor_origin)
        self.windows[hid] = win
        win.show_all()
        return {"ok": True, "id": hid}

    def remove(self, hid: str) -> dict:
        win = self.windows.pop(hid, None)
        if win is not None:
            win.destroy()
        return {"ok": True, "id": hid}

    def clear_all(self) -> dict:
        for hid in list(self.windows.keys()):
            self.remove(hid)
        self.pick_ids.clear()
        return {"ok": True}

    def enter_pick(self, windows: list, theme: Optional[dict] = None) -> dict:
        # Clear prior pick badges only (preserve other highlights).
        for hid in self.pick_ids:
            self.remove(hid)
        self.pick_ids = []
        # Theme defaults — InfiniBot Gold pill, top-left corner of each
        # target. Caller can override via the `theme` payload from the
        # pick tool / agent for per-call branding.
        t = theme or {}
        color = str(t.get("color", "#fbbf24"))
        thickness = int(t.get("thickness", 3))
        fill_alpha = float(t.get("fill_alpha", 0.10))
        badge_position = str(t.get("badge_position", "corner"))
        badge_style = str(t.get("badge_style", "pill"))
        for w in windows:
            hid = f"pick:{w['id']}"
            geom = w["geometry"]
            label = str(w.get("label", w["id"]))
            self.add(
                hid,
                geom,
                HighlightStyle(
                    style_type="fill",
                    color=color,
                    thickness=thickness,
                    label=label,
                    fill_alpha=fill_alpha,
                    badge_position=badge_position,
                    badge_style=badge_style,
                ),
            )
            self.pick_ids.append(hid)
        return {"ok": True, "count": len(self.pick_ids)}

    def exit_pick(self) -> dict:
        for hid in self.pick_ids:
            self.remove(hid)
        self.pick_ids = []
        return {"ok": True}

    def sync_window_ids(self, windows: list, theme: Optional[dict] = None) -> dict:
        """Persistent always-on window-id badges.

        Unlike `enter_pick`, this keeps badges across calls and only does a
        delta update: anything already shown that's still in `windows` is
        left in place (after geometry refresh); anything new is added;
        anything missing is removed. This is what the Hyprland-IPC
        subscriber calls on every openwindow/closewindow/movewindow event
        to keep the corner-circle badges in lockstep with the compositor.
        """
        t = theme or {}
        color = str(t.get("color", "#dc143c"))  # crimson default
        position = str(t.get("badge_position", "tr"))
        style_name = str(t.get("badge_style", "corner_circle"))
        thickness = int(t.get("thickness", 0))  # 0 = no window-sized ring
        fill_alpha = float(t.get("fill_alpha", 0.0))

        desired_ids = set()
        for w in windows:
            hid = f"winid:{w['id']}"
            desired_ids.add(hid)
            geom = w["geometry"]
            label = str(w.get("label", ""))
            # Per-surface color overrides the theme color. Used by the
            # frame-strip mode so each window's 4 strips can be different
            # palette hues from each other.
            surface_color = str(w.get("color", color))
            monitor = w.get("monitor")
            mon_origin = None
            if "monitor_x" in w and "monitor_y" in w:
                try:
                    mon_origin = (int(w["monitor_x"]), int(w["monitor_y"]))
                except (TypeError, ValueError):
                    mon_origin = None
            # When the caller asks for "frame_strip" each surface fills
            # itself solid (the surface IS already strip-shaped). No badge,
            # no label, just a colored rectangle. Falls back to the
            # historical corner_circle/label behavior otherwise.
            if style_name == "frame_strip":
                style_obj = HighlightStyle(
                    style_type="fill",
                    color=surface_color,
                    thickness=0,
                    label="",
                    fill_alpha=1.0,
                    badge_position=position,
                    badge_style="frame_strip",
                )
            else:
                style_obj = HighlightStyle(
                    style_type="label" if thickness == 0 else "fill",
                    color=surface_color,
                    thickness=thickness,
                    label=label,
                    fill_alpha=fill_alpha,
                    badge_position=position,
                    badge_style=style_name,
                )
            self.add(hid, geom, style_obj, monitor=monitor, monitor_origin=mon_origin)

        # Drop stale window-id badges (windows that no longer exist).
        for hid in list(self.window_id_ids):
            if hid not in desired_ids:
                self.remove(hid)
        self.window_id_ids = desired_ids
        self.window_id_active = True
        return {"ok": True, "count": len(desired_ids)}

    def exit_window_ids(self) -> dict:
        for hid in list(self.window_id_ids):
            self.remove(hid)
        self.window_id_ids = set()
        self.window_id_active = False
        return {"ok": True}


# -- socket server ---------------------------------------------------------

def socket_path() -> str:
    runtime = os.environ.get("XDG_RUNTIME_DIR") or "/tmp"
    return os.path.join(runtime, "infinibot-overlay.sock")


class Server:
    def __init__(self, overlay: Overlay):
        self.overlay = overlay
        self.path = socket_path()
        self._sock: Optional[socket.socket] = None
        self._stopping = False

    def start(self):
        try:
            os.unlink(self.path)
        except FileNotFoundError:
            pass
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock.bind(self.path)
        os.chmod(self.path, 0o600)
        sock.listen(8)
        self._sock = sock
        threading.Thread(target=self._accept_loop, daemon=True).start()
        sys.stderr.write(f"infinibot-overlay listening on {self.path}\n")

    def _accept_loop(self):
        assert self._sock is not None
        while not self._stopping:
            try:
                conn, _ = self._sock.accept()
            except OSError:
                break
            threading.Thread(target=self._client_loop, args=(conn,), daemon=True).start()

    def _client_loop(self, conn: socket.socket):
        with conn:
            buf = b""
            while not self._stopping:
                try:
                    chunk = conn.recv(4096)
                except OSError:
                    return
                if not chunk:
                    return
                buf += chunk
                while b"\n" in buf:
                    line, buf = buf.split(b"\n", 1)
                    if not line.strip():
                        continue
                    response = self._dispatch_on_main(line.decode("utf-8", errors="replace"))
                    try:
                        conn.sendall((json.dumps(response) + "\n").encode("utf-8"))
                    except OSError:
                        return

    def _dispatch_on_main(self, line: str) -> dict:
        # Run the actual GTK work on the main loop thread.
        result: Dict[str, Any] = {}
        done = threading.Event()

        def run():
            try:
                result.update(self._dispatch(line))
            except Exception as e:  # noqa: BLE001
                result.update({"ok": False, "error": str(e)})
            finally:
                done.set()
            return False

        GLib.idle_add(run)
        done.wait(timeout=5.0)
        if not done.is_set():
            return {"ok": False, "error": "timeout running on main loop"}
        return result

    def _dispatch(self, line: str) -> dict:
        try:
            msg = json.loads(line)
        except Exception as e:  # noqa: BLE001
            return {"ok": False, "error": f"invalid json: {e}"}
        op = msg.get("op")
        if op == "ping":
            return {"ok": True, "pong": True}
        if op == "shutdown":
            self.stop()
            GLib.timeout_add(50, lambda: (Gtk.main_quit(), False)[1])
            return {"ok": True}
        if op == "add_highlight":
            hid = str(msg["id"])
            geom = msg["geometry"]
            style_in = msg.get("style", {})
            style = HighlightStyle(
                style_type=str(style_in.get("type", "ring")),
                color=str(style_in.get("color", "#fbbf24")),
                thickness=int(style_in.get("thickness", 4)),
                label=style_in.get("label"),
                fill_alpha=float(style_in.get("fill_alpha", 0.15)),
            )
            return self.overlay.add(hid, geom, style)
        if op == "clear_highlight":
            return self.overlay.remove(str(msg["id"]))
        if op == "clear_all":
            return self.overlay.clear_all()
        if op == "enter_pick_mode":
            return self.overlay.enter_pick(
                msg.get("windows", []),
                theme=msg.get("theme"),
            )
        if op == "exit_pick_mode":
            return self.overlay.exit_pick()
        if op == "sync_window_ids":
            # Always-on corner-circle badges. Callers send the full window
            # list on every Hyprland window event; the daemon diffs and
            # updates surfaces in place.
            return self.overlay.sync_window_ids(
                msg.get("windows", []),
                theme=msg.get("theme"),
            )
        if op == "exit_window_ids":
            return self.overlay.exit_window_ids()
        return {"ok": False, "error": f"unknown op: {op}"}

    def stop(self):
        self._stopping = True
        if self._sock is not None:
            try:
                self._sock.close()
            finally:
                self._sock = None
        try:
            os.unlink(self.path)
        except FileNotFoundError:
            pass


def main():
    overlay = Overlay()
    server = Server(overlay)
    server.start()
    try:
        Gtk.main()
    finally:
        server.stop()


if __name__ == "__main__":
    main()
