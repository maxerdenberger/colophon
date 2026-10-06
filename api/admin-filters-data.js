// /api/admin-filters-data — returns unique disciplines and availability values
// from the bench sheet so admin dropdown filters match actual data.
//
// GET /api/admin-filters-data?auth=ADMIN_KEY
// Returns: { disciplines: [], availabilities: [] }

import { google } from 'googleapis';

const TAB_NAME = process.env.SHEETS_TAB_NAME || 'Form Responses 1';
const RANGE_ALL = `${TAB_NAME}!A:Z`;

const COL = {
  DISC: 5,
  OTHER_DISC: 6,
  AVAIL: 7,
  STATUS: 18,
};

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'method not allowed' });
  }

  const auth = req.query.auth || '';
  const adminKey = process.env.ADMIN_KEY || process.env.ADMIN_SECRET || '590Rossmore';
  if (auth !== adminKey) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  try {
    if (!process.env.SHEETS_SPREADSHEET_ID) {
      throw new Error('SHEETS_SPREADSHEET_ID not set');
    }
    if (!process.env.GOOGLE_SERVICE_EMAIL || !process.env.GOOGLE_PRIVATE_KEY) {
      throw new Error('Google auth not configured');
    }

    const googleAuth = new google.auth.JWT({
      email: process.env.GOOGLE_SERVICE_EMAIL,
      key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    });

    const sheets = google.sheets({ version: 'v4', auth: googleAuth });
    const result = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.SHEETS_SPREADSHEET_ID,
      range: RANGE_ALL,
    });

    const rows = result.data.values || [];
    const disciplines = new Set();
    const availabilities = new Set();

    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      if (!row || row.length < 19) continue;

      const status = (row[COL.STATUS] || '').trim().toLowerCase();

      // Only approved/active creatives
      if (status !== 'approved' && status !== 'active') continue;

      const disc = (row[COL.DISC] || '').trim();
      const otherDisc = (row[COL.OTHER_DISC] || '').trim();
      const avail = (row[COL.AVAIL] || '').trim();

      if (disc) disciplines.add(disc);
      if (otherDisc) disciplines.add(otherDisc);
      if (avail) availabilities.add(avail);
    }

    // Sort and deduplicate
    const sortedDisciplines = Array.from(disciplines)
      .filter(Boolean)
      .sort()
      .slice(0, 50); // Cap at 50 to avoid huge lists

    const sortedAvailabilities = Array.from(availabilities)
      .filter(Boolean)
      .sort();

    return res.status(200).json({
      disciplines: sortedDisciplines,
      availabilities: sortedAvailabilities,
    });
  } catch (err) {
    console.error('admin-filters-data error:', err);
    return res.status(500).json({ error: err.message || 'failed to fetch filter data' });
  }
}
