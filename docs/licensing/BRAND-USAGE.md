# Third-party brand usage review

Status: review of the repository at branch `oss/fsl-license`, 2026-09-27.
Brand guidelines were read on **2026-09-27**. This is an engineering review,
not legal advice. Have counsel check the REMOVE/ADJUST calls before launch.

<!-- OWNER: have a lawyer review this document before launch. -->

> **Update (release/launch-1):** `feat/brand-neutral-logos` has since carried
> out most of the plan in section 4. P1–P7 are gone: the mesh map, coder
> chips, tooltips, channel cards and mobile glyphs now use neutral InfiniBot
> monograms (`ui/public/providers/mono-{c,x,g,o}*.png`), and
> `gen-provider-logos.mjs` only draws those. P12–P14 coder portraits were
> regenerated without third-party names, the landing/download pages use plain
> text, and the iOS/macOS app icons (N1) now show the InfiniBot mark.
> **Still open:** the Android launcher icons (N1, owner has icon work in
> progress) and `docs/assets/pixel-lobster.svg` (N2). The inventory below is
> kept as the record of what was reviewed.

> **Update (2026-10-30, `feat/setup-brand-logos`):** on the owner's request, the
> picker surfaces now show third-party provider marks again: the setup brain
> step, setup wizard, cloud setup, API Keys, model pickers, coding-backend
> selectors, Coders settings and the chat mode switcher. This **reverses** the
> REMOVE verdicts in section 3 for those surfaces. No written permission from
> any brand is on file, and the guideline table in section 2 still applies:
> Anthropic, OpenAI, DeepSeek and others require permission, and several ban
> enclosing a mark in a tile. Have counsel review before release. To withdraw a
> mark, delete its entry from `LOGOS` in `ui/scripts/gen-brand-logos.mjs` and
> regenerate: that brand falls back to a lettermark on every surface. The mesh
> map badges and activity feed still use the neutral monograms.

## Summary

- InfiniBot's license (FSL-1.1-ALv2, later Apache-2.0) covers InfiniBot's own
  code only. It gives **no rights in third-party names or logos**. See
  [`TRADEMARKS.md`](../../TRADEMARKS.md#third-party-trademarks) and
  [`NOTICE`](../../NOTICE).
- Naming a product in **plain text** to say InfiniBot works with it
  (nominative use) is allowed by every guideline we found.
- Showing the **logos** of Anthropic/Claude, OpenAI/Codex and Google/Gemini
  needs the owner's permission. None of them publishes a self-serve "works
  with" logo licence. Until permission exists, show these names as text.
- No published guideline allows recolouring a mark to gold or grey. Most
  also ban putting it inside your own shape (disc, ring, tinted tile) or
  "simplifying" it. Many InfiniBot icons do one of these.
- Simple Icons path data is CC0, but its
  [DISCLAIMER](https://github.com/simple-icons/simple-icons/blob/develop/DISCLAIMER.md)
  says CC0 does not cover the trademarks. Users must still get permission and
  follow each brand's guidelines.

## 1. Inventory of third-party marks

"Official" means the brand's own geometry (Simple Icons, Octicons, Ionicons
`logo-*`, Font Awesome brands). "Redrawn" means a hand-simplified copy that is
still recognisable. "Generic" means an ordinary icon that is not the brand's
mark.

### 1a. Coder provider marks (Claude Code, Codex, Gemini CLI, OpenCode)

| # | File | Brand | Where shown | How rendered |
| --- | --- | --- | --- | --- |
| P1 | `ui/public/providers/claude.png`, `claude@2x.png` | Claude symbol (Anthropic) | Agent mesh map: badge above each coder agent (`ui/src/ui/views/agent-ops/activity-map.ts` via `provider-logos.ts`), coder-build chips (`world-map-coder-builds.ts`, `.wmcb-mono`), hover tooltip (`agency-world-viz.ts`, `.bx-tt-logo`) | Official path (Simple Icons v16.23.0), Claude orange `#D97757`, transparent PNG 96/192 px. On screen: badge ≈16 px (counter-scaled), chip 14 px, tooltip 12 px |
| P2 | `ui/public/providers/codex.png`, `codex@2x.png` | OpenAI Blossom (OpenAI), labelled "Codex" | Same three places | Official Blossom path, **white** `#FFFFFF` on the dark map |
| P3 | `ui/public/providers/gemini.png`, `gemini@2x.png` | Gemini sparkle (Google) | Same three places | Simple Icons sparkle path with a **hand-picked** blue→violet→rose gradient (`#1C7DFF`/`#8E75B2`/`#E86F82`), not Google's own asset |
| P4 | `ui/public/providers/opencode.png`, `opencode@2x.png` | OpenCode logo | Same three places | Simple Icons frame path, light `#F4F1F1`, **plus an added** muted inner fill `#5E5A5A` that is not in the source path |
| P5 | `ui/scripts/gen-provider-logos.mjs` | All four above | Build script that makes P1–P4 | Embeds the path data. Comment calls the Blossom path "OpenAI brand path" |
| P6 | `ui/public/providers/claude-mark.svg`, `mobile/assets/providers/claude-mark.svg` | Claude (redrawn) | **Not referenced** (orphan) | 16-point starburst, `currentColor` |
| P7 | `ui/public/providers/openai-mark.svg`, `mobile/assets/providers/openai-mark.svg` | OpenAI (redrawn) | **Not referenced** (orphan) | Six stroked circles in a rosette, `currentColor` |
| P8 | `ui/src/ui/lib/coder-backend-brand.ts` | Claude, OpenAI, Google "G", OpenCode | Activity feed badges (`agent-activity.ts`), topbar pill (`coder-backend-pill.ts`), subagent cards/history, recently-finished feed, activity dashboard, voice holo ring | 14 px inline SVG, tinted with InfiniBot accents: Claude = redrawn starburst in `#d97706`; Codex = redrawn "hex-petal" in sky `#0ea5e9`; **Gemini = a Google "G" inside a circle**, violet `#a855f7`; OpenCode = house "OC" monogram in a rounded square (not the OpenCode logo) |
| P9 | `ui/src/ui/views/agents-management.ts:1765-1780` | Claude, OpenAI | Agents page gallery card, provider chip | Generic 4-point sparkle / hexagon outline ("OpenAI hex-knot"), `#ff9a55` / `#10a37f`, 14 px in a 28 px tinted rounded square |
| P10 | `mobile/src/utils/providerLogo.js:26-57` | Claude, OpenAI | Mobile Sessions and TaskActivity screens | Same shapes as P6/P7, tinted, 14/20 px in 30/38 px rounded squares |
| P11 | `mobile/src/screens/NeuralMeshScreen.js:137` | Labelled OpenAI, glyph is **Electron** (`logo-electron`) | Mobile Neural Mesh provider filter chip | 12 px, `#10A37F`. Wrong brand's mark |
| P12 | `ui/public/agent-avatars/coder-claude.webp` | "Claude" name in artwork; Python logo; "TS" tile | Constellation org chart portrait (`ui/src/ui/lib/constellation-org-chart.ts`) for agent `coder-claude` | AI-generated portrait with the caption **"CLAUDE CODER — Claude AI Code Specialist"**, a Python logo and a TypeScript "TS" tile |
| P13 | `ui/public/agent-avatars/coder-codex.webp` | "OpenAI Codex" name in artwork | Same, agent `coder-codex` | Caption **"CODEX — OpenAI Codex Engineering Specialist"** |
| P14 | `ui/public/agent-avatars/coder-opencode.webp` | "OpenCode" name in artwork | Same, agent `coder-opencode` | Chest badge **"OPENCODE — Open Source Engineering Specialist"** |
| — | `ui/public/agent-sprites/*.png`, `mobile/assets/agent-sprites/*.png`, `ui/public/assets/sprites/agents/*-coder.svg` | none | Agency world / mesh characters | Original character art. SVG sheets have a 16 px letter badge (C/X/G/O). **No third-party marks** |

**Mesh map state.** On `feat/saas-clerk-neon`, commit `c745639f` removed the
dark disc and gold ring that framed P1–P4 on the map badges, chips and tooltip.
The marks are now shown on their own. **This branch (`oss/fsl-license`)
predates that commit**, so `provider-logos.ts` here still draws the disc and
ring. Section 4 treats `c745639f` as the baseline.

### 1b. Chat channels and social platforms (web UI)

| # | File | Brands | Where shown | How rendered |
| --- | --- | --- | --- | --- |
| C1 | `ui/src/ui/views/channels.logos.ts:22-54` | WhatsApp, Telegram, Discord, Slack | Channels page card headers (`channels.card.ts:68`) | Redrawn marks at 44 px. WhatsApp phone-in-bubble in `#25D366`; Telegram plane in `#229ED9`; Discord Clyde in `#5865F2`; Slack four-colour hash in real Slack colours. All sit in a 12 px-radius tile with a brand-tinted gradient, brand border and glow (`ui/src/styles/channels.css:99`) |
| C2 | `channels.logos.ts:57-119` | Signal, iMessage, Google Chat, Nostr, BlueBubbles, Mattermost, Microsoft Teams | Same | Signal, iMessage, Google Chat, Nostr, BlueBubbles and Mattermost are **generic** bubbles/shapes in a brand-ish colour. Teams is a **crude approximation** (two rectangles + "T") in `#6264A7`. Same tile as C1 |
| C3 | `ui/src/ui/views/clients.ts:222-267` | WhatsApp, Telegram, Discord, Instagram | Clients page social links: cards, detail, edit form | Official-style white glyphs at 20 px. WhatsApp/Telegram inside a brand-colour circle, Discord in a rounded square, Instagram in a gradient rounded square |
| C4 | `ui/src/ui/views/agency-operations.ts:4015-4033` | Same as C3 | Agency Operations → finance client-edit modal | Same markup as C3 at 16 px |
| C5 | `ui/src/ui/views/vault-dashboard.ts:44` | Discord | Kingly Vault dashboard: Discord tab, server icon, empty state, settings title | Official Simple Icons path, **recoloured gold** (`currentColor` = `--g-primary`), 16 px, sometimes in a bordered 48 px box |
| C6 | `ui/src/ui/views/kanban.ts:1547`, `:5532` | GitHub | Kanban run modal (GitHub precheck, "Verify GitHub"), project page repo link | Official Octicons mark-github, `currentColor`, 14 px, no container |
| C7 | `ui/src/ui/views/funnel-flow-map.ts:28-35`, `funnels-onboarding.ts:75-78` | Instagram, YouTube, LinkedIn, X, TikTok, Discord (+ generic Telegram/WhatsApp) | Funnel flow map nodes and config; funnels onboarding platform picker | Feather/Tabler brand **outlines** (redrawn) at 20/24 px. `currentColor`, or brand colour when selected |
| C8 | `ui/src/ui/views/integrations-panel.ts:207` | Instagram | Integrations panel: Instagram connect hero and tile | Feather outline, **black on a gold rounded square**, 72/44 px |
| C9 | `ui/src/ui/views/products.ts:1827` | Notion | Products "Import from Notion" button | Generic stroke icon (not the Notion "N" cube) |
| C10 | `ui/src/ui/views/docker.ts:25` | Docker | Docker "Voice Services" panel | Official whale, `#2496ED` or grey, 20 px. `renderDocker` seems to have no callers, so it may never render |

### 1c. Mobile app

| # | File | Brands | Where shown | How rendered |
| --- | --- | --- | --- | --- |
| M1 | `mobile/src/screens/content/contentApi.js:184-190` | Instagram, YouTube, LinkedIn, Twitter (bird), Facebook | Content Pages rows and surface chips | Official Ionicons `logo-*`, **recoloured gold** (`COLORS.gold`) or muted, 20/13 px |
| M2 | `mobile/src/screens/content/TrendsScreen.js:30-38` | Reddit, Hacker News, YouTube, Twitter/X, Instagram | Trends story rows | Ionicons `logo-*`, **gold**, 14 px |
| M3 | `mobile/src/screens/content/ContentIntelScreen.js:639` | Instagram | Content Intel player, "Open in Instagram" fallback | Ionicons `logo-instagram`, white, 56 px over the video poster |
| — | P6/P7/P10/P11 above | Claude, OpenAI, Electron | — | See 1a |

### 1d. Docs and marketing pages

The landing page ships no logo files. It hot-links every mark at runtime from
`cdn.simpleicons.org` or `api.iconify.design` (`simple-icons:*`).

| # | File | Brands | Where shown | How rendered |
| --- | --- | --- | --- | --- |
| L1 | `docs/landing.html` (#cli-agents cards) | Anthropic, OpenAI | "Claude Coder" and "Codex" cards | Official Simple Icons, **recoloured `#cbd5e1`**, 12 px in a pill |
| L2 | `docs/landing.html` (#cli-agents marquee "Wired gateway providers") | Anthropic, OpenAI, Google Gemini, Ollama (×2), Groq, OpenRouter, xAI (**shows the X mark**), Cerebras, Mistral AI, GitHub Copilot, Qwen (**shows the Alibaba Cloud mark**), DeepSeek, Hugging Face, Perplexity | Scrolling logo marquee | Official Simple Icons, **recoloured `#e5e7eb`** (one Ollama gold `#fbbf24`), 32 px, scales ×1.18 on hover, in pills |
| L3 | `docs/landing.html` (F-05 "MCP ecosystem") | Supabase, Canva, Gmail, Google Calendar, Google Drive, Excalidraw | Chips orbiting an "MCP" hub | Official, `#e5e7eb`, 14 px pills |
| L4 | `docs/landing.html` (#replaces marquee) | OpenAI (for "ChatGPT Plus"), Notion, Zapier, Calendly, Linear, ElevenLabs, Loom, Make | "What it replaces" | Official, `#a1a1aa` + `grayscale(1)`, 14 px pills |
| L5 | `docs/landing.html` (#compare tabs, #cmp-* tables) | Notion, OpenAI, Zapier | "vs Notion AI", "vs ChatGPT + tools", "vs Zapier + CRM" | Official, `#cbd5e1`, 14 px in tab buttons and table headers |
| L6 | `docs/landing.html` (install section), `docs/download.html:93,105,111` | Microsoft Windows, Apple | Windows and macOS download cards and steps | Official Windows (Simple Icons) and Apple (Font Awesome) paths, **gold** (`var(--gold)`, `#f6c873`) or grey, 22–32 px |

### 1e. Native apps (upstream artwork)

| # | File | Mark | Notes |
| --- | --- | --- | --- |
| N1 | `apps/macos/Icon.icon/Assets/clawdbot-mac.png`, `apps/ios/Sources/Assets.xcassets/AppIcon.appiconset/*.png`, `apps/android/app/src/main/res/mipmap-*/ic_launcher*.png` | Upstream "Clawdbot" app icon | Lobster in a blue police box labelled "CLAWDBOT"/"POLLIS". Upstream branding, which [`TRADEMARKS.md`](../../TRADEMARKS.md) says we don't claim. The police-box design is closely tied to the BBC's *Doctor Who* TARDIS, which the BBC has registered as a trademark in the UK |
| N2 | `docs/assets/pixel-lobster.svg` | Clawdbot mascot | Used in `docs/_layouts/default.html:41` |

Not logos (checked): `ui/src/ui/controllers/mcp-registry.ts` (emoji),
`comms-hub.ts` (Unicode glyphs), `email-accounts.ts:1277` (generic
envelope), `content-pages.ts:225-258` (generic outlines commented "no
platform brand assets"), and the landing page's letter monograms and
plain-text "Claude Coder"/"Codex"/"OpenCode" labels. Screenshots such as
`docs/whatsapp-clawd.jpg` show third-party UI but no standalone logo.

## 2. Brand guidelines (sources read 2026-09-27)

"Fetched" means the primary text was read. Some pages block scripted fetches
and were read through a reader proxy (openai.com/brand, meta.com, notion.so,
Google's Partner Marketing Hub). "Not found" means no official third-party
guideline was found. It is not a permission.

| Brand | Logo in a third-party UI to show integration? | Colour variants | Modify / enclose / clear space | Marketing and wording | Attribution | Source |
| --- | --- | --- | --- | --- | --- | --- |
| **Anthropic / Claude / Claude Code** | **Needs written permission.** "You may only use our trademarks as specifically permitted by us and only in materials we approve beforehand." For Claude Code: you may say "in plain text" that your product runs Claude Code; "any other use of Anthropic's names or logos … requires our written permission." | "No alterations … (changes to color, font, proportion, or otherwise)" | Readable background and "a reasonable space" around it. No published minimum size | Plain-text factual statements only. Don't suggest Anthropic "built, endorses, or is partnered with your product". Don't use the names in your own product or company names | "Do not use a trademark symbol with the trademarks." Contact `marketing@anthropic.com` | [anthropic.com/legal/trademark-guidelines](https://www.anthropic.com/legal/trademark-guidelines) (effective 2024-08-01); [code.claude.com/docs/en/legal-and-compliance](https://code.claude.com/docs/en/legal-and-compliance); [support.claude.com/en/articles/13145338](https://support.claude.com/en/articles/13145338) |
| **OpenAI (Blossom, Codex)** | **Needs permission.** Don't: "Use the logo without permission or outside OpenAI's terms." Do: use it "only when it directly relates to OpenAI services … exactly as provided". Co-branding needs approval from both brands (`partnercomms@openai.com`) | "DON'T add any colors to the Blossom". Use the provided variants | No stretching, cropping, masking, effects or added elements. Use the prescribed spacing. Not over busy images | Don't imply endorsement or sponsorship, or show it more prominently than your own logo. Be precise when naming models | "Acknowledge that it belongs to OpenAI." No exact wording given | [openai.com/brand](https://openai.com/brand) (fetched via proxy; the collapsible "Language" section with any "powered by" rules **did not load**, so those rules are unverified. Codex isn't named) |
| **Google Gemini (sparkle)** | **No public third-party guideline found.** `ai.google.dev/gemini-api/docs/branding` returns 404. The Gemini brand pages in the Partner Marketing Hub need a partner login. Google treats product icons as needing Hub approval (next row). The Google APIs Terms §6b give a limited licence to display Brand Features "to promote … that you use the APIs", subject to Google's guidelines and "sole discretion" | Unknown | Unknown | Plain text "works with / integrates with" is fine under Google's general rules | Google footer legal line (see next row) | [developers.google.com/terms](https://developers.google.com/terms) §6b; Google row below |
| **Google (G, Gmail, Drive, Calendar, Chat)** | G logo: full colour only, and "Don't use the Google G in marketing materials for a business". Product icons such as Gmail: only with Partner Marketing Hub approval, "only when necessary" (e.g. a grid of compatible products), with your brand more prominent | G logo full colour on white or black. No recolouring | Don't modify or combine. Clear space = width of the G | "works with", "is compatible with", "integrates with", "for" are fine. Don't imply certification | Footer legal line (e.g. "Google Chat™ is a trademark of Google LLC") | [Google Partner Marketing Hub](https://partnermarketinghub.withgoogle.com/) (via about.google/brand-resource-center); [developers.google.com/identity/branding-guidelines](https://developers.google.com/identity/branding-guidelines); [developers.google.com/workspace/marketplace/terms/branding](https://developers.google.com/workspace/marketplace/terms/branding) |
| **OpenCode** | **No logo guideline found.** The code is MIT ("Copyright (c) 2025 opencode"); MIT covers code, not marks. The README asks projects using "opencode" in their name to say they are "not built by the OpenCode team and … not affiliated with us" | Unknown | Unknown | Same non-affiliation statement | Non-affiliation note | [github.com/anomalyco/opencode](https://github.com/anomalyco/opencode) (redirect from sst/opencode) |
| **Telegram** | **Allowed.** "Feel free to use these Telegram logos for … 'forward to Telegram' buttons, etc. Just make sure people understand you're not representing Telegram officially." | Not specified | Not specified | Don't appear official | None required | [telegram.org/tour/screenshots](https://telegram.org/tour/screenshots) |
| **WhatsApp (Meta)** | Allowed if you follow the rules. Use only the logo provided on the WhatsApp site. Meta can revoke permission | "You shouldn't modify any colors" | Don't modify "in any way", combine with other logos/words, or make it the most prominent feature | No partnership/endorsement implied. Not in product names | — | [meta.com/brand/resources/whatsapp/whatsapp-brand](https://about.meta.com/brand/resources/whatsapp/whatsapp-brand/) |
| **Instagram (Meta)** | Allowed digitally (permission needed only for broadcast, out-of-home, or print larger than A4). Integrations may say "for Instagram" only | **Unverified** (the icon page returned 404) | **Unverified** | Don't imply partnership. Instagram mustn't be the most prominent element | — | [meta.com/brand/resources/instagram/instagram-brand](https://about.meta.com/brand/resources/instagram/instagram-brand/) |
| **Discord** | "You must have permission from Discord before using any of the Discord Marks … except as permitted here." The permitted uses (saying you use Discord or have a server) don't clearly cover an integration UI | Official colour, black or white only. "Do not edit, change, distort, recolor, or reconfigure" | Clear space shown in images only | Not in product or bot names. Digital use only | — | [discord.com/branding](https://discord.com/branding) |
| **Slack** | "Most uses require a specific written license"; "Don't use the Slack logo (with or without your company logo)". Marketplace apps may use the official "Add to Slack" button | No recolouring, transparency changes, effects or cropping | Clear space ≥ one octothorpe pill | "integrated with Slack", "X for Slack" | Outside the US: "Slack is a trademark and service mark of Slack Technologies, Inc., registered in the U.S. and in other countries." May require "not created by, affiliated with, or supported by Slack Technologies, LLC" | [slack.com/terms-of-service/slack-brand](https://slack.com/terms-of-service/slack-brand); [slack.com/media-kit](https://slack.com/media-kit); [Slack Marketplace guidelines](https://docs.slack.dev/slack-marketplace/slack-marketplace-app-guidelines-and-requirements/) |
| **Signal** | May refer to Signal. "for Signal" only if genuinely integrated. Combining with other marks or implying endorsement needs written permission | — | Proportional scaling only. No outlines or effects. Clear space ≥ 0.5× logo. Minimum 26×26 px | No implied endorsement | — | [signal.org/brand](https://signal.org/brand) (updated 2024-11-08) |
| **Apple / iMessage** | No Apple logo or Apple-owned icons without an express written licence | — | — | Word marks allowed in "runs on / for use with / compatible with", less prominent than your name | "___ is a trademark of Apple Inc." | [apple.com/legal/intellectual-property/guidelinesfor3rdparties.html](https://www.apple.com/legal/intellectual-property/guidelinesfor3rdparties.html) |
| **Microsoft (Teams, Windows)** | Logos and product icons "can never be used without an express license" | — | — | "works with Microsoft Teams" text is fine | "Microsoft, [marks] are trademarks of the Microsoft group of companies." | [microsoft.com/en-us/legal/intellectualproperty/trademarks](https://www.microsoft.com/en-us/legal/intellectualproperty/trademarks) |
| **GitHub** | **Allowed** to "inform others that your project integrates with GitHub" or to link to GitHub | Black or white (occasionally grey or green) | Don't modify colour or proportions, or combine with other words or design elements | Less prominent than your brand. No endorsement implied | — | [github.com/logos](https://github.com/logos) → brand.github.com/foundations/logo |
| **Notion** | Text: "works with / built with Notion", "A Notion integration". Logo via the official "Made for Notion" badge (minimum 48 px on screen) | — | — | No implied endorsement. Not in product or domain names | "Notion and the Notion logo are trademarks of Notion Labs, Inc., and are used here with permission." (where permission is granted) | [Notion Trademark Usage Guidelines](https://notion.notion.site/p/Notion-Trademark-Usage-Guidelines-9826313c686a4f6e9d8a48347162714b) |
| **ElevenLabs** | Public kit for external parties. No written permission rules | Black or white | Clear space = logo height. The "11" icon may be used in holding shapes (circle/square) | Spelling "ElevenLabs" | — | [elevenlabs.io/brand](https://elevenlabs.io/brand) |
| **Groq** | **Asks you** to show its "Powered by Groq" badge in apps built with Groq (light/dark SVG, link to groq.com) | Badge as supplied | — | — | — | [console.groq.com/docs/badge](https://console.groq.com/docs/badge) |
| **OpenRouter** | Kit available. No permission terms | Grape/Ink on light, Volt/Cloud on dark | "Please don't stretch, recolor, or remix the marks." | — | — | [openrouter.ai/brand](https://openrouter.ai/brand) |
| **Ollama** | **No guideline found** (`ollama.com/brand` 404). MIT covers code only | — | — | — | — | [github.com/ollama/ollama](https://github.com/ollama/ollama) |
| **Mistral AI** | "Partners and collaborators are welcome to use our brand" | Gradient, inverted, black, white. "Do not recolor" | "Do not use a frame." Keep clear space | — | — | [mistral.ai/brand](https://mistral.ai/brand) |
| **DeepSeek** | "Without our permission, you … shall not use any trademarks … company logos … in any way." | — | Don't place the logo next to yours in a misleading way | Only a "technology provider and API user" relationship may be implied | — | [DeepSeek Open Platform ToS](https://cdn.deepseek.com/policies/en-US/deepseek-open-platform-terms-of-service.html) §5.2–5.3 |
| **xAI / Grok** | Only to "accurately refer to us". Exactly as provided | No alteration | No alteration or added elements | No endorsement implied | — | [x.ai/legal/brand-guidelines](https://x.ai/legal/brand-guidelines) (2025-02-14) |
| **X / Twitter** | "Solely for the purposes expressly authorized by X" | Black or white only | Equal clear space | — | — | [about.x.com brand toolkit](https://about.x.com/en/who-we-are/brand-toolkit) |
| **Perplexity** | Only guide found is hosted on a third-party platform; authority unclear. "Partnerships … reach out" | Full or one colour | Don't fill, rotate or thicken | — | — | [live.standards.site/perplexity/logo](https://live.standards.site/perplexity/logo) (ambiguous) |
| **Hugging Face** | Logo downloads "to use in your projects". No written rules | `#FFD21E`, `#FF9D00` | — | — | — | [huggingface.co/brand](https://huggingface.co/brand) |
| **Canva** | Apps may show the Canva logo or "Powered by Canva". "for / works with / compatible with Canva" | No recolouring | Icon below 50 px, 8 px padding. No combining | Not "by Canva" | — | [canva.dev/docs/connect/guidelines/brand](https://www.canva.dev/docs/connect/guidelines/brand/) |
| **YouTube** | API apps may show the logo, but it "must link back to YouTube content" | "You cannot modify the colors" | — | Don't pair with your app name | — | [developers.google.com/youtube/terms/branding-guidelines](https://developers.google.com/youtube/terms/branding-guidelines) |
| **TikTok** | "You may not use TikTok logos, icons, symbols, or designs, without our prior written permission." | — | — | — | — | [developers.tiktok.com design guidelines](https://developers.tiktok.com/docs/en/getting-started-design-guidelines) (updated 2026-08-04) |
| **LinkedIn** | [in] logo only as a Share button or follow widget | Blue, black, white | No modification or combining | No implied affiliation | — | [brand.linkedin.com/in-logo](https://brand.linkedin.com/in-logo) |
| **Linear** | "Do not alter … imply a relationship … or combine … without written consent" | Monochrome preferred | — | — | — | [linear.app/brand](https://linear.app/brand) |
| **Stripe** | Only where it relates to Stripe services (e.g. checkout) | Slate/blurple on light, white on dark | No alteration. No ™/® | No endorsement | — | [stripe.com/marks/legal](https://stripe.com/marks/legal) |
| **Whop** | Kit only. No third-party terms found | Duotone or white/black | Misuse examples shown as images | — | — | [brand.whop.com](https://brand.whop.com) |
| **Docker, Supabase, Zapier, Calendly, Loom, Make, Cerebras, GitHub Copilot, Qwen/Alibaba, Excalidraw, Reddit, Hacker News, Facebook, Nostr, Mattermost, BlueBubbles, Electron, Python, TypeScript** | **Not reviewed.** Guidelines weren't researched in this pass. Treat logo use as needing permission until checked | — | — | — | — | — |

## 3. Verdicts

**OK** = keep as is. **ADJUST** = keep with the exact change listed.
**REMOVE** = replace with a plain-text name or a generic icon that isn't the
brand's mark (a letter monogram, a code glyph, a chat bubble). The goal is to
make the UI safe without needing anyone's permission. If permission arrives
later, a mark can come back using the owner's supplied asset, unmodified.

| # | Usage | Verdict | Reason |
| --- | --- | --- | --- |
| P1 | Claude symbol on mesh badge, chip, tooltip | **REMOVE** | Anthropic requires written permission for any logo use beyond plain-text statements |
| P2 | OpenAI Blossom (white) for Codex | **REMOVE** | OpenAI requires permission. Also, the Blossom stands for OpenAI, not the Codex CLI |
| P3 | Gemini sparkle with a hand-picked gradient | **REMOVE** | No public licence. The gradient isn't Google's asset |
| P4 | OpenCode frame with added inner fill | **ADJUST** (or REMOVE for consistency) | No guideline found. If kept: drop the added `#5E5A5A` inner fill so the path is unmodified, and add OpenCode's non-affiliation line. Recommended: replace it with the same text/monogram treatment as P1–P3 |
| P5 | `gen-provider-logos.mjs` | **REMOVE** (with P1–P4) | Only produces the marks above. Keep only the InfiniBot fallback, or drop the script |
| P6, P7 | Orphan `claude-mark.svg` / `openai-mark.svg` (web + mobile) | **REMOVE** | Unused redrawn marks |
| P8 | `coder-backend-brand.ts` icons | **REMOVE** | Redrawn, recoloured marks, which Anthropic and OpenAI ban. Gemini is shown with the **Google "G"**, which Google bans in business marketing and whose colours may not change. The OpenCode "OC" monogram is our own design and is OK |
| P9 | `agents-management.ts` sparkle/hex chips | **REMOVE** | Evoke the Claude and OpenAI marks. Tinted and enclosed |
| P10 | `mobile/src/utils/providerLogo.js` | **REMOVE** | Same as P6/P7/P8 |
| P11 | Mobile Neural Mesh "OpenAI" → Electron logo | **ADJUST** | Wrong brand's mark. Replace `icon: 'logo-electron'` with a generic Ionicon (e.g. `'sparkles-outline'`) or the `mono: 'AI'` text |
| P12–P14 | Coder avatar portraits with brand captions | **ADJUST** | Regenerate or crop so they carry no third-party names or logos: no "Claude", "OpenAI Codex", "OpenCode", Python logo or "TS" tile. As they stand, the captions read like official "Claude/OpenAI specialist" branding |
| — | Agent sprites and sprite sheets | **OK** | Original art. Letter badges only |
| C1 | WhatsApp / Telegram / Discord / Slack channel logos | Telegram **OK** · WhatsApp **ADJUST** · Discord **REMOVE** · Slack **REMOVE** | Telegram allows its logos. WhatsApp: use Meta's supplied asset unmodified, with no tinted tile, gradient, border or glow. Discord needs permission for uses it hasn't listed and bans recolouring. Slack bans its logo without a licence |
| C2 | Generic channel glyphs (Signal, iMessage, Google Chat, Nostr, BlueBubbles, Mattermost) | **OK** | Not the brands' marks. Names shown as text |
| C2 | Microsoft Teams approximation | **REMOVE** | Microsoft icons need a licence, and the approximation imitates the mark. Use a generic bubble like the other channels |
| C3, C4 | Client social icons (WhatsApp, Telegram, Discord, Instagram) in circles/tiles | WhatsApp **ADJUST** · Telegram **OK** · Discord **REMOVE** · Instagram **ADJUST** | WhatsApp: official asset, no added circle. Telegram OK. Discord: generic icon + "Discord" text. Instagram: use Meta's official glyph asset as supplied (colour rules couldn't be verified), not a redrawn gradient tile |
| C5 | Vault dashboard Discord mark in gold | **REMOVE** | Recolouring is banned and use needs permission. Use a generic chat icon + "Discord" |
| C6 | GitHub Octicon | **OK / ADJUST** | GitHub allows marks that show integration. Make sure it renders black, white or grey: if the theme's `currentColor` is gold there, set `color` to the text colour |
| C7 | Funnel platform icons (Instagram, YouTube, LinkedIn, X, TikTok, Discord outlines) | **REMOVE** | TikTok needs permission. LinkedIn allows its logo only as a share button. X only as authorised. YouTube logos must link to YouTube content. Use generic icons as `content-pages.ts` already does ("no platform brand assets") |
| C8 | Instagram outline, black on gold tile | **REMOVE** | Recoloured and enclosed redraw. Use a generic icon + "Instagram" text |
| C9 | Notion import button (generic stroke) | **OK** | Not the Notion mark |
| C10 | Docker whale | **Not reviewed** | Guidelines not checked, and the code seems unreachable. Replace with a generic container icon, or check Docker's rules |
| M1, M2 | Mobile Ionicons `logo-*` in gold | **REMOVE** | Recolouring is banned (YouTube, LinkedIn, X), and LinkedIn/X limit logo use. Use generic Ionicons (e.g. `globe-outline`, `play-circle-outline`) + the platform name |
| M3 | White Instagram glyph on the "Open in Instagram" fallback | **ADJUST** | Links to Instagram, which is a reasonable use, but the glyph colour rules couldn't be verified. Use Meta's supplied white glyph asset, or a generic `open-outline` icon + "Open in Instagram" |
| L1–L5 | Landing-page logos (AI providers, MCP ecosystem, "replaces", compare tabs and tables) | **REMOVE** | Anthropic, OpenAI, Google, DeepSeek and TikTok-style rules need permission. OpenRouter, Mistral, GitHub, Canva and others ban recolouring (all of these are recoloured grey/gold). xAI and Qwen show **other companies'** marks. Showing competitors' logos in comparison sections adds risk. Use plain-text names (a text marquee is fine). Also remove the hot-links to cdn.simpleicons.org and api.iconify.design |
| L6 | Windows / Apple logos on the download pages (gold) | **REMOVE** | Apple and Microsoft logos need an express licence. Use "Windows" / "macOS" text or a generic monitor/laptop icon |
| N1, N2 | Upstream Clawdbot app icons and mascot | **ADJUST** | Replace with InfiniBot artwork before any app-store or public binary release. The police-box design raises a BBC trademark risk |

## 4. Required UI changes (for the orchestrator to apply on the main branch)

Baseline is `feat/saas-clerk-neon` at or after `c745639f`. Nothing below has
been changed in this branch.

1. **Mesh provider marks → neutral monograms + text.**
   - `ui/src/ui/views/agent-ops/provider-logos.ts`: stop loading
     `/providers/{claude,codex,gemini,opencode}*.png`. Map every coder backend
     to a neutral InfiniBot-drawn letter monogram texture (C / X / G / O,
     like the existing sprite-sheet badges), or to `infinibot`, and keep
     `PROVIDER_LOGO_LABEL` as the tooltip/label text.
   - `world-map-coder-builds.ts:263` and `agency-world-viz.ts:1604`: same
     monogram source. The text label next to it stays.
   - Delete `ui/public/providers/{claude,codex,gemini,opencode}{,@2x}.png`.
     Remove the claude/codex/gemini/opencode entries from
     `ui/scripts/gen-provider-logos.mjs`, keeping only the InfiniBot fallback,
     or generate monograms there instead.
   - If you keep an OpenCode mark instead: remove the `#5E5A5A` inner path in
     `gen-provider-logos.mjs` (`LOGOS.opencode`) so only the unmodified
     Simple Icons path is drawn.
2. **Delete orphans:** `ui/public/providers/claude-mark.svg`,
   `ui/public/providers/openai-mark.svg`,
   `mobile/assets/providers/claude-mark.svg`,
   `mobile/assets/providers/openai-mark.svg`.
3. **`ui/src/ui/lib/coder-backend-brand.ts`:** replace `claudeIcon`,
   `codexIcon` and `geminiIcon` with neutral glyphs, e.g. the existing
   code-brackets icon from `CODER_BACKEND_BRAND_UNKNOWN`, or letter monograms
   in the same rounded-square style as `opencodeIcon`. Fix the comments that
   call them "simplified … official logo". Labels stay as text. Also change
   `getCoderBackendIconLabel` "Codex CLI (OpenAI)" → "Codex CLI" and
   "Gemini CLI (Google)" → "Gemini CLI" (less implied affiliation; optional).
4. **`ui/src/ui/views/agents-management.ts:1765-1780`:** replace the
   sparkle/hex provider glyphs with the same neutral glyphs.
5. **`mobile/src/utils/providerLogo.js`:** replace the Claude starburst and
   OpenAI rosette with letter monograms (or `code-slash-outline`).
6. **`mobile/src/screens/NeuralMeshScreen.js:137`:**
   `icon: 'logo-electron'` → a generic Ionicon (e.g. `'sparkles-outline'`).
7. **Coder avatars:** regenerate `ui/public/agent-avatars/coder-claude.webp`,
   `coder-codex.png` and `coder-opencode.png` with no third-party names,
   captions or logos (no Python logo or "TS" tile).
8. **`ui/src/ui/views/channels.logos.ts`:**
   - Discord (`:38-43`), Slack (`:46-54`) and Microsoft Teams (`:113-119`) →
     generic chat-bubble glyphs, like Signal and Google Chat.
   - WhatsApp (`:22-28`) → Meta's supplied WhatsApp asset, unmodified.
   - In `ui/src/styles/channels.css:99`, drop the brand-tinted tile,
     gradient, border and glow for real brand marks (WhatsApp, Telegram), so
     the mark sits on the card background. Generic glyphs may keep the tile.
9. **`ui/src/ui/views/clients.ts:222-267` and
   `agency-operations.ts:4015-4033`:**
   - Discord → generic icon + "Discord" text.
   - WhatsApp → official asset with no added circle.
   - Instagram → Meta's supplied glyph asset, not the redrawn gradient
     rounded square.
   - Telegram may stay.
10. **`ui/src/ui/views/vault-dashboard.ts:44`:** replace the gold Discord path
    with a generic chat icon (used at `:272`, `:568`, `:598`, `:1355`).
11. **`ui/src/ui/views/kanban.ts:1547`, `:5532`:** make sure the GitHub mark
    renders black, white or grey, e.g. add `style="color: var(--text)"` if
    the surrounding `currentColor` is gold.
12. **`ui/src/ui/views/funnel-flow-map.ts:28-35`, `funnels-onboarding.ts:75-78`:**
    replace the Instagram/YouTube/LinkedIn/X/TikTok/Discord outlines with
    generic icons, following `content-pages.ts:225-258`. Platform names stay
    as text.
13. **`ui/src/ui/views/integrations-panel.ts:207`:** replace the Instagram
    outline on the gold tile with a generic icon.
14. **Mobile `contentApi.js:184-190`, `TrendsScreen.js:30-38`:** replace
    `logo-*` Ionicons with generic Ionicons + text. **`ContentIntelScreen.js:639`:**
    use `open-outline` (or Meta's supplied glyph).
15. **`docs/landing.html` and `docs/download.html`:**
    - Replace every `cdn.simpleicons.org` / `api.iconify.design` logo with
      plain-text names: the #cli-agents cards and marquee, F-05 MCP ecosystem,
      #replaces marquee, #compare tabs and #cmp-* tables.
    - Replace the Windows and Apple paths with text or a generic device icon.
    - Rename the "Claude Coder" card (see marketing guidance).
16. **Native app icons (`apps/macos`, `apps/ios`, `apps/android`):** replace
    the Clawdbot police-box artwork with InfiniBot icons before release.
17. `ui/src/ui/views/docker.ts:25`: optional. Use a generic container icon or
    review Docker's guidelines.

## 5. Marketing guidance (landing page, Instagram, cloud pricing page)

- **Use text, not logos**, for every third-party product. Suggested line:
  "Works with Claude Code, Codex CLI, Gemini CLI and OpenCode, and with any
  model through OpenRouter, Ollama and other providers." Put the
  third-party trademark notice (below) in the page footer, or in the post
  caption or a pinned comment.
- **Don't use their names in ours.** Anthropic bans its names in your product
  or company names, and Slack, Notion, WhatsApp, Discord and OpenAI have
  similar rules. Avoid feature names like **"Claude Coder"** in marketing.
  Say "Coder agent (runs Claude Code)" or "InfiniBot Coder, with Claude
  Code". The internal tool id `claude_coder` isn't customer-facing branding,
  but UI and marketing labels should follow the same rule.
- **Don't say "powered by", "partner", "official", "certified" or "built
  with"** about Anthropic, OpenAI, Google or DeepSeek. Use "works with",
  "compatible with", "connects to", or "runs [tool]". Be exact about models,
  as OpenAI and Anthropic ask ("uses your Claude Code CLI", not "powered by
  Claude").
- **Exception, only if applicable:** Groq asks for its official "Powered by
  Groq" badge in apps built on Groq. You may use the badge exactly as
  supplied. Canva, Notion and GitHub have official "for / works with" badges
  or allowances you can use as supplied.
- **Comparison sections** ("vs ChatGPT", "vs Notion AI", "vs Zapier"): use
  text names only and keep the claims factual and checkable.
- **Instagram and other social posts:** same rules. No third-party logos in
  thumbnails or carousels. Show real screenshots with our own UI instead
  (after the section 4 changes, those screenshots won't show third-party
  marks either).
- **Cloud pricing page:** list supported providers as text ("Bring your own
  keys for Anthropic, OpenAI, Google Gemini, OpenRouter …"). Don't suggest
  that plan prices include or resell those services unless they do.
- **Trademark symbols:** don't add ™/® to Anthropic or Stripe marks (both ask
  for none). Use the owner's wording where one is given (Apple, Microsoft,
  Slack, Notion; see section 2).

Footer notice to use (same text as `TRADEMARKS.md` and `NOTICE`):

> Claude and Anthropic, OpenAI and Codex, Gemini and Google, OpenCode, and
> other third-party names and logos are trademarks of their respective
> owners. They are used only to identify compatibility with those tools, are
> not covered by InfiniBot's license, and their use does not imply any
> endorsement, sponsorship or affiliation.

## 6. Open items

- OpenAI's "Language" section (possible "powered by" or "built with" rules)
  wasn't readable. Re-check [openai.com/brand](https://openai.com/brand) in
  a browser.
- The Gemini sparkle and Google product-icon rules sit behind the Partner
  Marketing Hub login. Ask Google if a Gemini mark is ever wanted.
- Instagram glyph colour and clear-space rules weren't verified (404).
- Brands marked "Not reviewed" in section 2 need a pass if their logos are
  kept anywhere.
- If we ask Anthropic, OpenAI or Google for logo permission, record the
  written approval and its scope here, and use only their supplied assets.
