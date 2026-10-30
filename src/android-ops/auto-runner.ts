/**
 * Drives the mechanical half of a setup run on the handset.
 *
 * What it does: launches the platform app, finds fields and buttons in the live
 * view hierarchy, types the profile copy the operator authored, and advances the
 * run when a step's work is genuinely finished.
 *
 * What it refuses: anything a person is supposed to see. Before and after every
 * action it re-reads the screen, and the moment detectBlocker() recognises a
 * CAPTCHA, a verification challenge, a rate limit or a platform block it stops,
 * marks the step blocked and hands back a prompt for the operator. It does not
 * read codes out of mail, does not retry past a block, and has no path that
 * solves a challenge. That is the boundary this system is built on, and
 * automating up to it is the point — automating through it is not.
 *
 * It is also honest about not knowing: if a screen does not contain what the
 * step needs, it stops and says which control it could not find, rather than
 * tapping blind and hoping.
 */
import {
  PLATFORM_PACKAGES,
  centerOf,
  detectBlocker,
  detectTermsGate,
  findNode,
  findTapTarget,
  parseHierarchy,
  type Blocker,
  type NodeSelector,
  type UiNode,
} from "./ui-automation.js";

export interface AutomationAction {
  action: string;
  detail: string;
  ok: boolean;
}

export type AutomationOutcome =
  | { status: "advanced"; actions: AutomationAction[]; note: string }
  | { status: "blocked"; actions: AutomationAction[]; blocker: Blocker }
  | { status: "needs_operator"; actions: AutomationAction[]; reason: string };

/** The device-facing calls the runner is allowed to make. */
export interface AutomationDriver {
  dump(): Promise<string>;
  tap(x: number, y: number): Promise<void>;
  type(text: string): Promise<void>;
  key(keyevent: string): Promise<void>;
  launch(pkg: string): Promise<void>;
  wait(ms: number): Promise<void>;
}

export interface AutomationContext {
  platform: string;
  handle: string;
  displayName: string | null;
  bio: string | null;
  recoveryEmail: string | null;
  /** Resolved only when the step genuinely needs to type it. */
  password: string | null;
}

const SETTLE_MS = 1400;

async function readScreen(driver: AutomationDriver): Promise<UiNode[]> {
  return parseHierarchy(await driver.dump());
}

/** Tap a control, or say which one was missing. */
async function tapNode(
  driver: AutomationDriver,
  nodes: UiNode[],
  selector: NodeSelector,
  label: string,
  actions: AutomationAction[],
): Promise<boolean> {
  const node = findTapTarget(nodes, selector);
  if (!node) {
    actions.push({ action: "tap", detail: `could not find ${label}`, ok: false });
    return false;
  }
  const { x, y } = centerOf(node);
  await driver.tap(x, y);
  actions.push({ action: "tap", detail: `${label} at ${x},${y}`, ok: true });
  await driver.wait(SETTLE_MS);
  return true;
}

async function typeInto(
  driver: AutomationDriver,
  nodes: UiNode[],
  selector: NodeSelector,
  value: string,
  label: string,
  actions: AutomationAction[],
): Promise<boolean> {
  const field = findNode(nodes, { ...selector, className: selector.className ?? "EditText" });
  if (!field) {
    actions.push({ action: "type", detail: `could not find the ${label} field`, ok: false });
    return false;
  }
  const { x, y } = centerOf(field);
  await driver.tap(x, y);
  await driver.wait(400);
  await driver.type(value);
  /* the value itself is never logged — a password would end up in the audit */
  actions.push({ action: "type", detail: `filled ${label}`, ok: true });
  await driver.wait(600);
  return true;
}

/**
 * Accept an agreement screen if one is in the way.
 *
 * The operator decided this is theirs to delegate: these are their devices and
 * their accounts, and accepting terms is not in the forbidden set — that list is
 * about deceiving a platform (CAPTCHA bypass, fake identity, anti-detection),
 * not about pressing a button they would press themselves. What the runner owes
 * them is a record: the transcript names the agreement it accepted, so there is
 * an answer to "what did this agree to, and when".
 */
async function acceptTermsIfPresent(
  driver: AutomationDriver,
  nodes: UiNode[],
  actions: AutomationAction[],
): Promise<UiNode[]> {
  const gate = detectTermsGate(nodes);
  if (!gate) return nodes;
  const { x, y } = centerOf(gate.control);
  await driver.tap(x, y);
  actions.push({
    action: "accept",
    detail: `"${gate.control.text.trim()}" on: ${gate.evidence}`,
    ok: true,
  });
  await driver.wait(SETTLE_MS);
  return readScreen(driver);
}

/** Stop as soon as the screen belongs to a person. */
function guard(nodes: UiNode[], actions: AutomationAction[]): AutomationOutcome | null {
  const blocker = detectBlocker(nodes);
  if (!blocker) return null;
  actions.push({ action: "halt", detail: `${blocker.kind}: ${blocker.evidence}`, ok: false });
  return { status: "blocked", actions, blocker };
}

/**
 * Run the automatable part of one step. Returns what it did and why it stopped;
 * the caller decides how that changes the run.
 */
export async function automateStep(
  stepKey: string,
  driver: AutomationDriver,
  ctx: AutomationContext,
): Promise<AutomationOutcome> {
  const actions: AutomationAction[] = [];
  const pkg = PLATFORM_PACKAGES[ctx.platform];

  if (stepKey === "signup") {
    if (!pkg) {
      return {
        status: "needs_operator",
        actions,
        reason: `No package is known for ${ctx.platform}.`,
      };
    }
    await driver.launch(pkg);
    actions.push({ action: "launch", detail: pkg, ok: true });
    await driver.wait(SETTLE_MS * 2);

    let nodes = await readScreen(driver);
    const blocked = guard(nodes, actions);
    if (blocked) return blocked;
    nodes = await acceptTermsIfPresent(driver, nodes, actions);

    /* the entry point differs per app and per version, so try the wordings that
       exist rather than assuming one */
    const entered =
      (await tapNode(
        driver,
        nodes,
        { label: "create new account" },
        "Create new account",
        actions,
      )) ||
      (await tapNode(driver, nodes, { exactText: "sign up" }, "Sign up", actions)) ||
      (await tapNode(driver, nodes, { label: "sign up" }, "Sign up", actions));
    if (!entered) {
      return {
        status: "needs_operator",
        actions,
        reason:
          "Could not find a signup entry point on this screen. Open the signup flow on the handset, then continue — the run picks up from there.",
      };
    }

    nodes = await readScreen(driver);
    const afterEntry = guard(nodes, actions);
    if (afterEntry) return afterEntry;
    nodes = await acceptTermsIfPresent(driver, nodes, actions);

    /* Signup opens on a phone-number step. This system provisions a durable
       mailbox per account and no phone number, so take the email path when the
       app offers one rather than leaving a field it cannot fill. */
    if (findNode(nodes, { label: "sign up with email" })) {
      await tapNode(driver, nodes, { label: "sign up with email" }, "Sign up with email", actions);
      nodes = await readScreen(driver);
      const afterSwitch = guard(nodes, actions);
      if (afterSwitch) return afterSwitch;
      nodes = await acceptTermsIfPresent(driver, nodes, actions);
    }

    if (ctx.recoveryEmail) {
      const typed =
        (await typeInto(
          driver,
          nodes,
          { resourceId: "email" },
          ctx.recoveryEmail,
          "email",
          actions,
        )) ||
        (await typeInto(
          driver,
          nodes,
          { label: "email", className: "EditText" },
          ctx.recoveryEmail,
          "email",
          actions,
        ));
      if (!typed)
        actions.push({ action: "note", detail: "email field not on this screen", ok: false });
      nodes = await readScreen(driver);
      const afterEmail = guard(nodes, actions);
      if (afterEmail) return afterEmail;
    }

    return {
      status: "needs_operator",
      actions,
      reason:
        "The signup form is open and the parts that could be filled are filled. Platforms put verification immediately after this point, so the rest is yours: finish on the handset, then mark the step done.",
    };
  }

  if (stepKey === "profile") {
    if (!ctx.displayName && !ctx.bio) {
      return {
        status: "needs_operator",
        actions,
        reason: "No display name or bio is set on this account yet.",
      };
    }
    let nodes = await readScreen(driver);
    const blocked = guard(nodes, actions);
    if (blocked) return blocked;

    const opened = await tapNode(driver, nodes, { label: "edit profile" }, "Edit profile", actions);
    if (!opened) {
      return {
        status: "needs_operator",
        actions,
        reason:
          "Open the profile editor on the handset — no Edit profile control is on this screen.",
      };
    }
    nodes = await readScreen(driver);
    const afterOpen = guard(nodes, actions);
    if (afterOpen) return afterOpen;

    let filled = 0;
    if (
      ctx.displayName &&
      (await typeInto(
        driver,
        nodes,
        { resourceId: "full_name" },
        ctx.displayName,
        "display name",
        actions,
      ))
    )
      filled += 1;
    if (ctx.bio) {
      nodes = await readScreen(driver);
      if (await typeInto(driver, nodes, { resourceId: "bio" }, ctx.bio, "bio", actions))
        filled += 1;
    }
    if (!filled) {
      return {
        status: "needs_operator",
        actions,
        reason:
          "Found the profile editor but not its fields — apply the copy on the handset and mark the step done.",
      };
    }
    return {
      status: "advanced",
      actions,
      note: `Applied ${filled} profile field(s) on the handset.`,
    };
  }

  return {
    status: "needs_operator",
    actions,
    reason: `"${stepKey}" is not a step this runner automates — it is yours to clear.`,
  };
}
