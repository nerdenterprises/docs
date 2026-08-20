// Two-stage classifier: deterministic rules (free, instant, never drifts) first,
// Claude fallback for anything unknown/low-confidence. Returns a normalized record
// or {needs_review:true, reason}. The conventions (tags/Member/etc.) are applied
// downstream in notion.mjs regardless of which stage produced this.
import { CFG } from './config.mjs';

const MONTHS = { january:1,february:2,march:3,april:4,may:5,june:6,july:7,august:8,september:9,october:10,november:11,december:12 };
const pad = (n) => String(n).padStart(2, '0');

// --- date helpers -----------------------------------------------------------
function isoFrom(y, m, d) { return `${y}-${pad(m)}-${pad(d)}`; }

function statementEndDate(text) {
  // "January 01, 2025 through January 31, 2025"  -> end date
  let m = text.match(/through\s+([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})/i);
  if (m && MONTHS[m[1].toLowerCase()]) return isoFrom(m[3], MONTHS[m[1].toLowerCase()], +m[2]);
  // "Statement Period 12/11/2025 to 01/09/2026" -> end date
  m = text.match(/Statement Period[^0-9]*\d{1,2}\/\d{1,2}\/\d{2,4}\s*(?:to|-|–)\s*(\d{1,2})\/(\d{1,2})\/(\d{2,4})/i);
  if (m) { const y = m[3].length === 2 ? '20' + m[3] : m[3]; return isoFrom(y, +m[1], +m[2]); }
  // "... to 06/09/2026" (closing only)
  m = text.match(/(?:to|through)\s+(\d{1,2})\/(\d{1,2})\/(\d{2,4})/i);
  if (m) { const y = m[3].length === 2 ? '20' + m[3] : m[3]; return isoFrom(y, +m[1], +m[2]); }
  return null;
}

function last4(text) {
  let m = text.match(/ending in\s+(\d{4})/i)
    || text.match(/Account Number:\s*[X\d\s]*?(\d{4})\b/i)
    || text.match(/XXXX\s*XXXX\s*XXXX\s*(\d{4})/i);
  return m ? m[1] : null;
}

// --- issuer signatures (extend freely; this is config, not intelligence) ----
const ISSUERS = [
  { re: /JPMorgan Chase|Chase\.com|CHASE\b/i, vendor: 'Chase', institution: 'Chase',
    products: [
      { re: /Business Complete Checking/i, name: 'Chase Business Complete Checking', category: 'Banking', tags: ['Bank Statement','Banking'] },
      { re: /Ink Business|CHASE ULTIMATE REWARDS|1\.5% cash back/i, name: 'Chase Ink Business Unlimited', category: 'Banking', tags: ['Credit Cards','Bank Statement'] },
      { re: /Sapphire/i, name: 'Chase Sapphire', category: 'Banking', tags: ['Credit Cards'] },
    ],
    fallback: { name: 'Chase', category: 'Banking', tags: ['Banking'] } },
  { re: /WELLS FARGO/i, vendor: 'Wells Fargo', institution: null,
    products: [
      { re: /ACTIVE CASH VISA/i, name: 'Wells Fargo Active Cash Visa', category: 'Banking', tags: ['Credit Cards'] },
    ],
    fallback: { name: 'Wells Fargo', category: 'Banking', tags: ['Banking'] } },
  { re: /Bank of America/i, vendor: 'Bank of America', institution: 'Bank of America',
    products: [], fallback: { name: 'Bank of America', category: 'Banking', tags: ['Banking'] } },
];

function deterministic(text, filename) {
  const f = (filename || '').toLowerCase();
  // filename-driven CSV shortcuts
  if (/payroll-summary-(\d{4})/.test(f)) {
    const y = f.match(/payroll-summary-(\d{4})/)[1];
    return { vendor: 'Payroll', suggested_name: `Payroll Summary ${y}`, date: `${y}-12-31`,
      doc_type: 'Payroll Summary', category: 'Expenses', tags: ['Payroll'], confidence: 0.95 };
  }
  if (/-csr-\d|paypal/i.test(f) && f.endsWith('.csv')) {
    return { vendor: 'PayPal', suggested_name: 'PayPal Transaction Report', doc_type: 'Report',
      category: 'Reports', tags: [], confidence: 0.9 };
  }

  for (const iss of ISSUERS) {
    if (!iss.re.test(text)) continue;
    const acct = last4(text);
    const date = statementEndDate(text);
    let p = iss.products.find((x) => x.re.test(text)) || iss.fallback;
    // confidence is high only when we have both a product match and a date
    const matchedProduct = iss.products.some((x) => x.re.test(text));
    const confidence = matchedProduct && date ? 0.9 : date ? 0.8 : 0.5;
    return {
      vendor: iss.vendor, institution: iss.institution, account: acct, date,
      doc_type: 'Statement', category: p.category, tags: p.tags,
      base_name: p.name, confidence,
    };
  }
  return null;
}

// --- Claude fallback --------------------------------------------------------
const SCHEMA = {
  type: 'object',
  properties: {
    vendor: { type: 'string', description: 'Issuer/company, e.g. "Chase", "Wells Fargo", "PG&E"' },
    date: { type: 'string', description: 'Most relevant date as YYYY-MM-DD (statement close date, invoice date, etc.) or empty' },
    account: { type: 'string', description: 'Last 4 of account/card if present, else empty' },
    doc_type: { type: 'string', description: 'e.g. Statement, Invoice, Receipt, Notice, Report, Payroll Summary' },
    category: { type: 'string', enum: ['Banking','Expenses','Income','Reports','Medical','Legal','Utilities','Personal','Reference','Support Documents'] },
    tags: { type: 'array', items: { type: 'string' } },
    suggested_name: { type: 'string', description: 'Human filename WITHOUT extension, e.g. "Chase Business Complete Checking 0360 2025-01-31"' },
    confidence: { type: 'number', description: '0..1 how sure you are' },
  },
  required: ['vendor', 'doc_type', 'category', 'suggested_name', 'confidence'],
};

async function askClaude(model, { text, filename, pdfBytes, imageBytes, imageMediaType }) {
  const sys = 'You classify a business/financial document for filing. Return ONLY the classify tool call. '
    + 'vendor: use the MOST SPECIFIC issuer/brand actually named anywhere in the document (e.g. "Kaiser Permanente", "Chase", "PG&E"). '
    + 'Only use a generic label (e.g. "Medical Provider") if NO issuer name appears anywhere in the text. '
    + 'date: the single most relevant date (statement close / invoice / appointment date) as YYYY-MM-DD, else empty. '
    + 'suggested_name: a clean, human, descriptive filename WITHOUT extension, leading with the vendor when known. '
    + 'When the input is a photo or scan, read the document shown in it. If the input is genuinely not a '
    + 'financial or business record, classify it honestly (category Reference or Support Documents) with a '
    + 'descriptive name rather than forcing it into Banking or Expenses.';
  const content = [];
  content.push({ type: 'text', text: `Filename: ${filename}` });
  if (text && text.trim()) {
    content.push({ type: 'text', text: 'Document text follows:\n\n' + text.slice(0, 60_000) });
  } else if (imageBytes) {
    content.push({ type: 'image', source: { type: 'base64', media_type: imageMediaType, data: imageBytes.toString('base64') } });
  } else if (pdfBytes) {
    content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBytes.toString('base64') } });
  }
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': CFG.anthropic.key,
      'anthropic-version': CFG.anthropic.version,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model, max_tokens: 1024, system: sys,
      tools: [{ name: 'classify', description: 'Return the document classification.', input_schema: SCHEMA }],
      tool_choice: { type: 'tool', name: 'classify' },
      messages: [{ role: 'user', content }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
  const data = await res.json();
  if (data.stop_reason === 'refusal') return { needs_review: true, reason: 'model refusal' };
  const tool = (data.content || []).find((c) => c.type === 'tool_use');
  if (!tool) return { needs_review: true, reason: 'no tool_use returned' };
  return tool.input;
}

/**
 * A title from the uploader's note. Only used where nothing can be read from the file
 * itself — a camera filename like PXL_20260820_200837367 carries no meaning, while
 * "Caden testimonial" in the note box does. First line only, since notes are prose.
 */
export function titleFromNote(note) {
  if (!note) return null;
  let t = String(note).split(/\r?\n/)[0].replace(/\s+/g, ' ').trim();
  t = t.replace(/[.!?,;:]+$/, '');
  if (t.length > 100) t = t.slice(0, 100).replace(/\s+\S*$/, ''); // clip on a word boundary
  return t.length >= 3 ? t : null;
}

/**
 * Media (video/audio) is filed, never classified: there is nothing to read. The title
 * comes from the uploader's note when there is one, else the client's own filename.
 * `noteShared` is set when the same note covers several files in one upload, in which
 * case the filename is kept as a discriminator so the rows stay tellable apart.
 */
export function classifyStored(filename, note = null, noteShared = false) {
  const stem = String(filename || 'Media').replace(/\.[^.]+$/, '').trim() || 'Media';
  const fromNote = titleFromNote(note);
  const suggested_name = fromNote ? (noteShared ? `${fromNote} ${stem}` : fromNote) : stem;
  return {
    vendor: 'Media', doc_type: 'Media', category: 'Reference',
    tags: ['Media'], suggested_name, confidence: 1, stored_only: true,
    title_from: fromNote ? 'note' : 'filename',
  };
}

export async function classifyDoc({ text, filename, pdfBytes, imageBytes, imageMediaType }) {
  const det = deterministic(text, filename);
  if (det && det.confidence >= CFG.minConfidence) return det;

  const input = { text, filename, pdfBytes, imageBytes, imageMediaType };
  let out = await askClaude(CFG.anthropic.model, input);
  if (out.needs_review) return out;
  if ((out.confidence ?? 0) < CFG.minConfidence) {
    const better = await askClaude(CFG.anthropic.escalateModel, input);
    if (!better.needs_review) out = better;
  }
  if ((out.confidence ?? 0) < CFG.minConfidence) return { needs_review: true, reason: `low confidence ${out.confidence}` };
  return out;
}
