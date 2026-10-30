/**
 * Agent Biographies (Phase 4 §cinematic-agent-biographies).
 *
 * Auto-generates a short shareable cinematic for a milestone event (a successful
 * agent completion = "shipped"). It reuses the in-world cinematic camera that the
 * engine publishes on `window.cinematicCamera`: frame the milestone agent with a
 * composed "reveal" shot, then capture a few seconds of canvas to a WebM Blob via
 * `recordCinematic()`. The resulting clip is announced with a `world-biography-ready`
 * CustomEvent (and returned) so any surface can offer it as a one-tap share — the
 * "every milestone becomes a mini-film" loop the plan describes.
 *
 * Recording is GPU/CPU heavy, so auto-capture is OPT-IN (window.__worldBiographies
 * === true). The manual entry point (window.__worldRecordBiography) always works.
 * A single in-flight lock prevents overlapping captures from fighting the camera.
 */

interface CinematicCameraHandle {
  cinematicShot(targetIds: string[], opts?: { type?: string }): Promise<void>;
  recordCinematic(opts: { durationMs: number; fps?: number }): Promise<Blob>;
}

export interface BiographyClip {
  sessionKey: string;
  label: string;
  blob: Blob;
  url: string;
  at: number;
}

let capturing = false;

function cinematic(): CinematicCameraHandle | null {
  const c = (window as unknown as { cinematicCamera?: CinematicCameraHandle }).cinematicCamera;
  return c && typeof c.recordCinematic === "function" ? c : null;
}

/**
 * Capture a biography clip for one agent. Returns the clip (also dispatched as a
 * `world-biography-ready` event), or null if the camera isn't available, a capture
 * is already running, or recording failed.
 */
export async function recordAgentBiography(
  sessionKey: string,
  label = "Milestone",
  durationMs = 6000,
): Promise<BiographyClip | null> {
  if (capturing) return null;
  const cam = cinematic();
  if (!cam) return null;
  capturing = true;
  try {
    // Frame the agent first so the clip opens on the hero, then roll.
    try {
      await cam.cinematicShot([sessionKey], { type: "reveal" });
    } catch {
      /* a failed framing shot shouldn't abort the capture */
    }
    const blob = await cam.recordCinematic({ durationMs, fps: 30 });
    if (!blob || blob.size === 0) return null;
    const url = URL.createObjectURL(blob);
    const clip: BiographyClip = { sessionKey, label, blob, url, at: Date.now() };
    window.dispatchEvent(new CustomEvent("world-biography-ready", { detail: clip }));
    return clip;
  } catch {
    return null;
  } finally {
    capturing = false;
  }
}

/**
 * Notify the biography system of a milestone. Records a clip only when auto-capture
 * is enabled (window.__worldBiographies === true) and the milestone succeeded.
 */
export function onMilestone(sessionKey: string, success: boolean, label?: string): void {
  if (!success) return;
  if ((window as unknown as { __worldBiographies?: boolean }).__worldBiographies !== true) return;
  void recordAgentBiography(sessionKey, label ?? "Shipped");
}

// Manual trigger for any surface / the share button.
(window as unknown as { __worldRecordBiography?: typeof recordAgentBiography }).__worldRecordBiography =
  recordAgentBiography;
