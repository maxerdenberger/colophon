// /api/bench-freshness
//
// Admin-only. Returns the current bench grouped into freshness buckets
// (fresh < 7d, aging 7–30d, stale 30d+) plus a stale-first sorted list
// so the operator can see at-a-glance who needs the next availability ping.
//
// Optional: ?withPings=1 also reads the Availability Pings tab and
// aggregates engagement stats (pinged / responded / open-trackable IDs)
// so the freshness card in admin can show "last blast: 100 pinged, 23
// responded" without a second round-trip.

import { getBenchFreshness } from './_utils/sheets.js';
import { google } from 'googleapis';

const PINGS_TAB = 'Availability Pings';

async function readPings() {
  if (!process.env.SHEETS_SPREADSHEET_ID) return { rows: [] };
  const auth = new google.auth.JWT({
    email: process.env.GOOGLE_SERVICE_EMAIL,
    key: String(process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  const sheets = google.sheets({ version: 'v4', auth });
  try {
    const r = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.SHEETS_SPREADSHEET_ID,
      range: `${PINGS_TAB}!A:I`,
    });
    return { rows: r.data.values || [] };
  } catch {
    // Tab doesn't exist yet — first ping not fired
    return { rows: [], missing: true };
  }
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'method not allowed' });
  }
  const auth = req.headers.authorization || '';
  const adminKey = process.env.ADMIN_KEY || process.env.ADMIN_SECRET || '590Rossmore';
  if (auth !== `Bearer ${adminKey}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  try {
    const freshness = await getBenchFreshness();

    let pings = null;
    if (req.query.withPings === '1') {
      const { rows, missing } = await readPings();
      if (missing) {
        pings = { missing: true, sent: 0, responded: 0, lastBlastAt: null, ids: [] };
      } else {
        // Schema: [Timestamp, Name, Email, Email ID, Status, Opened At,
        //          Responded At, Response, Prior Availability]
        let sent = 0, responded = 0, lastBlastAt = 0;
        const ids = [];
        const recent = [];
        for (let i = 1; i < rows.length; i++) {
          const r = rows[i];
          const ts = Date.parse(String(r[0] || '').trim()) || 0;
          if (ts > lastBlastAt) lastBlastAt = ts;
          if (String(r[4] || '').toLowerCase() === 'sent') sent++;
          if (String(r[6] || '').trim()) responded++;
          if (r[3]) ids.push(r[3]);
          recent.push({
            timestamp: r[0] || '',
            name:      r[1] || '',
            email:     r[2] || '',
            emailId:   r[3] || '',
            status:    r[4] || '',
            respondedAt: r[6] || '',
            response:    r[7] || '',
          });
        }
        // Sort recent desc by timestamp, cap at 50 so the response stays small
        recent.sort((a, b) => (Date.parse(b.timestamp) || 0) - (Date.parse(a.timestamp) || 0));
        pings = {
          sent,
          responded,
          responseRate: sent > 0 ? Math.round((responded / sent) * 100) : 0,
          lastBlastAt:  lastBlastAt ? new Date(lastBlastAt).toISOString() : null,
          ids:    ids.slice(-200),   // most-recent 200 for Resend events lookup
          recent: recent.slice(0, 50),
        };
      }
    }

    return res.status(200).json({
      ...freshness,
      ...(pings ? { pings } : {}),
      builtAt: new Date().toISOString(),
    });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'freshness fetch failed' });
  }
}
