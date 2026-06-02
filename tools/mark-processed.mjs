#!/usr/bin/env node
// Step 7: mark Supabase originals as processed (kept as backup, not deleted).
//
//   node tools/mark-processed.mjs <submission_id> [<submission_id> ...]
//   node tools/mark-processed.mjs --client acme   # mark all of a client's downloaded rows
//
// NOTE: avoids process.exit() after fetch() (Windows libuv teardown bug).
import { querySubmissions, patchSubmission } from "./lib.mjs";

const USAGE = "Usage: node tools/mark-processed.mjs <submission_id> [...]  |  --client <slug>";

await main();

async function main() {
  const args = process.argv.slice(2);
  let ids = [];

  if (args[0] === "--client") {
    const slug = args[1];
    if (!slug) { console.error(USAGE); process.exitCode = 1; return; }
    const rows = await querySubmissions(`client_slug=eq.${slug}&status=eq.downloaded&select=id`);
    ids = rows.map((r) => r.id);
    if (ids.length === 0) { console.log(`No downloaded files to mark for "${slug}".`); return; }
  } else {
    ids = args;
  }

  if (ids.length === 0) { console.error(USAGE); process.exitCode = 1; return; }

  const stamp = new Date().toISOString();
  for (const id of ids) {
    try {
      await patchSubmission(id, { status: "processed", processed_at: stamp });
      console.log(`✓ ${id} -> processed`);
    } catch (e) {
      console.log(`✗ ${id}: ${e.message}`);
    }
  }
}
