import Testing
@testable import MoltbotDiscovery

@Suite
struct WideAreaGatewayDiscoveryTests {
    @Test func discoversBeaconFromTailnetDnsSdFallback() {
        let statusJson = """
        {
          "Self": { "TailscaleIPs": ["100.64.10.9"] },
          "Peer": {
            "peer-1": { "TailscaleIPs": ["100.64.10.8"] }
          }
        }
        """

        let context = WideAreaGatewayDiscovery.DiscoveryContext(
            tailscaleStatus: { statusJson },
            dig: { args, _ in
                let recordType = args.last ?? ""
                let nameserver = args.first(where: { $0.hasPrefix("@") }) ?? ""
                if recordType == "PTR" {
                    if nameserver == "@100.64.10.8" {
                        return "steipetacstudio-gateway._moltbot-gw._tcp.clawdbot.internal.\n"
                    }
                    return ""
                }
                if recordType == "SRV" {
                    return "0 0 18789 steipetacstudio.clawdbot.internal."
                }
                if recordType == "TXT" {
                    return "\"displayName=Peter\\226\\128\\153s Mac Studio (Moltbot)\" \"gatewayPort=18789\" \"tailnetDns=studio-mac-1.example-tailnet.ts.net\" \"cliPath=/Users/steipete/moltbot/src/entry.ts\""
                }
                return ""
            })

        let beacons = WideAreaGatewayDiscovery.discover(
            timeoutSeconds: 2.0,
            context: context)

        #expect(beacons.count == 1)
        let beacon = beacons[0]
        let expectedDisplay = "Peter\u{2019}s Mac Studio (Moltbot)"
        #expect(beacon.displayName == expectedDisplay)
        #expect(beacon.port == 18789)
        #expect(beacon.gatewayPort == 18789)
        #expect(beacon.tailnetDns == "studio-mac-1.example-tailnet.ts.net")
        #expect(beacon.cliPath == "/Users/steipete/moltbot/src/entry.ts")
    }
}
