// Google Drive filing: refresh-token auth, resolve/create folders, upload, share link.
import { CFG } from './config.mjs';

let cachedToken = null;
let cachedExp = 0;

async function accessToken() {
  const now = Date.now();
  if (cachedToken && now < cachedExp - 60_000) return cachedToken;
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CFG.google.clientId,
      client_secret: CFG.google.clientSecret,
      refresh_token: CFG.google.refreshToken,
      grant_type: 'refresh_token',
    }),
  }).then((x) => x.json());
  if (!r.access_token) throw new Error(`Drive token refresh failed: ${JSON.stringify(r)}`);
  cachedToken = r.access_token;
  cachedExp = now + (r.expires_in || 3600) * 1000;
  return cachedToken;
}

async function api(path, init = {}) {
  const tok = await accessToken();
  const res = await fetch(`https://www.googleapis.com/drive/v3/${path}`, {
    ...init, headers: { Authorization: `Bearer ${tok}`, ...(init.headers || {}) },
  });
  if (!res.ok) throw new Error(`Drive ${init.method || 'GET'} ${path} -> ${res.status}: ${await res.text()}`);
  return res.json();
}

async function findChildFolder(parentId, name) {
  const q = `name='${name.replace(/'/g, "\\'")}' and mimeType='application/vnd.google-apps.folder' `
    + `and '${parentId}' in parents and trashed=false`;
  const r = await api(`files?q=${encodeURIComponent(q)}&fields=files(id,name)&pageSize=1`);
  return r.files?.[0]?.id || null;
}

async function ensureFolder(parentId, name) {
  const found = await findChildFolder(parentId, name);
  if (found) return found;
  const r = await api('files?fields=id', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] }),
  });
  return r.id;
}

/** Resolve (and cache) the client's ".../Client Documents/<Client>/Processed" folder id. */
export async function resolveProcessedFolder(client) {
  if (client.drive_processed_folder_id) return client.drive_processed_folder_id;
  const displayName = client.display_name || client.name;
  const clientFolder = client.drive_folder_id || await ensureFolder(CFG.google.clientDocsRootId, displayName);
  const processed = await ensureFolder(clientFolder, 'Processed');
  return { processed, clientFolder };
}

// Google documents uploadType=multipart as good for 5MB or less. Above that the
// resumable endpoint is the supported path — needed for video and big scans.
const MULTIPART_MAX = 5 * 1024 * 1024;
const CHUNK = 8 * 1024 * 1024; // must be a multiple of 256KB

async function uploadMultipart(tok, meta, bytes, mime, filename) {
  const boundary = 'clean-docs-' + Buffer.from(filename).toString('hex').slice(0, 16);
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Type: ${mime}\r\n\r\n`),
    bytes,
    Buffer.from(`\r\n--${boundary}--`),
  ]);
  const up = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', {
    method: 'POST',
    headers: { Authorization: `Bearer ${tok}`, 'Content-Type': `multipart/related; boundary=${boundary}` },
    body,
  });
  if (!up.ok) throw new Error(`Drive upload -> ${up.status}: ${await up.text()}`);
  return (await up.json()).id;
}

async function uploadResumable(tok, meta, bytes, mime) {
  const start = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id', {
    method: 'POST',
    headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Type': mime, 'X-Upload-Content-Length': String(bytes.length) },
    body: meta,
  });
  if (!start.ok) throw new Error(`Drive resumable start -> ${start.status}: ${await start.text()}`);
  const session = start.headers.get('location');
  if (!session) throw new Error('Drive resumable start returned no session URL');

  for (let off = 0; off < bytes.length;) {
    const end = Math.min(off + CHUNK, bytes.length);
    const res = await fetch(session, {
      method: 'PUT',
      headers: { 'Content-Length': String(end - off),
        'Content-Range': `bytes ${off}-${end - 1}/${bytes.length}` },
      body: bytes.subarray(off, end),
    });
    if (res.status === 200 || res.status === 201) return (await res.json()).id;
    if (res.status !== 308) throw new Error(`Drive resumable chunk -> ${res.status}: ${await res.text()}`);
    // 308: Google reports how much it actually kept; continue from there.
    const range = res.headers.get('range');
    off = range ? Number(range.split('-').pop()) + 1 : end;
  }
  throw new Error('Drive resumable upload ended without a file id');
}

/** Upload bytes as a new file; return {id, webViewLink} with anyone-with-link reader access. */
export async function uploadFile(folderId, filename, bytes, mime = 'application/pdf') {
  const tok = await accessToken();
  const meta = JSON.stringify({ name: filename, parents: [folderId] });
  const id = bytes.length > MULTIPART_MAX
    ? await uploadResumable(tok, meta, bytes, mime)
    : await uploadMultipart(tok, meta, bytes, mime, filename);

  // Anyone-with-the-link reader (matches existing behavior).
  await api(`files/${id}/permissions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'reader', type: 'anyone' }),
  });

  const got = await api(`files/${id}?fields=webViewLink`);
  return { id, webViewLink: got.webViewLink };
}
