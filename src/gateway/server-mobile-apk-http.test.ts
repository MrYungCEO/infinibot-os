import { createHash } from "node:crypto";
import fs from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { classifyHttpRoute } from "./http-auth.js";
import {
  MOBILE_APK_LINK_TTL_MS,
  handleMobileApkHttpRequest,
  normalizeBaseOrigin,
  resetMobileApkLinkKeyCacheForTest,
  signMobileApkLink,
  getMobileApkLinkKey,
} from "./server-mobile-apk-http.js";

const APK_BYTES = Buffer.from("PK\u0003\u0004 fake apk payload ".repeat(64));
const FILE = "infinibot-1.2.3.apk";

let stateDir: string;
let server: Server;
let base: string;
let nowMs = Date.now();
const env = () => ({ INFINIBOT_STATE_DIR: stateDir }) as NodeJS.ProcessEnv;

function publish() {
  const dir = path.join(stateDir, "mobile", "apk");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, FILE), APK_BYTES);
  fs.writeFileSync(
    path.join(dir, "latest.json"),
    JSON.stringify({
      version: "1.2.3",
      versionCode: 42,
      buildDate: "2026-09-30T00:00:00.000Z",
      size: APK_BYTES.length,
      sha256: createHash("sha256").update(APK_BYTES).digest("hex"),
      file: FILE,
      package: "ai.infinibot.app",
    }),
  );
}

beforeAll(async () => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "mobile-apk-test-"));
  server = createServer((req, res) => {
    void handleMobileApkHttpRequest(req, res, { env: env(), now: () => nowMs }).then((handled) => {
      if (!handled) {
        res.statusCode = 404;
        res.end("unhandled");
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  fs.rmSync(stateDir, { recursive: true, force: true });
});

beforeEach(() => {
  nowMs = Date.now();
  fs.rmSync(path.join(stateDir, "mobile"), { recursive: true, force: true });
});

describe("route classification", () => {
  it("keeps /api/mobile/apk* behind the gate and the signed path public-static", () => {
    expect(classifyHttpRoute("GET", "/api/mobile/apk")).toBe("protected");
    expect(classifyHttpRoute("GET", "/api/mobile/apk/download")).toBe("protected");
    expect(classifyHttpRoute("HEAD", "/api/mobile/apk/download")).toBe("protected");
    expect(classifyHttpRoute("POST", "/api/mobile/apk/link")).toBe("protected");
    expect(classifyHttpRoute("GET", `/mobile-apk/${FILE}`)).toBe("static");
    expect(classifyHttpRoute("POST", `/mobile-apk/${FILE}`)).toBe("protected");
  });
});

describe("handleMobileApkHttpRequest", () => {
  it("ignores unrelated paths", async () => {
    const res = await fetch(`${base}/api/other`);
    expect(await res.text()).toBe("unhandled");
  });

  it("reports available:false when nothing is published", async () => {
    const res = await fetch(`${base}/api/mobile/apk`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ available: false });
    expect((await fetch(`${base}/api/mobile/apk/download`)).status).toBe(404);
    expect((await fetch(`${base}/api/mobile/apk/link`, { method: "POST" })).status).toBe(404);
  });

  it("returns the manifest", async () => {
    publish();
    const body = (await (await fetch(`${base}/api/mobile/apk`)).json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      available: true,
      version: "1.2.3",
      versionCode: 42,
      file: FILE,
      size: APK_BYTES.length,
      package: "ai.infinibot.app",
    });
  });

  it("streams the APK with download headers, HEAD and Range", async () => {
    publish();
    const res = await fetch(`${base}/api/mobile/apk/download`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/vnd.android.package-archive");
    expect(res.headers.get("content-disposition")).toContain(`filename="${FILE}"`);
    expect(res.headers.get("content-length")).toBe(String(APK_BYTES.length));
    expect(Buffer.from(await res.arrayBuffer()).equals(APK_BYTES)).toBe(true);

    const head = await fetch(`${base}/api/mobile/apk/download`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe(String(APK_BYTES.length));

    const part = await fetch(`${base}/api/mobile/apk/download`, {
      headers: { Range: "bytes=0-9" },
    });
    expect(part.status).toBe(206);
    expect(Buffer.from(await part.arrayBuffer()).equals(APK_BYTES.subarray(0, 10))).toBe(true);
  });

  it("mints a signed link with a QR that downloads, and rejects tampering/expiry", async () => {
    publish();
    const res = await fetch(`${base}/api/mobile/apk/link`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ baseUrl: "http://192.168.1.110:18789/some/path" }),
    });
    expect(res.status).toBe(200);
    const link = (await res.json()) as {
      url: string;
      path: string;
      expiresAt: number;
      qrSvg: string;
    };
    expect(link.url.startsWith(`http://192.168.1.110:18789/mobile-apk/${FILE}?exp=`)).toBe(true);
    expect(link.expiresAt).toBe(nowMs + MOBILE_APK_LINK_TTL_MS);
    expect(link.qrSvg.startsWith("<svg")).toBe(true);

    const ok = await fetch(`${base}${link.path}`);
    expect(ok.status).toBe(200);
    expect(Buffer.from(await ok.arrayBuffer()).equals(APK_BYTES)).toBe(true);

    const tampered = link.path.replace(
      /sig=(.)/,
      (_m, c: string) => `sig=${c === "A" ? "B" : "A"}`,
    );
    expect((await fetch(`${base}${tampered}`)).status).toBe(403);
    const otherExp = link.path.replace(/exp=\d+/, `exp=${link.expiresAt + 60_000}`);
    expect((await fetch(`${base}${otherExp}`)).status).toBe(403);
    expect((await fetch(`${base}/mobile-apk/${FILE}`)).status).toBe(403);

    nowMs = link.expiresAt + 1;
    expect((await fetch(`${base}${link.path}`)).status).toBe(403);
  });

  it("returns a relative url and no QR when baseUrl is not an http(s) origin", async () => {
    publish();
    const res = await fetch(`${base}/api/mobile/apk/link`, {
      method: "POST",
      body: JSON.stringify({ baseUrl: "javascript:alert(1)" }),
    });
    const link = (await res.json()) as { url: string; qrSvg: string | null };
    expect(link.url.startsWith(`/mobile-apk/${FILE}?exp=`)).toBe(true);
    expect(link.qrSvg).toBeNull();
  });

  it("refuses names outside the SAFE_NAME pattern even with a valid signature", async () => {
    publish();
    const key = getMobileApkLinkKey(env());
    const exp = nowMs + 60_000;
    for (const name of ["latest.json", "..%2Flatest.json", "infinibot-..%2F..%2Fx.apk"]) {
      const decoded = decodeURIComponent(name);
      const sig = signMobileApkLink(decoded, exp, key);
      expect((await fetch(`${base}/mobile-apk/${name}?exp=${exp}&sig=${sig}`)).status).toBe(403);
    }
  });

  it("persists the link key (0600) so links survive a restart", async () => {
    publish();
    const key = getMobileApkLinkKey(env());
    const keyFile = path.join(stateDir, "credentials", "mobile-apk-link.key");
    expect(fs.readFileSync(keyFile).equals(key)).toBe(true);
    expect(fs.statSync(keyFile).mode & 0o777).toBe(0o600);
    const exp = nowMs + 60_000;
    const sig = signMobileApkLink(FILE, exp, key);
    resetMobileApkLinkKeyCacheForTest();
    expect((await fetch(`${base}/mobile-apk/${FILE}?exp=${exp}&sig=${sig}`)).status).toBe(200);
  });

  it("rejects non-GET on the signed path", async () => {
    publish();
    expect((await fetch(`${base}/mobile-apk/${FILE}`, { method: "POST" })).status).toBe(405);
  });
});

describe("normalizeBaseOrigin", () => {
  it("accepts http(s) origins only", () => {
    expect(normalizeBaseOrigin("https://host.tail1234.ts.net:18789/x?y")).toBe(
      "https://host.tail1234.ts.net:18789",
    );
    expect(normalizeBaseOrigin("ws://1.2.3.4:18789")).toBeNull();
    expect(normalizeBaseOrigin("http://user:pw@1.2.3.4")).toBeNull();
    expect(normalizeBaseOrigin(42)).toBeNull();
  });
});
