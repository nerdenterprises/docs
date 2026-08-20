// Shared Office Open XML plumbing: the zip reader, XML unescaping, and the
// text flatteners for .docx and .pptx. An OOXML file is just a zip of XML, so
// zlib does the only heavy lifting — no new deps, no new native tools.
// (.xlsx has its own richer reader in xlsx.mjs, which imports from here.)
import { inflateRawSync } from 'node:zlib';

const MAX_CHARS = 120_000; // classify only ever reads the first ~60k chars

// --- zip ---------------------------------------------------------------------
export function readZip(buf) {
  // End of central directory: scan back from the tail (max 64KB comment).
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip (no EOCD)');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  if (p === 0xffffffff) throw new Error('zip64 not supported');

  const entries = new Map();
  for (let n = 0; n < count && p + 46 <= buf.length; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const rawSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    entries.set(name, { method, compSize, rawSize, localOff });
    p += 46 + nameLen + extraLen + commentLen;
  }
  const inflate = (e) => {
    // Local header sizes can be zeroed (data descriptor); trust the central dir.
    const nameLen = buf.readUInt16LE(e.localOff + 26);
    const extraLen = buf.readUInt16LE(e.localOff + 28);
    const start = e.localOff + 30 + nameLen + extraLen;
    const raw = buf.subarray(start, start + e.compSize);
    return e.method === 0 ? raw : inflateRawSync(raw);
  };

  return {
    has: (name) => entries.has(name),
    names: () => [...entries.keys()],
    /** Uncompressed size — what the bytes actually weigh once inflated. */
    size: (name) => entries.get(name)?.rawSize ?? 0,
    read(name) {
      const e = entries.get(name);
      return e ? inflate(e).toString('utf8') : null;
    },
    readBytes(name) {
      const e = entries.get(name);
      return e ? Buffer.from(inflate(e)) : null;
    },
  };
}

/**
 * The largest embedded raster under `<part>/media/` — for the very common case of a
 * Word/PowerPoint file whose real content is a pasted receipt or statement screenshot.
 * Returns null when there is nothing worth sending to the classifier as an image.
 */
export function largestMedia(zip, part) {
  const cands = zip.names()
    .filter((n) => new RegExp(`^${part}/media/.+\\.(png|jpe?g|gif|webp|tiff?|bmp|emf|wmf)$`, 'i').test(n))
    .map((n) => ({ name: n, size: zip.size(n) }))
    .sort((a, b) => b.size - a.size);
  // EMF/WMF are vector wrappers Claude can't read; only fall back to real rasters.
  const best = cands.find((c) => /\.(png|jpe?g|gif|webp|tiff?|bmp)$/i.test(c.name));
  if (!best || best.size < 4096) return null; // icons/logos aren't the document
  return { name: best.name, bytes: zip.readBytes(best.name) };
}

/** Which OOXML flavor a zip is, by the part names it carries (never the extension). */
export function ooxmlKind(zip) {
  const names = zip.names();
  if (names.some((n) => n.startsWith('word/'))) return 'docx';
  if (names.some((n) => n.startsWith('xl/'))) return 'xlsx';
  if (names.some((n) => n.startsWith('ppt/'))) return 'pptx';
  return null;
}

// --- xml ---------------------------------------------------------------------
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
export const unxml = (s) =>
  s.replace(/&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos);/g, (m, g) =>
    g[0] === '#'
      ? String.fromCodePoint(g[1] === 'x' || g[1] === 'X' ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10))
      : (ENT[g] ?? m));

/** All <t> (or <w:t>, <a:t>, …) text inside a chunk, concatenated. */
export const textOf = (chunk, tag = 't') => {
  const re = new RegExp(String.raw`<${tag}(?:\s[^>]*)?>([\s\S]*?)</${tag}>`, 'g');
  return [...chunk.matchAll(re)].map((m) => unxml(m[1])).join('');
};

// --- flow text ---------------------------------------------------------------
// One linear scan over the tags that carry structure. Word and PowerPoint use the
// same shapes under different prefixes (w: / a:), so both share this. Table rows
// become tab-separated lines, which is what makes a Word invoice or a slide table
// still legible to the classifier.
function flowText(xml, ns) {
  const P = `${ns}:p`, TR = `${ns}:tr`, TC = `${ns}:tc`, T = `${ns}:t`;
  const re = new RegExp(
    String.raw`<${T}(?:\s[^>]*)?>([\s\S]*?)</${T}>|<(${ns}:tab)\s*/>|<(${ns}:br)\s*/>`
    + String.raw`|</(${P})>|<(${TR})[\s>]|</(${TR})>|</(${TC})>`,
    'g');

  const lines = [];
  let buf = '';         // current paragraph
  let cells = null;     // pending cells when inside a table row
  const flushPara = () => {
    const s = buf.trim();
    buf = '';
    if (!s) return;
    if (cells) cells.push(s); else lines.push(s);
  };

  for (const m of xml.matchAll(re)) {
    if (m[1] !== undefined) buf += unxml(m[1]);
    else if (m[2]) buf += '\t';
    else if (m[3]) { flushPara(); }
    else if (m[4]) { flushPara(); }
    else if (m[5]) { flushPara(); cells = []; }
    else if (m[6]) { flushPara(); if (cells?.length) lines.push(cells.join('\t')); cells = null; }
    else if (m[7]) { flushPara(); }
  }
  flushPara();
  if (cells?.length) lines.push(cells.join('\t'));
  return lines.join('\n');
}

// --- docx --------------------------------------------------------------------
export function docxToText(bytes) {
  const zip = readZip(bytes);
  const body = zip.read('word/document.xml');
  if (!body) throw new Error('zip is not a docx (no word/document.xml)');

  const parts = [flowText(body, 'w')];
  // Footnotes/endnotes often carry the terms that matter on a contract or invoice.
  for (const extra of ['word/footnotes.xml', 'word/endnotes.xml']) {
    const xml = zip.read(extra);
    if (!xml) continue;
    const t = flowText(xml, 'w').trim();
    if (t) parts.push(t);
  }
  return parts.join('\n').slice(0, MAX_CHARS);
}

// --- pptx --------------------------------------------------------------------
export function pptxToText(bytes) {
  const zip = readZip(bytes);
  const slides = zip.names()
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => (+a.match(/(\d+)/)[1]) - (+b.match(/(\d+)/)[1]));
  if (!slides.length) throw new Error('zip is not a pptx (no ppt/slides/slideN.xml)');

  const out = [];
  for (const path of slides) {
    const n = +path.match(/(\d+)/)[1];
    const body = flowText(zip.read(path) || '', 'a').trim();
    const notesXml = zip.read(`ppt/notesSlides/notesSlide${n}.xml`);
    const notes = notesXml ? flowText(notesXml, 'a').trim() : '';
    out.push(`--- Slide ${n} ---${body ? '\n' + body : ''}${notes ? '\nNotes: ' + notes : ''}`);
    if (out.join('\n').length > MAX_CHARS) break;
  }
  return out.join('\n').slice(0, MAX_CHARS);
}
