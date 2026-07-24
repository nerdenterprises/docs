#!/usr/bin/env node
/**
 * One-time: mint a long-lived Google Drive REFRESH TOKEN for the Clean Documents
 * worker to file client documents into your own Google Drive unattended.
 *
 * You only run this ONCE. The refresh token it prints goes into the worker's
 * secrets (Google Cloud Secret Manager). Because the OAuth app is user-type
 * "Internal" on your Workspace, the token does NOT expire on a 7-day clock and
 * needs no Google verification/CASA.
 *
 * Prereq (see SETUP.md): a Google Cloud OAuth client of type "Desktop app",
 * Drive API enabled, consent screen user-type = Internal.
 *
 * Usage (PowerShell):
 *   $env:GOOGLE_CLIENT_ID="....apps.googleusercontent.com"
 *   $env:GOOGLE_CLIENT_SECRET="GOCSPX-...."
 *   node tools/mint-drive-token.mjs
 *
 * It opens a local page, you approve in the browser, and it prints the tokens.
 */
import http from 'node:http';
import { URL } from 'node:url';
import { exec } from 'node:child_process';

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID || process.argv[2];
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || process.argv[3];
const PORT = 53682;
const REDIRECT = `http://127.0.0.1:${PORT}`;
// Full drive scope: lets the worker see/write your EXISTING "Client Documents"
// tree (drive.file could only see files it created). Safe here because the app
// is Internal-only. Swap to ".../auth/drive.file" if you ever want least-privilege.
const SCOPE = 'https://www.googleapis.com/auth/drive';

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('Missing GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET.');
  console.error('Set them as env vars (see the header of this file) and re-run.');
  process.exit(1);
}

const authUrl =
  'https://accounts.google.com/o/oauth2/v2/auth?' +
  new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT,
    response_type: 'code',
    scope: SCOPE,
    access_type: 'offline',
    prompt: 'consent', // force a refresh_token every time
  }).toString();

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, REDIRECT);
  const code = u.searchParams.get('code');
  const err = u.searchParams.get('error');
  if (err) {
    res.end(`Authorization failed: ${err}. You can close this tab.`);
    console.error('Authorization error:', err);
    server.close();
    process.exit(1);
  }
  if (!code) { res.end('Waiting for Google authorization…'); return; }

  try {
    const tok = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        redirect_uri: REDIRECT,
        grant_type: 'authorization_code',
      }),
    }).then((r) => r.json());

    if (!tok.refresh_token) {
      throw new Error(
        'No refresh_token returned. Revoke prior access at ' +
        'https://myaccount.google.com/permissions and re-run (prompt=consent is set).\n' +
        JSON.stringify(tok, null, 2)
      );
    }

    res.setHeader('Content-Type', 'text/html');
    res.end('<h2>✅ Done — refresh token minted.</h2><p>Return to your terminal and copy the values. You can close this tab.</p>');

    console.log('\n==================  COPY THESE INTO YOUR WORKER SECRETS  ==================\n');
    console.log('GOOGLE_CLIENT_ID     =', CLIENT_ID);
    console.log('GOOGLE_CLIENT_SECRET =', CLIENT_SECRET);
    console.log('GOOGLE_REFRESH_TOKEN =', tok.refresh_token);
    console.log('\n(access token good for ~1h, the worker refreshes it automatically:');
    console.log(' ', (tok.access_token || '').slice(0, 24) + '…)\n');
    console.log('===========================================================================\n');
    server.close();
    process.exit(0);
  } catch (e) {
    res.end('Token exchange failed: ' + e.message);
    console.error(e);
    server.close();
    process.exit(1);
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('\nOpen this URL in your browser (signed in as seth@nerdenterprises.com):\n');
  console.log(authUrl + '\n');
  // Best-effort auto-open on Windows/macOS/Linux.
  const opener =
    process.platform === 'win32' ? `start "" "${authUrl}"` :
    process.platform === 'darwin' ? `open "${authUrl}"` :
    `xdg-open "${authUrl}"`;
  exec(opener, () => {});
});
