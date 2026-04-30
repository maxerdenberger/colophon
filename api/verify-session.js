// Verifies a session token. Called by the access page on load.
// Never returns bench data — only session metadata.
import { verifySession } from './_utils/session.js';

export default function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'method not allowed' });
  }
  const token = req.query.token || '';
  const result = verifySession(token);
  if (!result.ok) {
    return res.status(200).json({ valid: false, reason: result.reason });
  }
  const p = result.payload;
  return res.status(200).json({
    valid: true,
    tier: p.tier,
    filters: p.filters || {},
    region: p.region,
    name: p.name || null,
    issued: p.iat,
    expires: p.exp,
    remaining_ms: Math.max(0, p.exp - Date.now()),
  });
}
