# Clean Documents — Automated Processing Setup (Phase 0)

These are the **one-time, human-only** steps that give the standalone processing
app its credentials. Do them once; after that the app runs unattended (no Claude
Code, no permission prompts). You can do these in parallel while the code is built.

Everything here is **single-owner** (your own Google Workspace / Notion / Supabase),
which is why there is **no Google verification, no CASA audit, and no "unverified
app" warning** — those only apply to multi-tenant External apps.

---

## 1. Google Cloud — Drive access (mint a refresh token)

1. Go to <https://console.cloud.google.com> → create/pick a project (e.g. `clean-documents`).
2. **APIs & Services → Enable APIs → enable "Google Drive API".**
3. **APIs & Services → OAuth consent screen:**
   - User type = **Internal** ← important (Workspace-only; exempts you from verification and the 7-day token expiry).
   - App name `Clean Documents`, support email = your address. Save.
4. **APIs & Services → Credentials → Create credentials → OAuth client ID:**
   - Application type = **Desktop app**, name `clean-documents-cli`.
   - Copy the **Client ID** and **Client secret**.
5. Mint the refresh token (run locally, once):
   ```bash
   # PowerShell
   $env:GOOGLE_CLIENT_ID="<client id>"; $env:GOOGLE_CLIENT_SECRET="<client secret>"; node tools/mint-drive-token.mjs
   ```
   A browser opens → approve as **seth@nerdenterprises.com** → the terminal prints
   `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`. Keep these for step 4 below.

> Scope is full `drive` so the worker can write into your **existing**
> `Client Documents/<Client>/Processed` folders. Safe because the app is Internal-only.

---

## 2. Notion — internal integration

1. <https://www.notion.so/my-integrations> → **New integration** → name `Clean Documents`,
   associated workspace = yours, capabilities = Read + Insert + Update content. Copy the
   **Internal Integration Secret** (`ntn_…`).
2. Share the databases with it: open **"Nerd's Client Documents"** → `⋯` → **Connections →
   Clean Documents**. Do the same for the **Member database** (the one holding
   PacificPenWorks, Personal – Shahnaz & Seth, etc.).
   - Data source IDs are already known to the code:
     - Documents DB data source: `5982ea20-8de0-4591-a457-6b2a9772e317`
     - Member data source: `1bcf5b24-58b4-419f-ad96-e412ab2beaf0`

---

## 3. Anthropic — API key

Use an existing key or create one at <https://console.anthropic.com> → **API Keys**.
Model used: `claude-haiku-4-5` (classification), escalating to `claude-sonnet-5` on low confidence.

---

## 4. Where each secret goes

| Secret | Lives in | Used by |
|---|---|---|
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_REFRESH_TOKEN` | GCP Secret Manager | worker (Drive upload) |
| `NOTION_TOKEN` | GCP Secret Manager | worker (Notion writes) |
| `ANTHROPIC_API_KEY` | GCP Secret Manager | worker (classification) |
| `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` | GCP Secret Manager | worker (queue + storage) |
| `WORKER_SHARED_SECRET` (any long random string) | GCP Secret Manager **and** `app_secrets` table | shared auth between edge fn ↔ worker |
| `worker_url` (Cloud Run URL, known after deploy) | `app_secrets` table | `process-enqueue` edge fn |

The `app_secrets` rows get set with a single SQL statement I'll provide after the worker is deployed.
**No secret ever lives in the static admin panel** — the browser only carries your own Google login session.

---

## 5. What you do NOT need to do
- No Google app verification / CASA (Internal app).
- No Google Picker / folder-grant dance (full `drive` scope sees the existing tree).
- No new Supabase project or plan change (reusing **Client Docs Intake**, Pro already active).
- No Lovable project (extending the existing admin panel).

Once steps 1–3 are done and you have the values, hand them to me (or paste into Secret
Manager during the worker deploy) and the pipeline goes live.
