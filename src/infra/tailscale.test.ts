import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import path from "node:path";
import * as tailscale from "./tailscale.js";

const {
  ensureGoInstalled,
  ensureTailscaledInstalled,
  getTailnetHostname,
  enableTailscaleServe,
  disableTailscaleServe,
  ensureFunnel,
} = tailscale;
// getTailscaleBinary() resolves a real install when there is one, so this must
// match both the bare PATH name and a discovered absolute path (incl. Windows'
// `...\Tailscale\tailscale.exe`).
const tailscaleBin = expect.stringMatching(/tailscale(\.exe)?$/i);

describe("tailscale helpers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("parses DNS name from tailscale status", async () => {
    const exec = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({
        Self: { DNSName: "host.tailnet.ts.net.", TailscaleIPs: ["100.1.1.1"] },
      }),
    });
    const host = await getTailnetHostname(exec);
    expect(host).toBe("host.tailnet.ts.net");
  });

  it("falls back to IP when DNS missing", async () => {
    const exec = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({ Self: { TailscaleIPs: ["100.2.2.2"] } }),
    });
    const host = await getTailnetHostname(exec);
    expect(host).toBe("100.2.2.2");
  });

  it("ensureGoInstalled installs when missing and user agrees", async () => {
    const exec = vi.fn().mockRejectedValueOnce(new Error("no go")).mockResolvedValue({}); // brew install go
    const prompt = vi.fn().mockResolvedValue(true);
    const runtime = {
      error: vi.fn(),
      log: vi.fn(),
      exit: ((code: number) => {
        throw new Error(`exit ${code}`);
      }) as (code: number) => never,
    };
    await ensureGoInstalled(exec as never, prompt, runtime);
    expect(exec).toHaveBeenCalledWith("brew", ["install", "go"]);
  });

  it("ensureTailscaledInstalled installs when missing and user agrees", async () => {
    const exec = vi.fn().mockRejectedValueOnce(new Error("missing")).mockResolvedValue({});
    const prompt = vi.fn().mockResolvedValue(true);
    const runtime = {
      error: vi.fn(),
      log: vi.fn(),
      exit: ((code: number) => {
        throw new Error(`exit ${code}`);
      }) as (code: number) => never,
    };
    await ensureTailscaledInstalled(exec as never, prompt, runtime);
    expect(exec).toHaveBeenCalledWith("brew", ["install", "tailscale"]);
  });

  it("enableTailscaleServe attempts normal first, then sudo", async () => {
    // 1. First attempt fails
    // 2. Second attempt (sudo) succeeds
    vi.spyOn(tailscale, "getTailscaleBinary").mockResolvedValue("tailscale");
    const exec = vi
      .fn()
      .mockRejectedValueOnce(new Error("permission denied"))
      .mockResolvedValueOnce({ stdout: "" });

    await enableTailscaleServe(3000, exec as never);

    expect(exec).toHaveBeenNthCalledWith(
      1,
      tailscaleBin,
      expect.arrayContaining(["serve", "--bg", "--yes", "3000"]),
      expect.any(Object),
    );

    expect(exec).toHaveBeenNthCalledWith(
      2,
      "sudo",
      expect.arrayContaining(["-n", tailscaleBin, "serve", "--bg", "--yes", "3000"]),
      expect.any(Object),
    );
  });

  it("enableTailscaleServe does NOT use sudo if first attempt succeeds", async () => {
    vi.spyOn(tailscale, "getTailscaleBinary").mockResolvedValue("tailscale");
    const exec = vi.fn().mockResolvedValue({ stdout: "" });

    await enableTailscaleServe(3000, exec as never);

    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec).toHaveBeenCalledWith(
      tailscaleBin,
      expect.arrayContaining(["serve", "--bg", "--yes", "3000"]),
      expect.any(Object),
    );
  });

  it("disableTailscaleServe uses fallback", async () => {
    vi.spyOn(tailscale, "getTailscaleBinary").mockResolvedValue("tailscale");
    const exec = vi
      .fn()
      .mockRejectedValueOnce(new Error("permission denied"))
      .mockResolvedValueOnce({ stdout: "" });

    await disableTailscaleServe(exec as never);

    expect(exec).toHaveBeenCalledTimes(2);
    expect(exec).toHaveBeenNthCalledWith(
      2,
      "sudo",
      expect.arrayContaining(["-n", tailscaleBin, "serve", "reset"]),
      expect.any(Object),
    );
  });

  it("ensureFunnel uses fallback for enabling", async () => {
    // Mock exec:
    // 1. status (success)
    // 2. enable (fails)
    // 3. enable sudo (success)
    vi.spyOn(tailscale, "getTailscaleBinary").mockResolvedValue("tailscale");
    const exec = vi
      .fn()
      .mockResolvedValueOnce({ stdout: JSON.stringify({ BackendState: "Running" }) }) // status
      .mockRejectedValueOnce(new Error("permission denied")) // enable normal
      .mockResolvedValueOnce({ stdout: "" }); // enable sudo

    const runtime = {
      error: vi.fn(),
      log: vi.fn(),
      exit: vi.fn() as unknown as (code: number) => never,
    };
    const prompt = vi.fn();

    await ensureFunnel(8080, exec as never, runtime, prompt);

    // 1. status
    expect(exec).toHaveBeenNthCalledWith(
      1,
      tailscaleBin,
      expect.arrayContaining(["funnel", "status", "--json"]),
    );

    // 2. enable normal
    expect(exec).toHaveBeenNthCalledWith(
      2,
      tailscaleBin,
      expect.arrayContaining(["funnel", "--yes", "--bg", "8080"]),
      expect.any(Object),
    );

    // 3. enable sudo
    expect(exec).toHaveBeenNthCalledWith(
      3,
      "sudo",
      expect.arrayContaining(["-n", tailscaleBin, "funnel", "--yes", "--bg", "8080"]),
      expect.any(Object),
    );
  });

  it("enableTailscaleServe skips sudo on non-permission errors", async () => {
    vi.spyOn(tailscale, "getTailscaleBinary").mockResolvedValue("tailscale");
    const exec = vi.fn().mockRejectedValueOnce(new Error("boom"));

    await expect(enableTailscaleServe(3000, exec as never)).rejects.toThrow("boom");

    expect(exec).toHaveBeenCalledTimes(1);
  });

  it("enableTailscaleServe rethrows original error if sudo fails", async () => {
    vi.spyOn(tailscale, "getTailscaleBinary").mockResolvedValue("tailscale");
    const originalError = Object.assign(new Error("permission denied"), {
      stderr: "permission denied",
    });
    const exec = vi
      .fn()
      .mockRejectedValueOnce(originalError)
      .mockRejectedValueOnce(new Error("sudo: a password is required"));

    await expect(enableTailscaleServe(3000, exec as never)).rejects.toBe(originalError);

    expect(exec).toHaveBeenCalledTimes(2);
  });
});

describe("findTailscaleBinary Windows resolution", () => {
  // The Tailscale MSI does not put tailscale.exe on the machine PATH, so the
  // gateway must know the default install locations or auto-serve can never
  // work on Windows.
  const { windowsTailscaleCandidates } = tailscale.__testables;
  // path.join, so the assertions hold when the suite runs on Linux CI too.
  const join = (...parts: string[]) => path.join(...parts);

  it("includes the default Program Files install path", () => {
    const candidates = windowsTailscaleCandidates({} as NodeJS.ProcessEnv);
    expect(candidates).toContain(join("C:\\Program Files", "Tailscale", "tailscale.exe"));
  });

  it("honours ProgramFiles/LOCALAPPDATA/ProgramData and de-duplicates", () => {
    const candidates = windowsTailscaleCandidates({
      ProgramFiles: "D:\\Apps",
      ProgramW6432: "D:\\Apps",
      LOCALAPPDATA: "D:\\Local",
      ProgramData: "D:\\ProgramData",
    } as NodeJS.ProcessEnv);
    expect(candidates.filter((c) => c.startsWith("D:\\Apps"))).toHaveLength(1);
    expect(candidates).toContain(join("D:\\Local", "Tailscale", "tailscale.exe"));
    expect(candidates).toContain(join("D:\\ProgramData", "chocolatey", "bin", "tailscale.exe"));
  });
});
