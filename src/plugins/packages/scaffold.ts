/**
 * `infinibot plugins create <id>` — scaffold a minimal working plugin.
 *
 * The generated plugin is plain JavaScript (no build step) and exercises one
 * of each core surface: a gateway RPC, an agent tool, a settings field and a
 * small UI panel. `examples/plugin-hello` is this scaffold's output for
 * `hello`; a test keeps the two identical, so the docs' walkthrough and what
 * the command really writes can't drift apart.
 */

import fs from "node:fs";
import path from "node:path";

import { PACKAGE_ID_RE, RESERVED_PACKAGE_IDS } from "./format.js";

/** First InfiniBot release that understands plugin packages. */
export const SCAFFOLD_MIN_HOST_VERSION = "2026.6.30";

export type ScaffoldOptions = {
  id: string;
  name?: string;
  publisher?: string;
  description?: string;
};

function titleCase(id: string): string {
  return id
    .split("-")
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(" ");
}

/** File path → contents for a new plugin. Throws on an invalid id. */
export function scaffoldPluginFiles(opts: ScaffoldOptions): Record<string, string> {
  const id = opts.id.trim();
  if (!PACKAGE_ID_RE.test(id)) {
    throw new Error(`plugin id "${id}" must be lowercase letters, digits and dashes (2–64 chars)`);
  }
  if (RESERVED_PACKAGE_IDS.has(id)) throw new Error(`plugin id "${id}" is reserved`);
  const name = opts.name?.trim() || titleCase(id);
  const publisher = opts.publisher?.trim() || "my-publisher";
  if (!PACKAGE_ID_RE.test(publisher)) {
    throw new Error(`publisher "${publisher}" must be lowercase letters, digits and dashes`);
  }
  const description = opts.description?.trim() || `${name} — a minimal InfiniBot plugin.`;
  const tool = `${id.replaceAll("-", "_")}_greet`;
  const tag = `${id}-panel`;

  const manifest = {
    manifestVersion: 2,
    id,
    name,
    version: "0.1.0",
    publisher,
    license: "MIT",
    description,
    minHostVersion: SCAFFOLD_MIN_HOST_VERSION,
    engines: { "infinibot-plugin-api": "^2.0.0" },
    listing: {
      tagline: `Say hello from ${name}.`,
      description: `**${name}** is a starter plugin. It adds one gateway method, one agent tool, one setting and a small panel.\n\nReplace this text with what your plugin does and who it is for.`,
      category: "developer",
      tags: ["example"],
      icon: "assets/icon.svg",
    },
    configSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        greeting: { type: "string", default: "Hello" },
      },
    },
    uiHints: {
      greeting: { label: "Greeting", placeholder: "Hello" },
    },
    ui: { navLabel: name, entry: `/plugins/${id}/ui.js` },
    contributes: {
      rpc: [{ method: `${id}.greet`, scope: "read" }],
      http: [`/plugins/${id}/ui.js`],
      tools: [tool],
    },
    permissions: {},
  };

  const pkg = {
    name: id,
    version: "0.1.0",
    private: true,
    type: "module",
    description,
    license: "MIT",
    infinibot: { extensions: ["./index.js"] },
  };

  const indexJs = `// ${name} — plugin entry. Runs inside the InfiniBot gateway.
// Everything registered here must be declared in infinibot.plugin.json
// ("contributes"); the host rejects undeclared RPC methods, routes and tools.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

function greet(api, who) {
  const greeting = api.pluginConfig?.greeting || "Hello";
  const name = typeof who === "string" && who.trim() ? who.trim().slice(0, 80) : "world";
  return \`\${greeting}, \${name}!\`;
}

export default {
  id: "${id}",
  name: "${name}",

  register(api) {
    // Gateway RPC — callable from the UI panel and other gateway clients.
    api.registerGatewayMethod("${id}.greet", ({ params, respond }) => {
      respond(true, { message: greet(api, params?.name) });
    });

    // Agent tool — agents can call it once the plugin is on.
    api.registerTool({
      name: "${tool}",
      label: "${name}: greet",
      description: "Return a friendly greeting for a name.",
      parameters: {
        type: "object",
        properties: { name: { type: "string", description: "Who to greet" } },
      },
      async execute(_toolCallId, params) {
        const message = greet(api, params?.name);
        return { content: [{ type: "text", text: message }], details: { message } };
      },
    });

    // UI panel module. publicAsset: the browser imports it as an ES module,
    // which can't send credentials — so serve only static code here.
    const panel = readFileSync(join(here, "ui.js"), "utf-8");
    api.registerHttpRoute({
      path: "/plugins/${id}/ui.js",
      publicAsset: true,
      handler: (_req, res) => {
        res.writeHead(200, {
          "content-type": "application/javascript; charset=utf-8",
          "cache-control": "no-cache",
        });
        res.end(panel);
      },
    });

    api.logger.info("${id}: ready");
  },
};
`;

  const uiJs = `// ${name} — UI panel. A plain custom element: no framework, no build step.
// The host imports this module and calls the default export with a container
// and { client, pluginId }; return a cleanup function.

const TAG = "${tag}";

const CSS = \`
  :host { display: block; color: var(--g-fg, #f5f5f4); font: inherit; }
  .wrap { display: grid; gap: 12px; max-width: 420px; }
  label { display: grid; gap: 6px; font-size: 0.9em; color: var(--muted, #a1a1aa); }
  input {
    min-height: 36px; padding: 0 10px; border-radius: 8px; font: inherit;
    color: inherit; background: transparent;
    border: 1px solid var(--g-line, rgba(255, 255, 255, 0.16));
  }
  button {
    justify-self: start; min-height: 36px; padding: 0 14px; border-radius: 8px;
    font: inherit; cursor: pointer; background: transparent;
    color: var(--plugin-accent, var(--g-primary, #fbbf24));
    border: 1px solid var(--plugin-accent, var(--g-primary, #fbbf24));
  }
  button:focus-visible, input:focus-visible {
    outline: 2px solid var(--plugin-accent, var(--g-primary, #fbbf24)); outline-offset: 2px;
  }
  .out { min-height: 1.4em; font-size: 1.1em; }
  .error { color: var(--g-danger, #ef4444); }
\`;

class Panel extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this.gateway = null; // set by mount()
    this.message = "";
    this.problem = "";
  }

  connectedCallback() {
    this.draw();
  }

  async greet(name) {
    this.problem = "";
    try {
      const res = await this.gateway.request("${id}.greet", { name });
      this.message = String(res?.message ?? "");
    } catch (err) {
      this.problem = err instanceof Error ? err.message : String(err);
    }
    this.draw();
  }

  draw() {
    const root = this.shadowRoot;
    const previous = root.querySelector("input")?.value ?? "";
    root.textContent = "";

    const style = document.createElement("style");
    style.textContent = CSS;

    const wrap = document.createElement("div");
    wrap.className = "wrap";

    const label = document.createElement("label");
    label.textContent = "Name";
    const input = document.createElement("input");
    input.type = "text";
    input.value = previous;
    input.placeholder = "world";
    label.append(input);

    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "Greet";
    button.addEventListener("click", () => void this.greet(input.value));

    const out = document.createElement("div");
    out.setAttribute("role", "status");
    out.setAttribute("aria-live", "polite");
    out.className = this.problem ? "out error" : "out";
    out.textContent = this.problem || this.message; // textContent, never innerHTML

    wrap.append(label, button, out);
    root.append(style, wrap);
  }
}

if (!customElements.get(TAG)) customElements.define(TAG, Panel);

export default function mount(container, ctx) {
  const el = document.createElement(TAG);
  el.gateway = ctx.client;
  container.replaceChildren(el);
  return () => el.remove();
}
`;

  const iconSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="${name}">
  <rect width="64" height="64" rx="14" fill="#18181b"/>
  <path d="M20 22v20M20 32h12M32 22v20M40 22v20M46 22v20" stroke="#fbbf24" stroke-width="4" stroke-linecap="round" fill="none"/>
</svg>
`;

  const readme = `# ${name}

${description}

## Develop

\`\`\`bash
# Load this folder straight from disk (no copy), then restart the gateway
infinibot plugins install --link .
infinibot plugins enable ${id}
\`\`\`

Open **Setup › Plugins › ${name}** to see the panel, or call the RPC \`${id}.greet\`.

## Package and install

\`\`\`bash
infinibot plugins validate .
infinibot plugins pack .            # writes ${id}-0.1.0.ibplugin.zip + .sha256
infinibot plugins install ./${id}-0.1.0.ibplugin.zip
\`\`\`

Docs: docs/plugins/getting-started.md
`;

  const changelog = `# Changelog

## 0.1.0

- First release.
`;

  const license = `MIT License

Copyright (c) ${publisher}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;

  const ignore = `# Files left out of the package (infinibot plugins pack)
*.test.js
test/
`;

  return {
    "infinibot.plugin.json": `${JSON.stringify(manifest, null, 2)}\n`,
    "package.json": `${JSON.stringify(pkg, null, 2)}\n`,
    "index.js": indexJs,
    "ui.js": uiJs,
    "assets/icon.svg": iconSvg,
    "README.md": readme,
    "CHANGELOG.md": changelog,
    LICENSE: license,
    ".ibpluginignore": ignore,
  };
}

/** Write the scaffold into `dir` (must not exist or be empty). Returns the files written. */
export function writePluginScaffold(dir: string, opts: ScaffoldOptions): string[] {
  const root = path.resolve(dir);
  if (fs.existsSync(root) && fs.readdirSync(root).length > 0) {
    throw new Error(`${root} already exists and is not empty`);
  }
  const files = scaffoldPluginFiles(opts);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, ...rel.split("/"));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return Object.keys(files);
}
