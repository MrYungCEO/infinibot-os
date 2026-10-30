/**
 * Agency Recorder — capture the live agency-world <canvas> to a WebM clip.
 *
 * Wraps canvas.captureStream() + MediaRecorder so the "REC" toolbar button can
 * grab a short marketing reel of the world in motion. Auto-stops at maxMs to
 * keep clips short and memory bounded. start() is a no-op if already recording
 * or unsupported; stop() resolves the assembled Blob (or null on failure).
 *
 *   const rec = new AgencyRecorder(canvas);
 *   rec.start();
 *   // …later…
 *   const blob = await rec.stop();
 *   if (blob) downloadBlob(blob, "agency-world.webm");
 */

interface AgencyRecorderOptions {
  fps?: number;
  maxMs?: number;
}

const DEFAULT_FPS = 30;
const DEFAULT_MAX_MS = 60000;

/** Pick the first supported webm mime type, preferring smaller/modern codecs. */
function pickMimeType(): string | null {
  if (
    typeof MediaRecorder === "undefined" ||
    typeof MediaRecorder.isTypeSupported !== "function"
  ) {
    // No introspection available — fall back to a bare webm request.
    return typeof MediaRecorder !== "undefined" ? "video/webm" : null;
  }
  const candidates = [
    "video/webm;codecs=vp9",
    "video/webm;codecs=vp8",
    "video/webm",
  ];
  for (const c of candidates) {
    if (MediaRecorder.isTypeSupported(c)) return c;
  }
  return null;
}

export class AgencyRecorder {
  private canvas: HTMLCanvasElement;
  private fps: number;
  private maxMs: number;

  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private mimeType = "video/webm";
  private isRecording = false;
  private autoStopTimer: ReturnType<typeof setTimeout> | null = null;
  private stopResolvers: Array<(blob: Blob | null) => void> = [];

  constructor(canvas: HTMLCanvasElement, opts: AgencyRecorderOptions = {}) {
    this.canvas = canvas;
    this.fps = opts.fps ?? DEFAULT_FPS;
    this.maxMs = opts.maxMs ?? DEFAULT_MAX_MS;
  }

  get recording(): boolean {
    return this.isRecording;
  }

  start(): void {
    if (this.isRecording) return;

    const mime = pickMimeType();
    if (
      !mime ||
      typeof MediaRecorder === "undefined" ||
      typeof this.canvas.captureStream !== "function"
    ) {
      // Unsupported environment — silently no-op; stop() will return null.
      this.isRecording = false;
      return;
    }

    try {
      this.stream = this.canvas.captureStream(this.fps);
      this.mimeType = mime;
      this.chunks = [];
      this.recorder = new MediaRecorder(this.stream, { mimeType: mime });
      this.recorder.ondataavailable = (e: BlobEvent) => {
        if (e.data && e.data.size > 0) this.chunks.push(e.data);
      };
      this.recorder.onstop = () => this.finalize();
      this.recorder.onerror = () => this.finalize();
      this.recorder.start(250); // gather chunks every 250ms
      this.isRecording = true;

      this.autoStopTimer = setTimeout(() => {
        // Auto-stop fires the same path as a manual stop().
        void this.stop();
      }, this.maxMs);
    } catch {
      this.cleanup();
      this.isRecording = false;
    }
  }

  stop(): Promise<Blob | null> {
    // Never recording (or unsupported) → resolve null immediately.
    if (!this.isRecording || !this.recorder) {
      this.cleanup();
      return Promise.resolve(null);
    }
    if (this.autoStopTimer) {
      clearTimeout(this.autoStopTimer);
      this.autoStopTimer = null;
    }
    const promise = new Promise<Blob | null>((resolve) => {
      this.stopResolvers.push(resolve);
    });
    try {
      if (this.recorder.state !== "inactive") {
        this.recorder.stop(); // triggers onstop → finalize()
      } else {
        this.finalize();
      }
    } catch {
      this.finalize();
    }
    return promise;
  }

  private finalize(): void {
    // Guard against double-invocation (onstop + onerror, etc.).
    const resolvers = this.stopResolvers;
    this.stopResolvers = [];
    let blob: Blob | null = null;
    if (this.chunks.length > 0) {
      blob = new Blob(this.chunks, { type: this.mimeType });
    }
    this.isRecording = false;
    this.cleanup();
    for (const resolve of resolvers) resolve(blob);
  }

  private cleanup(): void {
    if (this.autoStopTimer) {
      clearTimeout(this.autoStopTimer);
      this.autoStopTimer = null;
    }
    if (this.stream) {
      for (const track of this.stream.getTracks()) {
        try {
          track.stop();
        } catch {
          /* ignore */
        }
      }
      this.stream = null;
    }
    this.recorder = null;
    this.chunks = [];
  }
}

/** Trigger a browser download of a Blob via a transient <a download> link. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  // Defer revocation so the click has time to start the download.
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 1000);
}
