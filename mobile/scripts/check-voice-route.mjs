// Checks that the mobile "Voice" catalogue entry and infinibot://voice open the web
// Voice page (/voice, the Robovoice console) in the WebSurface host.
// Bundles the navigation modules with esbuild (their extensionless RN imports
// don't resolve under plain Node).  Run: node mobile/scripts/check-voice-route.mjs
import { build } from "esbuild";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
const nav = join(dirname(fileURLToPath(import.meta.url)), "../src/navigation");
const out = join(mkdtempSync(join(tmpdir(), "voice-route-")), "b.mjs");
await build({
  stdin: { contents: `export { resolveDeepLink } from ${JSON.stringify(join(nav, "deep-links.js"))};\nexport { SCREEN_SECTIONS, navigateToScreen, isRoutable, openVoice } from ${JSON.stringify(join(nav, "screen-registry.js"))};`, resolveDir: nav },
  bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "error",
});
const m = await import(out);
for (const link of ["infinibot://voice", "infinibot://robovoice", "infinibot://call"]) {
  const r = m.resolveDeepLink(link);
  assert.equal(r.webPath, "/voice", link);
  assert.equal(r.embed, true, link);
}
const entry = m.SCREEN_SECTIONS.flatMap((s) => s.items).find((e) => e.key === "voice");
assert.ok(entry && m.isRoutable(entry), "voice entry routable");
let nav2 = null;
m.navigateToScreen({ navigate: (r, p) => (nav2 = [r, p]) }, entry);
assert.equal(nav2[0], "WebSurfaceModal");
assert.equal(nav2[1].path, "/voice");
// Dock / terminal / chat / glasses voice buttons all go through openVoice().
let nav3 = null;
m.openVoice({ navigate: (r, p) => (nav3 = [r, p]) });
assert.deepEqual(nav3, nav2);
// No local voice route is left in the catalogue.
assert.ok(!m.SCREEN_SECTIONS.flatMap((s) => s.items).some((e) => e.screen === "VoiceCallScreen"), "no VoiceCallScreen entry");
console.log("PASS mobile voice route:", JSON.stringify(nav2), JSON.stringify(m.resolveDeepLink("infinibot://voice")));
