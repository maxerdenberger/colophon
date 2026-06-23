// /api/brief-outreach
//
// Brief-driven outbound to candidates on the bench. Distinct from /api/ping
// (which runs a periodic cadence) and from the concierge flow (which replies
// to the buyer with curated picks). This endpoint is fired manually from
// Cowork — the operator pastes a brief, Cowork filters the bench against
// it, drafts a personalized soft-availability email per candidate, and
// posts the rendered batch here for delivery.
//
// Soft-availability tone: the brand stays redacted, only discipline +
// industry hint + timeline are shared. Replies land at bench@colophon.contact
// (forwarded to the operator inbox).
//
// SMS — channel='sms' is reserved for the Thanksgiving milestone. Today it
// returns 400; the param exists so the caller-side contract is stable when
// Twilio gets wired in.
//
// POST body:
//   {
//     briefId:    string   caller-supplied identifier; tagged on each send
//                          and useful for querying Resend's log later.
//     channel?:   'email'  default 'email'. 'sms' rejected until wired.
//     recipients: [
//       {
//         rowNumber?: number   1-indexed bench-sheet row, used to stamp
//                              Last Pinged. Omit to skip the stamp.
//         name:       string
//         email:      string
//         subject:    string   already personalized by caller
//         text:       string   already personalized; wrapped to HTML here
//       },
//     ]
//   }
//
// Query flags:
//   ?dryRun=1   skip resend send + sheet stamp; report what would have run.
//
// Returns:
//   { ok, sent, failed, results: [{email, id?, error?, stamped?: bool}] }

import { Resend } from 'resend';
import { stampLastPinged } from './_utils/sheets.js';

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
  const briefId = String(body.briefId || '').trim();
  const channel = String(body.channel || 'email').toLowerCase();
  const recipients = Array.isArray(body.recipients) ? body.recipients : [];

  if (!briefId)            return res.status(400).json({ error: 'missing briefId' });
  if (channel === 'sms')   return res.status(400).json({ error: "channel 'sms' not wired yet (planned for Thanksgiving milestone)" });
  if (channel !== 'email') return res.status(400).json({ error: `unknown channel '${channel}'` });
  if (!recipients.length)  return res.status(400).json({ error: 'no recipients supplied' });

  const dryRun = req.query?.dryRun === '1' || req.query?.dry === '1';
  const resend = new Resend(process.env.RESEND_API_KEY);
  const nowIso = new Date().toISOString();
  const results = [];

  for (const r of recipients) {
    const email = String(r.email || '').trim();
    const subject = String(r.subject || '').trim();
    const text = String(r.text || '').trim();
    const rowNumber = Number(r.rowNumber);

    if (!email.includes('@') || !subject || !text) {
      results.push({ email, error: 'missing email / subject / text' });
      continue;
    }

    if (dryRun) {
      results.push({ email, dryRun: true, rowNumber: rowNumber || null });
      continue;
    }

    let sentId = null;
    try {
      const html = wrapHtml(text);
      const out = await resend.emails.send({
        from: FROM,
        to: email,
        replyTo: REPLY_TO,
        subject,
        text,
        html,
        tags: [
          { name: 'brief_id', value: briefId.slice(0, 80) },
          { name: 'channel',  value: 'email' },
        ],
      });
      sentId = out && out.data && out.data.id;
    } catch (err) {
      results.push({ email, error: err.message || 'resend send failed' });
      continue;
    }

    let stamped = false;
    if (Number.isFinite(rowNumber) && rowNumber >= 2) {
      try {
        await stampLastPinged(rowNumber, nowIso);
        stamped = true;
      } catch {
        // Stamp failure is non-fatal — the send already went out, so we
        // surface the row but don't mark the whole call failed.
      }
    }
    results.push({ email, id: sentId, stamped });
  }

  const sent   = results.filter((x) => x.id || x.dryRun).length;
  const failed = results.filter((x) => x.error).length;
  return res.status(200).json({ ok: failed === 0, sent, failed, results });
}

// Cream-card wrap to match the rest of Colophon's transactional mail.
// White-space preserved so plain-text drafts render with their original
// line breaks; bare URLs get auto-linked.
function wrapHtml(text) {
  const safe = escapeHtml(text).replace(
    /(https?:\/\/\S+)/g,
    '<a href="$1" style="color:#0d1014;text-decoration:underline;">$1</a>',
  );
  return `<div style="font-family:Georgia,'Times New Roman',serif;color:#0d1014;background:#f4ede2;padding:48px 24px;">` +
         `<div style="max-width:520px;margin:0 auto;font-size:16px;line-height:1.7;white-space:pre-wrap;">${safe}</div></div>`;
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
