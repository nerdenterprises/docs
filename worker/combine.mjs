// Combine multiple uploaded PDFs (that are really one document — e.g. a scanner
// over-split) into a single PDF, file it to Drive, and log one Notion row.
// Originals are kept untouched. Uses qpdf to decrypt-then-merge.
import { execFile } from 'node:child_process';
import { writeFile, readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as supa from './supa.mjs';
import * as drive from './drive.mjs';
import * as notion from './notion.mjs';
import { extractText } from './extract.mjs';
import { classifyDoc } from './classify.mjs';
import { buildName } from './rename.mjs';

function run(cmd, args) {
  return new Promise((res) => execFile(cmd, args, { maxBuffer: 128 * 1024 * 1024 }, (e, _o, er) => res({ ok: !e, stderr: er || '' })));
}

export async function combineDocs({ submissionIds, clientSlug }) {
  const client = await supa.getClient(clientSlug);
  if (!client) throw new Error(`Unknown client ${clientSlug}`);

  const subs = (await supa.getSubmissions(submissionIds)).filter(Boolean);
  const pdfs = subs
    .filter((s) => (s.original_filename || s.file_path || '').toLowerCase().endsWith('.pdf'))
    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  if (pdfs.length < 2) throw new Error('Need at least 2 PDFs to combine');

  const dir = await mkdtemp(join(tmpdir(), 'cmb-'));
  try {
    // download + decrypt each (decrypt is a safe no-op for unencrypted files)
    const parts = [];
    for (let i = 0; i < pdfs.length; i++) {
      const bytes = await supa.downloadObject(pdfs[i].file_path);
      const raw = join(dir, `in${i}.pdf`);
      await writeFile(raw, bytes);
      const dec = join(dir, `dec${i}.pdf`);
      const q = await run('qpdf', ['--decrypt', '--password=', raw, dec]);
      parts.push(q.ok ? dec : raw);
    }

    // merge
    const out = join(dir, 'combined.pdf');
    const m = await run('qpdf', ['--empty', '--pages', ...parts, '--', out]);
    if (!m.ok) throw new Error(`qpdf merge failed: ${m.stderr.slice(0, 200)}`);
    const mergedBytes = await readFile(out);

    // classify the merged document for a coherent name
    const { text } = await extractText(mergedBytes, 'pdf');
    const cls = await classifyDoc({ text, filename: pdfs[0].original_filename, pdfBytes: mergedBytes });
    let fileName;
    if (cls.needs_review) fileName = buildName({ suggested_name: (pdfs[0].original_filename || 'Combined Document').replace(/\.[^.]+$/, ''), date: null }, 'pdf');
    else fileName = buildName(cls, 'pdf');
    const title = fileName.replace(/\.[^.]+$/, '');

    // Drive folder (reuse cache)
    let processedId = client.drive_processed_folder_id;
    if (!processedId) {
      const r = await drive.resolveProcessedFolder(client);
      processedId = typeof r === 'string' ? r : r.processed;
      await supa.patchClient(client.slug, { drive_processed_folder_id: processedId });
    }
    const up = await drive.uploadFile(processedId, fileName, mergedBytes, 'application/pdf');

    // Notion row (Member/Drive link/Claude enforced; tag as Combined)
    let memberPageId = client.notion_member_page_id;
    if (!memberPageId) {
      memberPageId = await notion.resolveMemberPageId(client.display_name || client.name);
      await supa.patchClient(client.slug, { notion_member_page_id: memberPageId });
    }
    const tags = Array.from(new Set([...(cls.tags || []), 'Combined']));
    const props = notion.buildPageProperties({
      title, docFileName: fileName, isoDate: cls.date || null, driveLink: up.webViewLink,
      memberPageId, category: cls.category, tags, institution: cls.institution,
    });
    const notionPageId = await notion.createDocumentRow(props);

    const rec = await supa.insertCombinedDoc({
      client_slug: clientSlug, source_submission_ids: pdfs.map((s) => s.id),
      renamed: fileName, drive_id: up.id, drive_link: up.webViewLink, notion_page_id: notionPageId,
    });
    return { ok: true, renamed: fileName, drive_link: up.webViewLink, notion_page_id: notionPageId, count: pdfs.length, id: rec?.id };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
