// Availability ping — run by Vercel cron (see vercel.json) or manually by an
// admin via Authorization: Bearer ADMIN_KEY.
//
// Cadence (per recipient, evaluated each run):
//   • New joiners (joined within last 60 days):    ping every 20 days
//   • Established (joined 60+ days ago):           ping every 45 days
//   • No response in 99+ days:                     send the COLD-STORAGE
//                                                  email and mark status=cold
//
// "Joined date"   → timestamp column (col 0).
// "Last updated"  → col 19 (set whenever a ping fires, an invite-confirm
//                    arrives, or the admin nudges the row).
// "Status"        → col 18. Untouched defaults to 'active'.
//
// Cold members are excluded from public bench counts and table rows by
// parseSheetCSV in index.html, but they keep their row so they can
// self-reactivate via the cold-email link.
//
// Env vars expected (already configured for the rest of the API):
//   RESEND_API_KEY, GOOGLE_SERVICE_EMAIL, GOOGLE_PRIVATE_KEY,
//   SHEETS_SPREADSHEET_ID, SHEETS_TAB_NAME (optional, default below),
//   ADMIN_KEY (or legacy ADMIN_SECRET) — for manual invocation.

import { Resend } from 'resend';
import { google } from 'googleapis';

const resend = new Resend(process.env.RESEND_API_KEY);
const FROM = 'Colophon <bench@colophon.contact>';
const TAB_NAME = process.env.SHEETS_TAB_NAME || 'Form Responses 1';

const COL = {
  timestamp:   0,
  name:        1,
  email:       2,
  // 3 portfolio · 4 linkedin · 5 discipline · 7 availability · 9 hourly · …
  status:      18,
  lastUpdated: 19,
};

const DAY = 86_400_000;
const NEW_JOINER_DAYS = 60;
const NEW_CADENCE_DAYS = 20;
const ESTAB_CADENCE_DAYS = 45;
const COLD_THRESHOLD_DAYS = 99;

let _sheets;
function sheetsClient() {
  if (_sheets) return _sheets;
  if (!process.env.GOOGLE_SERVICE_EMAIL || !process.env.GOOGLE_PRIVATE_KEY) {
    throw new Error('GOOGLE_SERVICE_EMAIL / GOOGLE_PRIVATE_KEY missing');
  }
  if (!process.env.SHEETS_SPREADSHEET_ID) {
    throw new Error('SHEETS_SPREADSHEET_ID missing');
  }
  const auth = new google.auth.JWT({
    email: process.env.GOOGLE_SERVICE_EMAIL,
    key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  _sheets = google.sheets({ version: 'v4', auth });
  return _sheets;
}

async function readAllRows() {
  const sheets = sheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.SHEETS_SPREADSHEET_ID,
    range: `${TAB_NAME}!A:Z`,
  });
  return res.data.values || [];
}

const colLetter = (n) => {
  let s = '';
  n = n + 1;
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
};

async function writeStatusAndStamp(rowNumber, status, isoStamp) {
  const sheets = sheetsClient();
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: process.env.SHEETS_SPREADSHEET_ID,
    requestBody: {
      valueInputOption: 'RAW',
      data: [
        { range: `${TAB_NAME}!${colLetter(COL.status)}${rowNumber}`,      values: [[status]] },
        { range: `${TAB_NAME}!${colLetter(COL.lastUpdated)}${rowNumber}`, values: [[isoStamp]] },
      ],
    },
  });
}

const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function emailShell(bodyHtml) {
  // Aligns with the latest palette: cream surface, ink type, accent dot logo.
  return `
<!doctype html>
<html lang="en">
<body style="margin:0;background:#FAFAF8;font-family:'IBM Plex Mono',ui-monospace,Menlo,monospace;color:#0d0d0b;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#FAFAF8;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="background:#FAFAF8;border:1px solid rgba(13,13,11,0.08);max-width:560px;">
        <tr><td style="padding:24px 28px;border-bottom:1px solid rgba(13,13,11,0.08);">
          <span style="font-family:'Space Grotesk',sans-serif;font-weight:700;font-size:18px;letter-spacing:-0.02em;color:#0d0d0b;">colo<span style="color:#FF5100;">phon</span></span>
        </td></tr>
        <tr><td style="padding:28px 28px 24px;line-height:1.7;font-size:14px;color:#0d0d0b;">
          ${bodyHtml}
        </td></tr>
        <tr><td style="padding:18px 28px;border-top:1px solid rgba(13,13,11,0.08);background:#F2EDE4;text-align:center;">
          <div style="display:inline-block;width:10px;height:10px;border-radius:50%;background:#FF5100;"></div>
          <div style="font-family:'IBM Plex Mono',monospace;font-size:10px;letter-spacing:0.14em;color:rgba(13,13,11,0.5);text-transform:uppercase;margin-top:8px;">colophon · the bench</div>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

const standardPingEmail = (name, email) => {
  const confirmUrl = `https://colophon.contact/invite?confirm=1&email=${encodeURIComponent(email)}`;
  const body = `
    <p style="margin:0 0 14px;">${esc(name) || 'hi'},</p>
    <p style="margin:0 0 14px;">quick check-in — still on the bench? a yes keeps you in front of buyers; a tap on the link below stamps your row as current and keeps you out of cold storage.</p>
    <p style="margin:0 0 18px;"><a href="${confirmUrl}" style="display:inline-block;padding:12px 18px;background:#0d0d0b;color:#FAFAF8;text-decoration:none;border-radius:6px;font-size:12px;letter-spacing:0.06em;">yes, keep me on the bench →</a></p>
    <p style="margin:0 0 0;font-size:12px;color:rgba(13,13,11,0.6);">no reply for 99 days and we'll move you to cold storage. you can self-reactivate any time.</p>`;
  return { subject: 'colophon · still on the bench?', html: emailShell(body) };
};

// 30-day reactivation token. Server-side /api/update validates and flips
// status back to 'active' + bumps lastUpdated.
const mintReactivateToken = (email) => {
  const payload = JSON.stringify({ email, exp: Date.now() + 30 * DAY });
  return Buffer.from(payload).toString('base64url');
};

const coldStorageEmail = (name, email, rowNumber) => {
  const token = mintReactivateToken(email);
  const primaryUrl = `https://colophon.contact/api/update?id=${rowNumber}&status=available&token=${encodeURIComponent(token)}`;
  const ghostUrl   = `https://colophon.contact/invite?name=${encodeURIComponent(name || '')}`;
  const html = `<!doctype html>
<html lang="en">
<body style="margin:0;background:#f4f1ec;font-family:Georgia,'Times New Roman',serif;color:#0d0d0b;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f4f1ec;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="background:#f4f1ec;max-width:560px;">
        <tr><td style="padding:24px 28px;">
          <span style="font-family:Georgia,'Times New Roman',serif;font-weight:bold;font-size:18px;color:#0d0d0b;">colo<span style="color:#FF5100;">phon</span></span>
        </td></tr>
        <tr><td style="padding:0 28px 8px;line-height:1.6;font-size:16px;color:#0d0d0b;">
          <p style="margin:0 0 18px;font-size:22px;line-height:1.25;font-style:italic;">you've gone cold on the bench.</p>
          <p style="margin:0 0 14px;">you haven't updated your status in 99 days. we've moved you to the cold bench — you won't appear in searches until you confirm you're still active.</p>
          <p style="margin:0 0 22px;">come back whenever you're ready. one tap is all it takes.</p>
        </td></tr>
        <tr><td style="padding:0 28px 12px;">
          <a href="${primaryUrl}" style="display:block;width:100%;padding:16px 18px;background:#0d0d0b;color:#f4f1ec;text-decoration:none;text-align:center;font-family:Georgia,'Times New Roman',serif;font-size:14px;box-sizing:border-box;">i'm back on the bench →</a>
        </td></tr>
        <tr><td style="padding:0 28px 18px;font-size:12px;color:rgba(13,13,11,0.55);line-height:1.6;">
          your profile and history are preserved. nothing is deleted.
        </td></tr>
        <tr><td style="padding:0 28px 28px;">
          <a href="${ghostUrl}" style="display:block;width:100%;padding:14px 18px;background:transparent;color:#0d0d0b;border:1px solid #0d0d0b;text-decoration:none;text-align:center;font-family:Georgia,'Times New Roman',serif;font-size:14px;box-sizing:border-box;">update my availability instead →</a>
        </td></tr>
        <tr><td style="padding:18px 28px;border-top:1px solid rgba(13,13,11,0.12);text-align:center;">
          <div style="display:inline-block;width:10px;height:10px;border-radius:50%;background:#FF5100;"></div>
          <div style="font-family:Georgia,'Times New Roman',serif;font-size:11px;color:rgba(13,13,11,0.5);margin-top:8px;">colophon · the bench</div>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
  return { subject: "you've gone cold on the bench.", html };
};

export default async function handler(req, res) {
  // Allow:
  //   • Vercel cron (no auth header in current Vercel cron runtime; requests
  //     come from an internal IP — we accept GETs without a body)
  //   • Admin manual run via Bearer ADMIN_KEY
  const adminKey = process.env.ADMIN_KEY || process.env.ADMIN_SECRET;
  const auth = req.headers.authorization || '';
  const isAdmin = adminKey && auth === `Bearer ${adminKey}`;
  const isCron = req.method === 'GET' && (req.headers['user-agent'] || '').includes('vercel-cron');
  if (!isAdmin && !isCron) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  try {
    const rows = await readAllRows();
    const now = Date.now();
    const dryRun = req.query?.dryRun === '1' || req.query?.dry === '1';
    const log = { sent: 0, cold: 0, skipped: 0, errors: [], decisions: [] };

    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      const rowNumber = i + 1;
      const email = (r[COL.email] || '').trim();
      const name  = (r[COL.name] || '').trim();
      if (!email || !email.includes('@')) { log.skipped++; continue; }

      const status = (r[COL.status] || 'active').toLowerCase();
      if (status === 'cold') { log.skipped++; continue; }

      const joinedAt = Date.parse(r[COL.timestamp]) || 0;
      if (!joinedAt) { log.skipped++; continue; }
      const lastUpdated = Date.parse(r[COL.lastUpdated]) || joinedAt;

      const daysFromJoin     = (now - joinedAt)    / DAY;
      const daysSinceUpdate  = (now - lastUpdated) / DAY;

      let action = null;
      if (daysSinceUpdate >= COLD_THRESHOLD_DAYS) {
        action = 'cold';
      } else if (daysFromJoin <= NEW_JOINER_DAYS && daysSinceUpdate >= NEW_CADENCE_DAYS) {
        action = 'ping-new';
      } else if (daysFromJoin > NEW_JOINER_DAYS && daysSinceUpdate >= ESTAB_CADENCE_DAYS) {
        action = 'ping-estab';
      }

      if (!action) { log.skipped++; continue; }

      log.decisions.push({ row: rowNumber, email, action, daysFromJoin: +daysFromJoin.toFixed(1), daysSinceUpdate: +daysSinceUpdate.toFixed(1) });
      if (dryRun) continue;

      try {
        if (action === 'cold') {
          const e = coldStorageEmail(name, email, rowNumber);
          await resend.emails.send({ from: FROM, to: email, subject: e.subject, html: e.html });
          await writeStatusAndStamp(rowNumber, 'cold', new Date().toISOString());
          log.cold++;
        } else {
          const e = standardPingEmail(name, email);
          await resend.emails.send({ from: FROM, to: email, subject: e.subject, html: e.html });
          // Stamp the ping itself; recipient must confirm to reset further.
          await writeStatusAndStamp(rowNumber, 'active', new Date().toISOString());
          log.sent++;
        }
      } catch (ex) {
        log.errors.push({ email, error: ex.message || String(ex) });
      }
    }

    return res.status(200).json(log);
  } catch (ex) {
    return res.status(500).json({ error: ex.message || String(ex) });
  }
}
