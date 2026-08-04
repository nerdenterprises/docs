// Text-extraction cascade. Cheap/local first; Claude direct-PDF only as last resort.
//   0. csv/txt read as-is; xlsx/xlsm flattened to text locally
//   1. pdftotext -layout                       (born-digital + text-layer scans)
//   2. qpdf --decrypt --password='' | pdftotext (empty-password-encrypted statements)
//   3. ocrmypdf | pdftotext                     (image-only scans)
//   4. signal caller to send the PDF to Claude's document endpoint
import { execFile } from 'node:child_process';
import { writeFile, readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { xlsxToText } from './xlsx.mjs';

const MIN_TEXT = 40; // non-space chars that count as "real text"

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { maxBuffer: 64 * 1024 * 1024, ...opts }, (err, stdout, stderr) =>
      resolve({ ok: !err, stdout: stdout || '', stderr: stderr || '' }));
  });
}

const enough = (t) => (t || '').replace(/\s/g, '').length >= MIN_TEXT;

async function pdftotext(path) {
  const r = await run('pdftotext', ['-layout', '-nopgbrk', '-enc', 'UTF-8', path, '-']);
  return r.ok ? r.stdout : '';
}

const isPdf = (bytes) => bytes.length > 4 && bytes.toString('latin1', 0, 5) === '%PDF-';

/**
 * @returns {Promise<{text:string, method:string, pdfBytes?:Buffer}>}
 *   method: 'text' | 'xlsx' | 'pdftotext' | 'decrypt' | 'ocr' | 'none'
 *   when method==='none' AND the bytes really are a PDF, pdfBytes is returned so the
 *   caller can fall back to Claude's document endpoint. Never send it anything else:
 *   the API rejects a non-PDF payload with a 400 and the job dies.
 */
export async function extractText(bytes, ext) {
  const e = (ext || '').toLowerCase();
  if (e === 'csv' || e === 'txt' || e === 'tsv') return { text: bytes.toString('utf8'), method: 'text' };
  if (e === 'xlsx' || e === 'xlsm') {
    try {
      const text = xlsxToText(bytes);
      if (enough(text)) return { text, method: 'xlsx' };
      return { text, method: 'xlsx-empty' };
    } catch (err) {
      return { text: '', method: `xlsx-failed: ${err.message}` };
    }
  }

  const dir = await mkdtemp(join(tmpdir(), 'cd-'));
  const src = join(dir, 'in.pdf');
  try {
    await writeFile(src, bytes);

    let t = await pdftotext(src);
    if (enough(t)) return { text: t, method: 'pdftotext' };

    // encrypted (empty password) — very common for bank statements
    const dec = join(dir, 'dec.pdf');
    const q = await run('qpdf', ['--decrypt', '--password=', src, dec]);
    if (q.ok) {
      t = await pdftotext(dec);
      if (enough(t)) return { text: t, method: 'decrypt' };
    }

    // image-only scan — OCR then read
    const ocr = join(dir, 'ocr.pdf');
    const o = await run('ocrmypdf', ['--skip-text', '--optimize', '0', '--quiet', src, ocr]);
    if (o.ok) {
      t = await pdftotext(ocr);
      if (enough(t)) return { text: t, method: 'ocr' };
    }

    return isPdf(bytes) ? { text: '', method: 'none', pdfBytes: bytes } : { text: '', method: 'none' };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
