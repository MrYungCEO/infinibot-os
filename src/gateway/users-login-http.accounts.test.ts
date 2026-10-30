import { PassThrough } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";

const profiles = vi.hoisted(() => ({ list: [{ id: "default" }] as Array<{ id: string }> }));
const users = vi.hoisted(() => ({ count: 0 }));

vi.mock("../users/profiles.js", () => ({
  listProfiles: () => ({ profiles: profiles.list, currentUserId: "default" }),
  createProfile: vi.fn(),
  switchProfile: vi.fn(),
  stampProfileCreatedAt: vi.fn(),
}));
vi.mock("../users/store.js", () => ({ getUserStore: () => ({ count: () => users.count }) }));
vi.mock("../saas/config.js", () => ({ isSaasMode: () => false }));

import { handleUsersLoginRequest, userAccountsExist } from "./users-login-http.js";

function get(url: string) {
  const req = Object.assign(new PassThrough(), {
    method: "GET",
    url,
    headers: {},
  }) as unknown as IncomingMessage;
  let status = 0;
  let body = "";
  const res = {
    writeHead: (s: number) => {
      status = s;
      return res;
    },
    end: (b?: string) => {
      body = b ?? "";
    },
    setHeader: () => {},
  } as unknown as ServerResponse;
  return { req, res, result: () => ({ status, json: body ? JSON.parse(body) : null }) };
}

describe("GET /api/users/login (accounts probe)", () => {
  beforeEach(() => {
    profiles.list = [{ id: "default" }];
    users.count = 0;
  });

  it("reports no accounts on a single-profile install", async () => {
    const { req, res, result } = get("/api/users/login");
    expect(await handleUsersLoginRequest(req, res)).toBe(true);
    expect(result()).toEqual({ status: 200, json: { accountsExist: false } });
  });

  it("reports accounts when a second profile or a user row exists", () => {
    profiles.list = [{ id: "default" }, { id: "usr_1" }];
    expect(userAccountsExist()).toBe(true);
    profiles.list = [{ id: "default" }];
    users.count = 2;
    expect(userAccountsExist()).toBe(true);
  });

  it("exposes only a boolean", async () => {
    profiles.list = [{ id: "default" }, { id: "usr_1" }];
    const { req, res, result } = get("/api/users/login");
    await handleUsersLoginRequest(req, res);
    expect(Object.keys(result().json)).toEqual(["accountsExist"]);
  });
});
