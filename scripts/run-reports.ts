/**
 * Direct runner — bypasses the missing MCP `report` tool by calling
 * the report system's own functions:
 *
 * 1. Enqueues a `ceo_hourly_insights` report (worker picks it up)
 * 2. Renders the AEO Instagram Carousel markdown → PDF → Telegram
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { enqueueReport } from "../src/reports/trigger.js";
import { markdownToPayload } from "../src/reports/helpers/markdown-to-payload.js";
import { sendReportToTelegram } from "../src/reports/render.js";

async function main() {
  // ── 1. CEO Hourly Insights ──────────────────────────────────────
  console.log("[1/2] Enqueuing ceo_hourly_insights report…");
  try {
    const rec = enqueueReport({
      kind: "ceo_hourly_insights" as any,
      trigger: "manual",
      sinks: ["ui", "telegram"],
    });
    console.log(`  ✅ Queued: id=${rec.id} status=${rec.status}`);
  } catch (e: any) {
    console.error(`  ❌ Failed to enqueue CEO report: ${e.message}`);
  }

  // ── 2. AEO Instagram Carousel → Telegram ───────────────────────
  console.log("\n[2/2] Rendering AEO carousel → PDF → Telegram…");
  try {
    const mdPath = join(
      process.cwd(),
      "content",
      "aeo-instagram-carousel.md",
    );
    const markdown = readFileSync(mdPath, "utf8");
    const payload = markdownToPayload(markdown, {
      title: "AEO — Get Found on Google & LinkedIn",
      theme: "black-gold",
    });

    const result = await sendReportToTelegram(payload, {
      caption: "🎯 AEO Instagram Carousel — 10 slides ready for delivery",
    });

    if (result.ok) {
      console.log(`  ✅ Delivered! messageId=${result.messageId} filePath=${result.filePath} bytes=${result.bytes}`);
    } else {
      console.error(`  ❌ Delivery failed: ${result.error}`);
    }
  } catch (e: any) {
    console.error(`  ❌ AEO carousel render/send failed: ${e.message}`);
    console.error(e.stack);
  }
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});