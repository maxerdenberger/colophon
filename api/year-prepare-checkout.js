// /api/year-prepare-checkout
//
// Signs a year-tier proposal token with HMAC-SHA256(ADMIN_KEY). The
// admin panel calls this when drafting the proposal email; the signed
// token gets dropped into the email body as a /year-buy?t=… URL.
//
// The token carries (price, email, name) so /api/year-checkout knows
// what amount to charge without trusting client input. Tampering breaks
// the HMAC.
//
// POST body:
//   { email, name, company, price }   // price in dollars
//
// Returns:
//   { token, url, exp }

import crypto from 'crypto';

const PROPOSAL_TTL_DAYS = 30;

function b64url(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method not allowed' });
  }
  const auth = req.headers.authorization || '';
  const adminKey = process.env.ADMIN_KEY || process.env.ADMIN_SECRET || '590Rossmore';
  if (auth !== `Bearer ${adminKey}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const body = req.body || {};
  const email = String(body.email || '').trim().toLowerCase();
  const name  = String(body.name || '').trim();
  const company = String(body.company || '').trim();
  const price = Number(body.price) || 0;
  if (!email.includes('@')) return res.status(400).json({ error: 'missing email' });
  if (!price || price < 100) return res.status(400).json({ error: 'price must be >= $100' });

  const exp = Date.now() + PROPOSAL_TTL_DAYS * 86400_000;
  const payload = { email, name, company, price, exp, kind: 'year-proposal' };
  const payloadB64 = b64url(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', adminKey).update(payloadB64).digest();
  const sigB64 = b64url(sig);
  const token = `${payloadB64}.${sigB64}`;

  const base = (process.env.SITE_URL || 'https://colophon.contact').replace(/\/$/, '');
  const url = `${base}/year-buy?t=${encodeURIComponent(token)}`;

  return res.status(200).json({ token, url, exp });
}
