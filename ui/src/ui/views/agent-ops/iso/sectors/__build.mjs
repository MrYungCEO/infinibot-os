// Rebuild the visual-verify bundle, then re-shoot the 5 phase screenshots.
//   node src/ui/views/agent-ops/iso/sectors/__build.mjs
import { build } from "esbuild";
import { fileURLToPath } from "url";
import path from "path";

const dir = path.dirname(fileURLToPath(import.meta.url));
await build({
  entryPoints: [path.join(dir, "__test.entry.ts")],
  bundle: true,
  format: "iife",
  outfile: path.join(dir, "__test.bundle.js"),
});
console.log("bundled → __test.bundle.js  (run __shoot.mjs for screenshots)");
