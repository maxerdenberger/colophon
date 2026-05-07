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
//   6 Timezone  · 7 Availability · 8 (empty) · 9 Hourly · 10 (empty) · 11 Referral
//   12 Past Clients · 13 Exp Level · 14 (empty) · 15 Value Prop · 16 (empty)
//   17 Partners · 18 Status · 19 Last Updated · 20 Confirmed · 21 Social
// Returns { rowNumber, range } so callers can patch other columns later.
export async function appendBenchRow(fields) {
  if (!process.env.SHEETS_SPREADSHEET_ID) {
    throw new Error('SHEETS_SPREADSHEET_ID not configured');
  }
  const sheets = client();
  const now = new Date().toLocaleString('en-US', { timeZone: 'UTC' });
  const row = new Array(22).fill('');
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
  // col L (index 11) — who referred them. Pulled from the apply form's
  // referralContext field (and any other referrer field bench-update may
  // pass through). Without this, the source of every approval is lost the
  // moment the row lands on the Sheet.
  row[11] = fields.referralContext || fields.referrer || fields.referral || '';
  row[12] = fields.topClients   || fields.clients || '';
  row[13] = fields.expLevel     || '';
  row[15] = fields.summary      || fields.valueProp || '';
  row[17] = fields.partnerEmails || '';
  row[18] = fields.status       || 'active';
  row[19] = now;
  row[20] = fields.confirmed ? 'yes' : '';
  // Col 21 — social-specialist flag from the apply form's heart toggle.
  row[21] = fields.social ? 'yes' : '';

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

// ───────────────────────────────────────────────────────────────────────────
// Status-only updates. The single source of truth for whether a row is on
// the public bench. Values used:
//   'approved'   — visible on the public bench (the only state that shows).
//   'pending'    — submitted/imported, not yet reviewed. Hidden from public.
//   'denied'     — explicitly rejected. Hidden.
//   'cold'       — auto-archived after 99 days of no update. Hidden.
//   'duplicate'  — merged into another row. Hidden.
// (Legacy 'active' is treated as 'approved' by the parser for backward compat,
// but new writes always use the explicit values above.)

// Update one row's status by email. Returns { updated, rowNumber } or
// { updated: 0, rowNumber: null } if the email wasn't found.
export async function updateBenchStatusByEmail(email, newStatus) {
  const target = String(email || '').trim().toLowerCase();
  if (!target.includes('@')) throw new Error('email required');
  const VALID = ['approved', 'pending', 'denied', 'cold', 'duplicate'];
  if (!VALID.includes(newStatus)) throw new Error(`invalid status: ${newStatus}`);
  const found = await findBenchRowByEmail(target);
  if (!found) return { updated: 0, rowNumber: null };
  const r = await updateBenchRow(found.rowNumber, { status: newStatus });
  return { updated: r.updated, rowNumber: found.rowNumber };
}

// Bulk migration. Reads the entire bench, sets every row's status:
//   - emails listed in `approvedEmails` (case-insensitive) → 'approved'
//   - everything else currently 'active' or empty           → 'pending'
//   - existing 'cold'/'duplicate'/'denied' rows are untouched
// One batchUpdate call → fast even on hundreds of rows.
export async function migrateApprovalsBulk(approvedEmails) {
  if (!process.env.SHEETS_SPREADSHEET_ID) throw new Error('SHEETS_SPREADSHEET_ID not configured');
  const sheets = client();
  const approvedSet = new Set((approvedEmails || []).map((e) => String(e || '').trim().toLowerCase()).filter(Boolean));
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.SHEETS_SPREADSHEET_ID,
    range: RANGE_ALL,
  });
  const rows = res.data.values || [];
  const data = [];
  let approvedCount = 0, pendingCount = 0, untouchedCount = 0;
  // i=1 skips header row
  for (let i = 1; i < rows.length; i++) {
    const email = String(rows[i][2] || '').trim().toLowerCase();
    const currentStatus = String(rows[i][18] || '').trim().toLowerCase();
    let nextStatus = null;
    if (approvedSet.has(email)) {
      if (currentStatus !== 'approved') nextStatus = 'approved';
      approvedCount++;
    } else if (currentStatus === 'cold' || currentStatus === 'duplicate' || currentStatus === 'denied') {
      untouchedCount++;
    } else {
      // 'active', '', 'approved' (orphaned), or unknown → 'pending'
      if (currentStatus !== 'pending') nextStatus = 'pending';
      pendingCount++;
    }
    if (nextStatus) {
      data.push({
        range: `${TAB_NAME}!S${i + 1}`,
        values: [[nextStatus]],
      });
    }
  }
  if (data.length) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: process.env.SHEETS_SPREADSHEET_ID,
      requestBody: { valueInputOption: 'RAW', data },
    });
  }
  return {
    cellsUpdated: data.length,
    approvedRows: approvedCount,
    pendingRows: pendingCount,
    untouchedRows: untouchedCount,
    totalRows: rows.length - 1,
  };
}

// Returns a map of {emailLowercased -> status} for every row on the bench
// Sheet. Used by /api/submissions to filter out Formspree submissions that
// have already been promoted into the Sheet (any status — approved, pending,
// denied, cold, duplicate). Empty rows skipped.
export async function getBenchEmailMap() {
  if (!process.env.SHEETS_SPREADSHEET_ID) {
    throw new Error('SHEETS_SPREADSHEET_ID not configured');
  }
  const sheets = client();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.SHEETS_SPREADSHEET_ID,
    range: RANGE_ALL,
  });
  const rows = res.data.values || [];
  const map = new Map();
  for (let i = 1; i < rows.length; i++) {
    const email = String(rows[i][2] || '').trim().toLowerCase();
    if (!email || !email.includes('@')) continue;
    const status = String(rows[i][18] || '').trim().toLowerCase() || 'pending';
    // First-write wins so we don't get confused by duplicates; the bench
    // browser's de-dupe step handles those separately.
    if (!map.has(email)) map.set(email, status);
  }
  return map;
}


// ───────────────────────────────────────────────────────────────────────────
// Referral audit log. Captures the two-referral block on /invite (one
// creative + one hirer) so we have a queryable record of who's been
// recommended and by whom — instead of the data sitting in the operator's
// admin email forever.
//
// Auto-creates the 'Referrals' tab on first call so no manual sheet setup.

let _referralsTabReady = false;

async function ensureTab(sheets, tabName, headers) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId: process.env.SHEETS_SPREADSHEET_ID });
  const exists = (meta.data.sheets || []).some((sh) => sh.properties && sh.properties.title === tabName);
  if (exists) return;
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: process.env.SHEETS_SPREADSHEET_ID,
    requestBody: { requests: [{ addSheet: { properties: { title: tabName } } }] },
  });
  if (headers && headers.length) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: process.env.SHEETS_SPREADSHEET_ID,
      range: `${tabName}!A1`,
      valueInputOption: 'RAW',
      requestBody: { values: [headers] },
    });
  }
}

// entries: [{ timestamp, referrer, referrerEmail, type, name, contact, org, status }]
//   type    = 'creative' | 'hirer'
//   status  = 'new' (default) — caller can set 'reached-out' / 'converted' etc.
// Returns { appended }.
export async function appendReferralLog(entries) {
  if (!process.env.SHEETS_SPREADSHEET_ID) {
    throw new Error('SHEETS_SPREADSHEET_ID not configured');
  }
  if (!Array.isArray(entries) || !entries.length) return { appended: 0 };
  const sheets = client();
  const TAB = 'Referrals';
  if (!_referralsTabReady) {
    await ensureTab(sheets, TAB, [
      'Timestamp','Referrer','Referrer Email','Type','Referred Name',
      'Referred Contact','Referred Org','Status','Notes',
    ]);
    _referralsTabReady = true;
  }
  const now = new Date().toISOString();
  const rows = entries.map((e) => [
    e.timestamp || now,
    e.referrer || '',
    e.referrerEmail || '',
    e.type || '',
    e.name || '',
    e.contact || '',
    e.org || '',
    e.status || 'new',
    e.notes || '',
  ]);
  await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.SHEETS_SPREADSHEET_ID,
    range: `${TAB}!A:I`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: rows },
  });
  return { appended: rows.length };
}
