// process-enqueue: authenticated front door for the Clean Documents pipeline.
// Verifies the caller (admin Google login OR Cloud Scheduler cron secret), atomically
// queues one job per NEW submission (all clients or one), fire-and-forgets the Cloud
// Run worker, and returns 202 immediately. Holds no third-party secrets.
//
// Deployed with verify_jwt = false because it must also accept Cloud Scheduler
// (which can't carry a Supabase user JWT); auth is enforced in-code below.
import { createClient } from "jsr:@supabase/supabase-js@2";

const ADMIN_EMAIL = "seth@nerdenterprises.com";
const ORIGIN = "https://docs.nerdenterprises.com";

const cors = {
  "Access-Control-Allow-Origin": ORIGIN,
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  // --- read shared secrets from app_secrets (service role) ---
  const { data: secretsRows } = await admin.from("app_secrets").select("key,value");
  const secrets: Record<string, string> = {};
  for (const r of secretsRows ?? []) secrets[r.key] = r.value;

  const body = await req.json().catch(() => ({}));
  const cronSecret = req.headers.get("x-cron-secret");

  // --- authenticate: cron secret OR admin Google session ---
  let trigger = "client";
  let requestedBy = "cron";
  if (cronSecret && secrets["cron_secret"] && cronSecret === secrets["cron_secret"]) {
    trigger = "cron";
  } else {
    const authz = req.headers.get("authorization") ?? "";
    const token = authz.replace(/^Bearer\s+/i, "");
    if (!token) return json({ error: "unauthorized" }, 401);
    const { data: userData, error } = await admin.auth.getUser(token);
    const email = userData?.user?.email?.toLowerCase();
    if (error || email !== ADMIN_EMAIL) return json({ error: "forbidden" }, 403);
    requestedBy = email;
    trigger = body.mode === "all" ? "all" : "client";
  }

  // --- retry a single failed/needs_review job (admin only) ---
  if (body.mode === "retry") {
    if (trigger === "cron") return json({ error: "retry requires admin" }, 403);
    if (!body.job_id) return json({ error: "job_id required" }, 400);
    const { data: jrow, error: jerr } = await admin.from("jobs")
      .update({ status: "queued", error_text: null })
      .eq("id", body.job_id).select("run_id").maybeSingle();
    if (jerr || !jrow) return json({ error: jerr?.message || "job not found" }, 404);
    const wu = secrets["worker_url"], ws = secrets["worker_shared_secret"];
    if (wu && ws) {
      const kick = fetch(wu, { method: "POST", headers: { "content-type": "application/json", "x-worker-secret": ws }, body: JSON.stringify({ run_id: jrow.run_id }) }).catch(() => {});
      // @ts-ignore EdgeRuntime is provided by Supabase
      if (typeof EdgeRuntime !== "undefined") EdgeRuntime.waitUntil(kick);
    }
    return json({ ok: true, retried: body.job_id, run_id: jrow.run_id }, 202);
  }

  // --- combine multiple uploads into one document (admin only) ---
  if (body.mode === "combine") {
    if (trigger === "cron") return json({ error: "combine requires admin" }, 403);
    if (!Array.isArray(body.submission_ids) || body.submission_ids.length < 2 || !body.client_slug) {
      return json({ error: "submission_ids (2+) and client_slug required" }, 400);
    }
    const wu = secrets["worker_url"], ws = secrets["worker_shared_secret"];
    if (!wu || !ws) return json({ error: "worker not configured" }, 500);
    const r = await fetch(wu.replace(/\/run$/, "/combine"), {
      method: "POST",
      headers: { "content-type": "application/json", "x-worker-secret": ws },
      body: JSON.stringify({ submission_ids: body.submission_ids, client_slug: body.client_slug }),
    });
    const out = await r.json().catch(() => ({ ok: false, error: `worker ${r.status}` }));
    return json(out, r.ok ? 200 : 502);
  }

  // --- mark a suggested group as "not a split" so it stops resurfacing (admin only) ---
  if (body.mode === "dismiss_split") {
    if (trigger === "cron") return json({ error: "dismiss_split requires admin" }, 403);
    if (!Array.isArray(body.submission_ids) || body.submission_ids.length < 1) {
      return json({ error: "submission_ids required" }, 400);
    }
    const { error: derr } = await admin.from("submissions")
      .update({ split_reviewed_at: new Date().toISOString() })
      .in("id", body.submission_ids);
    if (derr) return json({ error: derr.message }, 500);
    return json({ ok: true, dismissed: body.submission_ids.length });
  }

  const slug = trigger === "all" || trigger === "cron" ? null : (body.slug ?? null);
  if (trigger === "client" && !slug) return json({ error: "slug required for client mode" }, 400);

  // --- atomically queue the batch ---
  const { data: runData, error: rpcErr } = await admin.rpc("enqueue_run", {
    p_trigger: trigger, p_slug: slug, p_requested_by: requestedBy,
  });
  if (rpcErr) return json({ error: rpcErr.message }, 500);
  const run = Array.isArray(runData) ? runData[0] : runData;

  // --- kick the worker (fire-and-forget); queue is durable if this misses ---
  const workerUrl = secrets["worker_url"];
  const workerSecret = secrets["worker_shared_secret"];
  if (workerUrl && workerSecret && (run?.queued ?? 0) > 0) {
    const kick = fetch(workerUrl, {
      method: "POST",
      headers: { "content-type": "application/json", "x-worker-secret": workerSecret },
      body: JSON.stringify({ run_id: run.run_id }),
    }).catch(() => {});
    // @ts-ignore EdgeRuntime is provided by Supabase
    if (typeof EdgeRuntime !== "undefined") EdgeRuntime.waitUntil(kick);
  }

  return json({
    ok: true,
    run_id: run?.run_id ?? null,
    queued: run?.queued ?? 0,
    worker_kicked: Boolean(workerUrl && workerSecret),
  }, 202);
});
