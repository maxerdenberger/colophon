// /api/migrate-approvals
//
// One-shot migration endpoint. POST a list of approved emails; the Sheet's
// status column gets normalized: matching rows → 'approved', everything else
// currently 'active'/empty → 'pending', and existing 'cold'/'duplicate'/
// 'denied' rows untouched. Idempotent — running it twice with the same list
// is a no-op.
//
// Body:
//   { emails: ['a@b.com', 'c@d.com', ...] }
//
// Auth: same Bearer adminKey as /api/bench-update.

import { migrateApprovalsBulk } from './_utils/sheets.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method not allowed' });
  }
  const auth = req.headers.authorization || '';
  const adminKey = process.env.ADMIN_KEY || process.env.ADMIN_SECRET || '590Rossmore';
  if (auth !== `Bearer ${adminKey}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const emails = Array.isArray(req.body && req.body.emails) ? req.body.emails : [];
  const cleaned = emails
    .map((e) => String(e || '').trim().toLowerCase())
    .filter((e) => e.includes('@'));

  if (!cleaned.length) {
    return res.status(400).json({ error: 'no valid emails in body.emails' });
  }

  try {
    const result = await migrateApprovalsBulk(cleaned);
    return res.status(200).json({ ok: true, ...result, seedEmails: cleaned.length });
  } catch (err) {
    return res.status(500).json({
      error: err.message || 'migration failed',
      hint:  'check GOOGLE_SERVICE_EMAIL / GOOGLE_PRIVATE_KEY / SHEETS_SPREADSHEET_ID env vars',
    });
  }
}
