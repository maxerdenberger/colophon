// /api/buyers
//
// Admin-only roll-up of Stripe customers, ranked by total spend. Same
// filter rules as /api/revenue: Colophon-tagged charges only, operator's
// own self-tests excluded. Groups by email + returns a single row per
// buyer with their products, spend, and most recent purchase.
//
// Auth: ADMIN_KEY → ADMIN_SECRET → '590Rossmore'
//
// Query:
//   ?days=180         (default 365 — long window for "lifetime" feel)
//   ?limit=50         (default 50, max 200)
//
// Returns:
//   {
//     range:  { from, to, days },
//     count:  N,
//     buyers: [
//       { email, name, purchases, totalGross, totalNet, products: ['day-pass', 'concierge'], firstAt, lastAt }
//       ...
//     ]
//   }
//
// Amounts in dollars.

import Stripe from 'stripe';

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
  if (!process.env.STRIPE_SECRET_KEY) {
    return res.status(501).json({ error: 'STRIPE_SECRET_KEY not configured' });
  }

  const days = Math.max(1, Math.min(730, parseInt(req.query.days, 10) || 365));
  const limit = Math.max(1, Math.min(200, parseInt(req.query.limit, 10) || 50));
  const since = Math.floor((Date.now() - days * 86400_000) / 1000);
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

  const KNOWN_PRODUCTS = new Set(['day-pass','week-pass','month-pass','year-pass','concierge']);
  const KNOWN_TIERS    = new Set(['year']);
  const OPERATOR_EMAILS = new Set(
    (process.env.OPERATOR_EMAIL || 'merdenberger@gmail.com')
      .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
  );
  const isColophonCharge = (c) => {
    const desc = String(c.description || '').toLowerCase();
    if (desc.startsWith('colophon')) return true;
    const md = c.metadata || {};
    if (md.product && KNOWN_PRODUCTS.has(md.product)) return true;
    if (md.tier && KNOWN_TIERS.has(md.tier)) return true;
    return false;
  };
  const buyerEmail = (c) =>
    ((c.billing_details && c.billing_details.email) || c.receipt_email || '').toLowerCase().trim();
  const isOperator = (c) => OPERATOR_EMAILS.has(buyerEmail(c));

  try {
    // Walk charges — up to 1000 over the window.
    const all = [];
    let starting_after;
    for (let page = 0; page < 10; page++) {
      const r = await stripe.charges.list({
        limit: 100,
        created: { gte: since },
        starting_after,
      });
      all.push(...r.data);
      if (!r.has_more) break;
      starting_after = r.data[r.data.length - 1].id;
    }
    const ours = all.filter((c) => isColophonCharge(c) && !isOperator(c) && c.paid && c.status === 'succeeded');

    // Aggregate by buyer email. No-email charges are bucketed under
    // 'unknown · <charge id>' so they still surface (rare on Stripe
    // checkout — every session captures email).
    const byEmail = new Map();
    for (const c of ours) {
      const email = buyerEmail(c) || `unknown:${c.id}`;
      const name  = (c.billing_details && c.billing_details.name) || '';
      const product = (c.metadata && c.metadata.product)
        || (c.description && c.description.toLowerCase().includes('day') ? 'day-pass'
          : c.description && c.description.toLowerCase().includes('week') ? 'week-pass'
          : c.description && c.description.toLowerCase().includes('month') ? 'month-pass'
          : c.description && c.description.toLowerCase().includes('concierge') ? 'concierge'
          : 'unknown');
      const ts = c.created * 1000;
      const grossCents = c.amount - (c.amount_refunded || 0);
      const entry = byEmail.get(email) || {
        email, name, purchases: 0, totalGrossCents: 0,
        products: new Set(), firstAt: ts, lastAt: ts,
      };
      entry.purchases  += 1;
      entry.totalGrossCents += grossCents;
      entry.products.add(product);
      entry.firstAt = Math.min(entry.firstAt, ts);
      entry.lastAt  = Math.max(entry.lastAt, ts);
      // Prefer the most-recently-seen non-empty name.
      if (name && ts >= entry.lastAt) entry.name = name;
      byEmail.set(email, entry);
    }

    const buyers = [...byEmail.values()]
      .map((b) => ({
        email:      b.email,
        name:       b.name || '',
        purchases:  b.purchases,
        totalGross: Math.round(b.totalGrossCents) / 100,
        products:   [...b.products],
        firstAt:    new Date(b.firstAt).toISOString(),
        lastAt:     new Date(b.lastAt).toISOString(),
      }))
      .sort((a, b) => b.totalGross - a.totalGross || b.purchases - a.purchases)
      .slice(0, limit);

    return res.status(200).json({
      range: { from: new Date(since * 1000).toISOString(), to: new Date().toISOString(), days },
      count: buyers.length,
      buyers,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'buyers list failed' });
  }
}
