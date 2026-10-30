import { describe, expect, it } from "vitest";
import { describeToolActivity, formatElapsed, toolProgress } from "./tool-activity";

describe("describeToolActivity", () => {
  it("gives FlyPic generations a friendly name, provider and media skeleton", () => {
    expect(describeToolActivity("flypic_generate_image")).toMatchObject({ label: "Generating image", doneLabel: "Image generated", provider: "FlyPic", media: "image" });
    expect(describeToolActivity("flypic_generate_video")).toMatchObject({ media: "video", typicalSeconds: expect.any(Number) });
    expect(describeToolActivity("flypic_find_reference").label).toBe("Finding reference photos");
  });

  it("humanizes unknown tools", () => {
    expect(describeToolActivity("mcp__infinibot__droid_swarm")).toEqual({ label: "Using droid swarm", doneLabel: "Used droid swarm" });
    expect(describeToolActivity("crm.update")).toMatchObject({ label: "Using crm update" });
  });
});

describe("toolProgress", () => {
  it("eases toward 92% and never claims done", () => {
    expect(toolProgress(0, 30)).toBe(0);
    const early = toolProgress(5_000, 30);
    const late = toolProgress(30_000, 30);
    expect(early).toBeGreaterThan(0);
    expect(late).toBeGreaterThan(early);
    expect(toolProgress(10 * 60_000, 30)).toBeLessThanOrEqual(92);
    expect(toolProgress(5_000, 0)).toBe(0);
  });

  it("formats elapsed time", () => {
    expect(formatElapsed(4_200)).toBe("4s");
    expect(formatElapsed(125_000)).toBe("2m 05s");
  });
});
