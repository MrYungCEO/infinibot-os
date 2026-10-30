import { createHash } from "node:crypto";
import { promises as fs, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const HASH_FILE = path.join(ROOT_DIR, "src/canvas-host/a2ui/.bundle.hash");
const OUTPUT_FILE = path.join(ROOT_DIR, "src/canvas-host/a2ui/a2ui.bundle.js");
const A2UI_RENDERER_DIR = path.join(ROOT_DIR, "vendor/a2ui/renderers/lit");
const A2UI_APP_DIR = path.join(ROOT_DIR, "apps/shared/ClawdbotKit/Tools/CanvasA2UI");

if (!existsSync(A2UI_RENDERER_DIR) || !existsSync(A2UI_APP_DIR)) {
    // Sources missing. Two cases:
    //   1. A prebuilt bundle is already on disk — keep it (the canonical
    //      release path: bundle is committed and vendor sources are
    //      gitignored).
    //   2. Neither sources nor a prebuilt bundle exist — write a no-op stub
    //      so the rest of `pnpm build` (canvas-a2ui-copy, tsc) doesn't fail
    //      on a clean checkout. Canvas-A2UI is a runtime feature; the stub
    //      keeps it lazy-loadable without crashing the build.
    if (existsSync(OUTPUT_FILE)) {
        console.log("A2UI sources missing; keeping prebuilt bundle.");
        process.exit(0);
    }
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });
    const stub =
        "// Auto-generated stub: A2UI vendor sources not present in this checkout.\n" +
        "// Canvas-A2UI features will be unavailable at runtime. To enable, vendor the\n" +
        "// renderer sources under vendor/a2ui/renderers/lit and rerun `pnpm canvas:a2ui:bundle`.\n" +
        "export const A2UI_BUNDLE_AVAILABLE = false;\n" +
        "export default null;\n";
    writeFileSync(OUTPUT_FILE, stub);
    if (!existsSync(path.join(path.dirname(OUTPUT_FILE), "index.html"))) {
        writeFileSync(
            path.join(path.dirname(OUTPUT_FILE), "index.html"),
            "<!doctype html><meta charset=utf-8><title>Canvas A2UI unavailable</title><p>This build does not include Canvas-A2UI. Vendor the sources to enable.</p>\n",
        );
    }
    console.log("A2UI sources missing; wrote stub bundle for build to proceed.");
    process.exit(0);
}

const lockFile = existsSync(path.join(ROOT_DIR, "pnpm-lock.yaml"))
    ? path.join(ROOT_DIR, "pnpm-lock.yaml")
    : path.join(ROOT_DIR, "package-lock.json");

const INPUT_PATHS = [
    path.join(ROOT_DIR, "package.json"),
    lockFile,
    A2UI_RENDERER_DIR,
    A2UI_APP_DIR,
].filter(p => existsSync(p));

async function walk(entryPath, files = []) {
    const st = await fs.stat(entryPath);
    if (st.isDirectory()) {
        const entries = await fs.readdir(entryPath);
        for (const entry of entries) {
            await walk(path.join(entryPath, entry), files);
        }
        return files;
    }
    files.push(entryPath);
    return files;
}

async function computeHash() {
    const allFiles = [];
    for (const input of INPUT_PATHS) {
        await walk(input, allFiles);
    }

    const normalize = (p) => p.split(path.sep).join("/");
    allFiles.sort((a, b) => normalize(a).localeCompare(normalize(b)));

    const hash = createHash("sha256");
    for (const filePath of allFiles) {
        const rel = normalize(path.relative(ROOT_DIR, filePath));
        hash.update(rel);
        hash.update("\0");
        hash.update(await fs.readFile(filePath));
        hash.update("\0");
    }
    return hash.digest("hex");
}

async function main() {
    const currentHash = await computeHash();
    if (existsSync(HASH_FILE)) {
        const previousHash = await fs.readFile(HASH_FILE, "utf8");
        if (previousHash.trim() === currentHash && existsSync(OUTPUT_FILE)) {
            console.log("A2UI bundle up to date; skipping.");
            process.exit(0);
        }
    }

    console.log("Bundling A2UI...");

    const tscResult = spawnSync("pnpm", ["exec", "tsc", "-p", path.join(A2UI_RENDERER_DIR, "tsconfig.json")], {
        stdio: "inherit",
        shell: true
    });
    if (tscResult.status !== 0) {
        console.error("A2UI bundling failed: tsc failed");
        process.exit(1);
    }

    const rolldownResult = spawnSync("pnpm", ["exec", "rolldown", "-c", path.join(A2UI_APP_DIR, "rolldown.config.mjs")], {
        stdio: "inherit",
        shell: true
    });
    if (rolldownResult.status !== 0) {
        console.error("A2UI bundling failed: rolldown failed");
        process.exit(1);
    }

    await fs.mkdir(path.dirname(HASH_FILE), { recursive: true });
    await fs.writeFile(HASH_FILE, currentHash);
    console.log("A2UI bundle updated.");
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
