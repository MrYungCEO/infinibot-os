const sharp = require('sharp');
const path = require('path');

const ASSETS = path.join(__dirname, '..', 'assets');
const LOGO = path.join(ASSETS, 'infinibot-logo.png');
const BG_COLOR = '#050505';

async function generate() {
  const logo = sharp(LOGO);
  const meta = await logo.metadata();
  console.log(`Logo: ${meta.width}x${meta.height}`);

  // 1. icon.png — 1024x1024, logo centered on black
  const logoSize = 680;
  const logoBuf = await sharp(LOGO).resize(logoSize, logoSize, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
  await sharp({ create: { width: 1024, height: 1024, channels: 4, background: BG_COLOR } })
    .composite([{ input: logoBuf, gravity: 'centre' }])
    .png()
    .toFile(path.join(ASSETS, 'icon.png'));
  console.log('✓ icon.png');

  // 2. adaptive-icon.png — 1024x1024, slightly smaller logo for safe zone
  const adaptiveSize = 600;
  const adaptiveBuf = await sharp(LOGO).resize(adaptiveSize, adaptiveSize, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
  await sharp({ create: { width: 1024, height: 1024, channels: 4, background: BG_COLOR } })
    .composite([{ input: adaptiveBuf, gravity: 'centre' }])
    .png()
    .toFile(path.join(ASSETS, 'adaptive-icon.png'));
  console.log('✓ adaptive-icon.png');

  // 3. splash-icon.png — 1024x1024, logo on black bg
  const splashSize = 400;
  const splashBuf = await sharp(LOGO).resize(splashSize, splashSize, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
  await sharp({ create: { width: 1024, height: 1024, channels: 4, background: BG_COLOR } })
    .composite([{ input: splashBuf, gravity: 'centre' }])
    .png()
    .toFile(path.join(ASSETS, 'splash-icon.png'));
  console.log('✓ splash-icon.png');

  // 4. favicon.png — 48x48
  const faviconSize = 36;
  const faviconBuf = await sharp(LOGO).resize(faviconSize, faviconSize, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
  await sharp({ create: { width: 48, height: 48, channels: 4, background: BG_COLOR } })
    .composite([{ input: faviconBuf, gravity: 'centre' }])
    .png()
    .toFile(path.join(ASSETS, 'favicon.png'));
  console.log('✓ favicon.png');

  console.log('All icons generated!');
}

generate().catch(err => { console.error(err); process.exit(1); });
