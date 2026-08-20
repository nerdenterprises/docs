// Minimal .xlsx/.xlsm reader: flattens the workbook to tab-separated text so the
// classifier can read a spreadsheet the same way it reads a CSV. Pure Node (an
// xlsx is a zip of XML, and zlib does the only heavy lifting) — no new deps, no
// new native tools in the image.
import { readZip, unxml, textOf } from './ooxml.mjs';

const MAX_ROWS_PER_SHEET = 300; // classify only ever reads the first ~60k chars
const MAX_CHARS = 120_000;

// --- dates -------------------------------------------------------------------
// A serial with a date number format is worth far more to the classifier as
// "2025-01-31" than as "45688".
const BUILTIN_DATE_FMT = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 30, 36, 45, 46, 47, 50, 57]);

function dateFormatIds(stylesXml) {
  const dateXf = new Set();
  if (!stylesXml) return dateXf;
  const customDate = new Set();
  for (const m of stylesXml.matchAll(/<numFmt\s[^>]*numFmtId="(\d+)"[^>]*formatCode="([^"]*)"/g)) {
    const code = unxml(m[2]).replace(/"[^"]*"|\[[^\]]*\]|\\./g, ''); // drop literals/colors/escapes
    if (/[ymd]/i.test(code) && !/[eE][+-]/.test(code)) customDate.add(+m[1]);
  }
  const cellXfs = stylesXml.match(/<cellXfs[\s\S]*?<\/cellXfs>/);
  if (!cellXfs) return dateXf;
  const xfs = [...cellXfs[0].matchAll(/<xf\b[^>]*>/g)];
  xfs.forEach((xf, i) => {
    const id = +(xf[0].match(/numFmtId="(\d+)"/)?.[1] ?? 0);
    if (BUILTIN_DATE_FMT.has(id) || customDate.has(id)) dateXf.add(i);
  });
  return dateXf;
}

function serialToISO(n) {
  if (!(n > 0) || n > 2_958_466) return null;         // 0 .. 9999-12-31
  const ms = Math.round((n - 25569) * 86_400_000);     // 25569 = 1970-01-01 as a serial
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

// --- sheets ------------------------------------------------------------------
function sheetOrder(zip) {
  const wb = zip.read('xl/workbook.xml');
  const rels = zip.read('xl/_rels/workbook.xml.rels');
  const fallback = zip.names().filter((n) => /^xl\/worksheets\/sheet\d*\.xml$/.test(n)).sort();
  if (!wb || !rels) return fallback.map((path) => ({ name: '', path }));

  const target = new Map();
  for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = m[0].match(/Id="([^"]+)"/)?.[1];
    let t = m[0].match(/Target="([^"]+)"/)?.[1];
    if (!id || !t) continue;
    t = t.replace(/^\/?xl\//, '').replace(/^\//, '');
    target.set(id, `xl/${t}`);
  }
  const out = [];
  for (const m of wb.matchAll(/<sheet\b[^>]*>/g)) {
    const rid = m[0].match(/r:id="([^"]+)"/)?.[1];
    const path = rid && target.get(rid);
    if (path && zip.has(path)) out.push({ name: unxml(m[0].match(/name="([^"]*)"/)?.[1] || ''), path });
  }
  return out.length ? out : fallback.map((path) => ({ name: '', path }));
}

function sheetToLines(xml, shared, dateXf) {
  const lines = [];
  const rows = xml.match(/<row\b[\s\S]*?(?:\/>|<\/row>)/g) || [];
  for (const row of rows.slice(0, MAX_ROWS_PER_SHEET)) {
    const cells = [];
    for (const cm of row.matchAll(/<c\b([^>]*)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cm[1] || '';
      const body = cm[2] || '';
      const type = attrs.match(/\bt="([^"]+)"/)?.[1] || 'n';
      let val;
      if (type === 's') {
        val = shared[+(body.match(/<v>([\s\S]*?)<\/v>/)?.[1] ?? -1)] ?? '';
      } else if (type === 'inlineStr' || type === 'str') {
        val = textOf(body) || unxml(body.match(/<v>([\s\S]*?)<\/v>/)?.[1] || '');
      } else {
        const raw = body.match(/<v>([\s\S]*?)<\/v>/)?.[1];
        if (raw == null) { continue; }
        val = unxml(raw);
        const s = +(attrs.match(/\bs="(\d+)"/)?.[1] ?? -1);
        if (dateXf.has(s)) val = serialToISO(+val) || val;
      }
      if (val !== '') cells.push(String(val).replace(/[\t\r\n]+/g, ' ').trim());
    }
    if (cells.length) lines.push(cells.join('\t'));
  }
  return lines;
}

/** Flatten an .xlsx/.xlsm buffer to plain text. Throws if it isn't a readable workbook. */
export function xlsxToText(bytes) {
  const zip = readZip(bytes);
  if (!zip.names().some((n) => n.startsWith('xl/'))) throw new Error('zip is not an xlsx workbook');

  const ss = zip.read('xl/sharedStrings.xml') || '';
  const shared = [...ss.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => textOf(m[1]));
  const dateXf = dateFormatIds(zip.read('xl/styles.xml'));

  const parts = [];
  let chars = 0;
  for (const sheet of sheetOrder(zip)) {
    const lines = sheetToLines(zip.read(sheet.path) || '', shared, dateXf);
    if (!lines.length) continue;
    const block = (sheet.name ? `# Sheet: ${sheet.name}\n` : '') + lines.join('\n');
    parts.push(block);
    chars += block.length;
    if (chars > MAX_CHARS) break;
  }
  return parts.join('\n\n').slice(0, MAX_CHARS);
}
