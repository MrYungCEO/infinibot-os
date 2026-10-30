/**
 * Code extraction is where this goes wrong quietly: a body is full of numbers
 * that look like codes, and a stale code fails on the handset while looking like
 * success. These pin both.
 */
import { describe, it, expect } from "vitest";
import { extractCode, findVerificationCode } from "./verification-mail.js";

describe("extracting a code", () => {
  it("prefers the subject, where platforms put it", () => {
    expect(extractCode("482913 is your Instagram code", "Ignore this: 2024 999999")).toBe("482913");
  });

  it("reads a labelled code out of the body", () => {
    expect(
      extractCode(
        "Verify your account",
        "Your confirmation code is 771204. It expires in 10 minutes.",
      ),
    ).toBe("771204");
  });

  it("reads a code standing alone on its own line", () => {
    expect(extractCode("Instagram", "Hi there\n\n  553271  \n\nThanks")).toBe("553271");
  });

  it("does not mistake stray numbers for a code", () => {
    expect(
      extractCode("Welcome to Instagram", "Founded in 2010. Port 993. Unsubscribe id 12."),
    ).toBeNull();
  });
});

describe("finding the newest code", () => {
  const creds = {
    clientId: "id",
    clientSecret: "secret",
    refreshToken: "refresh",
    email: "ops@example",
  };
  const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64url");

  const fakeGmail = (
    messages: Array<{ id: string; subject: string; age: number; body?: string }>,
  ) =>
    (async (url: string) => {
      const href = String(url);
      if (href.includes("oauth2")) return { json: async () => ({ access_token: "at" }) } as never;
      if (href.includes("/messages?")) {
        return { json: async () => ({ messages: messages.map((m) => ({ id: m.id })) }) } as never;
      }
      const id = href.split("/messages/")[1].split("?")[0];
      const m = messages.find((x) => x.id === id)!;
      return {
        json: async () => ({
          internalDate: String(Date.now() - m.age),
          payload: {
            headers: [
              { name: "Subject", value: m.subject },
              { name: "From", value: "security@mail.instagram.com" },
            ],
            body: { data: b64(m.body ?? "") },
          },
        }),
      } as never;
    }) as unknown as typeof fetch;

  it("returns a fresh code", async () => {
    const hit = await findVerificationCode("ava-pipnotes@ops.example", {
      creds,
      fetchImpl: fakeGmail([{ id: "1", subject: "662104 is your Instagram code", age: 30_000 }]),
    });
    expect(hit?.code).toBe("662104");
  });

  it("skips a stale one rather than replaying it", async () => {
    const hit = await findVerificationCode("ava-pipnotes@ops.example", {
      creds,
      withinMs: 60_000,
      fetchImpl: fakeGmail([
        { id: "1", subject: "112233 is your Instagram code", age: 45 * 60_000 },
      ]),
    });
    expect(hit).toBeNull();
  });

  it("returns null when nothing has arrived, so the caller can halt", async () => {
    const hit = await findVerificationCode("nobody@ops.example", {
      creds,
      fetchImpl: fakeGmail([]),
    });
    expect(hit).toBeNull();
  });

  it("refuses to run with no Gmail connection", async () => {
    await expect(
      findVerificationCode("a@b.c", { creds: null, fetchImpl: fakeGmail([]) }),
    ).rejects.toThrow(/No Gmail connection/i);
  });
});
