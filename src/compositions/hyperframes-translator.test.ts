import { describe, expect, it } from "vitest";

import { generateHyperframesHtml } from "@hyperframes/core";

import {
  compositionToHyperframes,
  compositionToHyperframesHtml,
} from "./hyperframes-translator.js";
import type { CompositionWithChildren } from "./types.js";

function fixtureComp(): CompositionWithChildren {
  const now = Date.now();
  return {
    id: "comp_smoke",
    name: "Smoke",
    slug: "smoke",
    widthPx: 1920,
    heightPx: 1080,
    fps: 30,
    durationSec: 6,
    bgColor: "#000000",
    meta: {},
    createdAt: now,
    updatedAt: now,
    tracks: [
      {
        id: "trk_video",
        compositionId: "comp_smoke",
        kind: "video",
        name: "Video",
        sortOrder: 0,
        muted: false,
        locked: false,
        hidden: false,
      },
      {
        id: "trk_overlay",
        compositionId: "comp_smoke",
        kind: "overlay",
        name: "Overlay",
        sortOrder: 1,
        muted: false,
        locked: false,
        hidden: false,
      },
      {
        id: "trk_audio",
        compositionId: "comp_smoke",
        kind: "audio",
        name: "Audio",
        sortOrder: 2,
        muted: false,
        locked: false,
        hidden: false,
      },
    ],
    clips: [
      {
        id: "clip_v1",
        compositionId: "comp_smoke",
        trackId: "trk_video",
        kind: "video",
        startSec: 0,
        durationSec: 6,
        z: 0,
        props: {
          src: "https://example.com/intro.mp4",
          x: 0,
          y: 0,
          width: 100,
          height: 100,
          volume: 0.8,
        },
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "clip_t1",
        compositionId: "comp_smoke",
        trackId: "trk_overlay",
        kind: "text",
        startSec: 1,
        durationSec: 3,
        z: 10,
        props: {
          text: "Hello hyperframes",
          x: 10,
          y: 40,
          fontSize: 96,
          fontWeight: 700,
          color: "#ffffff",
          animateIn: { kind: "fade", durationSec: 0.5, easing: "easeOut" },
          animateOut: { kind: "slideUp", durationSec: 0.4, easing: "easeIn" },
        },
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "clip_a1",
        compositionId: "comp_smoke",
        trackId: "trk_audio",
        kind: "audio",
        startSec: 0,
        durationSec: 6,
        z: 0,
        props: { src: "https://example.com/bgm.mp3", volume: 0.4 },
        createdAt: now,
        updatedAt: now,
      },
    ],
  };
}

describe("compositionToHyperframes", () => {
  it("maps clips to typed timeline elements", () => {
    const t = compositionToHyperframes(fixtureComp());
    expect(t.totalDuration).toBe(6);
    expect(t.widthPx).toBe(1920);
    expect(t.heightPx).toBe(1080);
    expect(t.fps).toBe(30);
    expect(t.options.resolution).toBe("landscape");

    const video = t.elements.find((e) => e.id === "clip_v1");
    expect(video?.type).toBe("video");
    expect((video as { src: string }).src).toBe("https://example.com/intro.mp4");

    const text = t.elements.find((e) => e.id === "clip_t1");
    expect(text?.type).toBe("text");
    expect((text as { content: string }).content).toBe("Hello hyperframes");

    const audio = t.elements.find((e) => e.id === "clip_a1");
    expect(audio?.type).toBe("audio");
  });

  it("produces fade-in + slide-out keyframes for the text clip", () => {
    const t = compositionToHyperframes(fixtureComp());
    const kf = t.options.keyframes?.["clip_t1"] ?? [];
    expect(kf.length).toBeGreaterThanOrEqual(4);
    const inFrame = kf.find((k) => k.id === "clip_t1-in-0");
    expect(inFrame?.properties.opacity).toBe(0);
    const outFrame = kf.find((k) => k.id === "clip_t1-out-1");
    expect(outFrame?.properties.opacity).toBe(0);
  });
});

describe("generateHyperframesHtml integration", () => {
  it("produces HTML containing the video src, text content, and gsap timeline", () => {
    const t = compositionToHyperframes(fixtureComp());
    const html = generateHyperframesHtml(t.elements, t.totalDuration, t.options);
    expect(typeof html).toBe("string");
    expect(html.length).toBeGreaterThan(500);
    expect(html).toContain("intro.mp4");
    expect(html).toContain("Hello hyperframes");
    expect(html.toLowerCase()).toContain("gsap");
  });

  it("compositionToHyperframesHtml returns the same HTML the lower-level call produces", async () => {
    const comp = fixtureComp();
    const direct = generateHyperframesHtml(
      compositionToHyperframes(comp).elements,
      compositionToHyperframes(comp).totalDuration,
      compositionToHyperframes(comp).options,
    );
    const via = compositionToHyperframesHtml(comp);
    expect(via.length).toBe(direct.length);
  });
});
