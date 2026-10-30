import { describe, expect, it } from "vitest";
import { CappedOutput } from "./capped-output.js";

describe("CappedOutput", () => {
  it("is exact while under the cap", () => {
    const b = new CappedOutput(8, 32);
    for (const c of ["ab", "cdefgh", "ijk", "lmnop"]) b.push(c);
    expect(b.toString()).toBe("abcdefghijklmnop");
    expect(b.dropped).toBe(0);
  });

  it("keeps the head and a bounded tail for unbounded input", () => {
    const b = new CappedOutput(10, 1000);
    b.push('{"session_id":"S1"}\n');
    for (let i = 0; i < 10_000; i++) b.push(`{"type":"assistant","i":${i}}\n`);
    b.push('{"type":"result","result":"done"}\n');
    // Retained size never exceeds head + tail * 1.25 regardless of input size.
    expect(b.length).toBeLessThanOrEqual(10 + 1250);
    expect(b.dropped).toBeGreaterThan(200_000);
    const s = b.toString();
    expect(s.startsWith('{"session_')).toBe(true);
    expect(s.endsWith('{"type":"result","result":"done"}\n')).toBe(true);
  });
});
