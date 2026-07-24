// Admin dashboard logic: Google sign-in (admin-only), client list, Add New Client.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cfg = window.SUPABASE_CONFIG;
const supabase = createClient(cfg.url, cfg.anonKey);
const ADMIN_EMAIL = "seth@nerdenterprises.com";
const DOMAIN = "docs.nerdenterprises.com";
const $ = (id) => document.getElementById(id);

init();

async function init() {
  wire();
  const { data: { session } } = await supabase.auth.getSession();
  render(session);
  supabase.auth.onAuthStateChange((_e, s) => render(s));
}

function render(session) {
  const user = session?.user;
  const email = user?.email?.toLowerCase();
  hide("login"); hide("denied"); hide("dash"); $("who").hidden = true;

  if (!user) { show("login"); return; }
  if (email !== ADMIN_EMAIL) {
    $("deniedEmail").textContent = user.email;
    show("denied");
    return;
  }
  $("who").hidden = false;
  $("whoEmail").textContent = user.email;
  show("dash");
  loadClients();
  loadReview();
  loadSplits();
}

function wire() {
  $("signin").onclick = () =>
    supabase.auth.signInWithOAuth({ provider: "google", options: { redirectTo: location.href.split("#")[0] } });
  $("signout").onclick = $("signout2").onclick = () => supabase.auth.signOut();
  $("addBtn").onclick = openModal;
  $("cancel").onclick = closeModal;
  $("cname").oninput = $("cslug").oninput = updatePreview;
  $("cmember").onchange = onMemberChange;
  $("addForm").onsubmit = onCreate;
  $("editCancel").onclick = closeEdit;
  $("editForm").onsubmit = onEdit;
  $("processAllBtn").onclick = () => processDocs("all", null);
  $("progressClose").onclick = () => { $("progress").hidden = true; };
  $("clientFilter").oninput = renderClients;
  $("clientSort").onchange = renderClients;
}

// ---- document processing ----
let pollTimer = null;

async function processDocs(mode, slug) {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  showProgress(mode === "all" ? "Queuing all clients…" : `Queuing “${slug}”…`);
  try {
    const { data, error } = await supabase.functions.invoke("process-enqueue", { body: { mode, slug } });
    let payload = data;
    if (error) { try { payload = await error.context.json(); } catch { /* ignore */ } }
    if (!payload?.ok) throw new Error(payload?.error || error?.message || "Enqueue failed");
    if (!payload.queued) { finishProgress("Nothing new to process — queue is empty.", null); return; }
    if (!payload.worker_kicked) banner("banner", "Queued, but the worker isn’t deployed yet — files will process once it’s live.", "error");
    pollRun(payload.run_id);
  } catch (e) {
    finishProgress(e.message, null, true);
  }
}

function pollRun(runId) {
  const tick = async () => {
    const { data: run } = await supabase.from("job_runs").select("*").eq("id", runId).single();
    if (!run) return;
    renderProgress(run);
    if (run.status === "done") {
      clearInterval(pollTimer); pollTimer = null;
      finishProgress("✓ Done.", run);
      loadClients();
      loadReview();
      loadSplits();
    }
  };
  tick();
  pollTimer = setInterval(tick, 2500);
}

function showProgress(title) {
  $("progressTitle").textContent = title;
  $("progressStats").textContent = "";
  $("progressFill").style.width = "0%";
  $("progressClose").hidden = true;
  $("progress").hidden = false;
}
function renderProgress(run) {
  const total = run.queued_count || 0;
  const finished = (run.done_count || 0) + (run.error_count || 0) + (run.review_count || 0);
  $("progressFill").style.width = total ? `${Math.round((finished / total) * 100)}%` : "0%";
  $("progressTitle").textContent = run.status === "done" ? "✓ Processing complete" : "Processing…";
  $("progressStats").textContent =
    `${run.done_count || 0} filed · ${run.review_count || 0} need review · ${run.error_count || 0} errors · ${total} total`;
}
function finishProgress(title, run, isError) {
  $("progressTitle").textContent = (isError ? "⚠ " : "") + title;
  if (run) renderProgress(run), ($("progressTitle").textContent = title);
  $("progressClose").hidden = false;
}

// ---- needs review ----
async function loadReview() {
  const { data, error } = await supabase
    .from("jobs")
    .select("id,status,error_text,result,client_slug,created_at,submissions(original_filename)")
    .in("status", ["needs_review", "error"])
    .order("created_at", { ascending: false });

  const card = $("review"), list = $("reviewList");
  if (error || !data || data.length === 0) { card.hidden = true; return; }
  $("reviewCount").textContent = `${data.length} item${data.length === 1 ? "" : "s"}`;
  list.innerHTML = "";
  for (const j of data) {
    const fn = j.submissions?.original_filename || "(unknown file)";
    const reason = j.status === "error" ? (j.error_text || "error") : (j.result?.reason || "low confidence");
    const link = j.result?.drive_link;
    const badge = j.status === "error" ? "⛔ error" : "🔎 needs review";
    const row = document.createElement("div");
    row.className = "review-row";
    row.innerHTML = `
      <div class="review-info">
        <div class="review-name">${esc(fn)}</div>
        <div class="review-meta muted">/${esc(j.client_slug)} · ${badge} · ${esc(String(reason).slice(0, 160))}</div>
      </div>
      <div class="review-actions">
        ${link ? `<button class="btn-ghost" data-review-open="${esc(link)}">Open</button>` : ""}
        <button class="btn-ghost" data-review-retry="${esc(j.id)}">Retry</button>
      </div>`;
    list.appendChild(row);
  }
  list.querySelectorAll("[data-review-open]").forEach((b) => (b.onclick = () => window.open(b.dataset.reviewOpen, "_blank")));
  list.querySelectorAll("[data-review-retry]").forEach((b) => (b.onclick = () => retryJob(b.dataset.reviewRetry, b)));
  card.hidden = false;
}

async function retryJob(jobId, btn) {
  btn.disabled = true; btn.textContent = "Retrying…";
  try {
    const { data, error } = await supabase.functions.invoke("process-enqueue", { body: { mode: "retry", job_id: jobId } });
    let payload = data;
    if (error) { try { payload = await error.context.json(); } catch { /* ignore */ } }
    if (!payload?.ok) throw new Error(payload?.error || error?.message || "Retry failed");
    banner("banner", "↻ Retrying — this refreshes in a few seconds.", "ok");
    setTimeout(() => { loadReview(); loadClients(); }, 4000);
  } catch (e) {
    banner("banner", e.message, "error");
    btn.disabled = false; btn.textContent = "Retry";
  }
}

// ---- combine split documents ----
// A "split" is ONE document uploaded as several files, so its parts share a
// client, a detected vendor, and a statement date. We group on those structured
// signals (from jobs.result) — never on upload timing, which only says files
// arrived in the same batch, not that they're the same document. Dismissals are
// persisted server-side (submissions.split_reviewed_at) so they never resurface.
const MAX_SPLIT_GROUP = 8;

async function loadSplits() {
  const [jobsRes, comboRes] = await Promise.all([
    supabase.from("jobs")
      .select("submission_id,client_slug,created_at,result,submissions(original_filename,split_reviewed_at)")
      .eq("status", "done").order("created_at", { ascending: false }).limit(1000),
    supabase.from("combined_docs").select("source_submission_ids"),
  ]);
  const used = new Set();
  for (const c of comboRes.data || []) for (const id of c.source_submission_ids || []) used.add(id);

  // one row per submission (newest done job wins); keep only PDFs that still carry
  // both signals we group on and haven't been combined or already dismissed
  const seen = new Set();
  const byKey = new Map();
  for (const j of jobsRes.data || []) {
    const id = j.submission_id;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const sub = j.submissions || {};
    if (used.has(id) || sub.split_reviewed_at) continue;
    const name = sub.original_filename || j.result?.renamed || "";
    if (!name.toLowerCase().endsWith(".pdf")) continue;
    const vendor = (j.result?.vendor || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    const date = j.result?.date || "";
    if (!vendor || !date) continue; // can't judge a split without both
    const key = `${j.client_slug}|${vendor}|${date}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push({ id, client_slug: j.client_slug, filename: name, created_at: j.created_at });
  }

  const groups = [...byKey.values()]
    .filter((g) => g.length >= 2 && g.length <= MAX_SPLIT_GROUP)
    .map((g) => g.sort((a, b) => new Date(a.created_at) - new Date(b.created_at)));

  const card = $("splits"), list = $("splitsList");
  if (groups.length === 0) { card.hidden = true; return; }
  list.innerHTML = "";
  for (const g of groups) {
    const ids = g.map((s) => s.id);
    const names = g.map((s) => esc(s.filename)).join("<br>");
    const row = document.createElement("div");
    row.className = "review-row";
    row.innerHTML = `
      <div class="review-info">
        <div class="review-meta muted">/${esc(g[0].client_slug)} · ${g.length} files · same vendor &amp; statement date</div>
        <div class="review-name" style="font-weight:500">${names}</div>
      </div>
      <div class="review-actions">
        <button class="btn-ghost" data-split-dismiss>Not a split</button>
        <button class="btn-primary" data-split-combine>Combine into one</button>
      </div>`;
    list.appendChild(row);
    row.querySelector("[data-split-dismiss]").onclick = (e) => dismissSplit(ids, e.currentTarget, row);
    row.querySelector("[data-split-combine]").onclick = (e) => combineGroup(ids, g[0].client_slug, e.currentTarget, row);
  }
  card.hidden = false;
}

async function dismissSplit(ids, btn, rowEl) {
  btn.disabled = true; btn.textContent = "…";
  try {
    const { data, error } = await supabase.functions.invoke("process-enqueue", {
      body: { mode: "dismiss_split", submission_ids: ids },
    });
    let payload = data;
    if (error) { try { payload = await error.context.json(); } catch { /* ignore */ } }
    if (!payload?.ok) throw new Error(payload?.error || error?.message || "Dismiss failed");
    rowEl.remove();
    if ($("splitsList").children.length === 0) $("splits").hidden = true;
  } catch (e) {
    banner("banner", e.message, "error");
    btn.disabled = false; btn.textContent = "Not a split";
  }
}

async function combineGroup(ids, slug, btn, rowEl) {
  btn.disabled = true; btn.textContent = "Combining…";
  try {
    const { data, error } = await supabase.functions.invoke("process-enqueue", {
      body: { mode: "combine", submission_ids: ids, client_slug: slug },
    });
    let payload = data;
    if (error) { try { payload = await error.context.json(); } catch { /* ignore */ } }
    if (!payload?.ok) throw new Error(payload?.error || error?.message || "Combine failed");
    banner("banner", `✓ Combined ${payload.count} files → “${payload.renamed}” (originals kept).`, "ok");
    rowEl.remove();
    if ($("splitsList").children.length === 0) $("splits").hidden = true;
  } catch (e) {
    banner("banner", e.message, "error");
    btn.disabled = false; btn.textContent = "Combine into one";
  }
}

function openEdit(slug) {
  const c = clientsCache.find((x) => x.slug === slug);
  if (!c) return;
  $("eslug").value = c.slug;
  $("ename").value = c.name;
  $("elogo").value = "";
  $("ecurrentLogo").innerHTML = c.logo_url
    ? `Current logo: <a href="${c.logo_url}" target="_blank" rel="noopener">view</a>`
    : "No logo set.";
  hideBanner("editBanner");
  $("editModal").hidden = false;
  $("ename").focus();
}
function closeEdit() { $("editModal").hidden = true; }

async function onEdit(e) {
  e.preventDefault();
  const slug = $("eslug").value;
  const name = $("ename").value.trim();
  if (!name) { banner("editBanner", "Client name can't be empty.", "error"); return; }
  const btn = $("editSave");
  btn.disabled = true; btn.textContent = "Saving…";
  try {
    let logo_base64 = null, logo_content_type = null, logo_ext = null;
    const file = $("elogo").files[0];
    if (file) {
      logo_base64 = await fileToB64(file);
      logo_content_type = file.type || "image/png";
      logo_ext = (file.name.split(".").pop() || "png").toLowerCase().replace(/[^a-z0-9]/g, "") || "png";
    }
    const { data, error } = await supabase.functions.invoke("update-client", {
      body: { slug, name, logo_base64, logo_content_type, logo_ext },
    });
    let payload = data;
    if (error) { try { payload = await error.context.json(); } catch { /* ignore */ } }
    if (!payload?.ok) throw new Error(payload?.error || error?.message || "Update failed");
    closeEdit();
    banner("banner", `✓ Updated “${payload.name}”.`, "ok");
    loadClients();
  } catch (err) {
    banner("editBanner", err.message, "error");
  } finally {
    btn.disabled = false; btn.textContent = "Save changes";
  }
}

let clientsCache = [];

async function loadClients() {
  const { data, error } = await supabase
    .from("clients")
    .select("slug,name,logo_url,created_at,active")
    .order("created_at", { ascending: false });
  if (error) { banner("banner", `Could not load clients: ${error.message}`, "error"); return; }
  clientsCache = data || [];
  renderClients();
}

function renderClients() {
  const q = ($("clientFilter")?.value || "").trim().toLowerCase();
  const sort = $("clientSort")?.value || "created_desc";

  let list = clientsCache.slice();
  if (q) list = list.filter((c) => c.name.toLowerCase().includes(q) || c.slug.toLowerCase().includes(q));
  list.sort((a, b) => {
    switch (sort) {
      case "name_asc": return a.name.localeCompare(b.name);
      case "name_desc": return b.name.localeCompare(a.name);
      case "created_asc": return new Date(a.created_at) - new Date(b.created_at);
      default: return new Date(b.created_at) - new Date(a.created_at);
    }
  });

  // toolbar count
  const countEl = $("clientCount");
  if (countEl) countEl.textContent = q
    ? `${list.length} of ${clientsCache.length}`
    : `${clientsCache.length} client${clientsCache.length === 1 ? "" : "s"}`;

  // empty states: nothing at all vs. nothing matching the filter
  const empty = $("empty");
  if (clientsCache.length === 0) { empty.textContent = 'No clients yet. Click "Add New Client" to create your first form.'; empty.hidden = false; }
  else if (list.length === 0) { empty.textContent = `No clients match “${q}”.`; empty.hidden = false; }
  else empty.hidden = true;

  const tbody = $("rows");
  tbody.innerHTML = "";
  for (const c of list) {
    const url = `https://${DOMAIN}/${c.slug}/`;
    const tr = document.createElement("tr");
    const logo = c.logo_url
      ? `<img class="logo" src="${c.logo_url}" alt="" />`
      : `<span class="logo">${initials(c.name)}</span>`;
    tr.innerHTML = `
      <td><div class="cell-client">${logo}<div><div class="name">${esc(c.name)}</div><div class="slug">/${esc(c.slug)}</div></div></div></td>
      <td><a class="url-link" href="${url}" target="_blank" rel="noopener">${url}</a></td>
      <td class="muted">${fmtDate(c.created_at)}</td>
      <td><div class="row-actions">
        <button class="btn-ghost" data-process="${esc(c.slug)}">Process</button>
        <button class="btn-ghost" data-edit="${esc(c.slug)}">Edit</button>
        <button class="btn-ghost" data-copy="${url}">Copy</button>
        <button class="btn-ghost" data-open="${url}">Open</button>
      </div></td>`;
    tbody.appendChild(tr);
  }
  tbody.querySelectorAll("[data-process]").forEach((b) => (b.onclick = () => processDocs("client", b.dataset.process)));
  tbody.querySelectorAll("[data-copy]").forEach((b) =>
    (b.onclick = async () => { await navigator.clipboard.writeText(b.dataset.copy); b.textContent = "Copied!"; setTimeout(() => (b.textContent = "Copy"), 1200); }));
  tbody.querySelectorAll("[data-open]").forEach((b) => (b.onclick = () => window.open(b.dataset.open, "_blank")));
  tbody.querySelectorAll("[data-edit]").forEach((b) => (b.onclick = () => openEdit(b.dataset.edit)));
}

async function onCreate(e) {
  e.preventDefault();
  const name = $("cname").value.trim();
  if (!name) { banner("modalBanner", "Please enter a client name.", "error"); return; }
  const slug = ($("cslug").value.trim() || slugify(name));

  const memberVal = $("cmember").value;
  const newMemberName = $("cnewmember").value.trim();
  if (!memberVal) { banner("modalBanner", "Choose a Notion member (or create a new one).", "error"); return; }
  if (memberVal === "__new__" && !newMemberName) { banner("modalBanner", "Enter the new member name.", "error"); return; }

  const btn = $("create");
  btn.disabled = true; btn.textContent = "Creating…";

  try {
    // 1) Read the logo (if any) as base64 — the edge function uploads it (service role).
    let logo_base64 = null, logo_content_type = null, logo_ext = null;
    const file = $("clogo").files[0];
    if (file) {
      logo_base64 = await fileToB64(file);
      logo_content_type = file.type || "image/png";
      logo_ext = (file.name.split(".").pop() || "png").toLowerCase().replace(/[^a-z0-9]/g, "") || "png";
    }

    // 2) Create the client (edge function commits form, uploads logo, registers client)
    const { data, error } = await supabase.functions.invoke("create-client", {
      body: {
        name, slug, logo_base64, logo_content_type, logo_ext,
        member_page_id: memberVal === "__new__" ? undefined : memberVal,
        new_member_name: memberVal === "__new__" ? newMemberName : undefined,
      },
    });
    let payload = data;
    if (error) { try { payload = await error.context.json(); } catch { /* ignore */ } }
    if (!payload?.ok) throw new Error(payload?.error || error?.message || "Create failed");

    closeModal();
    banner("banner", `✓ Created “${payload.name}” → ${payload.url} (live in ~1 min)`, "ok");
    loadClients();
  } catch (err) {
    banner("modalBanner", err.message, "error");
  } finally {
    btn.disabled = false; btn.textContent = "Create form";
  }
}

// --- modal + helpers ---
function openModal() {
  $("addForm").reset();
  $("cnewmemberWrap").hidden = true;
  hideBanner("modalBanner");
  updatePreview();
  $("modal").hidden = false;
  $("cname").focus();
  loadMembers();
}
function closeModal() { $("modal").hidden = true; }

function onMemberChange() {
  const isNew = $("cmember").value === "__new__";
  $("cnewmemberWrap").hidden = !isNew;
  if (isNew && !$("cnewmember").value) $("cnewmember").value = $("cname").value.trim();
}

async function loadMembers() {
  const sel = $("cmember");
  sel.innerHTML = '<option value="">— loading members… —</option>';
  try {
    const { data, error } = await supabase.functions.invoke("members", { body: {} });
    let payload = data;
    if (error) { try { payload = await error.context.json(); } catch { /* ignore */ } }
    if (!payload?.ok) throw new Error(payload?.error || error?.message || "Could not load members");
    const opts = ['<option value="">— choose an existing member —</option>'];
    for (const m of payload.members) {
      const label = m.taken ? `${m.name} — already linked to /${m.taken_by}` : m.name;
      opts.push(`<option value="${esc(m.id)}"${m.taken ? " disabled" : ""}>${esc(label)}</option>`);
    }
    opts.push('<option value="__new__">➕ Create a new member…</option>');
    sel.innerHTML = opts.join("");
  } catch (e) {
    sel.innerHTML = '<option value="">(couldn’t load — create new below)</option><option value="__new__">➕ Create a new member…</option>';
    banner("modalBanner", e.message, "error");
  }
}
function updatePreview() {
  const name = $("cname").value.trim();
  const slug = $("cslug").value.trim() || slugify(name);
  $("urlPreview").textContent = slug ? `Form URL: https://${DOMAIN}/${slug}/` : "";
}
function show(id) { $(id).hidden = false; }
function hide(id) { $(id).hidden = true; }
function banner(id, msg, kind) { const b = $(id); b.textContent = msg; b.className = `banner show ${kind}`; }
function hideBanner(id) { $(id).className = "banner"; }
function slugify(s) {
  return s.toLowerCase().normalize("NFKD").replace(/[^\w\s-]/g, "").trim().replace(/[\s_]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
}
function initials(name) {
  return (name.replace(/[^A-Za-z ]/g, "").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join("") || name.slice(0, 2).toUpperCase());
}
function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function fileToB64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1]);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}
function fmtDate(iso) { const d = new Date(iso); return d.toLocaleDateString(undefined, { month: "short", day: "numeric" }); }
