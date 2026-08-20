// Text-extraction cascade. Cheap/local first; Claude vision/document input only as
// a last resort. Types are decided by CONTENT, not by the extension — clients rename
// things, and mailing a non-PDF to the document endpoint is a 400 that kills the job.
//
//   text-ish (csv/txt/ofx/qfx/eml/html/rtf) → read/strip locally
//   xlsx/xlsm → flattened locally      docx/pptx → flattened locally
//   pdf → pdftotext → qpdf --decrypt → ocrmypdf → Claude document input
//   tiff → PDF (so multi-page scans OCR whole) → the pdf cascade
//   png/jpeg/gif/webp/heic/bmp → normalized → Claude image input
//   video/audio → stored, never classified (see index.mjs's store lane)
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from './sh.mjs';
import { xlsxToText } from './xlsx.mjs';
import { readZip, ooxmlKind, docxToText, pptxToText, largestMedia } from './ooxml.mjs';
import { NATIVE, normalizeImage, tiffToPdf } from './images.mjs';

const MIN_TEXT = 40;                        // non-space chars that count as "real text"
const MAX_PDF_TO_CLAUDE = 20 * 1024 * 1024; // API caps a request at 32MB; base64 inflates ~33%
const MAX_PDF_PAGES = 100;                  // API cap for document input

const enough = (t) => (t || '').replace(/\s/g, '').length >= MIN_TEXT;

// Read as text when the bytes are plainly text. These extensions are the ones a
// bookkeeping client actually sends; .ofx/.qfx/.qbo/.qif are bank downloads.
const TEXT_EXT = new Set(['csv', 'tsv', 'txt', 'md', 'json', 'ofx', 'qfx', 'qbo', 'qif', 'eml', 'log']);

// Stored, not classified. Anything here is a deliverable (a video testimonial, a
// recorded call) rather than a document with fields to extract.
const MEDIA = new Set(['mp4', 'mov', 'avi', 'matroska', 'asf', 'ogg', 'mp3', 'm4a', 'wav', 'flac']);

// Legacy binary Office. Reading these needs LibreOffice (~500MB in the image), so
// we ask for a re-save instead of guessing.
const LEGACY = { ole2: 'Office 97-2003 (.doc/.xls/.ppt)' };

/** Content sniffing. Falls back to the extension only when the bytes say nothing. */
export function sniff(bytes, ext) {
  const b = bytes;
  const at = (i, s) => b.length >= i + s.length && b.toString('latin1', i, i + s.length) === s;
  const u8 = (...xs) => b.length >= xs.length && xs.every((x, i) => b[i] === x);

  if (b.toString('latin1', 0, 1024).includes('%PDF-')) return 'pdf';
  if (u8(0x89, 0x50, 0x4e, 0x47)) return 'png';
  if (u8(0xff, 0xd8, 0xff)) return 'jpeg';
  if (at(0, 'GIF8')) return 'gif';
  if (at(0, 'RIFF')) {
    if (at(8, 'WEBP')) return 'webp';
    if (at(8, 'AVI ')) return 'avi';
    if (at(8, 'WAVE')) return 'wav';
  }
  if (at(4, 'ftyp')) {
    const brand = b.toString('latin1', 8, 12);
    if (/^(heic|heix|hevc|hevx|mif1|msf1)$/.test(brand)) return 'heic';
    if (brand.startsWith('qt')) return 'mov';
    if (brand === 'M4A ') return 'm4a';
    return 'mp4';
  }
  if (u8(0x49, 0x49, 0x2a, 0x00) || u8(0x4d, 0x4d, 0x00, 0x2a)) return 'tiff';
  if (at(0, 'BM')) return 'bmp';
  if (u8(0x50, 0x4b, 0x03, 0x04)) return 'zip';
  if (u8(0xd0, 0xcf, 0x11, 0xe0)) return 'ole2';
  if (u8(0x1a, 0x45, 0xdf, 0xa3)) return 'matroska';
  if (u8(0x30, 0x26, 0xb2, 0x75)) return 'asf';
  if (at(0, 'OggS')) return 'ogg';
  if (at(0, 'ID3') || u8(0xff, 0xfb) || u8(0xff, 0xf3)) return 'mp3';
  if (at(0, 'fLaC')) return 'flac';
  if (at(0, '{\\rtf')) return 'rtf';

  const e = (ext || '').toLowerCase();
  if (/^<(!doctype html|html)/i.test(b.toString('utf8', 0, 200).trim())) return 'html';
  if (e === 'htm' || e === 'html') return 'html';
  if (TEXT_EXT.has(e)) return 'text';

  // No magic, no known extension: if it reads as text, treat it as text. Bank
  // exports land here with all sorts of extensions (.dat, .statement, none at all).
  const head = b.subarray(0, 4096);
  if (head.length) {
    let printable = 0;
    for (const c of head) if (c === 9 || c === 10 || c === 13 || (c >= 32 && c !== 127)) printable++;
    if (printable / head.length > 0.9) return 'text';
  }
  return e || 'unknown';
}

// --- local text readers ------------------------------------------------------
const HTML_ENT = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" };

const stripHtml = (s) =>
  s.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<\/t[dh]>/gi, '\t')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&(amp|lt|gt|quot|#39);/gi, (m) => HTML_ENT[m.toLowerCase()] ?? m)
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();

// Minimal RTF de-controlling: drop skippable groups, then control words.
const stripRtf = (s) =>
  s.replace(/\{\\\*[\s\S]*?\}/g, ' ')
    .replace(/\\'([0-9a-f]{2})/gi, (m, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\par[d]?\b/g, '\n')
    .replace(/\\tab\b/g, '\t')
    .replace(/\\[a-z]+-?\d*\s?/gi, '')
    .replace(/[{}]/g, '')
    .replace(/[ \t]+/g, ' ')
    .trim();

async function pdftotext(path) {
  const r = await run('pdftotext', ['-layout', '-nopgbrk', '-enc', 'UTF-8', path, '-']);
  return r.ok ? r.stdout : '';
}

async function pageCount(path) {
  const r = await run('pdfinfo', [path]);
  const m = r.ok && r.stdout.match(/^Pages:\s+(\d+)/m);
  return m ? +m[1] : null;
}

/** The PDF cascade, shared by real PDFs and by TIFFs we converted into one. */
async function fromPdf(bytes, method0) {
  const dir = await mkdtemp(join(tmpdir(), 'cd-'));
  const src = join(dir, 'in.pdf');
  try {
    await writeFile(src, bytes);

    let t = await pdftotext(src);
    if (enough(t)) return { kind: 'text', text: t, method: method0 || 'pdftotext' };

    // encrypted (empty password) — very common for bank statements
    const dec = join(dir, 'dec.pdf');
    if ((await run('qpdf', ['--decrypt', '--password=', src, dec])).ok) {
      t = await pdftotext(dec);
      if (enough(t)) return { kind: 'text', text: t, method: 'decrypt' };
    }

    // image-only scan — OCR then read
    const ocr = join(dir, 'ocr.pdf');
    if ((await run('ocrmypdf', ['--skip-text', '--optimize', '0', '--quiet', src, ocr])).ok) {
      t = await pdftotext(ocr);
      if (enough(t)) return { kind: 'text', text: t, method: 'ocr' };
    }

    // Last resort: let Claude read the PDF itself, but only within the API's limits.
    if (bytes.length > MAX_PDF_TO_CLAUDE) {
      return { kind: 'unsupported', method: 'none',
        reason: `no text layer and PDF is ${Math.round(bytes.length / 1e6)}MB (over the ${MAX_PDF_TO_CLAUDE / 1e6}MB direct-read limit)` };
    }
    const pages = await pageCount(src);
    if (pages && pages > MAX_PDF_PAGES) {
      return { kind: 'unsupported', method: 'none',
        reason: `no text layer and ${pages} pages (over the ${MAX_PDF_PAGES}-page direct-read limit)` };
    }
    return { kind: 'pdf', pdfBytes: bytes, method: method0 ? `${method0}-none` : 'none' };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** An OOXML file whose text is too thin to classify but which wraps a scan. */
async function ooxmlFallbackImage(zip, part, label) {
  const media = largestMedia(zip, part);
  if (!media) return null;
  const type = sniff(media.bytes, media.name.split('.').pop());
  if (!NATIVE[type] && !['heic', 'bmp', 'tiff'].includes(type)) return null;
  try {
    const img = await normalizeImage(media.bytes, type);
    return { kind: 'image', imageBytes: img.bytes, imageMediaType: img.mediaType,
      method: `${label}-embedded-${img.method}` };
  } catch {
    return null;
  }
}

/**
 * @returns {Promise<{kind:'text'|'pdf'|'image'|'store'|'unsupported', method:string,
 *   text?:string, pdfBytes?:Buffer, imageBytes?:Buffer, imageMediaType?:string, reason?:string}>}
 */
export async function extractText(bytes, ext) {
  const e = (ext || '').toLowerCase();
  const type = sniff(bytes, e);

  if (MEDIA.has(type)) return { kind: 'store', method: `media-${type}` };
  if (LEGACY[type]) {
    return { kind: 'unsupported', method: type,
      reason: `${LEGACY[type]} isn't readable here — re-save as .docx/.xlsx/.pptx or PDF and re-upload` };
  }

  if (type === 'text') return { kind: 'text', text: bytes.toString('utf8'), method: `text-${e || 'plain'}` };
  if (type === 'html') {
    const t = stripHtml(bytes.toString('utf8'));
    return { kind: 'text', text: t, method: enough(t) ? 'html' : 'html-empty' };
  }
  if (type === 'rtf') {
    const t = stripRtf(bytes.toString('latin1'));
    return { kind: 'text', text: t, method: enough(t) ? 'rtf' : 'rtf-empty' };
  }

  if (type === 'zip') {
    let zip;
    try { zip = readZip(bytes); }
    catch (err) { return { kind: 'unsupported', method: 'zip', reason: `unreadable zip: ${err.message}` }; }
    const kind = ooxmlKind(zip);
    const READERS = { xlsx: [xlsxToText, 'xl'], docx: [docxToText, 'word'], pptx: [pptxToText, 'ppt'] };
    if (READERS[kind]) {
      const [reader, part] = READERS[kind];
      try {
        const text = reader(bytes);
        if (enough(text)) return { kind: 'text', text, method: kind };
        return (await ooxmlFallbackImage(zip, part, kind)) || { kind: 'text', text, method: `${kind}-empty` };
      } catch (err) {
        return { kind: 'unsupported', method: kind, reason: `${kind} read failed: ${err.message}` };
      }
    }
    if (zip.names().some((n) => /^(Index\/|index\.(xml|apxl))/.test(n))) {
      return { kind: 'unsupported', method: 'iwork',
        reason: 'Apple Pages/Numbers/Keynote file — export to PDF or Office format and re-upload' };
    }
    return { kind: 'unsupported', method: 'zip',
      reason: 'zip archive — please upload the files individually rather than zipped' };
  }

  if (type === 'pdf') return fromPdf(bytes, null);

  if (type === 'tiff') {
    const pdf = await tiffToPdf(bytes);
    if (pdf) return fromPdf(pdf, 'tiff');
    // else fall through to single-image handling below
  }

  if (NATIVE[type] || ['heic', 'bmp', 'tiff'].includes(type)) {
    try {
      const img = await normalizeImage(bytes, type);
      return { kind: 'image', imageBytes: img.bytes, imageMediaType: img.mediaType, method: img.method };
    } catch (err) {
      return { kind: 'unsupported', method: `image-${type}`, reason: err.message };
    }
  }

  return { kind: 'unsupported', method: type, reason: `unsupported file type: ${type}` };
}
