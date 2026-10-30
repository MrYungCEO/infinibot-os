import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";

const callGatewayFromCli = vi.fn(async (method: string, _opts: unknown, params?: unknown) => {
  if (method.endsWith(".get")) {
    return {
      path: "/tmp/exec-approvals.json",
      exists: true,
      hash: "hash-1",
      file: { version: 1, agents: {} },
    };
  }
  return { method, params };
});

const runtimeLogs: string[] = [];
const runtimeErrors: string[] = [];
const defaultRuntime = {
  log: (msg: string) => runtimeLogs.push(msg),
  error: (msg: string) => runtimeErrors.push(msg),
  exit: (code: number) => {
    throw new Error(`__exit__:${code}`);
  },
};

const localSnapshot = {
  path: "/tmp/local-exec-approvals.json",
  exists: true,
  raw: "{}",
  hash: "hash-local",
  file: { version: 1, agents: {} },
};

vi.mock("./gateway-rpc.js", async () => {
  const actual = await vi.importActual<typeof import("./gateway-rpc.js")>("./gateway-rpc.js");
  return {
    ...actual,
    callGatewayFromCli: (method: string, opts: unknown, params?: unknown) =>
      callGatewayFromCli(method, opts, params),
  };
});

vi.mock("./nodes-cli/rpc.js", async () => {
  const actual = await vi.importActual<typeof import("./nodes-cli/rpc.js")>("./nodes-cli/rpc.js");
  return {
    ...actual,
    resolveNodeId: vi.fn(async () => "node-1"),
  };
});

vi.mock("../runtime.js", () => ({
  defaultRuntime,
}));

vi.mock("../infra/exec-approvals.js", async () => {
  const actual = await vi.importActual<typeof import("../infra/exec-approvals.js")>(
    "../infra/exec-approvals.js",
  );
  return {
    ...actual,
    readExecApprovalsSnapshot: () => localSnapshot,
    saveExecApprovals: vi.fn(),
  };
});

describe("exec approvals CLI", () => {
  it("loads local approvals by default", async () => {
    runtimeLogs.length = 0;
    runtimeErrors.length = 0;
    callGatewayFromCli.mockClear();

    const { registerExecApprovalsCli } = await import("./exec-approvals-cli.js");
    const program = new Command();
    program.exitOverride();
    registerExecApprovalsCli(program);

    await program.parseAsync(["approvals", "get"], { from: "user" });

    expect(callGatewayFromCli).not.toHaveBeenCalled();
    expect(runtimeErrors).toHaveLength(0);
  });

  it("loads gateway approvals when --gateway is set", async () => {
    runtimeLogs.length = 0;
    runtimeErrors.length = 0;
    callGatewayFromCli.mockClear();

    const { registerExecApprovalsCli } = await import("./exec-approvals-cli.js");
    const program = new Command();
    program.exitOverride();
    registerExecApprovalsCli(program);

    await program.parseAsync(["approvals", "get", "--gateway"], { from: "user" });

    expect(callGatewayFromCli).toHaveBeenCalledWith("exec.approvals.get", expect.anything(), {});
    expect(runtimeErrors).toHaveLength(0);
  });

  it("loads node approvals when --node is set", async () => {
    runtimeLogs.length = 0;
    runtimeErrors.length = 0;
    callGatewayFromCli.mockClear();

    const { registerExecApprovalsCli } = await import("./exec-approvals-cli.js");
    const program = new Command();
    program.exitOverride();
    registerExecApprovalsCli(program);

    await program.parseAsync(["approvals", "get", "--node", "macbook"], { from: "user" });

    expect(callGatewayFromCli).toHaveBeenCalledWith("exec.approvals.node.get", expect.anything(), {
      nodeId: "node-1",
    });
    expect(runtimeErrors).toHaveLength(0);
  });

  it("defaults allowlist add to wildcard agent", async () => {
    runtimeLogs.length = 0;
    runtimeErrors.length = 0;
    callGatewayFromCli.mockClear();

    const execApprovals = await import("../infra/exec-approvals.js");
    const saveExecApprovals = vi.mocked(execApprovals.saveExecApprovals);
    saveExecApprovals.mockClear();

    const { registerExecApprovalsCli } = await import("./exec-approvals-cli.js");
    const program = new Command();
    program.exitOverride();
    registerExecApprovalsCli(program);

    await program.parseAsync(["approvals", "allowlist", "add", "/usr/bin/uname"], { from: "user" });

    expect(callGatewayFromCli).not.toHaveBeenCalledWith(
      "exec.approvals.set",
      expect.anything(),
      {},
    );
    expect(saveExecApprovals).toHaveBeenCalledWith(
      expect.objectContaining({
        agents: expect.objectContaining({
          "*": expect.anything(),
        }),
      }),
    );
  });

  it("approvals approve/redirect resolve unified approvals via approvals.resolve", async () => {
    runtimeLogs.length = 0;
    runtimeErrors.length = 0;
    callGatewayFromCli.mockClear();
    callGatewayFromCli.mockImplementationOnce(async () => ({
      ok: true,
      record: { status: "approved", title: "fly deploy" },
    }));
    const { registerExecApprovalsCli } = await import("./exec-approvals-cli.js");
    const program = new Command();
    program.exitOverride();
    registerExecApprovalsCli(program);
    await program.parseAsync(["approvals", "approve", "apr_1", "--note", "after 6pm"], {
      from: "user",
    });
    expect(callGatewayFromCli).toHaveBeenCalledWith("approvals.resolve", expect.anything(), {
      id: "apr_1",
      action: "approve",
      note: "after 6pm",
      via: "cli",
    });
    expect(runtimeLogs.join("\n")).toContain("approved: fly deploy");

    // redirect without --note is refused before any RPC
    callGatewayFromCli.mockClear();
    await expect(
      program.parseAsync(["approvals", "redirect", "apr_2"], { from: "user" }),
    ).rejects.toThrow("__exit__:1");
    expect(callGatewayFromCli).not.toHaveBeenCalled();
    expect(runtimeErrors.join("\n")).toContain("--note is required");
  });
});
