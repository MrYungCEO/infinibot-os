/**
 * Send an existing PDF file to Telegram as a document.
 * Usage: node --import tsx scripts/send-pdf-telegram.ts <pdf-path> [caption]
 */

import { readFileSync } from "node:fs";
import { sendDocumentTelegram } from "../src/reports/sinks/telegram.js";

async function main() {
  const pdfPath = process.argv[2];
  const caption = process.argv[3] || "📄 PDF document";

  if (!pdfPath) {
    console.error("Usage: send-pdf-telegram.ts <pdf-path> [caption]");
    process.exit(1);
  }

  console.log(`Sending ${pdfPath} to Telegram…`);
  const buffer = readFileSync(pdfPath);
  const filename = pdfPath.split("/").pop() || "document.pdf";

  const result = await sendDocumentTelegram(buffer, {
    filename,
    caption,
  });

  if (result.ok) {
    console.log(`✅ Sent! messageId=${result.messageId} chatId=${result.chatId}`);
  } else {
    console.error(`❌ Failed: ${result.error}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});