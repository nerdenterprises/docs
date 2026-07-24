// Clean Documents worker (Cloud Run). POST /run drains the job queue, processing
// one file at a time (safe under concurrent instances via claim_next_job SKIP LOCKED).
// Every step reuses the modules; the drift conventions live in notion.buildPageProperties.
import http from 'node:http';
import { CFG } from './config.mjs';
import * as supa from './supa.mjs';
import * as drive from './drive.mjs';
import * as notion from './notion.mjs';
import { extractText } from './extract.mjs';
import { classifyDoc } from './classify.mjs';
import { buildName } from './rename.mjs';

const extOf = (name) => (name.split('.').pop() || 'pdf').toLowerCase();

async function processOne(job) {
  const client = await supa.getClient(job.client_slug);
  if (!client) throw new Error(`Unknown client_slug ${job.client_slug}`);

  const bytes = await supa.downloadObject(job.file_path);
  const ext = extOf(job.original_filename || job.file_path);

  const { text, method, pdfBytes } = await extractText(bytes, ext);
  const cls = await classifyDoc({ text, filename: job.original_filename, pdfBytes });
  if (cls.needs_review) {
    await supa.finalizeJob(job.job_id, 'needs_review', { reason: cls.reason, method }, null);
    return 'needs_review';
  }

  const fileName = buildName(cls, ext);
  const title = fileName.replace(/\.[^.]+$/, '');

  // Drive: resolve/create folder (cache it), upload, capture share link.
  let processedId = client.drive_processed_folder_id;
  if (!processedId) {
    const r = await drive.resolveProcessedFolder(client);
    processedId = typeof r === 'string' ? r : r.processed;
    const patch = { drive_processed_folder_id: processedId };
    if (typeof r !== 'string' && r.clientFolder && !client.drive_folder_id) patch.drive_folder_id = r.clientFolder;
    await supa.patchClient(client.slug, patch);
  }
  const mime = ext === 'csv' ? 'text/csv' : ext === 'pdf' ? 'application/pdf' : 'application/octet-stream';
  const { id: driveId, webViewLink } = await drive.uploadFile(processedId, fileName, bytes, mime);

  // Notion: resolve member (cache it), then the single enforced writer.
  let memberPageId = client.notion_member_page_id;
  if (!memberPageId) {
    memberPageId = await notion.resolveMemberPageId(client.display_name || client.name);
    await supa.patchClient(client.slug, { notion_member_page_id: memberPageId });
  }
  const props = notion.buildPageProperties({
    title, docFileName: fileName, isoDate: cls.date || null, driveLink: webViewLink,
    memberPageId, category: cls.category, tags: cls.tags, institution: cls.institution,
  });
  const notionPageId = await notion.createDocumentRow(props);

  await supa.markSubmissionProcessed(job.submission_id);
  await supa.finalizeJob(job.job_id, 'done', {
    vendor: cls.vendor, date: cls.date || null, renamed: fileName,
    drive_id: driveId, drive_link: webViewLink, notion_page_id: notionPageId, method,
  }, null);
  return 'done';
}

async function drain(runId) {
  const counts = { done: 0, error: 0, needs_review: 0 };
  for (;;) {
    const job = await supa.claimNextJob(runId);
    if (!job) break;
    try {
      const outcome = await processOne(job);
      counts[outcome] = (counts[outcome] || 0) + 1;
    } catch (e) {
      counts.error++;
      console.error(`job ${job.job_id} (${job.original_filename}) failed:`, e.message);
      try { await supa.finalizeJob(job.job_id, 'error', null, String(e.message).slice(0, 2000)); } catch {}
    }
  }
  return counts;
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200); res.end('ok'); return;
  }
  if (req.method !== 'POST' || !req.url.startsWith('/run')) {
    res.writeHead(404); res.end('not found'); return;
  }
  if (req.headers['x-worker-secret'] !== CFG.workerSecret) {
    res.writeHead(401); res.end('unauthorized'); return;
  }
  let body = '';
  for await (const chunk of req) body += chunk;
  let runId = null;
  try { runId = JSON.parse(body || '{}').run_id || null; } catch {}
  try {
    const counts = await drain(runId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, run_id: runId, ...counts }));
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: e.message }));
  }
});

const port = Number(process.env.PORT || 8080);
server.listen(port, () => console.log(`clean-documents worker listening on :${port}`));
