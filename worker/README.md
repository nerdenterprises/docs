# Clean Documents — Cloud Run worker

The unattended engine. Given a `run_id` (or none), it drains `public.jobs`,
processing one file at a time:

```
download (Supabase Storage) → extract text (pdftotext → qpdf-decrypt → ocrmypdf → Claude PDF)
→ classify (deterministic rules → claude-haiku-4-5 → claude-sonnet-5) → rename
→ upload to Google Drive (owner's own Drive, anyone-with-link reader) → capture share link
→ write Notion row (buildPageProperties enforces Member + Drive link + "Claude" tag)
→ mark submission processed → finalize job
```

Concurrent instances are safe: `claim_next_job()` uses `FOR UPDATE SKIP LOCKED`.
A file that no path can read, or a low-confidence classification, becomes
`needs_review` instead of a bad row.

## Files
- `index.mjs` — HTTP server (`POST /run`, `GET /health`) + drain loop + per-file pipeline
- `extract.mjs` — extraction cascade (native binaries in the image)
- `classify.mjs` — deterministic rules + Claude fallback (strict tool-schema output)
- `rename.mjs` — filename convention
- `drive.mjs` — refresh-token auth, folder resolve/create, upload, share link
- `notion.mjs` — `buildPageProperties()` invariants + page create + member resolve
- `supa.mjs` — Supabase REST/RPC/Storage (service role)
- `config.mjs` — env + workspace constants

## Deploy
1. Finish `../SETUP.md` (Google refresh token, Notion token, keys).
2. From this directory, with `gcloud auth login` done and env vars exported:
   ```bash
   export GCP_PROJECT=your-project-id
   export SUPABASE_URL=https://dyyvegcsejdkzysuzwfh.supabase.co
   export SUPABASE_SERVICE_ROLE_KEY=...            # from Supabase dashboard
   export GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... GOOGLE_REFRESH_TOKEN=...
   export NOTION_TOKEN=ntn_... ANTHROPIC_API_KEY=sk-ant-...
   export WORKER_SHARED_SECRET="$(openssl rand -hex 32)"
   bash deploy.sh
   ```
3. Store `worker_url` (the printed URL + `/run`) and `worker_shared_secret`
   (same value) in `public.app_secrets` — the deploy script prints the exact SQL.

## Local smoke test
```bash
# with the same env vars exported:
node index.mjs
curl -s localhost:8080/health           # -> ok
curl -s -XPOST localhost:8080/run -H "x-worker-secret: $WORKER_SHARED_SECRET" -d '{}'
```
