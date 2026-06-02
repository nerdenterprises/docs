// Shared helpers for the processing pipeline scripts.
// Dependency-free: uses Node's built-in fetch + process.loadEnvFile (Node 20.12+).
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

const envPath = join(ROOT_DIR, ".env");
if (existsSync(envPath)) process.loadEnvFile(envPath);

export const SUPABASE_URL = process.env.SUPABASE_URL || "https://dyyvegcsejdkzysuzwfh.supabase.co";
export const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
export const BUCKET = process.env.SUPABASE_BUCKET || "client-docs";

if (!SERVICE_KEY) {
  console.error(
    "\n❌ Missing SUPABASE_SERVICE_ROLE_KEY.\n" +
    "   Copy .env.example to .env (repo root) and paste your service_role key.\n" +
    "   Get it from: Supabase Dashboard -> Project Settings -> API -> service_role secret.\n"
  );
  process.exit(1);
}

export function headers(extra = {}) {
  return { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, ...extra };
}

// Encode each path segment but keep the slashes between folders.
export function encodePath(p) {
  return p.split("/").map(encodeURIComponent).join("/");
}

// PostgREST query against the submissions table.
export async function querySubmissions(qs) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/submissions?${qs}`, { headers: headers() });
  const body = await res.json();
  if (!res.ok) throw new Error(`submissions query failed (${res.status}): ${JSON.stringify(body)}`);
  return body;
}

export async function patchSubmission(id, patch) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/submissions?id=eq.${id}`, {
    method: "PATCH",
    headers: headers({ "Content-Type": "application/json", Prefer: "return=minimal" }),
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`status update failed for ${id} (${res.status})`);
}

export async function downloadObject(filePath) {
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${encodePath(filePath)}`, { headers: headers() });
  if (!res.ok) throw new Error(`download failed for ${filePath} (${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}
