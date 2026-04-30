import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY);
const FROM = 'Colophon <bench@colophon.contact>';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method not allowed' });
  }

  try {
    const { email, availability, notes, portfolio } = req.body || {};

    if (!email) {
      return res.status(400).json({ error: 'email required' });
    }
    if (!process.env.ADMIN_EMAIL) {
      return res.status(500).json({ error: 'ADMIN_EMAIL env var not configured' });
    }

    const row = (label, value) => `
      <tr>
        <td style="background:#f8f4ec;width:140px;padding:10px 14px;border-bottom:1px solid #eee;vertical-align:top;"><strong>${label}</strong></td>
        <td style="padding:10px 14px;border-bottom:1px solid #eee;vertical-align:top;">${value || '—'}</td>
      </tr>`;
    const linkOrDash = (url) =>
      url ? `<a href="${esc(url)}" style="color:#0d1014;">${esc(url)}</a>` : '—';

    const html = `
      <html><body style="font-family:-apple-system,system-ui,sans-serif;background:#f4ede2;padding:32px;color:#0d1014;margin:0;">
        <div style="max-width:640px;margin:0 auto;">
          <h2 style="margin:0 0 8px;font-size:20px;">Bench confirmation</h2>
          <p style="color:#555;margin:0 0 20px;">${esc(email)}</p>
          <table cellpadding="0" cellspacing="0" style="border-collapse:collapse;width:100%;background:#fff;border:1px solid #ddd;font-size:14px;">
            ${row('Email', esc(email))}
            ${row('Availability', esc(availability))}
            ${row('Notes', esc(notes).replace(/\n/g, '<br/>'))}
            ${row('Portfolio', linkOrDash(portfolio))}
          </table>
          <p style="margin:20px 0 0;color:#555;font-size:13px;">Match to CSV record: ${esc(email)}</p>
        </div>
      </body></html>`;

    await resend.emails.send({
      from: FROM,
      to: process.env.ADMIN_EMAIL,
      subject: `Bench confirmation — ${email}`,
      html,
    });

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('invite-confirm error:', err);
    return res.status(500).json({ error: err.message || 'send failed' });
  }
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
