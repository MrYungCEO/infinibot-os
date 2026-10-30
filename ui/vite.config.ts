import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const here = path.dirname(fileURLToPath(import.meta.url));

function normalizeBase(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return "/";
  if (trimmed === "./") return "./";
  if (trimmed.endsWith("/")) return trimmed;
  return `${trimmed}/`;
}

export default defineConfig(({ command }) => {
  const envBase = process.env.INFINIBOT_CONTROL_UI_BASE_PATH?.trim();
  const base = envBase ? normalizeBase(envBase) : "./";
  return {
    base,
    publicDir: path.resolve(here, "public"),
    // First-party plugin pages (extensions/*/ui) import "lit" from outside
    // this package; resolve it to the control UI's single copy. "three" too:
    // every three-based dependency (react-three, postprocessing, three-stdlib,
    // reactbits…) has its own nested node_modules/three, which bundled the r184
    // core 9× (~3 MB) and logged "Multiple instances of Three.js" per copy.
    resolve: {
      dedupe: ["lit", "lit-html", "lit-element", "@lit/reactive-element", "three"],
    },
    optimizeDeps: {
      include: ["lit/directives/repeat.js"],
    },
    build: {
      outDir: path.resolve(here, "../dist/control-ui"),
      emptyOutDir: true,
      sourcemap: false,
      rollupOptions: {
        external: [],
        // Two pages: the app, and the local setup wizard (`infinibot
        // quickstart`), which shares the onboarding console but not the shell.
        input: {
          main: path.resolve(here, "index.html"),
          setup: path.resolve(here, "setup.html"),
        },
        output: {
          manualChunks(id) {
            if (!id.includes("node_modules")) return undefined;

            // 3D engines
            if (/[\\/]node_modules[\\/](three|three-stdlib|@react-three)[\\/]/.test(id)) return "three-vendor";
            if (/[\\/]node_modules[\\/](pixi\.js|pixi-viewport)[\\/]/.test(id)) return "pixi-vendor";
            if (/[\\/]node_modules[\\/](ogl|gl-matrix|meshline)[\\/]/.test(id)) return "ogl-vendor";

            // Heavy media / ML
            if (id.includes("/livekit-client/")) return "livekit-vendor";
            // CSS files imported via ?raw stay in the main chunk (they're tiny
            // string literals). Without this exclusion, the ?raw import of
            // xterm.css in masonry-grid.ts creates a static link to xterm-vendor
            // that forces the whole 336KB chunk to execute on every page load.
            if (id.includes("/@xterm/") && !id.includes(".css")) return "xterm-vendor";
            if (id.includes("/@excalidraw/")) return "excalidraw-vendor";
            if (/[\\/]node_modules[\\/](onnxruntime-web|@ricky0123[\\/]vad-web)[\\/]/.test(id)) return "onnx-vendor";

            // Animation libs
            if (/[\\/]node_modules[\\/](framer-motion|gsap|@motionone)[\\/]/.test(id)) return "motion-vendor";

            // React + Chakra/Emotion must share a chunk to avoid duplicate React
            if (/[\\/]node_modules[\\/](react|react-dom|scheduler|@chakra-ui|@emotion)[\\/]/.test(id)) return "react-vendor";

            // Lit
            if (/[\\/]node_modules[\\/](lit|lit-html|lit-element|@lit)[\\/]/.test(id)) return "lit-vendor";

            // Markdown
            if (/[\\/]node_modules[\\/](marked|dompurify)[\\/]/.test(id)) return "markdown-vendor";

            // Other heavy oddballs (also helps if they're ever imported)
            if (id.includes("/matter-js/")) return "matter-vendor";
            if (id.includes("/@xyflow/")) return "xyflow-vendor";
            if (/[\\/]node_modules[\\/]d3(-[a-z]+)?[\\/]/.test(id)) return "d3-vendor";

            return undefined;
          },
        },
      },
    },
    server: {
      host: true,
      port: 5173,
      strictPort: true,
      proxy: {
        "/api/connection-details": "http://localhost:3001",
        "/api/voice": "http://localhost:3001",
        "/api/voices": "http://localhost:3001",
        "/api/settings": "http://localhost:3001",
        "/api/wake": "http://localhost:3001",
        "/api/wake-word": "http://localhost:3001",
        "/api/setup": "http://localhost:3001",
        "/media": "http://localhost:18789",
        "/api/compositions": "http://localhost:18789",
      }
    },
  };
});
