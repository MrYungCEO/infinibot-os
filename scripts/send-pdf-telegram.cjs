// Send an existing PDF file to Telegram as a document.
// Usage: node scripts/send-pdf-telegram.cjs <pdf-path> [caption]
const { sendDocumentTelegram } = require('../dist/reports/sinks/telegram.js');

async function main() {
  const pdfPath = process.argv[2];
  const caption = process.argv[3] || 'PDF document';
  if (!pdfPath) { console.error('Usage: send-pdf-telegram.cjs <pdf-path> [caption]'); process.exit(1); }
  const result = await sendDocumentTelegram(pdfPath, { caption });
  if (result.ok) { console.log('OK messageId=' + result.messageId + ' chatId=' + result.chatId); }
  else { console.error('FAIL: ' + result.error); process.exit(1); }
}
main().catch(e => { console.error('Fatal: ' + e.message); process.exit(1); });