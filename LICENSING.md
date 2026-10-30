# Licensing FAQ

InfiniBot — the AI OS is licensed under the **Functional Source License,
Version 1.1, ALv2 Future License** (SPDX: `FSL-1.1-ALv2`). The full text is in
[`LICENSE`](LICENSE). This page explains it in plain English.

**This FAQ is a summary, not legal advice, and it does not change the
license.** If this page and [`LICENSE`](LICENSE) disagree, `LICENSE` wins. If
you are unsure whether your use is allowed, ask us (see [How to buy a
commercial license](#how-to-buy-a-commercial-license)).

<!-- OWNER: have a lawyer review this FAQ together with LICENSE, COMMERCIAL.md,
CLA.md and TRADEMARKS.md before the public launch. -->

## The short version

- You can **use, copy, modify and self-host** InfiniBot for free, including
  inside a company and for commercial work, as long as you are not offering
  InfiniBot, or a product that competes with it, to other people as a
  commercial product or service.
- **Every release becomes Apache-2.0 two years after it is published.** After
  that date you can use that release for anything the Apache License allows,
  including competing products.
- **InfiniBot Cloud** is our hosted version. It is how we fund the project.
  See [`COMMERCIAL.md`](COMMERCIAL.md).
- The FSL gives you **no trademark rights**. If you publish a fork, give it a
  different name. See [`TRADEMARKS.md`](TRADEMARKS.md).

## What the license actually says

The FSL grants you the right to "use, copy, modify, create derivative works,
publicly perform, publicly display and redistribute the Software for any
Permitted Purpose". A Permitted Purpose is anything except a Competing Use.
The license defines Competing Use like this (quoted from [`LICENSE`](LICENSE)):

> A Competing Use means making the Software available to others in a
> commercial product or service that:
>
> 1. substitutes for the Software;
>
> 2. substitutes for any other product or service we offer using the Software
>    that exists as of the date we make the Software available; or
>
> 3. offers the same or substantially similar functionality as the Software.

And it names some uses that are always allowed:

> Permitted Purposes specifically include using the Software:
>
> 1. for your internal use and access;
>
> 2. for non-commercial education;
>
> 3. for non-commercial research; and
>
> 4. in connection with professional services that you provide to a licensee
>    using the Software in accordance with these Terms and Conditions.

Two things follow from that wording:

- The test is about **making InfiniBot available to others** in a
  **commercial** product or service. Running it yourself, for yourself or your
  own organization, is internal use.
- Point 2 covers the products we offer using InfiniBot on the date a release
  comes out. Today that includes **InfiniBot Cloud**, the hosted, managed
  InfiniBot service.

## What you can do for free

| Use | Allowed? | Why |
| --- | --- | --- |
| Run InfiniBot on your own computer or server for yourself | Yes | Internal use |
| Run it inside your company for your employees, on your own servers or cloud account | Yes | Internal use and access |
| An agency or freelancer self-hosting InfiniBot to run **their own** business (their CRM, projects, agents, content) | Yes | Internal use. Your clients receive your work, not access to InfiniBot |
| Being paid to install, configure or customize InfiniBot for a client who runs it themselves under this license | Yes | Professional services to a licensee (Permitted Purpose 4) |
| Modifying the code, writing plugins, skills and extensions for your own use | Yes | Allowed by the license grant |
| Publishing a fork or your modifications | Yes, with conditions | Keep the license and all copyright notices, don't offer it as a Competing Use, and use a different name (see [`TRADEMARKS.md`](TRADEMARKS.md)) |
| Teaching with it, or using it for non-commercial research | Yes | Permitted Purposes 2 and 3 |
| Contributing to InfiniBot | Yes | See [`CONTRIBUTING.md`](CONTRIBUTING.md) and [`CLA.md`](CLA.md) |
| Anything at all with a release that is more than two years old | Yes | That release is available under Apache-2.0 |

## What needs a commercial license

You need a commercial license (or have to wait for the Apache-2.0 date) when
you make InfiniBot available **to others** in a **commercial** product or
service that falls under the Competing Use definition. In practice:

- **Offering InfiniBot as a hosted or managed service.** For example, running
  InfiniBot instances for customers and charging for access, or selling
  "managed InfiniBot" hosting. That substitutes for the Software and for
  InfiniBot Cloud.
- **Selling a product built on InfiniBot that offers the same or
  substantially similar functionality.** For example, a rebranded AI OS, an
  agent-gateway product, or a vertical "AI OS for X" that ships InfiniBot's
  gateway, control UI and agent runtime to customers. This is what we call an
  **OEM** or **embedded** license.
- **Embedding InfiniBot in a commercial product you distribute to
  customers**, where the result competes with InfiniBot as described above.

Whether a specific product "offers substantially similar functionality" is a
question about the facts. If your product uses InfiniBot only behind the
scenes to deliver something unrelated (for example, you run InfiniBot
internally to operate your bakery's orders), that is internal use. If your
customers get an AI operating system, an agent gateway or a control room that
looks and works like InfiniBot, it is very likely a Competing Use. When in
doubt, ask us before you ship. We would rather give you a clear answer (and,
where it fits, a reasonable license) than have you guess.

## The two-year Apache-2.0 conversion

The license includes this grant:

> We hereby irrevocably grant you an additional license to use the Software
> under the Apache License, Version 2.0 that is effective on the second
> anniversary of the date we make the Software available.

What that means:

- **It applies per release.** Each version we publish carries its own date.
  Two years after that date, that version is also available under Apache-2.0.
- **It is irrevocable.** We can't take it back, even if we change the license
  of later versions.
- **Newer versions are still FSL** until their own two-year date.

## Our pledge

The FSL already guarantees the conversion above. In addition, we commit to
this:

1. **Every release of the InfiniBot core we publish under the FSL converts to
   Apache-2.0 two years after it is published**, exactly as the license says,
   including every contribution merged into that release.
2. Contributions accepted under the [`CLA`](CLA.md) will always be published
   in the public core under FSL-1.1-ALv2 or a more permissive license, so they
   convert to Apache-2.0 on the same schedule. The CLA lets us also include
   them in commercial and OEM editions; it does not let us keep them out of
   the public core's conversion.
3. We will not move a feature that self-hosters already have in the public
   core behind a paywall.

<!-- OWNER: confirm pledge points 2 and 3, and whether to add "we will never
relicense the core under anything more restrictive than FSL-1.1-ALv2". -->

## How the hosted cloud relates to the core

- **InfiniBot Cloud** runs the same source-available core you can
  self-host, plus proprietary hosted-operations code: multi-tenant sign-in,
  the machine orchestrator, usage limits and billing. That operations code is
  not part of this repository and is not licensed under the FSL.
- Cloud plans are **flat monthly prices**, from a Free plan ($0) to Scale
  ($199/mo). AI is bring-your-own-key (BYOK) or a local model, so your AI
  provider bills you separately. Details: [`COMMERCIAL.md`](COMMERCIAL.md).
- Nothing in the cloud is required to self-host. The core must build and run
  without it.

## Code that is not under the FSL

- **Upstream code.** InfiniBot started from Clawdbot/Moltbot, released under
  the MIT License (Copyright (c) 2025 Peter Steinberger). Code from that
  project remains available under the MIT License, and its notice is kept in
  [`NOTICE`](NOTICE). The FSL applies to InfiniBot's own work.
- **Third-party components and dependencies** keep their own licenses. See
  [`NOTICE`](NOTICE) and [`THIRD_PARTY_LICENSES.md`](THIRD_PARTY_LICENSES.md).

## Other conditions worth knowing

- **Redistribution:** if you share copies, modifications or derivatives, you
  must include a copy of, or a link to, the license and keep all copyright
  notices.
- **Patents:** the license includes a patent license for permitted uses. It
  ends if you claim that the Software infringes a patent.
- **No warranty:** the Software is provided "as is".
- **Trademarks:** the license only lets you display the license details and
  identify us as the origin of the Software. See [`TRADEMARKS.md`](TRADEMARKS.md).

## How to buy a commercial license

Tiers, prices and checkout are on the
[commercial licenses page](https://cloud.infinibotos.com/licenses/).
See [`COMMERCIAL.md`](COMMERCIAL.md) for InfiniBot Cloud, commercial/OEM
licenses and enterprise self-host support, and for how to contact us.
