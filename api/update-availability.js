// /api/update-availability
//
// Token-validated GET endpoint. The buttons in the availability-check-in
// email link here with: ?email=<>&token=<HMAC>&value=available|soon|booked.
// We verify the HMAC, write the new availability to the Sheet's row for
// that email, and render a simple confirmation page.
//
// Token: HMAC-SHA256 of email + secret (env AVAILABILITY_TOKEN_SECRET or
// ADMIN_KEY), first 32 hex chars. Stable per recipient; no expiration.

import crypto from 'crypto';
import { findBenchRowByEmail, updateBenchRow } from './_utils/sheets.js';

const VALID_VALUES = {
  available: 'Immediate (ready to start within 1 week)',
  soon:      '2–4 Weeks Out',
  booked:    'Waitlist Only (currently booked)',
};

function tokenFor(email) {
  const secret = process.env.AVAILABILITY_TOKEN_SECRET || process.env.ADMIN_KEY || '590Rossmore';
  return crypto.createHmac('sha256', secret).update(String(email).trim().toLowerCase()).digest('hex').slice(0, 32);
}

const page = (title, body, accentColor) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${title}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;700&family=IBM+Plex+Mono&display=swap" rel="stylesheet">
</head><body style="margin:0;background:#f4ede2;font-family:Georgia,serif;color:#0d1014;">
  <div style="min-height:100vh;display:flex;align-items:center;justify-content:center;padding:48px 24px;">
    <div style="max-width:520px;text-align:center;">
      <div style="margin:0 auto 18px;line-height:0;">
        <span style="display:inline-block;width:28px;height:28px;background:#f4ede2;border:1.5px solid #0d1014;border-radius:50%;box-sizing:border-box;line-height:24px;text-align:center;"><span style="display:inline-block;width:10px;height:10px;background:${accentColor || '#FF5100'};border-radius:50%;vertical-align:1px;"></span></span>
      </div>
      <div style="font-family:'Space Grotesk',sans-serif;font-weight:700;font-size:26px;letter-spacing:-0.02em;color:#0d1014;margin:0 0 32px;">colo<span style="color:#FF5100;">phon</span></div>
      ${body}
      <p style="font-family:'IBM Plex Mono',monospace;font-size:11px;letter-spacing:0.14em;color:#888580;text-transform:uppercase;margin:48px 0 0;">colophon · the bench</p>
    </div>
  </div>
</body></html>`;

export default async function handler(req, res) {
  const { email, token, value } = req.query || {};
  const cleanEmail = String(email || '').trim().toLowerCase();

  if (!cleanEmail.includes('@')) {
    return res.status(400).setHeader('Content-Type','text/html').send(page('Bad request', '<p>Missing or invalid email.</p>'));
  }
  const expected = tokenFor(cleanEmail);
  if (token !== expected) {
    return res.status(403).setHeader('Content-Type','text/html').send(page('Link expired',
      '<h1 style="font-family:\'Space Grotesk\',sans-serif;font-weight:700;font-size:32px;letter-spacing:-0.02em;margin:0 0 16px;">link mismatch.</h1><p style="font-size:16px;line-height:1.7;">The token in this URL doesn\'t match what we expect for this email. If you got two pings, use the most recent one — or reply to <a href="mailto:bench@colophon.contact">bench@colophon.contact</a> and I\'ll update by hand.</p>'));
  }
  if (!VALID_VALUES[value]) {
    return res.status(400).setHeader('Content-Type','text/html').send(page('Bad request', '<p>Unknown availability value.</p>'));
  }

  try {
    const found = await findBenchRowByEmail(cleanEmail);
    if (!found) {
      return res.status(404).setHeader('Content-Type','text/html').send(page('Not on the bench',
        '<h1 style="font-family:\'Space Grotesk\',sans-serif;font-weight:700;font-size:32px;letter-spacing:-0.02em;margin:0 0 16px;">we couldn\'t find your row.</h1><p style="font-size:16px;line-height:1.7;">Reply to <a href="mailto:bench@colophon.contact">bench@colophon.contact</a> and I\'ll sort it.</p>'));
    }
    await updateBenchRow(found.rowNumber, { availability: VALID_VALUES[value] });
  } catch (err) {
    return res.status(500).setHeader('Content-Type','text/html').send(page('Server error',
      `<h1 style="font-family:'Space Grotesk',sans-serif;font-weight:700;font-size:28px;margin:0 0 16px;">something went wrong.</h1><p style="font-size:14px;line-height:1.7;">${String(err.message || 'unknown')}. Reply to bench@colophon.contact.</p>`));
  }

  const labels = {
    available: { line: 'available now', color: '#3F7F4A' },
    soon:      { line: 'available in 2–4 weeks', color: '#C87C18' },
    booked:    { line: 'booked / waitlist only', color: '#0d1014' },
  };
  const lab = labels[value];
  const body = `
    <h1 style="font-family:'Space Grotesk',sans-serif;font-weight:700;font-size:36px;letter-spacing:-0.025em;line-height:1.05;margin:0 0 12px;">your row is updated.</h1>
    <p style="font-family:'IBM Plex Mono',monospace;font-size:13px;letter-spacing:0.04em;color:${lab.color};text-transform:uppercase;margin:0 0 28px;">→ ${lab.line}</p>
    <p style="font-size:16px;line-height:1.7;color:#0d1014;margin:0 0 16px;">Hirers will see the change on the public bench within a few minutes.</p>
    <p style="font-size:14px;line-height:1.7;color:#3D3C38;margin:0 0 0;">Anything else to update — rate, portfolio, the social heart? Reply to <a href="mailto:bench@colophon.contact" style="color:#0d1014;">bench@colophon.contact</a> and I\'ll roll it in.</p>
  `;
  res.setHeader('Content-Type', 'text/html');
  return res.status(200).send(page('Updated', body, lab.color));
}
