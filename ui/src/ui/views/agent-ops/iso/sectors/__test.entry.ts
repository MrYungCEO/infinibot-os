// Visual-verify harness for <world-atmosphere> + <world-sectors>.
// Bundled by __build.mjs → __test.bundle.js, loaded by __test.html.
import "../../../../components/world-atmosphere.js";
import "./world-sectors.js";

const stage = document.getElementById("stage")!;
stage.innerHTML = `
  <div style="position:absolute;inset:0;background:radial-gradient(120% 120% at 50% 30%, #16203a 0%, #070a14 70%)"></div>
  <world-atmosphere style="position:absolute;inset:0;z-index:1"></world-atmosphere>
  <world-sectors labels style="position:absolute;inset:0;z-index:2"></world-sectors>
  <div id="badge" style="position:absolute;left:12px;top:10px;z-index:9;font:700 14px ui-monospace,monospace;color:#fbbf24;letter-spacing:.15em;text-shadow:0 1px 4px #000"></div>
`;

const atmo = stage.querySelector("world-atmosphere") as any;
const badge = stage.querySelector("#badge")!;
(window as any).__setPhase = (p: string) => {
  atmo.setTimeOverride(p);
  badge.textContent = p.toUpperCase();
};
// default
(window as any).__setPhase("day");
