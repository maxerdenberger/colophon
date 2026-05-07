// /api/build-batches — gathers two ready-to-send audiences:
//
//   1. creatives — pending Sheet rows (referred or self-applied), excluding
//      anyone already confirmed on the bench, the operator's own test rows,
//      and anyone who's already a buyer (they've moved up the funnel).
//
//   2. buyers — Stripe customers who paid for any Colophon product
//      (day/week/month/year pass, concierge), excluding the operator's own
//      test purchases. Dedupes by email and keeps the most-recent purchase.
//
// Returns counts + lists. Used by the admin panel's BatchSendsPanel and by
// /api/send-batch as the freshly-pulled recipient set at send time.
//
// Auth: Bearer ADMIN_KEY (or legacy ADMIN_SECRET, falls back to '590Rossmore').

import { google } from 'googleapis';
import Stripe from 'stripe';

const TAB_NAME  = process.env.SHEETS_TAB_NAME || 'Form Responses 1';
const RANGE_ALL = `${TAB_NAME}!A:Z`;

// Sheet column map (0-indexed) — same as _utils/sheets.js header comment.
const COL = {
  TS: 0, NAME: 1, EMAIL: 2, PORTFOLIO: 3, LINKEDIN: 4, DISC: 5,
  OTHER_DISC: 6, AVAIL: 7, RATE_SECTION: 8, HOURLY: 9, MIN_FEE: 10,
  REFERRAL: 11, TOP_CLIENTS: 12, EXP_LEVEL: 13, CATEGORIES: 14,
  VALUE_PROP: 15, PARTNERS: 17, STATUS: 18, UPDATED: 19, CONFIRMED: 20,
};

const operatorEmails = () =>
  new Set(
    (process.env.OPERATOR_EMAIL || 'merdenberger@gmail.com')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  );

function sheetClient() {
  if (!process.env.GOOGLE_SERVICE_EMAIL || !process.env.GOOGLE_PRIVATE_KEY) {
    throw new Error('GOOGLE_SERVICE_EMAIL / GOOGLE_PRIVATE_KEY not configured');
  }
  if (!process.env.SHEETS_SPREADSHEET_ID) {
    throw new Error('SHEETS_SPREADSHEET_ID not configured');
  }
  const auth = new google.auth.JWT({
    email: process.env.GOOGLE_SERVICE_EMAIL,
    key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  return google.sheets({ version: 'v4', auth });
}

async function fetchCreatives() {
  const sheets = sheetClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.SHEETS_SPREADSHEET_ID,
    range: RANGE_ALL,
  });
  const rows = res.data.values || [];
  const ops  = operatorEmails();
  const seen = new Set();
  const out  = [];
  // skip header row 0
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const email = (r[COL.EMAIL] || '').trim().toLowerCase();
    if (!email || !email.includes('@')) continue;
    if (ops.has(email)) continue;
    if (seen.has(email)) continue;

    const status    = (r[COL.STATUS] || '').trim().toLowerCase();
    const confirmed = (r[COL.CONFIRMED] || '').trim().toLowerCase();

    // We only want recommends/applicants who haven't yet claimed a row.
    // Definition: status is empty or 'pending', and confirmed is not TRUE.
    // Exclude approved (already on the bench), denied, cold, duplicate.
    const isPending = status === '' || status === 'pending';
    const alreadyClaimed = confirmed === 'true' || confirmed === 'yes' || confirmed === '1';
    if (!isPending) continue;
    if (alreadyClaimed) continue;

    seen.add(email);
    out.push({
      email,
      name:       (r[COL.NAME]      || '').trim(),
      referrer:   (r[COL.REFERRAL]  || '').trim(),
      discipline: (r[COL.DISC]      || '').trim(),
      addedAt:    (r[COL.TS]        || '').trim(),
    });
  }
  return out;
}

async function fetchBuyers() {
  if (!process.env.STRIPE_SECRET_KEY) {
    return { list: [], note: 'STRIPE_SECRET_KEY not set — buyer list empty' };
  }
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const ops    = operatorEmails();

  // Same filter logic as /api/recent-activity.
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
  const productOf = (c) => (c.metadata && c.metadata.product)
    || (String(c.description || '').toLowerCase().includes('day')       ? 'day-pass'
      : String(c.description || '').toLowerCase().includes('week')      ? 'week-pass'
      : String(c.description || '').toLowerCase().includes('month')     ? 'month-pass'
      : String(c.description || '').toLowerCase().includes('year')      ? 'year-pass'
      : String(c.description || '').toLowerCase().includes('concierge') ? 'concierge'
      : 'unknown');

  // Pull all Colophon charges since launch (last ~24mo cap is plenty).
  const sinceUnix = Math.floor(Date.now() / 1000) - 60 * 60 * 24 * 365 * 2;
  const all = [];
  let starting_after;
  for (let page = 0; page < 10; page++) {
    const r = await stripe.charges.list({
      limit: 100,
      created: { gte: sinceUnix },
      starting_after,
    });
    all.push(...r.data);
    if (!r.has_more) break;
    starting_after = r.data[r.data.length - 1].id;
  }

  // Filter, dedupe by email, keep most-recent + sum totals.
  const byEmail = new Map();
  for (const c of all) {
    if (!c.paid || c.status !== 'succeeded') continue;
    if (!isColophonCharge(c)) continue;
    const email = ((c.billing_details && c.billing_details.email) || c.receipt_email || '').toLowerCase();
    if (!email || !email.includes('@')) continue;
    if (ops.has(email)) continue;

    const product = productOf(c);
    const amount  = (c.amount - (c.amount_refunded || 0)) / 100;
    const ts      = c.created * 1000;
    const name    = (c.billing_details && c.billing_details.name) || '';

    if (!byEmail.has(email)) {
      byEmail.set(email, {
        email,
        name,
        lastPaidAt:  ts,
        products:    [product],
        totalPaid:   amount,
        chargeCount: 1,
      });
    } else {
      const e = byEmail.get(email);
      if (ts > e.lastPaidAt) { e.lastPaidAt = ts; e.name = name || e.name; }
      if (!e.products.includes(product)) e.products.push(product);
      e.totalPaid += amount;
      e.chargeCount += 1;
    }
  }

  const list = Array.from(byEmail.values()).map((b) => ({
    ...b,
    totalPaid:    Math.round(b.totalPaid * 100) / 100,
    lastPaidAtIso: new Date(b.lastPaidAt).toISOString(),
  })).sort((a, b) => b.lastPaidAt - a.lastPaidAt);

  return { list };
}

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'method not allowed' });
  }

  const auth = req.headers.authorization || '';
  const adminKey = process.env.ADMIN_KEY || process.env.ADMIN_SECRET || '590Rossmore';
  if (auth !== `Bearer ${adminKey}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  try {
    const [creatives, buyersResult] = await Promise.all([
      fetchCreatives().catch((e) => { throw new Error('sheet: ' + (e.message || 'fetch failed')); }),
      fetchBuyers().catch((e) => ({ list: [], error: 'stripe: ' + (e.message || 'fetch failed') })),
    ]);

    // Funnel rule: anyone who is BOTH a recommend and a buyer goes only
    // into buyers (they've moved past 'invite'). Inverse-not-applied: a
    // buyer is never re-invited as a creative.
    const buyerEmails = new Set(buyersResult.list.map((b) => b.email));
    const creativesFiltered = creatives.filter((c) => !buyerEmails.has(c.email));

    return res.status(200).json({
      builtAt: new Date().toISOString(),
      creatives: {
        count: creativesFiltered.length,
        list:  creativesFiltered,
      },
      buyers: {
        count: buyersResult.list.length,
        list:  buyersResult.list,
        ...(buyersResult.error ? { error: buyersResult.error } : {}),
        ...(buyersResult.note  ? { note:  buyersResult.note  } : {}),
      },
    });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'build-batches failed' });
  }
}
