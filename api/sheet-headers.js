// /api/sheet-headers
//
// Writes header labels to row 1 for the columns this app added on top
// of the original Google Form schema. Idempotent — running twice just
// re-writes the same labels.
//
// Columns set:
//   R (17) — Partners
//   S (18) — Status
//   T (19) — Last Updated
//   U (20) — Confirmed
//
// Existing form-generated headers in cols A–P (timestamp, name, email,
// portfolio, linkedin, etc.) are left alone.

import { google } from 'googleapis';

const TAB_NAME = process.env.SHEETS_TAB_NAME || 'Form Responses 1';

const HEADERS = [
  { col: 'R', label: 'Partners' },
  { col: 'S', label: 'Status' },
  { col: 'T', label: 'Last Updated' },
  { col: 'U', label: 'Confirmed' },
];

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

  try {
    const auth2 = new google.auth.JWT({
      email: process.env.GOOGLE_SERVICE_EMAIL,
      key: String(process.env.GOOGLE_PRIVATE_KEY).replace(/\\n/g, '\n'),
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    const sheets = google.sheets({ version: 'v4', auth: auth2 });

    const data = HEADERS.map((h) => ({
      range: `${TAB_NAME}!${h.col}1`,
      values: [[h.label]],
    }));
    const r = await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: process.env.SHEETS_SPREADSHEET_ID,
      requestBody: { valueInputOption: 'RAW', data },
    });

    return res.status(200).json({
      ok: true,
      updated: r.data.totalUpdatedCells || 0,
      headers: HEADERS,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'header write failed' });
  }
}
