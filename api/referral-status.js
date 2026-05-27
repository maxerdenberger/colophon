// /api/referral-status
//
// Admin-only readback of the Referrals tab. Each row in that tab carries
// a 'Notes' column that the auto-invite code writes its outcome into:
//   - 'auto-invited'                — invite email shipped via Resend
//   - 'auto-invite-failed: <err>'   — Resend errored
//   - 'auto-invite-error: <err>'    — exception thrown
//   - 'activation'                  — came in via the /activate flow
//   - (empty)                       — older row, predates auto-invite
//
// Returns each referral with a derived `inviteState`:
//   - 'sent'        — auto-invited
//   - 'failed'      — auto-invite-failed / auto-invite-error
//   - 'skipped'     — contact wasn't an email (linkedin / handle / blank)
//   - 'unknown'     — older row, no notes captured
//
// Auth: ADMIN_KEY → ADMIN_SECRET → '590Rossmore'

import { google } from 'googleapis';

const REFERRALS_TAB = 'Referrals';

function sheetsClient() {
  return google.sheets({
    version: 'v4',
    auth: new google.auth.JWT({
      email: process.env.GOOGLE_SERVICE_EMAIL,
      key: String(process.env.GOOGLE_PRIVATE_KEY).replace(/\\n/g, '\n'),
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    }),
  });
}

function looksLikeEmail(s) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || '').trim());
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
  if (!process.env.SHEETS_SPREADSHEET_ID) {
    return res.status(501).json({ error: 'SHEETS_SPREADSHEET_ID not configured' });
  }

  try {
    const sheets = sheetsClient();
    const r = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.SHEETS_SPREADSHEET_ID,
      range: `${REFERRALS_TAB}!A:I`,
    });
    const rows = r.data.values || [];
    if (rows.length < 2) {
      return res.status(200).json({ count: 0, summary: {}, referrals: [] });
    }
    const header = rows[0].map((h) => String(h || '').trim().toLowerCase());
    const idx = (k) => header.indexOf(k);
    const cTs        = idx('timestamp');
    const cRefBy     = idx('referrer');
    const cRefByEm   = idx('referrer email');
    const cType      = idx('type');
    const cRefName   = idx('referred name');
    const cRefCt     = idx('referred contact');
    const cRefOrg    = idx('referred org');
    const cStatus    = idx('status');
    const cNotes     = idx('notes');

    const referrals = rows.slice(1).map((row, i) => {
      const ts        = cTs       >= 0 ? row[cTs]       : '';
      const referrer  = cRefBy    >= 0 ? row[cRefBy]    : '';
      const refByEm   = cRefByEm  >= 0 ? row[cRefByEm]  : '';
      const type      = cType     >= 0 ? row[cType]     : '';
      const name      = cRefName  >= 0 ? row[cRefName]  : '';
      const contact   = cRefCt    >= 0 ? row[cRefCt]    : '';
      const org       = cRefOrg   >= 0 ? row[cRefOrg]   : '';
      const status    = cStatus   >= 0 ? row[cStatus]   : '';
      const notes     = cNotes    >= 0 ? row[cNotes]    : '';
      const notesLc   = String(notes || '').toLowerCase();

      // Derive invite state from the notes field. Hirer-type rows
      // don't get auto-invites (they're sales leads, not creatives) —
      // mark those as 'n/a' so the panel doesn't flag them as missed.
      let inviteState;
      if (type === 'hirer') {
        inviteState = 'n/a';
      } else if (notesLc.includes('auto-invite-failed') || notesLc.includes('auto-invite-error')) {
        inviteState = 'failed';
      } else if (notesLc.includes('auto-invited')) {
        inviteState = 'sent';
      } else if (!looksLikeEmail(contact)) {
        inviteState = 'skipped';   // linkedin or handle, no email to send
      } else {
        // Email contact, but notes is empty — either pre-auto-invite era,
        // or the invite was never fired. Either way, surface for action.
        inviteState = 'unknown';
      }

      return { rowNumber: i + 2, ts, referrer, referrerEmail: refByEm, type, name, contact, org, status, notes, inviteState };
    });

    const summary = referrals.reduce((acc, r) => {
      acc[r.inviteState] = (acc[r.inviteState] || 0) + 1;
      return acc;
    }, {});

    // Newest first for the panel.
    referrals.sort((a, b) => (Date.parse(b.ts) || 0) - (Date.parse(a.ts) || 0));

    return res.status(200).json({
      count: referrals.length,
      summary,
      referrals,
      ts: new Date().toISOString(),
    });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'referral-status read failed' });
  }
}
