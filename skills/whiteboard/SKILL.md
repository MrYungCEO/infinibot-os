# Whiteboard Skill — Excalidraw Canvas

Draw diagrams, flowcharts, mind maps, and freeform sketches on InfiniBot's live whiteboard using the Excalidraw MCP tools.

## When to Use

Use this skill when asked to:
- Draw a diagram, flowchart, or mind map
- Sketch UI wireframes
- Create visual explanations on the canvas
- Annotate or update the whiteboard
- Clear or reset the canvas

## Architecture

```
Agent calls mcp__infinibot__excalidraw_*
        ↓
extensions/mcp-excalidraw (holds in-memory scene)
        ↓ canvas.update broadcast
Gateway → app-gateway.ts → excalidraw-update DOM event
        ↓
Whiteboard page (/whiteboard tab) — live React Excalidraw canvas updates instantly
```

Changes appear immediately on the operator's whiteboard view. No reload needed.

## Quickstart

### Draw a simple rectangle
```
mcp__infinibot__excalidraw_create_element({
  type: "rectangle",
  x: 100,
  y: 100,
  width: 200,
  height: 100,
  strokeColor: "#6366f1",
  backgroundColor: "#1a1a3e",
  fillStyle: "solid",
  roughness: 0
})
```

### Create multiple elements at once (preferred for complex diagrams)
```
mcp__infinibot__excalidraw_create_batch({
  elements: [
    { type: "rectangle", x: 100, y: 100, width: 150, height: 60, id: "box1", strokeColor: "#6366f1", fillStyle: "solid", roughness: 0 },
    { type: "text", x: 130, y: 120, text: "Start", fontSize: 18, fontFamily: 1, id: "txt1" },
    { type: "arrow", x: 175, y: 160, width: 0, height: 60, strokeColor: "#6366f1", id: "arr1" }
  ]
})
```

## Element Types

| Type | Required Fields | Notes |
|------|----------------|-------|
| `rectangle` | x, y, width, height | Use roughness: 0 for clean edges |
| `ellipse` | x, y, width, height | Circles: equal width/height |
| `diamond` | x, y, width, height | Good for decisions in flowcharts |
| `text` | x, y, text | fontSize 14–24, fontFamily 1 (Virgil) |
| `arrow` | x, y, width, height | width=0 for vertical, height=0 for horizontal |
| `line` | x, y, width, height | Like arrow but no arrowhead |
| `freedraw` | x, y, points | Array of [x,y] point pairs |
| `frame` | x, y, width, height | Groups visual area; label with `name` |

## Coordinate System

- Origin (0, 0) is top-left
- X increases right, Y increases down
- Typical canvas workspace: 0–1200 x 0–900
- Shapes are positioned by their top-left corner
- For text: x,y is baseline-left of the text

## Styling Properties

```typescript
{
  strokeColor: "#6366f1",        // Border color (hex)
  backgroundColor: "#1a1a3e",    // Fill color
  fillStyle: "solid",            // "solid" | "hachure" | "cross-hatch" | "dots" | "zigzag"
  strokeWidth: 2,                // 1 | 2 | 4
  strokeStyle: "solid",          // "solid" | "dashed" | "dotted"
  roughness: 0,                  // 0 = clean, 1 = hand-drawn, 2 = very rough
  opacity: 100,                  // 0–100
}
```

## Recommended Color Palette

```
Primary/indigo: #6366f1
Success/green:  #10b981
Warning/amber:  #f59e0b
Error/red:      #ef4444
Info/blue:      #3b82f6
Pink:           #ec4899
Dark bg:        #1a1a3e  (rectangles)
Darker bg:      #0f0f1a  (panels)
```

## Scene Management

### Clear the canvas
```
mcp__infinibot__excalidraw_clear_canvas({})
```

### Get all current elements
```
mcp__infinibot__excalidraw_get_scene({})
```

### Fit view to all content
```
mcp__infinibot__excalidraw_fit_to_content({})
```

### Update a specific element
```
mcp__infinibot__excalidraw_update_element({
  id: "my-element-id",
  strokeColor: "#10b981",
  text: "Updated label"
})
```

### Delete specific elements
```
mcp__infinibot__excalidraw_delete_elements({ ids: ["id1", "id2"] })
```

## Complete Flowchart Example

```
mcp__infinibot__excalidraw_clear_canvas({})

mcp__infinibot__excalidraw_create_batch({
  elements: [
    // Start box
    { type: "rectangle", id: "start", x: 300, y: 50, width: 160, height: 55, strokeColor: "#10b981", backgroundColor: "#1a2e2a", fillStyle: "solid", roughness: 0, strokeWidth: 2 },
    { type: "text", id: "start-lbl", x: 360, y: 68, text: "Start", fontSize: 18, fontFamily: 1 },
    
    // Arrow down
    { type: "arrow", id: "a1", x: 380, y: 105, width: 0, height: 60, strokeColor: "#888", strokeWidth: 2 },
    
    // Process box
    { type: "rectangle", id: "proc", x: 280, y: 165, width: 200, height: 55, strokeColor: "#6366f1", backgroundColor: "#1a1a3e", fillStyle: "solid", roughness: 0, strokeWidth: 2 },
    { type: "text", id: "proc-lbl", x: 330, y: 183, text: "Process", fontSize: 18, fontFamily: 1 },
    
    // Arrow down
    { type: "arrow", id: "a2", x: 380, y: 220, width: 0, height: 60, strokeColor: "#888", strokeWidth: 2 },
    
    // Decision diamond
    { type: "diamond", id: "dec", x: 280, y: 280, width: 200, height: 80, strokeColor: "#f59e0b", backgroundColor: "#2a2a1e", fillStyle: "solid", roughness: 0, strokeWidth: 2 },
    { type: "text", id: "dec-lbl", x: 345, y: 310, text: "Done?", fontSize: 16, fontFamily: 1 },
    
    // Yes arrow → End
    { type: "arrow", id: "a3", x: 380, y: 360, width: 0, height: 60, strokeColor: "#10b981", strokeWidth: 2 },
    { type: "text", id: "a3-lbl", x: 385, y: 382, text: "Yes", fontSize: 13, fontFamily: 1 },
    
    // End box
    { type: "rectangle", id: "end", x: 300, y: 420, width: 160, height: 55, strokeColor: "#ef4444", backgroundColor: "#2a1a1a", fillStyle: "solid", roughness: 0, strokeWidth: 2 },
    { type: "text", id: "end-lbl", x: 365, y: 438, text: "End", fontSize: 18, fontFamily: 1 }
  ]
})

mcp__infinibot__excalidraw_fit_to_content({})
```

## Tips

1. **Always call `clear_canvas` before drawing a new diagram** unless you're adding to an existing one.
2. **Use `create_batch` for multi-element diagrams** — one network call is faster than many.
3. **Use explicit `id` fields** so you can update or delete specific elements later.
4. **Call `fit_to_content` after drawing** so the operator can see the full diagram.
5. **Use `roughness: 0` for professional-looking diagrams**, `roughness: 1` for sketch feel.
6. **Arrow direction**: width=0 means vertical arrow (straight down), height=0 means horizontal.

## Querying Elements

```
// Find all rectangles
mcp__infinibot__excalidraw_query_elements({ type: "rectangle" })

// Get a specific element
mcp__infinibot__excalidraw_get_element({ id: "my-id" })

// Get the whole scene
mcp__infinibot__excalidraw_get_scene({})
```

## Arrangement Tools

```
mcp__infinibot__excalidraw_bring_to_front({ ids: ["id1"] })
mcp__infinibot__excalidraw_send_to_back({ ids: ["id2"] })
mcp__infinibot__excalidraw_group_elements({ ids: ["id1", "id2", "id3"] })
```

## Notes

- The whiteboard uses a **singleton canvas** — only one React root at a time. If both the floating overlay and the `/whiteboard` tab are open, they share the same canvas state but the visible one is whichever was mounted last.
- Changes are **live** — operators see updates immediately as you call tools.
- The canvas agent panel on the `/whiteboard` page uses the `canvas` agent (via `sessions.spawn`). When responding to a prompt in that panel, this skill applies.
