import { describe, it, expect } from "vitest";
import {
  formatDurationHuman,
  formatSubagentNotificationSummary,
  formatSubagentNotificationTitle,
  humanizeSubagentLabel,
  severityForSubagentPhase,
  subagentTaskExcerpt,
} from "./subagent-format.js";

describe("subagent-format", () => {
  describe("humanizeSubagentLabel", () => {
    it("strips coder-/runid noise + hex tail", () => {
      expect(humanizeSubagentLabel("coder-mobile-foo-bar-x9y2")).toBe("Mobile foo bar");
    });

    it("keeps clean human labels", () => {
      expect(humanizeSubagentLabel("Mobile Library glassmorphism revamp")).toBe(
        "Mobile Library glassmorphism revamp",
      );
    });

    it("falls back to the supplied default when raw is empty", () => {
      expect(humanizeSubagentLabel("", "fallback task")).toBe("fallback task");
    });

    it("handles missing input", () => {
      expect(humanizeSubagentLabel(undefined)).toBe("Sub-agent");
      expect(humanizeSubagentLabel(null)).toBe("Sub-agent");
    });
  });

  describe("subagentTaskExcerpt", () => {
    it("returns the first non-empty line and trims to maxLen", () => {
      const task =
        "  \n\n- Bullet line\nSecond line is actually useful here and has plenty of content";
      const out = subagentTaskExcerpt(task, 30);
      expect(out.length).toBeLessThanOrEqual(30);
      expect(out.startsWith("Bullet line")).toBe(true);
    });

    it("strips fenced code blocks", () => {
      const task = "```ts\nlet x = 1;\n```\nReal description here";
      expect(subagentTaskExcerpt(task, 80)).toBe("Real description here");
    });

    it("returns empty string for empty input", () => {
      expect(subagentTaskExcerpt("")).toBe("");
      expect(subagentTaskExcerpt(undefined)).toBe("");
    });
  });

  describe("formatDurationHuman", () => {
    it("formats seconds / minutes / hours", () => {
      expect(formatDurationHuman(5000)).toBe("5s");
      expect(formatDurationHuman(252000)).toBe("4m 12s");
      expect(formatDurationHuman(3_660_000)).toBe("1h 1m");
    });

    it("returns undefined for nonsense input", () => {
      expect(formatDurationHuman(0)).toBeUndefined();
      expect(formatDurationHuman(-1)).toBeUndefined();
      expect(formatDurationHuman(undefined)).toBeUndefined();
    });
  });

  describe("formatSubagentNotificationTitle", () => {
    it("produces human spawn / complete / fail strings", () => {
      expect(
        formatSubagentNotificationTitle({
          phase: "spawn",
          label: "coder-mobile-voice-federation-x9y2",
        }),
      ).toBe("Mobile voice federation — running");

      expect(
        formatSubagentNotificationTitle({
          phase: "complete",
          label: "Mobile Library glassmorphism revamp",
        }),
      ).toBe("Sub-agent finished: Mobile Library glassmorphism revamp");

      expect(
        formatSubagentNotificationTitle({
          phase: "fail",
          label: "API refactor",
        }),
      ).toBe("Sub-agent failed: API refactor");
    });
  });

  describe("formatSubagentNotificationSummary", () => {
    it("builds the completion summary from duration + files-touched", () => {
      expect(
        formatSubagentNotificationSummary({
          phase: "complete",
          durationMs: 252000,
          filesTouchedCount: 3,
        }),
      ).toBe("completed in 4m 12s · 3 files changed");
    });

    it("uses the task excerpt for spawn phase", () => {
      expect(
        formatSubagentNotificationSummary({
          phase: "spawn",
          task: "Rebuild the mobile alerts page with glassmorphism",
        }),
      ).toBe("Rebuild the mobile alerts page with glassmorphism");
    });

    it("includes a project hint when present", () => {
      expect(
        formatSubagentNotificationSummary({
          phase: "spawn",
          task: "Rebuild alerts page",
          projectHint: "Mobile",
        }),
      ).toBe("Rebuild alerts page · Mobile");
    });

    it("uses errorMessage for fail summary when no summary provided", () => {
      expect(
        formatSubagentNotificationSummary({
          phase: "fail",
          durationMs: 30_000,
          errorMessage: "Connection refused",
        }),
      ).toBe("failed after 30s · Connection refused");
    });
  });

  describe("severityForSubagentPhase", () => {
    it("maps phases + outcomes", () => {
      expect(severityForSubagentPhase("spawn")).toBe("info");
      expect(severityForSubagentPhase("complete")).toBe("success");
      expect(severityForSubagentPhase("complete", "error")).toBe("error");
      expect(severityForSubagentPhase("fail")).toBe("error");
      expect(severityForSubagentPhase("timeout")).toBe("warn");
      expect(severityForSubagentPhase("cancel")).toBe("info");
    });
  });
});
