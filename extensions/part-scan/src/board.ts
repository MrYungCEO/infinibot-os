import type { PartScanConfig } from "./types.js";

// OpenCV DICT_5X5_100 payload bits. Marker rendering adds the required black border.
const DICT_5X5_100 = [
  "1010001011011001010111100", "0000111000000011011100110", "1101011110000111011011101",
  "1000000111001010111110111", "1101011101011010100100100", "1110101000000100000101101",
  "0110100111101011111101100", "0111000100001010001101011", "1000011010110000100110010",
  "1001100010011111110100101", "1001111001110111000000011", "1101000101101101011000000",
  "1111001100010101100010001", "0010111100111000101100110", "1111111001111110010101000",
  "0010100011110001101111111", "0100101111010011101011000", "0101111101010001001101111",
  "0111101100100110111000100", "1000001100001110111101000", "1001011011101101001110101",
  "1010100001110010001000000", "1011010110000110010100001", "0101110100001001011011110",
  "1100111001101000000100011", "1101001011001100101110010", "1110000111100111010001011",
  "0001000100100001001000110", "0001110111001011001110010", "0001001000010001000111011",
  "0001001110011011101101110", "0001101101000100001110011", "0010000001101000011001110",
  "0010010101010101011001000", "0010001100100001110111010", "0011110100110111111101010",
  "0100110011000101010101100", "0100000101101000100000001", "0100110101010110100011101",
  "0100001100011110001110010", "0101011010010100000100101", "0101001010010111110011110",
  "0110110000100100111110111", "0110000110000100111011001", "0110110100111111000110001",
  "0111010010110001001111010", "0111010011011100110010111", "0111110010100100000000110",
  "0111101011001000100100101", "0111101101011011111010111", "1000110110101100011100100",
  "1000110101101001001111001", "1000111100011100000001011", "1000101101001010001000101",
  "1001011111111101101001010", "1010110001100101110001101", "1010110011000011111110000",
  "1010000100010111111011111", "1010011100001001000100111", "1010101101101111100100010",
  "1011100111101101111110001", "1011001001100100100111100", "1011111001011101110000110",
  "1100010000000101010000111", "1100100010100011111011101", "1100001001110101110001010",
  "1100011011000010110101101", "1101100101100110110101001", "1101110101011110101110011",
  "1111010011101010000110010", "1111001110110010100101000", "0111101010111010000001010",
  "1101100010001101001010011", "0000110001100111001100101", "0001010101011001000011001",
  "0100110001110100110000001", "0101010000000011000011100", "1010000011010000101011000",
  "1100001010011000101001100", "1100101101101000100101100", "1111110101101001110100010",
  "0000010010010001010110101", "0000110011011110011100000", "0000010110101010001111100",
  "0000000101100011101101111", "0000100110010001010001001", "0000100101101001010100111",
  "0000011000100101101000011", "0000001100111101111000101", "0000011111010101000001101",
  "0000111110001111101010100", "0001110001110100001111001", "0001100100011101100100011",
  "0001011000011011001000111", "0001011011010010100011011", "0001011101001110110001101",
  "0001001111100010101100010", "0001111101111110111110101", "0010100100001111011100000",
  "0010001001000111011111101",
] as const;

interface Rect { x: number; y: number; w: number; h: number }

function boardGeometry(config: PartScanConfig): { width: number; height: number; black: Rect[] } {
  const square = config.markerSquareMm;
  const marker = square * 0.75;
  const offset = (square - marker) / 2;
  const cell = marker / 7;
  const black: Rect[] = [];
  let markerId = 0;
  for (let row = 0; row < config.boardRows; row++) {
    for (let col = 0; col < config.boardCols; col++) {
      const x = col * square;
      const y = row * square;
      if ((row + col) % 2 === 0) {
        black.push({ x, y, w: square, h: square });
        continue;
      }
      const bits = DICT_5X5_100[markerId++ % DICT_5X5_100.length];
      for (let my = 0; my < 7; my++) {
        for (let mx = 0; mx < 7; mx++) {
          const border = my === 0 || mx === 0 || my === 6 || mx === 6;
          const payloadBlack = !border && bits[(my - 1) * 5 + (mx - 1)] === "0";
          if (border || payloadBlack) black.push({ x: x + offset + mx * cell, y: y + offset + my * cell, w: cell, h: cell });
        }
      }
    }
  }
  return { width: config.boardCols * square, height: config.boardRows * square, black };
}

export function charucoSvg(config: PartScanConfig): string {
  const board = boardGeometry(config);
  const margin = 12;
  const width = board.width + margin * 2;
  const height = board.height + margin * 2 + 12;
  const rects = board.black
    .map((r) => `<rect x="${(r.x + margin).toFixed(4)}" y="${(r.y + margin).toFixed(4)}" width="${r.w.toFixed(4)}" height="${r.h.toFixed(4)}"/>`)
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}mm" height="${height}mm" viewBox="0 0 ${width} ${height}">` +
    `<rect width="100%" height="100%" fill="white"/><g fill="black">${rects}</g>` +
    `<text x="${margin}" y="${height - 4}" font-family="sans-serif" font-size="3.2" fill="black">` +
    `InfiniBot Part Scan · ${config.markerDictionary} · square ${config.markerSquareMm} mm · print at 100%</text></svg>`;
}

function pdfObject(id: number, body: string | Buffer): Buffer {
  const content = Buffer.isBuffer(body) ? body : Buffer.from(body, "binary");
  return Buffer.concat([Buffer.from(`${id} 0 obj\n`, "ascii"), content, Buffer.from("\nendobj\n", "ascii")]);
}

export function charucoPdf(config: PartScanConfig): Buffer {
  const board = boardGeometry(config);
  const mmToPt = 72 / 25.4;
  const pageW = 210 * mmToPt;
  const pageH = 297 * mmToPt;
  const originX = (pageW - board.width * mmToPt) / 2;
  const originY = (pageH - board.height * mmToPt) / 2;
  const commands = ["0 g"];
  for (const r of board.black) {
    commands.push(
      `${(originX + r.x * mmToPt).toFixed(3)} ${(originY + (board.height - r.y - r.h) * mmToPt).toFixed(3)} ` +
      `${(r.w * mmToPt).toFixed(3)} ${(r.h * mmToPt).toFixed(3)} re f`,
    );
  }
  const label = `InfiniBot Part Scan - ${config.markerDictionary} - square ${config.markerSquareMm} mm - print at 100%`;
  commands.push(`BT /F1 9 Tf 36 24 Td (${label.replace(/[()\\]/g, "")}) Tj ET`);
  const stream = Buffer.from(`${commands.join("\n")}\n`, "ascii");
  const objects = [
    pdfObject(1, "<< /Type /Catalog /Pages 2 0 R >>"),
    pdfObject(2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>"),
    pdfObject(3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageW.toFixed(3)} ${pageH.toFixed(3)}] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>`),
    pdfObject(4, Buffer.concat([Buffer.from(`<< /Length ${stream.length} >>\nstream\n`, "ascii"), stream, Buffer.from("endstream", "ascii")])),
    pdfObject(5, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"),
  ];
  const header = Buffer.from("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n", "binary");
  const offsets: number[] = [0];
  let cursor = header.length;
  for (const object of objects) {
    offsets.push(cursor);
    cursor += object.length;
  }
  const xrefOffset = cursor;
  const xref = ["xref", `0 ${objects.length + 1}`, "0000000000 65535 f "];
  for (let i = 1; i <= objects.length; i++) xref.push(`${String(offsets[i]).padStart(10, "0")} 00000 n `);
  xref.push("trailer", `<< /Size ${objects.length + 1} /Root 1 0 R >>`, "startxref", String(xrefOffset), "%%EOF", "");
  return Buffer.concat([header, ...objects, Buffer.from(xref.join("\n"), "ascii")]);
}

export const boardInternals = { boardGeometry };
