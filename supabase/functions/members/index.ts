// members: returns the Notion members the "Clean Documents" integration can see,
// each flagged whether it's already linked to a client (one member ↔ one form).
// Admin-only. Used to populate the member dropdown in the Add-Client modal.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ADMIN_EMAIL = "seth@nerdenterprises.com";
const MEMBER_DS = "1bcf5b24-58b4-419f-ad96-e412ab2beaf0";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  const { data: u } = await admin.auth.getUser(token);
  if (u?.user?.email?.toLowerCase() !== ADMIN_EMAIL) return json({ error: "Not authorized" }, 403);

  const { data: sec } = await admin.from("app_secrets").select("value").eq("key", "notion_token").single();
  const notionToken = sec?.value as string | undefined;
  if (!notionToken) return json({ error: "Notion token not configured" }, 500);

  // members the integration can see
  const res = await fetch(`https://api.notion.com/v1/data_sources/${MEMBER_DS}/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${notionToken}`, "Notion-Version": "2025-09-03", "Content-Type": "application/json" },
    body: JSON.stringify({ page_size: 100 }),
  });
  if (!res.ok) return json({ error: `Notion query failed (${res.status})` }, 502);
  const data = await res.json();

  // which member ids are already linked to a client
  const { data: clients } = await admin.from("clients").select("slug,notion_member_page_id");
  const takenBy: Record<string, string> = {};
  for (const c of clients ?? []) if (c.notion_member_page_id) takenBy[c.notion_member_page_id] = c.slug;

  const members = (data.results ?? []).map((p: any) => {
    const name = (p.properties?.Client?.title ?? []).map((t: any) => t.plain_text).join("");
    const id = p.id;
    return { id, name, taken: Boolean(takenBy[id]), taken_by: takenBy[id] ?? null };
  }).filter((m: any) => m.name).sort((a: any, b: any) => a.name.localeCompare(b.name));

  return json({ ok: true, members });
});
