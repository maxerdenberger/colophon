// /api/revenue
//
// Admin-only Stripe revenue summary. Walks recent payment_intents and
// charges, returns gross / fees / net + a per-product breakdown plus
// a 30-day series for trend rendering. Server-side because we don't
// want STRIPE_SECRET_KEY in client JS.
//
// Auth: same fallback chain as the other admin endpoints.
//   ADMIN_KEY → ADMIN_SECRET → '590Rossmore'
//
// Returns:
//   {
//     range: { from, to, days },
//     totals: { gross, fees, net, count, refunds },
//     byProduct: { 'day-pass': { count, gross }, 'week-pass': {...}, ... },
//     daily: [ { day, gross, count } ]   // last `days` days, oldest first
//   }
//
// Amounts are dollars (already divided by 100).

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

  const days = Math.max(1, Math.min(365, parseInt(req.query.days, 10) || 90));
  const since = Math.floor((Date.now() - days * 86400_000) / 1000);
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

  try {
    // Walk charges (not payment_intents) — charges include fees/net via
    // balance_transaction expansion. Cap at 1000 in case of high volume.
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

    // Pull each charge's balance_transaction in parallel for fee/net.
    // Skip if not yet available (charge.balance_transaction may be null
    // briefly after creation).
    const txIds = all
      .filter((c) => c.paid && c.status === 'succeeded' && c.balance_transaction)
      .map((c) => typeof c.balance_transaction === 'string' ? c.balance_transaction : c.balance_transaction.id);
    const txCache = new Map();
    await Promise.all(
      [...new Set(txIds)].map(async (id) => {
        try {
          const tx = await stripe.balanceTransactions.retrieve(id);
          txCache.set(id, tx);
        } catch {}
      })
    );

    let gross = 0, fees = 0, net = 0, count = 0, refunds = 0;
    const byProduct = {};
    const dailyMap = new Map();
    for (const c of all) {
      if (!c.paid || c.status !== 'succeeded') continue;
      const day = new Date(c.created * 1000).toISOString().slice(0, 10);
      const dayBucket = dailyMap.get(day) || { day, gross: 0, count: 0 };

      const grossCents = c.amount;
      const refundCents = c.amount_refunded || 0;
      const netCharge = grossCents - refundCents;
      gross += grossCents;
      refunds += refundCents;
      count += 1;
      dayBucket.gross += netCharge;
      dayBucket.count += 1;
      dailyMap.set(day, dayBucket);

      const txId = typeof c.balance_transaction === 'string' ? c.balance_transaction : (c.balance_transaction && c.balance_transaction.id);
      const tx = txId ? txCache.get(txId) : null;
      if (tx) {
        fees += tx.fee || 0;
        net  += tx.net || 0;
      }

      // Product attribution — checkout.js sends product key in metadata.
      const product = (c.metadata && c.metadata.product)
        || (c.description && c.description.toLowerCase().includes('day') ? 'day-pass'
          : c.description && c.description.toLowerCase().includes('week') ? 'week-pass'
          : c.description && c.description.toLowerCase().includes('month') ? 'month-pass'
          : c.description && c.description.toLowerCase().includes('concierge') ? 'concierge'
          : 'unknown');
      const bp = byProduct[product] || { count: 0, gross: 0 };
      bp.count += 1;
      bp.gross += netCharge;
      byProduct[product] = bp;
    }

    const toDollars = (c) => Math.round(c) / 100;
    const daily = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400_000).toISOString().slice(0, 10);
      const b = dailyMap.get(d) || { day: d, gross: 0, count: 0 };
      daily.push({ day: d, gross: toDollars(b.gross), count: b.count });
    }

    return res.status(200).json({
      range: { from: new Date(since * 1000).toISOString(), to: new Date().toISOString(), days },
      totals: {
        gross:   toDollars(gross),
        fees:    toDollars(fees),
        net:     toDollars(net),
        refunds: toDollars(refunds),
        count,
      },
      byProduct: Object.fromEntries(
        Object.entries(byProduct).map(([k, v]) => [k, { count: v.count, gross: toDollars(v.gross) }])
      ),
      daily,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'stripe summary failed' });
  }
}
