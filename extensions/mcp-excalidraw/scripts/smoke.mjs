#!/usr/bin/env node
/**
 * End-to-end smoke test for the canvas state + tools.
 * Bypasses the gateway bridge — every mutation just verifies state.
 *
 * Run: node scripts/smoke.mjs
 */
import * as canvas from "../dist/canvas-state.js";
import { applyPatch, reconcileBindings, normalizeElement } from "../dist/elements.js";
import { buildDiagram } from "../dist/diagram.js";

let passed = 0;
let failed = 0;
function assert(cond, msg) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
}

function reset() {
  canvas.clearAll();
}

console.log("\n— shape with text expands into shape + bound label —");
reset();
const box = canvas.createOne({ type: "rectangle", x: 0, y: 0, width: 200, height: 100, text: "Hello", id: "box1" });
const all1 = canvas.getAll();
assert(all1.length === 2, "two elements emitted (shape + label)");
assert(box.id === "box1", "primary returned is the shape");
assert(!("text" in box) || box.text === undefined, "shape has no text field (label lives separately)");
const label1 = all1.find((e) => e.type === "text" && e.containerId === "box1");
assert(!!label1, "label has containerId pointing at shape");
assert(label1.text === "Hello", "label text matches");
assert(
  Array.isArray(box.boundElements) && box.boundElements.some((b) => b.type === "text" && b.id === label1.id),
  "shape.boundElements references the label",
);

console.log("\n— update_element with text propagates to the bound label —");
canvas.updateOne("box1", { text: "Goodbye" });
const all2 = canvas.getAll();
const label2 = all2.find((e) => e.type === "text" && e.containerId === "box1");
assert(label2.text === "Goodbye", "label text updated");
const shape2 = all2.find((e) => e.id === "box1");
assert(!shape2.text, "shape still has no text field after redirect");

console.log("\n— moving a shape repositions its label —");
canvas.updateOne("box1", { x: 500, y: 300 });
const label3 = canvas.getAll().find((e) => e.type === "text" && e.containerId === "box1");
assert(label3.x >= 500 && label3.x < 700, `label x followed shape (got ${label3.x})`);
assert(label3.y >= 300 && label3.y < 500, `label y followed shape (got ${label3.y})`);

console.log("\n— connect_elements builds bound arrow + back-refs on both shapes —");
reset();
canvas.createOne({ type: "rectangle", x: 0, y: 0, width: 200, height: 100, text: "A", id: "A" });
canvas.createOne({ type: "rectangle", x: 400, y: 0, width: 200, height: 100, text: "B", id: "B" });
const arrow = canvas.createConnection({ fromId: "A", toId: "B", label: "calls" });
assert(arrow.type === "arrow", "arrow created");
assert(arrow.startBinding?.elementId === "A", "startBinding → A");
assert(arrow.endBinding?.elementId === "B", "endBinding → B");
const sceneA = canvas.getById("A");
const sceneB = canvas.getById("B");
assert(
  sceneA.boundElements.some((b) => b.type === "arrow" && b.id === arrow.id),
  "shape A has arrow back-ref",
);
assert(
  sceneB.boundElements.some((b) => b.type === "arrow" && b.id === arrow.id),
  "shape B has arrow back-ref",
);
const arrowLabel = canvas.getAll().find((e) => e.type === "text" && e.containerId === arrow.id);
assert(!!arrowLabel, "arrow has bound label text element");
assert(arrowLabel.text === "calls", "arrow label text correct");

console.log("\n— deleting an element cascades to its bound label —");
reset();
canvas.createOne({ type: "rectangle", x: 0, y: 0, text: "X", id: "X1" });
const beforeDelete = canvas.getAll().length;
assert(beforeDelete === 2, "shape + label before delete");
canvas.deleteIds(["X1"]);
assert(canvas.getAll().length === 0, "label is removed when its container is");

console.log("\n— deleting an arrow removes its back-refs from bound shapes —");
reset();
canvas.createOne({ type: "rectangle", x: 0, y: 0, id: "A", width: 100, height: 100 });
canvas.createOne({ type: "rectangle", x: 300, y: 0, id: "B", width: 100, height: 100 });
const ar = canvas.createConnection({ fromId: "A", toId: "B" });
canvas.deleteIds([ar.id]);
const aAfter = canvas.getById("A");
const bAfter = canvas.getById("B");
assert(
  !aAfter.boundElements || !aAfter.boundElements.some((b) => b.id === ar.id),
  "shape A no longer references deleted arrow",
);
assert(
  !bAfter.boundElements || !bAfter.boundElements.some((b) => b.id === ar.id),
  "shape B no longer references deleted arrow",
);

console.log("\n— applyPatch bumps version + versionNonce + updated —");
const original = normalizeElement({ type: "rectangle", x: 0, y: 0 });
const patched = applyPatch(original, { x: 50 });
assert(patched.version > original.version, `version bumped (${original.version} → ${patched.version})`);
assert(patched.versionNonce !== original.versionNonce, "versionNonce regenerated");
assert(patched.updated >= original.updated, "updated timestamp refreshed");

console.log("\n— reconcileBindings drops stale arrow refs and adds missing ones —");
const inputs = [
  normalizeElement({ id: "shape1", type: "rectangle", x: 0, y: 0, width: 100, height: 100 }),
  normalizeElement({
    id: "arr1",
    type: "arrow",
    x: 0,
    y: 0,
    width: 100,
    height: 0,
    points: [[0, 0], [100, 0]],
    startBinding: { elementId: "shape1" },
    endBinding: { elementId: "missing-shape" },
  }),
];
// Manually plant a stale back-ref to make sure the reconciler removes it
inputs[0].boundElements = [
  { type: "arrow", id: "ghost-arrow" },
  { type: "text", id: "real-label" },
];
reconcileBindings(inputs);
const refs = inputs[0].boundElements;
assert(
  refs.some((r) => r.type === "arrow" && r.id === "arr1"),
  "arr1 added as back-ref on shape1",
);
assert(
  !refs.some((r) => r.id === "ghost-arrow"),
  "ghost arrow back-ref removed",
);
assert(
  refs.some((r) => r.type === "text" && r.id === "real-label"),
  "non-arrow back-refs (labels) are preserved",
);

console.log("\n— buildDiagram produces nodes + bound arrows —");
const diagram = buildDiagram({
  kind: "flowchart",
  direction: "TB",
  nodes: [
    { id: "n1", label: "Start", kind: "start" },
    { id: "n2", label: "Process", kind: "process" },
    { id: "n3", label: "Decide", kind: "decision" },
    { id: "n4", label: "End", kind: "end" },
  ],
  edges: [
    { from: "n1", to: "n2" },
    { from: "n2", to: "n3" },
    { from: "n3", to: "n4", label: "yes" },
  ],
});
assert(diagram.elements.length === 4, "4 node elements");
assert(diagram.edges.length === 3, "3 edge elements");
const labeledEdge = diagram.edges.find((e) => e.text === "yes");
assert(!!labeledEdge, "labeled edge has text field (will be expanded on insert)");

console.log("\n— create_diagram via canvas.createMany binds arrows + expands labels —");
reset();
const flat = canvas.createMany([...diagram.elements, ...diagram.edges]);
assert(flat.length >= 8, `at least 8 stored (4 nodes + 4 labels + 3 arrows + 1 arrow-label, got ${flat.length})`);
const n1 = canvas.getById("n1");
assert(
  Array.isArray(n1.boundElements) && n1.boundElements.some((b) => b.type === "arrow"),
  "n1 has an arrow back-ref",
);
const arrowWithLabel = canvas
  .getAll()
  .find((e) => e.type === "arrow" && Array.isArray(e.boundElements) && e.boundElements.some((b) => b.type === "text"));
assert(!!arrowWithLabel, "edge with label has bound text element");

console.log("\n— clearAll wipes the scene —");
canvas.clearAll();
assert(canvas.getAll().length === 0, "canvas cleared");

console.log(`\n${passed} passed · ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
