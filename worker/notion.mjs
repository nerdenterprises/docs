// Notion logging. buildPageProperties() is the ONE place a row is written, and it
// hard-enforces every convention (Member relation, Drive link on Documents, the
// "Claude" tag) so drift is impossible — a row can't be created without them.
import { CFG } from './config.mjs';

const NH = {
  Authorization: `Bearer ${CFG.notion.token}`,
  'Notion-Version': CFG.notion.version,
  'Content-Type': 'application/json',
};

async function notion(path, init = {}) {
  const res = await fetch(`https://api.notion.com/v1/${path}`, { ...init, headers: { ...NH, ...(init.headers || {}) } });
  if (!res.ok) throw new Error(`Notion ${init.method || 'GET'} ${path} -> ${res.status}: ${await res.text()}`);
  return res.json();
}

/** Resolve a client's Member page id by the "Client" title; cache upstream. Throws if not found. */
export async function resolveMemberPageId(displayName) {
  const r = await notion(`data_sources/${CFG.notion.memberDataSource}/query`, {
    method: 'POST',
    body: JSON.stringify({ filter: { property: 'Client', title: { equals: displayName } }, page_size: 1 }),
  });
  const id = r.results?.[0]?.id;
  if (!id) throw new Error(`No Member page found for client "${displayName}" — refusing to write an empty relation.`);
  return id;
}

/**
 * Build the property map. Enforced invariants:
 *  - 🎭 Member relation (required — caller must pass a resolved memberPageId)
 *  - Documents = external file pointing at the Drive share link (name required)
 *  - Tags ALWAYS include "Claude"
 *  - Document Title + Document Date + Status
 */
export function buildPageProperties({ title, docFileName, isoDate, driveLink, memberPageId, category, tags, institution }) {
  if (!memberPageId) throw new Error('buildPageProperties: memberPageId is required (no empty Member relation).');
  if (!driveLink) throw new Error('buildPageProperties: driveLink is required (Documents must carry the Drive link).');

  const tagSet = Array.from(new Set([...(tags || []), 'Claude'])); // "Claude" is non-negotiable
  const props = {
    'Document Title': { title: [{ text: { content: title } }] },
    'Status': { select: { name: 'Active' } },
    '🎭 Member': { relation: [{ id: memberPageId }] },
    'Documents': { files: [{ name: docFileName || `${title}.pdf`, external: { url: driveLink } }] },
    'Tags': { multi_select: tagSet.map((name) => ({ name })) },
  };
  if (isoDate) props['Document Date'] = { date: { start: isoDate } };
  if (category) props['Category'] = { select: { name: category } };
  if (institution && CFG.notion.knownInstitutions.has(institution)) props['Name'] = { select: { name: institution } };
  return props;
}

export async function createDocumentRow(properties) {
  const r = await notion('pages', {
    method: 'POST',
    body: JSON.stringify({ parent: { type: 'data_source_id', data_source_id: CFG.notion.docsDataSource }, properties }),
  });
  return r.id;
}
