import { describe, expect, it } from "vitest";

import { startKvIntentLink, takeKvIntentFromUrl, withReturn } from "./kv-connect-intent";

const INTENT = "b".repeat(32);

function fakeWin(href: string) {
  const store = new Map<string, string>();
  const win = {
    location: { href },
    history: {
      state: null,
      replaceState: (_s: unknown, _t: string, url: string) => {
        win.location.href = new URL(url, href).toString();
      },
    },
    sessionStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    },
  };
  return win as unknown as Window;
}

describe("KinglyVault → Cloud app connect intent", () => {
  it("takes the intent from the URL, cleans the address bar and remembers it across a sign-in redirect", () => {
    const win = fakeWin(`https://cloud.infinibotos.com/app/plugins?x=1&kvconnect=start&kvintent=${INTENT}#top`);
    expect(takeKvIntentFromUrl(win)).toBe(INTENT);
    expect(win.location.href).toBe("https://cloud.infinibotos.com/app/plugins?x=1#top");
    expect(takeKvIntentFromUrl(win)).toBe(INTENT); // from sessionStorage after a redirect
  });

  it("ignores pages without the marker and junk intents", () => {
    expect(takeKvIntentFromUrl(fakeWin(`https://cloud.infinibotos.com/app/?kvintent=${INTENT}`))).toBeNull();
    expect(takeKvIntentFromUrl(fakeWin("https://cloud.infinibotos.com/app/?kvconnect=start&kvintent=%3Cscript%3E"))).toBeNull();
  });

  it("starts kvconnect.start with the intent and adds the return URL", async () => {
    const calls: Array<{ m: string; p: unknown }> = [];
    const client = {
      supports: (m: string) => m === "kvconnect.start",
      request: async (m: string, p: unknown) => {
        calls.push({ m, p });
        return { linking: { verifyUrl: "https://kinglyvault.com/infinibot/link?code=BCDF-GHJK" } };
      },
    };
    const url = await startKvIntentLink(client as never, INTENT, "https://cloud.infinibotos.com/app/");
    expect(calls).toEqual([{ m: "kvconnect.start", p: { intent: INTENT } }]);
    expect(url).toBe(withReturn("https://kinglyvault.com/infinibot/link?code=BCDF-GHJK", "https://cloud.infinibotos.com/app/"));
    expect(new URL(url!).searchParams.get("return")).toBe("https://cloud.infinibotos.com/app/");
    expect(await startKvIntentLink({ supports: () => false, request: async () => ({}) } as never, INTENT, "x")).toBeNull();
  });
});
