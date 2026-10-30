import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_LAUNCH_PERSONAS } from "./personas.js";
import { LaunchPanelStore } from "./store.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "launch-panel-personas-"));
  dirs.push(dir);
  return new LaunchPanelStore(dir);
}

describe("Launch Panel persona library", () => {
  it("loads the ten launch customer avatars by default", () => {
    const personas = tempStore().listPersonas();
    expect(personas).toHaveLength(10);
    expect(personas.map((p) => p.id)).toContain("mobile-only");
    expect(personas.map((p) => p.id)).toContain("enterprise-ops");
  });

  it("persists an editable persona", () => {
    const store = tempStore();
    const changed = { ...DEFAULT_LAUNCH_PERSONAS[0]!, budget: "$0–$25 per month", enabled: false };
    store.savePersona(changed);
    expect(store.listPersonas().find((p) => p.id === changed.id)).toMatchObject({
      budget: "$0–$25 per month",
      enabled: false,
    });
  });

  it("recovers from a corrupt state file without losing the default library", () => {
    const store = tempStore();
    fs.mkdirSync(path.dirname(store.filePath), { recursive: true });
    fs.writeFileSync(store.filePath, "{broken", "utf8");
    expect(store.listPersonas()).toHaveLength(10);
    expect(fs.readdirSync(path.dirname(store.filePath)).some((f) => f.includes(".corrupt-"))).toBe(
      true,
    );
  });

  it("writes generated credentials with owner-only permissions", () => {
    const store = tempStore();
    const accounts = store.ensureTestAccounts(
      "lp-test",
      DEFAULT_LAUNCH_PERSONAS.slice(0, 2),
      "owner@example.com",
    );
    expect(accounts[0]!.email).toContain("+kvpanel-");
    expect(store.getTestAccount("lp-test", accounts[0]!.personaId)).toEqual(accounts[0]);
    expect(store.getTestAccount("lp-other", accounts[0]!.personaId)).toBeNull();
    expect(fs.statSync(store.credentialsPath()).mode & 0o777).toBe(0o600);
  });
});
