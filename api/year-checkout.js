// /api/year-checkout
//
// Verifies a signed year-tier proposal token and returns a Stripe
// Checkout session URL configured as an annual subscription at the
// agreed price. No admin auth required — the HMAC on the token IS
// the auth (only signed-by-us tokens make it past verification).
//
// POST body:
//   { token: '<base64payload>.<base64sig>' }
//
// Returns:
//   { url: 'https://checkout.stripe.com/...' }
//
// On success, Stripe redirects to /year-success?session_id={CHECKOUT_SESSION_ID}.

import Stripe from 'stripe';
import crypto from 'crypto';

function fromB64url(s) {
  const pad = '='.repeat((4 - s.length % 4) % 4);
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}
function verifyToken(token, secret) {
  if (!token || !token.includes('.')) return null;
  const [payloadB64, sigB64] = token.split('.');
  const expected = crypto.createHmac('sha256', secret).update(payloadB64).digest();
  let provided;
  try { provided = fromB64url(sigB64); } catch { return null; }
  if (expected.length !== provided.length) return null;
  if (!crypto.timingSafeEqual(expected, provided)) return null;
  try {
    const json = fromB64url(payloadB64).toString('utf8');
    return JSON.parse(json);
  } catch { return null; }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method not allowed' });
  }
  if (!process.env.STRIPE_SECRET_KEY) {
    return res.status(501).json({ error: 'STRIPE_SECRET_KEY not set' });
  }

  const adminKey = process.env.ADMIN_KEY || process.env.ADMIN_SECRET || '590Rossmore';
  const token = String((req.body && req.body.token) || req.query.t || '').trim();
  const proposal = verifyToken(token, adminKey);
  if (!proposal) return res.status(400).json({ error: 'invalid or tampered token' });
  if (proposal.kind !== 'year-proposal') return res.status(400).json({ error: 'wrong token kind' });
  if (proposal.exp && Date.now() > proposal.exp) {
    return res.status(410).json({ error: 'proposal expired — request a fresh quote' });
  }
  if (!proposal.price || !proposal.email) {
    return res.status(400).json({ error: 'incomplete proposal' });
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const origin = (process.env.SITE_URL || 'https://colophon.contact').replace(/\/$/, '');

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer_email: proposal.email,
      line_items: [{
        price_data: {
          currency: 'usd',
          unit_amount: Math.round(proposal.price * 100),
          recurring: { interval: 'year' },
          product_data: {
            name: 'Colophon — annual access',
            description: 'Unlimited bench access · priority concierge · quarterly reports · direct intros · no markup. Auto-renews annually; cancel anytime.',
          },
        },
        quantity: 1,
      }],
      subscription_data: {
        metadata: {
          tier: 'year',
          buyer_name: proposal.name || '',
          buyer_company: proposal.company || '',
          quote_price_dollars: String(proposal.price),
        },
      },
      metadata: {
        tier: 'year',
        buyer_email: proposal.email,
        buyer_name: proposal.name || '',
        quote_price_dollars: String(proposal.price),
      },
      success_url: `${origin}/year-success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${origin}/`,
      allow_promotion_codes: true,
    });
    return res.status(200).json({ url: session.url });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'stripe checkout failed' });
  }
}
