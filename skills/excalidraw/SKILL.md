# Excalidraw MCP Skill

AI-powered diagramming with full Excalidraw canvas control.

## 🎯 BEST PRACTICE: Rectangle Connectors for Clean Diagrams

**Arrows are unreliable. Use thin rectangles as connector lines instead!**

This produces **perfectly straight, predictable lines** every time:

```json
{
  "elements": [
    // Shapes
    {"id": "master", "type": "rectangle", "x": 350, "y": 100, "width": 300, "height": 100, "backgroundColor": "#1e3a5f", "strokeColor": "#3b82f6"},
    {"id": "sat1", "type": "rectangle", "x": 130, "y": 300, "width": 180, "height": 70, "backgroundColor": "#1f2937", "strokeColor": "#6b7280"},
    {"id": "sat2", "type": "rectangle", "x": 410, "y": 300, "width": 180, "height": 70, "backgroundColor": "#1f2937", "strokeColor": "#6b7280"},
    {"id": "sat3", "type": "rectangle", "x": 690, "y": 300, "width": 180, "height": 70, "backgroundColor": "#1f2937", "strokeColor": "#6b7280"},
    
    // Connector lines (thin rectangles)
    {"id": "trunk", "type": "rectangle", "x": 497, "y": 200, "width": 6, "height": 50, "backgroundColor": "#fbbf24", "strokeColor": "#fbbf24"},
    {"id": "h-bus", "type": "rectangle", "x": 170, "y": 247, "width": 660, "height": 6, "backgroundColor": "#fbbf24", "strokeColor": "#fbbf24"},
    {"id": "drop1", "type": "rectangle", "x": 220, "y": 247, "width": 6, "height": 53, "backgroundColor": "#fbbf24", "strokeColor": "#fbbf24"},
    {"id": "drop2", "type": "rectangle", "x": 497, "y": 247, "width": 6, "height": 53, "backgroundColor": "#fbbf24", "strokeColor": "#fbbf24"},
    {"id": "drop3", "type": "rectangle", "x": 775, "y": 247, "width": 6, "height": 53, "backgroundColor": "#fbbf24", "strokeColor": "#fbbf24"}
  ]
}
```

**Result:** Clean tree structure with trunk + horizontal bus + vertical drops.

---

## 🔑 Critical Rules for Clean Diagrams

### 1. Separate Text from Shapes

**Don't use `text` property on rectangles.** Create separate text elements:

```json
// ✅ CORRECT: Shape + separate text
{"id": "box", "type": "rectangle", "x": 100, "y": 100, "width": 200, "height": 60, "backgroundColor": "#1e3a5f", "strokeColor": "#3b82f6", "strokeWidth": 2},
{"id": "box-txt", "type": "text", "x": 100, "y": 115, "width": 200, "height": 30, "text": "My Label", "fontSize": 14, "textAlign": "center", "strokeColor": "#ffffff"}

// ❌ WRONG: text property on rectangle (often doesn't render properly)
{"id": "box", "type": "rectangle", "text": "My Label", ...}
```

### 2. Always Use White Text on Dark Backgrounds

```json
{"type": "text", "strokeColor": "#ffffff", ...}  // White text
```

**Color palette for dark backgrounds:**
- Text on dark shapes: `#ffffff` (white)
- Text on light backgrounds: `#374151` (dark gray)
- Accent text (titles): `#fbbf24` (gold) or `#1e40af` (blue)
- Subdued text (captions): `#a5b4fc` (light purple)

### 3. Clear Canvas Before New Diagrams

Use browser automation to click "Clear Canvas" button, or create fresh elements that replace old ones.

```powershell
# Via browser automation
browser action=act request='{"kind": "click", "ref": "Clear Canvas button"}'
```

### 4. Batch Create Everything

Always create all elements in ONE request:

```powershell
$body = @{
    elements = @(
        @{id="shape1"; ...},
        @{id="shape1-txt"; ...},
        @{id="shape2"; ...},
        @{id="connector"; ...}
    )
} | ConvertTo-Json -Depth 5

Invoke-RestMethod -Uri "http://localhost:3000/api/elements/batch" -Method POST -Body $body -ContentType "application/json"
```

---

## 📐 Layout Patterns

### Tree/Hierarchy Pattern

```
        ┌─────────┐
        │  ROOT   │
        └────┬────┘
             │ (trunk - vertical rectangle)
    ═════════╧═════════ (horizontal bus)
    │        │        │ (drops - vertical rectangles)
┌───┴───┐┌───┴───┐┌───┴───┐
│ LEAF1 ││ LEAF2 ││ LEAF3 │
└───────┘└───────┘└───────┘
```

**Implementation:**
```json
// Trunk (vertical line from root down)
{"id": "trunk", "type": "rectangle", "x": 497, "y": 200, "width": 6, "height": 50, "backgroundColor": "#fbbf24"}

// Horizontal bus
{"id": "h-bus", "type": "rectangle", "x": 170, "y": 247, "width": 660, "height": 6, "backgroundColor": "#fbbf24"}

// Drops to each leaf (position x at center of each leaf box)
{"id": "drop1", "type": "rectangle", "x": 220, "y": 247, "width": 6, "height": 53, "backgroundColor": "#fbbf24"}
{"id": "drop2", "type": "rectangle", "x": 497, "y": 247, "width": 6, "height": 53, "backgroundColor": "#fbbf24"}
{"id": "drop3", "type": "rectangle", "x": 775, "y": 247, "width": 6, "height": 53, "backgroundColor": "#fbbf24"}
```

### Flow/Pipeline Pattern

```
┌────┐    ┌────┐    ┌────┐    ┌────┐
│ A  │════│ B  │════│ C  │════│ D  │
└────┘    └────┘    └────┘    └────┘
```

**Implementation:**
```json
// Boxes at same Y, increasing X
{"id": "a", "type": "rectangle", "x": 100, "y": 200, "width": 100, "height": 60, ...}
{"id": "b", "type": "rectangle", "x": 250, "y": 200, "width": 100, "height": 60, ...}
{"id": "c", "type": "rectangle", "x": 400, "y": 200, "width": 100, "height": 60, ...}

// Horizontal connectors between boxes
{"id": "conn-ab", "type": "rectangle", "x": 200, "y": 227, "width": 50, "height": 6, "backgroundColor": "#fbbf24"}
{"id": "conn-bc", "type": "rectangle", "x": 350, "y": 227, "width": 50, "height": 6, "backgroundColor": "#fbbf24"}
```

### Grid/Matrix Pattern

For capability matrices or comparison tables, use aligned rectangles:

```json
// Headers row
{"id": "h1", "type": "rectangle", "x": 150, "y": 100, "width": 100, "height": 40, ...}
{"id": "h2", "type": "rectangle", "x": 260, "y": 100, "width": 100, "height": 40, ...}
{"id": "h3", "type": "rectangle", "x": 370, "y": 100, "width": 100, "height": 40, ...}

// Data rows (same widths, consistent Y spacing)
{"id": "r1c1", "type": "rectangle", "x": 150, "y": 150, "width": 100, "height": 30, ...}
{"id": "r1c2", "type": "rectangle", "x": 260, "y": 150, "width": 100, "height": 30, ...}
// etc.
```

---

## 🎨 Recommended Color Palettes

### Dark Theme (Professional)

| Use | Background | Stroke | Text |
|-----|------------|--------|------|
| Primary box | `#1e3a5f` | `#3b82f6` | `#ffffff` |
| Secondary box | `#1f2937` | `#6b7280` | `#ffffff` |
| Accent (services) | `#7c3aed` | `#a78bfa` | `#ffffff` |
| Success/Sync | `#059669` | `#34d399` | `#ffffff` |
| Warning/Events | `#dc2626` | `#f87171` | `#ffffff` |
| Connector lines | `#fbbf24` | `#fbbf24` | — |
| UI elements | `#0f766e` | `#2dd4bf` | `#ffffff` |
| Info cards | `#312e81` | `#6366f1` | `#ffffff` |

### Connector Colors

| Meaning | Color |
|---------|-------|
| Data/Task routing | `#fbbf24` (gold) |
| Event broadcast | `#22c55e` (green) |
| Sync/Real-time | `#60a5fa` (blue) |
| Error/Warning | `#ef4444` (red) |

---

## 📋 Complete Example: Architecture Diagram

```powershell
$body = @{
    elements = @(
        # ===== TITLE =====
        @{id="title"; type="text"; x=350; y=40; width=300; height=40; text="SYSTEM ARCHITECTURE"; fontSize=28; textAlign="center"; strokeColor="#1e40af"; fontFamily=1}
        
        # ===== MASTER NODE =====
        @{id="master"; type="rectangle"; x=350; y=100; width=300; height=120; backgroundColor="#1e3a5f"; strokeColor="#3b82f6"; strokeWidth=3}
        @{id="master-lbl"; type="text"; x=400; y=110; width=200; height=22; text="MASTER NODE"; fontSize=16; textAlign="center"; strokeColor="#ffffff"}
        
        # Components inside master
        @{id="gw"; type="rectangle"; x=380; y=145; width=240; height=35; backgroundColor="#1e40af"; strokeColor="#60a5fa"; strokeWidth=2}
        @{id="gw-txt"; type="text"; x=380; y=152; width=240; height=20; text="Gateway"; fontSize=12; textAlign="center"; strokeColor="#ffffff"}
        
        @{id="svc"; type="rectangle"; x=380; y=190; width=240; height=25; backgroundColor="#059669"; strokeColor="#34d399"; strokeWidth=2}
        @{id="svc-txt"; type="text"; x=380; y=195; width=240; height=16; text="Services"; fontSize=10; textAlign="center"; strokeColor="#ffffff"}
        
        # ===== CONNECTOR LINES =====
        @{id="trunk"; type="rectangle"; x=497; y=220; width=6; height=40; backgroundColor="#fbbf24"; strokeColor="#fbbf24"}
        @{id="h-bus"; type="rectangle"; x=170; y=257; width=660; height=6; backgroundColor="#fbbf24"; strokeColor="#fbbf24"}
        @{id="drop1"; type="rectangle"; x=220; y=257; width=6; height=43; backgroundColor="#fbbf24"; strokeColor="#fbbf24"}
        @{id="drop2"; type="rectangle"; x=497; y=257; width=6; height=43; backgroundColor="#fbbf24"; strokeColor="#fbbf24"}
        @{id="drop3"; type="rectangle"; x=775; y=257; width=6; height=43; backgroundColor="#fbbf24"; strokeColor="#fbbf24"}
        
        # ===== SATELLITE NODES =====
        @{id="sat1"; type="rectangle"; x=130; y=300; width=180; height=60; backgroundColor="#1f2937"; strokeColor="#6b7280"; strokeWidth=2}
        @{id="sat1-lbl"; type="text"; x=145; y=310; width=150; height=18; text="Node 1"; fontSize=13; textAlign="center"; strokeColor="#ffffff"}
        @{id="sat1-cap"; type="text"; x=145; y=335; width=150; height=14; text="Capability A"; fontSize=10; textAlign="center"; strokeColor="#a5b4fc"}
        
        @{id="sat2"; type="rectangle"; x=410; y=300; width=180; height=60; backgroundColor="#1f2937"; strokeColor="#6b7280"; strokeWidth=2}
        @{id="sat2-lbl"; type="text"; x=425; y=310; width=150; height=18; text="Node 2"; fontSize=13; textAlign="center"; strokeColor="#ffffff"}
        @{id="sat2-cap"; type="text"; x=425; y=335; width=150; height=14; text="Capability B"; fontSize=10; textAlign="center"; strokeColor="#a5b4fc"}
        
        @{id="sat3"; type="rectangle"; x=690; y=300; width=180; height=60; backgroundColor="#1f2937"; strokeColor="#6b7280"; strokeWidth=2}
        @{id="sat3-lbl"; type="text"; x=705; y=310; width=150; height=18; text="Node 3"; fontSize=13; textAlign="center"; strokeColor="#ffffff"}
        @{id="sat3-cap"; type="text"; x=705; y=335; width=150; height=14; text="Capability C"; fontSize=10; textAlign="center"; strokeColor="#a5b4fc"}
        
        # ===== LEGEND =====
        @{id="leg-title"; type="text"; x=130; y=400; width=100; height=18; text="LEGEND"; fontSize=14; textAlign="left"; strokeColor="#fbbf24"}
        @{id="l1"; type="rectangle"; x=130; y=425; width=14; height=14; backgroundColor="#fbbf24"; strokeColor="#fbbf24"}
        @{id="l1-txt"; type="text"; x=150; y=425; width=100; height=14; text="Data Flow"; fontSize=10; strokeColor="#374151"}
        @{id="l2"; type="rectangle"; x=260; y=425; width=14; height=14; backgroundColor="#1e3a5f"; strokeColor="#3b82f6"}
        @{id="l2-txt"; type="text"; x=280; y=425; width=80; height=14; text="Master"; fontSize=10; strokeColor="#374151"}
        @{id="l3"; type="rectangle"; x=370; y=425; width=14; height=14; backgroundColor="#1f2937"; strokeColor="#6b7280"}
        @{id="l3-txt"; type="text"; x=390; y=425; width=80; height=14; text="Node"; fontSize=10; strokeColor="#374151"}
    )
} | ConvertTo-Json -Depth 5

Invoke-RestMethod -Uri "http://localhost:3000/api/elements/batch" -Method POST -Body $body -ContentType "application/json"
```

---

## Overview

This skill integrates the mcp_excalidraw server with InfiniBot, providing 26 MCP tools for creating, editing, and managing Excalidraw diagrams.

## Architecture

```
Agent ↔ MCP Server (stdio) ↔ Canvas Server (Docker :3000)
                                      ↓
                              WebUI / Remote Access
```

## Components

### Canvas Server (Docker)
- Container: `ghcr.io/yctimlin/mcp_excalidraw-canvas:latest`
- Port: 3000
- Live Excalidraw UI with real-time sync

### MCP Server
- Location: `<workspace>/mcp_excalidraw/dist/index.js`
- Transport: stdio
- Environment: `EXPRESS_SERVER_URL=http://localhost:3000`

## Available Tools (26 Total)

### Element Operations
- `create_element` — Create rectangle, ellipse, diamond, line, arrow, text, freedraw
- `create_elements` — Batch create multiple elements
- `get_element` — Get element by ID
- `update_element` — Update element properties
- `delete_element` — Delete element by ID
- `duplicate_elements` — Copy elements

### Canvas Operations
- `clear_canvas` — Clear all elements
- `describe_scene` — Get structured text description (for AI feedback loop)
- `get_canvas_screenshot` — Screenshot for visual inspection

### Layout Tools
- `align_elements` — Align elements (left, center, right, top, middle, bottom)
- `distribute_elements` — Distribute elements evenly
- `group_elements` — Group elements
- `ungroup_elements` — Ungroup elements

### Mermaid Integration
- `create_from_mermaid` — Convert Mermaid diagram to Excalidraw

### File I/O
- `export_scene` — Export to .excalidraw JSON
- `import_scene` — Import from .excalidraw JSON
- `export_to_image` — Export to PNG/SVG
- `export_to_excalidraw_url` — Get shareable excalidraw.com URL

### State Management
- `snapshot_scene` — Save named snapshot
- `restore_snapshot` — Restore from snapshot

### Viewport
- `set_viewport` — Zoom, scroll, center on element

### Documentation
- `read_diagram_guide` — Best practices for AI diagramming

## Usage

### Starting the Services

```powershell
# 1. Start Canvas Server (if not running)
docker start mcp-excalidraw-canvas

# 2. Canvas available at http://localhost:3000
```

### Remote Access (Cloudflare Tunnel)

```powershell
cloudflared tunnel --url http://localhost:3000
# Returns: https://xxx.trycloudflare.com
```

### REST API Endpoints

```powershell
# Batch create elements (PRIMARY METHOD)
Invoke-RestMethod -Uri "http://localhost:3000/api/elements/batch" -Method POST -Body $jsonBody -ContentType "application/json"

# Get all elements
Invoke-RestMethod -Uri "http://localhost:3000/api/elements" -Method GET

# Create single element
Invoke-RestMethod -Uri "http://localhost:3000/api/elements" -Method POST -Body $element -ContentType "application/json"
```

## Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `EXPRESS_SERVER_URL` | Canvas server URL | `http://localhost:3000` |
| `ENABLE_CANVAS_SYNC` | Real-time sync | `true` |

### Claude Code / InfiniBot MCP Config

Add to `~/.claude/mcp.json` or equivalent:

```json
{
  "mcpServers": {
    "excalidraw": {
      "command": "node",
      "args": ["<workspace>/mcp_excalidraw/dist/index.js"],
      "env": {
        "EXPRESS_SERVER_URL": "http://localhost:3000",
        "ENABLE_CANVAS_SYNC": "true"
      }
    }
  }
}
```

---

## ⚠️ When Arrows ARE Needed

If you must use arrows (for arrowheads), use bound arrows with explicit side connections:

```json
{
  "elements": [
    {"id": "box1", "type": "rectangle", "x": 100, "y": 100, "width": 150, "height": 80},
    {"id": "box2", "type": "rectangle", "x": 100, "y": 300, "width": 150, "height": 80},
    {"type": "arrow", "x": 0, "y": 0, "start": {"id": "box1", "side": "bottom"}, "end": {"id": "box2", "side": "top"}}
  ]
}
```

**Key points:**
- All elements in ONE batch request
- Use `start`/`end` with `{id, side}` for precise binding
- Set arrow `x`, `y` to `0, 0` — server calculates position
- Valid sides: `"top"`, `"bottom"`, `"left"`, `"right"`

---

## Troubleshooting

### Canvas not loading
```powershell
docker ps | Select-String excalidraw
# If not running:
docker start mcp-excalidraw-canvas
```

### Elements not appearing
- Check JSON depth: use `ConvertTo-Json -Depth 5` for nested objects
- Verify `Content-Type: application/json` header
- Check element coordinates are reasonable (visible in viewport)

### Text not visible
- Ensure `strokeColor: "#ffffff"` for dark backgrounds
- Separate text elements from shapes
- Verify fontSize is large enough (10-16 for labels, 20+ for titles)

### Lines not straight
- **Don't use arrows** — use thin rectangles as connector lines
- Ensure width=6 for horizontal lines, height=6 for vertical lines
- Align connector coordinates with shape centers

---

## Quick Reference

| Task | Method |
|------|--------|
| Create diagram | `POST /api/elements/batch` with all elements |
| Clear canvas | Click "Clear Canvas" button via browser |
| View diagram | `http://localhost:3000` or tunnel URL |
| Take screenshot | Browser screenshot tool |
| Export PNG | `export_to_image` MCP tool |

---

🎨 Happy diagramming!
