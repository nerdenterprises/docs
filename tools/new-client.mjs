#!/usr/bin/env node
// Create New Form — scaffolds a new client upload form, commits, and pushes.
//
// Usage:
//   node tools/new-client.mjs "Acme Holdings, Inc."
//   node tools/new-client.mjs "Acme Holdings, Inc." --slug acme
//   node tools/new-client.mjs "Acme Holdings, Inc." --no-push
//
// Result: docs.nerdenterprises.com/<slug>/  →  the client's personal upload form.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TEMPLATE = join(ROOT, "tools", "templates", "client-index.html");
const DOMAIN = "docs.nerdenterprises.com";

// ---- parse args -----------------------------------------------------------
const args = process.argv.slice(2);
const flags = { push: true };
const positional = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--slug") flags.slug = args[++i];
  else if (args[i] === "--no-push") flags.push = false;
  else positional.push(args[i]);
}
const name = (positional.join(" ") || "").trim();
if (!name) {
  console.error('Usage: node tools/new-client.mjs "Client Name" [--slug custom-slug] [--no-push]');
  process.exit(1);
}

// ---- derive slug + initials ----------------------------------------------
const slug = (flags.slug || slugify(name));
if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(slug)) {
  console.error(`Invalid slug "${slug}". Use lowercase letters, numbers, and hyphens only.`);
  process.exit(1);
}
const RESERVED = new Set(["assets", "tools", "config", "index", "admin", "api"]);
if (RESERVED.has(slug)) {
  console.error(`"${slug}" is reserved. Pass a different --slug.`);
  process.exit(1);
}

const dir = join(ROOT, slug);
if (existsSync(dir)) {
  console.error(`A form for "${slug}" already exists at /${slug}/. Choose a different --slug.`);
  process.exit(1);
}

const initials = name
  .replace(/[^A-Za-z ]/g, "")
  .split(/\s+/)
  .filter(Boolean)
  .slice(0, 2)
  .map((w) => w[0].toUpperCase())
  .join("") || name.slice(0, 2).toUpperCase();

// ---- stamp template -------------------------------------------------------
const html = readFileSync(TEMPLATE, "utf8")
  .replaceAll("{{CLIENT_SLUG}}", slug)
  .replaceAll("{{CLIENT_NAME}}", escapeHtml(name))
  .replaceAll("{{INITIALS}}", escapeHtml(initials));

mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "index.html"), html, "utf8");

const url = `https://${DOMAIN}/${slug}/`;
console.log(`\n✅ Created form for "${name}"`);
console.log(`   Folder:  /${slug}/index.html`);
console.log(`   Link:    ${url}\n`);

// ---- commit + push --------------------------------------------------------
if (flags.push) {
  try {
    run(`git -C "${ROOT}" add "${slug}/index.html"`);
    run(`git -C "${ROOT}" commit -m "Add upload form for ${name} (${slug})"`);
    run(`git -C "${ROOT}" push`);
    console.log(`🚀 Pushed. Live shortly at ${url}`);
    console.log(`   (Supabase folder "${slug}/" is created automatically on the first upload.)\n`);
  } catch (e) {
    console.error("\n⚠️  Files created but git push failed — push manually:\n   git add . && git commit && git push\n");
    process.exit(1);
  }
} else {
  console.log("Skipped git (--no-push). Commit & push when ready.\n");
}

// ---- helpers --------------------------------------------------------------
function slugify(s) {
  return s.toLowerCase().normalize("NFKD").replace(/[^\w\s-]/g, "")
    .trim().replace(/[\s_]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
}
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function run(cmd) { execSync(cmd, { stdio: "pipe" }); }
