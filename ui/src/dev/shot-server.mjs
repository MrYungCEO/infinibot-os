// Dev-only helper: receives a data-URL via POST and writes it as a JPEG.
// Usage: node src/dev/shot-server.mjs <out-path> [port]
import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';

const out = process.argv[2] || 'shot.jpg';
const port = Number(process.argv[3] || 18991);

createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') { res.end(); return; }
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    const b64 = body.replace(/^data:image\/\w+;base64,/, '');
    writeFileSync(out, Buffer.from(b64, 'base64'));
    res.end('ok');
    console.log(`wrote ${out} (${b64.length} b64 chars)`);
  });
}).listen(port, () => console.log(`shot-server on ${port}`));
