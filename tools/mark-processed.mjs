#!/usr/bin/env node
// Step 7: mark Supabase originals as processed (kept as backup, not deleted).
//
//   node tools/mark-processed.mjs <submission_id> [<submission_id> ...]
//   node tools/mark-processed.mjs --client acme   # mark all of a client's 'filed' rows
import { querySubmissions, patchSubmission } from "./lib.mjs";

const args = process.argv.slice(2);
let ids = [];

if (args[0] === "--client") {
  const slug = args[1];
  if (!slug) { console.error("Usage: node tools/mark-processed.mjs --client <slug>"); process.exit(1); }
  const rows = await querySubmissions(`client_slug=eq.${slug}&status=eq.downloaded&select=id`);
  ids = rows.map((r) => r.id);
  if (ids.length === 0) { console.log(`No downloaded files to mark for "${slug}".`); process.exit(0); }
} else {
  ids = args;
}

if (ids.length === 0) {
  console.error("Usage: node tools/mark-processed.mjs <submission_id> [...]  |  --client <slug>");
  process.exit(1);
}

const stamp = new Date().toISOString();
for (const id of ids) {
  try {
    await patchSubmission(id, { status: "processed", processed_at: stamp });
    console.log(`✓ ${id} -> processed`);
  } catch (e) {
    console.log(`✗ ${id}: ${e.message}`);
  }
}
