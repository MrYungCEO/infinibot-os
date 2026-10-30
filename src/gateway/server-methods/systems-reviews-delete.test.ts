/**
 * `systems.reviews.delete` — the reviews family served list/get/create but no
 * delete, so the delete button in the Systems Intelligence view always errored.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const deleteReview = vi.fn();

vi.mock("../../systems-intelligence/store.js", () => ({
  getSystemsIntelligenceStore: () => ({ deleteReview }),
}));

const { systemsIntelligenceHandlers } = await import("./systems-intelligence.js");

type Reply = { ok: boolean; payload?: any; error?: any };

async function call(params: Record<string, unknown>): Promise<Reply> {
  const handler = systemsIntelligenceHandlers["systems.reviews.delete"];
  let reply: Reply | undefined;
  await handler!({
    params,
    respond: (ok: boolean, payload?: unknown, error?: unknown) => {
      reply = { ok, payload, error };
    },
  } as any);
  return reply!;
}

beforeEach(() => deleteReview.mockReset());

describe("systems.reviews.delete", () => {
  it("deletes an existing review", async () => {
    deleteReview.mockReturnValue(true);

    const res = await call({ id: "r1" });

    expect(res.ok).toBe(true);
    expect(res.payload).toEqual({ deleted: true, id: "r1" });
    expect(deleteReview).toHaveBeenCalledWith("r1");
  });

  it("404s when nothing was deleted — matching the other systems.*.delete handlers", async () => {
    deleteReview.mockReturnValue(false);

    const res = await call({ id: "ghost" });

    expect(res.ok).toBe(false);
    expect(res.error).toMatchObject({ code: "NOT_FOUND" });
  });

  it("requires an id", async () => {
    const res = await call({});
    expect(res.ok).toBe(false);
    expect(res.error).toMatchObject({ code: "INVALID_REQUEST" });
    expect(deleteReview).not.toHaveBeenCalled();
  });
});
