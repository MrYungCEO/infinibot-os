import { describe, expect, it } from "vitest";
import { isOcrFileName } from "./file-ocr";
import { analysisColor, formatTimecode, isVideoFileName, isVideoMime, parseTimecodeInput } from "./video-analysis";

describe("video analysis UI helpers", () => {
  it("recognises video files and mimes (and routes them through the OCR panel)", () => {
    for (const n of ["dig.mp4", "A.MOV", "clip.webm", "x.mkv", "y.m4v"]) {
      expect(isVideoFileName(n)).toBe(true);
      expect(isOcrFileName(n)).toBe(true);
    }
    expect(isVideoFileName("photo.jpg")).toBe(false);
    expect(isVideoMime("video/mp4")).toBe(true);
    expect(isVideoMime("image/png")).toBe(false);
  });

  it("formats and parses timecodes typed in follow-up questions", () => {
    expect(formatTimecode(83.6)).toBe("01:23");
    expect(formatTimecode(3725)).toBe("1:02:05");
    expect(parseTimecodeInput("look at 01:23 and 1:40, then 1:02:05")).toEqual([83, 100, 3725]);
    expect(parseTimecodeInput("no times here")).toEqual([]);
  });

  it("gives each analysis a distinct marker colour", () => {
    expect(new Set([0, 1, 2, 3, 4, 5].map(analysisColor)).size).toBe(6);
    expect(analysisColor(6)).toBe(analysisColor(0));
  });
});
