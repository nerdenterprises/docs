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

/** Download a Storage object as a Buffer. */
export async function downloadObject(filePath) {
  const res = await fetch(
    `${base}/storage/v1/object/${CFG.bucket}/${filePath.split('/').map(encodeURIComponent).join('/')}`,
    { headers: { apikey: CFG.serviceRole, Authorization: `Bearer ${CFG.serviceRole}` } },
  );
  if (!res.ok) throw new Error(`Storage download ${filePath} -> ${res.status}: ${await res.text()}`);
  return Buffer.from(await res.arrayBuffer());
}
