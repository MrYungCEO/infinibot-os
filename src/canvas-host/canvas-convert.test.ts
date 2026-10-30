import { describe, expect, it } from "vitest";
import type { ReportRecord } from "../reports/types.js";
import { CanvasConvertError, convertToCanvas, parseCanvasSource } from "./canvas-convert.js";

const rec = (over: Partial<ReportRecord>) =>
  ({
    id: "r",
    title: "Stored title",
    config: {},
    markdownBody: null,
    markdownPath: null,
    ...over,
  }) as ReportRecord;

describe("canvas conversion (core runtime)", () => {
  it("report with a stored ReportPayload → report-walkthrough", () => {
    const report = rec({
      config: {
        payload: {
          title: "Ops weekly",
          metrics: [{ label: "Tasks", value: 12 }],
          sections: [
            { heading: "Done", body: "Shipped" },
            { heading: "Next", body: "Plan" },
          ],
        },
      },
    });
    const out = convertToCanvas({ source: "report", reportId: "r" }, { getReport: () => report });
    expect(out.mediaKind).toBe("report-walkthrough");
    expect(out.title).toBe("Ops weekly");
    expect(out.payload.nodes.length).toBe(out.payload.scenes.length);
    expect(out.payload.nodes.length).toBeGreaterThanOrEqual(3);
  });

  it("report with only a markdown parity copy", () => {
    const report = rec({ markdownBody: "# Audit\n\n## Findings\n\n- one\n\n## Fixes\n\ntwo" });
    const out = convertToCanvas({ source: "report", reportId: "r" }, { getReport: () => report });
    expect(out.title).toBe("Stored title"); // the report record names it
    expect(out.payload.scenes.length).toBeGreaterThanOrEqual(2);
  });

  it("empty or missing report → typed errors", () => {
    expect(() =>
      convertToCanvas({ source: "report", reportId: "r" }, { getReport: () => rec({}) }),
    ).toThrow(CanvasConvertError);
    try {
      convertToCanvas({ source: "report", reportId: "x" }, { getReport: () => null });
    } catch (e) {
      expect((e as CanvasConvertError).code).toBe("NOT_FOUND");
    }
  });

  it("stylized walkthrough chapters and markdown", () => {
    const w = convertToCanvas(
      parseCanvasSource({
        source: "walkthrough",
        title: "Guide",
        chapters: [{ title: "A", body: "x" }, { title: "B", body: "y" }, { bad: 1 }],
      }),
    );
    expect(w.mediaKind).toBe("stylized-walkthrough");
    expect(w.title).toBe("Guide");
    const m = convertToCanvas(
      parseCanvasSource({
        source: "markdown",
        markdown: "## One\n\nx\n\n## Two\n\ny",
        title: "Md",
      }),
    );
    expect(m.mediaKind).toBe("infinite-canvas-walkthrough");
    expect(m.payload.title).toBe("Md");
    expect(m.payload.scenes.length).toBe(2);
  });

  it("rejects bad params", () => {
    for (const bad of [
      {},
      { source: "report" },
      { source: "markdown", markdown: " " },
      { source: "walkthrough", chapters: [] },
    ]) {
      expect(() => parseCanvasSource(bad)).toThrow(CanvasConvertError);
    }
  });
});

describe("converted cards use the fields the overlay renderer draws", () => {
  it("report: title card h1, metrics stats card, text sections h2, stats sections kicker", () => {
    const report = rec({
      config: {
        payload: {
          title: "Ops",
          eyebrow: "Weekly",
          metrics: [{ label: "Tasks", value: 3 }],
          sections: [
            { heading: "Done", body: "Shipped" },
            { heading: "By team", table: { columns: ["t", "n"], rows: [["a", 4]] } },
          ],
        },
      },
    });
    const { payload } = convertToCanvas(
      { source: "report", reportId: "r" },
      { getReport: () => report },
    );
    const [title, metrics, text, stats] = payload.nodes;
    expect(title).toMatchObject({ kind: "title", brand: "Weekly", h1: "Ops" });
    expect(metrics).toMatchObject({ kind: "stats", stats: [{ n: "3", l: "Tasks" }] });
    expect(text).toMatchObject({ kind: "text", h2: "Done" });
    expect(stats).toMatchObject({ kind: "stats", kicker: "By team" });
    expect(payload.scenes.map((s) => s.focusNodeId)).toEqual(payload.nodes.map((n) => n.id));
  });

  it("walkthrough: chapter cards carry h2", () => {
    const { payload } = convertToCanvas(
      parseCanvasSource({
        source: "walkthrough",
        title: "G",
        chapters: [{ title: "One", body: "x" }],
      }),
    );
    expect(payload.nodes[0]).toMatchObject({ kind: "title", h1: "G" });
    expect(payload.nodes[1]).toMatchObject({ kind: "text", h2: "One" });
  });
});
