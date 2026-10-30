import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./cloud/cloud-env", () => ({ isCloudBuild: () => true }));

import { setResolvedGatewayUrl } from "./gateway-endpoint";
import { gatewayImageSrc, needsGatewayImageLoader } from "./gateway-image";

describe("plugin listing images across sites (hosted cloud)", () => {
  afterEach(() => {
    setResolvedGatewayUrl(null);
    vi.unstubAllGlobals();
  });

  it("same-origin (self-hosted): the gateway path is used directly", () => {
    vi.stubGlobal("location", { origin: "http://127.0.0.1:18789", href: "http://127.0.0.1:18789/setup" });
    expect(needsGatewayImageLoader("/api/plugins/assets/discipline/cover.png")).toBe(false);
    expect(gatewayImageSrc("/api/plugins/assets/discipline/cover.png", () => {})).toBe(
      "/api/plugins/assets/discipline/cover.png",
    );
  });

  it("cross-site: fetches the image from the tenant gateway (Bearer via the fetch wrapper) into a blob: URL", async () => {
    vi.stubGlobal("location", { origin: "https://infinibot-cloud.netlify.app", href: "https://infinibot-cloud.netlify.app/setup" });
    setResolvedGatewayUrl("wss://ib-gw-abc.fly.dev/ws");
    const fetchMock = vi.fn(async () => new Response(new Blob(["png"]), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: () => "blob:cover-1" }));
    const src = "/api/plugins/assets/discipline/cover-x.png";
    let changed = 0;
    expect(gatewayImageSrc(src, () => changed++)).toBeUndefined();
    await vi.waitFor(() => expect(changed).toBe(1));
    expect(fetchMock).toHaveBeenCalledWith("https://ib-gw-abc.fly.dev/api/plugins/assets/discipline/cover-x.png");
    expect(gatewayImageSrc(src, () => {})).toBe("blob:cover-1");
    // Absolute / data URLs are never proxied.
    expect(gatewayImageSrc("data:image/svg+xml,x", () => {})).toBe("data:image/svg+xml,x");
  });

  it("a failed load reports the image as broken", async () => {
    vi.stubGlobal("location", { origin: "https://infinibot-cloud.netlify.app", href: "https://infinibot-cloud.netlify.app/setup" });
    setResolvedGatewayUrl("wss://ib-gw-abc.fly.dev/ws");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("no", { status: 401 })));
    let broken = 0;
    gatewayImageSrc("/api/plugins/assets/x/missing.png", () => {}, () => broken++);
    await vi.waitFor(() => expect(broken).toBe(1));
  });
});
