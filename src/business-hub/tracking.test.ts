import { createContext, runInContext } from "node:vm";
import { afterEach, describe, expect, it } from "vitest";
import { timeline, upsertContact } from "./contacts.js";
import { openHubDb, type HubDb } from "./db.js";
import { resetEmailRuntime } from "./email/config.js";
import { startHttp } from "./email/test-helpers.js";
import { contactToken } from "./email/tokens.js";
import { createBusinessHubDispatcher } from "./http.js";
import { SNIPPET_JS, snippetHtml } from "./tracking-snippet.js";
import { ingestEvents, saveSite, trackingStats, validateEvent } from "./tracking.js";

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
  resetEmailRuntime();
});

const ORIGIN = "https://landing.example.com";
const ev = (k: string, extra: Record<string, unknown> = {}) => ({
  k,
  t: "page_view",
  u: `${ORIGIN}/`,
  a: "anon_abcdef01",
  s: "sess_abcdef01",
  ...extra,
});

function site(db: HubDb, origins: string[] = [ORIGIN], consentMode = "cookieless") {
  return saveSite(db, { name: "Landing", origins, consentMode });
}

describe("ingest", () => {
  it("enforces the origin allowlist (and flags sites without one)", () => {
    const db = openHubDb(":memory:");
    const s = site(db, [ORIGIN, "*.acme.example"]);
    expect(
      ingestEvents(db, "https://evil.example.net", { events: [ev(s.publicKey)] }),
    ).toMatchObject({
      accepted: 0,
      rejected: 1,
      errors: ["origin not allowed"],
    });
    expect(ingestEvents(db, null, [ev(s.publicKey)]).accepted).toBe(0);
    expect(ingestEvents(db, ORIGIN, [ev(s.publicKey)]).accepted).toBe(1);
    expect(ingestEvents(db, "https://shop.acme.example", [ev(s.publicKey)]).accepted).toBe(1);
    const open = site(db, []);
    const r = ingestEvents(db, "https://anything.example.org", [ev(open.publicKey)]);
    expect(r.accepted).toBe(1);
    expect(r.originUnverified).toBe(true);
    expect(ingestEvents(db, ORIGIN, [ev("pk_unknownkey123")]).errors).toEqual(["unknown site key"]);
  });

  it("validates events strictly", () => {
    const k = "pk_abcdefghijkl";
    expect(validateEvent(ev(k)).ok).toBe(true);
    expect(validateEvent({ ...ev(k), ip: "1.2.3.4" })).toMatchObject({ ok: false });
    expect(validateEvent({ ...ev(k), t: "purchase" })).toMatchObject({ ok: false });
    expect(validateEvent({ ...ev(k), u: "javascript:alert(1)" })).toMatchObject({ ok: false });
    expect(validateEvent({ ...ev(k), e: "a@example.com" })).toMatchObject({ ok: false }); // not on page_view
    const props = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`k${i}`, i]));
    expect(validateEvent({ ...ev(k), p: props })).toMatchObject({ ok: false });
    expect(validateEvent({ ...ev(k), p: { a: "x".repeat(257) } })).toMatchObject({ ok: false });
    expect(validateEvent({ ...ev(k), p: { a: { nested: 1 } } })).toMatchObject({ ok: false });
    const f = validateEvent({
      ...ev(k),
      t: "form_submit",
      f: { email: "a@example.com", password: "x", card_number: "4242" },
    });
    expect(f.ok && f.ev.f).toEqual({ email: "a@example.com" });
    const db = openHubDb(":memory:");
    const s = site(db);
    expect(
      ingestEvents(
        db,
        ORIGIN,
        Array.from({ length: 21 }, () => ev(s.publicKey)),
      ).accepted,
    ).toBe(0);
  });

  it("captures UTMs → campaign and stitches identity on form submit, back-filling earlier events", () => {
    const db = openHubDb(":memory:");
    const s = site(db);
    const submitted: string[] = [];
    const a = { a: "anon_visitor1", s: "sess_visitor1" };
    ingestEvents(db, ORIGIN, [
      ev(s.publicKey, {
        ...a,
        u: `${ORIGIN}/?utm_source=facebook&utm_medium=cpc&utm_campaign=Spring%20Sale`,
        r: "https://facebook.com/",
        n: "Home",
      }),
      ev(s.publicKey, {
        ...a,
        u: `${ORIGIN}/pricing`,
        utm: { source: "facebook", medium: "cpc", campaign: "Spring Sale" },
      }),
    ]);
    const camp = db
      .prepare("SELECT id, channel FROM campaigns WHERE utm_campaign = 'spring sale'")
      .get() as {
      id: string;
      channel: string;
    };
    expect(camp.channel).toBe("paid");
    const anonEvents = db
      .prepare("SELECT contact_id, campaign_id FROM track_events")
      .all() as Array<{
      contact_id: string | null;
      campaign_id: string;
    }>;
    expect(anonEvents.every((e) => e.contact_id === null && e.campaign_id === camp.id)).toBe(true);

    const r = ingestEvents(
      db,
      ORIGIN,
      {
        events: [
          ev(s.publicKey, {
            ...a,
            t: "form_submit",
            n: "demo",
            u: `${ORIGIN}/pricing`,
            f: {
              email: "Lead@Example.com",
              first_name: "Lee",
              company: "Acme",
              phone: "512-555-0100",
              newsletter: true,
            },
          }),
        ],
      },
      { hooks: { onFormSubmitted: (cid) => submitted.push(cid) } },
    );
    expect(r.contactIds).toHaveLength(1);
    const cid = r.contactIds[0];
    expect(submitted).toEqual([cid]);
    const c = db.prepare("SELECT * FROM contacts WHERE id = ?").get(cid) as Record<string, unknown>;
    expect(c.email).toBe("lead@example.com");
    expect(c.lifecycle).toBe("lead");
    expect(c.email_opt_in).toBe(1);
    expect(c.first_campaign_id).toBe(camp.id);
    expect(c.phone_e164).toBe("+15125550100");
    const src = db
      .prepare("SELECT kind, name FROM sources WHERE id = ?")
      .get(c.first_source_id) as Record<string, string>;
    expect(src).toEqual({ kind: "paid", name: "facebook" });
    const all = db.prepare("SELECT contact_id FROM track_events").all() as Array<{
      contact_id: string;
    }>;
    expect(all).toHaveLength(3);
    expect(all.every((e) => e.contact_id === cid)).toBe(true); // back-filled
    const types = timeline(db, "contact", cid).map((x) => x.type);
    expect(types).toContain("form.submitted");
    expect(types).toContain("page.viewed");

    const stats = trackingStats(db, s.id, { from: 0 });
    expect(stats).toMatchObject({
      pageViews: 2,
      uniqueVisitors: 1,
      formSubmits: 1,
      conversionRate: 1,
    });
    expect(stats.byReferrer.map((r) => r.domain)).toContain("facebook.com");
    expect(stats.topContacts).toHaveLength(1);
  });

  it("stitches a visitor from an email-click contact token (ct)", () => {
    const db = openHubDb(":memory:");
    const s = site(db);
    const c = upsertContact(db, { email: "clicker@example.com" })!.contact;
    const r = ingestEvents(db, ORIGIN, [ev(s.publicKey, { ct: contactToken(db, c.id) })]);
    expect(r.contactIds).toEqual([c.id]);
    expect(
      ingestEvents(db, ORIGIN, [ev(s.publicKey, { a: "anon_other01", ct: "forged.token" })])
        .contactIds,
    ).toEqual([]);
  });
});

describe("collector endpoint", () => {
  it("cookieless: rotates the visitor key, keeps only the edge country, never stores the IP", async () => {
    const db = openHubDb(":memory:");
    const s = site(db);
    const srv = await startHttp(createBusinessHubDispatcher({ getDb: () => db }));
    closers.push(srv.close);
    const url = `${srv.url}/plugins/business-agency/t/c`;
    const pre = await fetch(url, { method: "OPTIONS", headers: { origin: ORIGIN } });
    expect(pre.status).toBe(204);
    const res = await fetch(url, {
      method: "POST",
      headers: {
        origin: ORIGIN,
        "content-type": "text/plain",
        "x-forwarded-for": "203.0.113.77",
        "cf-ipcountry": "DE",
      },
      body: JSON.stringify({ events: [ev(s.publicKey)] }),
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    const v = db.prepare("SELECT * FROM visitors").get() as Record<string, unknown>;
    expect(v.anon_id).not.toBe("anon_abcdef01");
    const e = db.prepare("SELECT * FROM track_events").get() as Record<string, unknown>;
    expect(JSON.parse(e.props as string)).toEqual({ geo_country: "DE" });
    const dump = JSON.stringify([
      db.prepare("SELECT * FROM visitors").all(),
      db.prepare("SELECT * FROM track_events").all(),
    ]);
    expect(dump).not.toContain("203.0.113.77");
    const bad = await fetch(url, {
      method: "POST",
      headers: { origin: "https://evil.example.net" },
      body: JSON.stringify([ev(s.publicKey)]),
    });
    expect(bad.status).toBe(400);
    expect(bad.headers.get("access-control-allow-origin")).toBeNull();
    const big = await fetch(url, { method: "POST", body: "x".repeat(70 * 1024) });
    expect(big.status).toBe(413);
    const js = await fetch(`${srv.url}/plugins/business-agency/t/s.js`);
    expect(js.headers.get("cache-control")).toBe("public, max-age=3600");
    expect(await js.text()).toBe(SNIPPET_JS);
  });

  it("rate-limits per IP + site", async () => {
    const db = openHubDb(":memory:");
    const s = site(db);
    const srv = await startHttp(
      createBusinessHubDispatcher({ getDb: () => db, collectPerMinute: 2 }),
    );
    closers.push(srv.close);
    const post = () =>
      fetch(`${srv.url}/plugins/business-agency/t/c`, {
        method: "POST",
        headers: { origin: ORIGIN },
        body: JSON.stringify([ev(s.publicKey)]),
      });
    expect((await post()).status).toBe(204);
    expect((await post()).status).toBe(204);
    expect((await post()).status).toBe(429);
  });
});

describe("snippet", () => {
  it("is small and the install tag carries site key + mode", () => {
    expect(Buffer.byteLength(SNIPPET_JS)).toBeLessThan(4096);
    expect(
      snippetHtml({ publicKey: "pk_x", consentMode: "consent" }, "https://hub.example.test/"),
    ).toBe(
      '<script defer src="https://hub.example.test/plugins/business-agency/t/s.js" data-site="pk_x" data-mode="consent"></script>',
    );
  });

  function runSnippet(opts: { dnt?: boolean; gpc?: boolean; mode?: string; search?: string }) {
    const beacons: Blob[] = [];
    const timers: Array<() => void> = [];
    const listeners: Record<string, Array<(e: unknown) => void>> = {};
    const store = () => {
      const m = new Map<string, string>();
      return {
        getItem: (k: string) => m.get(k) ?? null,
        setItem: (k: string, v: string) => void m.set(k, v),
        removeItem: (k: string) => void m.delete(k),
      };
    };
    const attrs: Record<string, string> = {
      "data-site": "pk_abcdefghijkl",
      "data-mode": opts.mode ?? "cookieless",
    };
    const location = {
      href: `${ORIGIN}/${opts.search ?? ""}`,
      search: opts.search ?? "",
      pathname: "/",
      hash: "",
    };
    const history = { state: null, pushState() {}, replaceState() {} };
    const win: Record<string, unknown> = {
      navigator: {
        doNotTrack: opts.dnt ? "1" : null,
        globalPrivacyControl: opts.gpc === true,
        sendBeacon: (_u: string, b: Blob) => {
          beacons.push(b);
          return true;
        },
      },
      document: {
        currentScript: {
          src: "https://hub.example.test/plugins/business-agency/t/s.js",
          getAttribute: (n: string) => attrs[n] ?? null,
          hasAttribute: (n: string) => n in attrs,
        },
        documentElement: { getAttribute: () => null },
        title: "Home",
        referrer: "https://www.google.com/",
        addEventListener: (t: string, fn: (e: unknown) => void) => (listeners[t] ??= []).push(fn),
        querySelector: () => null,
      },
      location,
      history,
      sessionStorage: store(),
      localStorage: store(),
      addEventListener: () => {},
      setTimeout: (fn: () => void) => {
        timers.push(fn);
        return timers.length;
      },
      clearTimeout: () => {},
      URLSearchParams,
      Blob,
      fetch: () => Promise.resolve(),
    };
    win.window = win;
    runInContext(SNIPPET_JS, createContext(win));
    const flush = () => timers.splice(0).forEach((f) => f());
    return { win, beacons, flush, listeners };
  }

  it("sends nothing under Do-Not-Track / GPC", () => {
    for (const o of [{ dnt: true }, { gpc: true }]) {
      const r = runSnippet(o);
      r.flush();
      (r.win.ib as (c: string, n: string) => void)("event", "x");
      r.flush();
      expect(r.beacons).toHaveLength(0);
    }
  });

  it("consent mode waits for ibConsent(true)", () => {
    const r = runSnippet({ mode: "consent" });
    r.flush();
    expect(r.beacons).toHaveLength(0);
    (r.win.ibConsent as (v: boolean) => void)(true);
    r.flush();
    expect(r.beacons).toHaveLength(1);
  });

  it("emits a page view the collector accepts (UTMs + form capture skip secrets)", async () => {
    const r = runSnippet({ search: "?utm_source=news&utm_medium=email&utm_campaign=oct" });
    r.flush();
    expect(r.beacons).toHaveLength(1);
    const payload = JSON.parse(await r.beacons[0].text());
    expect(payload.events[0]).toMatchObject({
      t: "page_view",
      utm: { campaign: "oct" },
      r: "https://www.google.com/",
    });
    const db = openHubDb(":memory:");
    const s = site(db);
    payload.events[0].k = s.publicKey;
    expect(ingestEvents(db, ORIGIN, payload).accepted).toBe(1);

    const el = (name: string, value: string, type = "text") => ({
      name,
      value,
      type,
      checked: false,
      disabled: false,
    });
    const form = {
      hasAttribute: () => false,
      getAttribute: (n: string) => (n === "name" ? "signup" : null),
      id: "",
      elements: [
        el("email", "x@example.com", "email"),
        el("password", "hunter2", "password"),
        el("cc_number", "4242"),
        el("_token", "abc", "hidden"),
      ],
    };
    r.listeners.submit[0]({ target: form });
    const sub = JSON.parse(await r.beacons[1].text()).events[0];
    expect(sub).toMatchObject({
      t: "form_submit",
      n: "signup",
      e: "x@example.com",
      f: { email: "x@example.com" },
    });
    expect(Object.keys(sub.f)).toEqual(["email"]);
  });
});
