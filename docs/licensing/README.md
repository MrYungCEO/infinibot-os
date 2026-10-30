# Licensing: FSL core + proprietary hosted fleet

InfiniBot's own code is licensed under the **Functional Source License 1.1,
ALv2 Future License** (`FSL-1.1-ALv2`) — see [`/LICENSE`](../../LICENSE),
[`/LICENSING.md`](../../LICENSING.md) and [`/NOTICE`](../../NOTICE). Every
release converts to Apache-2.0 two years after it ships. Anyone can self-host.

(This file previously described an AGPL-3.0-only open core. That plan was
superseded by the FSL decision in release/launch-1; the fleet carve-out below
is unchanged.)

## The one exception: the hosted fleet control plane

| Path | License |
| --- | --- |
| `src/fleet/**` | Proprietary — [`src/fleet/LICENSE`](../../src/fleet/LICENSE) |
| `deploy/fly/orchestrator/**` | Proprietary — [`src/fleet/LICENSE`](../../src/fleet/LICENSE) |
| everything else (gateway, UI, gateway container `Dockerfile.fleet-gateway`, `deploy/fly/gateway/**`) | FSL-1.1-ALv2 |

The orchestrator/router, tenant Machine provisioning, wake/suspend/reaper,
the `fleet_machines` registry, metering/billing and the owner admin console
are not needed to self-host InfiniBot.

Trademarks: see [`/TRADEMARKS.md`](../../TRADEMARKS.md) and
[`BRAND-USAGE.md`](./BRAND-USAGE.md). Third-party names/logos are used only to
identify compatibility.

Open item: the copyright holder / legal entity name is still a placeholder
(`NOTICE`, `src/fleet/LICENSE`) — owner to confirm.
