/**
 * Vite build for the mobile WebView embed of the Agency World engine.
 *
 * Emits a SINGLE self-contained HTML file with PixiJS + pixi-viewport + GSAP
 * + the ActivityMap engine inlined. The mobile app reads that file (wrapped
 * as a JS string by scripts/wrap-embed-html.mjs) and hands it to the
 * react-native-webview as `source.html`.
 *
 * Output: dist/agency-world-mobile/index.html
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  // Use relative asset paths so the post-build inliner can locate emitted
  // chunks without depending on a real base URL (the mobile webview loads
  // the HTML via `source.html`, not a server).
  base: "./",
  publicDir: false,
  build: {
    outDir: path.resolve(here, "../dist/agency-world-mobile"),
    emptyOutDir: true,
    sourcemap: false,
    cssCodeSplit: false,
    assetsDir: ".",
    minify: "esbuild",
    target: "es2020",
    rollupOptions: {
      input: path.resolve(here, "src/embed/agency-world-mobile.html"),
      output: {
        // Single chunk — no code splitting, so the inliner has exactly one
        // <script> tag to swallow.
        inlineDynamicImports: true,
        entryFileNames: "agency-world-mobile.js",
        assetFileNames: "agency-world-mobile.[ext]",
      },
    },
  },
});
