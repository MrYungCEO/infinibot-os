/**
 * Reusable Playwright lead-scraping module.
 *
 * Call `scrapeLeads(input, ctx)` from any agent tool or workflow step.
 * The LLM picks parameters; this module does all browser automation.
 * Adding a new source = extending the `source` union + one handler function.
 *
 * Pre-requisite: a Chromium-based browser must be installed on the host.
 * This module will never auto-install browsers; see README.md for setup.
 */

import { chromium } from "playwright-core";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { fileURLToPath } from "node:url";
import {
  findChromeExecutableLinux,
  findChromeExecutableMac,
  findChromeExecutableWindows,
} from "../../browser/chrome.executables.js";
import { resolveHostedFeatures } from "../../saas/hosted-features.js";

// ── Public types ─────────────────────────────────────────────────────────────

export type LeadSource = "google_maps" | "instagram_search" | "directory_site";

export interface ScrapeLeadsInput {
  source: LeadSource;
  /** Search text (google_maps, instagram_search) or direct URL (directory_site). */
  query: string;
  /** Stop collecting once this many leads are found. Default 50. */
  maxResults?: number;
  /** Source-specific filter key/value pairs (e.g. { minRating: "4.0" }). */
  filters?: Record<string, string>;
  /** Launch browser headless. Default false — the window is shown so the user can watch the scrape. */
  headless?: boolean;
  /** Path to a Playwright storageState JSON (for authenticated sources like IG). */
  storageStatePath?: string;
  /**
   * For google_maps: click into each result to extract Phone, Website, Address, Rating, ReviewCount.
   * Adds ~2s/lead. Set enrich=false to skip (fast list-only mode). Default true.
   */
  enrich?: boolean;
}

export interface ScrapedLead {
  name?: string;
  business?: string;
  phone?: string;
  email?: string;
  website?: string;
  socials?: Array<{ handle: string; platform: string; url: string }>;
  address?: string;
  rating?: number;
  reviewCount?: number;
  sourceUrl?: string;
  /** Top-level summary fields only — no raw HTML. */
  raw?: Record<string, unknown>;
}

export interface ScrapeLeadsOutput {
  leads: ScrapedLead[];
  /** True when the run hit maxResults before exhausting available listings. */
  truncated: boolean;
  /** Total listing elements seen (including ones that failed extraction). */
  totalSeen: number;
  durationMs: number;
}

// ── Module identity ──────────────────────────────────────────────────────────
// Logged on every run so callers can confirm the same compiled module is
// reused across workflow invocations (acceptance criterion 2).
export const SCRAPE_LEADS_MODULE_PATH: string = fileURLToPath(import.meta.url);

// ── Browser resolution ───────────────────────────────────────────────────────

function resolveExecutablePath(): string {
  // InfiniBot Cloud: scraping drives the agent browser, so it follows the plan's browser gate.
  const hosted = resolveHostedFeatures();
  if (hosted.fleet && !hosted.browser) {
    throw new Error(
      "Lead scraping uses the agent browser, which is not included in this workspace's plan.",
    );
  }
  const platform = process.platform;
  const exe =
    platform === "darwin"
      ? findChromeExecutableMac()
      : platform === "linux"
        ? findChromeExecutableLinux()
        : findChromeExecutableWindows();
  if (exe) return exe.path;

  // INFINIBOT_BROWSER_EXECUTABLE: the agent browser binary (the cloud image ships it there).
  const envPath =
    process.env.PLAYWRIGHT_CHROMIUM_PATH ??
    process.env.CHROME_PATH ??
    process.env.INFINIBOT_BROWSER_EXECUTABLE;
  if (envPath) return envPath;

  throw new Error(
    "No Chromium-based browser found. Install Chrome/Chromium or set PLAYWRIGHT_CHROMIUM_PATH.",
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function isRateLimitedPage(title: string, url: string): boolean {
  const t = title.toLowerCase();
  const u = url.toLowerCase();
  return (
    t.includes("captcha") ||
    t.includes("unusual traffic") ||
    t.includes("429") ||
    u.includes("sorry/index") ||
    u.includes("recaptcha")
  );
}

/** Attempt to locate an element with a series of selectors; returns first hit. */
async function tryText(page: Page, selectors: string[]): Promise<string | undefined> {
  for (const sel of selectors) {
    try {
      const el = await page.$(sel);
      if (el) {
        const text = (await el.textContent())?.trim();
        if (text) return text;
      }
    } catch {
      // try next
    }
  }
  return undefined;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Scrape leads from the given source using a real headless browser.
 *
 * @param input  - What to scrape and how.
 * @param ctx    - Optional AbortSignal (for cancellation) and log emitter.
 * @returns      Structured leads + run metadata.
 */
export async function scrapeLeads(
  input: ScrapeLeadsInput,
  ctx: { signal?: AbortSignal; log?: (line: string) => void } = {},
): Promise<ScrapeLeadsOutput> {
  const startMs = Date.now();
  const emit = ctx.log ?? ((line: string) => console.log(line));
  const maxResults = Math.max(1, input.maxResults ?? 50);
  const headless = input.headless === true;

  emit(`[lead-scrape] module=${SCRAPE_LEADS_MODULE_PATH}`);
  emit(`[lead-scrape] source=${input.source} query=${input.query} maxResults=${maxResults}`);

  const executablePath = resolveExecutablePath();
  emit(`[lead-scrape] browser=${executablePath} headless=${headless}`);

  let browser: Browser | null = null;
  let context: BrowserContext | null = null;
  const result: ScrapeLeadsOutput = {
    leads: [],
    truncated: false,
    totalSeen: 0,
    durationMs: 0,
  };

  try {
    browser = await chromium.launch({ executablePath, headless, args: ["--no-sandbox"] });

    const contextOpts: Parameters<Browser["newContext"]>[0] = {
      userAgent:
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    };
    if (input.storageStatePath) {
      contextOpts.storageState = input.storageStatePath;
    }
    context = await browser.newContext(contextOpts);

    if (ctx.signal) {
      ctx.signal.addEventListener("abort", () => {
        browser?.close().catch(() => {});
      });
    }

    const page = await context.newPage();

    switch (input.source) {
      case "google_maps":
        Object.assign(
          result,
          await scrapeGoogleMaps(page, input, { maxResults, emit, signal: ctx.signal }),
        );
        break;
      case "instagram_search":
        Object.assign(
          result,
          await scrapeInstagram(page, input, { maxResults, emit, signal: ctx.signal }),
        );
        break;
      case "directory_site":
        Object.assign(
          result,
          await scrapeDirectorySite(page, input, { maxResults, emit, signal: ctx.signal }),
        );
        break;
    }
  } finally {
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
    result.durationMs = Date.now() - startMs;
    emit(
      `[lead-scrape] done leads=${result.leads.length} totalSeen=${result.totalSeen} durationMs=${result.durationMs}`,
    );
  }

  return result;
}

// ── Source: google_maps ───────────────────────────────────────────────────────

async function scrapeGoogleMaps(
  page: Page,
  input: ScrapeLeadsInput,
  opts: { maxResults: number; emit: (line: string) => void; signal?: AbortSignal },
): Promise<ScrapeLeadsOutput> {
  const { maxResults, emit } = opts;
  const startMs = Date.now();
  const leads: ScrapedLead[] = [];
  let totalSeen = 0;
  let truncated = false;

  const encoded = encodeURIComponent(input.query);
  const url = `https://www.google.com/maps/search/${encoded}`;
  emit(`[google_maps] navigate → ${url}`);

  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });

  // Dismiss consent overlay if present (EU)
  const consentBtn = await page.$('button[aria-label*="Accept"]').catch(() => null);
  if (consentBtn) {
    await consentBtn.click().catch(() => {});
    await page.waitForTimeout(1_500);
  }

  // Detect rate-limit / captcha
  if (isRateLimitedPage(await page.title(), page.url())) {
    emit("[google_maps] rate-limit or captcha detected — bailing");
    return { leads: [], truncated: true, totalSeen: 0, durationMs: Date.now() - startMs };
  }

  // Wait for the results feed
  const feedSel = 'div[role="feed"]';
  const feedReady = await page.waitForSelector(feedSel, { timeout: 20_000 }).catch(() => null);
  if (!feedReady) {
    emit("[google_maps] feed not found — possibly zero results or page structure changed");
    return { leads: [], truncated: false, totalSeen: 0, durationMs: Date.now() - startMs };
  }

  let noProgressRounds = 0;
  let prevVisible = 0;

  while (leads.length < maxResults && noProgressRounds < 3) {
    if (opts.signal?.aborted) break;

    // Collect all result anchors visible so far
    const anchors = await page
      .$$eval(`${feedSel} a[href*="/maps/place/"]`, (els) =>
        (els as HTMLAnchorElement[]).map((a) => {
          const container = a.closest("[jsaction]") ?? a.parentElement ?? a;
          const name =
            a.getAttribute("aria-label") ||
            container.querySelector(".fontHeadlineSmall")?.textContent?.trim() ||
            container.querySelector('[class*="fontHeadline"]')?.textContent?.trim() ||
            a.textContent?.trim();

          const ratingEl =
            container.querySelector('[aria-label*="stars"]') ??
            container.querySelector('[class*="Aq14fc"]');
          const ratingText = ratingEl?.getAttribute("aria-label") ?? ratingEl?.textContent;
          const ratingMatch = ratingText?.match(/[\d.]+/);
          const rating = ratingMatch ? parseFloat(ratingMatch[0]) : undefined;

          const reviewEl = container.querySelector('[class*="UY7F9"]');
          const reviewMatch = reviewEl?.textContent?.match(/[\d,]+/);
          const reviewCount = reviewMatch ? parseInt(reviewMatch[0].replace(/,/g, "")) : undefined;

          // Address line — typically the second W4Efsd span
          const spans = Array.from(container.querySelectorAll('span[class*="W4Efsd"]'));
          const address = spans[1]?.textContent?.trim() || spans[0]?.textContent?.trim();

          const websiteAnchor = container.querySelector(
            'a[data-value="Website"]',
          ) as HTMLAnchorElement | null;
          const website = websiteAnchor?.href;

          return {
            name: name || undefined,
            address: address || undefined,
            website: website || undefined,
            rating,
            reviewCount,
            sourceUrl: a.href,
          };
        }),
      )
      .catch(
        () =>
          [] as Array<{
            name: string | undefined;
            address: string | undefined;
            website: string | undefined;
            rating: number | undefined;
            reviewCount: number | undefined;
            sourceUrl: string;
          }>,
      );

    // Process only newly-visible entries
    const newEntries = anchors.slice(totalSeen);
    for (const entry of newEntries) {
      totalSeen++;
      if (!entry.name) continue;
      const lead: ScrapedLead = {
        business: entry.name,
        address: entry.address,
        website: entry.website,
        rating: entry.rating,
        reviewCount: entry.reviewCount,
        sourceUrl: entry.sourceUrl,
      };
      leads.push(lead);
      emit(`[google_maps] +lead: ${lead.business}`);
      if (leads.length >= maxResults) {
        truncated = true;
        break;
      }
    }

    if (truncated) break;
    if (anchors.length === prevVisible) {
      noProgressRounds++;
    } else {
      noProgressRounds = 0;
      prevVisible = anchors.length;
    }

    if (noProgressRounds < 3) {
      // Check for end-of-list sentinel
      const endEl = await page.$('[aria-label*="end of list"]').catch(() => null);
      if (endEl) break;

      // Scroll the feed
      await page
        .evaluate((sel) => {
          const el = document.querySelector(sel);
          if (el) el.scrollTop += el.clientHeight;
        }, feedSel)
        .catch(() => {});
      await page.waitForTimeout(1_800);
    }
  }

  // Detail enrichment: click into each Maps result to extract Phone, Website, Address
  const shouldEnrich = input.enrich !== false;
  if (shouldEnrich && leads.length > 0) {
    emit(`[google_maps] enriching ${leads.length} leads via detail pages…`);
    for (let i = 0; i < leads.length; i++) {
      if (opts.signal?.aborted) break;
      const lead = leads[i];
      if (!lead.sourceUrl) continue;
      try {
        await page.goto(lead.sourceUrl, { waitUntil: "domcontentloaded", timeout: 20_000 });
        await page.waitForTimeout(1_200);

        // Phone — aria-label="Phone: ..." buttons
        const phone = await page
          .evaluate(() => {
            const btn = document.querySelector(
              'button[data-item-id^="phone:"]',
            ) as HTMLButtonElement | null;
            if (btn) {
              const label = btn.getAttribute("aria-label") ?? "";
              return label.replace(/^Phone:\s*/i, "").trim() || null;
            }
            // Fallback: any href with tel:
            const telA = document.querySelector('a[href^="tel:"]') as HTMLAnchorElement | null;
            return telA ? telA.href.replace("tel:", "").trim() : null;
          })
          .catch(() => null);
        if (phone) lead.phone = phone;

        // Website — data-item-id="authority" or the website action button
        if (!lead.website) {
          const website = await page
            .evaluate(() => {
              const webBtn = document.querySelector(
                'a[data-item-id="authority"]',
              ) as HTMLAnchorElement | null;
              if (webBtn?.href) return webBtn.href;
              const webBtnAlt = document.querySelector(
                'a[aria-label*="website" i]',
              ) as HTMLAnchorElement | null;
              return webBtnAlt?.href ?? null;
            })
            .catch(() => null);
          if (website) lead.website = website;
        }

        // Address — more accurate from detail page
        if (!lead.address) {
          const address = await page
            .evaluate(() => {
              const el = document.querySelector(
                'button[data-item-id="address"]',
              ) as HTMLButtonElement | null;
              if (el) {
                const label = el.getAttribute("aria-label") ?? "";
                return label.replace(/^Address:\s*/i, "").trim() || null;
              }
              return null;
            })
            .catch(() => null);
          if (address) lead.address = address;
        }

        // Rating + reviewCount — more accurate from detail heading
        const ratingDetail = await page
          .evaluate(() => {
            const ratingEl = document.querySelector(
              'div[jsaction*="pane.rating"] span[aria-label*="star"]',
            ) as HTMLElement | null;
            const ratingText = ratingEl?.getAttribute("aria-label") ?? "";
            const ratingMatch = ratingText.match(/[\d.]+/);

            const reviewEl = document.querySelector(
              'div[jsaction*="pane.review"] span[aria-label]',
            ) as HTMLElement | null;
            const reviewText = reviewEl?.getAttribute("aria-label") ?? reviewEl?.textContent ?? "";
            const reviewMatch = reviewText.match(/[\d,]+/);

            return {
              rating: ratingMatch ? parseFloat(ratingMatch[0]) : null,
              reviewCount: reviewMatch ? parseInt(reviewMatch[0].replace(/,/g, "")) : null,
            };
          })
          .catch(() => ({ rating: null, reviewCount: null }));

        if (ratingDetail.rating != null && !lead.rating) lead.rating = ratingDetail.rating;
        if (ratingDetail.reviewCount != null && !lead.reviewCount)
          lead.reviewCount = ratingDetail.reviewCount;

        emit(
          `[google_maps] enriched ${i + 1}/${leads.length}: ${lead.business} phone=${lead.phone ?? "—"}`,
        );
      } catch (err) {
        emit(`[google_maps] enrich failed for ${lead.business}: ${String(err)}`);
      }
    }
  }

  return { leads, truncated, totalSeen, durationMs: Date.now() - startMs };
}

// ── Source: instagram_search ──────────────────────────────────────────────────

async function scrapeInstagram(
  page: Page,
  input: ScrapeLeadsInput,
  opts: { maxResults: number; emit: (line: string) => void; signal?: AbortSignal },
): Promise<ScrapeLeadsOutput> {
  const { maxResults, emit } = opts;
  const startMs = Date.now();
  const leads: ScrapedLead[] = [];
  let totalSeen = 0;
  let truncated = false;

  if (!input.storageStatePath) {
    emit("[instagram] storageStatePath required for authenticated scraping");
    return { leads: [], truncated: true, totalSeen: 0, durationMs: Date.now() - startMs };
  }

  // Determine if query is a hashtag or username
  const isHashtag = input.query.startsWith("#");
  const term = input.query.replace(/^[#@]/, "");
  const url = isHashtag
    ? `https://www.instagram.com/explore/tags/${encodeURIComponent(term)}/`
    : `https://www.instagram.com/${encodeURIComponent(term)}/`;

  emit(`[instagram] navigate → ${url}`);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });

  if (isRateLimitedPage(await page.title(), page.url())) {
    emit("[instagram] rate-limit detected — bailing");
    return { leads: [], truncated: true, totalSeen: 0, durationMs: Date.now() - startMs };
  }

  // For a profile page, extract the bio, link, and contact info
  if (!isHashtag) {
    await page.waitForSelector("header", { timeout: 15_000 }).catch(() => null);

    const nameText = await tryText(page, [
      "header h2",
      "header h1",
      'header span[class*="username"]',
      '[data-testid="user-name"]',
    ]);
    const bioText = await tryText(page, [
      'header div[class*="biography"]',
      '[data-testid="user-description-container"]',
      "header section div span",
    ]);
    const websiteEl = await page.$('header a[rel="nofollow"]').catch(() => null);
    const website = websiteEl ? ((await websiteEl.getAttribute("href")) ?? undefined) : undefined;
    const igUrl = page.url();

    totalSeen = 1;
    if (nameText) {
      const lead: ScrapedLead = {
        name: nameText,
        business: nameText,
        website,
        socials: [{ handle: term, platform: "instagram", url: igUrl }],
        raw: { bio: bioText },
        sourceUrl: igUrl,
      };
      leads.push(lead);
      emit(`[instagram] +profile: ${nameText}`);
    }
  } else {
    // For hashtag pages, collect top post authors
    await page.waitForSelector("article", { timeout: 15_000 }).catch(() => null);
    const posts = await page.$$('article a[href*="/p/"]').catch(() => []);
    const seen = new Set<string>();

    for (const post of posts.slice(0, maxResults * 2)) {
      if (opts.signal?.aborted || leads.length >= maxResults) break;
      totalSeen++;

      const postHref = await post.getAttribute("href").catch(() => null);
      if (!postHref || seen.has(postHref)) continue;
      seen.add(postHref);

      // Navigate to post to get author info
      const postUrl = `https://www.instagram.com${postHref}`;
      try {
        await page.goto(postUrl, { waitUntil: "domcontentloaded", timeout: 20_000 });
        const authorHandle = await tryText(page, [
          'article header a[href*="/"]',
          '[data-testid="user-avatar"] + span a',
        ]);
        if (!authorHandle || seen.has(authorHandle)) continue;
        seen.add(authorHandle);

        const lead: ScrapedLead = {
          name: authorHandle,
          socials: [
            {
              handle: authorHandle.replace(/^@/, ""),
              platform: "instagram",
              url: `https://www.instagram.com/${authorHandle.replace(/^@/, "")}/`,
            },
          ],
          sourceUrl: postUrl,
        };
        leads.push(lead);
        emit(`[instagram] +author: ${authorHandle}`);
        if (leads.length >= maxResults) truncated = true;

        await page.goBack().catch(() => {});
        await page.waitForTimeout(1_000);
      } catch {
        // abandon this post
      }
    }
  }

  return { leads, truncated, totalSeen, durationMs: Date.now() - startMs };
}

// ── Source: directory_site ────────────────────────────────────────────────────

async function scrapeDirectorySite(
  page: Page,
  input: ScrapeLeadsInput,
  opts: { maxResults: number; emit: (line: string) => void; signal?: AbortSignal },
): Promise<ScrapeLeadsOutput> {
  const { maxResults, emit } = opts;
  const startMs = Date.now();
  const leads: ScrapedLead[] = [];
  let totalSeen = 0;
  let truncated = false;

  // Treat query as a direct URL for directory_site
  const targetUrl =
    input.query.startsWith("http") || input.query.startsWith("data:")
      ? input.query
      : `https://${input.query}`;

  emit(`[directory_site] navigate → ${targetUrl}`);
  await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });

  if (isRateLimitedPage(await page.title(), page.url())) {
    emit("[directory_site] rate-limit detected — bailing");
    return { leads: [], truncated: true, totalSeen: 0, durationMs: Date.now() - startMs };
  }

  // 1. Try JSON-LD structured data first — most reliable
  const jsonLdLeads = await page.evaluate(() => {
    const scripts = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
    const results: Array<Record<string, unknown>> = [];
    for (const script of scripts) {
      try {
        const data = JSON.parse(script.textContent ?? "") as Record<string, unknown>;
        const types = Array.isArray(data["@type"])
          ? (data["@type"] as string[])
          : [String(data["@type"] ?? "")];
        const businessTypes = new Set([
          "LocalBusiness",
          "Organization",
          "Store",
          "Restaurant",
          "Hotel",
          "MedicalOrganization",
          "ProfessionalService",
        ]);
        if (types.some((t) => businessTypes.has(t))) {
          results.push(data);
        }
        // Also check @graph
        if (Array.isArray(data["@graph"])) {
          for (const node of data["@graph"] as Record<string, unknown>[]) {
            const nodeTypes = Array.isArray(node["@type"])
              ? (node["@type"] as string[])
              : [String(node["@type"] ?? "")];
            if (nodeTypes.some((t) => businessTypes.has(t))) {
              results.push(node);
            }
          }
        }
      } catch {
        // malformed JSON-LD — skip
      }
    }
    return results;
  });

  for (const data of jsonLdLeads) {
    if (opts.signal?.aborted || leads.length >= maxResults) {
      truncated = true;
      break;
    }
    totalSeen++;

    const addr = data.address as Record<string, string> | string | undefined;
    const addressStr =
      typeof addr === "string"
        ? addr
        : addr
          ? [addr.streetAddress, addr.addressLocality, addr.addressRegion]
              .filter(Boolean)
              .join(", ")
          : undefined;

    const telephone = typeof data.telephone === "string" ? data.telephone : undefined;
    const email = typeof data.email === "string" ? data.email : undefined;
    const website = typeof data.url === "string" ? data.url : undefined;
    const name = typeof data.name === "string" ? data.name : undefined;

    const ratingData = data.aggregateRating as Record<string, unknown> | undefined;
    const rating =
      ratingData?.ratingValue != null ? parseFloat(String(ratingData.ratingValue)) : undefined;
    const reviewCount =
      ratingData?.reviewCount != null ? parseInt(String(ratingData.reviewCount)) : undefined;

    if (name) {
      const lead: ScrapedLead = {
        business: name,
        name,
        phone: telephone,
        email,
        website,
        address: addressStr,
        rating: Number.isFinite(rating) ? rating : undefined,
        reviewCount: Number.isFinite(reviewCount) ? reviewCount : undefined,
        sourceUrl: page.url(),
      };
      leads.push(lead);
      emit(`[directory_site] +json-ld: ${name}`);
    }
  }

  // 2. If no JSON-LD results, fall back to meta tags + heuristic extraction
  if (leads.length === 0 && !opts.signal?.aborted) {
    totalSeen++;
    const pageLead = await page.evaluate((): Partial<ScrapedLead> => {
      const meta = (name: string) =>
        (document.querySelector(`meta[name="${name}"]`) as HTMLMetaElement | null)?.content ||
        (document.querySelector(`meta[property="${name}"]`) as HTMLMetaElement | null)?.content;

      const text = (sel: string) =>
        (document.querySelector(sel) as HTMLElement | null)?.textContent?.trim();

      return {
        business:
          meta("og:site_name") || meta("og:title") || text("h1") || document.title || undefined,
        website: (document.querySelector('link[rel="canonical"]') as HTMLLinkElement | null)?.href,
        phone: text('[class*="phone"]') || text('[itemprop="telephone"]') || text('[href^="tel:"]'),
        email: text('[href^="mailto:"]'),
        address:
          text('[itemprop="address"]') ||
          text('[class*="address"]') ||
          text('[itemtype*="PostalAddress"]'),
        sourceUrl: window.location.href,
      };
    });

    if (pageLead.business) {
      leads.push(pageLead as ScrapedLead);
      emit(`[directory_site] +meta: ${pageLead.business}`);
    }
  }

  return {
    leads,
    truncated: truncated || leads.length >= maxResults,
    totalSeen,
    durationMs: Date.now() - startMs,
  };
}
