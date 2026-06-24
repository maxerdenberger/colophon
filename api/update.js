// /api/update
//
// One-click availability update from outreach and ping emails.
// Called via GET link embedded in each email — no login, no form.
//
// Query params:
//   email      string   recipient email (must match token)
//   status     string   'available' | 'soon' | 'booked'
//   token      string   base64url-encoded {email, exp} — minted at send time
//   brief      string   (optional) campaign tag e.g. 'google-hardware-film-2026'
//
// Returns an HTML confirmation page the recipient sees after clicking.

import { Resend } from 'resend';
import { findBenchRowByEmail, updateBenchRow } from './_utils/sheets.js';

const resend = new Resend(process.env.RESEND_API_KEY);
const NOTIFY_TO = 'merdenberger@gmail.com';
const FROM      = 'Colophon <bench@colophon.contact>';

const DAY = 86_400_000;

const STATUS_MAP = {
  available: { availability: 'Immediate (ready to start within 1 week)', label: 'available' },
  soon:      { availability: '2–4 Weeks Out',                           label: 'available in 2–4 weeks' },
  booked:    { availability: 'Waitlist Only (currently booked)',         label: 'booked / not available' },
};

function validateToken(token, email) {
  try {
    const payload = JSON.parse(Buffer.from(token, 'base64url').toString('utf-8'));
    return (
      typeof payload.email === 'string' &&
      payload.email.toLowerCase() === email.toLowerCase() &&
      typeof payload.exp === 'number' &&
      payload.exp > Date.now()
    );
  } catch {
    return false;
  }
}

function page(title, body) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${title} — colophon</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@700&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#e8e5de;font-family:'IBM Plex Mono',monospace;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:40px 20px}
.card{background:#f4f1ec;border:1px solid rgba(13,13,11,.12);max-width:480px;width:100%;padding:48px 40px}
.logo{font-family:'Space Grotesk',sans-serif;font-weight:700;font-size:16px;letter-spacing:-.02em;color:#0d0d0b;margin-bottom:36px}
.logo span{color:#ff5100}
h1{font-family:'Space Grotesk',sans-serif;font-weight:700;font-size:28px;line-height:1;letter-spacing:-.03em;color:#0d0d0b;margin-bottom:20px;text-transform:lowercase}
p{font-size:12px;line-height:1.75;color:#888580;text-transform:lowercase}
</style>
</head>
<body>
<div class="card">
  <div class="logo">colo<span>phon</span></div>
  ${body}
</div>
</body>
</html>`;
}

async function notify({ email, status, brief, name }) {
  try {
    await resend.emails.send({
      from: FROM,
      to: NOTIFY_TO,
      subject: `bench response — ${status} — ${email}`,
      html: `<p style="font-family:monospace;font-size:13px;line-height:1.8;color:#333;">
        <strong>${name || email}</strong> just updated their status.<br/><br/>
        email: ${email}<br/>
        status: <strong>${status}</strong><br/>
        campaign: ${brief || 'unknown'}<br/>
        time: ${new Date().toISOString()}
      </p>`,
      text: `bench response\n\n${name || email} — ${email}\nstatus: ${status}\ncampaign: ${brief || 'unknown'}\ntime: ${new Date().toISOString()}`,
    });
  } catch (err) {
    // best-effort — don't let notification failure break the confirmation page
    console.error('notify failed:', err.message);
  }
}

export default async function handler(req, res) {
  const { email, status, token, brief } = req.query || {};

  if (!email || !status || !token) {
    return res.status(400).send(page('error', `
      <h1>missing params</h1>
      <p>this link looks incomplete. reach out to bench@colophon.contact if you need help.</p>
    `));
  }

  const mapping = STATUS_MAP[status];
  if (!mapping) {
    return res.status(400).send(page('error', `
      <h1>unknown status</h1>
      <p>valid values: available, soon, booked.</p>
    `));
  }

  if (!validateToken(token, email)) {
    return res.status(401).send(page('link expired', `
      <h1>link expired.</h1>
      <p>outreach links are valid for 30 days. reply to the original email and we'll sort it out.</p>
    `));
  }

  try {
    const found = await findBenchRowByEmail(email);
    if (!found) {
      return res.status(404).send(page('not found', `
        <h1>not on the bench.</h1>
        <p>we couldn't find your email in the bench. reply to the original email if something seems off.</p>
      `));
    }

    await updateBenchRow(found.rowNumber, {
      availability: mapping.availability,
      status: 'bench',
    });

    const name = found.row ? found.row[1] : null;
    await notify({ email, status, brief, name });

    return res.status(200).send(page('got it', `
      <h1>got it.</h1>
      <p>your status is updated: <strong style="color:#0d0d0b">${mapping.label}</strong>.<br/><br/>
      hirers are looking at the bench. keep your status current — updated monthly keeps you visible.</p>
    `));
  } catch (err) {
    console.error('/api/update error:', err);
    return res.status(500).send(page('error', `
      <h1>something went wrong.</h1>
      <p>reply to bench@colophon.contact and we'll update your status manually.</p>
    `));
  }
}
