/**
 * Lead generation — test helpers: recorded fixtures and a routed mock
 * `fetch` / DNS so tests never touch the network.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { LeadgenDeps, MxRecord } from "./types.js";

const FIXTURES = join(import.meta.dirname, "fixtures");

export function fixture(name: string): string {
  return readFileSync(join(FIXTURES, name), "utf8");
}

export type Route = (req: {
  url: URL;
  method: string;
  body: string;
}) => Response | Promise<Response> | null | undefined;

export function html(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function text(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "text/plain" } });
}

/** A fetch that walks `routes` in order; unmatched URLs 404. Records every call. */
export function mockFetch(routes: Route[]): {
  fetch: typeof fetch;
  calls: Array<{ url: string; method: string }>;
} {
  const calls: Array<{ url: string; method: string }> = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url,
    );
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? init.body : "";
    calls.push({ url: url.toString(), method });
    for (const r of routes) {
      const res = await r({ url, method, body });
      if (res) return res;
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { fetch: f, calls };
}

/** Route for the Boise Smiles fixture site (home, contact, team, robots). */
export const boiseSmilesSite: Route = ({ url }) => {
  if (url.hostname !== "www.boisesmiles.com") return null;
  switch (url.pathname) {
    case "/robots.txt":
      return text(fixture("robots.txt"));
    case "/":
      return html(fixture("site-home.html"));
    case "/contact-us/":
      return html(fixture("site-contact.html"));
    case "/about/team":
      return html(fixture("site-team.html"));
    default:
      return html("<h1>Not found</h1>", 404);
  }
};

export function mockMx(
  withMx: string[],
  dnsFail: string[] = [],
): LeadgenDeps["resolveMx"] & { calls: string[] } {
  const calls: string[] = [];
  const fn = async (domain: string): Promise<MxRecord[]> => {
    calls.push(domain);
    if (dnsFail.includes(domain)) throw Object.assign(new Error("timeout"), { code: "ETIMEOUT" });
    if (withMx.includes(domain)) return [{ exchange: `mx.${domain}`, priority: 10 }];
    throw Object.assign(new Error("no data"), { code: "ENODATA" });
  };
  return Object.assign(fn, { calls });
}

export function baseDeps(extra: Partial<LeadgenDeps> = {}): LeadgenDeps {
  return {
    lookupHost: async () => [{ address: "93.184.216.34", family: 4 }],
    sleep: async () => undefined,
    hostIntervalMs: 0,
    pollIntervalMs: 0,
    env: {},
    secrets: {
      encrypt: (s) => `enc:${Buffer.from(s).toString("base64")}`,
      decrypt: (s) => (s.startsWith("enc:") ? Buffer.from(s.slice(4), "base64").toString() : null),
    },
    ...extra,
  };
}
