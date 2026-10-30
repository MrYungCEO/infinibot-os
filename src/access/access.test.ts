import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { authorizeUserMethod, buildAccessContext, isOwnSessionKey, type Lookups } from "./authz.js";
import { totpCode, verifyTotp, newTotpSecret, verifyPassword, hashPassword } from "./crypto.js";
import { userMayReceiveEvent } from "./events.js";
import { resolvePermissions } from "./policy.js";
import { AccessStore, inviteStatus } from "./store.js";

let dir: string;
let store: AccessStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ib-access-"));
  store = new AccessStore(dir);
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function seed() {
  const A = store.createWorkspace({ name: "Workspace A" });
  const B = store.createWorkspace({ name: "Workspace B" });
  store.assign("projects", "proj-a", A.id);
  store.assign("projects", "proj-b", B.id);
  store.assign("documents", "folder-a", A.id);
  store.assign("documents", "doc-b", B.id);
  store.assign("reports", "rep-a", A.id);
  store.assign("agents", "main", A.id);
  return { A, B };
}

const lookups: Lookups = {
  taskProjectId: async (id) => ({ "task-a": "proj-a", "task-b": "proj-b" })[id] ?? null,
  documentParents: async () =>
    new Map<string, string | null>([
      ["folder-a", null],
      ["doc-a1", "folder-a"],
      ["doc-b", null],
      ["secret-doc", null],
    ]),
};

async function decide(userId: string, method: string, params: Record<string, unknown> = {}) {
  const user = store.getUser(userId)!;
  const ctx = buildAccessContext(store, user);
  return authorizeUserMethod(method, params, store, ctx, lookups);
}

async function list(userId: string, method: string, payload: unknown, params = {}) {
  const d = await decide(userId, method, params);
  if (!d.ok) throw new Error(`denied: ${d.reason}`);
  return d.transform ? d.transform(payload) : payload;
}

describe("crypto", () => {
  it("hashes and verifies passwords", () => {
    const h = hashPassword("correct horse");
    expect(verifyPassword("correct horse", h)).toBe(true);
    expect(verifyPassword("wrong", h)).toBe(false);
    expect(h.startsWith("scrypt$")).toBe(true);
  });
  it("TOTP round-trips and rejects stale codes", () => {
    const secret = newTotpSecret();
    const t = 1_700_000_000_000;
    expect(verifyTotp(secret, totpCode(secret, t), t)).toBe(true);
    expect(verifyTotp(secret, totpCode(secret, t - 30_000), t)).toBe(true);
    expect(verifyTotp(secret, totpCode(secret, t - 120_000), t)).toBe(false);
    // RFC 6238 test vector (SHA-1, T=59 → 94287082, last 6 digits).
    const rfcSecret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
    expect(totpCode(rfcSecret, 59_000)).toBe("287082");
  });
});

describe("authz matrix", () => {
  it("denies by default: unknown / owner-only methods", async () => {
    const { A } = seed();
    const u = store.createUser({ username: "vee", password: "password1", role: "viewer" });
    store.setMember(A.id, u.id, null, {});
    for (const m of [
      "config.get",
      "config.patch",
      "secure.status",
      "sessions.delete",
      "exec.approvals.set",
      "access.overview",
      "made.up",
    ]) {
      expect((await decide(u.id, m)).ok, m).toBe(false);
    }
  });

  it("viewer in A sees only A's projects, docs and reports; cannot edit", async () => {
    const { A } = seed();
    const u = store.createUser({ username: "vee", password: "password1", role: "viewer" });
    store.setMember(A.id, u.id, null, {});

    const projects = await list(u.id, "kanban.projects.list", [
      { id: "proj-a" },
      { id: "proj-b" },
      { id: "owner-only" },
    ]);
    expect(projects).toEqual([{ id: "proj-a" }]);

    const tree = (await list(u.id, "documents.tree", {
      nodes: [
        { id: "folder-a", parentId: null },
        { id: "doc-a1", parentId: "folder-a" },
        { id: "doc-b", parentId: null },
        { id: "secret-doc", parentId: null },
      ],
      count: 4,
    })) as { nodes: { id: string }[]; count: number };
    expect(tree.nodes.map((n) => n.id)).toEqual(["folder-a", "doc-a1"]);
    expect(tree.count).toBe(2);

    const reports = (await list(u.id, "reports.list", {
      reports: [{ id: "rep-a" }, { id: "rep-x" }],
      total: 2,
    })) as {
      reports: unknown[];
    };
    expect(reports.reports).toEqual([{ id: "rep-a" }]);

    expect((await decide(u.id, "documents.get", { id: "doc-a1" })).ok).toBe(true); // via folder
    expect((await decide(u.id, "documents.get", { id: "doc-b" })).ok).toBe(false);
    expect((await decide(u.id, "documents.get", { id: "secret-doc" })).ok).toBe(false);
    expect((await decide(u.id, "kanban.tasks.update", { id: "task-a" })).ok).toBe(false); // viewer
    expect((await decide(u.id, "kanban.projects.create", { name: "x" })).ok).toBe(false);
    expect((await decide(u.id, "documents.update", { id: "doc-a1" })).ok).toBe(false);
    expect((await decide(u.id, "chat.send", { sessionKey: `agent:main:mu-${u.id}` })).ok).toBe(
      false,
    ); // no chat feature
  });

  it("granting edit (member allowance) applies on the next request", async () => {
    const { A } = seed();
    const u = store.createUser({ username: "vee", password: "password1", role: "viewer" });
    store.setMember(A.id, u.id, null, {});
    expect((await decide(u.id, "documents.update", { id: "doc-a1" })).ok).toBe(false);
    store.setMember(A.id, u.id, null, { resources: { documents: { edit: true } } });
    expect((await decide(u.id, "documents.update", { id: "doc-a1" })).ok).toBe(true);
    // Still nothing in B.
    expect((await decide(u.id, "documents.update", { id: "doc-b" })).ok).toBe(false);
  });

  it("member can create in their workspace; the record is assigned there", async () => {
    const { A } = seed();
    const u = store.createUser({ username: "mem", password: "password1", role: "member" });
    store.setMember(A.id, u.id, null, {});
    const d = await decide(u.id, "kanban.projects.create", { name: "New" });
    expect(d.ok).toBe(true);
    if (d.ok) d.after?.({ id: "proj-new" });
    expect(store.workspacesForResource("projects", "proj-new")).toEqual([A.id]);
    expect((await decide(u.id, "kanban.tasks.update", { id: "task-a" })).ok).toBe(true);
    expect((await decide(u.id, "kanban.tasks.update", { id: "task-b" })).ok).toBe(false);
    expect((await decide(u.id, "kanban.tasks.create", { projectId: "proj-b" })).ok).toBe(false);
  });

  it("chat: off for members by default; when granted, own sessions with an assigned agent only", async () => {
    const { A } = seed();
    const u = store.createUser({ username: "mem", password: "password1", role: "member" });
    store.setMember(A.id, u.id, null, {});
    expect((await decide(u.id, "chat.send", { sessionKey: `agent:main:mu-${u.id}` })).ok).toBe(
      false,
    );
    store.updateUser(u.id, { allowance: { features: { chat: true } } });
    expect((await decide(u.id, "chat.send", { sessionKey: `agent:main:mu-${u.id}` })).ok).toBe(
      true,
    );
    expect((await decide(u.id, "chat.send", { sessionKey: "agent:main:main" })).ok).toBe(false);
    expect((await decide(u.id, "chat.send", { sessionKey: `agent:other:mu-${u.id}` })).ok).toBe(
      false,
    );
    expect((await decide(u.id, "chat.history", { sessionKey: "agent:main:main" })).ok).toBe(false);
    const sessions = (await list(u.id, "sessions.list", {
      sessions: [{ key: "agent:main:main" }, { key: `agent:main:mu-${u.id}` }],
    })) as { sessions: { key: string }[] };
    expect(sessions.sessions.map((s) => s.key)).toEqual([`agent:main:mu-${u.id}`]);
  });

  it("feature switches: coders/finance off for members; secure never from a role", async () => {
    const { A } = seed();
    const admin = store.createUser({ username: "adm", password: "password1", role: "admin" });
    store.setMember(A.id, admin.id, null, {});
    expect((await decide(admin.id, "subagents.list")).ok).toBe(true);
    expect((await decide(admin.id, "secure.status")).ok).toBe(false);
    // Matrix trying to grant secure to a role is ignored.
    store.setRoleMatrix({ admin: { features: { secure: true } } });
    expect((await decide(admin.id, "secure.status")).ok).toBe(false);
    // Explicit user allowance grants it.
    store.updateUser(admin.id, { allowance: { features: { secure: true } } });
    expect((await decide(admin.id, "secure.status")).ok).toBe(true);

    const m = store.createUser({ username: "mem", password: "password1", role: "member" });
    store.setMember(A.id, m.id, null, {});
    expect((await decide(m.id, "subagents.list")).ok).toBe(false);
    expect((await decide(m.id, "business.income.stats")).ok).toBe(false);
  });

  it("access.* admin methods: admins yes, members no, self methods for all", async () => {
    seed();
    const admin = store.createUser({ username: "adm", password: "password1", role: "admin" });
    const m = store.createUser({ username: "mem", password: "password1", role: "member" });
    expect((await decide(admin.id, "access.overview")).ok).toBe(true);
    expect((await decide(m.id, "access.overview")).ok).toBe(false);
    expect((await decide(m.id, "access.invites.create")).ok).toBe(false);
    expect((await decide(m.id, "access.me")).ok).toBe(true);
  });

  it("workspace role overrides tighten a role in one workspace", async () => {
    const { A, B } = seed();
    const m = store.createUser({ username: "mem", password: "password1", role: "member" });
    store.setMember(A.id, m.id, null, {});
    store.setMember(B.id, m.id, null, {});
    store.updateWorkspace(B.id, {
      roleOverrides: { member: { resources: { projects: { edit: false } } } },
    });
    expect((await decide(m.id, "kanban.projects.update", { id: "proj-a" })).ok).toBe(true);
    expect((await decide(m.id, "kanban.projects.update", { id: "proj-b" })).ok).toBe(false);
  });

  it("preview sessions cannot change the previewed account", async () => {
    const { A } = seed();
    const m = store.createUser({ username: "mem", password: "password1", role: "member" });
    store.setMember(A.id, m.id, null, {});
    const ctx = buildAccessContext(store, m, { preview: true });
    expect((await authorizeUserMethod("access.me", {}, store, ctx, lookups)).ok).toBe(true);
    expect((await authorizeUserMethod("access.totp.setup", {}, store, ctx, lookups)).ok).toBe(
      false,
    );
    expect((await authorizeUserMethod("access.password.change", {}, store, ctx, lookups)).ok).toBe(
      false,
    );
    expect((await authorizeUserMethod("kanban.projects.create", {}, store, ctx, lookups)).ok).toBe(
      false,
    );
  });

  it("preview context is read-only", () => {
    const { A } = seed();
    const m = store.createUser({ username: "mem", password: "password1", role: "member" });
    store.setMember(A.id, m.id, null, {});
    const ctx = buildAccessContext(store, m, { preview: true });
    expect(ctx.workspaces[0].perms.resources.projects).toEqual({ view: true, edit: false });
    expect(ctx.workspaces[0].perms.features.chat).toBe(false);
  });

  it("resolvePermissions: owner is full, edit implies view", () => {
    expect(resolvePermissions({ role: "owner" }).features.secure).toBe(true);
    const p = resolvePermissions({
      role: "viewer",
      userAllowance: { resources: { kanban: { edit: true, view: false } } },
    });
    expect(p.resources.kanban).toEqual({ view: true, edit: true });
  });

  it("knowledge graph keeps only nodes backed by visible records", async () => {
    const { A } = seed();
    const u = store.createUser({ username: "vee", password: "password1", role: "viewer" });
    store.setMember(A.id, u.id, null, {});
    const snap = (await list(u.id, "graph.global.snapshot", {
      nodes: [
        { id: "project:proj-a", kind: "project" },
        { id: "project:proj-b", kind: "project" },
        { id: "task:task-a", kind: "task", meta: { projectId: "proj-a" } },
        { id: "client:c1", kind: "client" },
      ],
      edges: [
        { source: "task:task-a", target: "project:proj-a", rel: "in" },
        { source: "client:c1", target: "project:proj-a", rel: "x" },
      ],
      typeStats: {},
    })) as { nodes: { id: string }[]; edges: unknown[] };
    expect(snap.nodes.map((n) => n.id)).toEqual(["project:proj-a", "task:task-a"]);
    expect(snap.edges).toHaveLength(1);
  });

  it("graph.global.snapshot (project-scoped) re-prunes islands left by hidden records", async () => {
    const { A } = seed();
    const u = store.createUser({ username: "vee2", password: "password1", role: "viewer" });
    store.setMember(A.id, u.id, null, {});
    const snap = (await list(u.id, "graph.global.snapshot", {
      nodes: [
        { id: "project:proj-a", kind: "project" },
        { id: "task:task-a", kind: "task", meta: { projectId: "proj-a" } },
        { id: "client:c1", kind: "client" },
      ],
      // task-a only reaches the project through the (hidden) client.
      edges: [
        { source: "task:task-a", target: "client:c1", rel: "x" },
        { source: "client:c1", target: "project:proj-a", rel: "x" },
      ],
      typeStats: {},
      scope: { projectNodeId: "project:proj-a" },
    })) as { nodes: { id: string }[]; edges: unknown[] };
    expect(snap.nodes.map((n) => n.id)).toEqual(["project:proj-a"]);
    expect(snap.edges).toHaveLength(0);
  });
});

describe("events", () => {
  it("users only receive their own chat stream + keep-alives", () => {
    const access = {
      userId: "u1",
      username: "u",
      sessionToken: "x",
      workspaceId: null,
      preview: false,
    };
    expect(userMayReceiveEvent(access, "tick", {})).toBe(true);
    expect(userMayReceiveEvent(access, "chat", { sessionKey: "agent:main:mu-u1" })).toBe(true);
    expect(userMayReceiveEvent(access, "chat", { sessionKey: "agent:main:main" })).toBe(false);
    expect(userMayReceiveEvent(access, "kanban.changed", {})).toBe(false);
    expect(userMayReceiveEvent(access, "device.pair.requested", {})).toBe(false);
    expect(isOwnSessionKey("u1", "agent:main:mu-u1:thread:1")).toBe(true);
    expect(isOwnSessionKey("u1", "agent:main:mu-u10")).toBe(false);
  });
});

describe("invite lifecycle", () => {
  it("single-use invite creates the user with role + workspaces, then is used up", () => {
    const { A } = seed();
    const { token, invite } = store.createInvite({
      role: "viewer",
      workspaceIds: [A.id],
      maxUses: 1,
      expiresAt: Date.now() + 3600_000,
      createdBy: "owner",
    });
    expect(inviteStatus(invite)).toBe("active");
    const u = store.redeemInvite(token, { username: "newbie", password: "password1" });
    expect(u.role).toBe("viewer");
    expect(store.membershipsForUser(u.id).map((m) => m.workspaceId)).toEqual([A.id]);
    expect(inviteStatus(store.getInvite(invite.id)!)).toBe("used");
    expect(() => store.redeemInvite(token, { username: "second", password: "password1" })).toThrow(
      "invite_used",
    );
    expect(store.getUserByLogin("second")).toBeNull();
  });

  it("multi-use invites, revocation and expiry", () => {
    seed();
    const multi = store.createInvite({
      role: "member",
      workspaceIds: [],
      maxUses: null,
      expiresAt: null,
      createdBy: "owner",
    });
    store.redeemInvite(multi.token, { username: "m1", password: "password1" });
    store.redeemInvite(multi.token, { username: "m2", password: "password1" });
    expect(store.getInvite(multi.invite.id)!.uses).toBe(2);
    store.revokeInvite(multi.invite.id);
    expect(() =>
      store.redeemInvite(multi.token, { username: "m3", password: "password1" }),
    ).toThrow("invite_revoked");

    const expired = store.createInvite({
      role: "viewer",
      workspaceIds: [],
      maxUses: 1,
      expiresAt: Date.now() - 1,
      createdBy: "owner",
    });
    expect(() =>
      store.redeemInvite(expired.token, { username: "late", password: "password1" }),
    ).toThrow("invite_expired");
    expect(() =>
      store.redeemInvite("ibinv_nope", { username: "x1", password: "password1" }),
    ).toThrow("invite_invalid");
  });

  it("a taken username does not burn the invite", () => {
    store.createUser({ username: "taken", password: "password1", role: "viewer" });
    const inv = store.createInvite({
      role: "viewer",
      workspaceIds: [],
      maxUses: 1,
      expiresAt: null,
      createdBy: "owner",
    });
    expect(() =>
      store.redeemInvite(inv.token, { username: "Taken", password: "password1" }),
    ).toThrow(/taken/);
    expect(store.getInvite(inv.invite.id)!.uses).toBe(0);
  });
});

describe("sessions", () => {
  it("expire, and die on disable / password reset / removal", () => {
    const u = store.createUser({ username: "s1", password: "password1", role: "member" });
    const short = store.createSession(u.id, 1000);
    expect(store.resolveSession(short.token)?.user.id).toBe(u.id);
    expect(store.resolveSession(short.token, Date.now() + 2000)).toBeNull();
    // Expired row is deleted, so it stays dead even "back in time".
    expect(store.resolveSession(short.token)).toBeNull();

    const a = store.createSession(u.id, 3600_000);
    store.updateUser(u.id, { disabled: true });
    expect(store.resolveSession(a.token)).toBeNull();
    store.updateUser(u.id, { disabled: false });
    const b = store.createSession(u.id, 3600_000);
    store.updateUser(u.id, { password: "password2" });
    expect(store.resolveSession(b.token)).toBeNull();
    expect(store.checkPassword(u.id, "password2")).toBe(true);
    const c = store.createSession(u.id, 3600_000);
    store.deleteUser(u.id);
    expect(store.resolveSession(c.token)).toBeNull();
  });

  it("rejects non-session tokens outright", () => {
    expect(store.resolveSession("gateway-password")).toBeNull();
    expect(store.resolveSession("ibus_unknown")).toBeNull();
  });
});
