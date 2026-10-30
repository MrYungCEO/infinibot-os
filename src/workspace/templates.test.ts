import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { scaffoldWorkspaceTemplate } from "./templates.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("workspace templates", () => {
  it.each(["react-vite", "next", "html", "astro"] as const)(
    "scaffolds %s without overwriting existing work",
    (id) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "ib-template-"));
      roots.push(root);
      const result = scaffoldWorkspaceTemplate(root, id);
      expect(result.files.length).toBeGreaterThan(0);
      expect(() => scaffoldWorkspaceTemplate(root, id)).toThrow(/overwrite/);
    },
  );
});
