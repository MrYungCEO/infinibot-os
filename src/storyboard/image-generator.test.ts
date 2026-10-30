import { afterEach, describe, expect, it, vi } from "vitest";

import { generateImage } from "./image-generator.js";

afterEach(() => vi.unstubAllGlobals());

describe("storyboard image backend diagnostics", () => {
  it("points at the local ComfyUI settings when no backend is available", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new Error("offline"))),
    );

    const result = await generateImage({ prompt: "test frame" });

    expect(result).toMatchObject({ success: false, backend: "auto" });
    expect(result.error).toContain("COMFY_URL");
    expect(result.error).toContain("LOCAL_IMAGE_API_URL");
    expect(result.error).not.toContain("GEMINI_API_KEY");
    expect(result.error).not.toContain("REPLICATE_API_TOKEN");
  });
});
