// /api/year-renewal-check
//
// Cron-fired daily. Walks active year-tier Stripe subscriptions and
// emails each subscriber about 10 months in (60 days before the next
// renewal date) so they have a fair window to cancel or reach out
// before the auto-charge.
//
// Idempotency: we record sent reminders in the `concierge_log` Sheet
// tab keyed by subscription_id + renewal date, so if the cron runs
// twice in the same day we don't double-send.
//
// Auth: Vercel cron header OR Bearer ADMIN_KEY for manual triggers.

import Stripe from 'stripe';
import { Resend } from 'resend';
import { google } from 'googleapis';

const REMIND_DAYS_BEFORE = 60;
const REMIND_WINDOW_DAYS = 1;   // cron runs daily; window matches that
const FROM = 'Colophon <noreply@colophon.contact>';

export default async function handler(req, res) {
  const cronAuth = req.headers['x-vercel-cron'] === '1' || (req.headers['user-agent'] || '').includes('vercel-cron');
  if (!cronAuth) {
    const auth = req.headers.authorization || '';
    const adminKey = process.env.ADMIN_KEY || process.env.ADMIN_SECRET || '590Rossmore';
    if (auth !== `Bearer ${adminKey}`) return res.status(401).json({ error: 'unauthorized' });
  }
  if (!process.env.STRIPE_SECRET_KEY) return res.status(501).json({ error: 'STRIPE_SECRET_KEY not set' });
  if (!process.env.RESEND_API_KEY)    return res.status(501).json({ error: 'RESEND_API_KEY not set' });

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const resend = new Resend(process.env.RESEND_API_KEY);

  // Pull active subscriptions tagged tier=year (we set this in metadata
  // at checkout time). Limit 100 — plenty for a long while.
  let subs = [];
  try {
    const list = await stripe.subscriptions.list({ status: 'active', limit: 100, expand: ['data.customer'] });
    subs = list.data.filter((s) => (s.metadata && s.metadata.tier) === 'year');
  } catch (err) {
    return res.status(502).json({ error: 'stripe list failed: ' + err.message });
  }

  // Read existing reminder log (best-effort) so we don't double-send.
  const sentSet = new Set();
  try {
    if (process.env.GOOGLE_SERVICE_EMAIL && process.env.GOOGLE_PRIVATE_KEY && process.env.SHEETS_SPREADSHEET_ID) {
      const auth2 = new google.auth.JWT({
        email: process.env.GOOGLE_SERVICE_EMAIL,
        key: String(process.env.GOOGLE_PRIVATE_KEY).replace(/\\n/g, '\n'),
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
      });
      const sheets = google.sheets({ version: 'v4', auth: auth2 });
      const tab = process.env.CONCIERGE_LOG_TAB || 'concierge_log';
      const r = await sheets.spreadsheets.values.get({
        spreadsheetId: process.env.SHEETS_SPREADSHEET_ID,
        range: `${tab}!B:D`,
      });
      const rows = (r.data && r.data.values) || [];
      for (const row of rows) {
        if (row[0] && String(row[0]).startsWith('renewal-reminder:')) sentSet.add(row[0]);
      }
    }
  } catch {}

  const now = Date.now();
  const sent = [];
  for (const sub of subs) {
    const periodEndMs = (sub.current_period_end || 0) * 1000;
    const daysUntil = (periodEndMs - now) / 86400_000;
    if (daysUntil > REMIND_DAYS_BEFORE || daysUntil < REMIND_DAYS_BEFORE - REMIND_WINDOW_DAYS) continue;

    const renewalDate = new Date(periodEndMs).toISOString().slice(0, 10);
    const dedupeKey = `renewal-reminder:${sub.id}:${renewalDate}`;
    if (sentSet.has(dedupeKey)) continue;

    const customer = sub.customer || {};
    const buyerEmail = (customer && customer.email) || (sub.metadata && sub.metadata.buyer_email) || null;
    const buyerName  = (customer && customer.name)  || (sub.metadata && sub.metadata.buyer_name)  || '';
    if (!buyerEmail) continue;

    const priceItem = sub.items && sub.items.data && sub.items.data[0];
    const priceCents = priceItem && priceItem.price && priceItem.price.unit_amount;
    const amount = priceCents ? `$${(priceCents / 100).toLocaleString('en-US')}` : 'your annual rate';
    const renewalHuman = new Date(periodEndMs).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

    const html = `
      <div style="background:#f4ede2;padding:48px 24px;font-family:Georgia,'Times New Roman',serif;color:#0d1014;">
        <div style="max-width:520px;margin:0 auto;font-size:16px;line-height:1.7;">
          <p style="font-size:11px;letter-spacing:0.14em;color:#888580;text-transform:uppercase;margin:0 0 18px;">colophon · annual renewal reminder</p>
          <p>Hi ${esc(buyerName.split(' ')[0] || 'there')},</p>
          <p>A quick heads up: your annual Colophon access renews on <strong>${esc(renewalHuman)}</strong> at <strong>${esc(amount)}</strong>.</p>
          <p>If that still works for you, no action needed — we'll keep your bench access live and the priority concierge SLA in place.</p>
          <p>If you'd like to cancel, change the seat count, or talk through a different arrangement, head back to <a href="https://colophon.contact/access" style="color:#0d1014;">colophon.contact/access</a> and I'll see your note from there.</p>
          <p>— Max</p>
          <p style="font-size:11px;color:#888580;margin-top:32px;">Subscription id: ${esc(sub.id)} · ${esc(buyerEmail)}</p>
        </div>
      </div>`;

    try {
      await resend.emails.send({
        from: FROM,
        to: buyerEmail,
        replyTo: 'noreply@colophon.contact',
        subject: `Your Colophon annual renews ${renewalHuman}`,
        html,
      });
      sent.push({ subscription: sub.id, email: buyerEmail, renewalDate });

      // Best-effort log row so we don't double-send on the next cron tick.
      try {
        if (process.env.GOOGLE_SERVICE_EMAIL && process.env.GOOGLE_PRIVATE_KEY && process.env.SHEETS_SPREADSHEET_ID) {
          const auth3 = new google.auth.JWT({
            email: process.env.GOOGLE_SERVICE_EMAIL,
            key: String(process.env.GOOGLE_PRIVATE_KEY).replace(/\\n/g, '\n'),
            scopes: ['https://www.googleapis.com/auth/spreadsheets'],
          });
          const sheets = google.sheets({ version: 'v4', auth: auth3 });
          const tab = process.env.CONCIERGE_LOG_TAB || 'concierge_log';
          await sheets.spreadsheets.values.append({
            spreadsheetId: process.env.SHEETS_SPREADSHEET_ID,
            range: `${tab}!A:F`,
            valueInputOption: 'RAW',
            insertDataOption: 'INSERT_ROWS',
            requestBody: {
              values: [[
                new Date().toISOString(),
                dedupeKey,
                buyerEmail,
                `Annual renewal reminder (${renewalDate})`,
                '',
                '',
              ]],
            },
          });
        }
      } catch {}
    } catch (err) {
      // log + continue
      console.error('renewal reminder failed', sub.id, err.message);
    }
  }

  return res.status(200).json({ ok: true, considered: subs.length, sent: sent.length, details: sent });
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
