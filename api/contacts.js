// /api/contacts
//
// Unified email roll-up across every contact surface Colophon has:
//   - applicant         — creative who filled the apply form (Sheet bench)
//   - referral-by       — someone who referred a creative or hirer
//   - referral-target   — someone who was referred (creative or hirer)
//   - buyer             — Stripe customer (Colophon products, operator excluded)
//   - newsletter        — Formspree source=bench-newsletter
//   - concierge         — Formspree source=concierge-brief
//
// Deduped by lowercased email. Each row keeps a `sources` array so the
// admin UI can filter ("show me everyone who was both a referral target
// AND a buyer", etc.). firstSeen/lastSeen reflect earliest/latest signal.
//
// Auth: ADMIN_KEY → ADMIN_SECRET → '590Rossmore'

import Stripe from 'stripe';
import { google } from 'googleapis';
import { readBench } from './_utils/sheets-v2.js';
import { isTestOrOperatorSubmission } from './_utils/formspree.js';

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

async function readReferralsTab() {
  if (!process.env.SHEETS_SPREADSHEET_ID) return [];
  try {
    const sheets = sheetsClient();
    const r = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.SHEETS_SPREADSHEET_ID,
      range: `${REFERRALS_TAB}!A:I`,
    });
    const rows = r.data.values || [];
    if (rows.length < 2) return [];
    const header = rows[0].map((h) => String(h || '').trim().toLowerCase());
    const idx = (k) => header.indexOf(k);
    const cTs       = idx('timestamp');
    const cRefBy    = idx('referrer');
    const cRefByEm  = idx('referrer email');
    const cType     = idx('type');
    const cRefName  = idx('referred name');
    const cRefCt    = idx('referred contact');
    const cRefOrg   = idx('referred org');
    const cStatus   = idx('status');
    return rows.slice(1).map((r) => ({
      ts:           cTs       >= 0 ? r[cTs]       : '',
      referrer:     cRefBy    >= 0 ? r[cRefBy]    : '',
      referrerEmail:cRefByEm  >= 0 ? r[cRefByEm]  : '',
      type:         cType     >= 0 ? r[cType]     : '',
      name:         cRefName  >= 0 ? r[cRefName]  : '',
      contact:      cRefCt    >= 0 ? r[cRefCt]    : '',
      org:          cRefOrg   >= 0 ? r[cRefOrg]   : '',
      status:       cStatus   >= 0 ? r[cStatus]   : '',
    }));
  } catch (e) {
    // Tab might not exist yet — that's fine, just return empty.
    return [];
  }
}

async function readStripeBuyers(days = 730) {
  if (!process.env.STRIPE_SECRET_KEY) return [];
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const since = Math.floor((Date.now() - days * 86400_000) / 1000);
  const KNOWN_PRODUCTS = new Set(['day-pass','week-pass','month-pass','year-pass','concierge']);
  const KNOWN_TIERS    = new Set(['year']);
  const OPERATOR_EMAILS = new Set(
    (process.env.OPERATOR_EMAIL || 'merdenberger@gmail.com')
      .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
  );
  const isColophon = (c) => {
    const desc = String(c.description || '').toLowerCase();
    if (desc.startsWith('colophon')) return true;
    const md = c.metadata || {};
    if (md.product && KNOWN_PRODUCTS.has(md.product)) return true;
    if (md.tier && KNOWN_TIERS.has(md.tier)) return true;
    return false;
  };
  const all = [];
  let starting_after;
  try {
    for (let p = 0; p < 10; p++) {
      const r = await stripe.charges.list({ limit: 100, created: { gte: since }, starting_after });
      all.push(...r.data);
      if (!r.has_more) break;
      starting_after = r.data[r.data.length - 1].id;
    }
  } catch { return []; }
  return all
    .filter((c) => c.paid && c.status === 'succeeded' && isColophon(c))
    .map((c) => {
      const email = ((c.billing_details && c.billing_details.email) || c.receipt_email || '').toLowerCase().trim();
      const name  = (c.billing_details && c.billing_details.name) || '';
      return { email, name, ts: new Date(c.created * 1000).toISOString() };
    })
    .filter((b) => b.email && !OPERATOR_EMAILS.has(b.email));
}

async function readFormspree() {
  const key = process.env.FORMSPREE_API_KEY;
  const formId = process.env.FORMSPREE_FORM_ID || 'xqenzjew';
  if (!key) return { newsletter: [], concierge: [] };
  const basic  = `Basic ${Buffer.from(`${key}:`).toString('base64')}`;
  const bearer = `Bearer ${key}`;
  const attempts = [
    { auth: basic,  url: `https://formspree.io/api/0/forms/${encodeURIComponent(formId)}/submissions` },
    { auth: bearer, url: `https://formspree.io/api/0/forms/${encodeURIComponent(formId)}/submissions` },
  ];
  let raw = null;
  for (const a of attempts) {
    try {
      const r = await fetch(a.url, { headers: { Authorization: a.auth, Accept: 'application/json' } });
      const text = await r.text();
      let j = null; try { j = text ? JSON.parse(text) : null; } catch {}
      if (r.ok) { raw = (j && (j.submissions || j.data)) || []; break; }
    } catch {}
  }
  if (!raw) return { newsletter: [], concierge: [] };
  const newsletter = [], concierge = [];
  for (const s of raw) {
    if (isTestOrOperatorSubmission(s)) continue;
    const data = (s.data || s) || {};
    const email = String(data.email || '').trim().toLowerCase();
    if (!email) continue;
    const source = String(data.source || s.source || '').toLowerCase();
    const ts = s.submitted_at || s.created_at || '';
    const name = data.name || '';
    if (source === 'bench-newsletter') newsletter.push({ email, name, ts });
    else if (source === 'concierge-brief') concierge.push({ email, name, ts });
  }
  return { newsletter, concierge };
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

  const want = String(req.query.sources || 'all').toLowerCase();
  const wants = (s) => want === 'all' || want.split(',').includes(s);

  try {
    const tasks = await Promise.all([
      wants('applicant') ? readBench({ force: false }).then(({ rows }) => rows.map((r) => ({
        email: String(r.email || '').toLowerCase().trim(),
        name: r.name || '',
        ts: r.lastUpdatedTs ? new Date(r.lastUpdatedTs).toISOString() : (r.createdAtTs ? new Date(r.createdAtTs).toISOString() : ''),
        meta: { status: r.status, discipline: r.disciplines },
      })).filter((r) => r.email && r.email.includes('@'))) : Promise.resolve([]),
      (wants('referral-by') || wants('referral-target')) ? readReferralsTab() : Promise.resolve([]),
      wants('buyer') ? readStripeBuyers() : Promise.resolve([]),
      (wants('newsletter') || wants('concierge')) ? readFormspree() : Promise.resolve({ newsletter: [], concierge: [] }),
    ]);
    const [applicants, referrals, buyers, formspree] = tasks;

    // Tag each source with which side of the market it belongs to.
    //   demand  — hiring managers (paid buyers, concierge briefs, hirer
    //             referrals, year-tier inquiries)
    //   supply  — creatives (applicants, creative referrals)
    //   unknown — newsletter signups (could be either)
    // A contact's final side is the strongest signal seen: demand wins
    // over supply wins over unknown.
    const SIDE_RANK = { demand: 3, supply: 2, unknown: 1 };
    const sourceSide = (source, type) => {
      if (source === 'buyer' || source === 'concierge') return 'demand';
      if (source === 'applicant') return 'supply';
      if (source === 'referral-by' || source === 'referral-target') {
        const t = String(type || '').toLowerCase();
        if (t === 'hirer' || t === 'hiring' || t === 'buyer')  return 'demand';
        if (t === 'creative')                                   return 'supply';
        return 'unknown';
      }
      return 'unknown';
    };

    // contacts: email → { email, name, sources: Set, side, firstSeen, lastSeen, meta }
    const map = new Map();
    const add = (email, name, source, ts, meta) => {
      const e = String(email || '').toLowerCase().trim();
      if (!e || !e.includes('@')) return;
      const tsMs = ts ? (Date.parse(ts) || 0) : 0;
      const cur = map.get(e) || { email: e, name: '', sources: new Set(), side: 'unknown', firstSeen: tsMs || Date.now(), lastSeen: tsMs || 0, meta: {} };
      cur.sources.add(source);
      const sourceTypeSide = sourceSide(source, meta && meta.type);
      if (SIDE_RANK[sourceTypeSide] > SIDE_RANK[cur.side]) cur.side = sourceTypeSide;
      if (name && !cur.name) cur.name = name;
      if (tsMs) {
        cur.firstSeen = Math.min(cur.firstSeen, tsMs);
        cur.lastSeen  = Math.max(cur.lastSeen, tsMs);
      }
      if (meta) Object.assign(cur.meta, meta);
      map.set(e, cur);
    };

    for (const a of applicants) add(a.email, a.name, 'applicant', a.ts, a.meta);
    for (const r of referrals) {
      if (wants('referral-by'))     add(r.referrerEmail, r.referrer, 'referral-by', r.ts, { type: r.type });
      if (wants('referral-target')) add(r.contact,       r.name,     'referral-target', r.ts, { type: r.type, referredBy: r.referrer || '' });
    }
    for (const b of buyers) add(b.email, b.name, 'buyer', b.ts);
    for (const n of formspree.newsletter || []) add(n.email, n.name, 'newsletter', n.ts);
    for (const c of formspree.concierge  || []) add(c.email, c.name, 'concierge', c.ts);

    const contacts = [...map.values()]
      .map((c) => ({
        email:     c.email,
        name:      c.name || '',
        sources:   [...c.sources],
        side:      c.side,
        firstSeen: c.firstSeen ? new Date(c.firstSeen).toISOString() : '',
        lastSeen:  c.lastSeen  ? new Date(c.lastSeen).toISOString()  : '',
        meta:      c.meta || {},
      }))
      .sort((a, b) => Date.parse(b.lastSeen || 0) - Date.parse(a.lastSeen || 0));

    // Per-source counts for the panel header.
    const counts = {};
    for (const c of contacts) for (const s of c.sources) counts[s] = (counts[s] || 0) + 1;
    // Per-side counts so the panel can show "X hiring managers · Y creatives".
    const sides = { demand: 0, supply: 0, unknown: 0 };
    for (const c of contacts) sides[c.side] = (sides[c.side] || 0) + 1;

    return res.status(200).json({
      count:   contacts.length,
      counts,
      sides,
      filter:  want,
      contacts,
      ts: new Date().toISOString(),
    });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'contacts roll-up failed' });
  }
}
