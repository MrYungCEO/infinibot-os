/**
 * What an agent needs to drive a handset the way an operator does by looking
 * at it: the screen as a compact element list, a way to name an element
 * instead of guessing pixels, and plain readings of what is running and how
 * the phone is doing.
 *
 * Pure parsing and selection only. The service owns dispatch (through the
 * command allow-list) and the audit trail; nothing here runs adb.
 */

import { centerOf, findTapTarget, type NodeSelector, type UiNode } from "./ui-automation.js";

/** One on-screen element, small enough to list a whole screen in a tool result. */
export interface CompactUiElement {
  /** Position in the dump, stable for this dump only. */
  i: number;
  text?: string;
  id?: string;
  desc?: string;
  /** Short class name, e.g. "Button" for android.widget.Button. */
  cls: string;
  /** [x1, y1, x2, y2] in device pixels. */
  bounds: [number, number, number, number];
  /** Where a tap lands. */
  center: [number, number];
  clickable?: true;
  scrollable?: true;
  focused?: true;
  checked?: true;
  disabled?: true;
  /** The field is a password field; its text is never echoed. */
  password?: true;
}

export interface UiSelectorInput {
  /** Substring of text OR content description (the forgiving default). */
  label?: string;
  text?: string;
  exactText?: string;
  resourceId?: string;
  desc?: string;
  className?: string;
}

const SELECTOR_KEYS = ["label", "text", "exactText", "resourceId", "desc", "className"] as const;

/** A validated selector; throws when nothing identifies an element. */
export function selectorFrom(input: UiSelectorInput): NodeSelector {
  const out: NodeSelector = {};
  for (const key of SELECTOR_KEYS) {
    const raw = input[key];
    if (typeof raw !== "string") continue;
    const value = raw.trim();
    if (!value) continue;
    if (value.length > 200) throw new Error(`${key} must be 200 characters or fewer.`);
    out[key] = value;
  }
  if (Object.keys(out).length === 0) {
    throw new Error(
      "Name the element: label, text, exactText, resourceId, desc or className (at least one).",
    );
  }
  return out;
}

function shortClass(className: string): string {
  const dot = className.lastIndexOf(".");
  return dot >= 0 ? className.slice(dot + 1) : className;
}

function isUseful(node: UiNode): boolean {
  return Boolean(
    node.text || node.contentDesc || node.resourceId || node.clickable || node.scrollable,
  );
}

export function compactNode(node: UiNode, i: number): CompactUiElement {
  const c = centerOf(node);
  const el: CompactUiElement = {
    i,
    cls: shortClass(node.className),
    bounds: [node.bounds.x1, node.bounds.y1, node.bounds.x2, node.bounds.y2],
    center: [c.x, c.y],
  };
  if (node.password) {
    el.password = true;
    if (node.text) el.text = "•••";
  } else if (node.text) {
    el.text = node.text.slice(0, 160);
  }
  if (node.resourceId) el.id = node.resourceId;
  if (node.contentDesc) el.desc = node.contentDesc.slice(0, 160);
  if (node.clickable) el.clickable = true;
  if (node.scrollable) el.scrollable = true;
  if (node.focused) el.focused = true;
  if (node.checked) el.checked = true;
  if (node.enabled === false) el.disabled = true;
  return el;
}

/**
 * The screen as an element list. Layout-only containers (no text, id,
 * description and not interactive) are dropped unless `all` is set: they are
 * most of a real dump and none of them is something an agent can name.
 */
export function compactHierarchy(
  nodes: UiNode[],
  opts: { all?: boolean; limit?: number } = {},
): { elements: CompactUiElement[]; totalNodes: number; truncated: boolean } {
  const limit = Math.max(1, Math.min(600, opts.limit ?? 250));
  const kept: CompactUiElement[] = [];
  nodes.forEach((node, i) => {
    if (opts.all || isUseful(node)) kept.push(compactNode(node, i));
  });
  return {
    elements: kept.slice(0, limit),
    totalNodes: nodes.length,
    truncated: kept.length > limit,
  };
}

/** The element a selector names and where to tap it, or null. */
export function locate(
  nodes: UiNode[],
  selector: NodeSelector,
): { element: CompactUiElement; tap: { x: number; y: number } } | null {
  const target = findTapTarget(nodes, selector);
  if (!target) return null;
  const index = nodes.indexOf(target);
  return { element: compactNode(target, index), tap: centerOf(target) };
}

/**
 * The foreground app from `dumpsys activity activities`. Android 10+ prints
 * `topResumedActivity`, older builds `mResumedActivity`; both carry
 * `ActivityRecord{… u0 com.pkg/.Activity t12}`.
 */
export function parseCurrentApp(
  dumpsys: string,
): { package: string; activity: string | null } | null {
  const lines = dumpsys.split("\n");
  const order = [/topResumedActivity/, /mResumedActivity/, /ResumedActivity/, /mFocusedApp/];
  for (const marker of order) {
    for (const line of lines) {
      if (!marker.test(line)) continue;
      const m = line.match(/\s([a-zA-Z0-9_.]+)\/([a-zA-Z0-9_.$]+)/);
      if (!m) continue;
      const activity = m[2].startsWith(".") ? m[1] + m[2] : m[2];
      return { package: m[1], activity };
    }
  }
  return null;
}

const PROP_FIELDS: Record<string, string> = {
  "ro.product.manufacturer": "manufacturer",
  "ro.product.model": "model",
  "ro.product.device": "device",
  "ro.build.version.release": "androidVersion",
  "ro.build.version.sdk": "sdk",
  "ro.build.version.security_patch": "securityPatch",
  "ro.build.display.id": "build",
  "persist.sys.timezone": "timezone",
  "persist.sys.locale": "locale",
  "gsm.operator.alpha": "carrier",
  "sys.boot_completed": "bootCompleted",
};

/** The handful of `getprop` values an operator reads off a phone. */
export function parseDeviceProps(getprop: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of getprop.matchAll(/^\[([^\]]+)\]:\s*\[([^\]]*)\]/gm)) {
    const field = PROP_FIELDS[m[1]];
    if (field && m[2]) out[field] = m[2];
  }
  return out;
}

/** Interface addresses from `ip -o addr show` (loopback dropped). */
export function parseNetwork(
  ipOut: string,
): Array<{ iface: string; family: "ipv4" | "ipv6"; address: string }> {
  const out: Array<{ iface: string; family: "ipv4" | "ipv6"; address: string }> = [];
  for (const line of ipOut.split("\n")) {
    const m = line.match(/^\d+:\s+(\S+)\s+(inet6?)\s+([0-9a-fA-F.:]+)\//);
    if (!m || m[1] === "lo") continue;
    out.push({ iface: m[1], family: m[2] === "inet6" ? "ipv6" : "ipv4", address: m[3] });
  }
  return out;
}

/** Third-party packages from `pm list packages -3`. */
export function parsePackages(pmOut: string): string[] {
  return pmOut
    .split("\n")
    .map((l) => l.trim().replace(/^package:/, ""))
    .filter((l) => /^[a-zA-Z0-9_.]+$/.test(l))
    .sort();
}
