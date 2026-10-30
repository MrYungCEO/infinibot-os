import { Command } from "commander";
import { describe, expect, it } from "vitest";

import { addGatewayRunCommand, resolveGatewayRunOpts } from "./run.js";

function build(capture: (opts: Record<string, unknown>) => void) {
  const program = new Command().exitOverride();
  // Same shape as register.ts: `gateway` and `gateway run` share options.
  const gateway = addGatewayRunCommand(program.command("gateway"));
  const run = addGatewayRunCommand(gateway.command("run"));
  for (const cmd of [gateway, run]) {
    cmd.action((_o, c: Command) => capture(resolveGatewayRunOpts(c)));
  }
  return program;
}

describe("gateway run options", () => {
  it("honours --port typed after `run` (commander gives it to the parent)", () => {
    let opts: Record<string, unknown> = {};
    build((o) => (opts = o)).parse([
      "node",
      "infinibot",
      "gateway",
      "run",
      "--port",
      "19431",
      "--bind",
      "loopback",
    ]);
    expect(opts.port).toBe("19431");
    expect(opts.bind).toBe("loopback");
  });

  it("still works for `gateway --port` and leaves untyped options alone", () => {
    let opts: Record<string, unknown> = {};
    build((o) => (opts = o)).parse(["node", "infinibot", "gateway", "--port", "19432"]);
    expect(opts.port).toBe("19432");
    build((o) => (opts = o)).parse(["node", "infinibot", "gateway", "run"]);
    expect(opts.port).toBeUndefined();
  });
});
