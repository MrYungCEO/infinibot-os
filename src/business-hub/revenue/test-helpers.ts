/**
 * Business hub revenue — test helpers: load the anonymised recorded
 * fixtures and serve them through a fake `fetch` that routes Whop v1
 * (cursor), Whop v5 (page) and Stripe (`starting_after`) list requests.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { FetchLike, HttpResponseLike } from "./http.js";
import { list, rec, s } from "./types.js";

export type PagedFixture = Record<string, unknown[]>;

export function loadFixture(name: string): PagedFixture {
  return JSON.parse(
    readFileSync(fileURLToPath(new URL(`./fixtures/${name}.json`, import.meta.url)), "utf8"),
  ) as PagedFixture;
}

export function response(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): HttpResponseLike {
  const h = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    status,
    headers: { get: (n: string) => h.get(n.toLowerCase()) ?? null },
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  };
}

export type FixtureFetch = FetchLike & { calls: string[]; methods: string[] };

export function fixtureFetch(
  fx: { whopV1?: PagedFixture; whopV5?: PagedFixture; stripe?: PagedFixture },
  opts: { fail?: (url: URL) => boolean } = {},
): FixtureFetch {
  const calls: string[] = [];
  const methods: string[] = [];
  const base: FetchLike = async (url, init) => {
    calls.push(url);
    methods.push(init.method);
    const u = new URL(url);
    if (opts.fail?.(u)) throw new Error("simulated network failure");
    if (u.hostname === "api.whop.com" && u.pathname.startsWith("/api/v1/")) {
      const pages = fx.whopV1?.[u.pathname.slice(8)];
      if (!fx.whopV1)
        return response(404, { error: { type: "not_found", message: "Bot was not found" } });
      if (!pages) return response(404, { error: { message: "not found" } });
      const after = u.searchParams.get("after");
      let i = 0;
      if (after) i = pages.findIndex((p) => s(rec(rec(p).page_info).end_cursor) === after) + 1;
      return response(200, pages[i] ?? { data: [], page_info: { has_next_page: false } });
    }
    if (u.hostname === "api.whop.com" && u.pathname.startsWith("/v5/company/")) {
      const pages = fx.whopV5?.[u.pathname.slice(12)];
      if (!pages) return response(404, { error: { message: "not found" } });
      const page = Number(u.searchParams.get("page") ?? "1");
      return response(
        200,
        pages[page - 1] ?? {
          data: [],
          pagination: { current_page: page, total_pages: pages.length },
        },
      );
    }
    if (u.hostname === "api.stripe.com") {
      const pages = fx.stripe?.[u.pathname.slice(4)];
      if (!pages) return response(404, { error: { message: "no such list" } });
      const after = u.searchParams.get("starting_after");
      let i = 0;
      if (after)
        i =
          pages.findIndex((p) => {
            const d = list(rec(p).data);
            return s(rec(d[d.length - 1]).id) === after;
          }) + 1;
      return response(200, pages[i] ?? { object: "list", has_more: false, data: [] });
    }
    return response(404, { error: "unknown host" });
  };
  return Object.assign(base, { calls, methods });
}

export const noSleep = async (): Promise<void> => {};
