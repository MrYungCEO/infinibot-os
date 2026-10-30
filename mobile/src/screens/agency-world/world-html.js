/**
 * Agency World — mobile WebView source.
 *
 * Previously this file shipped a Canvas2D reimplementation of the isometric
 * office. It has been replaced by a self-contained single-file build of the
 * EXACT PixiJS engine used on web (ActivityMap + iso/sector-layout + galactic
 * assets). The bundle is produced by `cd ui && npm run build:embed:mobile`
 * which writes mobile/src/screens/agency-world/world-html.bundled.js — this
 * file just re-exports its `AGENCY_WORLD_HTML` constant so the existing
 * AgencyWorldView import path keeps working.
 *
 * Host ↔ embed protocol (unchanged from the legacy Canvas2D engine — handled
 * by ui/src/embed/agency-world-mobile.ts):
 *   host → embed: { type:'sync', nodes, agents, tasks }
 *                 { type:'events', events: WorldEvent[] }
 *                 { type:'zoom',   action: 'in' | 'out' | 'fit' }
 *                 { type:'theme',  theme: 'galactic' | ... }
 *   embed → host: { type:'ready' }
 *                 { type:'agentTap', sessionKey }
 *                 { type:'nodeTap',  nodeId }
 */

// Metro (React Native) resolves './world-html.bundled' to .js, but Node ESM
// requires the explicit extension. Keep the extension so this file is usable
// from both runtimes — including the scripts/verify-iso-parity.mjs verifier.
export { AGENCY_WORLD_HTML } from './world-html.bundled.js';
