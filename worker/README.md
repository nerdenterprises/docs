# Clean Documents — Cloud Run worker

The unattended engine. Given a `run_id` (or none), it drains `public.jobs`,
processing one file at a time:

```
download (Supabase Storage) → extract (by CONTENT, not extension — see below)
→ classify (deterministic rules → claude-haiku-4-5 → claude-sonnet-5) → rename
→ upload to Google Drive (owner's own Drive, anyone-with-link reader) → capture share link
→ write Notion row (buildPageProperties enforces Member + Drive link + "Claude" tag)
→ mark submission processed → finalize job
```

Concurrent instances are safe: `claim_next_job()` uses `FOR UPDATE SKIP LOCKED`.
A file that no path can read, or a low-confidence classification, becomes
`needs_review` instead of a bad row.

## Supported uploads

Type is decided by **magic bytes, never the extension** — clients rename things,
and posting a non-PDF to Claude's document endpoint is a 400 that kills the job.

| Input | How it's read |
|---|---|
| `.pdf` | `pdftotext` → `qpdf --decrypt` (empty-password statements) → `ocrmypdf` → Claude document input |
| `.xlsx` `.xlsm` | flattened to TSV locally (`xlsx.mjs`) |
| `.docx` | paragraphs + table rows, plus footnotes/endnotes (`ooxml.mjs`) |
| `.pptx` | per-slide text, tables, and speaker notes (`ooxml.mjs`) |
| `.csv` `.tsv` `.txt` `.md` `.json` `.log` | read as-is |
| `.ofx` `.qfx` `.qbo` `.qif` | read as-is (bank/accounting downloads) |
| `.eml` | read as-is (forwarded receipts) |
| `.html` `.htm` | tags stripped (saved order confirmations) |
| `.rtf` | control words stripped |
| `.png` `.jpg` `.gif` `.webp` | Claude image input; EXIF-rotated and downscaled only when needed |
| `.heic` `.bmp` | converted to JPEG first (ImageMagick, `heif-convert` fallback) |
| `.tiff` | converted to **PDF** so multi-page faxes/scans OCR whole, then the PDF cascade |
| `.docx`/`.pptx`/`.xlsx` wrapping a scan | if the text is too thin, the largest embedded raster is read as an image |
| video / audio (`.mp4` `.mov` `.mp3` …) | **stored, never classified** — see below |

**The store lane.** Media has no fields to extract, and the client's own filename is
the best title it will ever have, so it skips extraction and the LLM entirely and is
filed under category `Reference` with a `Media` tag. This is what makes video
testimonials work without burning tokens on frames we can't read anyway.

**Deliberate dead ends** — these finish as `needs_review` with an actionable reason
rather than a filename guess: legacy binary Office (`.doc`/`.xls`/`.ppt` — needs
LibreOffice, ~500MB in the image), Apple iWork files, zip archives, and PDFs with no
text layer that exceed the API's 20MB/100-page direct-read limits.

## Files
- `index.mjs` — HTTP server (`POST /run`, `GET /health`) + drain loop + per-file pipeline
- `extract.mjs` — content sniffing + the extraction cascade (native binaries in the image)
- `ooxml.mjs` — shared zip/XML reader; `.docx` and `.pptx` text; embedded-media lookup
- `xlsx.mjs` — `.xlsx`/`.xlsm` → TSV (sheet order, shared strings, date formats)
- `images.mjs` — normalize to what Claude's vision input takes; TIFF → PDF
- `sh.mjs` — run a native tool, never throw (the cascade depends on trying the next thing)
- `classify.mjs` — deterministic rules + Claude fallback (strict tool-schema output)
- `rename.mjs` — filename convention
- `drive.mjs` — refresh-token auth, folder resolve/create, upload (multipart ≤5MB,
  resumable above that), share link
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
