// /api/activate
//
// Final gate. After approval, a creative gets the welcome email which
// links to /activate?email=<base64>&token=<hmac>. They submit 3 peer
// referrals + 1 buyer referral. This endpoint:
//   1. Validates the HMAC token (anti-tampering)
//   2. Writes all 4 referrals to the Referrals tab
//   3. Auto-fires invite emails to peer refs whose contact looks like email
//   4. Sets confirmed='yes' on the creative's bench row
//
// Public bench then shows the row (filter: status='bench' AND confirmed='yes',
// with grandfather for rows created before ACTIVATION_GATE_TS).
//
// Body (POST):
//   {
//     email:        'creative@example.com',     // their email (from approval)
//     token:        'a1b2c3...',                // HMAC from welcome link
//     refs: [
//       { type: 'creative', name: '...', contact: '...' },   // ×3
//       { type: 'hirer',    name: '...', org: '...', contact: '...' }  // ×1
//     ]
//   }

import crypto from 'crypto';
import { setConfirmedByEmail } from './_utils/sheets-v2.js';
import { appendReferralLog } from './_utils/sheets.js';
import { sendInviteEmail, looksLikeEmail } from './_utils/invites.js';

function tokenFor(email) {
  const secret = process.env.ACTIVATION_TOKEN_SECRET
              || process.env.AVAILABILITY_TOKEN_SECRET
              || process.env.ADMIN_KEY
              || '590Rossmore';
  return crypto.createHmac('sha256', secret).update(String(email).trim().toLowerCase()).digest('hex').slice(0, 32);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method not allowed' });
  }
  const body = req.body || {};
  const email = String(body.email || '').trim().toLowerCase();
  const token = String(body.token || '');
  const refs  = Array.isArray(body.refs) ? body.refs : [];

  if (!email || !email.includes('@')) {
    return res.status(400).json({ error: 'email required' });
  }
  if (token !== tokenFor(email)) {
    return res.status(401).json({ error: 'invalid token — link expired or tampered' });
  }

  // Validate: must have at least 3 creative refs + 1 hirer ref, all with
  // name + contact (and org for hirer).
  const creatives = refs.filter((r) => r && r.type === 'creative' && r.name && r.contact);
  const hirers    = refs.filter((r) => r && r.type === 'hirer'    && r.name && r.contact && r.org);
  if (creatives.length < 3) {
    return res.status(400).json({ error: 'three creative referrals required (name + contact each)' });
  }
  if (hirers.length < 1) {
    return res.status(400).json({ error: 'one buyer referral required (name + org + email)' });
  }

  try {
    // Write all referrals to the Referrals tab.
    const ts = new Date().toISOString();
    const entries = [];
    for (const c of creatives.slice(0, 3)) {
      entries.push({
        timestamp: ts,
        referrer: '',           // we don't have the creative's display name here
        referrerEmail: email,
        type: 'creative',
        name:    c.name || '',
        contact: c.contact || '',
        notes:   'activation',
      });
    }
    for (const h of hirers.slice(0, 1)) {
      entries.push({
        timestamp: ts,
        referrer: '',
        referrerEmail: email,
        type: 'hirer',
        name:    h.name || '',
        contact: h.contact || '',
        org:     h.org || '',
        notes:   'activation',
      });
    }
    let referralLog = null;
    try {
      const r = await appendReferralLog(entries);
      referralLog = { logged: r.appended };
    } catch (e) {
      referralLog = { error: e.message || 'log failed' };
    }

    // Best-effort auto-invite for any creative ref with an email contact.
    const autoInvites = [];
    for (const c of creatives.slice(0, 3)) {
      if (!looksLikeEmail(c.contact)) continue;
      try {
        const r = await sendInviteEmail({
          name:     c.name,
          email:    String(c.contact).trim(),
          referrer: email,   // referrer = the activating creative
        });
        autoInvites.push({ to: c.contact, sent: !!r.ok, error: r.error || null });
      } catch (e) {
        autoInvites.push({ to: c.contact, sent: false, error: e.message });
      }
    }

    // Flip confirmed='yes' on the bench row — this is the gate that the
    // public bench filter checks alongside status='bench'.
    const confirmed = await setConfirmedByEmail(email, 'yes');

    return res.status(200).json({
      ok: true,
      email,
      confirmed,
      referralLog,
      autoInvites,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'activation failed' });
  }
}
