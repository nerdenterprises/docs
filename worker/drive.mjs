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

/** Upload bytes as a new file; return {id, webViewLink} with anyone-with-link reader access. */
export async function uploadFile(folderId, filename, bytes, mime = 'application/pdf') {
  const tok = await accessToken();
  const boundary = 'clean-docs-' + Buffer.from(filename).toString('hex').slice(0, 16);
  const meta = JSON.stringify({ name: filename, parents: [folderId] });
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
  const { id } = await up.json();

  // Anyone-with-the-link reader (matches existing behavior).
  await api(`files/${id}/permissions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'reader', type: 'anyone' }),
  });

  const got = await api(`files/${id}?fields=webViewLink`);
  return { id, webViewLink: got.webViewLink };
}
