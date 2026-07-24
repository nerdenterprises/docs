# Nerd Enterprises — Client Document Intake

A replicable, no-backend system for collecting documents from clients.
Each client gets a personal, branded upload form at
`https://docs.nerdenterprises.com/<client-slug>/` that uploads files straight
into a private Supabase Storage bucket. A scheduled Cowork pipeline then pulls
new files down, files them in Notion + Google Drive, and marks the originals
processed.

## Architecture

```
Client browser ──upload──▶ Supabase Storage (bucket: client-docs, folder: <slug>/)
   (static form)           Supabase table:   public.submissions  (the work queue)
                                   │
                                   ▼
                 Cowork (scheduled) ── queries submissions ──▶ downloads files
                                   ├─▶ Notion task (file paths / Drive links)
                                   └─▶ marks submissions.status = processed
```

- **No backend of ours.** Supabase *is* the backend. The form is pure static
  HTML/JS hosted on GitHub Pages.
- **Security model:** the form uses Supabase's *publishable* key, which is
  **insert-only**. Row-Level Security forbids the public key from reading,
  listing, updating, or deleting anything. Clients can drop files in; only the
  service role (Cowork via MCP) can read them back out. The key in `config.js`
  is therefore safe to commit and serve publicly.

## Repo layout

| Path | Purpose |
|------|---------|
| `config.js` | Public Supabase URL + publishable key + bucket name |
| `assets/app.js` | Shared upload logic (Supabase JS SDK) |
| `assets/styles.css` | Shared styling |
| `index.html` | Generic landing page (no client list exposed) |
| `<slug>/index.html` | A client's personal upload form |
| `tools/templates/client-index.html` | Template the generator stamps |
| `tools/new-client.mjs` | **Create New Form** generator |
| `CNAME` | Custom domain for GitHub Pages |

## Create a new client form

```bash
node tools/new-client.mjs "Acme Holdings, Inc."
# → creates /acme-holdings-inc/, commits, pushes
# → live at https://docs.nerdenterprises.com/acme-holdings-inc/
```

Options:
- `--slug acme` — set a custom (shorter) slug.
- `--no-push` — scaffold only; commit/push yourself.

The client's Supabase folder is created automatically on their first upload —
nothing else to provision.

## Supabase project

- Project: **Client Docs Intake** (`dyyvegcsejdkzysuzwfh`), region `us-east-1`
- Bucket: `client-docs` (private, 100 MB/file)
- Tables: `public.submissions` (work queue), `public.clients` (registry)

## Processing pipeline (Cowork)

Tracked in the Notion **Client Document Intake** database
(`Status`: New → Downloaded → Renamed → Filed → Processed). Files for a client
land in Google Drive under `Client Documents/<Client>/`; lifecycle is tracked by
Notion status (no separate Processing/Permanent folders).

Setup once: copy `.env.example` → `.env` and paste the Supabase `service_role`
key (needed to download files; gitignored).

| # | Trigger | Command / action |
|---|---------|------------------|
| 3 | Scheduled (a few×/day) | `node tools/pull.mjs` downloads new files to `inbox/<client>/`, marks `downloaded`, writes `inbox/_last-pull.json`; Cowork ensures the client's Drive folder and creates a Notion row per file (Downloaded). |
| 4 | You: "process" | For each file Cowork: reads it → renames `[Vendor] [YYYY-MM-DD] [Amount].ext` (descriptive fallback for non-financial docs, e.g. USPS notices) → **moves it into the local Drive folder** `G:\My Drive\Nerd Enterprises, Inc\Client Documents\<Client>\` (Drive for Desktop syncs it up automatically — no drag) → sets Notion `Renamed As` + `Drive Link` + status `Processed` → `tools/mark-processed.mjs <id>` marks the Supabase original processed (kept as backup). |

> **Auto-Drive note:** filing is done by *moving* the file into the mounted Drive folder, not by uploading bytes through the connector (`create_file` needs inline base64 — impractical for large PDFs). Requires Google Drive for Desktop.

Scripts:
- `tools/pull.mjs` — pull new files + manifest (`--dry` to preview).
- `tools/mark-processed.mjs` — mark originals processed (by id, or `--client <slug>`).
- `tools/lib.mjs` — shared helpers (dependency-free; Node 20.12+).

## Automated processing (the "Clean Documents" app)

The manual Cowork step above is superseded by a standalone, unattended pipeline
you trigger from the admin panel (**Process ALL** / per-client **Process**) — no
Claude Code, no permission prompts. See **[SETUP.md](SETUP.md)** (one-time keys)
and **[worker/README.md](worker/README.md)** (deploy).

```
Admin panel (Google login)  ──▶  process-enqueue (Supabase Edge Fn, verifies admin/cron)
     │ polls job_runs                    │ enqueue_run() → public.jobs (durable queue), returns 202
     ▼                                   ▼  fire-and-forget
 live progress                    Cloud Run worker (Node + poppler/qpdf/ocrmypdf)
                                         └ per file: extract → classify (rules→Claude)
                                            → rename → Drive upload + share link
                                            → Notion row → mark submission processed
 Cloud Scheduler ──(a few×/day, x-cron-secret)──▶ process-enqueue (mode=all)
```

**Conventions are code, not habit (this is the anti-drift guarantee).**
`worker/notion.mjs` → `buildPageProperties()` is the *only* way a Notion row is
written, and it hard-enforces, every time:
- **🎭 Member** relation (fails the file to `needs_review` rather than writing an empty relation);
- **Documents** = the Google Drive share link (external file);
- **Tags** always include **"Claude"**.

Pieces:
| Path | Role |
|------|------|
| `supabase/functions/process-enqueue/` | Authenticated trigger; queues jobs, kicks worker |
| `worker/` | Cloud Run container: extract → classify → file → log → mark processed |
| `tools/mint-drive-token.mjs` | One-time Google Drive refresh-token minter |
| DB: `jobs`, `job_runs`, `claim_next_job()`, `enqueue_run()`, `finalize_job()` | Durable queue + progress |

Classification: deterministic account→vendor rules first (free/instant), then
`claude-haiku-4-5` → `claude-sonnet-5` for unknown/low-confidence docs; scanned/
encrypted PDFs go pdftotext → qpdf-decrypt → ocrmypdf → Claude-PDF as a last resort.
