import { describe, expect, it } from "vitest";
import {
  derivePluginCategory,
  isSafeListingAssetPath,
  isSafeListingDataUrl,
  listingAssetPaths,
  listingAssetUrl,
  parseListing,
  resolveListingForUi,
} from "./listing.js";
import { loadPluginManifest } from "./manifest.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

describe("plugin store listing", () => {
  it("is optional: no listing → nothing, no warnings", () => {
    expect(parseListing(undefined)).toEqual({ warnings: [] });
  });

  it("parses a full listing", () => {
    const { listing, warnings } = parseListing({
      tagline: "  Doctor AI OS  ",
      description: "## Hello\n\n**markdown**",
      category: "Apps",
      tags: ["Research", "research", "PHI"],
      cover: "assets/cover.svg",
      icon: "assets/icon.svg",
      screenshots: [{ src: "assets/shot-1.webp", caption: "Feed" }, "assets/shot-2.png"],
      publisher: { name: "InfiniBot", url: "https://infinibot.ai" },
      links: { docs: "https://example.com/docs", source: "https://example.com/src" },
    });
    expect(warnings).toEqual([]);
    expect(listing).toMatchObject({
      tagline: "Doctor AI OS",
      category: "apps",
      tags: ["research", "phi"],
      cover: "assets/cover.svg",
      screenshots: [{ src: "assets/shot-1.webp", caption: "Feed" }, { src: "assets/shot-2.png" }],
      publisher: { name: "InfiniBot", url: "https://infinibot.ai/" },
      links: { docs: "https://example.com/docs", source: "https://example.com/src" },
    });
  });

  it("drops unsafe images and links with a warning instead of failing", () => {
    const { listing, warnings } = parseListing({
      cover: "../../etc/passwd.png",
      icon: "/abs/icon.png",
      screenshots: [
        { src: "assets/../../secret.png" },
        { src: "C:\\x.png" },
        { src: "assets/shot.exe" },
        { src: "https://cdn.example.com/x.png" },
        { src: "assets/ok.webp" },
      ],
      links: { docs: "javascript:alert(1)" },
      publisher: { url: "https://x" },
      category: "Not A Slug!",
    });
    expect(listing?.cover).toBeUndefined();
    expect(listing?.icon).toBeUndefined();
    expect(listing?.screenshots).toEqual([{ src: "assets/ok.webp", caption: undefined }]);
    expect(listing?.links).toEqual({});
    expect(listing?.publisher).toBeUndefined();
    expect(listing?.category).toBeUndefined();
    expect(warnings.length).toBe(9);
  });

  it("rejects a non-object listing", () => {
    expect(parseListing("hi").warnings).toEqual(["listing: must be an object"]);
  });

  it("path safety", () => {
    for (const bad of [
      "",
      "..",
      "../x.png",
      "a/../x.png",
      "./x.png",
      "a//x.png",
      "/x.png",
      "a\\x.png",
      "x.png\0",
      "file:x.png",
      ".hidden/x.png",
      "a/%2e%2e/x.png",
      "x.js",
      "x",
    ]) {
      expect(isSafeListingAssetPath(bad), bad).toBe(false);
    }
    for (const good of ["cover.svg", "assets/cover.webp", "assets/shots/1.PNG"]) {
      expect(isSafeListingAssetPath(good), good).toBe(true);
    }
  });

  it("data URLs: images only, size capped", () => {
    expect(isSafeListingDataUrl("data:image/png;base64,iVBORw0KGgo=")).toBe(true);
    expect(isSafeListingDataUrl("data:text/html;base64,PHNjcmlwdD4=")).toBe(false);
    expect(isSafeListingDataUrl(`data:image/png;base64,${"A".repeat(400_000)}`)).toBe(false);
  });

  it("URLs go through the authenticated asset route; data URLs pass through", () => {
    expect(listingAssetUrl("omniclinic", "assets/a b.webp")).toBe(
      "/api/plugin-assets/omniclinic/assets/a%20b.webp",
    );
    expect(listingAssetUrl("x", "data:image/png;base64,AA==")).toBe("data:image/png;base64,AA==");
    const ui = resolveListingForUi(
      "x",
      parseListing({ cover: "c.svg", screenshots: ["s.png"] }).listing,
    );
    expect(ui?.cover).toBe("/api/plugin-assets/x/c.svg");
    expect(ui?.screenshots[0]?.src).toBe("/api/plugin-assets/x/s.png");
  });

  it("the asset allowlist is exactly the declared images", () => {
    const { listing } = parseListing({
      cover: "c.svg",
      icon: "data:image/png;base64,AA==",
      screenshots: ["s1.png", "s2.png"],
    });
    expect(listingAssetPaths(listing)).toEqual(["c.svg", "s1.png", "s2.png"]);
  });

  it("derives a store category when the listing has none", () => {
    expect(derivePluginCategory({ listing: { category: "apps" }, channels: ["x"] })).toBe("apps");
    expect(derivePluginCategory({ channels: ["telegram"] })).toBe("channels");
    expect(derivePluginCategory({ providers: ["qwen"] })).toBe("integrations");
    expect(derivePluginCategory({ kind: "memory" })).toBe("integrations");
    expect(derivePluginCategory({ pages: 2 })).toBe("apps");
    expect(derivePluginCategory({})).toBe("developer");
  });

  it("a v1 manifest with a broken listing still loads (backward compatible)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "listing-v1-"));
    fs.writeFileSync(
      path.join(dir, "infinibot.plugin.json"),
      JSON.stringify({
        id: "demo",
        configSchema: { type: "object" },
        listing: { tagline: "Hi", cover: "../x.png" },
      }),
    );
    const res = loadPluginManifest(dir);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.manifest.listing?.tagline).toBe("Hi");
    expect(res.manifest.listing?.cover).toBeUndefined();
    expect(res.manifest.listingWarnings?.[0]).toMatch(/listing.cover/);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
