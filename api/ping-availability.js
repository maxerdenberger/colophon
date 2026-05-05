// /api/ping-availability
//
// Admin-only bulk send. Walks the Sheet for every status='approved' row
// and emails each creative an availability-update prompt with three
// one-click buttons (available now / soon / booked). Each button hyperlinks
// to /api/update-availability?email=<>&token=<HMAC>&value=<>; the token is
// a stable HMAC of email+secret so the same link works forever for that
// recipient (and only their row).
//
// Body (optional): { dryRun: true } — returns the recipient list without
// sending, so the operator can preview before triggering the real send.

import { Resend } from 'resend';
import crypto from 'crypto';
import { google } from 'googleapis';

const FROM = 'Colophon <bench@colophon.contact>';
const REPLY_TO = 'bench@colophon.contact';
const SITE = 'https://colophon.contact';

function tokenFor(email) {
  const secret = process.env.AVAILABILITY_TOKEN_SECRET || process.env.ADMIN_KEY || '590Rossmore';
  return crypto.createHmac('sha256', secret).update(String(email).trim().toLowerCase()).digest('hex').slice(0, 32);
}

const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function buildEmail(name, email) {
  const firstName = String(name || '').trim().split(/\s+/)[0] || 'there';
  const tok = tokenFor(email);
  const link = (value) => `${SITE}/api/update-availability?email=${encodeURIComponent(email)}&token=${tok}&value=${encodeURIComponent(value)}`;
  const subject = `${firstName.charAt(0).toUpperCase() + firstName.slice(1)}, quick availability update?`;
  const text = [
    `Hi ${firstName},`,
    ``,
    `quick one — the bench runs in real time. tap whichever line fits today — your status updates now. no reply needed.`,
    ``,
    `Available now:           ${link('available')}`,
    `Available in 2–4 weeks:  ${link('soon')}`,
    `Booked / waitlist:       ${link('booked')}`,
    ``,
    `— Max`,
    `Colophon · ${SITE}`,
  ].join('\n');

  const safeFirst = esc(firstName);
  const html = `<!doctype html>
<html>
<head>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@700&display=swap" rel="stylesheet">
</head>
<body style="margin:0;padding:0;background:#f4ede2;">
  <div style="background:#f4ede2;padding:48px 24px;font-family:Georgia,'Times New Roman',serif;color:#0d1014;">
    <div style="max-width:560px;margin:0 auto;font-size:16px;line-height:1.7;">
      <div style="margin:0 0 28px;text-align:left;">
        <div style="margin:0 0 12px;line-height:0;">
          <span style="display:inline-block;width:24px;height:24px;background:#f4ede2;border:1.5px solid #0d1014;border-radius:50%;box-sizing:border-box;text-align:center;line-height:20px;"><span style="display:inline-block;width:9px;height:9px;background:#FF5100;border-radius:50%;vertical-align:1px;"></span></span>
        </div>
        <div style="font-family:'Space Grotesk','Helvetica Neue',Helvetica,Arial,sans-serif;font-weight:700;font-size:26px;letter-spacing:-0.02em;color:#0d1014;line-height:1;">colo<span style="color:#FF5100;">phon</span></div>
      </div>
      <p style="font-size:11px;letter-spacing:0.18em;color:#888580;text-transform:uppercase;margin:0 0 24px;font-family:'IBM Plex Mono','Menlo',monospace;">availability check-in</p>
      <p style="margin:0 0 16px;">Hi ${safeFirst},</p>
      <p style="margin:0 0 24px;">Quick one — the bench runs in real time. Tap whichever line fits today — your status updates now. No reply needed.</p>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 28px;">
        <tr><td style="padding:0 0 10px;">
          <a href="${link('available')}" style="display:block;background:#3F7F4A;color:#f4ede2;padding:14px 18px;text-decoration:none;font-family:'IBM Plex Mono','Menlo',monospace;font-size:13px;letter-spacing:0.04em;border-radius:2px;text-align:left;">
            <strong style="font-weight:500;">available now</strong> &nbsp;·&nbsp; <span style="opacity:0.85;">ready for the next thing</span>
          </a>
        </td></tr>
        <tr><td style="padding:0 0 10px;">
          <a href="${link('soon')}" style="display:block;background:#C87C18;color:#f4ede2;padding:14px 18px;text-decoration:none;font-family:'IBM Plex Mono','Menlo',monospace;font-size:13px;letter-spacing:0.04em;border-radius:2px;text-align:left;">
            <strong style="font-weight:500;">available in 2–4 weeks</strong> &nbsp;·&nbsp; <span style="opacity:0.85;">finishing one thing first</span>
          </a>
        </td></tr>
        <tr><td>
          <a href="${link('booked')}" style="display:block;background:#0d1014;color:#f4ede2;padding:14px 18px;text-decoration:none;font-family:'IBM Plex Mono','Menlo',monospace;font-size:13px;letter-spacing:0.04em;border-radius:2px;text-align:left;">
            <strong style="font-weight:500;">booked / waitlist only</strong> &nbsp;·&nbsp; <span style="opacity:0.85;">not taking inbound for now</span>
          </a>
        </td></tr>
      </table>
      <p style="margin:0 0 8px;">Thanks,</p>
      <p style="margin:0 0 32px;">— Max</p>
      <p style="font-size:11px;color:#888580;font-family:'IBM Plex Mono','Menlo',monospace;letter-spacing:0.04em;text-transform:uppercase;margin:0;">colophon · <a href="${SITE}" style="color:#888580;text-decoration:underline;">${SITE.replace(/^https?:\/\//, '')}</a></p>
    </div>
  </div>
</body>
</html>`;
  return { subject, text, html };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method not allowed' });
  }
  const auth = req.headers.authorization || '';
  const adminKey = process.env.ADMIN_KEY || process.env.ADMIN_SECRET || '590Rossmore';
  if (auth !== `Bearer ${adminKey}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  if (!process.env.RESEND_API_KEY) {
    return res.status(501).json({ error: 'RESEND_API_KEY not set on Vercel' });
  }
  if (!process.env.GOOGLE_SERVICE_EMAIL || !process.env.GOOGLE_PRIVATE_KEY || !process.env.SHEETS_SPREADSHEET_ID) {
    return res.status(501).json({ error: 'Google Sheets env vars not set' });
  }

  const dryRun = !!(req.body && req.body.dryRun);

  // Pull the Sheet directly (bypasses the 5-min publish-to-web cache).
  let approvedRows = [];
  try {
    const auth2 = new google.auth.JWT({
      email: process.env.GOOGLE_SERVICE_EMAIL,
      key: String(process.env.GOOGLE_PRIVATE_KEY).replace(/\\n/g, '\n'),
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    });
    const sheets = google.sheets({ version: 'v4', auth: auth2 });
    const TAB = process.env.SHEETS_TAB_NAME || 'Form Responses 1';
    const r = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.SHEETS_SPREADSHEET_ID,
      range: `${TAB}!A:Z`,
    });
    const rows = r.data.values || [];
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const email = String(row[2] || '').trim();
      const name = String(row[1] || '').trim();
      const status = String(row[18] || '').trim().toLowerCase();
      // 'active' is the legacy synonym for 'approved' (parser bridges it).
      if ((status === 'approved' || status === 'active') && email.includes('@')) {
        approvedRows.push({ email, name, rowNumber: i + 1 });
      }
    }
  } catch (err) {
    return res.status(500).json({ error: `sheet read failed: ${err.message}` });
  }

  // Drop the operator's own email so we don't ping ourselves on every run.
  const operatorEmails = new Set(
    (process.env.OPERATOR_EMAIL || 'merdenberger@gmail.com')
      .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
  );
  approvedRows = approvedRows.filter((r) => !operatorEmails.has(r.email.toLowerCase()));

  if (dryRun) {
    return res.status(200).json({
      ok: true, dryRun: true,
      recipientCount: approvedRows.length,
      recipients: approvedRows.slice(0, 10).map((r) => ({ name: r.name, email: r.email })),
      note: approvedRows.length > 10 ? `+${approvedRows.length - 10} more` : '',
    });
  }

  const resend = new Resend(process.env.RESEND_API_KEY);
  let sent = 0, failed = 0;
  const failures = [];
  for (const r of approvedRows) {
    try {
      const msg = buildEmail(r.name, r.email);
      await resend.emails.send({
        from: FROM,
        to: r.email,
        replyTo: REPLY_TO,
        subject: msg.subject,
        text: msg.text,
        html: msg.html,
      });
      sent++;
    } catch (err) {
      failed++;
      failures.push({ email: r.email, error: err.message || 'send failed' });
    }
  }

  return res.status(200).json({
    ok: true,
    sent, failed,
    recipientCount: approvedRows.length,
    failures: failures.slice(0, 12),
  });
}
