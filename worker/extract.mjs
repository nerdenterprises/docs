// Text-extraction cascade. Cheap/local first; Claude direct-PDF only as last resort.
//   1. pdftotext -layout                       (born-digital + text-layer scans)
//   2. qpdf --decrypt --password='' | pdftotext (empty-password-encrypted statements)
//   3. ocrmypdf | pdftotext                     (image-only scans)
//   4. signal caller to send the PDF to Claude's document endpoint
import { execFile } from 'node:child_process';
import { writeFile, readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

/**
 * @returns {Promise<{text:string, method:string, pdfBytes?:Buffer}>}
 *   method: 'text' | 'pdftotext' | 'decrypt' | 'ocr' | 'none'
 *   when method==='none', pdfBytes is returned so the caller can fall back to Claude.
 */
export async function extractText(bytes, ext) {
  const e = (ext || '').toLowerCase();
  if (e === 'csv' || e === 'txt') return { text: bytes.toString('utf8'), method: 'text' };

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

    return { text: '', method: 'none', pdfBytes: bytes };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
