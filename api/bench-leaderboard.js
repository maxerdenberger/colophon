// /api/bench-leaderboard
//
// Returns bench members ranked by a responsiveness + freshness score.
// Used by the admin leaderboard panel.
//
// Score (0–100):
//   responsiveness = pings_responded / pings_sent  (default 1.0 if never pinged)
//   freshness      = max(0, 1 - daysSinceUpdate / 30)
//   score          = (responsiveness * 60) + (freshness * 40)
//
// GET /api/bench-leaderboard

import { google } from 'googleapis';
import { readBench } from './_utils/sheets-v2.js';

let _client;
function client() {
  if (_client) return _client;
  const auth = new google.auth.JWT({
    email: process.env.GOOGLE_SERVICE_EMAIL,
    key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  _client = google.sheets({ version: 'v4', auth });
  return _client;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'method not allowed' });
  }
  const auth     = req.headers.authorization || '';
  const adminKey = process.env.ADMIN_KEY || process.env.ADMIN_SECRET || '590Rossmore';
  if (auth !== `Bearer ${adminKey}`) return res.status(401).json({ error: 'unauthorized' });

  // 1. Bench members
  let benchRows;
  try {
    const { rows } = await readBench();
    benchRows = rows.filter(r => r.status === 'bench' && r.email);
  } catch (err) {
    return res.status(502).json({ error: 'bench read failed: ' + err.message });
  }

  // 2. Availability Pings — ping counts + last response per email
  let pingStats = new Map(); // email → { sent, responded, yes, lastPingedAt, lastRespondedAt }
  try {
    const sheets = client();
    const r = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.SHEETS_SPREADSHEET_ID,
      range: 'Availability Pings!A:J',
    });
    const rows = (r.data.values || []).slice(1);
    for (const row of rows) {
      const email       = String(row[2] || '').trim().toLowerCase();
      const timestamp   = String(row[0] || '').trim();
      const respondedAt = String(row[6] || '').trim();
      const response    = String(row[7] || '').trim();
      if (!email) continue;
      if (!pingStats.has(email)) pingStats.set(email, { sent: 0, responded: 0, yes: 0, lastPingedAt: '', lastRespondedAt: '' });
      const s = pingStats.get(email);
      s.sent++;
      if (timestamp > s.lastPingedAt) s.lastPingedAt = timestamp;
      if (respondedAt) {
        s.responded++;
        if (respondedAt > s.lastRespondedAt) s.lastRespondedAt = respondedAt;
        if (/available/i.test(response)) s.yes++;
      }
    }
  } catch { /* pings unavailable — scores will be freshness-only */ }

  const now = Date.now();
  const DAY = 86400000;

  const scored = benchRows.map(r => {
    const email = r.email.toLowerCase();
    const ps    = pingStats.get(email) || { sent: 0, responded: 0, yes: 0, lastPingedAt: '', lastRespondedAt: '' };

    const lastUpdatedMs  = r.lastUpdated ? Date.parse(r.lastUpdated) : 0;
    const daysSinceUpdate = lastUpdatedMs ? (now - lastUpdatedMs) / DAY : 999;

    const responsiveness = ps.sent > 0 ? ps.responded / ps.sent : 1.0;
    const freshness      = Math.max(0, 1 - daysSinceUpdate / 30);
    const score          = Math.round(responsiveness * 60 + freshness * 40);

    const discs = String(r.disciplines || '').split(/[,;\/]+/).map(s => s.trim()).filter(Boolean);

    return {
      name:             r.name || '',
      email:            r.email || '',
      discipline:       discs[0] || '',
      availability:     r.availability || '',
      rateTier:         r.hourlyRate >= 400 ? '$$$$' : r.hourlyRate >= 250 ? '$$$' : r.hourlyRate >= 150 ? '$$' : r.hourlyRate > 0 ? '$' : '',
      hourlyRate:       r.hourlyRate || 0,
      score,
      responsiveness:   Math.round(responsiveness * 100),
      freshness:        Math.round(freshness * 100),
      daysSinceUpdate:  Math.round(daysSinceUpdate),
      pingsSent:        ps.sent,
      pingsResponded:   ps.responded,
      yesCount:         ps.yes,
      lastRespondedAt:  ps.lastRespondedAt,
      lastUpdated:      r.lastUpdated || '',
    };
  });

  scored.sort((a, b) => b.score - a.score);

  return res.status(200).json({ ok: true, members: scored });
}
