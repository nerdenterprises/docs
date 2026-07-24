// Build the final, human filename from a classification. Mirrors the established
// convention: "<Vendor/Product> [<acct>] <YYYY-MM-DD>" for statements; Claude's
// suggested_name for everything else. No dollar amounts (per owner preference).

const sanitize = (s) =>
  String(s)
    .replace(/[\/\\:*?"<>|]/g, ' ')       // characters illegal in file names
    .replace(/[^\w .,$()&%+#-]/g, ' ')     // keep a friendly ASCII-ish set
    .replace(/\s+/g, ' ')
    .trim();

export function buildName(cls, ext) {
  const e = (ext || 'pdf').toLowerCase().replace(/[^a-z0-9]/g, '') || 'pdf';
  let stem;
  if (cls.base_name) {
    stem = [cls.base_name, cls.account, cls.date].filter(Boolean).join(' ');
  } else if (cls.suggested_name) {
    stem = cls.suggested_name;
  } else {
    stem = [cls.vendor, cls.account, cls.date].filter(Boolean).join(' ') || 'Document';
  }
  stem = sanitize(stem).slice(0, 180) || 'Document';
  return `${stem}.${e}`;
}
