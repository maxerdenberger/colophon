// /api/audit-duplicates
//
// Returns an audit of duplicate bench rows, grouped by lowercased
// email. For each duplicate group we identify the most-recent row
// (by col-A timestamp) and tag the rest as stale.
//
// Read-only — no Sheet mutations. The admin merges manually in their
// own system; this endpoint just surfaces what to consolidate.
//
// Returns:
//   {
//     totalRows: number,
//     duplicateGroups: number,
//     groups: [
//       {
//         email: string,
//         count: number,
//         keep:  { rowNumber, timestamp, name, ... },
//         stale: [ { rowNumber, timestamp, name, ... }, ... ]
//       }
//     ]
//   }

import { google } from 'googleapis';

const TAB_NAME = process.env.SHEETS_TAB_NAME || 'Form Responses 1';
const RANGE_ALL = `${TAB_NAME}!A:U`;

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'method not allowed' });
  }

  const auth = req.headers.authorization || '';
  const adminKey = process.env.ADMIN_KEY || process.env.ADMIN_SECRET || '590Rossmore';
  if (auth !== `Bearer ${adminKey}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  if (!process.env.SHEETS_SPREADSHEET_ID || !process.env.GOOGLE_SERVICE_EMAIL || !process.env.GOOGLE_PRIVATE_KEY) {
    return res.status(501).json({ error: 'sheet credentials not configured' });
  }

  try {
    const auth2 = new google.auth.JWT({
      email: process.env.GOOGLE_SERVICE_EMAIL,
      key: String(process.env.GOOGLE_PRIVATE_KEY).replace(/\\n/g, '\n'),
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    });
    const sheets = google.sheets({ version: 'v4', auth: auth2 });
    const r = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.SHEETS_SPREADSHEET_ID,
      range: RANGE_ALL,
    });
    const rows = (r.data && r.data.values) || [];
    if (!rows.length) return res.status(200).json({ totalRows: 0, duplicateGroups: 0, groups: [] });

    // Skip header (row 1). Group by lowercased email.
    const byEmail = new Map();
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const email = String(row[2] || '').trim().toLowerCase();
      if (!email || !email.includes('@')) continue;
      const list = byEmail.get(email) || [];
      list.push({
        rowNumber: i + 1,            // Sheets API is 1-indexed
        timestamp: row[0] || '',
        timestampMs: Date.parse(row[0] || '') || 0,
        name: row[1] || '',
        portfolio: row[3] || '',
        linkedin: row[4] || '',
        disciplines: row[5] || '',
        availability: row[7] || '',
        hourlyRate: row[9] || '',
        clients: row[12] || '',
        expLevel: row[13] || '',
        valueProp: row[15] || '',
        partners: row[17] || '',
        status: row[18] || '',
        confirmed: row[20] || '',
      });
      byEmail.set(email, list);
    }

    const groups = [];
    for (const [email, list] of byEmail) {
      if (list.length < 2) continue;
      // Most recent first (largest timestampMs wins; falls back to row order)
      list.sort((a, b) => (b.timestampMs - a.timestampMs) || (b.rowNumber - a.rowNumber));
      const [keep, ...stale] = list;
      groups.push({ email, count: list.length, keep, stale });
    }

    // Most-affected groups first.
    groups.sort((a, b) => b.count - a.count);

    return res.status(200).json({
      totalRows: rows.length - 1,
      duplicateGroups: groups.length,
      duplicateRows: groups.reduce((s, g) => s + g.stale.length, 0),
      groups,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'audit failed' });
  }
}
