import { describe, expect, it } from "vitest";

import {
  cardFor,
  dockerStartLine,
  downloadLine,
  fmtBytes,
  fmtEta,
  headline,
  introCopy,
  introLine,
  stepIcon,
  type SetupState,
} from "./local-voice-model";

const base = (over: Partial<SetupState> = {}): SetupState => ({
  phase: "idle",
  running: false,
  interrupted: false,
  project: "infinibot-voice",
  host: null,
  steps: [],
  docker: {},
  download: null,
  services: {},
  model: null,
  test: null,
  error: null,
  notes: [],
  log: [],
  ...over,
});

describe("intro copy", () => {
  it("built-in engine by default: size, free disk, no extra apps", () => {
    const c = introCopy("native", { approxMb: 260 }, 41.7);
    expect(c.button).toBe("Set up voice for me");
    expect(c.text).toMatch(/about 260 MB/);
    expect(c.fine).toBe("No extra apps and no admin password. Needs about 260 MB. You have 41 GB free.");
    expect(introCopy("native", { approxMb: 0, downloaded: true }, null).text).toMatch(/already downloaded/);
  });
  it("existing Docker voice is kept", () => {
    const c = introCopy("docker", null, 10);
    expect(c.title).toMatch(/runs in Docker/);
    expect(c.text).toMatch(/Nothing gets replaced/);
    expect(c.fine).toMatch(/free helper app/);
  });
});

describe("local voice view model", () => {
  it("picks the card for every state", () => {
    expect(cardFor(null, false)).toBe("unsupported");
    expect(cardFor(null, true)).toBe("intro");
    expect(cardFor(base(), true)).toBe("intro");
    expect(cardFor(base({ phase: "checking", running: true }), true)).toBe("progress");
    expect(cardFor(base({ phase: "downloading", interrupted: true }), true)).toBe("progress");
    expect(cardFor(base({ phase: "needs-docker" }), true)).toBe("needs-docker");
    expect(cardFor(base({ phase: "needs-permission" }), true)).toBe("needs-permission");
    expect(cardFor(base({ phase: "needs-sudo" }), true)).toBe("needs-sudo");
    expect(cardFor(base({ phase: "done" }), true)).toBe("done");
    expect(cardFor(base({ phase: "failed" }), true)).toBe("failed");
    expect(cardFor(base({ phase: "cancelled" }), true)).toBe("intro");
  });

  it("says what is happening in plain words", () => {
    expect(headline(base({ phase: "downloading" }))).toBe("Downloading the voice engine…");
    expect(headline(base({ phase: "checking", interrupted: true }))).toBe("Checking your computer…");
    expect(dockerStartLine(base({ phase: "starting-docker", docker: { startPlan: { kind: "open-desktop" }, countdownSec: 95 } }))).toBe(
      "Opening Docker Desktop. This can take up to 1:35.",
    );
    expect(introLine([{ approxMb: 900 }, { approxMb: 2600 }])).toMatch(/about 3\.4 GB the first time/);
  });

  it("formats download progress", () => {
    expect(fmtBytes(512 * 1024 * 1024)).toBe("512 MB");
    expect(fmtBytes(3.5 * 1024 ** 3)).toBe("3.5 GB");
    expect(fmtEta(null)).toBe("working out the time left");
    expect(fmtEta(30)).toBe("less than a minute left");
    expect(fmtEta(360)).toBe("about 6 min left");
    expect(
      downloadLine({ images: [], doneBytes: 1024 ** 3, totalBytes: 4 * 1024 ** 3, percent: 25, etaSec: 300 }),
    ).toBe("1.0 GB of 4.0 GB · 25% · about 5 min left");
  });

  it("uses icons from icons.ts for each step state", () => {
    expect(stepIcon("done")).toBe("checkCircle");
    expect(stepIcon("active")).toBe("loader");
    expect(stepIcon("failed")).toBe("xCircle");
    expect(stepIcon("pending")).toBe("circle");
  });
});
