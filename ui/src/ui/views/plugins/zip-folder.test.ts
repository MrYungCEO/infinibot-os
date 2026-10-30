import { describe, expect, it } from "vitest";
import { openPluginZip } from "../../../../../src/plugins/packages/zip-read.js";
import { keepPath, zipFiles } from "./zip-folder.js";

const enc = new TextEncoder();

describe("zipFiles (folder import)", () => {
  it("produces a zip the gateway's hardened reader accepts, wrapped in the folder name", async () => {
    const manifest = JSON.stringify({ manifestVersion: 2, id: "demo", name: "Demo", version: "1.0.0" });
    const bytes = zipFiles([
      { path: "demo/infinibot.plugin.json", data: enc.encode(manifest) },
      { path: "demo/index.js", data: enc.encode("export default {}\n") },
      { path: "demo/ui/ünïcode.txt", data: enc.encode("ok") },
    ]);
    const zip = await openPluginZip(Buffer.from(bytes));
    expect(zip.has("infinibot.plugin.json")).toBe(true);
    expect((await zip.read("index.js")).toString()).toBe("export default {}\n");
    expect((await zip.read("ui/ünïcode.txt")).toString()).toBe("ok");
    // Same folder → same bytes.
    expect(Buffer.from(zipFiles([{ path: "a", data: enc.encode("x") }])).equals(Buffer.from(zipFiles([{ path: "a", data: enc.encode("x") }])))).toBe(true);
  });
  it("skips node_modules, .git and OS junk", () => {
    expect(keepPath("demo/index.js")).toBe(true);
    expect(keepPath("demo/node_modules/x/index.js")).toBe(false);
    expect(keepPath("demo/.git/HEAD")).toBe(false);
    expect(keepPath("demo/.DS_Store")).toBe(false);
  });
});
