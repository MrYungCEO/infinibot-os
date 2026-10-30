/**
 * Android Social Ops — compliance boundary.
 *
 * §6 and §9 of the plan draw a hard line: this system administers accounts its
 * owner legitimately controls. It does not help anything get past a platform's
 * integrity systems.
 *
 * The boundary is implemented, not just documented:
 *
 *  - {@link FORBIDDEN_CAPABILITIES} is the canonical list of things this
 *    codebase will not do. The UI renders it verbatim so an operator can see
 *    where the system stops.
 *  - {@link assertAllowedCommand} gates every device command that leaves the
 *    server, so an adapter cannot smuggle in a spoofing shell call.
 *  - {@link assertHumanCheckpoint} guards the ACTION_REQUIRED exit: a
 *    verification/CAPTCHA/2FA checkpoint may only be cleared by a named human
 *    operator, never by an automated actor.
 */

import type { ActionRequiredKind } from "./types.js";

export interface ForbiddenCapability {
  key: string;
  label: string;
  why: string;
}

/** Capabilities this system refuses to provide. Rendered in the Ops surface. */
export const FORBIDDEN_CAPABILITIES: ForbiddenCapability[] = [
  {
    key: "captcha_bypass",
    label: "CAPTCHA solving or bypass",
    why: "Human verification is escalated to an operator as ACTION REQUIRED, never solved automatically or outsourced.",
  },
  {
    key: "fake_identity",
    label: "Fake identity infrastructure",
    why: "Accounts are registered against domain-controlled mailboxes the owner actually holds. No synthetic identities, no disposable recovery.",
  },
  {
    key: "artificial_engagement",
    label: "Artificial engagement",
    why: "No like/follow/view generation. The Inbox handles genuine replies from the account owner only.",
  },
  {
    key: "anti_detection",
    label: "Anti-detection behaviour",
    why: "No randomised humanisation designed to look like a different user, and no fingerprint shaping.",
  },
  {
    key: "signal_falsification",
    label: "Rotating or falsified device / location signals",
    why: "Network egress may be stable and separate, but device identity, GPS and locale are never spoofed to evade platform controls.",
  },
  {
    key: "integrity_evasion",
    label: "Evasion of platform integrity systems",
    why: "Security challenges, appeals and policy prompts are surfaced to a human, not automated around.",
  },
];

/**
 * Every ACTION_REQUIRED reason is a human checkpoint. This map exists so the
 * escalation UI can explain *why* a person has to touch it, and so no future
 * caller can quietly treat one of them as automatable.
 */
export const HUMAN_CHECKPOINTS: Record<ActionRequiredKind, string> = {
  captcha:
    "Platform is presenting a human-verification challenge. An operator must complete it on the device.",
  email_verification:
    "Platform sent a verification email. An operator confirms it from the controlled recovery mailbox.",
  sms_verification: "Platform sent an SMS code. An operator reads it from the registered handset.",
  security_challenge:
    "Platform raised a security/identity challenge. An operator reviews and responds.",
  two_factor:
    "A 2FA prompt needs the authenticator. Supervised by an operator; codes stay in the vault.",
  login_required:
    "The app session expired. An operator signs in and re-establishes the trusted device.",
  policy_prompt:
    "Platform surfaced a policy or consent prompt that requires an accountable human decision.",
  manual_review: "Flagged for operator review before publishing.",
};

/**
 * Shell/UI operations an adapter is allowed to perform on a handset. This is an
 * allow-list on purpose: anything not named here cannot be dispatched.
 */
export const ALLOWED_COMMANDS = [
  "health.battery",
  "health.storage",
  "health.wifi",
  "health.uptime",
  "app.launch",
  "app.version",
  "app.install",
  /* Agent device control (droid_swarm): fixed argv each, no caller shell
     strings. Uninstall is destructive and only reachable behind an operator
     approval in the plugin tool. */
  "app.stop",
  "app.uninstall",
  "app.current",
  "app.list",
  "device.props",
  /* Read-only screen state (awake / lock screen / focused window) from
     dumpsys, so presence checks and account detection can tell a locked or
     asleep phone from a broken one without tapping anything. */
  "device.screen",
  "device.ime",
  "health.network",
  "media.push",
  "media.cleanup",
  "media.stat",
  /* Posting queue: index a pushed video, read its MediaStore id, and open the
     target app's share screen with it (the owner's own content, own account).
     Fixed argv; the final publish tap stays a separate, audited ui.tap. */
  "media.scan",
  "media.query",
  "post.share",
  "post.prepare",
  "post.publish",
  "post.verify",
  "session.check",
  "screenshot.capture",
  "logs.pull",
  /* Reading the accessibility tree is a strictly smaller capability than the
     screenshot capture already permitted above: it observes the screen so
     automation can find a field, and so detectBlocker() can recognise a CAPTCHA
     or a block and STOP. It writes nothing. */
  "ui.dump",
  "ui.tap",
  "ui.swipe",
  "ui.text",
  "ui.keyevent",
] as const;

export type AllowedCommand = (typeof ALLOWED_COMMANDS)[number];

const ALLOWED = new Set<string>(ALLOWED_COMMANDS);

export class ComplianceViolationError extends Error {
  readonly capability: string;
  constructor(capability: string, message: string) {
    super(message);
    this.name = "ComplianceViolationError";
    this.capability = capability;
  }
}

/**
 * Gate for device commands. Throws rather than returning false so a mistake in
 * an adapter surfaces loudly instead of silently degrading.
 */
export function assertAllowedCommand(command: string): asserts command is AllowedCommand {
  if (!ALLOWED.has(command)) {
    throw new ComplianceViolationError(
      "unlisted_command",
      `Device command "${command}" is not on the Android Social Ops allow-list. ` +
        `Permitted: ${ALLOWED_COMMANDS.join(", ")}.`,
    );
  }
}

/**
 * Gate for clearing an ACTION_REQUIRED checkpoint. `actor` must be a named
 * human operator — automated actors (the scheduler, the simulator, any agent)
 * are rejected.
 */
const AUTOMATED_ACTORS = new Set([
  "system",
  "scheduler",
  "simulator",
  "worker",
  "agent",
  "cron",
  "",
]);

export function assertHumanCheckpoint(actor: string | undefined | null): asserts actor is string {
  const name = (actor ?? "").trim();
  /* Agent actors arrive namespaced (`agent:main:…`, `agent:mcp`); the bare set
     above only caught the literal word. */
  if (!name || AUTOMATED_ACTORS.has(name.toLowerCase()) || /^agent[:/]/i.test(name)) {
    throw new ComplianceViolationError(
      "automated_checkpoint_resolution",
      "ACTION REQUIRED checkpoints (verification, CAPTCHA, 2FA, security challenges) must be " +
        "cleared by a named human operator. Automated actors cannot resolve them.",
    );
  }
}

/** Human-readable summary used by the Ops surface and the audit trail. */
export const COMPLIANCE_STATEMENT =
  "This system administers accounts you legitimately own. It publishes content you supply and " +
  "escalates every verification, CAPTCHA, 2FA and security challenge to a human operator. It does " +
  "not bypass platform integrity systems.";
