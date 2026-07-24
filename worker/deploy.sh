#!/usr/bin/env bash
# One-time (then re-runnable) deploy of the Clean Documents worker to Cloud Run.
# Run from the worker/ directory, authenticated as the owner:  gcloud auth login
set -euo pipefail

PROJECT="${GCP_PROJECT:?set GCP_PROJECT to your Google Cloud project id}"
REGION="${GCP_REGION:-us-central1}"
SERVICE="clean-documents-worker"

gcloud config set project "$PROJECT"
gcloud services enable run.googleapis.com cloudbuild.googleapis.com secretmanager.googleapis.com

# --- 1) Create secrets ONCE (skip any that already exist). Values come from SETUP.md. ---
create_secret () {  # name value
  if ! gcloud secrets describe "$1" >/dev/null 2>&1; then
    printf '%s' "$2" | gcloud secrets create "$1" --data-file=- --replication-policy=automatic
  else
    printf '%s' "$2" | gcloud secrets versions add "$1" --data-file=-
  fi
}
# Fill these in your shell env before running, or edit here:
create_secret SUPABASE_URL                "${SUPABASE_URL:?}"
create_secret SUPABASE_SERVICE_ROLE_KEY   "${SUPABASE_SERVICE_ROLE_KEY:?}"
create_secret GOOGLE_CLIENT_ID            "${GOOGLE_CLIENT_ID:?}"
create_secret GOOGLE_CLIENT_SECRET        "${GOOGLE_CLIENT_SECRET:?}"
create_secret GOOGLE_REFRESH_TOKEN        "${GOOGLE_REFRESH_TOKEN:?}"
create_secret NOTION_TOKEN                "${NOTION_TOKEN:?}"
create_secret ANTHROPIC_API_KEY           "${ANTHROPIC_API_KEY:?}"
create_secret WORKER_SHARED_SECRET        "${WORKER_SHARED_SECRET:?}"

# --- 2) Build + deploy. Scale-to-zero, long timeout for big batches. ---
# Network is open but /run is gated by WORKER_SHARED_SECRET (a Supabase edge fn
# and Cloud Scheduler both call it with that header; a Google OIDC token would be
# awkward to mint from Deno). Keep WORKER_SHARED_SECRET long and random.
gcloud run deploy "$SERVICE" \
  --source . \
  --region "$REGION" \
  --allow-unauthenticated \
  --timeout 3600 \
  --cpu 1 --memory 1Gi \
  --max-instances 3 \
  --set-secrets "SUPABASE_URL=SUPABASE_URL:latest,SUPABASE_SERVICE_ROLE_KEY=SUPABASE_SERVICE_ROLE_KEY:latest,GOOGLE_CLIENT_ID=GOOGLE_CLIENT_ID:latest,GOOGLE_CLIENT_SECRET=GOOGLE_CLIENT_SECRET:latest,GOOGLE_REFRESH_TOKEN=GOOGLE_REFRESH_TOKEN:latest,NOTION_TOKEN=NOTION_TOKEN:latest,ANTHROPIC_API_KEY=ANTHROPIC_API_KEY:latest,WORKER_SHARED_SECRET=WORKER_SHARED_SECRET:latest"

URL="$(gcloud run services describe "$SERVICE" --region "$REGION" --format='value(status.url)')"
echo
echo "Worker deployed at: $URL"
echo
echo "Next, store the URL + shared secret in Supabase so the enqueue function can reach it:"
echo "  insert into public.app_secrets(key,value) values"
echo "    ('worker_url','$URL/run'),"
echo "    ('worker_shared_secret','<same WORKER_SHARED_SECRET>')"
echo "  on conflict (key) do update set value=excluded.value, updated_at=now();"
