// /api/dedupe
//
// Marks specific bench rows as status='duplicate'. The CSV parser then
// filters them out alongside 'cold' rows, so they disappear from the
// live bench, the bench browser, and any tokenized views — without
// being deleted from the Sheet (so the data is recoverable: edit col S
// back to 'active' on the row to restore).
//
// POST body:
//   { rows: [rowNumber, rowNumber, ...] }   — 1-indexed Sheet rows
//
// Returns:
//   { ok: true, marked: N }

import { google } from 'googleapis';

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

    // One batchUpdate, one cell per row (col S = status, index 18, A1 'S').
    const data = rowNums.map((n) => ({
      range: `${TAB_NAME}!S${n}`,
      values: [['duplicate']],
    }));
    const r = await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: process.env.SHEETS_SPREADSHEET_ID,
      requestBody: { valueInputOption: 'RAW', data },
    });

    return res.status(200).json({
      ok: true,
      marked: r.data.totalUpdatedCells || rowNums.length,
      rows: rowNums,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'dedupe failed' });
  }
}
