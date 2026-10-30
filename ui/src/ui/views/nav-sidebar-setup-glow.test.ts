import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";

import { applySetupStatus, resetNavSetupStatusForTests, setSetupHighlightEnabled, snoozeSetupCheck } from "../controllers/nav-setup-status";
import { mergeNavSidebarState } from "../controllers/nav-sidebar";
import { renderSetupBanner } from "../components/setup-banner";
import { renderEnhancedNavSidebar } from "./nav-sidebar-enhanced";

/** Flatten a lit TemplateResult into markup (attribute bindings inlined). */
function toHtml(value: unknown): string {
  if (value === null || value === undefined || value === false || typeof value === "symbol") return "";
  if (Array.isArray(value)) return value.map(toHtml).join("");
  if (typeof value === "object" && value && "strings" in value && "values" in value) {
    const { strings, values } = value as { strings: readonly string[]; values: unknown[] };
    let out = strings[0];
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      out += (typeof v === "function" ? "" : typeof v === "symbol" ? "" : toHtml(v)) + strings[i + 1];
    }
    return out;
  }
  if (typeof value === "object") return "";
  return String(value);
}

function sidebar(collapsed = false) {
  return toHtml(
    renderEnhancedNavSidebar({
      currentTab: "dashboard",
      basePath: "",
      collapsed,
      navState: mergeNavSidebarState({}),
      onNavStateChange: () => {},
      onTabSelect: () => {},
    }),
  );
}

/** The <a class="nav-item ..."> markup for one tab. */
function item(markup: string, tab: string): string {
  const start = markup.indexOf(`data-tab-pill=${tab}`) >= 0 ? markup.indexOf(`data-tab-pill=${tab}`) : markup.indexOf(`data-tab-pill="${tab}"`);
  expect(start, `sidebar renders ${tab}`).toBeGreaterThan(-1);
  const open = markup.lastIndexOf("<a", start);
  return markup.slice(open, markup.indexOf("</a>", start));
}

const checks = [
  { id: "core.inbox", source: "core", title: "Email account", tabs: ["inbox"], state: "needs-setup", reason: "No email account connected.", action: { label: "Connect email", tab: "inbox" } },
  { id: "core.models", source: "core", title: "Model provider", tabs: ["apikeys"], state: "error", reason: "The OpenAI key was rejected.", action: { label: "Fix API key", tab: "apikeys" } },
  { id: "core.coders", source: "core", title: "Coding agent", tabs: ["coders"], state: "optional", reason: "No coding agent installed.", action: { label: "Install a coder", tab: "setup", view: "coders" } },
  { id: "core.channels", source: "core", title: "Channel", tabs: ["channels"], state: "ready", reason: "" },
];

describe("sidebar: needs-setup glow", () => {
  beforeEach(() => {
    localStorage.clear();
    resetNavSetupStatusForTests();
    applySetupStatus({ checks });
  });

  it("expanded: glowing entries carry state, ring, tooltip and aria description", () => {
    const html = sidebar(false);
    const inbox = item(html, "inbox");
    expect(inbox).toContain("nav-item--setup nav-item--setup-needs-setup");
    expect(inbox).toContain("nav-item__setup-ring");
    expect(inbox).toContain("Needs setup: No email account connected.");
    expect(inbox).toMatch(/aria-describedby=["]?nav-setup-desc-[^ >]*-inbox/);
    expect(html).toMatch(/id=["]?nav-setup-desc-[^ >]*-inbox["]? class="nav-sr-only">Needs setup: No email account connected\./);

    expect(item(html, "apikeys")).toContain("nav-item--setup-error");
    expect(item(html, "apikeys")).toContain("Setup problem: The OpenAI key was rejected.");
    // Merged sub-tab (Setup › Coders) lights its host entry.
    expect(item(html, "setup")).toContain("nav-item--setup-optional");
    // Ready and unrelated entries stay plain.
    expect(item(html, "channels")).not.toContain("nav-item--setup");
    expect(item(html, "dashboard")).not.toContain("nav-item--setup");
  });

  it("group headers count pages needing setup (optional excluded)", () => {
    const html = sidebar(false);
    expect(html).toContain("1 page needs setup"); // Chat & Voice: inbox
    expect(html).toContain("1 page needs setup"); // Settings: apikeys (setup is optional)
    expect(html).not.toContain("2 pages need setup");
  });

  it("collapsed rail: the same entries render the rail dot", () => {
    const html = sidebar(true);
    expect(item(html, "inbox")).toContain("nav-item__setup-dot");
    expect(item(html, "apikeys")).toContain("nav-item__setup-dot");
    expect(item(html, "dashboard")).not.toContain("nav-item__setup-dot");
  });

  it("toggle off → no glow anywhere; dismissing an optional check clears its entry", () => {
    snoozeSetupCheck("core.coders");
    expect(item(sidebar(), "setup")).not.toContain("nav-item--setup");
    setSetupHighlightEnabled(false);
    const html = sidebar();
    expect(html).not.toContain("nav-item--setup");
    expect(html).not.toContain("nav-setup-count");
  });

  it("the page banner explains the reason with one action (hidden when it points at the same page)", () => {
    const onApikeys = toHtml(renderSetupBanner({ tab: "apikeys", basePath: "", onNavigate: () => {} }));
    expect(onApikeys).toContain("setup-banner--error");
    expect(onApikeys).toContain("The OpenAI key was rejected.");
    expect(onApikeys).not.toContain("setup-banner__btn"); // action = this page

    applySetupStatus({ checks: [{ ...checks[0], tabs: ["webchat", "inbox"], action: { label: "Connect email", tab: "inbox" } }] });
    const onDash = toHtml(renderSetupBanner({ tab: "inbox", view: "replies", basePath: "", onNavigate: () => {} }));
    expect(onDash).toContain("setup-banner--needs-setup");

    applySetupStatus({ checks });
    const onSetup = toHtml(renderSetupBanner({ tab: "setup", basePath: "", onNavigate: () => {} }));
    expect(onSetup).toContain("Install a coder");
    expect(onSetup).toContain("/setup?view=coders");
    expect(onSetup).toContain("Later"); // optional → snooze + dismiss
    expect(toHtml(renderSetupBanner({ tab: "dashboard", basePath: "", onNavigate: () => {} }))).toBe("");
  });
});

describe("glow CSS contract", () => {
  const css = readFileSync(fileURLToPath(new URL("../../styles/nav-setup-glow.css", import.meta.url)), "utf8");

  it("paints inside the row only (inset glow, no outer shadow) so nothing overflows", () => {
    const ring = css.slice(css.indexOf(".nav.enhanced .nav-item__setup-ring {"), css.indexOf("}", css.indexOf(".nav.enhanced .nav-item__setup-ring {")));
    expect(ring).toContain("inset: 0");
    const shadows = ring.split("box-shadow:")[1] ?? "";
    // Split top-level comma layers (color-mix(...) nests parens).
    const layers: string[] = [];
    let depth = 0;
    let cur = "";
    for (const ch of shadows.split(";")[0]) {
      if (ch === "(") depth++;
      if (ch === ")") depth--;
      if (ch === "," && depth === 0) {
        layers.push(cur);
        cur = "";
      } else cur += ch;
    }
    layers.push(cur);
    expect(layers.length).toBeGreaterThan(0);
    for (const layer of layers) expect(layer.trim().startsWith("inset")).toBe(true);
  });

  it("pulses via opacity only and goes static under prefers-reduced-motion", () => {
    const frames = /@keyframes nav-setup-breathe \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";
    expect(frames).toContain("opacity");
    expect(frames).not.toMatch(/box-shadow|transform|width|height/);
    const reduced = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(reduced).toContain("animation: none");
  });

  it("stacked top bar (≤1100px) keeps the ring: nothing hides it there", () => {
    const stacked = readFileSync(fileURLToPath(new URL("../../styles/nav-enhanced.css", import.meta.url)), "utf8");
    expect(stacked).not.toContain("nav-item__setup-ring");
    expect(css).not.toMatch(/max-width: 1100px\)[^@]*setup-ring[^}]*display: none/);
  });
});
