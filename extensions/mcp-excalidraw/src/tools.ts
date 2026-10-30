/**
 * MCP tool registry — every operation an agent can perform on the
 * Excalidraw canvas.
 *
 * Coverage map:
 *   READ         get_scene, get_element, query_elements
 *   CREATE       create_element, create_batch
 *   UPDATE       update_element, update_batch
 *   DELETE       delete_elements, clear_canvas
 *   ARRANGE      bring_to_front, send_to_back, bring_forward, send_backward,
 *                group_elements, ungroup_elements
 *   VIEW         fit_to_content, scroll_to, set_zoom
 *   IO           export_scene, import_scene
 *
 * 18 tools, every Excalidraw element type supported (rectangle, ellipse,
 * diamond, line, arrow, text, freedraw, image, frame). Tool inputs use
 * JSON Schema so the agent's tool-call validator surfaces clear errors
 * when arguments are missing.
 */
import * as canvas from "./canvas-state.js";
import { buildDiagram, type DiagramRequest } from "./diagram.js";
import { ELEMENT_TYPES } from "./elements.js";

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => unknown;
}

// JSON Schema fragment for a single element. Kept loose (additionalProperties
// allowed) so future Excalidraw fields aren't blocked by the gateway —
// validation happens in elements.ts at runtime.
const ELEMENT_INPUT_SCHEMA = {
  type: "object",
  required: ["type", "x", "y"],
  properties: {
    id: { type: "string", description: "Stable id; auto-generated if absent" },
    type: { type: "string", enum: ELEMENT_TYPES as unknown as string[] },
    x: { type: "number" },
    y: { type: "number" },
    width: { type: "number" },
    height: { type: "number" },
    strokeColor: { type: "string" },
    backgroundColor: { type: "string" },
    fillStyle: { type: "string", enum: ["hachure", "cross-hatch", "solid", "zigzag", "dots"] },
    strokeWidth: { type: "number" },
    strokeStyle: { type: "string", enum: ["solid", "dashed", "dotted"] },
    roughness: { type: "number" },
    opacity: { type: "number" },
    text: { type: "string" },
    fontSize: { type: "number" },
    fontFamily: { type: "number" },
    textAlign: { type: "string", enum: ["left", "center", "right"] },
    verticalAlign: { type: "string", enum: ["top", "middle", "bottom"] },
    points: {
      type: "array",
      items: { type: "array", items: { type: "number" }, minItems: 2, maxItems: 2 },
    },
    startBinding: {
      type: "object",
      properties: {
        elementId: { type: "string" },
        focus: { type: "number" },
        gap: { type: "number" },
      },
    },
    endBinding: {
      type: "object",
      properties: {
        elementId: { type: "string" },
        focus: { type: "number" },
        gap: { type: "number" },
      },
    },
    startArrowhead: { type: ["string", "null"], enum: ["arrow", "bar", "dot", "triangle", null] },
    endArrowhead: { type: ["string", "null"], enum: ["arrow", "bar", "dot", "triangle", null] },
    groupIds: { type: "array", items: { type: "string" } },
    locked: { type: "boolean" },
    angle: { type: "number" },
    fileId: { type: "string" },
    name: { type: "string" },
  },
  additionalProperties: true,
} as const;

function ok(payload: unknown): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

export const TOOLS: McpTool[] = [
  // ── Read ────────────────────────────────────────────────────────────
  {
    name: "get_scene",
    description: "Return every element currently on the canvas.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: () => ok({ elements: canvas.getAll() }),
  },
  {
    name: "get_element",
    description: "Look up a single element by id.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: { id: { type: "string" } },
    },
    handler: (args) => ok({ element: canvas.getById(String(args.id)) }),
  },
  {
    name: "query_elements",
    description:
      "Filter elements by type / groupId / containerId / text substring. Each filter is optional; combine for AND.",
    inputSchema: {
      type: "object",
      properties: {
        type: { type: "string", enum: ELEMENT_TYPES as unknown as string[] },
        groupId: { type: "string" },
        containerId: { type: "string" },
        textContains: { type: "string" },
      },
    },
    handler: (args) =>
      ok({
        elements: canvas.query({
          type: args.type as string | undefined,
          groupId: args.groupId as string | undefined,
          containerId: args.containerId as string | undefined,
          textContains: args.textContains as string | undefined,
        }),
      }),
  },

  // ── Create ──────────────────────────────────────────────────────────
  {
    name: "create_element",
    description:
      "Add a single element. Defaults are applied for unspecified style fields. Returns the normalized element with its assigned id.",
    inputSchema: ELEMENT_INPUT_SCHEMA as Record<string, unknown>,
    handler: (args) => ok({ element: canvas.createOne(args) }),
  },
  {
    name: "create_batch",
    description:
      "Add many elements in one call. Use this for diagrams — Excalidraw renders a batch as a single undo step. Returns normalized elements with ids.",
    inputSchema: {
      type: "object",
      required: ["elements"],
      properties: {
        elements: { type: "array", items: ELEMENT_INPUT_SCHEMA },
      },
    },
    handler: (args) => ok({ elements: canvas.createMany(args.elements) }),
  },
  {
    name: "create_diagram",
    description:
      "Generate a complete laid-out diagram in one call. Supply nodes + edges and a kind (flowchart, sequence, erd, mindmap, architecture); the layout engine positions everything, binds the arrows to the shapes, and adds labels. Direction is 'TB' (top-down, default) or 'LR'. Use this instead of hand-rolling create_batch for any multi-node chart — saves dozens of tool calls and gets the bindings right the first time.",
    inputSchema: {
      type: "object",
      required: ["kind", "nodes"],
      properties: {
        kind: { type: "string", enum: ["flowchart", "sequence", "erd", "mindmap", "architecture"] },
        nodes: {
          type: "array",
          items: {
            type: "object",
            required: ["id"],
            properties: {
              id: { type: "string" },
              label: { type: "string" },
              kind: { type: "string", enum: ["process", "decision", "data", "actor", "start", "end", "group", "note"] },
            },
          },
        },
        edges: {
          type: "array",
          items: {
            type: "object",
            required: ["from", "to"],
            properties: {
              from: { type: "string" },
              to: { type: "string" },
              label: { type: "string" },
              kind: { type: "string", enum: ["solid", "dashed", "dotted"] },
            },
          },
        },
        direction: { type: "string", enum: ["LR", "TB"] },
        origin: { type: "object", properties: { x: { type: "number" }, y: { type: "number" } } },
        fit: { type: "boolean", description: "Fit the camera to the diagram after creating." },
        merge: { type: "boolean", description: "Add to the current scene instead of replacing it. Default: true." },
      },
    },
    handler: (args) => {
      const req = args as unknown as DiagramRequest;
      if (req.merge === false) canvas.clearAll();
      const { elements, edges } = buildDiagram(req);
      // Nodes first so arrows can resolve their bindings, then edges.
      const created = canvas.createMany([...elements, ...edges]);
      if (req.fit) canvas.fitToContent();
      return ok({
        elements: created,
        nodeCount: elements.length,
        edgeCount: edges.length,
      });
    },
  },
  {
    name: "connect_elements",
    description:
      "Draw an arrow between two existing elements, with proper start/end bindings so the arrow tracks the shapes when they move. Optional label is rendered as a bound text element at the midpoint. This is the right way to add connections between agent-created shapes — building an arrow by hand with create_element rarely gets the binding back-references correct.",
    inputSchema: {
      type: "object",
      required: ["fromId", "toId"],
      properties: {
        fromId: { type: "string" },
        toId: { type: "string" },
        label: { type: "string" },
        strokeStyle: { type: "string", enum: ["solid", "dashed", "dotted"] },
        strokeColor: { type: "string" },
        startArrowhead: { type: ["string", "null"], enum: ["arrow", "bar", "dot", "triangle", null] },
        endArrowhead: { type: ["string", "null"], enum: ["arrow", "bar", "dot", "triangle", null] },
      },
    },
    handler: (args) =>
      ok({
        element: canvas.createConnection({
          fromId: String(args.fromId),
          toId: String(args.toId),
          label: args.label as string | undefined,
          strokeStyle: args.strokeStyle as "solid" | "dashed" | "dotted" | undefined,
          strokeColor: args.strokeColor as string | undefined,
          startArrowhead: args.startArrowhead as "arrow" | "bar" | "dot" | "triangle" | null | undefined,
          endArrowhead: args.endArrowhead as "arrow" | "bar" | "dot" | "triangle" | null | undefined,
        }),
      }),
  },

  // ── Update ──────────────────────────────────────────────────────────
  {
    name: "update_element",
    description:
      "Patch an existing element. Only the supplied fields change; the rest are preserved. Throws if id is unknown.",
    inputSchema: {
      type: "object",
      required: ["id", "patch"],
      properties: {
        id: { type: "string" },
        patch: { type: "object", additionalProperties: true },
      },
    },
    handler: (args) =>
      ok({
        element: canvas.updateOne(
          String(args.id),
          args.patch as Record<string, unknown>,
        ),
      }),
  },
  {
    name: "update_batch",
    description:
      "Patch many elements at once. Each entry is { id, patch }. Unknown ids are skipped silently. Returns the elements that did change.",
    inputSchema: {
      type: "object",
      required: ["updates"],
      properties: {
        updates: {
          type: "array",
          items: {
            type: "object",
            required: ["id", "patch"],
            properties: {
              id: { type: "string" },
              patch: { type: "object", additionalProperties: true },
            },
          },
        },
      },
    },
    handler: (args) =>
      ok({
        elements: canvas.updateMany(
          args.updates as Array<{ id: string; patch: Record<string, unknown> }>,
        ),
      }),
  },

  // ── Delete ──────────────────────────────────────────────────────────
  {
    name: "delete_elements",
    description: "Remove the listed element ids from the canvas.",
    inputSchema: {
      type: "object",
      required: ["ids"],
      properties: { ids: { type: "array", items: { type: "string" } } },
    },
    handler: (args) => ok(canvas.deleteIds(args.ids as string[])),
  },
  {
    name: "clear_canvas",
    description: "Remove every element. Cannot be undone via this MCP — operator's Excalidraw undo still works.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: () => {
      canvas.clearAll();
      return ok({ ok: true });
    },
  },

  // ── Arrange ─────────────────────────────────────────────────────────
  {
    name: "bring_to_front",
    description: "Move the listed elements above every other element.",
    inputSchema: {
      type: "object",
      required: ["ids"],
      properties: { ids: { type: "array", items: { type: "string" } } },
    },
    handler: (args) => {
      canvas.bringToFront(args.ids as string[]);
      return ok({ ok: true });
    },
  },
  {
    name: "send_to_back",
    description: "Move the listed elements below every other element.",
    inputSchema: {
      type: "object",
      required: ["ids"],
      properties: { ids: { type: "array", items: { type: "string" } } },
    },
    handler: (args) => {
      canvas.sendToBack(args.ids as string[]);
      return ok({ ok: true });
    },
  },
  {
    name: "bring_forward",
    description: "Move each listed element up exactly one z-index slot.",
    inputSchema: {
      type: "object",
      required: ["ids"],
      properties: { ids: { type: "array", items: { type: "string" } } },
    },
    handler: (args) => {
      canvas.bringForward(args.ids as string[]);
      return ok({ ok: true });
    },
  },
  {
    name: "send_backward",
    description: "Move each listed element down exactly one z-index slot.",
    inputSchema: {
      type: "object",
      required: ["ids"],
      properties: { ids: { type: "array", items: { type: "string" } } },
    },
    handler: (args) => {
      canvas.sendBackward(args.ids as string[]);
      return ok({ ok: true });
    },
  },
  {
    name: "group_elements",
    description: "Group the listed elements. Returns the assigned groupId.",
    inputSchema: {
      type: "object",
      required: ["ids"],
      properties: { ids: { type: "array", items: { type: "string" } } },
    },
    handler: (args) => ok(canvas.group(args.ids as string[])),
  },
  {
    name: "ungroup_elements",
    description: "Remove the supplied groupId from every element that has it.",
    inputSchema: {
      type: "object",
      required: ["groupId"],
      properties: { groupId: { type: "string" } },
    },
    handler: (args) => ok(canvas.ungroup(String(args.groupId))),
  },

  // ── View ────────────────────────────────────────────────────────────
  {
    name: "fit_to_content",
    description: "Zoom + pan the camera so every element is visible.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: () => {
      canvas.fitToContent();
      return ok({ ok: true });
    },
  },
  {
    name: "scroll_to",
    description: "Scroll the viewport so the named element is in view.",
    inputSchema: {
      type: "object",
      required: ["elementId"],
      properties: { elementId: { type: "string" } },
    },
    handler: (args) => {
      canvas.scrollTo(String(args.elementId));
      return ok({ ok: true });
    },
  },
  {
    name: "set_zoom",
    description: "Set the camera zoom (1 = 100%, 2 = 200%, 0.5 = 50%).",
    inputSchema: {
      type: "object",
      required: ["zoom"],
      properties: { zoom: { type: "number", minimum: 0.1, maximum: 8 } },
    },
    handler: (args) => {
      canvas.setZoom(Number(args.zoom));
      return ok({ ok: true });
    },
  },

  // ── IO ──────────────────────────────────────────────────────────────
  {
    name: "export_scene",
    description:
      "Return the entire canvas as a JSON object compatible with Excalidraw's File > Save As format.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: () => ok(canvas.exportScene()),
  },
  {
    name: "import_scene",
    description:
      "Replace the canvas with the supplied scene JSON. Same shape as Excalidraw's saved files.",
    inputSchema: {
      type: "object",
      required: ["scene"],
      properties: { scene: { type: "object", additionalProperties: true } },
    },
    handler: (args) => ok(canvas.importScene(args.scene)),
  },
];

export const TOOL_COUNT = TOOLS.length;
