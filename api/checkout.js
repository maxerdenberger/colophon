import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Canonical catalog. Amounts are in cents.
const PRODUCTS = {
  'day-pass':   { name: 'Colophon — day pass',   amount: 4000 },
  'week-pass':  { name: 'Colophon — week pass',  amount: 8200 },
  'month-pass': { name: 'Colophon — month pass', amount: 34900 },
  'concierge':  { name: 'Colophon — concierge',  amount: 19900 },
};

const ALLOWED_ORIGINS = ['https://colophon.contact', 'https://www.colophon.contact'];

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method not allowed' });
  }
  if (!process.env.STRIPE_SECRET_KEY) {
    return res.status(500).json({ error: 'STRIPE_SECRET_KEY not configured' });
  }

  try {
    const {
      product,
      amount,           // optional override in dollars (used by the bench-builder discount flow)
      duration,         // legacy: 'day' | 'week' | 'month'
      name,
      email,
      filters,
      matched,
    } = req.body || {};

    // Resolve which catalog entry this request maps to
    const productKey = product || (duration ? `${duration}-pass` : null);
    const catalog = productKey && PRODUCTS[productKey];
    if (!catalog) {
      return res.status(400).json({ error: `unknown product: ${productKey}` });
    }

    const unitAmount = typeof amount === 'number' && amount > 0
      ? Math.round(amount * 100)
      : catalog.amount;

    // Origin: prefer the request's Origin header if it's on the allow-list,
    // then SITE_URL env var, otherwise the canonical domain.
    const reqOrigin = (req.headers.origin || '').toLowerCase();
    const siteUrl = (process.env.SITE_URL || '').replace(/\/$/, '');
    const origin = ALLOWED_ORIGINS.includes(reqOrigin)
      ? reqOrigin
      : (siteUrl || 'https://colophon.contact');

    // Concierge flow returns to /concierge with paid=1 so the brief stage unlocks;
    // every other flow lands on /success.
    const isConcierge = productKey === 'concierge';
    const successUrl = isConcierge
      ? `${origin}/concierge?paid=1&session_id={CHECKOUT_SESSION_ID}`
      : `${origin}/success?session_id={CHECKOUT_SESSION_ID}`;
    const cancelUrl = isConcierge ? `${origin}/concierge` : `${origin}/look`;

    const metadata = {
      product: productKey,
      ...(duration ? { duration } : {}),
      ...(matched ? { matched: String(matched) } : {}),
      ...(name ? { buyer_name: String(name).slice(0, 100) } : {}),
      ...(filters ? { filters: JSON.stringify(filters).slice(0, 480) } : {}),
    };

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: { name: catalog.name },
          unit_amount: unitAmount,
        },
        quantity: 1,
      }],
      success_url: successUrl,
      cancel_url: cancelUrl,
      customer_email: email || undefined,
      metadata,
    });

    return res.status(200).json({ url: session.url });
  } catch (err) {
    console.error('checkout error:', err);
    return res.status(500).json({ error: err.message || 'checkout failed' });
  }
}
