# InfiniBot Windows Code-Signing — Options Survey (June 2026)

**Goal:** ship a code-signed `InfiniBot-Setup-<version>.exe` that eventually clears
SmartScreen's "Windows protected your PC / unrecognized app" prompt, at the lowest
possible recurring cost, using only legitimate signing infrastructure.

**Artifact under signing** (owned by the Electron packaging pipeline — see
`electron/package.json` `build`):
- `electron/dist/InfiniBot-Setup-<version>.exe`  (NSIS one-click installer)
- `electron/dist/InfiniBot-Portable-<version>.exe`  (portable single-file)
- `appId: com.infinibot.desktop`, `productName: InfiniBot`, publisher `InfiniBot`.

**TL;DR up front — the EV/SmartScreen myth is dead in 2026.** Microsoft confirmed
EV certificates *no longer* grant instant SmartScreen reputation. **No certificate
of any kind — free, OV, or EV — buys an instant clean prompt anymore.** SmartScreen
trust is now built purely from download volume + clean-history of a *stable publisher
identity*. That reframes the whole decision: the job is not "buy a magic cert," it is
"get a cheap, stable, legitimately-issued identity onto every build so reputation can
accumulate across versions instead of resetting each release." See
[Microsoft Learn — SmartScreen reputation](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation).

---

## Option 1 — SignPath.io Foundation (free EV-grade OSS signing)

**2026 status:** Active and healthy. SignPath Foundation (the nonprofit at
[signpath.org](https://signpath.org/)) provides free certificates; SignPath.io provides
the signing platform free of charge for qualifying OSS projects. This is the gold-standard
free path used by many well-known OSS Windows apps.

**Eligibility (verbatim conditions, [signpath.org/terms.html](https://signpath.org/terms.html)):**
1. No malware / PUP.
2. **OSI-approved Open Source license, with NO commercial dual-licensing, for ALL components.**
3. **May NOT contain ANY proprietary, non-open-source component** — *especially* code
   published by a maintainer or affiliated person/org.
4. Actively maintained.
5. Already released in the form to be signed.
6. Functionality documented on the download page / store entry.
7. Binaries built from source in a verifiable way; every release manually approved.

**Eligibility verdict for InfiniBot: ❌ INELIGIBLE as-is.**
InfiniBot's `LICENSE` is the **Functional Source License 1.1, Apache-2.0 future
license (FSL-1.1-ALv2)**. It is source-available, not OSI-approved, and InfiniBot
sells commercial/OEM licenses (see `LICENSING.md`, `COMMERCIAL.md`). That fails
condition #2 outright. (Each release becomes Apache-2.0 after two years, but the
current release is what gets signed.) Critically, condition #3 also closes the obvious
escape hatch: you **cannot** license just the Electron wrapper as MIT while keeping
the core under the FSL, because the Electron installer *bundles the FSL-licensed InfiniBot
core* (`extraResources` ships `../dist`, `../node_modules`, etc. into the app). SignPath
explicitly forbids any non-open-source component authored by the maintainer in the signed
artifact. The thing being signed is the whole FSL-licensed product.

**The only way to qualify** would be to relicense the *entire distributed binary* (core
included) under an OSI-approved license with no commercial dual-licensing. That directly
conflicts with InfiniBot's monetization model (FSL core + hosted InfiniBot Cloud +
commercial/OEM licenses; see `COMMERCIAL.md`). **Not recommended.** Document the gap,
move on.

- **Pros:** truly $0/yr; well-trodden; good signing UX (GitHub Action + manual approval gate).
- **Cons:** requires going fully open-source — a business non-starter here.
- **Lead time (if eligible):** application review typically days→2 weeks.
- **Recommended next step:** None for the FSL-licensed product. (A *separate*, genuinely
  OSS InfiniBot component — e.g. a standalone open-source CLI or SDK with its own repo and
  OSI license that ships *no* FSL or proprietary code — could qualify on its own, but that is not
  the desktop installer.)
- **Application URL:** https://signpath.io/foundation/eligibility →
  https://about.signpath.io/product/open-source (apply form). A drafted-but-unsubmitted
  packet lives at `/tmp/signpath-application/` for the record / future OSS-component use.

---

## Option 2 — Azure Artifact Signing (formerly "Trusted Signing" / "Azure Code Signing")  ⭐ RECOMMENDED

**2026 status:** GA. Rebranded from *Trusted Signing* → **Azure Artifact Signing**
([azure.microsoft.com/products/artifact-signing](https://azure.microsoft.com/en-us/products/artifact-signing)).
Microsoft issues and custodies the cert (HSM-backed, short-lived certs, you never hold a
private key). This is now Microsoft's officially-recommended path for small publishers
([Microsoft Learn — code-signing options](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options)).

**Eligibility for InfiniBot:**
- **Individual developers: USA & Canada only** for *Public Trust* certs (the ones that
  chain to the Microsoft Trusted Root and are recognized by Windows). Founder must be in
  US/CA, or register as an organization that's ≥3 years old for the org tier.
- Identity validation required (Microsoft validates you) — **plan a few business days.**
- No open-source requirement. **Proprietary software is fine.** ✅

**Pricing:** **~$9.99/month** for the individual tier (US/CA). *Not strictly free* — but
the cheapest legitimate path to a real, Windows-trusted Authenticode signature, and an
order of magnitude under a traditional OV/EV cert ($200–$600/yr).

**SmartScreen reality:** Does **not** instantly bypass SmartScreen (nothing does in 2026).
But because every build is signed by the *same stable Microsoft-issued publisher identity*,
SmartScreen reputation **accumulates across releases** instead of resetting each version —
which is the entire point. The prompt fades once the publisher identity has enough clean
download history.

- **Pros:** cheapest real Authenticode; no key management (HSM); first-class GitHub Actions
  support (`azure/trusted-signing-action`); no license requirement; reputation persists across versions.
- **Cons:** $9.99/mo (not $0); US/CA-only for individuals; few-days identity validation;
  requires an Azure subscription + a Trusted Signing Account + Certificate Profile.
- **Lead time:** ~2–5 business days for identity validation, then minutes to wire CI.
- **Recommended next step:** Create an Azure subscription → Trusted Signing Account →
  Certificate Profile (Public Trust). Then enable the (already-written) `sign-windows`
  job in `.github/workflows/electron-sign.yml` by adding the `AZURE_*` GitHub Secrets.
- Refs: [Quickstart](https://learn.microsoft.com/en-us/azure/artifact-signing/quickstart),
  [Hanselman: auto-signing EXE w/ Trusted Signing + GitHub Actions](https://www.hanselman.com/blog/automatically-signing-a-windows-exe-with-azure-trusted-signing-dotnet-sign-and-github-actions),
  [Melatonin: code signing w/ Azure Trusted Signing](https://melatonin.dev/blog/code-signing-on-windows-with-azure-trusted-signing/).

---

## Option 3 — Microsoft Store / MSIX distribution (Microsoft signs for you)

**2026 status:** Active. If you ship through the Microsoft Store, Microsoft signs the
package and Store-delivered apps are inherently trusted by SmartScreen (no warning).

**Cost:** Developer account registration — **$19 one-time individual / $99 one-time
company** (one-time, not annual). Not strictly $0, but a one-time fee with no renewal.

**Eligibility for InfiniBot:** Possible but **high-friction for this app.** InfiniBot is a
local gateway that spawns child processes (node-pty, Docker, native better-sqlite3, opens
LAN ports, runs arbitrary coder backends). MSIX runs in a constrained AppContainer /
packaged context; full-trust desktop bridge is allowed but the certification + sandbox
review for an app that launches subprocesses and binds sockets is a real engineering lift,
and Store policy review can reject "developer tool that runs arbitrary code" categories.

- **Pros:** zero SmartScreen friction for Store installs; built-in update channel; one-time fee.
- **Cons:** packaging rework (MSIX target, not currently in electron-builder config — and
  that config is owned by the packaging agent); Store certification review; sandbox
  constraints fight InfiniBot's architecture; doesn't help the *direct-download* `.exe`.
- **Lead time:** days→weeks (account + first certification).
- **Recommended next step:** Park it. Revisit only if a Store presence becomes a marketing
  goal. Does not replace direct-download signing.
- Ref: [Publish your first Windows app](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/publish-first-app).

---

## Option 4 — SmartScreen reputation building (ship unsigned / self-signed, ramp organically)

**2026 status:** Always available; this is the genuine $0 path.

**How it works:** ship the `.exe` unsigned (or self-signed for tamper-evidence only).
SmartScreen shows "unrecognized app" until the file/publisher accumulates clean download
history. There is **no published threshold**; community reports put fast Windows-11
positive reputation around **~15,000 clean downloads**, and meaningfully reduced friction
after several weeks + hundreds of installs from a diverse audience
([Microsoft Learn — SmartScreen reputation](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation)).

**The catch that makes pure-unsigned painful:** an **unsigned** file rebuilds reputation
*from zero on every new version* (reputation keys off the file hash, and there's no stable
publisher identity to carry it forward). For an app that ships frequently, you never escape
the warning. **Signed builds (even cheap Azure ones) let reputation attach to the publisher
identity and persist across versions** — which is exactly why Option 2 beats pure Option 4.

- **Pros:** $0; nothing to apply for; ships today.
- **Cons:** persistent "unrecognized app" warning during ramp; resets every release while
  unsigned; degraded first-run UX → measurable install drop-off.
- **Lead time:** 0 to ship; weeks→months to ramp reputation.
- **Recommended next step:** Use as the **interim** posture *only* until Azure signing is
  live. Ship the `electron/SIGNING.md` "right-click → Properties → Unblock" one-pager with
  every download link to cushion the UX. Do **not** treat this as the destination.

---

## Option 5 — Sigstore / cosign + community CI signing (CodeNotary, etc.)

**2026 status:** Sigstore is mainstream — but for the *wrong target*.

**Critical limitation:** Sigstore's Fulcio CA is **not** in the Microsoft Trusted Root
Program. A Windows `.exe` signed only via Sigstore still shows **"Unknown Publisher"** and
does **nothing** for SmartScreen / Authenticode. Sigstore signs container images, npm/PyPI
packages, and provides a public transparency log (Rekor) — it is *provenance/attestation*,
not Windows Authenticode. Same for **CodeNotary CAS** (free OSS notarization/SBOM
attestation) — valuable for supply-chain provenance, useless for the SmartScreen prompt.

- **Pros:** free; fully automated; keyless; great for SBOM/provenance/supply-chain proof.
- **Cons:** **does not satisfy Windows Authenticode or SmartScreen at all.** Wrong tool for this goal.
- **Lead time:** minutes to wire.
- **Recommended next step:** Optionally add `cosign` attestation + an SBOM to releases as a
  *complement* (supply-chain hygiene / marketing "verifiable builds"), but **not** as the
  Windows signing solution. Out of scope for the SmartScreen goal.
- Refs: [comparecheapssl — free code signing 2026 reality](https://comparecheapssl.com/free-code-signing-certificate-and-how-to-get-it/),
  [bigiron — cosign + GPG default](https://www.bigiron.cc/guides/code-signing-certs-for-your-own-binaries-when-it-matters).

---

## Final recommendation

**There is no $0/yr path that produces a Windows-trusted Authenticode signature for a
non-OSI-licensed (FSL) app.** The single legitimately-free option (SignPath Foundation)
requires an OSI license with no commercial licensing, which conflicts with InfiniBot's licensing/monetization. So the honest
recommendation is a **two-phase posture**:

1. **Now (truly $0): Option 4 — ship with the "Unblock" one-pager.** No application, no
   wait. Accept the interim SmartScreen warning and soften it with `electron/SIGNING.md`.
2. **As soon as practical (~$9.99/mo): Option 2 — Azure Artifact Signing.** Cheapest real,
   Windows-trusted Authenticode signature with no license requirement; HSM-backed (no key to
   leak); reputation accrues across versions. The CI job is already written and stubbed in
   `.github/workflows/electron-sign.yml`; flipping it on is just adding 4 GitHub Secrets
   after Microsoft validates the founder's identity.

Skip SignPath (license-incompatible), skip MSIX (architecture-incompatible, deferred),
and use Sigstore only as optional supply-chain *garnish*, never as the SmartScreen fix.

> Note on the "free EV bypasses SmartScreen" advice you'll see in older blog posts: it is
> **obsolete**. EV certs no longer grant instant SmartScreen reputation as of Microsoft's
> 2024+ policy. Do not pay an EV premium expecting a clean prompt — it buys nothing the
> $9.99/mo Azure cert doesn't.

### Sources
- https://signpath.org/ · https://signpath.org/terms.html · https://signpath.io/foundation/eligibility
- https://azure.microsoft.com/en-us/products/artifact-signing
- https://learn.microsoft.com/en-us/azure/artifact-signing/quickstart
- https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options
- https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation
- https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/publish-first-app
- https://www.hanselman.com/blog/automatically-signing-a-windows-exe-with-azure-trusted-signing-dotnet-sign-and-github-actions
- https://melatonin.dev/blog/code-signing-on-windows-with-azure-trusted-signing/
- https://comparecheapssl.com/free-code-signing-certificate-and-how-to-get-it/
- https://www.bigiron.cc/guides/code-signing-certs-for-your-own-binaries-when-it-matters
