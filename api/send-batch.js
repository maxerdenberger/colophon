// /api/send-batch — fires a transactional email to one of the two ready-
// to-send audiences from /api/build-batches.
//
//   POST { audience: 'creatives' | 'buyers', dryRun?: bool }
//
// Re-pulls the audience at send time (Sheet + Stripe), so anything that
// changed between admin-panel preview and click is caught. Returns
// { audience, sent, failed, dryRun, sample } where sample is the first 5
// recipients (for the activity-log toast).
//
// Auth: Bearer ADMIN_KEY (or legacy ADMIN_SECRET, falls back to '590Rossmore').

import { Resend } from 'resend';
import { google } from 'googleapis';
import Stripe from 'stripe';

const resend = new Resend(process.env.RESEND_API_KEY);
const FROM     = 'Colophon <noreply@colophon.contact>';
const REPLY_TO = 'noreply@colophon.contact';
const SLEEP_MS = 120;

const TAB_NAME  = process.env.SHEETS_TAB_NAME || 'Form Responses 1';
const RANGE_ALL = `${TAB_NAME}!A:Z`;
const COL = {
  TS: 0, NAME: 1, EMAIL: 2, DISC: 5, REFERRAL: 11, STATUS: 18, CONFIRMED: 20,
};
const operatorEmails = () =>
  new Set(
    (process.env.OPERATOR_EMAIL || 'merdenberger@gmail.com')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  );

const BRAND_MARK = `
  <table cellpadding="0" cellspacing="0" border="0" style="margin: 0 0 28px;">
    <tr>
      <td>
        <div style="display:inline-block;width:44px;height:44px;background:#f4f1ec;border:2px solid #0d0d0b;border-radius:50%;text-align:center;line-height:40px;vertical-align:middle;">
          <span style="display:inline-block;width:14px;height:14px;background:#ff5100;border-radius:50%;vertical-align:middle;"></span>
        </div>
      </td>
      <td style="padding-left:12px;font-family:'Space Grotesk',Georgia,serif;font-weight:700;font-size:16px;letter-spacing:-0.02em;color:#0d0d0b;vertical-align:middle;">
        colo<span style="color:#ff5100;">phon</span>
      </td>
    </tr>
  </table>`;

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

// ─── audience: creatives ────────────────────────────────────────────────
async function fetchCreatives() {
  if (!process.env.SHEETS_SPREADSHEET_ID) throw new Error('SHEETS_SPREADSHEET_ID not set');
  const auth = new google.auth.JWT({
    email: process.env.GOOGLE_SERVICE_EMAIL,
    key:   process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  const sheets = google.sheets({ version: 'v4', auth });
  const r = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.SHEETS_SPREADSHEET_ID,
    range: RANGE_ALL,
  });
  const rows = r.data.values || [];
  const ops  = operatorEmails();
  const seen = new Set();
  const out  = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const email = (row[COL.EMAIL] || '').trim().toLowerCase();
    if (!email || !email.includes('@')) continue;
    if (ops.has(email)) continue;
    if (seen.has(email)) continue;
    const status    = (row[COL.STATUS]    || '').trim().toLowerCase();
    const confirmed = (row[COL.CONFIRMED] || '').trim().toLowerCase();
    const isPending = status === '' || status === 'pending';
    const claimed   = confirmed === 'true' || confirmed === 'yes' || confirmed === '1';
    if (!isPending || claimed) continue;
    seen.add(email);
    out.push({
      email,
      name:       (row[COL.NAME]     || '').trim(),
      referrer:   (row[COL.REFERRAL] || '').trim(),
      discipline: (row[COL.DISC]     || '').trim(),
    });
  }
  return out;
}

function creativeEmail({ name, referrer }) {
  const inviteUrl = `https://colophon.contact/invite?name=${encodeURIComponent(name || '')}${referrer ? `&ref=${encodeURIComponent(referrer)}` : ''}`;
  const subject = referrer
    ? `${referrer} recommended you to Colophon.`
    : `you've been recommended to Colophon.`;
  const opener  = referrer
    ? `${esc(referrer)} thought you'd be a good fit.`
    : `someone in the network put your name forward.`;
  const html = `
    <div style="background:#f4ede2;padding:56px 24px;font-family:Georgia,'Times New Roman',serif;color:#0d1014;">
      <div style="max-width:520px;margin:0 auto;">
        ${BRAND_MARK}
        <p style="font-size:17px;line-height:1.7;margin:0 0 18px;">${opener}</p>
        <p style="font-size:17px;line-height:1.7;margin:0 0 18px;">colophon is a private bench of vetted creative talent — writers, directors, designers, strategists. hirers come to us when they need the right person fast.</p>
        <p style="font-size:17px;line-height:1.7;margin:0 0 14px;">confirm your details — takes 60 seconds:</p>
        <p style="font-size:16px;line-height:1.7;margin:0 0 36px;"><a href="${inviteUrl}" style="color:#0d1014;text-decoration:underline;">${inviteUrl}</a></p>
        <p style="font-size:15px;line-height:1.7;margin:0;">— colophon</p>
      </div>
    </div>`;
  const text = [
    `${referrer ? referrer + ' thought' : 'someone in the network thought'} you'd be a good fit.`,
    ``,
    `colophon is a private bench of vetted creative talent — writers, directors, designers, strategists. hirers come to us when they need the right person fast.`,
    ``,
    `confirm your details — takes 60 seconds:`,
    inviteUrl,
    ``,
    `— colophon`,
  ].join('\n');
  return { subject, html, text };
}

// ─── audience: buyers ───────────────────────────────────────────────────
async function fetchBuyers() {
  if (!process.env.STRIPE_SECRET_KEY) return [];
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const ops    = operatorEmails();
  const KNOWN_PRODUCTS = new Set(['day-pass','week-pass','month-pass','year-pass','concierge']);
  const KNOWN_TIERS    = new Set(['year']);
  const isColophonCharge = (c) => {
    const desc = String(c.description || '').toLowerCase();
    if (desc.startsWith('colophon')) return true;
    const md = c.metadata || {};
    if (md.product && KNOWN_PRODUCTS.has(md.product)) return true;
    if (md.tier && KNOWN_TIERS.has(md.tier)) return true;
    return false;
  };
  const sinceUnix = Math.floor(Date.now() / 1000) - 60 * 60 * 24 * 365 * 2;
  const all = [];
  let starting_after;
  for (let page = 0; page < 10; page++) {
    const r = await stripe.charges.list({
      limit: 100, created: { gte: sinceUnix }, starting_after,
    });
    all.push(...r.data);
    if (!r.has_more) break;
    starting_after = r.data[r.data.length - 1].id;
  }
  const byEmail = new Map();
  for (const c of all) {
    if (!c.paid || c.status !== 'succeeded') continue;
    if (!isColophonCharge(c)) continue;
    const email = ((c.billing_details && c.billing_details.email) || c.receipt_email || '').toLowerCase();
    if (!email || !email.includes('@')) continue;
    if (ops.has(email)) continue;
    const name = (c.billing_details && c.billing_details.name) || '';
    if (!byEmail.has(email)) byEmail.set(email, { email, name });
    else if (name && !byEmail.get(email).name) byEmail.get(email).name = name;
  }
  return Array.from(byEmail.values());
}

function buyerEmail({ name }) {
  const subject = `back on the bench.`;
  const greeting = name ? `${esc(name.split(/\s+/)[0])},` : `quick note,`;
  const html = `
    <div style="background:#f4ede2;padding:56px 24px;font-family:Georgia,'Times New Roman',serif;color:#0d1014;">
      <div style="max-width:520px;margin:0 auto;">
        ${BRAND_MARK}
        <p style="font-size:17px;line-height:1.7;margin:0 0 18px;">${greeting}</p>
        <p style="font-size:17px;line-height:1.7;margin:0 0 18px;">the bench has been moving. new directors, new writers, new strategists — every name vouched for, every rate transparent, every contact direct.</p>
        <p style="font-size:17px;line-height:1.7;margin:0 0 14px;">when you're ready:</p>
        <p style="font-size:16px;line-height:1.7;margin:0 0 12px;">→ <a href="https://colophon.contact/look" style="color:#0d1014;text-decoration:underline;">browse the bench</a></p>
        <p style="font-size:16px;line-height:1.7;margin:0 0 36px;">→ <a href="https://colophon.contact/concierge" style="color:#0d1014;text-decoration:underline;">send a brief, get five names in four hours</a></p>
        <p style="font-size:15px;line-height:1.7;margin:0;">— colophon</p>
      </div>
    </div>`;
  const text = [
    `${name ? name.split(/\s+/)[0] + ',' : 'quick note,'}`,
    ``,
    `the bench has been moving. new directors, new writers, new strategists — every name vouched for, every rate transparent, every contact direct.`,
    ``,
    `when you're ready:`,
    `→ browse the bench: https://colophon.contact/look`,
    `→ send a brief, get five names in four hours: https://colophon.contact/concierge`,
    ``,
    `— colophon`,
  ].join('\n');
  return { subject, html, text };
}

// ─── handler ────────────────────────────────────────────────────────────
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
    return res.status(501).json({ error: 'RESEND_API_KEY not set' });
  }

  const body = req.body || {};
  const audience = String(body.audience || '').toLowerCase();
  const dryRun   = !!body.dryRun;
  if (!['creatives','buyers'].includes(audience)) {
    return res.status(400).json({ error: 'audience must be "creatives" or "buyers"' });
  }

  let recipients;
  try {
    recipients = audience === 'creatives' ? await fetchCreatives() : await fetchBuyers();
    if (audience === 'creatives') {
      const buyers = await fetchBuyers();
      const buyerSet = new Set(buyers.map((b) => b.email));
      recipients = recipients.filter((r) => !buyerSet.has(r.email));
    }
  } catch (err) {
    return res.status(500).json({ error: 'fetch: ' + (err.message || 'failed') });
  }

  if (dryRun) {
    return res.status(200).json({
      audience, dryRun: true,
      count: recipients.length,
      sample: recipients.slice(0, 5),
    });
  }

  let sent = 0;
  const failed = [];
  for (const r of recipients) {
    const tpl = audience === 'creatives' ? creativeEmail(r) : buyerEmail(r);
    try {
      await resend.emails.send({
        from: FROM,
        to:   r.email,
        replyTo: REPLY_TO,
        subject: tpl.subject,
        html: tpl.html,
        text: tpl.text,
      });
      sent++;
    } catch (err) {
      failed.push({ email: r.email, error: err.message || 'send failed' });
    }
    if (SLEEP_MS) await new Promise((res2) => setTimeout(res2, SLEEP_MS));
  }

  return res.status(200).json({
    audience,
    dryRun: false,
    sent,
    failed,
    sample: recipients.slice(0, 5),
  });
}
