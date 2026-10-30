import { describe, expect, it } from "vitest";
import { archivePatchToNotion } from "./kanban.js";

describe("archivePatchToNotion", () => {
  it("maps archived booleans to the Notion Archive checkbox", () => {
    expect(archivePatchToNotion({ archived: true })).toEqual({ Archive: { checkbox: true } });
    expect(archivePatchToNotion({ archived: false })).toEqual({ Archive: { checkbox: false } });
  });
  it("ignores missing or non-boolean values", () => {
    expect(archivePatchToNotion({})).toEqual({});
    expect(archivePatchToNotion({ archived: "yes" })).toEqual({});
    expect(archivePatchToNotion({ archived: null })).toEqual({});
  });
});
