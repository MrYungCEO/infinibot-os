/**
 * glow3d — shared three.js helpers for InfiniBot's glowing 3D surfaces.
 *
 *   createGlowScene   renderer + camera + OrbitControls + bloom + backdrop + fog uniforms
 *   createStarfield   distant twinkling stars (one draw, shader-animated)
 *   createDust        drifting motes around the subject
 *   createGuideRings  faint concentric rings on the ground plane
 *   GlowNodes         instanced emissive orbs with additive halos
 *   GlowLinks         gradient glowing edges + energy pulses
 *   CameraTween       eased fly-to / fit-sphere camera moves
 *   StatusRings       progress / live / selection rings around chosen nodes
 *   GroupHalos        luminous ground discs under clusters
 *   createPolarGrid   instrument grid + radar sweep on the ground plane
 *   createNebula      distant violet/cyan/gold nebula wisps
 *
 * Designed so the knowledge graph and the agents constellation can share the
 * same look without sharing component code.
 */

export { createGlowScene, webglAvailable, FOG_GLSL } from "./scene";
export type { GlowScene, GlowSceneOptions, GlowSurface, GlowUniforms } from "./scene";
export { createStarfield, createDust, createGuideRings, createPolarGrid, createNebula } from "./ambience";
export { StatusRings } from "./status-rings";
export type { RingItem } from "./status-rings";
export { GroupHalos } from "./group-halos";
export type { HaloItem } from "./group-halos";
export { GlowNodes } from "./glow-nodes";
export type { GlowNodesOptions } from "./glow-nodes";
export { GlowLinks } from "./glow-links";
export type { GlowLinkIn, GlowLinksOptions } from "./glow-links";
export { CameraTween } from "./camera-tween";
export { radialSpriteTexture, toColor } from "./textures";
export { LobeVolumes } from "./lobe-volumes";
export type { LobeItem } from "./lobe-volumes";
export { NODE_SHAPES, shapeGeometry } from "./node-shapes";
export type { NodeShapeId } from "./node-shapes";
export { BrainCortex } from "./brain-cortex";
export type { LobeAnchor } from "./brain-cortex";
export { SuperNodes } from "./super-nodes";
export type { SuperNodeItem } from "./super-nodes";
export { BundleRibbons } from "./bundle-ribbons";
export type { BundleIn } from "./bundle-ribbons";
