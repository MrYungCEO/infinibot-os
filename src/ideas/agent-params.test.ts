import { describe, expect, it } from "vitest";

import { resolveClientParam, resolveDateParam, whenString } from "./agent-params.js";

const now = new Date(Date.UTC(2026, 9, 14, 3, 0, 0)); // Wed 14 Oct 2026, 10:00 Bangkok
const opts = { now, timeZone: "Asia/Bangkok" };
const clients = [
  { id: "c-gengu", name: "Gengu Dinosaurs Technology Co., Ltd.", aliases: ["Gengu"] },
  { id: "c-Sample-1", name: "SAMPLE Robopark" },
  { id: "c-Sample-2", name: "SAMPLE Robopark" },
  { id: "c-alan", name: "Alan" },
];

describe("resolveDateParam", () => {
  it("passes ISO, parses words, clears, rejects nonsense", () => {
    expect(resolveDateParam("2026-10-20", opts)).toEqual({ date: "2026-10-20" });
    expect(resolveDateParam("2026-10-20T15:30", opts)).toEqual({
      date: "2026-10-20",
      time: "15:30",
    });
    expect(resolveDateParam("next Friday at 3", opts)).toEqual({
      date: "2026-10-23",
      time: "15:00",
    });
    expect(resolveDateParam("end of month", opts)).toEqual({ date: "2026-10-31" });
    expect(resolveDateParam("none", opts)).toEqual({ clear: true });
    expect(resolveDateParam("", opts)).toEqual({ clear: true });
    expect(resolveDateParam(undefined, opts)).toBeUndefined();
    expect(resolveDateParam("2026-02-30", opts)).toHaveProperty("error");
    expect(resolveDateParam("whenever", opts)).toHaveProperty("error");
    expect(whenString({ date: "2026-10-20", time: "09:00" })).toBe("2026-10-20T09:00");
  });
});

describe("resolveClientParam", () => {
  it("ids, exact names and unambiguous mentions resolve; ambiguity returns candidates", async () => {
    expect(await resolveClientParam("c-alan", { clients })).toEqual({
      clientId: "c-alan",
      name: "Alan",
    });
    expect(await resolveClientParam("alan", { clients })).toEqual({
      clientId: "c-alan",
      name: "Alan",
    });
    expect(await resolveClientParam("Gengu", { clients })).toMatchObject({ clientId: "c-gengu" });
    const dup = await resolveClientParam("SAMPLE Robopark", { clients });
    expect(dup).toMatchObject({ candidates: [{ id: "c-Sample-1" }, { id: "c-Sample-2" }] });
    expect(await resolveClientParam("Nobody Inc", { clients })).toHaveProperty("error");
    expect(await resolveClientParam("none", { clients })).toEqual({ clear: true });
    expect(await resolveClientParam(undefined, { clients })).toBeUndefined();
  });
});
