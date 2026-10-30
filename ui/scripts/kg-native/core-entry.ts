// Native bundle: the pure knowledge-graph pipeline (no DOM, no three.js).
export * from "../../src/ui/components/knowledge-graph-scene";
export * from "../../src/ui/components/knowledge-graph-scene-digest";
export * from "../../src/ui/components/knowledge-graph-ops";
export * from "../../src/ui/components/knowledge-graph-links";
export {
  ANCHOR_KINDS,
  DEFAULT_HEALTH,
  DEFAULT_KINDS,
  HEALTH_COLOR,
  HEALTH_LABEL,
  HEALTH_ORDER,
  KIND_LABEL,
  KIND_ORDER,
  KIND_PALETTE,
  KIND_SHAPE,
  KIND_SINGULAR,
  SHAPE,
  colorFor,
  healthOf,
  labelScaleFor,
  relativeAge,
  shapeFor,
} from "../../src/ui/components/knowledge-graph-model";
export {
  buildUndo,
  captureOf,
  clusterSubProjects,
  describePlan,
  planConvertToTasks,
  planMergeDuplicates,
  resolveRefs,
  subProjectsOf,
  UNRESOLVED,
} from "../../src/ui/components/knowledge-graph-consolidate";
export { makeLiveShapedSnapshot } from "../../src/ui/components/knowledge-graph-synth";
// The flat 2D map (the web's 2D renderer + a stage with the 3D stage's surface).
export * from "../../src/ui/components/knowledge-graph-map2d";
export * from "../../src/ui/components/knowledge-graph-map2d-stage";
export * from "../../src/ui/components/knowledge-graph-map2d-digest";
