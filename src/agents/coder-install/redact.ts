/**
 * Log hygiene for coder installs and sign-in sessions: strip terminal escape
 * sequences, then mask anything that looks like a credential (the shared
 * logging patterns, fully masked) plus any literal secret values we know of.
 */

import { redactSensitiveText } from "../../logging/redact.js";

// CSI / OSC (incl. OSC 8 hyperlinks terminated by BEL or ST) / single-char ESC.
// eslint-disable-next-line no-control-regex
const ANSI_RE =
  /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b\[[0-?]*[ -/]*[@-~]|\u001b[@-_]/g;

export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text
    .replace(ANSI_RE, "")
    .replace(/\r(?!\n)/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
}

/** Extra patterns the shared list misses: Claude OAuth tokens, JWT-ish blobs. */
const EXTRA_PATTERNS = [
  String.raw`\b(sk-ant-[A-Za-z0-9_-]{8,})\b`,
  String.raw`\b(eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b`,
];

export function redactSecrets(text: string, known: readonly string[] = []): string {
  if (!text) return text;
  let out = redactSensitiveText(text, { mode: "tools", full: true });
  out = redactSensitiveText(out, { mode: "tools", full: true, patterns: EXTRA_PATTERNS });
  for (const secret of known) {
    if (secret && secret.length >= 6) out = out.split(secret).join("***");
  }
  return out;
}

/** Clean one chunk of process output for display. */
export function cleanLogText(text: string, known: readonly string[] = []): string {
  return redactSecrets(stripAnsi(text), known);
}
