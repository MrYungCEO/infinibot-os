import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const here = path.dirname(new URL(import.meta.url).pathname);
const views = path.resolve(here, "../../..");
const read = (name: string) => fs.readFileSync(path.join(views, name), "utf8");
const viewFiles = ["logs.ts", "debug.ts", "instances.ts", "nodes.ts"];
const sharedThemeVars = new Set([
  "--bg-content",
  "--bg-elevated",
  "--bg-hover",
  "--bg-muted",
  "--border",
  "--border-strong",
  "--card",
  "--card-foreground",
  "--input",
  "--shadow-md",
  "--shadow-sm",
  "--shadow-xl",
]);

describe("operations pages", () => {
  it("mounts every redesigned view inside the shared, page-scoped glass system", () => {
    for (const file of viewFiles) {
      const source = read(file);
      expect(source, file).toContain("ops-page");
      expect(source, file).toContain("renderOpsSharedStyles()");
    }
  });

  it("uses the existing global token vocabulary without private color tokens", () => {
    for (const file of ["ops-glass.ts", ...viewFiles]) {
      const source = read(file);
      const vars = [...source.matchAll(/var\((--[\w-]+)/g)].map((match) => match[1]);
      expect(vars.length, file).toBeGreaterThan(0);
      expect(
        vars.filter((name) => !name.startsWith("--g-") && !sharedThemeVars.has(name)),
        file,
      ).toEqual([]);
      expect(source, file).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    }
  });

  it("has explicit phone, reduced-motion, and reduced-transparency fallbacks", () => {
    const shared = read("ops-glass.ts");
    expect(shared).toContain("@media (max-width: 600px)");
    expect(shared).toContain("prefers-reduced-motion: reduce");
    expect(shared).toContain("prefers-reduced-transparency: reduce");
    for (const file of viewFiles) {
      expect(read(file), file).toMatch(/@media\s*\(max-width:\s*390px\)/);
    }
  });

  it("preserves the operational callbacks and guided-tour anchors", () => {
    const logs = read("logs.ts");
    expect(logs).toContain("props.onScroll");
    expect(logs).toContain("props.onExport");
    expect(logs).toContain("props.onToggleAutoFollow(true)");

    const debug = read("debug.ts");
    expect(debug).toContain("props.onCall");
    expect(debug).toContain("props.onRefresh");

    const instances = read("instances.ts");
    expect(instances).toContain("props.onContextMenu");
    expect(instances).toContain("props.onAssignToProject");
    expect(instances).toContain("props.onUnassignFromProject");

    const nodes = read("nodes.ts");
    expect(nodes).toContain('data-learn-id="nodes-list"');
    expect(nodes).toContain('data-learn-id="nodes-devices"');
    expect(nodes).toContain('data-learn-id="nodes-exec-approvals"');
    expect(nodes).toContain("props.onDeviceApprove");
    expect(nodes).toContain("props.onSaveExecApprovals");
  });

  it("uses inline SVG icons rather than emoji or dingbat glyphs", () => {
    const glyphs = /[\u{1F000}-\u{1FAFF}\u{2190}-\u{27BF}]/u;
    for (const file of ["ops-glass.ts", ...viewFiles]) {
      expect(read(file), file).not.toMatch(glyphs);
    }
    expect(read("ops-glass.ts")).toContain("const ICON_PATHS");
    expect(read("ops-glass.ts")).toContain('stroke="currentColor"');
  });

  it("exposes a shared accessible telemetry rail and live-state semantics", () => {
    const shared = read("ops-glass.ts");
    expect(shared).toContain("renderOpsTelemetryRail");
    expect(shared).toContain('role="list"');
    expect(shared).toContain('role="listitem"');
    expect(shared).toContain("ops-telemetry-rail");

    for (const file of viewFiles) {
      const source = read(file);
      expect(source, file).toContain("renderOpsTelemetryRail");
      expect(source, file).toContain("aria-busy");
    }
    expect(read("logs.ts")).toContain('aria-relevant="additions text"');
    expect(read("debug.ts")).toContain('role="alert"');
    expect(read("instances.ts")).toContain('aria-label="${entry.host');
  });
});
