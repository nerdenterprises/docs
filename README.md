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
| 3 | Scheduled (a few×/day) | `node tools/pull.mjs` — downloads new files to `inbox/<client>/`, sets status `downloaded`, writes `inbox/_last-pull.json`. Then Cowork creates a Notion row per file from the manifest. |
| 4 | "process" | Cowork reads each file in `inbox/<client>/` and renames it `[Vendor or Name] [YYYY-MM-DD] [Amount].ext`; updates Notion `Renamed As` + status `Renamed`. |
| 5 | You | Drag `inbox/<client>/` → Drive `Client Documents/<Client>/`. |
| 6 | "add to Notion" | Cowork fetches Drive share links → updates Notion `Drive Link` + status `Filed`. |
| 7 | "done" | `node tools/mark-processed.mjs --client <slug>` — sets Supabase `status='processed'` (original kept as backup); Notion status `Processed`. |

Scripts:
- `tools/pull.mjs` — pull new files + manifest (`--dry` to preview).
- `tools/mark-processed.mjs` — mark originals processed (by id, or `--client <slug>`).
- `tools/lib.mjs` — shared helpers (dependency-free; Node 20.12+).
