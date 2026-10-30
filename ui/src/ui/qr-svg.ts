/**
 * Render a QR code as an SVG string IN THE BROWSER, with the QR encoder that
 * already ships with qrcode-terminal (the gateway's own server-pairing-http
 * uses the same one). Use this for anything secret — the Mobile page's other
 * QRs go through api.qrserver.com, which must never see a gateway password.
 */
// @ts-expect-error — vendored CommonJS module without types.
import QRCode from "qrcode-terminal/vendor/QRCode/index.js";

type QrInstance = { addData(s: string): void; make(): void; moduleCount: number; isDark(r: number, c: number): boolean };

export function renderQrSvg(text: string, opts: { cell?: number; pad?: number; fg?: string; bg?: string } = {}): string {
  const QR = QRCode as unknown as new (type: number, level: number) => QrInstance;
  const qr = new QR(-1, 1 /* M */);
  qr.addData(text);
  qr.make();
  const n = qr.moduleCount;
  const cell = opts.cell ?? 6;
  const pad = opts.pad ?? 4 * cell;
  const size = n * cell + pad * 2;
  let path = "";
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (qr.isDark(r, c)) path += `M${pad + c * cell} ${pad + r * cell}h${cell}v${cell}h-${cell}z`;
    }
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges">` +
    `<rect width="100%" height="100%" fill="${opts.bg ?? "#ffffff"}"/>` +
    `<path fill="${opts.fg ?? "#000000"}" d="${path}"/>` +
    `</svg>`
  );
}
