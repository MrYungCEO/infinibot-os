import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import { classifyHttpRoute } from "./http-auth.js";
import {
  handleDeepLinkOpenerRequest,
  renderOpenerPage,
  resolveOpenerTarget,
} from "./server-deeplink-http.js";

const plugins = [
  {
    id: "infinitrade",
    status: "loaded",
    enabled: true,
    contributes: {
      pages: [
        { tab: "infinitrade", route: "/infinitrade" },
        { tab: "infinitrade-signals", route: "/infinitrade/signals" },
      ],
    },
  },
];

function fakeRes() {
  const headers: Record<string, string> = {};
  const out = { statusCode: 0, body: "" as string | undefined, headers };
  const res = {
    set statusCode(v: number) {
      out.statusCode = v;
    },
    setHeader: (k: string, v: string) => {
      headers[k.toLowerCase()] = v;
    },
    end: (b?: string) => {
      out.body = b;
    },
  } as unknown as ServerResponse;
  return { res, out };
}

describe("/m/* deep-link opener", () => {
  it("is a public (static) GET route", () => {
    expect(classifyHttpRoute("GET", "/m/approvals/a1")).toBe("static");
    expect(classifyHttpRoute("GET", "/m")).toBe("static");
  });

  it("resolves the app link and the same-origin web route", () => {
    expect(resolveOpenerTarget("/m/plugin/infinitrade/signals?signal=abc", { plugins })).toEqual({
      path: "plugin/infinitrade/signals?signal=abc",
      appLink: "infinibot://plugin/infinitrade/signals?signal=abc",
      webRoute: "/infinitrade/signals?signal=abc",
    });
    expect(resolveOpenerTarget("/m/approvals/a1", { plugins, basePath: "/ui/" })?.webRoute).toBe(
      "/ui/autonomy?view=approvals&approval=a1",
    );
    expect(resolveOpenerTarget("/m", { plugins })?.webRoute).toBe("/dashboard");
    expect(resolveOpenerTarget("/mobile", { plugins })).toBeNull();
  });

  it("never yields an off-origin web route", () => {
    for (const url of [
      "/m//evil.com",
      "/m/web//evil.com/x",
      "/m/%2F%2Fevil.com",
      "/m/web/%5C%5Cevil.com",
    ]) {
      const t = resolveOpenerTarget(url, { plugins })!;
      expect(t.webRoute.startsWith("/")).toBe(true);
      expect(t.webRoute.startsWith("//")).toBe(false);
      expect(t.webRoute.startsWith("/\\")).toBe(false);
    }
    expect(resolveOpenerTarget("/m/web/javascript:alert(1)", { plugins })!.webRoute).toBe(
      "/javascript%3Aalert(1)",
    );
  });

  it("renders a CSP-nonced page with escaped links and the intent hand-off", async () => {
    const { res, out } = fakeRes();
    const handled = await handleDeepLinkOpenerRequest(
      { method: "GET", url: "/m/runs/r%3Cscript%3E" } as IncomingMessage,
      res,
      { plugins },
    );
    expect(handled).toBe(true);
    expect(out.statusCode).toBe(200);
    const csp = out.headers["content-security-policy"];
    const nonce = /'nonce-([^']+)'/.exec(csp)![1];
    expect(out.body).toContain(`<script nonce="${nonce}">`);
    expect(out.body).toContain("<title>Opening InfiniBot…</title>");
    expect(out.body).toContain("scheme=infinibot;S.browser_fallback_url=");
    expect(out.body).not.toContain("<script>alert");
    expect(out.body).toContain('href="/reviews?run=r%3Cscript%3E"');
  });

  it("escapes a hostile path in the inline JSON", () => {
    const html = renderOpenerPage(
      { path: "x</script><script>alert(1)", appLink: "infinibot://x", webRoute: "/dashboard" },
      "n",
    );
    expect(html).not.toContain("</script><script>alert");
  });

  it("ignores other paths and methods; assetlinks only when configured", async () => {
    const { res } = fakeRes();
    expect(
      await handleDeepLinkOpenerRequest({ method: "POST", url: "/m/x" } as IncomingMessage, res),
    ).toBe(false);
    expect(
      await handleDeepLinkOpenerRequest({ method: "GET", url: "/mesh" } as IncomingMessage, res),
    ).toBe(false);
    expect(
      await handleDeepLinkOpenerRequest(
        { method: "GET", url: "/.well-known/assetlinks.json" } as IncomingMessage,
        res,
        {
          env: {},
        },
      ),
    ).toBe(false);
    const { res: r2, out } = fakeRes();
    expect(
      await handleDeepLinkOpenerRequest(
        { method: "GET", url: "/.well-known/assetlinks.json" } as IncomingMessage,
        r2,
        {
          env: {
            INFINIBOT_ANDROID_APP_LINKS_JSON:
              '[{"relation":["delegate_permission/common.handle_all_urls"]}]',
          },
        },
      ),
    ).toBe(true);
    expect(JSON.parse(out.body!)[0].relation[0]).toContain("handle_all_urls");
  });
});
