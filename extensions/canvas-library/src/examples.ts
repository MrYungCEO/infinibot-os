/**
 * Example walkthroughs for the HoloCanvas library.
 *
 * Opt-in only: nothing is inserted until the owner presses "Load examples" (or
 * an agent calls `canvas-library.examples.load`). They are neutral, about the
 * canvas format itself, so a fresh library never fills up with marketing.
 * Loading is idempotent by title.
 */

import type { SavedCanvas } from "infinibot/plugin-sdk";

export type CanvasPayload = SavedCanvas["payload"];

export interface ExampleCanvas {
  title: string;
  payload: CanvasPayload;
  tags: string[];
}

export const EXAMPLE_TAG = "example";

export const EXAMPLE_CANVASES: ExampleCanvas[] = [
  {
    title: "How a canvas walkthrough works",
    tags: [EXAMPLE_TAG, "guide"],
    payload: {
      title: "How a canvas walkthrough works",
      world: { w: 3600, h: 2000 },
      voiceSuppress: true,
      autoAdvance: true,
      nodes: [
        {
          id: "title",
          kind: "title",
          x: 200,
          y: 180,
          w: 760,
          cl: "gold",
          brand: "HoloCanvas · example",
          h1: "Walkthroughs on an infinite canvas",
          sub: "Cards sit on a large board. Scenes move the camera from card to card, with an optional narrated caption.",
        },
        {
          id: "nodes",
          kind: "text",
          x: 1120,
          y: 200,
          w: 560,
          cl: "cyan",
          kicker: "Step 1",
          h2: "Cards",
          body: "Each card has a **kind** (title, text, stats, callout, chart, image, code…) and a position on the board.",
        },
        {
          id: "scenes",
          kind: "text",
          x: 1120,
          y: 760,
          w: 560,
          cl: "cyan",
          kicker: "Step 2",
          h2: "Scenes",
          body: "A scene focuses one card. Add a caption and narration text; **Bake narration** turns it into audio.",
        },
        {
          id: "share",
          kind: "callout",
          x: 200,
          y: 800,
          w: 640,
          cl: "gold",
          icon: "★",
          title: "Keep, share, replay",
          body: "Saved canvases get a share link, a single-file HTML export, and can be shown again as an on-screen overlay.",
        },
      ],
      links: [
        ["title", "nodes"],
        ["nodes", "scenes"],
        ["scenes", "share"],
      ],
      scenes: [
        {
          id: "s1",
          focusNodeId: "title",
          narration: {
            ttsText: "A walkthrough is a set of cards on a large board, and a camera that tours them.",
            captionMd: "Cards on a board, and a camera tour.",
          },
        },
        {
          id: "s2",
          focusNodeId: "nodes",
          narration: {
            ttsText: "Every card has a kind and a position.",
            captionMd: "Cards have a kind and a position.",
          },
        },
        {
          id: "s3",
          focusNodeId: "scenes",
          narration: {
            ttsText: "Each scene focuses one card and can carry narration.",
            captionMd: "One scene, one card.",
          },
          beats: [{ atMs: 200, op: "highlight", target: "scenes" }],
        },
        {
          id: "s4",
          focusNodeId: "share",
          narration: {
            ttsText: "Saved canvases can be shared, exported or replayed.",
            captionMd: "Share, export, replay.",
          },
        },
      ],
    },
  },
  {
    title: "Weekly review (template)",
    tags: [EXAMPLE_TAG, "template"],
    payload: {
      title: "Weekly review (template)",
      world: { w: 3400, h: 1800 },
      voiceSuppress: true,
      autoAdvance: false,
      nodes: [
        {
          id: "title",
          kind: "title",
          x: 200,
          y: 200,
          w: 720,
          cl: "gold",
          brand: "Template",
          h1: "Weekly review",
          sub: "Replace these cards with your own numbers, wins and next steps.",
        },
        {
          id: "numbers",
          kind: "stats",
          x: 1080,
          y: 200,
          w: 620,
          cl: "gold",
          kicker: "This week",
          stats: [
            { n: "0", l: "tasks closed" },
            { n: "0", l: "new clients" },
            { n: "0", l: "open issues" },
          ],
        },
        {
          id: "wins",
          kind: "text",
          x: 200,
          y: 780,
          w: 620,
          cl: "cyan",
          kicker: "Wins",
          h2: "What went well",
          body: "- First win\n- Second win",
        },
        {
          id: "next",
          kind: "callout",
          x: 1080,
          y: 780,
          w: 620,
          cl: "gold",
          icon: "→",
          title: "Next week",
          body: "The one or two things that matter most.",
        },
      ],
      links: [
        ["title", "numbers"],
        ["numbers", "wins"],
        ["wins", "next"],
      ],
      scenes: [
        { id: "s1", focusNodeId: "title" },
        { id: "s2", focusNodeId: "numbers" },
        { id: "s3", focusNodeId: "wins" },
        { id: "s4", focusNodeId: "next" },
      ],
    },
  },
];
