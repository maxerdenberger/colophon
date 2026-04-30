import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY);
const FROM = 'Colophon <bench@colophon.contact>';
const SLEEP_MS = 100;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method not allowed' });
  }

  // ── Auth: Bearer ADMIN_SECRET ─────────────────────────────────────────────
  const auth = req.headers.authorization || '';
  const expected = `Bearer ${process.env.ADMIN_SECRET}`;
  if (!process.env.ADMIN_SECRET || auth !== expected) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  // Body may be a raw array OR { people: [...] }
  const people = Array.isArray(req.body)
    ? req.body
    : Array.isArray(req.body?.people) ? req.body.people : [];

  if (!people.length) {
    return res.status(400).json({ error: 'no recipients' });
  }

  let sent = 0;
  const failed = [];

  for (const p of people) {
    const { name, email, referrer, discipline } = p || {};
    if (!email || !name || !referrer) {
      failed.push({ email: email || '?', error: 'missing required fields (name, email, referrer)' });
      continue;
    }

    const inviteUrl = `https://colophon.contact/invite?name=${encodeURIComponent(name)}&ref=${encodeURIComponent(referrer)}`;

    const html = `
      <div style="background:#f4ede2;padding:56px 24px;font-family:Georgia,'Times New Roman',serif;color:#0d1014;">
        <div style="max-width:520px;margin:0 auto;">
          <p style="font-size:17px;line-height:1.7;margin:0 0 18px;">${esc(referrer)} thought you'd be a good fit.</p>
          <p style="font-size:17px;line-height:1.7;margin:0 0 18px;">Colophon is a private bench of vetted creative talent — writers, directors, designers, strategists. Agencies come to us when they need the right person fast.</p>
          <p style="font-size:17px;line-height:1.7;margin:0 0 14px;">Confirm your details here — takes 60 seconds:</p>
          <p style="font-size:16px;line-height:1.7;margin:0 0 36px;"><a href="${inviteUrl}" style="color:#0d1014;text-decoration:underline;">${inviteUrl}</a></p>
          <p style="font-size:15px;line-height:1.7;margin:0;">— Colophon</p>
        </div>
      </div>`;

    try {
      await resend.emails.send({
        from: FROM,
        to: email,
        replyTo: 'bench@colophon.contact',
        subject: `${referrer} recommended you to Colophon.`,
        html,
      });
      sent++;
    } catch (err) {
      failed.push({ email, error: err.message || 'send failed' });
    }

    if (SLEEP_MS) await new Promise((r) => setTimeout(r, SLEEP_MS));
  }

  return res.status(200).json({ sent, failed });
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
