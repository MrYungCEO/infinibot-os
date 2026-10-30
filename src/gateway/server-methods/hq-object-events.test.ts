import { describe, expect, it, vi } from "vitest";
import { withHqObjectBroadcast } from "./hq-object-events.js";

function run(handlers: any, method: string, params: Record<string, unknown>) {
  const broadcast = vi.fn();
  const respond = vi.fn();
  return Promise.resolve(handlers[method]({ params, respond, context: { broadcast } })).then(
    () => ({ broadcast, respond }),
  );
}

describe("withHqObjectBroadcast", () => {
  const raw = {
    "commitment.update": ({ params, respond }: any) =>
      params.fail
        ? respond(false, undefined, { code: "X", message: "no" })
        : respond(true, { id: params.id, status: "met" }),
    "commitment.list": ({ respond }: any) => respond(true, { commitments: [] }),
  };
  const h = withHqObjectBroadcast("commitment", raw as any, ["commitment.update"]);

  it("broadcasts hq.object.changed after a successful write (and still answers)", async () => {
    const { broadcast, respond } = await run(h, "commitment.update", { id: "c1" });
    expect(respond).toHaveBeenCalledWith(true, { id: "c1", status: "met" }, undefined, undefined);
    expect(broadcast).toHaveBeenCalledWith(
      "hq.object.changed",
      { kind: "commitment", op: "update", id: "c1" },
      { dropIfSlow: true },
    );
  });

  it("no broadcast for failed writes or reads", async () => {
    expect(
      (await run(h, "commitment.update", { id: "c1", fail: true })).broadcast,
    ).not.toHaveBeenCalled();
    expect((await run(h, "commitment.list", {})).broadcast).not.toHaveBeenCalled();
  });
});
