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
  if (auth !== process.env.ADMIN_KEY) {
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

    const sheets = google.sheets({ version: 'v4', googleAuth });
    const result = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.SHEETS_SPREADSHEET_ID,
      range: RANGE_ALL,
    });

    const rows = result.data.values || [];
    const disciplines = new Set();
    const availabilities = new Set();

    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const status = (row[COL.STATUS] || '').trim().toLowerCase();

      // Only approved/active creatives
      if (status !== 'approved' && status !== 'active') continue;

      const disc = (row[COL.DISC] ||
git add api/admin-filters-data.js
git commit -m "Add admin filters data API"
git push origin main
git add api/admin-filters-data.js
git commit -m "Add admin filters data API"
git push origin main


