import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { SecureLaneStore } from "./lane-store.js";
import { SecureVault, SecureVaultError } from "./vault.js";

const MARKER = "PLAINTEXT-MARKER-7f3a9c";
const dirs: string[] = [];
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "ib-secure-vault-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function grepTree(dir: string, needle: string): string[] {
  const hits: string[] = [];
  for (const f of fs.readdirSync(dir, { recursive: true }) as string[]) {
    const p = path.join(dir, f);
    if (!fs.statSync(p).isFile()) continue;
    const raw = fs.readFileSync(p);
    if (raw.includes(Buffer.from(needle))) hits.push(p);
    // also catch base64 / hex leaks of the marker
    if (raw.includes(Buffer.from(Buffer.from(needle).toString("base64").slice(0, 16)))) hits.push(`${p} (b64)`);
  }
  return hits;
}

describe("SecureVault (AES-256-GCM envelope)", () => {
  it("round-trips and never writes plaintext to disk", () => {
    const dir = tmp();
    const vault = new SecureVault(randomBytes(32), dir);
    vault.writeJson("kanban", { tasks: [{ title: MARKER }] });
    expect(vault.readJson("kanban", null)).toEqual({ tasks: [{ title: MARKER }] });
    const raw = fs.readFileSync(vault.filePath("kanban"), "utf8");
    expect(raw).not.toContain(MARKER);
    expect(JSON.parse(raw)).toMatchObject({ magic: "ibsec1", alg: "aes-256-gcm", store: "kanban" });
    expect(grepTree(dir, MARKER)).toEqual([]);
    expect(fs.statSync(vault.filePath("kanban")).mode & 0o777).toBe(0o600);
  });

  it("uses a fresh IV and data key per write", () => {
    const vault = new SecureVault(randomBytes(32), tmp());
    vault.writeJson("docs-index", { a: 1 });
    const a = fs.readFileSync(vault.filePath("docs-index"), "utf8");
    vault.writeJson("docs-index", { a: 1 });
    const b = fs.readFileSync(vault.filePath("docs-index"), "utf8");
    expect(a).not.toBe(b);
  });

  it("fails closed on a wrong key, tampering, or a file swapped between stores", () => {
    const dir = tmp();
    const key = randomBytes(32);
    const vault = new SecureVault(key, dir);
    vault.writeJson("graph", { secret: MARKER });
    expect(() => new SecureVault(randomBytes(32), dir).readJson("graph", null)).toThrow(SecureVaultError);

    const file = JSON.parse(fs.readFileSync(vault.filePath("graph"), "utf8"));
    const body = Buffer.from(file.body.data, "base64");
    body[0] ^= 0xff;
    fs.writeFileSync(vault.filePath("graph"), JSON.stringify({ ...file, body: { ...file.body, data: body.toString("base64") } }));
    expect(() => vault.readJson("graph", null)).toThrow(/authentication/);

    vault.writeJson("kanban", { x: 1 });
    fs.copyFileSync(vault.filePath("kanban"), vault.filePath("graph"));
    expect(() => vault.readJson("graph", null)).toThrow(SecureVaultError);
  });

  it("encrypts every secure-lane store (kanban, docs, graph)", () => {
    const dir = tmp();
    const lane = new SecureLaneStore(new SecureVault(randomBytes(32), dir));
    const project = lane.createProject({ name: `${MARKER}-project` });
    const task = lane.createTask({ title: `${MARKER}-task`, projectId: project.id });
    lane.createDoc({ title: `${MARKER}-doc`, content: `# ${MARKER} body` });
    const node = lane.createNode({ label: `${MARKER}-node`, kind: "person" });
    lane.link({ source: node.id, target: `secure:task:${task.id}`, rel: "owns" });
    expect(lane.counts()).toEqual({ projects: 1, tasks: 1, docs: 1, nodes: 1, edges: 1 });
    const snap = lane.snapshot();
    expect(snap.nodes.map((n) => n.label)).toContain(`${MARKER}-node`);
    expect(snap.edges).toContainEqual({ source: `secure:project:${project.id}`, target: `secure:task:${task.id}`, rel: "contains" });
    expect(fs.readdirSync(dir).length).toBeGreaterThanOrEqual(4);
    expect(grepTree(dir, MARKER)).toEqual([]);
  });

  it("seeds the secure graph once from a normal snapshot", () => {
    const lane = new SecureLaneStore(new SecureVault(randomBytes(32), tmp()));
    const res = lane.seedFromSnapshot({
      nodes: [
        { id: "project:a", kind: "project", label: "A" },
        { id: "task:b", kind: "task", label: "B" },
      ],
      edges: [{ source: "project:a", target: "task:b", rel: "contains" }],
    });
    expect(res).toMatchObject({ nodes: 2, edges: 1 });
    expect(lane.snapshot().nodes.filter((n) => n.meta?.seeded)).toHaveLength(2);
    expect(() => lane.seedFromSnapshot({ nodes: [], edges: [] })).toThrow(/one-time/);
  });
});
