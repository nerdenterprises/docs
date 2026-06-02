#!/usr/bin/env node
// Step 3 (scheduled): pull NEW client uploads from Supabase to inbox/<client>/,
// mark them "downloaded", and emit a manifest the Cowork run uses to create
// Notion rows.
//
//   node tools/pull.mjs            # download all new files
//   node tools/pull.mjs --dry      # show what would be pulled, change nothing
//
// Output: JSON manifest on stdout + written to inbox/_last-pull.json
//
// NOTE: this script avoids process.exit() on purpose — calling it after a
// fetch() trips a libuv teardown assertion on Windows. Let it exit naturally.
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join, extname, basename } from "node:path";
import { ROOT_DIR, querySubmissions, patchSubmission, downloadObject } from "./lib.mjs";

const DRY = process.argv.includes("--dry");
const INBOX = join(ROOT_DIR, "inbox");

await main();

async function main() {
  const rows = await querySubmissions("status=eq.new&order=created_at.asc&select=*");
  if (rows.length === 0) {
    console.log(JSON.stringify({ count: 0, pulled: [] }, null, 2));
    return;
  }

  if (DRY) {
    console.log(`Would pull ${rows.length} file(s):`);
    for (const r of rows) console.log(`  [${r.client_slug}] ${r.original_filename}  (from ${r.uploader_name})`);
    return;
  }

  const manifest = [];
  for (const r of rows) {
    const dir = join(INBOX, r.client_slug);
    mkdirSync(dir, { recursive: true });
    try {
      const buf = await downloadObject(r.file_path);
      const local = uniquePath(join(dir, sanitize(r.original_filename)));
      writeFileSync(local, buf);
      await patchSubmission(r.id, { status: "downloaded" });
      manifest.push({
        id: r.id,
        client_slug: r.client_slug,
        uploader_name: r.uploader_name,
        uploader_email: r.uploader_email,
        note: r.note,
        original_filename: r.original_filename,
        file_path: r.file_path,
        size_bytes: r.size_bytes,
        content_type: r.content_type,
        uploaded_at: r.created_at,
        local_path: local,
      });
      console.error(`✓ [${r.client_slug}] ${r.original_filename}`);
    } catch (e) {
      console.error(`✗ [${r.client_slug}] ${r.original_filename}: ${e.message}`);
    }
  }

  mkdirSync(INBOX, { recursive: true });
  const manifestPath = join(INBOX, "_last-pull.json");
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify({ count: manifest.length, manifest: manifestPath, pulled: manifest }, null, 2));
}

// --- helpers ---
function sanitize(name) {
  return name.replace(/[\\/:*?"<>|]/g, "_").replace(/\s+/g, " ").trim() || "file";
}
function uniquePath(p) {
  if (!existsSync(p)) return p;
  const ext = extname(p);
  const stem = join(p, "..", basename(p, ext));
  let i = 2;
  while (existsSync(`${stem} (${i})${ext}`)) i++;
  return `${stem} (${i})${ext}`;
}
