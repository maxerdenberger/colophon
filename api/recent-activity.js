// /api/recent-activity
//
// Admin-only combined activity feed. Walks Formspree submissions and
// Stripe charges in the last N days, returns a unified shape ordered
// newest-first plus per-type counts for the dashboard tiles.
//
// Returns:
//   {
//     range: { from, to, days },
//     applications: { total, bySource: { 'apply-bench': N, 'concierge-brief': N, ... }, recent: [...] },
//     sales:        { total, gross, byProduct: { 'day-pass': { count, gross }, ... }, recent: [...] }
//   }

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

  const days = Math.max(1, Math.min(365, parseInt(req.query.days, 10) || 30));
  const since = Date.now() - days * 86400_000;
  const sinceUnix = Math.floor(since / 1000);

  const out = {
    range: { from: new Date(since).toISOString(), to: new Date().toISOString(), days },
    applications: { total: 0, bySource: {}, recent: [] },
    sales:        { total: 0, gross: 0, byProduct: {}, recent: [] },
  };

  // ── Formspree submissions ────────────────────────────────────────────
  const fpKey = process.env.FORMSPREE_API_KEY;
  const formId = process.env.FORMSPREE_FORM_ID || 'xqenzjew';
  if (fpKey) {
    try {
      const looksFormLevel = /^[0-9a-f]{16,}$/i.test(fpKey);
      const authHeader = looksFormLevel
        ? `Basic ${Buffer.from(`${fpKey}:`).toString('base64')}`
        : `Bearer ${fpKey}`;
      const r = await fetch(`https://formspree.io/api/0/forms/${encodeURIComponent(formId)}/submissions`, {
        headers: { Authorization: authHeader, Accept: 'application/json' },
      });
      const text = await r.text();
      let j = null; try { j = text ? JSON.parse(text) : null; } catch {}
      const all = (j && (j.submissions || j.data)) || [];
      const recent = all
        .map((s) => ({
          submitted_at: s.submitted_at || s.created_at || '',
          ts: s.submitted_at ? Date.parse(s.submitted_at) : 0,
          source: ((s.data && s.data.source) || s.source || 'unknown'),
          name:    (s.data && s.data.name) || s.name || '',
          email:   (s.data && s.data.email) || s.email || '',
          summary: ((s.data && (s.data.brief || s.data.summary)) || s.brief || s.summary || '').slice(0, 120),
        }))
        .filter((s) => !s.ts || s.ts >= since);
      recent.sort((a, b) => b.ts - a.ts);
      const bySource = {};
      for (const sub of recent) bySource[sub.source] = (bySource[sub.source] || 0) + 1;
      out.applications = {
        total: recent.length,
        bySource,
        recent: recent.slice(0, 25),
      };
    } catch {}
  }

  // ── Stripe charges ───────────────────────────────────────────────────
  if (process.env.STRIPE_SECRET_KEY) {
    try {
      const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
      const all = [];
      let starting_after;
      for (let page = 0; page < 5; page++) {
        const r = await stripe.charges.list({
          limit: 100,
          created: { gte: sinceUnix },
          starting_after,
        });
        all.push(...r.data);
        if (!r.has_more) break;
        starting_after = r.data[r.data.length - 1].id;
      }
      const succeeded = all.filter((c) => c.paid && c.status === 'succeeded');
      const productOf = (c) => (c.metadata && c.metadata.product)
        || (c.description && c.description.toLowerCase().includes('day') ? 'day-pass'
          : c.description && c.description.toLowerCase().includes('week') ? 'week-pass'
          : c.description && c.description.toLowerCase().includes('month') ? 'month-pass'
          : c.description && c.description.toLowerCase().includes('year')  ? 'year-pass'
          : c.description && c.description.toLowerCase().includes('concierge') ? 'concierge'
          : 'unknown');
      const byProduct = {};
      let gross = 0;
      const recent = succeeded.map((c) => {
        const product = productOf(c);
        const amt = (c.amount - (c.amount_refunded || 0)) / 100;
        gross += amt;
        byProduct[product] = byProduct[product] || { count: 0, gross: 0 };
        byProduct[product].count += 1;
        byProduct[product].gross += amt;
        return {
          ts: c.created * 1000,
          created_at: new Date(c.created * 1000).toISOString(),
          product,
          amount: amt,
          email: (c.billing_details && c.billing_details.email) || c.receipt_email || '',
          name:  (c.billing_details && c.billing_details.name)  || '',
        };
      }).sort((a, b) => b.ts - a.ts);
      // Round byProduct.gross
      for (const k of Object.keys(byProduct)) byProduct[k].gross = Math.round(byProduct[k].gross * 100) / 100;
      out.sales = {
        total: succeeded.length,
        gross: Math.round(gross * 100) / 100,
        byProduct,
        recent: recent.slice(0, 25),
      };
    } catch {}
  }

  return res.status(200).json(out);
}
