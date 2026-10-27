// /api/brief-stats
//
// Admin-only. Reads the Availability Pings sheet and returns per-brief
// stats grouped by Brief ID (column J). Used by the admin brief history
// panel to show sent / responded / response-rate per brief send.
//
// GET /api/brief-stats?limit=20
//
// Returns:
//   { briefs: [ { briefId, sent, responded, responseRate, firstSentAt, lastSentAt, recipients } ] }
//   Recipients: [ { name, email, respondedAt, response } ] — most recent first

import { google } from 'googleapis';

function client() {
  if (!process.env.GOOGLE_SERVICE_EMAIL || !process.env.GOOGLE_PRIVATE_KEY) {
    throw new Error('Google credentials not configured');
  }
  const auth = new google.auth.JWT({
    email: process.env.GOOGLE_SERVICE_EMAIL,
    key: String(process.env.GOOGLE_PRIVATE_KEY).replace(/\\n/g, '\n'),
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  return google.sheets({ version: 'v4', auth });
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

  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));

  try {
    const sheets = client();
    const r = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.SHEETS_SPREADSHEET_ID,
      range: 'Availability Pings!A:J',
    });
    const rows = (r.data && r.data.values) || [];
    if (rows.length <= 1) {
      return res.status(200).json({ briefs: [], total: 0 });
    }

    // cols: 0=Timestamp 1=Name 2=Email 3=EmailID 4=Status
    //       5=OpenedAt 6=RespondedAt 7=Response 8=PriorAvail 9=BriefID
    const data = rows.slice(1); // skip header

    const briefMap = new Map(); // briefId → { ... }

    for (const row of data) {
      const briefId     = String(row[9] || '').trim();
      const timestamp   = String(row[0] || '').trim();
      const name        = String(row[1] || '').trim();
      const email       = String(row[2] || '').trim();
      const respondedAt = String(row[6] || '').trim();
      const response    = String(row[7] || '').trim();

      if (!email) continue;

      // Rows without a briefId are from the periodic ping blast, not outreach
      const key = briefId || '__ping__';

      if (!briefMap.has(key)) {
        briefMap.set(key, {
          briefId: key,
          sent: 0,
          responded: 0,
          firstSentAt: timestamp,
          lastSentAt:  timestamp,
          recipients: [],
        });
      }

      const b = briefMap.get(key);
      b.sent++;
      if (respondedAt || response) b.responded++;
      if (timestamp && timestamp < b.firstSentAt) b.firstSentAt = timestamp;
      if (timestamp && timestamp > b.lastSentAt)  b.lastSentAt  = timestamp;
      b.recipients.push({ name, email, respondedAt, response });
    }

    // Build output — only actual brief sends (not __ping__), sorted newest first
    let briefs = [...briefMap.entries()]
      .filter(([key]) => key !== '__ping__')
      .map(([, b]) => ({
        ...b,
        responseRate: b.sent ? Math.round((b.responded / b.sent) * 100) : 0,
        recipients: b.recipients.slice(0, 40),
      }))
      .sort((a, b) => (b.lastSentAt > a.lastSentAt ? 1 : -1))
      .slice(0, limit);

    return res.status(200).json({ briefs, total: briefs.length });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'brief-stats failed' });
  }
}
