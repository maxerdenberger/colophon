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

// Append a new row to the bench Sheet. Columns mirror the parser:
//   0 Timestamp · 1 Name · 2 Email · 3 Portfolio · 4 LinkedIn · 5 Disciplines
//   6 (empty)   · 7 Availability · 8 (empty) · 9 Hourly · 10 (empty) · 11 (empty)
//   12 Past Clients · 13 Exp Level · 14 (empty) · 15 Value Prop · 16 (empty)
//   17 Partners · 18 Status · 19 Last Updated · 20 Confirmed
// Returns { rowNumber, range } so callers can patch other columns later.
export async function appendBenchRow(fields) {
  if (!process.env.SHEETS_SPREADSHEET_ID) {
    throw new Error('SHEETS_SPREADSHEET_ID not configured');
  }
  const sheets = client();
  const now = new Date().toLocaleString('en-US', { timeZone: 'UTC' });
  const row = new Array(21).fill('');
  row[0]  = fields.timestamp    || now;
  row[1]  = fields.name         || '';
  row[2]  = fields.email        || '';
  row[3]  = fields.portfolio    || '';
  row[4]  = fields.linkedin     || '';
  row[5]  = fields.disciplines  || fields.discipline || '';
  // col G (index 6) — Timezone. Accepts a region word ('americas'|
  // 'europe'|'asia') or a UTC string ('UTC+8', 'UTC−5'). parseSheetCSV
  // resolves region words via REGION_TO_TZ on read.
  row[6]  = fields.timezone     || '';
  row[7]  = fields.availability || '';
  row[9]  = String(fields.hourlyRate || '');
  row[12] = fields.topClients   || fields.clients || '';
  row[13] = fields.expLevel     || '';
  row[15] = fields.summary      || fields.valueProp || '';
  row[17] = fields.partnerEmails || '';
  row[18] = fields.status       || 'active';
  row[19] = now;
  row[20] = fields.confirmed ? 'yes' : '';

  const res = await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.SHEETS_SPREADSHEET_ID,
    range: RANGE_ALL,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [row] },
  });
  const updatedRange = res.data && res.data.updates && res.data.updates.updatedRange;
  const m = updatedRange && updatedRange.match(/!A(\d+):/);
  const rowNumber = m ? parseInt(m[1], 10) : null;
  return { rowNumber, range: updatedRange };
}

// Patch only the columns we own.
//   availability → col H (index 7)
//   portfolio    → col D (3)
//   partners     → col R (17) — comma-joined emails
//   status       → col S (18)
export async function updateBenchRow(rowNumber, { availability, portfolio, partners, status }) {
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
  if (partners != null) {
    const value = Array.isArray(partners) ? partners.filter(Boolean).join(', ') : String(partners);
    data.push({
      range: `${TAB_NAME}!R${rowNumber}`,
      values: [[value]],
    });
  }
  if (status) {
    data.push({
      range: `${TAB_NAME}!S${rowNumber}`,
      values: [[status]],
    });
  }
  if (!data.length) return { updated: 0 };
  const res = await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: process.env.SHEETS_SPREADSHEET_ID,
    requestBody: { valueInputOption: 'RAW', data },
  });
  return { updated: res.data.totalUpdatedCells || 0 };
}
