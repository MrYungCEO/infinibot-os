import fs from "node:fs";
import path from "node:path";

export type WorkspaceTemplateId = "react-vite" | "next" | "html" | "astro";

const templates: Record<WorkspaceTemplateId, Record<string, string>> = {
  "react-vite": {
    "package.json":
      JSON.stringify(
        {
          scripts: { dev: "vite", build: "vite build" },
          dependencies: {
            "@vitejs/plugin-react": "latest",
            vite: "latest",
            react: "latest",
            "react-dom": "latest",
          },
          devDependencies: {},
        },
        null,
        2,
      ) + "\n",
    "index.html":
      '<!doctype html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>InfiniBot App</title></head><body><div id="root"></div><script type="module" src="/src/main.jsx"></script></body></html>\n',
    "src/main.jsx":
      "import React from 'react';\nimport { createRoot } from 'react-dom/client';\nimport './styles.css';\n\nfunction App(){return <main><p>INFINIBOT TEMPLATE</p><h1>Build something remarkable.</h1><button>Start creating</button></main>}\ncreateRoot(document.getElementById('root')).render(<App/>);\n",
    "src/styles.css":
      ":root{font-family:Inter,system-ui;color:#f7edd0;background:#090806}*{box-sizing:border-box}body{margin:0}main{min-height:100vh;display:grid;place-content:center;text-align:center;padding:2rem;background:radial-gradient(circle at 50% 20%,#493b16 0,transparent 35%)}p{letter-spacing:.22em;color:#d8b75b}h1{font-size:clamp(2.5rem,8vw,6rem);max-width:12ch;margin:.4em auto}button{justify-self:center;padding:.9rem 1.4rem;border:1px solid #d8b75b;border-radius:999px;background:#d8b75b;color:#151108;font-weight:800}\n",
    "vite.config.js":
      "import { defineConfig } from 'vite';\nimport react from '@vitejs/plugin-react';\nexport default defineConfig({plugins:[react()]});\n",
  },
  next: {
    "package.json":
      JSON.stringify(
        {
          scripts: { dev: "next dev", build: "next build", start: "next start" },
          dependencies: { next: "latest", react: "latest", "react-dom": "latest" },
        },
        null,
        2,
      ) + "\n",
    "app/layout.jsx":
      "import './globals.css';\nexport const metadata={title:'InfiniBot App'};\nexport default function Layout({children}){return <html lang=\"en\"><body>{children}</body></html>}\n",
    "app/page.jsx":
      "export default function Page(){return <main><span>INFINIBOT TEMPLATE</span><h1>Your next idea, live.</h1><button>Start building</button></main>}\n",
    "app/globals.css":
      "*{box-sizing:border-box}body{margin:0;background:#080705;color:#f4ead0;font-family:Inter,system-ui}main{min-height:100vh;display:grid;place-content:center;text-align:center;padding:2rem}span{color:#d8b75b;letter-spacing:.2em}h1{font-size:clamp(3rem,8vw,7rem);max-width:10ch;margin:.35em auto}button{justify-self:center;border:1px solid #d8b75b;border-radius:2rem;padding:1rem 1.5rem;background:transparent;color:#d8b75b}\n",
  },
  html: {
    "index.html":
      '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>InfiniBot Site</title><link rel="stylesheet" href="/styles.css"></head><body><main><span>INFINIBOT TEMPLATE</span><h1>From prompt to production.</h1><button id="cta">Make it yours</button></main><script src="/app.js"></script></body></html>\n',
    "styles.css":
      "*{box-sizing:border-box}body{margin:0;background:#090806;color:#f7edd0;font-family:Inter,system-ui}main{min-height:100vh;display:grid;place-content:center;text-align:center;padding:2rem;background:radial-gradient(circle at top,#443713,transparent 40%)}span{color:#d8b75b;letter-spacing:.2em}h1{font-size:clamp(3rem,9vw,7rem);max-width:11ch;margin:.4em auto}button{justify-self:center;padding:1rem 1.5rem;border:1px solid #d8b75b;border-radius:999px;background:#d8b75b;color:#151108;font-weight:800}\n",
    "app.js":
      "document.querySelector('#cta').addEventListener('click',()=>document.querySelector('h1').textContent='Now make it unforgettable.');\n",
  },
  astro: {
    "package.json":
      JSON.stringify(
        {
          scripts: { dev: "astro dev", build: "astro build", preview: "astro preview" },
          dependencies: { astro: "latest" },
        },
        null,
        2,
      ) + "\n",
    "src/pages/index.astro":
      '---\nconst title=\'Build at the speed of thought.\';\n---\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>InfiniBot Astro</title></head><body><main><span>INFINIBOT TEMPLATE</span><h1>{title}</h1><button>Start creating</button></main></body></html><style>body{margin:0;background:#090806;color:#f7edd0;font-family:Inter,system-ui}main{min-height:100vh;display:grid;place-content:center;text-align:center}span{color:#d8b75b;letter-spacing:.2em}h1{font-size:clamp(3rem,9vw,7rem);max-width:10ch;margin:.4em auto}button{justify-self:center;padding:1rem 1.5rem;border:1px solid #d8b75b;border-radius:2rem;background:transparent;color:#d8b75b}</style>\n',
  },
};

export function listWorkspaceTemplates() {
  return [
    { id: "react-vite" as const, name: "React + Vite", description: "Fast React starter with HMR" },
    { id: "next" as const, name: "Next.js", description: "App Router starter" },
    { id: "html" as const, name: "Plain HTML", description: "Zero-build static site" },
    { id: "astro" as const, name: "Astro", description: "Content-first Astro starter" },
  ];
}

export function scaffoldWorkspaceTemplate(
  rootInput: string,
  templateId: WorkspaceTemplateId,
  overwrite = false,
): { files: string[] } {
  const root = path.resolve(rootInput);
  const template = templates[templateId];
  if (!template) throw new Error(`Unknown workspace template: ${templateId}`);
  const conflicts = Object.keys(template).filter((relative) =>
    fs.existsSync(path.join(root, relative)),
  );
  if (conflicts.length && !overwrite)
    throw new Error(`Template would overwrite existing files: ${conflicts.join(", ")}`);
  const written: string[] = [];
  for (const [relative, content] of Object.entries(template)) {
    const target = path.resolve(root, relative);
    if (target !== root && !target.startsWith(root + path.sep))
      throw new Error("Template path escaped workspace root");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, "utf8");
    written.push(relative);
  }
  return { files: written };
}
