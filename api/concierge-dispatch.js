// /api/concierge-dispatch
//
// Cron-friendly endpoint that pings the operator (you) when a concierge
// brief has been waiting too long without a response. Triggered by
// Vercel cron (see vercel.json) or by hitting the URL manually.
//
// Logic:
//   1. Pull recent concierge briefs from Formspree
//   2. Pull rows from the concierge_log sheet (records of replies sent)
//   3. For any brief older than ALERT_THRESHOLD_MIN that has no log row,
//      send a Resend email to OPERATOR_EMAIL with brief preview + admin
//      link.
//   4. To avoid pinging the same brief repeatedly, only alert briefs in
//      the [threshold, threshold + bucketWindow] window — so a 30-min
//      cron with a 30-min threshold pings each brief exactly once.
//
// Env vars used:
//   FORMSPREE_API_KEY, FORMSPREE_FORM_ID  (defaults to xqenzjew)
//   RESEND_API_KEY
//   OPERATOR_EMAIL  (where to send the dispatch — defaults to merdenberger@gmail.com)
//   GOOGLE_SERVICE_EMAIL / GOOGLE_PRIVATE_KEY / SHEETS_SPREADSHEET_ID
//   CONCIERGE_LOG_TAB  (defaults to "concierge_log")
//   ALERT_THRESHOLD_MIN  (defaults to 30)
//
// Auth:
//   Vercel Cron sends a special header. Allow that.
//   Otherwise require Bearer ADMIN_KEY for manual triggers.

import { Resend } from 'resend';
import { google } from 'googleapis';

const DEFAULT_OPERATOR = 'merdenberger@gmail.com';
const DEFAULT_THRESHOLD_MIN = 30;
const BUCKET_WINDOW_MIN = 60;
const FROM = 'Colophon dispatch <bench@colophon.contact>';

export default async function handler(req, res) {
  // Allow Vercel cron OR admin Bearer.
  const cronAuth = req.headers['x-vercel-cron'] === '1' || req.headers['user-agent']?.includes('vercel-cron');
  if (!cronAuth) {
    const auth = req.headers.authorization || '';
    const adminKey = process.env.ADMIN_KEY || process.env.ADMIN_SECRET || '590Rossmore';
    if (auth !== `Bearer ${adminKey}`) {
      return res.status(401).json({ error: 'unauthorized' });
    }
  }

  const formspreeKey = process.env.FORMSPREE_API_KEY;
  const formId = process.env.FORMSPREE_FORM_ID || 'xqenzjew';
  const resendKey = process.env.RESEND_API_KEY;
  const opEmail = process.env.OPERATOR_EMAIL || DEFAULT_OPERATOR;
  const threshold = Number(process.env.ALERT_THRESHOLD_MIN || DEFAULT_THRESHOLD_MIN);

  if (!formspreeKey) return res.status(501).json({ error: 'FORMSPREE_API_KEY not set' });
  if (!resendKey)    return res.status(501).json({ error: 'RESEND_API_KEY not set' });

  // ── 1. Pull recent Formspree submissions (concierge-brief source) ────
  let briefs = [];
  try {
    const looksLikeFormLevelKey = /^[0-9a-f]{16,}$/i.test(formspreeKey);
    const authHeader = looksLikeFormLevelKey
      ? `Basic ${Buffer.from(`${formspreeKey}:`).toString('base64')}`
      : `Bearer ${formspreeKey}`;
    const r = await fetch(`https://formspree.io/api/0/forms/${encodeURIComponent(formId)}/submissions`, {
      headers: { Authorization: authHeader, Accept: 'application/json' },
    });
    const text = await r.text();
    let j = null; try { j = text ? JSON.parse(text) : null; } catch {}
    const all = (j && (j.submissions || j.data)) || [];
    briefs = all.filter((s) => {
      const data = (s.data || s);
      return ((data.source || s.source || '').toLowerCase() === 'concierge-brief');
    });
  } catch (err) {
    return res.status(502).json({ error: 'formspree fetch failed: ' + err.message });
  }

  // ── 2. Pull existing replies from the log sheet ──────────────────────
  const replied = new Set();
  try {
    if (process.env.GOOGLE_SERVICE_EMAIL && process.env.GOOGLE_PRIVATE_KEY && process.env.SHEETS_SPREADSHEET_ID) {
      const auth2 = new google.auth.JWT({
        email: process.env.GOOGLE_SERVICE_EMAIL,
        key: String(process.env.GOOGLE_PRIVATE_KEY).replace(/\\n/g, '\n'),
        scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
      });
      const sheets = google.sheets({ version: 'v4', auth: auth2 });
      const tab = process.env.CONCIERGE_LOG_TAB || 'concierge_log';
      const r = await sheets.spreadsheets.values.get({
        spreadsheetId: process.env.SHEETS_SPREADSHEET_ID,
        range: `${tab}!B:B`,  // submission_id column
      });
      const rows = (r.data && r.data.values) || [];
      for (const row of rows) if (row[0]) replied.add(row[0]);
    }
  } catch {
    // If the log tab doesn't exist yet, treat everything as unanswered.
  }

  // ── 3. Find unanswered briefs in the alert window ────────────────────
  const now = Date.now();
  const cutoffOldest = now - (threshold + BUCKET_WINDOW_MIN) * 60_000;
  const cutoffNewest = now - threshold * 60_000;
  const toAlert = briefs.filter((s) => {
    if (replied.has(String(s.id))) return false;
    const ts = s.submitted_at ? Date.parse(s.submitted_at) : 0;
    if (!ts) return false;
    return ts >= cutoffOldest && ts <= cutoffNewest;
  });

  if (!toAlert.length) {
    return res.status(200).json({ ok: true, alerted: 0, considered: briefs.length });
  }

  // ── 4. Send a Resend dispatch email per unanswered brief ─────────────
  const resend = new Resend(resendKey);
  const sent = [];
  for (const s of toAlert) {
    const data = s.data || s;
    const minsOld = Math.floor((now - Date.parse(s.submitted_at)) / 60_000);
    const briefExcerpt = (data.brief || '').slice(0, 280);
    const html = `
      <div style="font-family:Georgia,'Times New Roman',serif;color:#0d1014;background:#f4ede2;padding:32px 20px;">
        <div style="max-width:520px;margin:0 auto;">
          <p style="font-size:11px;letter-spacing:0.14em;color:#7a4a0e;text-transform:uppercase;margin-bottom:14px;">colophon dispatch · concierge brief unanswered</p>
          <h1 style="font-family:'Space Grotesk',Georgia,serif;font-weight:700;font-size:24px;letter-spacing:-0.02em;line-height:1.1;margin-bottom:14px;">${esc(data.name || '(no name)')} sent a brief ${minsOld}m ago.</h1>
          <p style="font-size:14px;line-height:1.7;margin-bottom:8px;"><strong>${esc(data.email || '')}</strong>${data.company ? ' · ' + esc(data.company) : ''}</p>
          <p style="font-size:13px;line-height:1.7;color:#3D3C38;margin-bottom:6px;">${[data.timing && 'timing: ' + esc(data.timing), data.budget && 'budget: ' + esc(data.budget)].filter(Boolean).join(' · ')}</p>
          <p style="font-size:14px;line-height:1.65;font-style:italic;border-left:3px solid #ff5100;padding-left:14px;margin:18px 0;">${esc(briefExcerpt)}${(data.brief || '').length > 280 ? '…' : ''}</p>
          <p style="font-size:14px;line-height:1.65;margin-top:24px;">
            <a href="https://colophon.contact/admin" style="color:#0d1014;text-decoration:underline;">Open admin → match queue</a>
          </p>
          <p style="font-size:11px;color:#888580;margin-top:24px;">Stripe paid $199. SLA is 4 hours from submission. This dispatch fires once per brief at the ${threshold}-min mark.</p>
        </div>
      </div>`;
    try {
      await resend.emails.send({
        from: FROM,
        to: opEmail,
        replyTo: data.email || REPLY_TO,
        subject: `[Colophon] ${data.name || 'concierge'} brief — ${minsOld}m unanswered`,
        html,
      });
      sent.push(s.id);
    } catch (err) {
      // log + continue
      console.error('dispatch send failed', s.id, err.message);
    }
  }

  return res.status(200).json({ ok: true, alerted: sent.length, ids: sent, considered: briefs.length });
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

const REPLY_TO = 'bench@colophon.contact';
