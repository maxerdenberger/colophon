// HMAC-signed session tokens. Tamper-proof, self-contained (no KV needed).
// Format: base64url(payload).base64url(hmac_sha256(payload, SESSION_SECRET))
// Vercel ignores files prefixed with _ when discovering serverless functions.
import { createHmac, randomUUID, timingSafeEqual } from 'crypto';

const TIER_DURATION_MS = {
  day:   24 * 60 * 60 * 1000,
  week:  7  * 24 * 60 * 60 * 1000,
  month: 30 * 24 * 60 * 60 * 1000,
};

function getSecret() {
  return process.env.SESSION_SECRET || process.env.ADMIN_KEY || process.env.STRIPE_SECRET_KEY;
}

export function tierDurationMs(tier) {
  return TIER_DURATION_MS[tier] || TIER_DURATION_MS.day;
}

// Sign a session payload; returns an opaque token string.
export function signSession({ tier, filters = {}, region, sub, name }) {
  const secret = getSecret();
  if (!secret) throw new Error('SESSION_SECRET not configured');
  const now = Date.now();
  const payload = {
    sid: randomUUID(),
    tier,
    filters,
    region: region || null,
    sub:    sub    || null,
    name:   name   || null,
    iat:    now,
    exp:    now + tierDurationMs(tier),
  };
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig  = createHmac('sha256', secret).update(data).digest('base64url');
  return `${data}.${sig}`;
}

// Verify a token string. Returns { ok, payload, reason }.
export function verifySession(token) {
  const secret = getSecret();
  if (!secret) return { ok: false, reason: 'misconfigured' };
  if (!token || typeof token !== 'string') return { ok: false, reason: 'not_found' };

  const [data, sig] = token.split('.');
  if (!data || !sig) return { ok: false, reason: 'malformed' };

  const expected = createHmac('sha256', secret).update(data).digest('base64url');
  // constant-time compare to avoid timing leaks
  let sigOk = false;
  try {
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    sigOk = a.length === b.length && timingSafeEqual(a, b);
  } catch { sigOk = false; }
  if (!sigOk) return { ok: false, reason: 'bad_signature' };

  let payload;
  try {
    payload = JSON.parse(Buffer.from(data, 'base64url').toString());
  } catch {
    return { ok: false, reason: 'malformed' };
  }

  if (typeof payload.exp !== 'number' || Date.now() > payload.exp) {
    return { ok: false, reason: 'expired', payload };
  }

  return { ok: true, payload };
}
