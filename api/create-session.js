// Mints a signed session token for a paid look.
//
// TODO: gate this behind payment confirmation. Currently this endpoint is
// open — anyone can POST and receive a free token. The intended flow is:
//   Stripe checkout completes → /api/stripe-webhook → calls signSession()
//   directly (server-side, no HTTP exposure) → emails the access URL.
// The synchronous redeem path (/api/redeem) already verifies the Stripe
// session before issuing a token, so /api/create-session itself should
// either (a) require an auth header, (b) be removed in favor of redeem, or
// (c) be kept for admin/test use behind ADMIN_KEY.
//
// For now it's protected with the ADMIN_KEY bearer token so it's not
// publicly mintable.

import { signSession, tierDurationMs } from './_utils/session.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method not allowed' });
  }

  // Bearer auth — same secret the admin console uses.
  const auth = req.headers.authorization || '';
  const secret = process.env.ADMIN_KEY || process.env.ADMIN_SECRET;
  if (!secret || auth !== `Bearer ${secret}`) {
    return res.status(401).json({ error: 'unauthorized — pass Bearer ADMIN_KEY' });
  }

  try {
    const { tier, filters = {}, visitorRegion, sub } = req.body || {};
    if (!tier || !['day', 'week', 'month'].includes(tier)) {
      return res.status(400).json({ error: 'tier must be day | week | month' });
    }

    const token = signSession({ tier, filters, region: visitorRegion, sub });
    const redirectUrl = `/access?token=${encodeURIComponent(token)}`;
    return res.status(200).json({
      token,
      redirectUrl,
      expires: Date.now() + tierDurationMs(tier),
    });
  } catch (err) {
    console.error('create-session error:', err);
    return res.status(500).json({ error: err.message || 'create-session failed' });
  }
}
