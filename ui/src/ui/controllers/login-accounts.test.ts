import { beforeEach, describe, expect, it, vi } from "vitest";
import { _resetAccountsProbe, getAccountsProbe, probeUserAccounts } from "./login-accounts";

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("login accounts probe", () => {
  beforeEach(() => _resetAccountsProbe());

  it("reports none for a single-user install", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ accountsExist: false }) }));
    vi.stubGlobal("fetch", fetchMock);
    const onChange = vi.fn();
    probeUserAccounts("ws://localhost:18789", onChange);
    await flush();
    expect(fetchMock).toHaveBeenCalledWith("http://localhost:18789/api/users/login", expect.objectContaining({ method: "GET" }));
    expect(getAccountsProbe()).toBe("none");
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("reports exist when accounts exist, and probes once per URL", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ accountsExist: true }) }));
    vi.stubGlobal("fetch", fetchMock);
    probeUserAccounts("", () => {});
    probeUserAccounts("", () => {});
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/users/login");
    expect(getAccountsProbe()).toBe("exist");
  });

  it("stays unknown on an older gateway (405) so the account toggle remains", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 405, json: async () => ({}) })));
    probeUserAccounts("ws://x", () => {});
    await flush();
    expect(getAccountsProbe()).toBe("unknown");
  });
});
