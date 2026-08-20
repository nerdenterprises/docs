// Supabase REST + Storage helpers (service_role, dependency-free fetch).
import { CFG } from './config.mjs';

const base = CFG.supabaseUrl.replace(/\/$/, '');
const H = {
  apikey: CFG.serviceRole,
  Authorization: `Bearer ${CFG.serviceRole}`,
  'Content-Type': 'application/json',
};

async function rest(path, init = {}) {
  const res = await fetch(`${base}${path}`, { ...init, headers: { ...H, ...(init.headers || {}) } });
  if (!res.ok) throw new Error(`Supabase ${init.method || 'GET'} ${path} -> ${res.status}: ${await res.text()}`);
  return res;
}

/** Atomically claim one queued job (optionally within a run). Returns null when drained. */
export async function claimNextJob(runId = null) {
  const res = await rest('/rest/v1/rpc/claim_next_job', {
    method: 'POST',
    body: JSON.stringify({ p_run_id: runId }),
  });
  const rows = await res.json();
  return rows[0] || null;
}

export async function finalizeJob(jobId, status, result = null, error = null) {
  await rest('/rest/v1/rpc/finalize_job', {
    method: 'POST',
    body: JSON.stringify({ p_job_id: jobId, p_status: status, p_result: result, p_error: error }),
  });
}

export async function getClient(slug) {
  const res = await rest(`/rest/v1/clients?slug=eq.${encodeURIComponent(slug)}&select=*`);
  return (await res.json())[0] || null;
}

export async function patchClient(slug, patch) {
  await rest(`/rest/v1/clients?slug=eq.${encodeURIComponent(slug)}`, {
    method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(patch),
  });
}

/** Checkpoint partial progress on a job (drive_id, notion_page_id, cls, …) for idempotent retries. */
export async function patchJobResult(jobId, result) {
  await rest(`/rest/v1/jobs?id=eq.${jobId}`, {
    method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ result }),
  });
}

export async function markSubmissionProcessed(id) {
  await rest(`/rest/v1/submissions?id=eq.${id}`, {
    method: 'PATCH', headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ status: 'processed', processed_at: new Date().toISOString() }),
  });
}

/** The uploader's note for one submission (claim_next_job doesn't carry it). */
export async function getSubmissionNote(id) {
  const res = await rest(`/rest/v1/submissions?id=eq.${encodeURIComponent(id)}&select=note`);
  return (await res.json())[0]?.note || null;
}

/** True when the same note covers more than one file — so it can't be a unique title. */
export async function noteIsShared(clientSlug, note) {
  const res = await rest(`/rest/v1/submissions?client_slug=eq.${encodeURIComponent(clientSlug)}`
    + `&note=eq.${encodeURIComponent(note)}&select=id&limit=2`);
  return (await res.json()).length > 1;
}

/** Fetch multiple submissions by id (for combine). */
export async function getSubmissions(ids) {
  const list = ids.map(encodeURIComponent).join(',');
  const res = await rest(`/rest/v1/submissions?id=in.(${list})&select=id,file_path,original_filename,created_at`);
  return await res.json();
}

/** Record a combined document. */
export async function insertCombinedDoc(row) {
  const res = await rest('/rest/v1/combined_docs', {
    method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify(row),
  });
  return (await res.json())[0];
}

/** Download a Storage object as a Buffer. */
export async function downloadObject(filePath) {
  const res = await fetch(
    `${base}/storage/v1/object/${CFG.bucket}/${filePath.split('/').map(encodeURIComponent).join('/')}`,
    { headers: { apikey: CFG.serviceRole, Authorization: `Bearer ${CFG.serviceRole}` } },
  );
  if (!res.ok) throw new Error(`Storage download ${filePath} -> ${res.status}: ${await res.text()}`);
  return Buffer.from(await res.arrayBuffer());
}
