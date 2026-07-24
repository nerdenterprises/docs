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
import { combineDocs } from './combine.mjs';

const extOf = (name) => (name.split('.').pop() || 'pdf').toLowerCase();

async function processOne(job) {
  const client = await supa.getClient(job.client_slug);
  if (!client) throw new Error(`Unknown client_slug ${job.client_slug}`);
  const ext = extOf(job.original_filename || job.file_path);
  const result = { ...(job.result || {}) }; // resume from any checkpointed progress

  // --- 1. classify (checkpointed): skip re-extraction/LLM on retry ---
  if (!result.cls) {
    const bytes = await supa.downloadObject(job.file_path);
    const { text, method, pdfBytes } = await extractText(bytes, ext);
    const cls = await classifyDoc({ text, filename: job.original_filename, pdfBytes });
    if (cls.needs_review) {
      await supa.finalizeJob(job.job_id, 'needs_review', { reason: cls.reason, method }, null);
      return 'needs_review';
    }
    result.cls = cls;
    result.method = method;
    result.renamed = buildName(cls, ext);
    await supa.patchJobResult(job.job_id, result);
  }
  const cls = result.cls;
  const fileName = result.renamed || buildName(cls, ext);
  const title = fileName.replace(/\.[^.]+$/, '');

  // --- 2. Drive upload (checkpointed): reuse the file on retry, never duplicate ---
  if (!result.drive_id) {
    let processedId = client.drive_processed_folder_id;
    if (!processedId) {
      const r = await drive.resolveProcessedFolder(client);
      processedId = typeof r === 'string' ? r : r.processed;
      const patch = { drive_processed_folder_id: processedId };
      if (typeof r !== 'string' && r.clientFolder && !client.drive_folder_id) patch.drive_folder_id = r.clientFolder;
      await supa.patchClient(client.slug, patch);
    }
    const bytes = await supa.downloadObject(job.file_path);
    const mime = ext === 'csv' ? 'text/csv' : ext === 'pdf' ? 'application/pdf' : 'application/octet-stream';
    const up = await drive.uploadFile(processedId, fileName, bytes, mime);
    result.drive_id = up.id;
    result.drive_link = up.webViewLink;
    await supa.patchJobResult(job.job_id, result);
  }

  // --- 3. Notion row (checkpointed): skip if already created ---
  if (!result.notion_page_id) {
    let memberPageId = client.notion_member_page_id;
    if (!memberPageId) {
      memberPageId = await notion.resolveMemberPageId(client.display_name || client.name);
      await supa.patchClient(client.slug, { notion_member_page_id: memberPageId });
    }
    const props = notion.buildPageProperties({
      title, docFileName: fileName, isoDate: cls.date || null, driveLink: result.drive_link,
      memberPageId, category: cls.category, tags: cls.tags, institution: cls.institution,
    });
    result.notion_page_id = await notion.createDocumentRow(props);
    await supa.patchJobResult(job.job_id, result);
  }

  // --- 4. finalize ---
  await supa.markSubmissionProcessed(job.submission_id);
  await supa.finalizeJob(job.job_id, 'done', {
    vendor: cls.vendor, date: cls.date || null, renamed: fileName,
    drive_id: result.drive_id, drive_link: result.drive_link, notion_page_id: result.notion_page_id, method: result.method,
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
  if (req.method !== 'POST') { res.writeHead(404); res.end('not found'); return; }
  if (req.headers['x-worker-secret'] !== CFG.workerSecret) {
    res.writeHead(401); res.end('unauthorized'); return;
  }
  let body = '';
  for await (const chunk of req) body += chunk;
  let payload = {};
  try { payload = JSON.parse(body || '{}'); } catch {}
  try {
    let out;
    if (req.url.startsWith('/combine')) {
      out = await combineDocs({ submissionIds: payload.submission_ids || [], clientSlug: payload.client_slug });
    } else { // /run
      const counts = await drain(payload.run_id || null);
      out = { ok: true, run_id: payload.run_id || null, ...counts };
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(out));
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: e.message }));
  }
});

const port = Number(process.env.PORT || 8080);
server.listen(port, () => console.log(`clean-documents worker listening on :${port}`));
