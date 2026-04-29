/**
 * api/invite.js — send a referral invitation
 * POST { email, referrerName, type: 'creative' | 'buyer' }
 * Generates a signed token and sends the matching email via Resend.
 * Logs the invite to the "Invites" tab of your Google Sheet.
 *
 * Env vars: RESEND_API_KEY, UPDATE_SECRET, SITE_URL,
 *           SHEETS_API_KEY, SHEETS_SPREADSHEET_ID
 */

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const SITE_URL       = process.env.SITE_URL || 'https://colophon.co';
const FROM_EMAIL     = 'bench@colophon.co';

function makeInviteToken(email, type) {
  const payload = { email, type, exp: Date.now() + 30 * 86400000 };
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

function creativeEmail({ email, referrerName, token }) {
  const acceptUrl  = `${SITE_URL}/api/apply?token=${token}&ref=${encodeURIComponent(referrerName)}`;
  const declineUrl = `${SITE_URL}/api/decline?token=${token}`;
  return {
    from: `colophon <${FROM_EMAIL}>`,
    to: email,
    subject: `${referrerName} recommended you to the bench`,
    html: `<!DOCTYPE html><html><body style="background:#e8e5de;margin:0;padding:40px 20px;font-family:'Courier New',monospace;">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:#f4f1ec;border:1px solid rgba(13,13,11,0.12);">
  <tr><td style="padding:28px 40px 24px;border-bottom:1px solid rgba(13,13,11,0.1);">
    <span style="font-family:Georgia,serif;font-weight:700;font-size:16px;color:#0d0d0b;">colo<span style="color:#ff5100;">phon</span></span>
  </td></tr>
  <tr><td style="padding:44px 40px 0;">
    <p style="font-size:10px;letter-spacing:0.14em;color:#888580;margin-bottom:24px;">private invitation — referral</p>
    <h1 style="font-family:Georgia,serif;font-weight:700;font-size:34px;line-height:0.95;letter-spacing:-0.03em;color:#0d0d0b;margin-bottom:24px;">
      <span style="color:#ff5100;">${referrerName.toLowerCase()}</span><br/>recommended you<br/>to the bench.
    </h1>
    <p style="font-size:12px;line-height:1.78;color:#555;margin-bottom:18px;">colophon is a private bench. 630 vetted creatives. clients pay a small pass to see who's free this week and reach out direct — no agency, no markup, no middlemen.</p>
    <p style="font-size:12px;line-height:1.78;color:#555;margin-bottom:18px;">you don't pay anything. fill out a 90-second form, we put you on. every 20 days we ping you to keep your status fresh.</p>
    <p style="font-size:12px;line-height:1.78;color:#555;margin-bottom:36px;">your name stays hidden until you accept a project. only your first name and discipline are visible to clients.</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:12px;"><tr><td style="background:#0d0d0b;">
      <a href="${acceptUrl}" style="display:block;padding:18px 24px;font-size:11px;letter-spacing:0.08em;color:#f4f1ec;text-decoration:none;">yes — put me on the bench<span style="float:right;opacity:0.4;">→</span></a>
    </td></tr></table>
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:40px;"><tr><td style="background:#f4f1ec;border:1px solid rgba(13,13,11,0.12);">
      <a href="${declineUrl}" style="display:block;padding:16px 24px;font-size:11px;letter-spacing:0.08em;color:#888580;text-decoration:none;">not right now — thanks ${referrerName.toLowerCase()}<span style="float:right;opacity:0.4;">→</span></a>
    </td></tr></table>
    <hr style="border:none;border-top:1px solid rgba(13,13,11,0.1);margin-bottom:24px;"/>
    <p style="font-size:10px;line-height:1.75;color:#888580;margin-bottom:32px;">questions? reply to this email. it goes straight to the founder.</p>
  </td></tr>
  <tr><td style="padding:24px 40px 28px;border-top:1px solid rgba(13,13,11,0.1);">
    <span style="font-family:Georgia,serif;font-weight:700;font-size:13px;color:#0d0d0b;">colo<span style="color:#ff5100;">phon</span></span>
    <span style="font-size:10px;color:#888580;margin-left:10px;">the bench is private. the work is public.</span>
  </td></tr>
</table></body></html>`,
  };
}

function buyerEmail({ email, token }) {
  const claimUrl  = `${SITE_URL}/api/founding?token=${token}`;
  const previewUrl = `${SITE_URL}/access?preview=1`;
  return {
    from: `colophon <${FROM_EMAIL}>`,
    to: email,
    subject: 'first look at the right bench — founding access',
    html: `<!DOCTYPE html><html><body style="background:#e8e5de;margin:0;padding:40px 20px;font-family:'Courier New',monospace;">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:#f4f1ec;border:1px solid rgba(13,13,11,0.12);">
  <tr><td style="padding:28px 40px 24px;border-bottom:1px solid rgba(13,13,11,0.1);">
    <span style="font-family:Georgia,serif;font-weight:700;font-size:16px;color:#0d0d0b;">colo<span style="color:#ff5100;">phon</span></span>
  </td></tr>
  <tr><td style="padding:44px 40px 0;">
    <p style="font-size:10px;letter-spacing:0.14em;color:#888580;margin-bottom:24px;">founding access — invitation</p>
    <h1 style="font-family:Georgia,serif;font-weight:700;font-size:34px;line-height:0.95;letter-spacing:-0.03em;color:#0d0d0b;margin-bottom:24px;">first look at<br/>the <span style="color:#ff5100;">right</span> bench.</h1>
    <p style="font-size:12px;line-height:1.78;color:#555;margin-bottom:18px;">you spend hours every week chasing creatives — fielding inbound, vetting portfolios, asking who's free. we built colophon to put that on a single page.</p>
    <p style="font-size:12px;line-height:1.78;color:#555;margin-bottom:18px;">630 vetted creatives. their real availability — refreshed every 20 days. their rate band, timezone, top brands. one tap and you email them direct.</p>
    <p style="font-size:12px;line-height:1.78;color:#555;margin-bottom:36px;">we're letting 25 founding resource managers in early. <span style="color:#0d0d0b;">a free day pass.</span> if you don't see something useful in 24 hours, you walk.</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:32px;background:#ede9e1;border:1px solid rgba(13,13,11,0.1);"><tr><td style="padding:18px 24px;">
      <span style="font-family:Georgia,serif;font-weight:300;font-size:32px;color:#0d0d0b;">486</span>
      <span style="font-size:11px;color:#888580;margin-left:12px;">available right now</span>
      <span style="font-size:10px;color:#2a8a3a;float:right;margin-top:14px;">● live</span>
    </td></tr></table>
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:12px;"><tr><td style="background:#0d0d0b;">
      <a href="${claimUrl}" style="display:block;padding:18px 24px;font-size:11px;letter-spacing:0.08em;color:#f4f1ec;text-decoration:none;">claim my free day — see the bench<span style="float:right;opacity:0.4;">→</span></a>
    </td></tr></table>
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:40px;"><tr><td style="background:#f4f1ec;border:1px solid rgba(13,13,11,0.12);">
      <a href="${previewUrl}" style="display:block;padding:16px 24px;font-size:11px;letter-spacing:0.08em;color:#888580;text-decoration:none;">show me a preview first<span style="float:right;opacity:0.4;">→</span></a>
    </td></tr></table>
    <hr style="border:none;border-top:1px solid rgba(13,13,11,0.1);margin-bottom:24px;"/>
    <p style="font-size:10px;line-height:1.75;color:#888580;margin-bottom:32px;">25 founding day passes. 19 left. when they're gone, every pass is paid.</p>
  </td></tr>
  <tr><td style="padding:24px 40px 28px;border-top:1px solid rgba(13,13,11,0.1);">
    <span style="font-family:Georgia,serif;font-weight:700;font-size:13px;color:#0d0d0b;">colo<span style="color:#ff5100;">phon</span></span>
    <span style="font-size:10px;color:#888580;margin-left:10px;">the bench is private. the work is public.</span>
  </td></tr>
</table></body></html>`,
  };
}

async function logToSheet({ email, type, referrerName }) {
  const id  = process.env.SHEETS_SPREADSHEET_ID;
  const key = process.env.SHEETS_API_KEY;
  if (!id || !key) return;
  const range = 'Invites!A:D';
  const body  = { values: [[new Date().toISOString(), email, type, referrerName || '']] };
  await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${id}/values/${range}:append?valueInputOption=RAW&key=${key}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
  );
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  // Admin protection — basic shared key
  if (req.headers['x-admin-key'] !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const { email, referrerName, type } = req.body || {};
  if (!email || !type) return res.status(400).json({ error: 'email + type required' });
  if (!['creative', 'buyer'].includes(type)) return res.status(400).json({ error: 'invalid type' });
  if (type === 'creative' && !referrerName) return res.status(400).json({ error: 'referrerName required for creative invites' });

  const token = makeInviteToken(email, type);
  const payload = type === 'creative'
    ? creativeEmail({ email, referrerName, token })
    : buyerEmail({ email, token });

  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify(payload),
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: data });

    await logToSheet({ email, type, referrerName });

    return res.status(200).json({ ok: true, id: data.id, type });
  } catch (err) {
    console.error('invite error:', err);
    return res.status(500).json({ error: err.message });
  }
}
