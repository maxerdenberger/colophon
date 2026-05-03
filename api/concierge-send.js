// /api/concierge-send
//
// Sends the drafted concierge reply via Resend, and writes a row to a
// "concierge_log" tab in the bench spreadsheet so the dispatch cron
// knows this brief was answered. The "responded in X" indicator in the
// admin UI is browser-local; the Sheet log is for cross-device truth.
//
// POST body:
//   {
//     to:         string  (buyer's email)
//     subject:    string
//     body:       string  (plain text)
//     submissionId: string (Formspree id — also written to the log)
//     submittedAt:  string|number (ISO or ms — used for response-time)
//   }

import { Resend } from 'resend';
import { google } from 'googleapis';

const FROM = 'Colophon <bench@colophon.contact>';
const REPLY_TO = 'bench@colophon.contact';

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
    return res.status(501).json({ error: 'RESEND_API_KEY not configured on Vercel' });
  }

  const body = req.body || {};
  const to = String(body.to || '').trim();
  const subject = String(body.subject || '').trim();
  const text = String(body.body || '').trim();
  if (!to.includes('@') || !subject || !text) {
    return res.status(400).json({ error: 'missing to / subject / body' });
  }

  const resend = new Resend(process.env.RESEND_API_KEY);

  // Plain text + a minimal HTML conversion (preserves line breaks +
  // makes the bespoke URL clickable). Keeps the email feeling personal.
  const html = `<div style="font-family:Georgia,'Times New Roman',serif;color:#0d1014;background:#f4ede2;padding:48px 24px;"><div style="max-width:520px;margin:0 auto;font-size:16px;line-height:1.7;white-space:pre-wrap;">${escapeHtml(text).replace(/(https?:\/\/\S+)/g, '<a href="$1" style="color:#0d1014;text-decoration:underline;">$1</a>')}</div></div>`;

  let sentId = null;
  try {
    const r = await resend.emails.send({
      from: FROM,
      to,
      replyTo: REPLY_TO,
      subject,
      text,
      html,
    });
    sentId = r && r.data && r.data.id;
  } catch (err) {
    return res.status(502).json({ error: err.message || 'resend send failed' });
  }

  // Best-effort: write to concierge_log Sheet so the dispatch cron can
  // see this brief was answered. Failures here don't block the response.
  let logged = false;
  try {
    if (process.env.GOOGLE_SERVICE_EMAIL && process.env.GOOGLE_PRIVATE_KEY && process.env.SHEETS_SPREADSHEET_ID) {
      const auth2 = new google.auth.JWT({
        email: process.env.GOOGLE_SERVICE_EMAIL,
        key: String(process.env.GOOGLE_PRIVATE_KEY).replace(/\\n/g, '\n'),
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
      });
      const sheets = google.sheets({ version: 'v4', auth: auth2 });
      const tab = process.env.CONCIERGE_LOG_TAB || 'concierge_log';
      const submittedMs = Number(body.submittedAt) || (body.submittedAt ? Date.parse(body.submittedAt) : 0);
      const sentMs = Date.now();
      const responseSeconds = submittedMs ? Math.floor((sentMs - submittedMs) / 1000) : '';
      await sheets.spreadsheets.values.append({
        spreadsheetId: process.env.SHEETS_SPREADSHEET_ID,
        range: `${tab}!A:F`,
        valueInputOption: 'RAW',
        insertDataOption: 'INSERT_ROWS',
        requestBody: {
          values: [[
            new Date(sentMs).toISOString(),
            String(body.submissionId || ''),
            to,
            subject,
            sentId || '',
            responseSeconds,
          ]],
        },
      });
      logged = true;
    }
  } catch {
    // Sheet log failure is not fatal — the email still went out.
  }

  return res.status(200).json({ ok: true, id: sentId, logged });
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
