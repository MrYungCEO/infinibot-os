import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { pickupAuthFromHash } from "./auth-hash";
import { loadSettings, saveSettings } from "./storage";

const SETTINGS_KEY = "infinibot.control.settings.v1";

function setHash(hash: string) {
  // Mutating location.hash directly triggers a hashchange event. We use
  // history.replaceState so the URL flips silently — matching how a launcher
  // would deliver the credentials in a real navigation.
  history.replaceState(null, "", `${location.pathname}${location.search}${hash}`);
}

describe("pickupAuthFromHash", () => {
  beforeEach(() => {
    localStorage.removeItem(SETTINGS_KEY);
    setHash("");
  });

  afterEach(() => {
    localStorage.removeItem(SETTINGS_KEY);
    setHash("");
  });

  it("returns nothing and leaves storage untouched when hash is empty", () => {
    const picked = pickupAuthFromHash();
    expect(picked).toEqual({});
    expect(localStorage.getItem(SETTINGS_KEY)).toBeNull();
  });

  it("ignores router-style hashes that don't carry credentials", () => {
    setHash("#/whiteboard");
    const picked = pickupAuthFromHash();
    expect(picked).toEqual({});
    expect(location.hash).toBe("#/whiteboard");
  });

  it("extracts a token, persists it, and scrubs the URL", () => {
    setHash("#token=abc123");
    const picked = pickupAuthFromHash();
    expect(picked.token).toBe("abc123");
    expect(loadSettings().token).toBe("abc123");
    expect(location.hash).toBe("");
  });

  it("extracts a password, persists it, and scrubs the URL", () => {
    setHash("#password=hunter2");
    const picked = pickupAuthFromHash();
    expect(picked.password).toBe("hunter2");
    expect(loadSettings().password).toBe("hunter2");
    expect(location.hash).toBe("");
  });

  it("extracts both credentials when shipped together", () => {
    setHash("#token=t&password=p");
    const picked = pickupAuthFromHash();
    expect(picked).toEqual({ token: "t", password: "p" });
    const stored = loadSettings();
    expect(stored.token).toBe("t");
    expect(stored.password).toBe("p");
  });

  it("does not overwrite an existing credential with an empty hash value", () => {
    saveSettings({ ...loadSettings(), token: "preexisting" });
    setHash("#token=");
    const picked = pickupAuthFromHash();
    expect(picked.token).toBeUndefined();
    expect(loadSettings().token).toBe("preexisting");
  });

  it("URL-decodes special characters in the credential", () => {
    setHash("#password=a%26b%3Dc");
    const picked = pickupAuthFromHash();
    expect(picked.password).toBe("a&b=c");
  });

  it("preserves an unrelated query string while scrubbing the hash", () => {
    history.replaceState(null, "", `${location.pathname}?onboarding=1#token=abc`);
    pickupAuthFromHash();
    expect(location.search).toBe("?onboarding=1");
    expect(location.hash).toBe("");
  });
});
