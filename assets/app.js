// Shared upload logic for all client document-intake forms.
// Reads two globals defined by the page:
//   window.SUPABASE_CONFIG = { url, anonKey, bucket }   (from ../config.js)
//   window.CLIENT          = { slug, name }             (baked into each client's index.html)
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cfg = window.SUPABASE_CONFIG || {};
const client = window.CLIENT || {};
const MAX_BYTES = 100 * 1024 * 1024; // 100 MB per file
const MAX_FILES = 25;

// Always use the anon key — never pick up an existing admin session from
// localStorage (admin and forms share the same origin). This ensures uploads
// always go through the insert-only anon RLS policy regardless of who is
// logged into the admin page.
const supabase = createClient(cfg.url, cfg.anonKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// Show the client's own logo (if one was uploaded) via the public branding lookup.
(async () => {
  if (!client.slug) return;
  try {
    const { data } = await supabase.rpc("client_branding", { p_slug: client.slug });
    const b = Array.isArray(data) ? data[0] : null;
    if (!b) return;
    if (b.logo_url) { const el = document.getElementById("clientLogo"); if (el) { el.src = b.logo_url; el.hidden = false; } }
    if (b.name) {
      const nameEl = document.getElementById("clientName");
      if (nameEl) nameEl.textContent = b.name;
      document.title = `Upload Documents — ${b.name}`;
    }
  } catch (_) { /* branding is best-effort */ }
})();

const $ = (sel) => document.querySelector(sel);
let queue = []; // File[]

// ---- file selection -------------------------------------------------------
const drop = $("#drop");
const picker = $("#picker");
const list = $("#files");

drop.addEventListener("click", () => picker.click());
drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("drag"); });
drop.addEventListener("dragleave", () => drop.classList.remove("drag"));
drop.addEventListener("drop", (e) => {
  e.preventDefault();
  drop.classList.remove("drag");
  addFiles(e.dataTransfer.files);
});
picker.addEventListener("change", () => { addFiles(picker.files); picker.value = ""; });

function addFiles(fileList) {
  for (const f of fileList) {
    if (queue.length >= MAX_FILES) { banner(`You can upload up to ${MAX_FILES} files at once.`); break; }
    if (f.size > MAX_BYTES) { banner(`"${f.name}" is larger than 100 MB and was skipped.`); continue; }
    if (queue.some((q) => q.name === f.name && q.size === f.size)) continue; // de-dupe
    queue.push(f);
  }
  renderFiles();
}

function renderFiles() {
  list.innerHTML = "";
  queue.forEach((f, i) => {
    const li = document.createElement("li");
    li.dataset.idx = i;
    li.innerHTML = `
      <span class="name">${escapeHtml(f.name)}</span>
      <span class="size">${fmtSize(f.size)}</span>
      <button type="button" class="rm" title="Remove" aria-label="Remove">&times;</button>`;
    li.querySelector(".rm").addEventListener("click", () => { queue.splice(i, 1); renderFiles(); });
    list.appendChild(li);
  });
  $("#submit").disabled = queue.length === 0;
}

// ---- submit ---------------------------------------------------------------
$("#form").addEventListener("submit", async (e) => {
  e.preventDefault();
  clearBanner();

  const name = $("#name").value.trim();
  const email = $("#email").value.trim();
  const note = $("#note").value.trim();
  if (!name) { banner("Please enter your name."); $("#name").focus(); return; }
  if (queue.length === 0) { banner("Please add at least one file."); return; }

  const submit = $("#submit");
  submit.disabled = true;
  const bar = $("#bar");
  bar.classList.add("show");
  const fill = bar.querySelector("i");

  let done = 0;
  let failures = 0;
  const items = [...list.children];

  for (let i = 0; i < queue.length; i++) {
    const file = queue[i];
    const li = items[i];
    setStat(li, "uploading…");
    const path = buildPath(client.slug, file.name);
    try {
      const { error: upErr } = await supabase.storage
        .from(cfg.bucket)
        .upload(path, file, { cacheControl: "3600", upsert: false, contentType: file.type || undefined });
      if (upErr) throw upErr;

      // Record the submission row (no .select() → no read-back needed under RLS).
      const { error: rowErr } = await supabase.from("submissions").insert({
        client_slug: client.slug,
        uploader_name: name,
        uploader_email: email || null,
        note: note || null,
        file_path: path,
        original_filename: file.name,
        size_bytes: file.size,
        content_type: file.type || null,
      });
      if (rowErr) throw rowErr;

      li.classList.add("done");
      setStat(li, "✓ uploaded");
    } catch (err) {
      console.error("Upload failed for", file.name, err);
      failures++;
      li.classList.add("failed");
      setStat(li, "failed");
    }
    done++;
    fill.style.width = `${Math.round((done / queue.length) * 100)}%`;
  }

  if (failures === 0) {
    showDone(queue.length);
  } else if (failures < queue.length) {
    banner(`${queue.length - failures} of ${queue.length} files uploaded. Please retry the failed ones.`);
    submit.disabled = false;
  } else {
    banner("Upload failed. Please check your connection and try again.");
    submit.disabled = false;
  }
});

// ---- helpers --------------------------------------------------------------
function buildPath(slug, filename) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  // Storage keys must avoid spaces & special chars — keep only [A-Za-z0-9._-].
  // (The real filename, spaces and all, is preserved in original_filename.)
  const safe = filename.normalize("NFKD").replace(/[^A-Za-z0-9.\-]+/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "") || "file";
  return `${slug}/${stamp}__${safe}`;
}
function setStat(li, text) {
  let s = li.querySelector(".stat");
  if (!s) { s = document.createElement("span"); s.className = "stat"; li.appendChild(s); }
  s.textContent = text;
  const rm = li.querySelector(".rm");
  if (rm) rm.style.display = "none";
}
function showDone(n) {
  $("#form").style.display = "none";
  const ds = $("#done");
  $("#done-count").textContent = `${n} file${n === 1 ? "" : "s"}`;
  ds.classList.add("show");
}
function banner(msg) { const b = $("#banner"); b.textContent = msg; b.classList.add("show", "error"); }
function clearBanner() { $("#banner").classList.remove("show"); }
function fmtSize(b) {
  if (b < 1024) return b + " B";
  if (b < 1048576) return (b / 1024).toFixed(0) + " KB";
  return (b / 1048576).toFixed(1) + " MB";
}
function escapeHtml(s) { return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

// reset button on the success screen
const resetBtn = document.getElementById("reset");
if (resetBtn) resetBtn.addEventListener("click", () => location.reload());
