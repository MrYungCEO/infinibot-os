import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import { _resetMobileWebRootForTests, handleMobileWebHttpRequest } from "./mobile-web-static.js";

function call(url: string): { status: number; body: string } {
  const out = { status: 0, body: "" };
  const res = {
    statusCode: 200,
    setHeader: () => undefined,
    end(b?: unknown) {
      out.status = (this as { statusCode: number }).statusCode;
      out.body = b == null ? "" : Buffer.isBuffer(b) ? b.toString() : (b as string);
    },
  } as unknown as ServerResponse;
  handleMobileWebHttpRequest({ url, method: "GET" } as IncomingMessage, res);
  return out;
}

describe("mobile-web static bundle", () => {
  let tmp = "";
  afterEach(() => {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    _resetMobileWebRootForTests();
  });

  it("serves a bundle exported after the first (missing) request — no restart needed", () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mobile-web-"));
    _resetMobileWebRootForTests([path.join(tmp, "mobile", "dist")]);
    expect(call("/mobile-web/").status).toBe(503);
    fs.mkdirSync(path.join(tmp, "mobile", "dist"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "mobile", "dist", "index.html"), "<html>infini</html>");
    const hit = call("/mobile-web/");
    expect(hit.status).toBe(200);
    expect(hit.body).toContain("infini");
  });
});
