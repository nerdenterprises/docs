import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ADMIN_EMAIL = "seth@nerdenterprises.com";
const REPO = "nerdenterprises/docs";
const BRANCH = "main";
const DOMAIN = "docs.nerdenterprises.com";
const TEMPLATE_PATH = "tools/templates/client-index.html";
const LOGO_BUCKET = "client-logos";
const MEMBER_DS = "1bcf5b24-58b4-419f-ad96-e412ab2beaf0";
const RESERVED = new Set(["assets", "tools", "admin", "api", "index", "config", "404", "cname"]);

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
}
function slugify(s: string) {
  return s.toLowerCase().normalize("NFKD").replace(/[^\w\s-]/g, "").trim()
    .replace(/[\s_]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
}
function escapeHtml(s: string) {
  return s.replace(/[&<>\"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '\"': "&quot;", "'": "&#39;" }[c]!));
}
function b64encode(str: string) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(bin);
}
function b64decode(b64: string) {
  const bin = atob(b64.replace(/\s/g, ""));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}
function b64ToBytes(b64: string) {
  const bin = atob(b64.replace(/\s/g, ""));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

async function gh(path: string, token: string, init: RequestInit = {}) {
  return await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "clean-books-create-client",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(init.headers || {}),
    },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const admin = createClient(SUPABASE_URL, SERVICE_KEY);

  // --- authorize ---
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  const { data: userData, error: userErr } = await admin.auth.getUser(token);
  if (userErr || !userData?.user || userData.user.email?.toLowerCase() !== ADMIN_EMAIL) {
    return json({ error: "Not authorized" }, 403);
  }

  // --- input ---
  let body: {
    name?: string; slug?: string; logo_base64?: string; logo_content_type?: string; logo_ext?: string;
    member_page_id?: string; new_member_name?: string;
  };
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON body" }, 400); }
  const name = (body.name || "").trim();
  if (!name) return json({ error: "Client name is required" }, 400);
  const slug = (body.slug || slugify(name)).trim();
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(slug)) return json({ error: `Invalid slug \"${slug}\"` }, 400);
  if (RESERVED.has(slug)) return json({ error: `\"${slug}\" is reserved` }, 400);

  const memberPageIdIn = (body.member_page_id || "").trim();
  const newMemberName = (body.new_member_name || "").trim();
  if (!memberPageIdIn && !newMemberName) {
    return json({ error: "Pick an existing Notion member or enter a new member name." }, 400);
  }

  // --- not already in DB ---
  const { data: existing } = await admin.from("clients").select("slug").eq("slug", slug).maybeSingle();
  if (existing) return json({ error: `A client with slug \"${slug}\" already exists` }, 409);

  // --- notion token (for member resolve/create) ---
  const { data: nsec } = await admin.from("app_secrets").select("value").eq("key", "notion_token").single();
  const notionToken = nsec?.value as string | undefined;
  if (!notionToken) return json({ error: "Notion token not configured" }, 500);
  const notion = (path: string, init: RequestInit = {}) =>
    fetch(`https://api.notion.com/v1/${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${notionToken}`, "Notion-Version": "2025-09-03", "Content-Type": "application/json", ...(init.headers || {}) },
    });

  // --- resolve the member (existing or create new) ---
  let memberPageId = memberPageIdIn;
  let memberCreated = false;
  if (!memberPageId) {
    // create a new member in the Members data source
    const r = await notion("pages", {
      method: "POST",
      body: JSON.stringify({
        parent: { type: "data_source_id", data_source_id: MEMBER_DS },
        properties: { Client: { title: [{ text: { content: newMemberName } }] } },
      }),
    });
    if (!r.ok) return json({ error: `Could not create Notion member (${r.status})`, detail: (await r.text()).slice(0, 300) }, 502);
    memberPageId = (await r.json()).id;
    memberCreated = true;
  }

  // --- one-to-one: member not already linked to another client ---
  const { data: taken } = await admin.from("clients").select("slug").eq("notion_member_page_id", memberPageId).maybeSingle();
  if (taken) return json({ error: `That member is already linked to form /${taken.slug}. Each member maps to one form.` }, 409);

  // --- github token ---
  const { data: secret, error: secErr } = await admin.from("app_secrets").select("value").eq("key", "github_token").single();
  if (secErr || !secret?.value) return json({ error: "GitHub token not configured" }, 500);
  const ghToken = secret.value as string;

  // --- ensure the form file doesn't already exist ---
  const filePath = `${slug}/index.html`;
  const head = await gh(`/repos/${REPO}/contents/${filePath}?ref=${BRANCH}`, ghToken);
  if (head.status === 200) return json({ error: `Form already exists at /${slug}/` }, 409);

  // --- optional: upload the client logo via the service role (bypasses RLS) ---
  let logo_url: string | null = null;
  if (body.logo_base64) {
    const ext = (body.logo_ext || "png").toLowerCase().replace(/[^a-z0-9]/g, "") || "png";
    const logoPath = `${slug}.${ext}`;
    const { error: upErr } = await admin.storage.from(LOGO_BUCKET).upload(logoPath, b64ToBytes(body.logo_base64), {
      contentType: body.logo_content_type || "image/png",
      upsert: true,
    });
    if (upErr) return json({ error: `Logo upload failed: ${upErr.message}` }, 500);
    logo_url = admin.storage.from(LOGO_BUCKET).getPublicUrl(logoPath).data.publicUrl;
  }

  // --- fetch + stamp the template ---
  const tplRes = await gh(`/repos/${REPO}/contents/${TEMPLATE_PATH}?ref=${BRANCH}`, ghToken);
  if (!tplRes.ok) return json({ error: `Could not read template (${tplRes.status})` }, 502);
  const tplJson = await tplRes.json();
  const html = b64decode(tplJson.content).replaceAll("{{CLIENT_SLUG}}", slug).replaceAll("{{CLIENT_NAME}}", escapeHtml(name));

  // --- commit the new client form ---
  const put = await gh(`/repos/${REPO}/contents/${filePath}`, ghToken, {
    method: "PUT",
    body: JSON.stringify({ message: `Add upload form for ${name} (${slug})`, content: b64encode(html), branch: BRANCH }),
  });
  if (!put.ok) {
    const t = await put.text();
    return json({ error: `GitHub commit failed (${put.status})`, detail: t.slice(0, 300) }, 502);
  }

  // --- register the client (roll back the file if this fails) ---
  const { error: insErr } = await admin.from("clients").insert({
    slug, name, logo_url, active: true,
    notion_member_page_id: memberPageId, display_name: name,
  });
  if (insErr) {
    const sha = (await put.json())?.content?.sha;
    if (sha) {
      await gh(`/repos/${REPO}/contents/${filePath}`, ghToken, {
        method: "DELETE",
        body: JSON.stringify({ message: `Roll back ${slug} (db insert failed)`, sha, branch: BRANCH }),
      });
    }
    return json({ error: `Database insert failed: ${insErr.message}` }, 500);
  }

  return json({ ok: true, slug, name, url: `https://${DOMAIN}/${slug}/`, member_page_id: memberPageId, member_created: memberCreated }, 200);
});
