/**
 * On-device UI automation.
 *
 * The mechanical half of account setup — launching the app, typing a username,
 * tapping Next — is inside the existing command allowlist (ui.tap, ui.text,
 * ui.keyevent, app.launch). This module is what turns those primitives into
 * something that can act on a real screen: it reads the view hierarchy with
 * `uiautomator dump`, finds a node by what the operator would look for, and
 * computes where to tap.
 *
 * The half it deliberately does NOT do is the half the compliance boundary
 * reserves for a human: detectBlocker() exists to STOP automation the moment a
 * screen looks like a CAPTCHA, a verification challenge or a platform block,
 * so the run pauses and asks. Nothing here tries to read, solve or work around
 * one — recognising that a wall is there is the opposite of climbing it.
 */

export interface UiNode {
  text: string;
  resourceId: string;
  className: string;
  contentDesc: string;
  clickable: boolean;
  focused: boolean;
  password: boolean;
  /** Present on real dumps; false when a dump omits it. */
  scrollable?: boolean;
  enabled?: boolean;
  checked?: boolean;
  /** Owning app package (real dumps carry it on every node). */
  packageName?: string;
  bounds: { x1: number; y1: number; x2: number; y2: number };
}

export interface NodeSelector {
  /**
   * Substring of EITHER the visible text or the content description. Android
   * apps label controls inconsistently — Instagram's "Sign up with email" button
   * carries a content-desc and empty text — so matching one field alone finds a
   * control on some screens and silently misses it on others.
   */
  label?: string;
  /** Case-insensitive substring of the node's visible text. */
  text?: string;
  /** Exact (case-insensitive) visible text — preferred for buttons. */
  exactText?: string;
  /** Substring of the resource id, e.g. "username". */
  resourceId?: string;
  /** Substring of the content description. */
  desc?: string;
  /** Substring of the class name, e.g. "EditText". */
  className?: string;
  /** Only consider nodes the system marks clickable. */
  clickableOnly?: boolean;
}

const BOUNDS_RE = /\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/;

/** uiautomator escapes attribute values as XML; decode the entities it emits. */
function decodeXml(value: string): string {
  if (!value.includes("&")) return value;
  return value.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (whole, ent: string) => {
    if (ent === "amp") return "&";
    if (ent === "lt") return "<";
    if (ent === "gt") return ">";
    if (ent === "quot") return '"';
    if (ent === "apos") return "'";
    const code = ent.startsWith("#x") ? Number.parseInt(ent.slice(2), 16) : Number(ent.slice(1));
    return Number.isFinite(code) && code > 0 && code < 0x110000
      ? String.fromCodePoint(code)
      : whole;
  });
}

function attr(fragment: string, name: string): string {
  // Leading boundary: `text` must not match inside `hint-text` / `content-text`.
  const m = fragment.match(new RegExp(`(?:^|\\s)${name}="([^"]*)"`));
  return m ? decodeXml(m[1]) : "";
}

/** Parse a `uiautomator dump` document into flat, searchable nodes. */
export function parseHierarchy(xml: string): UiNode[] {
  const nodes: UiNode[] = [];
  for (const match of xml.matchAll(/<node\b([^>]*)>/g)) {
    const fragment = match[1];
    const bounds = attr(fragment, "bounds").match(BOUNDS_RE);
    if (!bounds) continue;
    nodes.push({
      text: attr(fragment, "text"),
      resourceId: attr(fragment, "resource-id"),
      className: attr(fragment, "class"),
      contentDesc: attr(fragment, "content-desc"),
      clickable: attr(fragment, "clickable") === "true",
      focused: attr(fragment, "focused") === "true",
      password: attr(fragment, "password") === "true",
      scrollable: attr(fragment, "scrollable") === "true",
      enabled: attr(fragment, "enabled") !== "false",
      checked: attr(fragment, "checked") === "true",
      packageName: attr(fragment, "package"),
      bounds: {
        x1: Number(bounds[1]),
        y1: Number(bounds[2]),
        x2: Number(bounds[3]),
        y2: Number(bounds[4]),
      },
    });
  }
  return nodes;
}

const has = (haystack: string, needle: string) =>
  haystack.toLowerCase().includes(needle.toLowerCase());

/** The first node matching every provided facet of the selector. */
export function findNode(nodes: UiNode[], selector: NodeSelector): UiNode | null {
  return (
    nodes.find((n) => {
      if (selector.clickableOnly && !n.clickable) return false;
      if (selector.label && !has(`${n.text} ${n.contentDesc}`, selector.label)) return false;
      if (selector.exactText && n.text.trim().toLowerCase() !== selector.exactText.toLowerCase())
        return false;
      if (selector.text && !has(n.text, selector.text)) return false;
      if (selector.resourceId && !has(n.resourceId, selector.resourceId)) return false;
      if (selector.desc && !has(n.contentDesc, selector.desc)) return false;
      if (selector.className && !has(n.className, selector.className)) return false;
      return true;
    }) ?? null
  );
}

/** Where to tap for a node — its centre, in device pixels. */
export function centerOf(node: UiNode): { x: number; y: number } {
  return {
    x: Math.round((node.bounds.x1 + node.bounds.x2) / 2),
    y: Math.round((node.bounds.y1 + node.bounds.y2) / 2),
  };
}

/**
 * Where to tap for a match. Android apps routinely put the label in a
 * non-clickable View inside a clickable container — Instagram's "Create new
 * account" is exactly that — so requiring the matched node itself to be
 * clickable finds the text and then refuses to press it. Resolve to the
 * smallest clickable node that contains the match, and fall back to the match
 * itself, since a touch at its centre lands on whatever handles it.
 */
export function findTapTarget(nodes: UiNode[], selector: NodeSelector): UiNode | null {
  const match = findNode(nodes, { ...selector, clickableOnly: false });
  if (!match) return null;
  if (match.clickable) return match;
  const point = centerOf(match);
  const area = (n: UiNode) => (n.bounds.x2 - n.bounds.x1) * (n.bounds.y2 - n.bounds.y1);
  const container = nodes
    .filter(
      (n) =>
        n.clickable &&
        n.bounds.x1 <= point.x &&
        n.bounds.x2 >= point.x &&
        n.bounds.y1 <= point.y &&
        n.bounds.y2 >= point.y,
    )
    .sort((a, b) => area(a) - area(b))[0];
  return container ?? match;
}

export type BlockerKind =
  | "captcha"
  | "human_verification"
  | "account_blocked"
  | "rate_limited"
  | "login_challenge";

export interface Blocker {
  kind: BlockerKind;
  /** The on-screen wording that triggered it, so the prompt can quote it. */
  evidence: string;
  /** What the operator is being asked to do, in their words. */
  ask: string;
}

/**
 * Phrases that mean "a person has to look at this". Matching one STOPS the run.
 *
 * This is not a bypass list and must never become one: the system's stated
 * boundary is that human verification is escalated, never solved or outsourced.
 * Adding an entry here makes automation stop MORE often, which is the only
 * direction this list is allowed to move.
 */
const BLOCKER_PATTERNS: Array<{ kind: BlockerKind; ask: string; patterns: RegExp[] }> = [
  {
    kind: "captcha",
    ask: "Solve the CAPTCHA on the handset yourself, then continue the run.",
    patterns: [/captcha/i, /i'?m not a robot/i, /confirm you'?re human/i, /security check/i],
  },
  {
    kind: "human_verification",
    ask: "Complete the verification on the handset — enter the emailed or texted code, or finish the identity check — then continue.",
    patterns: [
      /enter (the )?(confirmation|verification|security) code/i,
      /we sent (you )?(a|an) (code|email|sms)/i,
      /verify your (account|email|phone|identity)/i,
      /confirm your (email|phone)/i,
      /two-factor/i,
    ],
  },
  {
    kind: "account_blocked",
    ask: "The platform has blocked this action. Read the screen and decide whether to retire this slot — nothing here works around a block.",
    patterns: [
      /(account|action) (has been )?(blocked|disabled|suspended|restricted)/i,
      /we (restrict|removed|disabled)/i,
      /violat(es|ed) our/i,
    ],
  },
  {
    kind: "rate_limited",
    ask: "The platform is rate limiting this handset. Leave it alone for a while before continuing.",
    patterns: [/try again later/i, /too many (attempts|requests)/i, /please wait/i, /slow down/i],
  },
  {
    kind: "login_challenge",
    ask: "The platform is challenging this login. Clear it on the handset, then continue.",
    patterns: [
      /suspicious (login|activity)/i,
      /unusual (login|activity)/i,
      /was this you/i,
      /help us confirm/i,
      /* Google account security prompts ("Is it you trying to sign in?",
         "Allow … access?", "Verify it's you") — the owner answers these on
         the phone; automation never taps Yes/Allow. */
      /(is it|is this) you trying to sign in/i,
      /trying to (sign|log) ?in/i,
      /(verify|confirm) it'?s you/i,
      /allow (this )?(app|device|account)? ?access\?/i,
      /google (account|sign.?in) (security|prompt)/i,
      /yes,? it'?s me/i,
    ],
  },
];

/**
 * Controls that mean "accept this agreement".
 *
 * Matched against CLICKABLE nodes only, deliberately: almost every signup screen
 * carries fine print saying you agree to some terms, and treating that prose as
 * a gate would fire on every ordinary screen. An actual button is the gate.
 *
 * This used to halt the run — the operator decided otherwise, so the runner taps
 * it and records what it accepted. The wording is captured with the tap so the
 * audit says which agreement was accepted and when, rather than just "tapped a
 * button".
 */
const AGREEMENT_CONTROLS = [
  /^i agree$/i,
  /^agree( and continue)?$/i,
  /^accept( all)?$/i,
  /^continue$/i,
];
const AGREEMENT_CONTEXT = /(terms|privacy policy|data policy|cookies? policy|user agreement)/i;

export interface TermsGate {
  /** The control to press. */
  control: UiNode;
  /** The on-screen wording, recorded so the audit names what was accepted. */
  evidence: string;
}

/** An agreement screen waiting on an accept control, or null. */
export function detectTermsGate(nodes: UiNode[]): TermsGate | null {
  const context = nodes.map((n) => `${n.text} ${n.contentDesc}`).join("\n");
  if (!AGREEMENT_CONTEXT.test(context)) return null;
  const control = nodes.find(
    (n) => n.clickable && AGREEMENT_CONTROLS.some((p) => p.test(n.text.trim())),
  );
  if (!control) return null;
  const line =
    context
      .split("\n")
      .find((l) => AGREEMENT_CONTEXT.test(l))
      ?.trim() ?? "terms";
  return { control, evidence: line.slice(0, 180) };
}

/** The first reason on screen that automation must not proceed past. */
export function detectBlocker(nodes: UiNode[]): Blocker | null {
  const surface = nodes
    .map((n) => `${n.text} ${n.contentDesc}`.trim())
    .filter(Boolean)
    .join("\n");
  for (const rule of BLOCKER_PATTERNS) {
    for (const pattern of rule.patterns) {
      const hit = surface.match(pattern);
      if (hit) {
        const line =
          surface
            .split("\n")
            .find((l) => pattern.test(l))
            ?.trim() ?? hit[0];
        return { kind: rule.kind, evidence: line.slice(0, 180), ask: rule.ask };
      }
    }
  }
  return null;
}

/** Package names for the platforms this console drives. */
export const PLATFORM_PACKAGES: Record<string, string> = {
  instagram: "com.instagram.android",
  facebook: "com.facebook.katana",
  threads: "com.instagram.barcelona",
  tiktok: "com.zhiliaoapp.musically",
  youtube: "com.google.android.youtube",
  x: "com.twitter.android",
};
