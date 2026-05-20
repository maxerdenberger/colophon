// sheets-v2.js — the clean rebuild of the bench data layer.
//
// Why a v2 file: the v1 helpers in ./sheets.js use hard-coded column
// indices (status at col S=18, etc). That broke whenever someone
// reordered or inserted a column. v2 reads the header row, maps
// header-text → column-index, and exposes everything by field name.
//
// One read of the Sheet powers everything downstream:
//   /api/bench   — GET, parses + filters by status
//   /api/queue   — GET, cross-references against Formspree submissions
//   /api/action  — POST, approve/reject/pause via email lookup (all dupes)
//
// All values flow through the canonical four-state vocabulary:
//   new       — landed, never touched (the queue)
//   bench     — approved, visible on the public bench
//   rejected  — never showing
//   paused    — was on bench, temporarily hidden
// Legacy values (approved | pending | denied | cold | duplicate | active)
// are accepted on read and silently translated.

import { google } from 'googleapis';

const TAB_NAME = process.env.SHEETS_TAB_NAME || 'Form Responses 1';

let _client;
function client() {
  if (_client) return _client;
  if (!process.env.GOOGLE_SERVICE_EMAIL || !process.env.GOOGLE_PRIVATE_KEY) {
    throw new Error('GOOGLE_SERVICE_EMAIL / GOOGLE_PRIVATE_KEY not configured');
  }
  const auth = new google.auth.JWT({
    email: process.env.GOOGLE_SERVICE_EMAIL,
    key: String(process.env.GOOGLE_PRIVATE_KEY).replace(/\\n/g, '\n'),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  _client = google.sheets({ version: 'v4', auth });
  return _client;
}

// Canonical → list of header-text aliases the user might have in the Sheet.
// Match is case-insensitive, whitespace-tolerant, punctuation-tolerant.
// First alias is the preferred display label.
const FIELD_ALIASES = {
  timestamp:   ['timestamp', 'date', 'submitted at', 'created at'],
  name:        ['name', 'full name', 'your name'],
  email:       ['email', 'email address', 'e-mail'],
  portfolio:   ['portfolio', 'portfolio link', 'professional portfolio link', 'website', 'site'],
  linkedin:    ['linkedin', 'linkedin profile url', 'linkedin url'],
  disciplines: ['disciplines', 'discipline', 'your top three creative disciplines, ranked', 'top disciplines'],
  otherDisc:   ['other discipline', 'other disciplines'],
  timezone:    ['timezone', 'time zone', 'working timezone', 'tz'],
  availability:['availability', 'availability ranges', 'current availability'],
  rateSection: ['rate section', 'rate band', 'rate range'],
  hourlyRate:  ['hourly rate', 'preferred standard hourly rate', 'rate', 'hourly'],
  minFee:      ['min fee', 'minimum fee', 'min project fee'],
  referral:    ['referral', 'referral context', 'referred by', 'who referred you'],
  topClients:  ['top clients', 'past clients', 'recent clients', 'clients'],
  expLevel:    ['exp level', 'experience level', 'experience', 'years of experience'],
  categories:  ['categories', 'tags'],
  valueProp:   ['value prop', 'summary', 'value proposition', 'about', 'bio'],
  partners:    ['partners', 'partner emails', 'collaborators'],
  status:      ['status'],
  lastUpdated: ['last updated', 'updated at', 'modified'],
  confirmed:   ['confirmed', 'confirmed at'],
  social:      ['social', 'social specialist', 'social-specialist'],
};

const _norm = (s) => String(s || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();

// Build a { fieldName → columnIndex } map by walking the header row and
// matching each cell against every alias. Headers not recognized get
// stashed under `_unknown` for diagnostics.
export function buildHeaderMap(headerRow) {
  const map = {};
  const unknown = [];
  const seen = new Set();
  const headers = (headerRow || []).map((h) => _norm(h));
  for (let i = 0; i < headers.length; i++) {
    const h = headers[i];
    if (!h) continue;
    let matched = null;
    for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
      if (seen.has(field)) continue;   // first match wins
      for (const a of aliases) {
        if (_norm(a) === h) { matched = field; break; }
      }
      if (matched) break;
    }
    if (matched) {
      map[matched] = i;
      seen.add(matched);
    } else {
      unknown.push({ index: i, header: headerRow[i] });
    }
  }
  return { map, unknown, headerCount: headers.length };
}

// Status normalization: canonical four-state + legacy → canonical.
// 'paused' stays paused (its own state).
const STATUS_CANON = {
  '':            'new',
  new:           'new',
  pending:       'new',
  bench:         'bench',
  approved:      'bench',
  active:        'bench',
  rejected:      'rejected',
  denied:        'rejected',
  cold:          'rejected',
  duplicate:     'rejected',
  paused:        'paused',
};

export function canonicalStatus(raw) {
  const v = String(raw || '').trim().toLowerCase();
  return STATUS_CANON[v] || 'new';
}

// In-memory cache shared across function invocations on the same warm
// instance. Vercel cold-start clears it, which is fine — cold starts
// already paid the sheets fetch.
const _benchCache = { rows: null, headerMap: null, ts: 0 };
const BENCH_TTL_MS = 15 * 1000;

export function invalidateBenchCache() { _benchCache.ts = 0; }

// Read the entire bench tab and parse every row into a typed object.
// Returns { rows, headerMap, builtAt }. Cached for 15s.
export async function readBench({ force = false } = {}) {
  const now = Date.now();
  if (!force && _benchCache.rows && (now - _benchCache.ts) < BENCH_TTL_MS) {
    return _benchCache;
  }
  if (!process.env.SHEETS_SPREADSHEET_ID) {
    throw new Error('SHEETS_SPREADSHEET_ID not configured');
  }
  const sheets = client();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.SHEETS_SPREADSHEET_ID,
    range: `${TAB_NAME}!A:AZ`,
  });
  const raw = res.data.values || [];
  if (raw.length < 1) {
    _benchCache.rows = [];
    _benchCache.headerMap = { map: {}, unknown: [], headerCount: 0 };
    _benchCache.ts = now;
    return _benchCache;
  }
  const header = raw[0];
  const headerMap = buildHeaderMap(header);
  const { map } = headerMap;
  const pick = (row, field) => {
    const i = map[field];
    return i == null ? '' : String(row[i] || '').trim();
  };

  const rows = [];
  for (let i = 1; i < raw.length; i++) {
    const r = raw[i];
    const email = pick(r, 'email').toLowerCase();
    const name = pick(r, 'name');
    // Skip completely empty rows
    if (!email && !name) continue;
    const statusRaw = pick(r, 'status');
    const status = canonicalStatus(statusRaw);
    const hourlyRateNum = (() => {
      const m = String(pick(r, 'hourlyRate')).match(/\d+/);
      return m ? parseInt(m[0], 10) : 0;
    })();
    const expRaw = pick(r, 'expLevel').toLowerCase();
    const yoeFromBucket = /12\+|veteran|executive/.test(expRaw) ? 15
              : /lead|principal|8.{0,3}12/.test(expRaw) ? 10
              : /senior|4.{0,3}7/.test(expRaw) ? 6
              : /junior|mid|1.{0,3}3/.test(expRaw) ? 2
              : 0;
    // Fallback: if no bucket matched, try to pull any number from the cell.
    // Handles entries like '20 years', '8-14 yrs', '7+', etc. — anything
    // numeric. Without this, every row whose expLevel column is free-text
    // (or empty) ends up with yoe=0 and gets filtered out of stats.
    const yoeFromNumber = (() => {
      const m = expRaw.match(/(\d+)/);
      return m ? parseInt(m[1], 10) : 0;
    })();
    const yoe = yoeFromBucket || yoeFromNumber;
    const social = (() => {
      const v = pick(r, 'social').toLowerCase();
      return v === 'yes' || v === 'true' || v === '1' || v === '♥';
    })();
    const lastUpdatedTs = (() => {
      const v = pick(r, 'lastUpdated');
      if (!v) return 0;
      const t = Date.parse(v);
      return Number.isFinite(t) ? t : 0;
    })();
    const tsCol = pick(r, 'timestamp');
    const createdAtTs = (() => {
      if (!tsCol) return 0;
      const t = Date.parse(tsCol);
      return Number.isFinite(t) ? t : 0;
    })();

    rows.push({
      rowNumber: i + 1,
      email,
      name,
      portfolio:    pick(r, 'portfolio'),
      linkedin:     pick(r, 'linkedin'),
      disciplines:  pick(r, 'disciplines'),
      timezone:     pick(r, 'timezone'),
      availability: pick(r, 'availability'),
      hourlyRate:   hourlyRateNum,
      minFee:       pick(r, 'minFee'),
      referral:     pick(r, 'referral'),
      topClients:   pick(r, 'topClients'),
      expLevel:     pick(r, 'expLevel'),
      yoe,
      categories:   pick(r, 'categories'),
      valueProp:    pick(r, 'valueProp'),
      partners:     pick(r, 'partners'),
      status,             // canonical: new | bench | rejected | paused
      statusRaw,          // whatever's actually in the cell, for debugging
      lastUpdatedTs,
      createdAtTs,
      confirmed:    pick(r, 'confirmed').toLowerCase() === 'yes',
      social,
    });
  }

  _benchCache.rows = rows;
  _benchCache.headerMap = headerMap;
  _benchCache.ts = now;
  return _benchCache;
}

// Look up all rows whose email matches (case-insensitive). Returns an array
// of { rowNumber, status } — empty if not found. The dedup-by-email
// invariant lives here: every mutation by email touches all matches.
export async function findRowsByEmail(email) {
  const target = String(email || '').trim().toLowerCase();
  if (!target.includes('@')) return [];
  const { rows } = await readBench();
  return rows.filter((r) => r.email === target).map((r) => ({
    rowNumber: r.rowNumber,
    status: r.status,
  }));
}

// Flip status on every row matching the given email. Also stamps the
// Last Updated column (if present). One batchUpdate call across all
// matches. Returns { rowsTouched, rowNumbers, newStatus }.
export async function setStatusByEmail(email, newStatus) {
  const target = String(email || '').trim().toLowerCase();
  if (!target.includes('@')) throw new Error('email required');
  const canon = canonicalStatus(newStatus);
  if (!['new','bench','rejected','paused'].includes(canon)) {
    throw new Error(`invalid status: ${newStatus}`);
  }
  const { rows, headerMap } = await readBench({ force: true });
  const { map } = headerMap;
  const statusCol = map.status;
  if (statusCol == null) throw new Error('no "Status" column found on Sheet — add it');
  const lastUpdatedCol = map.lastUpdated;
  const matched = rows.filter((r) => r.email === target).map((r) => r.rowNumber);
  if (!matched.length) return { rowsTouched: 0, rowNumbers: [], newStatus: canon };
  const sheets = client();
  const colLetter = (n) => {
    // Convert zero-indexed column number to letter (A, B, …, Z, AA, …).
    let s = '';
    n = n + 1;
    while (n > 0) {
      const mod = (n - 1) % 26;
      s = String.fromCharCode(65 + mod) + s;
      n = Math.floor((n - 1) / 26);
    }
    return s;
  };
  const now = new Date().toISOString();
  const data = [];
  for (const n of matched) {
    data.push({ range: `${TAB_NAME}!${colLetter(statusCol)}${n}`, values: [[canon]] });
    if (lastUpdatedCol != null) {
      data.push({ range: `${TAB_NAME}!${colLetter(lastUpdatedCol)}${n}`, values: [[now]] });
    }
  }
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: process.env.SHEETS_SPREADSHEET_ID,
    requestBody: { valueInputOption: 'RAW', data },
  });
  invalidateBenchCache();
  return { rowsTouched: matched.length, rowNumbers: matched, newStatus: canon };
}

// Append a new row. Used only when an action targets an email that
// isn't already on the Sheet (e.g. approving a Formspree submission
// from a brand-new applicant). Writes fields whose header columns exist;
// silently skips fields whose columns aren't in the Sheet.
export async function appendRow(fields) {
  const { headerMap } = await readBench({ force: true });
  const { map, headerCount } = headerMap;
  const sheets = client();
  const row = new Array(headerCount).fill('');
  const set = (field, value) => {
    const i = map[field];
    if (i == null || value == null) return;
    row[i] = typeof value === 'string' ? value : String(value);
  };
  set('timestamp',   fields.timestamp || new Date().toISOString());
  set('name',        fields.name);
  set('email',       fields.email);
  set('portfolio',   fields.portfolio);
  set('linkedin',    fields.linkedin);
  set('disciplines', fields.disciplines || fields.discipline);
  set('timezone',    fields.timezone || fields.tz);
  set('availability',fields.availability);
  set('hourlyRate',  fields.hourlyRate);
  set('minFee',      fields.minFee);
  set('referral',    fields.referral || fields.referralContext || fields.referrer);
  set('topClients',  fields.topClients || fields.clients);
  set('expLevel',    fields.expLevel);
  set('categories',  fields.categories);
  set('valueProp',   fields.valueProp || fields.summary);
  set('partners',    fields.partners || fields.partnerEmails);
  set('status',      canonicalStatus(fields.status || 'new'));
  set('lastUpdated', new Date().toISOString());
  set('confirmed',   fields.confirmed ? 'yes' : '');
  set('social',      fields.social ? 'yes' : '');
  const res = await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.SHEETS_SPREADSHEET_ID,
    range: `${TAB_NAME}!A:AZ`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [row] },
  });
  invalidateBenchCache();
  const m = res.data && res.data.updates && res.data.updates.updatedRange &&
            res.data.updates.updatedRange.match(/!A(\d+):/);
  return { rowNumber: m ? parseInt(m[1], 10) : null };
}

// Upsert: if email matches an existing row, flip its status; if not,
// append a new row with the supplied fields and the target status.
// Returns { rowsTouched, rowNumbers, mode: 'updated' | 'appended', newStatus }.
export async function upsertByEmail(fields, targetStatus) {
  const email = String(fields.email || '').trim().toLowerCase();
  if (!email.includes('@')) throw new Error('email required for upsert');
  const matches = await findRowsByEmail(email);
  if (matches.length) {
    const r = await setStatusByEmail(email, targetStatus);
    return { ...r, mode: 'updated' };
  }
  const appended = await appendRow({ ...fields, status: targetStatus });
  return {
    rowsTouched: 1,
    rowNumbers: appended.rowNumber ? [appended.rowNumber] : [],
    newStatus: canonicalStatus(targetStatus),
    mode: 'appended',
  };
}
