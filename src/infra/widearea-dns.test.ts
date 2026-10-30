import { describe, expect, it } from "vitest";

import { renderWideAreaGatewayZoneText, WIDE_AREA_DISCOVERY_DOMAIN } from "./widearea-dns.js";

describe("wide-area DNS-SD zone rendering", () => {
  it("renders a infinibot.internal zone with gateway PTR/SRV/TXT records", () => {
    const txt = renderWideAreaGatewayZoneText({
      serial: 2025121701,
      gatewayPort: 18789,
      displayName: "Mac Studio (InfiniBot)",
      tailnetIPv4: "100.64.10.8",
      tailnetIPv6: "fd7a:115c:a1e0::8801:e04c",
      hostLabel: "studio-london",
      instanceLabel: "studio-london",
      sshPort: 22,
      cliPath: "/opt/homebrew/bin/infinibot",
    });

    expect(txt).toContain(`$ORIGIN ${WIDE_AREA_DISCOVERY_DOMAIN}`);
    expect(txt).toContain(`studio-london IN A 100.64.10.8`);
    expect(txt).toContain(`studio-london IN AAAA fd7a:115c:a1e0::8801:e04c`);
    expect(txt).toContain(`_infinibot-gw._tcp IN PTR studio-london._infinibot-gw._tcp`);
    expect(txt).toContain(`studio-london._infinibot-gw._tcp IN SRV 0 0 18789 studio-london`);
    expect(txt).toContain(`displayName=Mac Studio (InfiniBot)`);
    expect(txt).toContain(`gatewayPort=18789`);
    expect(txt).toContain(`sshPort=22`);
    expect(txt).toContain(`cliPath=/opt/homebrew/bin/infinibot`);
  });

  it("includes tailnetDns when provided", () => {
    const txt = renderWideAreaGatewayZoneText({
      serial: 2025121701,
      gatewayPort: 18789,
      displayName: "Mac Studio (InfiniBot)",
      tailnetIPv4: "100.64.10.8",
      tailnetDns: "studio-mac-1.example-tailnet.ts.net",
      hostLabel: "studio-london",
      instanceLabel: "studio-london",
    });

    expect(txt).toContain(`tailnetDns=studio-mac-1.example-tailnet.ts.net`);
  });
});
