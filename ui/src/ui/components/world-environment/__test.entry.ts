// Standalone visual-test entry for <world-environment>. Bundled by esbuild.
import "../world-environment.js";

const env = document.createElement("world-environment");
env.id = "env";
env.setAttribute("style", "position:absolute;inset:0;z-index:0");
document.getElementById("stage")!.appendChild(env);

// Mock viz overlay (transparent) to confirm depth reads correctly through it.
const viz = document.createElement("div");
viz.id = "mockviz";
viz.setAttribute(
  "style",
  "position:absolute;inset:0;z-index:1;display:none;pointer-events:none;" +
    "background:radial-gradient(40% 30% at 50% 54%, rgba(20,30,60,0.0), transparent 70%);",
);
viz.innerHTML = `
  <div style="position:absolute;left:50%;top:54%;transform:translate(-50%,-50%);
    width:120px;height:60px;border:1px solid rgba(212,175,55,.6);border-radius:8px;
    background:rgba(10,14,26,.55);color:#d4af37;font:12px monospace;display:grid;
    place-items:center;box-shadow:0 0 30px rgba(212,175,55,.25)">ATRIUM CORE</div>
  <div style="position:absolute;left:24%;top:32%;width:34px;height:34px;border-radius:6px;
    background:rgba(125,211,252,.18);border:1px solid rgba(125,211,252,.5)"></div>
  <div style="position:absolute;left:70%;top:64%;width:34px;height:34px;border-radius:6px;
    background:rgba(167,139,250,.18);border:1px solid rgba(167,139,250,.5)"></div>
`;
document.getElementById("stage")!.appendChild(viz);

// Expose controls for puppeteer.
(window as any).__we = {
  env,
  showViz(on: boolean) {
    viz.style.display = on ? "block" : "none";
  },
  setActivity(v: number) {
    env.setActivity(v);
  },
  setTheme(t: any) {
    env.setSkyTheme(t);
  },
  addDemoBeams() {
    const cx = 0.5,
      cy = 0.54;
    const specs = [];
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2 + 0.3;
      specs.push({
        from: { x: cx, y: cy },
        to: { x: cx + Math.cos(a) * 0.36, y: cy + Math.sin(a) * 0.32 },
        intensity: 0.3 + (i % 3) * 0.3,
        color: i % 2 ? "#d4af37" : "#7dd3fc",
      });
    }
    env.setBeams(specs as any);
  },
};
