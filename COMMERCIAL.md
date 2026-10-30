# Commercial options

InfiniBot — the AI OS is free to self-host under
[FSL-1.1-ALv2](LICENSE) (see [`LICENSING.md`](LICENSING.md)). This page covers
the three ways to pay us: the hosted cloud, a commercial/OEM license, and
enterprise support for self-hosting.

InfiniBot is published and licensed by **Kingly Intelligence Systems LLC**, a
Delaware limited liability company. This page is a summary; the terms of each
deal are in its own agreement.

## 1. InfiniBot Cloud (hosted)

InfiniBot Cloud is InfiniBot run for you: a managed gateway, the control UI,
voice and channels, with updates, backups and uptime handled by us. It is the
main way we fund InfiniBot.

**Plans are flat monthly prices.** AI is bring-your-own-key (BYOK) or a
local model, so your AI provider bills you separately (a local model costs
$0).

| Plan | Price | What you get |
| --- | --- | --- |
| Self-host | $0 | Run InfiniBot on your own hardware (desktop app or npm) |
| Free | $0 | Hosted, 30 active minutes a day, no Telegram/Slack |
| Starter | $19/mo | Wakes on use, about 150 active hours a month (fair use) |
| Pro | $49/mo | Always on |
| Business | $99/mo | More headroom for a small fleet: twice the agents and coders of Pro, 4 GB of RAM, 3 seats |
| Scale | $199/mo | The most agents and coders at once, 8 GB of RAM, 10 seats, priority support |

Some plugins are a separate one-time purchase ($19 to $49) on the Plugins
page; on the cloud, the CEO plan also unlocks the paid plugins.

- Sign up (the Free plan needs no card): <https://cloud.infinibotos.com>
- Pricing: <https://infinibotos.com/#pricing>

The cloud's hosted-operations code (multi-tenant sign-in, orchestrator,
metering, billing) is proprietary and is not part of this repository.

## 2. Commercial and OEM license

You need a commercial license to make InfiniBot available to others in a
commercial product or service that is a **Competing Use** under the FSL (see
[`LICENSING.md`](LICENSING.md) for the exact definition). Typical cases:

- **Specialized AI OS products built on InfiniBot.** You build a vertical
  product (for example an AI OS for clinics, traders, agencies or robotics
  fleets) on InfiniBot's gateway, agent runtime and control UI, and sell it to
  customers.
- **SaaS and managed hosting.** You run InfiniBot, or a product based on it,
  for your customers as a hosted service.
- **Embedding / OEM.** You ship InfiniBot inside a commercial product you
  distribute (desktop, appliance, device or on-prem bundle) and the result
  competes with InfiniBot.

A commercial license can include:

- the right to use InfiniBot for the Competing Use described in your
  agreement;
- **white-label rights** under your own brand (a trademark license for
  "InfiniBot" is separate and optional; see [`TRADEMARKS.md`](TRADEMARKS.md));
- access to commercial-only modules where they exist;
- support and update terms.

Standard tiers are Indie ($299/year, one product), Team / Business
($1,499/year), Agency / Reseller ($2,499 every 180 days, resale and
white-label), and Enterprise / OEM ($2,499 every 60 days, OEM). Every tier
renews automatically through Whop until cancelled. Perpetual fixed-version
licenses start at $49,999 by written quote.

- [Commercial License Agreement](docs/licensing/COMMERCIAL-LICENSE-AGREEMENT.md)
- [Tier and Order-Form Schedule](docs/licensing/COMMERCIAL-LICENSE-TIERS.md)
- Public checkout and status: <https://cloud.infinibotos.com/licenses>

The Commercial License Agreement (v1.0, effective 2026-10-27) supplements the
FSL; it never narrows rights the FSL already gives you, and it does not change
any version's Change Date. It is governed by Delaware law.

## 3. Enterprise self-host support

For organizations that self-host InfiniBot for internal use (which is free
under the FSL) but want a vendor behind it:

- priority support and response-time commitments;
- deployment reviews, upgrade assistance and security advisories before
  public disclosure;
- help with SSO, audit and compliance requirements;
- custom development and integration work.

<!-- OWNER: define support tiers, SLAs and pricing. -->

## Contact

- Licensor: Kingly Intelligence Systems LLC (Delaware)
- Email (licensing and legal notices): **https://infinibotos.com**
- Web: <https://cloud.infinibotos.com/licenses>

Please tell us what you are building, how it will be delivered to your
customers (hosted, distributed, embedded) and roughly how many customers or
deployments you expect. If you aren't sure whether you need a license, ask;
we'll give you a straight answer.
