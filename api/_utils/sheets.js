// Google Sheets write helper. Authenticates with the service-account creds
// already in the project's Vercel env (GOOGLE_SERVICE_EMAIL, GOOGLE_PRIVATE_KEY,
// SHEETS_SPREADSHEET_ID). Used by /api/invite-confirm to live-update an
// existing bench row when the recipient is matched by email.
//
// Schema (zero-indexed columns, mirrors the existing CSV parser):
//   0 Timestamp  1 Name  2 Email  3 Portfolio  4 LinkedIn  5 Discipline
//   6 Other-disc 7 Availability   8 Rate-section  9 Hourly  10 Min Fee
//   11 Referral  12 Top Clients   13 Exp Level    14 Categories  15 Value Prop

import { google } from 'googleapis';

const TAB_NAME = process.env.SHEETS_TAB_NAME || 'Form Responses 1';
const RANGE_ALL = `${TAB_NAME}!A:Z`;

let _client; // memoize across invocations on the same warm instance
function client() {
  if (_client) return _client;
  if (!process.env.GOOGLE_SERVICE_EMAIL || !process.env.GOOGLE_PRIVATE_KEY) {
    throw new Error('GOOGLE_SERVICE_EMAIL / GOOGLE_PRIVATE_KEY not configured');
  }
  const auth = new google.auth.JWT({
    email: process.env.GOOGLE_SERVICE_EMAIL,
    key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  _client = google.sheets({ version: 'v4', auth });
  return _client;
}

// Find a row by email (col index 2). Returns 1-indexed row number for Sheets
// API, or null if not found.
export async function findBenchRowByEmail(email) {
  if (!process.env.SHEETS_SPREADSHEET_ID) {
    throw new Error('SHEETS_SPREADSHEET_ID not configured');
  }
  const sheets = client();
  const target = String(email || '').trim().toLowerCase();
  if (!target || !target.includes('@')) return null;

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.SHEETS_SPREADSHEET_ID,
    range: RANGE_ALL,
  });
  const rows = res.data.values || [];
  for (let i = 1; i < rows.length; i++) {
    const cell = (rows[i][2] || '').trim().toLowerCase();
    if (cell === target) {
      return { rowNumber: i + 1, row: rows[i] };
    }
  }
  return null;
}

// Map the form's UI strings → values that the existing CSV parser will read
// back as 'available' / 'soon' / 'booked'.
const AVAIL_MAP = {
  'Available now':            'Immediate (ready to start within 1 week)',
  'Available in 1–2 weeks':   '2–4 Weeks Out',
  'Booked / waitlist only':   'Waitlist Only (currently booked)',
};

// Patch only the columns we own. availability → col H (index 7), portfolio → col D (3).
export async function updateBenchRow(rowNumber, { availability, portfolio }) {
  const sheets = client();
  const data = [];
  if (availability) {
    data.push({
      range: `${TAB_NAME}!H${rowNumber}`,
      values: [[AVAIL_MAP[availability] || availability]],
    });
  }
  if (portfolio && portfolio.trim()) {
    data.push({
      range: `${TAB_NAME}!D${rowNumber}`,
      values: [[portfolio.trim()]],
    });
  }
  if (!data.length) return { updated: 0 };
  const res = await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: process.env.SHEETS_SPREADSHEET_ID,
    requestBody: { valueInputOption: 'RAW', data },
  });
  return { updated: res.data.totalUpdatedCells || 0 };
}
