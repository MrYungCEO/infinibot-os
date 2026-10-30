/**
 * Benign console noise from headless browsers.
 *
 * visual_verify (and agents' own puppeteer scripts) run Chrome headless with
 * software GL. Chrome then logs GPU-driver chatter at `error` level
 * ("GL Driver Message … GPU stall due to ReadPixels", "Automatic fallback to
 * software WebGL has been deprecated", GroupMarkerNotSet …). Those lines say
 * nothing about the page under test, yet they were counted as console errors
 * and made reviewers reject "0 console errors" claims.
 *
 * This is the single classifier: everything that counts console errors for
 * verification goes through {@link partitionConsoleMessages}.
 */

export type ConsoleNoiseKind = "gl-driver" | "network-flake" | "favicon";

const BENIGN: Array<{ kind: ConsoleNoiseKind; re: RegExp }> = [
  // GPU / GL driver chatter from software rendering (SwiftShader / ANGLE / Mesa).
  { kind: "gl-driver", re: /GL Driver Message/i },
  { kind: "gl-driver", re: /GPU stall due to ReadPixels/i },
  { kind: "gl-driver", re: /Automatic fallback to software WebGL/i },
  { kind: "gl-driver", re: /GroupMarkerNotSet\(crbug\.com\/242999\)/i },
  { kind: "gl-driver", re: /\[\.WebGL-0x[0-9a-f]+\]/i },
  { kind: "gl-driver", re: /WebGL: too many errors, no more errors will be reported/i },
  { kind: "gl-driver", re: /swiftshader|SwANGLE|ANGLE \(.*SwiftShader/i },
  { kind: "gl-driver", re: /\bGL_(?:INVALID_OPERATION|CLOSE_PATH_NV)\b.*(?:Performance|ReadPixels)/i },
  { kind: "gl-driver", re: /Failed to (?:create|initialize) (?:WebGL|GPU|GL) context.*headless/i },
  // The network changing under a headless run (VPN / tailscale reconnects) on
  // third-party font CDNs — never the app's own requests.
  {
    kind: "network-flake",
    re: /(?:fonts\.(?:googleapis|gstatic)\.com).*ERR_NETWORK_CHANGED|ERR_NETWORK_CHANGED.*fonts\.(?:googleapis|gstatic)\.com/i,
  },
  { kind: "favicon", re: /\/favicon\.ico\b.*(?:404|Not Found)/i },
];

/** Classify one console line: a benign kind, or null when it is a real error. */
export function benignConsoleKind(message: string): ConsoleNoiseKind | null {
  const text = String(message ?? "");
  for (const b of BENIGN) if (b.re.test(text)) return b.kind;
  return null;
}

export function isBenignConsoleMessage(message: string): boolean {
  return benignConsoleKind(message) !== null;
}

export function partitionConsoleMessages(messages: readonly string[]): {
  errors: string[];
  benign: string[];
} {
  const errors: string[] = [];
  const benign: string[] = [];
  for (const m of messages) (isBenignConsoleMessage(m) ? benign : errors).push(m);
  return { errors, benign };
}

/**
 * Count real console errors in a visual_verify report's shots. Also used to
 * recount old reports (written before this classifier) during re-review.
 */
export function countRealConsoleErrors(
  shots: ReadonlyArray<{ consoleErrors?: string[]; pageErrors?: string[] }>,
): { errors: number; benign: number } {
  let errors = 0;
  let benign = 0;
  for (const s of shots) {
    const p = partitionConsoleMessages(s.consoleErrors ?? []);
    errors += p.errors.length + (s.pageErrors ?? []).length;
    benign += p.benign.length;
  }
  return { errors, benign };
}
