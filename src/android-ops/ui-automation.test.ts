/**
 * The load-bearing test here is the blocker detector. Automation that keeps
 * typing into a CAPTCHA or a blocked-account screen is the exact failure this
 * system is built to refuse, so these cases pin the stop conditions.
 */
import { describe, it, expect } from "vitest";
import {
  parseHierarchy,
  findNode,
  findTapTarget,
  centerOf,
  detectBlocker,
  detectTermsGate,
} from "./ui-automation.js";

const node = (attrs: Record<string, string>) =>
  `<node ${Object.entries(attrs)
    .map(([k, v]) => `${k}="${v}"`)
    .join(" ")}>`;

const doc = (...nodes: string[]) =>
  `<?xml version='1.0'?><hierarchy rotation="0">${nodes.join("")}</hierarchy>`;

describe("hierarchy parsing", () => {
  it("reads text, ids, flags and bounds", () => {
    const xml = doc(
      node({
        text: "Sign up",
        "resource-id": "com.instagram.android:id/sign_up_button",
        class: "android.widget.Button",
        "content-desc": "",
        clickable: "true",
        focused: "false",
        password: "false",
        bounds: "[40,900][680,1000]",
      }),
    );
    const [n] = parseHierarchy(xml);
    expect(n.text).toBe("Sign up");
    expect(n.resourceId).toContain("sign_up_button");
    expect(n.clickable).toBe(true);
    expect(centerOf(n)).toEqual({ x: 360, y: 950 });
  });

  it("ignores nodes without bounds rather than guessing a tap target", () => {
    expect(parseHierarchy(doc(node({ text: "x", class: "y" })))).toHaveLength(0);
  });
});

describe("finding a node", () => {
  const nodes = parseHierarchy(
    doc(
      node({
        text: "Username",
        class: "android.widget.TextView",
        clickable: "false",
        bounds: "[0,0][100,50]",
      }),
      node({
        text: "",
        "resource-id": "com.x:id/username_field",
        class: "android.widget.EditText",
        clickable: "true",
        bounds: "[0,60][720,140]",
      }),
      node({
        text: "Next",
        class: "android.widget.Button",
        clickable: "true",
        bounds: "[0,200][720,280]",
      }),
    ),
  );

  it("matches an exact button label over a partial one", () => {
    expect(findNode(nodes, { exactText: "next", clickableOnly: true })!.className).toContain(
      "Button",
    );
  });

  it("finds an input by resource id", () => {
    expect(findNode(nodes, { resourceId: "username", className: "EditText" })).toBeTruthy();
  });

  it("returns null rather than a wrong node", () => {
    expect(findNode(nodes, { exactText: "Create account" })).toBeNull();
  });
});

describe("resolving a tap target", () => {
  // Instagram's "Create new account" is a non-clickable View inside a clickable
  // container; requiring the match itself to be clickable found the label and
  // then refused to press it.
  const nodes = parseHierarchy(
    doc(
      node({
        text: "",
        class: "android.view.ViewGroup",
        clickable: "true",
        bounds: "[0,1200][720,1400]",
      }),
      node({
        text: "Create new account",
        class: "android.view.View",
        clickable: "false",
        bounds: "[224,1296][497,1337]",
      }),
    ),
  );

  it("climbs to the clickable container that holds the label", () => {
    const target = findTapTarget(nodes, { text: "create new account" });
    expect(target!.clickable).toBe(true);
    expect(centerOf(target!)).toEqual({ x: 360, y: 1300 });
  });

  it("prefers the node itself when it is already clickable", () => {
    const direct = parseHierarchy(
      doc(
        node({
          text: "Next",
          class: "android.widget.Button",
          clickable: "true",
          bounds: "[0,0][100,50]",
        }),
      ),
    );
    expect(findTapTarget(direct, { exactText: "next" })!.text).toBe("Next");
  });

  it("still returns null when nothing matches", () => {
    expect(findTapTarget(nodes, { text: "log in with facebook" })).toBeNull();
  });
});

describe("blocker detection", () => {
  const screenWith = (...lines: string[]) =>
    parseHierarchy(
      doc(
        ...lines.map((t, i) =>
          node({
            text: t,
            class: "android.widget.TextView",
            bounds: `[0,${i * 50}][720,${i * 50 + 40}]`,
          }),
        ),
      ),
    );

  it("stops on a CAPTCHA", () => {
    const b = detectBlocker(screenWith("Security check", "Confirm you're human"));
    expect(b?.kind).toBe("captcha");
    expect(b?.ask).toMatch(/yourself/i);
  });

  it("stops on emailed or texted verification codes", () => {
    expect(
      detectBlocker(screenWith("We sent you a code", "Enter the confirmation code"))?.kind,
    ).toBe("human_verification");
  });

  it("stops on a platform block and does not offer a way around it", () => {
    const b = detectBlocker(screenWith("Your account has been disabled for violating our terms"));
    expect(b?.kind).toBe("account_blocked");
    expect(b?.ask).toMatch(/nothing here works around a block/i);
  });

  it("stops on rate limiting and on login challenges", () => {
    expect(detectBlocker(screenWith("Please try again later"))?.kind).toBe("rate_limited");
    expect(detectBlocker(screenWith("Suspicious login attempt", "Was this you?"))?.kind).toBe(
      "login_challenge",
    );
  });

  it("quotes the wording that stopped it, so the prompt can show it", () => {
    expect(detectBlocker(screenWith("Enter the verification code we sent"))?.evidence).toMatch(
      /verification code/i,
    );
  });

  it("treats an agreement gate as an action, not a blocker", () => {
    const nodes = parseHierarchy(
      doc(
        node({
          text: "Terms of Use and Privacy Policy",
          class: "android.widget.TextView",
          clickable: "false",
          bounds: "[0,0][720,80]",
        }),
        node({
          text: "I agree",
          class: "android.widget.Button",
          clickable: "true",
          bounds: "[0,200][720,280]",
        }),
      ),
    );
    // an agreement screen is an ACTION now, not a halt — the operator delegated
    // it, so it must not read as a blocker or the runner stops on what it should clear
    expect(detectBlocker(nodes)).toBeNull();
    const gate = detectTermsGate(nodes);
    expect(gate!.control.text).toBe("I agree");
    expect(gate!.evidence).toMatch(/terms of use/i);
  });

  it("does not see a gate in the fine print every signup screen carries", () => {
    // prose mentioning terms, but no accept control — this is an ordinary screen
    const nodes = parseHierarchy(
      doc(
        node({
          text: "By signing up you agree to our Terms and Privacy Policy",
          class: "android.widget.TextView",
          clickable: "false",
          bounds: "[0,0][720,80]",
        }),
        node({
          text: "Next",
          class: "android.widget.Button",
          clickable: "true",
          bounds: "[0,200][720,280]",
        }),
      ),
    );
    expect(detectTermsGate(nodes)).toBeNull();
  });

  it("lets an ordinary signup screen through", () => {
    expect(detectBlocker(screenWith("Create a username", "Choose a password", "Next"))).toBeNull();
  });
});
