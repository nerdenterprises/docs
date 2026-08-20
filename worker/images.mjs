// Turn any client-supplied image into something Claude's vision input accepts:
// JPEG/PNG/GIF/WebP, <=5MB, <=8000px. Phone photos of receipts arrive as HEIC,
// sideways (EXIF), and far larger than useful, so normalizing is the common path,
// not the exception. Multi-page TIFFs go the other way — to PDF — so the existing
// pdftotext/OCR cascade can read every page instead of just the first.
import { writeFile, readFile, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from './sh.mjs';

// What the API takes as an `image` block, keyed by our sniffed type.
export const NATIVE = { png: 'image/png', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };

const MAX_BYTES = 4 * 1024 * 1024; // stay clear of the API's 5MB/image ceiling
const MAX_EDGE = 1568;             // the API downscales past this anyway
const HARD_EDGE = 8000;            // above this the API rejects outright

// --- ImageMagick discovery (v7 ships `magick`, Debian's v6 ships `convert`) ---
let imBin;
async function magick() {
  if (imBin !== undefined) return imBin;
  for (const c of ['magick', 'convert']) {
    if ((await run(c, ['-version'])).ok) { imBin = c; return imBin; }
  }
  imBin = null;
  return imBin;
}

/**
 * Pixel dimensions straight from the file header — no subprocess. Covers the four
 * native types; anything else is being converted regardless, so it doesn't matter.
 * @returns {{w:number,h:number}|null}
 */
export function pixelSize(b, type) {
  try {
    if (type === 'png' && b.length > 24) return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
    if (type === 'gif' && b.length > 10) return { w: b.readUInt16LE(6), h: b.readUInt16LE(8) };
    if (type === 'webp' && b.length > 30) {
      const fourcc = b.toString('latin1', 12, 16);
      if (fourcc === 'VP8X') return { w: (b.readUIntLE(24, 3) & 0xffffff) + 1, h: (b.readUIntLE(27, 3) & 0xffffff) + 1 };
      if (fourcc === 'VP8 ') return { w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff };
      return null; // VP8L bit-packed; let the byte-size guard handle it
    }
    if (type === 'jpeg') {
      // Walk the marker chain to the first start-of-frame.
      let i = 2;
      while (i + 9 < b.length) {
        if (b[i] !== 0xff) { i++; continue; }
        const m = b[i + 1];
        if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
        const len = b.readUInt16BE(i + 2);
        if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
          return { h: b.readUInt16BE(i + 5), w: b.readUInt16BE(i + 7) };
        }
        i += 2 + len;
      }
    }
  } catch { /* a malformed header just means "convert it" */ }
  return null;
}

/**
 * @returns {Promise<{bytes:Buffer, mediaType:string, method:string}>}
 * @throws when no converter is available for a type the API can't take as-is.
 */
export async function normalizeImage(bytes, type) {
  const native = NATIVE[type];
  const dims = native ? pixelSize(bytes, type) : null;
  const tooBig = bytes.length > MAX_BYTES;
  const tooWide = dims ? Math.max(dims.w, dims.h) > HARD_EDGE : false;

  // Already acceptable — don't re-encode and lose detail for nothing.
  if (native && !tooBig && !tooWide) return { bytes, mediaType: native, method: 'image' };

  const im = await magick();
  const dir = await mkdtemp(join(tmpdir(), 'cd-img-'));
  const src = join(dir, `in.${type === 'jpeg' ? 'jpg' : type}`);
  const out = join(dir, 'out.jpg');
  try {
    await writeFile(src, bytes);
    let done = im
      ? (await run(im, [src, '-auto-orient', '-resize', `${MAX_EDGE}x${MAX_EDGE}>`, '-strip', '-quality', '85', out])).ok
      : false;

    // Debian's ImageMagick only reads HEIC when the libheif delegate is present;
    // heif-convert is the direct path when it isn't.
    if (!done && type === 'heic') {
      const mid = join(dir, 'mid.jpg');
      if ((await run('heif-convert', ['-q', '90', src, mid])).ok) {
        done = im
          ? (await run(im, [mid, '-auto-orient', '-resize', `${MAX_EDGE}x${MAX_EDGE}>`, '-strip', '-quality', '85', out])).ok
          : false;
        if (!done) { // no ImageMagick: take heif-convert's output as-is if it fits
          const b = await readFile(mid);
          if (b.length <= MAX_BYTES) return { bytes: b, mediaType: 'image/jpeg', method: 'image-heic' };
        }
      }
    }
    if (!done) throw new Error(`cannot convert ${type} image (ImageMagick${im ? '' : ' missing'})`);

    let b = await readFile(out);
    // A dense scan can still land over the cap at q85; step the quality down.
    for (const q of [70, 55]) {
      if (b.length <= MAX_BYTES) break;
      if (!(await run(im, [src, '-auto-orient', '-resize', `${MAX_EDGE}x${MAX_EDGE}>`, '-strip', '-quality', String(q), out])).ok) break;
      b = await readFile(out);
    }
    if (b.length > MAX_BYTES) throw new Error(`image still ${Math.round(b.length / 1e6)}MB after downscaling`);
    return { bytes: b, mediaType: 'image/jpeg', method: native ? 'image-resized' : `image-from-${type}` };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * TIFF -> PDF, so multi-page faxes and scans go through the OCR cascade whole.
 * Returns null when no converter is available (caller falls back to image handling).
 */
export async function tiffToPdf(bytes) {
  const im = await magick();
  if (!im) return null;
  const dir = await mkdtemp(join(tmpdir(), 'cd-tif-'));
  const src = join(dir, 'in.tiff');
  const out = join(dir, 'out.pdf');
  try {
    await writeFile(src, bytes);
    if (!(await run(im, [src, out])).ok) return null;
    const s = await stat(out).catch(() => null);
    return s && s.size > 0 ? await readFile(out) : null;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
