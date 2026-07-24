// Central config + constants for the Clean Documents worker.
// Secrets come from the environment (GCP Secret Manager mounts); the Notion
// data-source IDs and Drive root are stable facts about this workspace.

export const env = (k, required = true) => {
  const v = process.env[k];
  if (required && !v) throw new Error(`Missing required env var: ${k}`);
  return v;
};

export const CFG = {
  supabaseUrl: env('SUPABASE_URL'),
  serviceRole: env('SUPABASE_SERVICE_ROLE_KEY'),
  bucket: process.env.SUPABASE_BUCKET || 'client-docs',

  google: {
    clientId: env('GOOGLE_CLIENT_ID'),
    clientSecret: env('GOOGLE_CLIENT_SECRET'),
    refreshToken: env('GOOGLE_REFRESH_TOKEN'),
    // "Client Documents" root folder in the owner's Drive.
    clientDocsRootId: process.env.CLIENT_DOCS_ROOT_ID || '1zgaIHdVtanaCSGVuSswy4odM1xxhd8UZ',
  },

  notion: {
    token: env('NOTION_TOKEN'),
    version: '2025-09-03',
    docsDataSource: process.env.NOTION_DOCS_DS || '5982ea20-8de0-4591-a457-6b2a9772e317',
    memberDataSource: process.env.NOTION_MEMBER_DS || '1bcf5b24-58b4-419f-ad96-e412ab2beaf0',
    // Institutions that already exist as options on the "Name" select — only set
    // Name when it matches one of these, to avoid polluting the select.
    knownInstitutions: new Set([
      'EverBank', 'Marriott', 'Chase', 'Marcus Goldman Sachs', 'Bank of America',
      'Israel Bonds', 'TIAA CREF', 'Ally Bank', 'Synchrony Bank', 'Citi', 'Citizens Bank',
    ]),
  },

  anthropic: {
    key: env('ANTHROPIC_API_KEY'),
    model: process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5',
    escalateModel: process.env.ANTHROPIC_ESCALATE_MODEL || 'claude-sonnet-5',
    version: '2023-06-01',
  },

  // Shared secret the enqueue edge function must present to POST /run.
  workerSecret: env('WORKER_SHARED_SECRET'),

  // Confidence below which we escalate to the stronger model; still below after
  // escalation => needs_review (never write a guessed row).
  minConfidence: Number(process.env.MIN_CONFIDENCE || 0.75),
};
