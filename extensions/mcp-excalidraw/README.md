# InfiniBot Excalidraw MCP

Stdio MCP server that gives agents full control of the Control UI's
Excalidraw canvas. Replaces the old `mcp_excalidraw` + Express setup
with a single Node process that talks to the InfiniBot gateway over
WebSocket — the gateway broadcasts each canvas mutation to every
connected Control UI client.

## Architecture

```
agent ──tool call──► mcp-excalidraw (stdio MCP)
                          │
                          │ canvas.update / canvas.view / canvas.clear
                          ▼
                    InfiniBot gateway
                          │
                          │ event: canvas.update
                          ▼
                    Control UI ──dispatchEvent──► Excalidraw React canvas
```

No Express server, no port 3000, no second process. The MCP holds the
in-memory scene; the gateway is a pass-through broadcaster; the UI
already listens for the `excalidraw-update` DOM event.

## Build

```bash
pnpm --filter @infinibot/mcp-excalidraw build
```

Produces `extensions/mcp-excalidraw/dist/index.js`.

## Wire it into Claude Code (or any MCP client)

Add to `~/.claude/mcp.json` (or InfiniBot config's `mcpServers` block):

```json
{
  "mcpServers": {
    "excalidraw": {
      "command": "node",
      "args": ["./extensions/mcp-excalidraw/dist/index.js"],
      "env": {
        "INFINIBOT_GATEWAY_URL": "ws://127.0.0.1:18789",
        "INFINIBOT_GATEWAY_PASSWORD": "your-gateway-password"
      }
    }
  }
}
```

For token-auth gateways, use `INFINIBOT_GATEWAY_TOKEN` instead.

## Tool surface (20 tools)

### Read
- `get_scene` — full element list
- `get_element` — single element by id
- `query_elements` — filter by type / groupId / containerId / text contains

### Create
- `create_element` — single element (any of: rectangle, ellipse, diamond, line, arrow, text, freedraw, image, frame)
- `create_batch` — many elements in one undo step

### Update
- `update_element` — patch one element by id
- `update_batch` — patch many

### Delete
- `delete_elements` — by id list
- `clear_canvas` — drop everything

### Arrange (z-order + grouping)
- `bring_to_front`, `send_to_back`, `bring_forward`, `send_backward`
- `group_elements`, `ungroup_elements`

### View
- `fit_to_content` — zoom + pan to show every element
- `scroll_to` — scroll the viewport to a specific element id
- `set_zoom` — zoom level (1 = 100%)

### IO
- `export_scene` — full JSON in Excalidraw's native save format
- `import_scene` — replace canvas from saved JSON

## Element defaults

Every shape / text / arrow gets sensible defaults so a one-line call
produces something visible. Override any field via the tool args:

```jsonc
// Minimal — uses defaults for everything else
create_element({ "type": "rectangle", "x": 100, "y": 100 })

// Full control
create_element({
  "type": "rectangle",
  "x": 100, "y": 100, "width": 240, "height": 80,
  "backgroundColor": "#1e3a5f",
  "strokeColor": "#3b82f6",
  "strokeWidth": 2,
  "roughness": 0
})
```

## Best practices (from `skills/excalidraw/SKILL.md`)

- **Use `create_batch` for diagrams** — Excalidraw renders the batch as one undo step.
- **Connector lines: use thin rectangles** instead of arrows for clean
  straight lines. `{type: "rectangle", width: 6, height: 50, ...}`
  produces a vertical drop; flip the dimensions for a horizontal bus.
- **Separate text from shapes** — create the rectangle and the text as
  two elements, don't try to put text inside a shape's properties.
- **Bind arrows by id + side** when you need actual arrowheads:
  `{type: "arrow", x: 0, y: 0, startBinding: {elementId: "box1"}, endBinding: {elementId: "box2"}}`.

## Environment variables

| Var | Default | Purpose |
|---|---|---|
| `INFINIBOT_GATEWAY_URL` | `ws://127.0.0.1:18789` | Gateway WS endpoint |
| `INFINIBOT_GATEWAY_TOKEN` | — | Gateway auth token (token-mode gateways) |
| `INFINIBOT_GATEWAY_PASSWORD` | — | Gateway password (password-mode gateways) |
| `MCP_EXCALIDRAW_VERBOSE` | — | Set to `1` for chatty stderr logging |

## State semantics

- Canvas state lives **in the MCP process** (in-memory). Restarting the
  MCP clears it. Operators who want persistence call `export_scene` and
  save the JSON; restore via `import_scene`.
- Every mutation broadcasts the **full scene** to the gateway. The UI
  applies the new scene with `excalidrawAPI.updateScene({elements})`.
  No diff replay — Excalidraw doesn't expose an incremental-apply API.
- The gateway connection auto-reconnects with exponential backoff
  (capped at 5s). Updates while the gateway is down are queued
  (max 200) and replayed on reconnect.
