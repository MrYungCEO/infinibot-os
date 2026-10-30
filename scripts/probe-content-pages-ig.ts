/**
 * One-off probe: for each content page with surface=instagram, fetch live
 * Instagram Graph API stats and print a summary.
 *
 * Usage: bun scripts/probe-content-pages-ig.ts
 */

import { getContentPagesStore } from "../src/content/pages-store.js";
import { getInstagramPageStats } from "../src/content/pages-instagram-stats.js";

const stateDir = process.env.INFINIBOT_STATE_DIR ?? `${process.env.HOME}/.infinibot`;

async function main() {
  const store = getContentPagesStore(stateDir);
  const pages = store.list({ includeArchived: false });

  const igPages = pages.filter(
    (p) => p.surface === "instagram" || p.integrations?.instagramGraph?.connected === true,
  );

  if (igPages.length === 0) {
    console.log("No Instagram pages found.");
    return;
  }

  console.log(`Found ${igPages.length} Instagram page(s).\n`);

  for (const page of igPages) {
    console.log(`─── ${page.name} (${page.id})`);
    console.log(`    surface=${page.surface}  connected=${page.integrations?.instagramGraph?.connected ?? false}`);

    const stats = await getInstagramPageStats(page, { forceRefresh: true });

    if (stats === null) {
      console.log("    → no IG integration configured\n");
      continue;
    }

    if (stats.error) {
      console.log(`    ERROR [${stats.error.code}]: ${stats.error.message}`);
    }

    console.log(`    followers   : ${stats.followers.toLocaleString()}`);
    console.log(`    reach30d    : ${stats.reach30d.toLocaleString()}`);
    console.log(
      `    impressions : ${stats.impressions30d !== null ? stats.impressions30d.toLocaleString() : "n/a (deprecated metric)"}`,
    );
    console.log(`    topMedia    : ${stats.topMedia.length} item(s)`);
    if (stats.topMedia.length > 0) {
      const top = stats.topMedia[0];
      console.log(
        `      #1  reach=${top.reach.toLocaleString()}  likes=${top.likes}  saves=${top.saves}  ${top.permalink}`,
      );
    }
    console.log(`    fromCache   : ${stats.fromCache}`);
    console.log(`    fetchedAt   : ${new Date(stats.fetchedAt).toISOString()}\n`);
  }
}

main().catch((e) => {
  console.error("Probe failed:", e);
  process.exit(1);
});
