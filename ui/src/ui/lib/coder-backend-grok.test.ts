import { describe, expect, it } from "vitest";
import {
  ALL_BACKEND_IDS,
  BACKEND_DISPLAY,
  isCoderBackendId,
  mapBackendToUiCli,
  mapUiCliToBackend,
} from "./coder-backend-id";
import {
  ALL_CODER_BACKEND_IDS,
  getCoderBackendBrand,
  getCoderBackendIcon,
  getCoderBackendIconLabel,
} from "./coder-backend-brand";
import { CLI_CONFIGS } from "../controllers/terminals";

describe("Grok Build in the UI coder vocabulary", () => {
  it("is a selectable coder backend (voice <agent-cli-selector>, coder toggle)", () => {
    expect(ALL_BACKEND_IDS).toContain("grok");
    expect(BACKEND_DISPLAY.grok).toBe("Grok Build");
    expect(isCoderBackendId("grok")).toBe(true);
    expect(mapBackendToUiCli("grok")).toBe("grok");
    expect(mapUiCliToBackend("grok")).toBe("grok");
  });

  it("has its own brand + glyph (activity feed, mesh badges)", () => {
    expect(ALL_CODER_BACKEND_IDS).toContain("grok");
    expect(getCoderBackendBrand("grok").label).toBe("Grok Build");
    expect(getCoderBackendIcon("grok")).not.toBeNull();
    expect(getCoderBackendIconLabel("grok-cli")).toBe("Grok Build");
  });

  it("is a terminal quick-launch CLI", () => {
    expect(CLI_CONFIGS.grok.command).toBe("grok");
  });
});
