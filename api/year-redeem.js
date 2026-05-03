// /api/year-redeem
//
// Verifies a Stripe Checkout session for a year-tier subscription
// and mints a 365-day access token. The success page (/year-success)
// calls this with the session_id; we return an /access?t=… URL the
// page redirects to.
//
// POST body:
//   { session_id: 'cs_xxx' }
//
// Returns:
//   { token, accessUrl, name, expiresAt }

import Stripe from 'stripe';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method not allowed' });
  }
  if (!process.env.STRIPE_SECRET_KEY) {
    return res.status(501).json({ error: 'STRIPE_SECRET_KEY not set' });
  }
  const sessionId = String((req.body && req.body.session_id) || req.query.session_id || '').trim();
  if (!sessionId) return res.status(400).json({ error: 'missing session_id' });

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ['subscription', 'customer'],
    });
    if (session.mode !== 'subscription') return res.status(400).json({ error: 'not a subscription session' });
    if (session.payment_status !== 'paid' && session.status !== 'complete') {
      return res.status(402).json({ error: 'session not paid yet' });
    }

    const buyerEmail = session.customer_details && session.customer_details.email
      || session.customer_email
      || (session.customer && session.customer.email)
      || '';
    const buyerName  = (session.metadata && session.metadata.buyer_name)
      || (session.customer_details && session.customer_details.name)
      || '';

    // 365-day base64 access token. Same shape AccessPage already
    // decodes — tier='year' grants the full unlocked bench, no
    // discipline/region filters.
    const exp = Date.now() + 365 * 86400_000;
    const payload = {
      exp,
      tier:  'year',
      name:  buyerName,
      email: buyerEmail,
      sub:   session.subscription && session.subscription.id ? session.subscription.id : null,
    };
    const token = Buffer.from(JSON.stringify(payload)).toString('base64');
    const origin = (process.env.SITE_URL || 'https://colophon.contact').replace(/\/$/, '');
    const accessUrl = `${origin}/access?t=${encodeURIComponent(token)}`;

    return res.status(200).json({
      token,
      accessUrl,
      name: buyerName,
      email: buyerEmail,
      expiresAt: new Date(exp).toISOString(),
    });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'stripe redeem failed' });
  }
}
