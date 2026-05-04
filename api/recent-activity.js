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
import { fetchFormspreeSubmissions, isTestOrOperatorSubmission } from './_utils/formspree.js';

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

  // ── Formspree submissions (shared multi-auth fetcher) ────────────────
  try {
    const fp = await fetchFormspreeSubmissions();
    if (fp.ok) {
      // Skip operator's own self-tests + any source tagged 'test'.
      const all = (fp.submissions || []).filter((s) => !isTestOrOperatorSubmission(s));
      const recent = all
        .map((s) => ({
          submitted_at: s.submitted_at || s.created_at || '',
          ts: s.submitted_at ? Date.parse(s.submitted_at) : 0,
          source: ((s.data && s.data.source) || s.source || 'unknown'),
          name:    (s.data && s.data.name) || s.name || '',
          email:   (s.data && s.data.email) || s.email || '',
          summary: ((s.data && (s.data.brief || s.data.summary)) || s.brief || s.summary || '').slice(0, 120),
        }))
        // Drop entries with parseable timestamps before the window;
        // entries without timestamps are kept conservatively.
        .filter((s) => !s.ts || s.ts >= since);
      recent.sort((a, b) => b.ts - a.ts);
      const bySource = {};
      for (const sub of recent) bySource[sub.source] = (bySource[sub.source] || 0) + 1;
      out.applications = {
        total: recent.length,
        bySource,
        recent: recent.slice(0, 25),
      };
    } else {
      // Surface the upstream error so the dashboard isn't silently empty.
      out.applications.error = fp.error || `status ${fp.status || ''}`.trim();
    }
  } catch (ex) {
    out.applications.error = ex.message || 'formspree fetch failed';
  }

  // ── Stripe charges ───────────────────────────────────────────────────
  if (process.env.STRIPE_SECRET_KEY) {
    try {
      const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
      // Filter to Colophon charges only, exclude operator's own test
      // purchases — same logic as /api/revenue keeps in sync.
      const KNOWN_PRODUCTS = new Set(['day-pass','week-pass','month-pass','year-pass','concierge']);
      const KNOWN_TIERS    = new Set(['year']);
      const OPERATOR_EMAILS = new Set(
        (process.env.OPERATOR_EMAIL || 'merdenberger@gmail.com')
          .split(',')
          .map((s) => s.trim().toLowerCase())
          .filter(Boolean)
      );
      const isColophonCharge = (c) => {
        const desc = String(c.description || '').toLowerCase();
        if (desc.startsWith('colophon')) return true;
        const md = c.metadata || {};
        if (md.product && KNOWN_PRODUCTS.has(md.product)) return true;
        if (md.tier && KNOWN_TIERS.has(md.tier)) return true;
        return false;
      };
      const isOperator = (c) => {
        const e = ((c.billing_details && c.billing_details.email) || c.receipt_email || '').toLowerCase();
        return e && OPERATOR_EMAILS.has(e);
      };

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
      const succeeded = all.filter((c) =>
        c.paid && c.status === 'succeeded' && isColophonCharge(c) && !isOperator(c));
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
