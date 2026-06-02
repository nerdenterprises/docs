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
}

function wire() {
  $("signin").onclick = () =>
    supabase.auth.signInWithOAuth({ provider: "google", options: { redirectTo: location.href.split("#")[0] } });
  $("signout").onclick = $("signout2").onclick = () => supabase.auth.signOut();
  $("addBtn").onclick = openModal;
  $("cancel").onclick = closeModal;
  $("cname").oninput = $("cslug").oninput = updatePreview;
  $("addForm").onsubmit = onCreate;
}

async function loadClients() {
  const { data, error } = await supabase
    .from("clients")
    .select("slug,name,logo_url,created_at,active")
    .order("created_at", { ascending: false });

  const tbody = $("rows");
  tbody.innerHTML = "";
  if (error) { banner("banner", `Could not load clients: ${error.message}`, "error"); return; }

  $("empty").hidden = data.length > 0;
  for (const c of data) {
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
        <button class="btn-ghost" data-copy="${url}">Copy</button>
        <button class="btn-ghost" data-open="${url}">Open</button>
      </div></td>`;
    tbody.appendChild(tr);
  }
  tbody.querySelectorAll("[data-copy]").forEach((b) =>
    (b.onclick = async () => { await navigator.clipboard.writeText(b.dataset.copy); b.textContent = "Copied!"; setTimeout(() => (b.textContent = "Copy"), 1200); }));
  tbody.querySelectorAll("[data-open]").forEach((b) => (b.onclick = () => window.open(b.dataset.open, "_blank")));
}

async function onCreate(e) {
  e.preventDefault();
  const name = $("cname").value.trim();
  if (!name) { banner("modalBanner", "Please enter a client name.", "error"); return; }
  const slug = ($("cslug").value.trim() || slugify(name));
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
      body: { name, slug, logo_base64, logo_content_type, logo_ext },
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
function openModal() { $("addForm").reset(); hideBanner("modalBanner"); updatePreview(); $("modal").hidden = false; $("cname").focus(); }
function closeModal() { $("modal").hidden = true; }
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
