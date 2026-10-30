/**
 * Friendly in-flight descriptions for agent tool calls (chat sidebar loading
 * cards). Pure — no DOM — so it runs under the node vitest config.
 */

export type ToolActivity = {
  /** While running, e.g. "Generating image". */
  label: string;
  /** Once finished, e.g. "Image generated". */
  doneLabel: string;
  /** Who does the work, shown as a small tag ("FlyPic"). */
  provider?: string;
  /** Media tools get a skeleton preview of the thing being made. */
  media?: "image" | "video";
  /** Rough duration, drives the progress bar; absent = indeterminate. */
  typicalSeconds?: number;
};

const KNOWN: Record<string, ToolActivity> = {
  flypic_generate_image: { label: "Generating image", doneLabel: "Image generated", provider: "FlyPic", media: "image", typicalSeconds: 35 },
  flypic_generate_video: { label: "Generating video", doneLabel: "Video generated", provider: "FlyPic", media: "video", typicalSeconds: 150 },
  flypic_edit_media: { label: "Editing image", doneLabel: "Image edited", provider: "FlyPic", media: "image", typicalSeconds: 35 },
  flypic_use_as_reference: { label: "Creating from your library", doneLabel: "Created from your library", provider: "FlyPic", media: "image", typicalSeconds: 40 },
  flypic_wait_job: { label: "Waiting for FlyPic", doneLabel: "FlyPic job finished", provider: "FlyPic", typicalSeconds: 60 },
  flypic_job_status: { label: "Checking FlyPic job", doneLabel: "Checked FlyPic job", provider: "FlyPic" },
  flypic_find_reference: { label: "Finding reference photos", doneLabel: "Found reference photos", provider: "FlyPic", typicalSeconds: 15 },
  flypic_list_models: { label: "Loading FlyPic models", doneLabel: "Loaded FlyPic models", provider: "FlyPic" },
  flypic_feed_list: { label: "Searching your FlyPic library", doneLabel: "Searched your FlyPic library", provider: "FlyPic" },
  flypic_feed_get: { label: "Opening a FlyPic item", doneLabel: "Opened a FlyPic item", provider: "FlyPic" },
  flypic_account: { label: "Checking your FlyPic account", doneLabel: "Checked your FlyPic account", provider: "FlyPic" },
  content_intel: { label: "Reading your reel library", doneLabel: "Read your reel library" },
  script: { label: "Generating script", doneLabel: "Script generated", typicalSeconds: 20 },
  research: { label: "Researching", doneLabel: "Research done", typicalSeconds: 30 },
  web: { label: "Researching", doneLabel: "Research done" },
  web_search: { label: "Searching the web", doneLabel: "Searched the web" },
  web_fetch: { label: "Reading a web page", doneLabel: "Read a web page" },
  browser: { label: "Using the browser", doneLabel: "Used the browser" },
  memory_search: { label: "Searching memory", doneLabel: "Searched memory" },
  memory_get: { label: "Reading memory", doneLabel: "Read memory" },
  read: { label: "Reading files", doneLabel: "Read files" },
  write: { label: "Writing a file", doneLabel: "Wrote a file" },
  edit: { label: "Editing a file", doneLabel: "Edited a file" },
  exec: { label: "Running a command", doneLabel: "Ran a command" },
  image: { label: "Looking at an image", doneLabel: "Looked at an image" },
  sessions_spawn: { label: "Starting a sub-agent", doneLabel: "Started a sub-agent" },
  claude_coder: { label: "Starting a coding agent", doneLabel: "Coding agent started" },
  codex_coder: { label: "Starting a coding agent", doneLabel: "Coding agent started" },
  opencode_coder: { label: "Starting a coding agent", doneLabel: "Coding agent started" },
  grok_coder: { label: "Starting a coding agent", doneLabel: "Coding agent started" },
  kanban: { label: "Updating the board", doneLabel: "Board updated" },
  notes: { label: "Working on notes", doneLabel: "Notes updated" },
  show_panel: { label: "Opening a panel", doneLabel: "Panel ready" },
};

function humanize(name: string): string {
  const words = name
    .replace(/^(mcp__[^_]+__|infinibot_)/, "")
    .replace(/[_.-]+/g, " ")
    .trim();
  return words || "tool";
}

export function describeToolActivity(name: string): ToolActivity {
  const known = KNOWN[name];
  if (known) return known;
  const words = humanize(name);
  return { label: `Using ${words}`, doneLabel: `Used ${words}` };
}

/**
 * Progress for a run with a typical duration: eases toward 92% so it never
 * claims to be done early, and keeps moving if the run is slow.
 */
export function toolProgress(elapsedMs: number, typicalSeconds: number): number {
  if (!(typicalSeconds > 0) || !(elapsedMs > 0)) return 0;
  return Math.round(92 * (1 - Math.exp(-elapsedMs / 1000 / (typicalSeconds * 0.8))));
}

export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}
