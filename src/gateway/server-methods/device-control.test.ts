import { describe, expect, it } from "vitest";
import { parseInputAction, pngSize } from "./device-control.js";

describe("device.input validation", () => {
  it("accepts the four actions and normalises coordinates", () => {
    expect(parseInputAction({ action: "move", x: 10.4, y: 20 })).toEqual({
      action: "move",
      x: 10,
      y: 20,
    });
    expect(parseInputAction({ action: "click", button: "right", double: true })).toEqual({
      action: "click",
      button: "right",
      double: true,
    });
    expect(parseInputAction({ action: "type", text: "hello" })).toEqual({
      action: "type",
      text: "hello",
    });
    expect(parseInputAction({ action: "key", key: "ctrl+c" })).toEqual({
      action: "key",
      key: "ctrl+c",
    });
  });
  it("rejects anything shell-shaped or out of range", () => {
    expect(() => parseInputAction({ action: "key", key: "a; rm -rf /" })).toThrow();
    expect(() => parseInputAction({ action: "move", x: -1, y: 0 })).toThrow();
    expect(() => parseInputAction({ action: "type", text: "" })).toThrow();
    expect(() => parseInputAction({ action: "exec" })).toThrow();
  });
  it("reads PNG dimensions", () => {
    const b = Buffer.alloc(24);
    b.writeUInt32BE(0x89504e47, 0);
    b.writeUInt32BE(1280, 16);
    b.writeUInt32BE(800, 20);
    expect(pngSize(b)).toEqual({ width: 1280, height: 800 });
    expect(pngSize(Buffer.from("nope"))).toBeNull();
  });
});
