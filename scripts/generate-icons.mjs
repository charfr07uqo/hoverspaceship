/**
 * Rasterizes public/favicon.svg into the bitmap icon formats that SVG favicons
 * do not cover:
 *
 *  - favicon.ico          16/32/48 px, for older Safari and legacy Windows chrome
 *  - favicon-16.png       explicit small fallback
 *  - favicon-32.png       explicit standard fallback
 *  - apple-touch-icon.png 180 px, flattened opaque because iOS ignores SVG
 *                         touch icons and masks its own rounded corners
 *
 * Run with `npm run icons` after editing favicon.svg. Outputs land in public/
 * so Vite copies them to dist/ on build.
 */
import { writeFile, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import sharp from 'sharp';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = path.join(root, 'public');
const source = path.join(publicDir, 'favicon.svg');

/**
 * Corner fill for the opaque iOS icon. The favicon art is a rounded rect, so its
 * corners are transparent; iOS composites unknown alpha onto white, which would
 * put bright wedges around a near-black icon. This matches the outer stop of the
 * artwork's radial gradient.
 */
const OPAQUE_BACKDROP = { r: 0x0e, g: 0x05, b: 0x1a, alpha: 1 };

/** Renders the source SVG to a square PNG buffer at the given edge length. */
async function renderPng(size, { flatten = false } = {}) {
  const svg = await readFile(source);
  // density scales librsvg's rasterization so small sizes stay crisp instead of
  // being downsampled from the SVG's nominal 64px box.
  const pipeline = sharp(svg, { density: Math.max(72, (size / 64) * 72) }).resize(size, size, {
    fit: 'contain',
    background: { r: 0, g: 0, b: 0, alpha: 0 }
  });
  return (flatten ? pipeline.flatten({ background: OPAQUE_BACKDROP }) : pipeline).png().toBuffer();
}

/**
 * Packs PNG buffers into a single .ico. The ICO container accepts PNG-encoded
 * frames directly, which avoids hand-rolling BMP/DIB encoding.
 */
function buildIco(pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // 1 = icon
  header.writeUInt16LE(pngs.length, 4);

  const ENTRY_BYTES = 16;
  let offset = header.length + pngs.length * ENTRY_BYTES;

  const entries = pngs.map(({ size, data }) => {
    const entry = Buffer.alloc(ENTRY_BYTES);
    entry.writeUInt8(size >= 256 ? 0 : size, 0); // width, 0 means 256
    entry.writeUInt8(size >= 256 ? 0 : size, 1); // height
    entry.writeUInt8(0, 2); // palette size, 0 for truecolor
    entry.writeUInt8(0, 3); // reserved
    entry.writeUInt16LE(1, 4); // color planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(data.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += data.length;
    return entry;
  });

  return Buffer.concat([header, ...entries, ...pngs.map((p) => p.data)]);
}

const icoSizes = [16, 32, 48];
const icoFrames = [];
for (const size of icoSizes) {
  icoFrames.push({ size, data: await renderPng(size) });
}
await writeFile(path.join(publicDir, 'favicon.ico'), buildIco(icoFrames));

await writeFile(path.join(publicDir, 'favicon-16.png'), await renderPng(16));
await writeFile(path.join(publicDir, 'favicon-32.png'), await renderPng(32));
await writeFile(
  path.join(publicDir, 'apple-touch-icon.png'),
  await renderPng(180, { flatten: true })
);

console.log('Icons written: favicon.ico (16/32/48), favicon-16.png, favicon-32.png, apple-touch-icon.png');
