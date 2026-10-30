import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { WebSocket } from "ws";
import {
  connectReq,
  getFreePort,
  installGatewayTestHooks,
  rpcReq,
  startGatewayServer,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

async function setMultiUser(enabled: boolean) {
  const { CONFIG_PATH } = await import("../config/config.js");
  let cfg: Record<string, unknown> = {};
  try {
    cfg = JSON.parse(await fs.readFile(CONFIG_PATH, "utf8")) as Record<string, unknown>;
  } catch {
    /* fresh */
  }
  cfg.auth = { ...(cfg.auth as object), multiUser: { enabled } };
  await fs.mkdir(path.dirname(CONFIG_PATH), { recursive: true });
  await fs.writeFile(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

const openWs = async (port: number) => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise<void>((resolve) => ws.once("open", resolve));
  return ws;
};

type Ok<T> = { ok: boolean; payload?: T; error?: { message?: string } };

describe("multi-user workspaces (gateway e2e)", () => {
  let server: Awaited<ReturnType<typeof startGatewayServer>>;
  let port: number;
  let owner: WebSocket;
  const ids: Record<string, string> = {};
  let sessionToken = "";
  let userId = "";

  beforeAll(async () => {
    port = await getFreePort();
    server = await startGatewayServer(port);
  });

  afterAll(async () => {
    owner?.close();
    await server.close();
  });

  // owner sets up workspaces A/B, data, and a viewer invite for A
  const setup = async () => {
    const a = (await rpcReq(owner, "access.workspaces.create", { name: "Workspace A" })) as Ok<{
      workspace: { id: string };
    }>;
    const b = (await rpcReq(owner, "access.workspaces.create", { name: "Workspace B" })) as Ok<{
      workspace: { id: string };
    }>;
    expect(a.ok && b.ok).toBe(true);
    ids.A = a.payload!.workspace.id;
    ids.B = b.payload!.workspace.id;

    const pa = (await rpcReq(owner, "kanban.projects.create", { name: "Alpha project" })) as Ok<{
      id: string;
    }>;
    const pb = (await rpcReq(owner, "kanban.projects.create", { name: "Beta project" })) as Ok<{
      id: string;
    }>;
    expect(pa.ok, JSON.stringify(pa.error)).toBe(true);
    ids.projA = pa.payload!.id;
    ids.projB = pb.payload!.id;
    const da = (await rpcReq(owner, "documents.create", { title: "Doc A" })) as Ok<{
      node: { id: string };
    }>;
    const db = (await rpcReq(owner, "documents.create", { title: "Doc B" })) as Ok<{
      node: { id: string };
    }>;
    expect(da.ok, JSON.stringify(da.error)).toBe(true);
    ids.docA = da.payload!.node.id;
    ids.docB = db.payload!.node.id;

    for (const [type, id, ws] of [
      ["projects", ids.projA, ids.A],
      ["projects", ids.projB, ids.B],
      ["documents", ids.docA, ids.A],
      ["documents", ids.docB, ids.B],
    ]) {
      const r = await rpcReq(owner, "access.assign", {
        resourceType: type,
        resourceId: id,
        workspaceId: ws,
      });
      expect(r.ok).toBe(true);
    }

    const inv = (await rpcReq(owner, "access.invites.create", {
      role: "viewer",
      workspaceIds: [ids.A],
      expiresInHours: 24,
      origin: `http://127.0.0.1:${port}`,
    })) as Ok<{ token: string; url: string; invite: { status: string; maxUses: number } }>;
    expect(inv.ok, JSON.stringify(inv.error)).toBe(true);
    expect(inv.payload!.invite.status).toBe("active");
    expect(inv.payload!.invite.maxUses).toBe(1);
    expect(inv.payload!.url).toContain("/?signup=ibinv_");
    ids.invite = inv.payload!.token;
  };

  // invitee signs up over HTTP; the link is single-use
  const signup = async () => {
    const { CONFIG_PATH } = await import("../config/config.js");
    const cfgNow = await fs.readFile(CONFIG_PATH, "utf8").catch(() => "(missing)");
    const info = await fetch(
      `http://127.0.0.1:${port}/api/access/invite?token=${encodeURIComponent(ids.invite)}`,
    );
    expect(info.status, `${await info.clone().text()} cfg=${cfgNow.slice(0, 300)}`).toBe(200);
    expect(await info.json()).toMatchObject({
      valid: true,
      role: "viewer",
      workspaces: ["Workspace A"],
    });

    const res = await fetch(`http://127.0.0.1:${port}/api/access/signup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ invite: ids.invite, username: "vic", password: "viewer-pass-1" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string; user: { id: string; role: string } };
    expect(body.token.startsWith("ibus_")).toBe(true);
    expect(body.user.role).toBe("viewer");
    userId = body.user.id;

    const again = await fetch(`http://127.0.0.1:${port}/api/access/signup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ invite: ids.invite, username: "vic2", password: "viewer-pass-1" }),
    });
    expect(again.status).toBe(410);

    const login = await fetch(`http://127.0.0.1:${port}/api/access/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ login: "vic", password: "viewer-pass-1" }),
    });
    expect(login.status).toBe(200);
    sessionToken = ((await login.json()) as { token: string }).token;
    const bad = await fetch(`http://127.0.0.1:${port}/api/access/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ login: "vic", password: "nope-nope" }),
    });
    expect(bad.status).toBe(401);
  };

  // viewer sees only workspace A's projects + docs, nothing owner-only
  const viewer = async () => {
    const ws = await openWs(port);
    const hello = (await connectReq(ws, { token: sessionToken, skipDefaultAuth: true })) as Ok<{
      snapshot?: { sessionDefaults?: { mainSessionKey?: string }; stateDir?: string };
      auth?: unknown;
    }>;
    expect(hello.ok, JSON.stringify(hello.error)).toBe(true);
    expect(hello.payload?.snapshot?.sessionDefaults?.mainSessionKey).toContain(`mu-${userId}`);
    expect(hello.payload?.snapshot?.stateDir).toBe("");
    expect(hello.payload?.auth).toBeUndefined(); // no device token for users

    const me = (await rpcReq(ws, "access.me")) as Ok<{
      role: string;
      workspaces: { id: string }[];
    }>;
    expect(me.payload?.role).toBe("viewer");
    expect(me.payload?.workspaces.map((w) => w.id)).toEqual([ids.A]);

    const projects = (await rpcReq(ws, "kanban.projects.list")) as Ok<{ id: string }[]>;
    expect(projects.ok, JSON.stringify(projects.error)).toBe(true);
    expect(projects.payload!.map((p) => p.id)).toEqual([ids.projA]);

    const tree = (await rpcReq(ws, "documents.tree")) as Ok<{ nodes: { id: string }[] }>;
    expect(tree.payload!.nodes.map((n) => n.id)).toEqual([ids.docA]);
    expect((await rpcReq(ws, "documents.get", { id: ids.docB })).ok).toBe(false);

    for (const m of [
      "config.get",
      "secure.status",
      "sessions.delete",
      "access.overview",
      "health",
    ]) {
      const r = await rpcReq(ws, m, {});
      expect(r.ok, m).toBe(false);
    }
    expect((await rpcReq(ws, "documents.update", { id: ids.docA, title: "edited" })).ok).toBe(
      false,
    );

    // Admin grants edit on documents in A → applies on the next request.
    const grant = await rpcReq(owner, "access.members.set", {
      workspaceId: ids.A,
      userId,
      allowance: { resources: { documents: { edit: true } } },
    });
    expect(grant.ok).toBe(true);
    const edit = await rpcReq(ws, "documents.update", { id: ids.docA, title: "edited by viewer" });
    expect(edit.ok, JSON.stringify(edit.error)).toBe(true);
    expect((await rpcReq(ws, "documents.update", { id: ids.docB, title: "nope" })).ok).toBe(false);

    // Audit trail records the denials.
    const audit = (await rpcReq(owner, "access.audit.list", { deniedOnly: true })) as Ok<{
      entries: { actor: string; method: string }[];
    }>;
    expect(audit.payload!.entries.some((e) => e.actor === "vic" && e.method === "config.get")).toBe(
      true,
    );
    ws.close();
  };

  // owner auth is unchanged; disabling the flag shuts user sessions out
  const ownerCompat = async () => {
    const o2 = await openWs(port);
    expect((await connectReq(o2)).ok).toBe(true);
    expect((await rpcReq(o2, "config.get", {})).ok).toBe(true);
    o2.close();

    await setMultiUser(false);
    const u = await openWs(port);
    const res = await connectReq(u, { token: sessionToken, skipDefaultAuth: true });
    expect(res.ok).toBe(false);
    u.close();
    const status = await fetch(`http://127.0.0.1:${port}/api/access/status`);
    expect(await status.json()).toEqual({ enabled: false });
    const o3 = await openWs(port);
    expect((await connectReq(o3)).ok).toBe(true);
    o3.close();
    await setMultiUser(true);
  };

  // revoked/removed users are cut off
  const revoked = async () => {
    const r = await rpcReq(owner, "access.users.update", { id: userId, disabled: true });
    expect(r.ok).toBe(true);
    const u = await openWs(port);
    expect((await connectReq(u, { token: sessionToken, skipDefaultAuth: true })).ok).toBe(false);
    u.close();
  };

  // The harness gives every test a fresh config + state dir, so the whole
  // owner → invite → signup → scoped view → grant → revoke flow is one test.
  test("owner invites a viewer to A; viewer sees only A; grant applies; owner auth unchanged", async () => {
    await setMultiUser(true);
    owner = await openWs(port);
    expect((await connectReq(owner)).ok).toBe(true);
    await setup();
    await signup();
    await viewer();
    await ownerCompat();
    await revoked();
  }, 120_000);
});
