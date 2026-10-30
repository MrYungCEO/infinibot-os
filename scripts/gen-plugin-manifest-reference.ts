/**
 * Regenerate docs/plugins/manifest-reference.md from the manifest field
 * catalog (src/plugins/manifest-fields.ts).
 *
 *   node --import tsx scripts/gen-plugin-manifest-reference.ts
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { renderManifestReference } from "../src/plugins/manifest-fields.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const file = path.join(root, "docs", "plugins", "manifest-reference.md");
fs.writeFileSync(file, renderManifestReference());
console.log(`wrote ${path.relative(root, file)}`);
