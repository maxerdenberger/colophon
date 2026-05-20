// /api/dedupe
//
// Marks specific bench rows as status='rejected' (canonical four-state).
// They disappear from the public bench but stay on the Sheet so the
// audit trail is preserved. Reversible — edit col S back to 'bench'
// on the row to restore.
//
// POST body:
//   { rows: [rowNumber, rowNumber, ...] }   — 1-indexed Sheet rows
//
// Returns:
//   { ok: true, marked: N }

import { google } from 'googleapis';
import { invalidateBenchCache } from './_utils/sheets-v2.js';

const TAB_NAME = process.env.SHEETS_TAB_NAME || 'Form Responses 1';

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
  if (!process.env.SHEETS_SPREADSHEET_ID || !process.env.GOOGLE_SERVICE_EMAIL || !process.env.GOOGLE_PRIVATE_KEY) {
    return res.status(501).json({ error: 'sheet credentials not configured' });
  }

  const body = req.body || {};
  const rowNums = Array.isArray(body.rows)
    ? body.rows.map((n) => parseInt(n, 10)).filter((n) => Number.isFinite(n) && n > 1)
    : [];
  if (!rowNums.length) return res.status(400).json({ error: 'no rows specified' });

  try {
    const auth2 = new google.auth.JWT({
      email: process.env.GOOGLE_SERVICE_EMAIL,
      key: String(process.env.GOOGLE_PRIVATE_KEY).replace(/\\n/g, '\n'),
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    const sheets = google.sheets({ version: 'v4', auth: auth2 });

    // One batchUpdate, status='rejected' on col S + Last Updated on col T
    const now = new Date().toISOString();
    const data = [];
    for (const n of rowNums) {
      data.push({ range: `${TAB_NAME}!S${n}`, values: [['rejected']] });
      data.push({ range: `${TAB_NAME}!T${n}`, values: [[now]] });
    }
    const r = await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: process.env.SHEETS_SPREADSHEET_ID,
      requestBody: { valueInputOption: 'RAW', data },
    });
    invalidateBenchCache();

    return res.status(200).json({
      ok: true,
      marked: rowNums.length,
      rows: rowNums,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'dedupe failed' });
  }
}
