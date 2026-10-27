// /api/brief-history
//
// Returns a per-brief summary derived from the Availability Pings tab.
// Each brief entry shows: id, firedAt, sent, responded, responseRate, rows.
//
// GET /api/brief-history
//   Returns all briefs (most recent first).
//   Query: ?briefId=<id> — return only rows for one brief.
//
// Availability Pings columns (0-indexed):
//   A 0 Timestamp · B 1 Name · C 2 Email · D 3 Email ID
//   E 4 Status    · F 5 Opened At · G 6 Responded At
//   H 7 Response  · I 8 Prior Availability · J 9 Brief ID

import { google } from 'googleapis';

let _client;
function client() {
  if (_client) return _client;
  if (!process.env.GOOGLE_SERVICE_EMAIL || !process.env.GOOGLE_PRIVATE_KEY) {
    throw new Error('GOOGLE_SERVICE_EMAIL / GOOGLE_PRIVATE_KEY not configured');
  }
  const auth = new google.auth.JWT({
    email: process.env.GOOGLE_SERVICE_EMAIL,
    key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  _client = google.sheets({ version: 'v4', auth });
  return _client;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'method not allowed' });
  }

  const auth     = req.headers.authorization || '';
  const adminKey = process.env.ADMIN_KEY || process.env.ADMIN_SECRET || '590Rossmore';
  if (auth !== `Bearer ${adminKey}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  if (!process.env.SHEETS_SPREADSHEET_ID) {
    return res.status(501).json({ error: 'SHEETS_SPREADSHEET_ID not configured' });
  }

  const filterBriefId = String(req.query?.briefId || '').trim();

  let rawRows;
  try {
    const sheets = client();
    const r = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.SHEETS_SPREADSHEET_ID,
      range: 'Availability Pings!A:J',
    });
    rawRows = r.data.values || [];
  } catch (err) {
    return res.status(502).json({ error: 'sheet read failed: ' + err.message });
  }

  // Skip header row (index 0)
  const pings = [];
  for (let i = 1; i < rawRows.length; i++) {
    const r = rawRows[i];
    const briefId = String(r[9] || '').trim();
    if (!briefId) continue;
    if (filterBriefId && briefId !== filterBriefId) continue;
    pings.push({
      timestamp:         String(r[0] || '').trim(),
      name:              String(r[1] || '').trim(),
      email:             String(r[2] || '').trim(),
      emailId:           String(r[3] || '').trim(),
      status:            String(r[4] || '').trim(),
      openedAt:          String(r[5] || '').trim(),
      respondedAt:       String(r[6] || '').trim(),
      response:          String(r[7] || '').trim(),
      priorAvailability: String(r[8] || '').trim(),
      briefId,
    });
  }

  // Group by briefId
  const briefs = new Map();
  for (const p of pings) {
    if (!briefs.has(p.briefId)) {
      briefs.set(p.briefId, {
        briefId:    p.briefId,
        firedAt:    p.timestamp,
        sent:       0,
        opened:     0,
        responded:  0,
        yesCount:   0,
        noCount:    0,
        rows:       [],
      });
    }
    const b = briefs.get(p.briefId);
    // firedAt = earliest timestamp in the brief
    if (p.timestamp && (!b.firedAt || p.timestamp < b.firedAt)) b.firedAt = p.timestamp;
    b.sent++;
    if (p.openedAt) b.opened++;
    if (p.respondedAt) b.responded++;
    if (/available/i.test(p.response)) b.yesCount++;
    if (/booked/i.test(p.response)) b.noCount++;
    b.rows.push(p);
  }

  // Sort rows within each brief by timestamp
  for (const b of briefs.values()) {
    b.rows.sort((a, z) => (a.timestamp > z.timestamp ? 1 : -1));
    b.responseRate = b.sent > 0 ? Math.round((b.responded / b.sent) * 100) : 0;
    b.openRate     = b.sent > 0 ? Math.round((b.opened   / b.sent) * 100) : 0;
  }

  // Sort briefs newest first
  const sorted = [...briefs.values()].sort((a, z) => (a.firedAt > z.firedAt ? -1 : 1));

  return res.status(200).json({ ok: true, briefs: sorted });
}
