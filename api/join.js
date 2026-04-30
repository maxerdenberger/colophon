import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY);
const FROM = 'Colophon <bench@colophon.contact>';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method not allowed' });
  }

  try {
    const {
      name, email, portfolio, linkedin, disciplines, availability,
      hourly_rate, min_fee, experience, categories, clients, referral, bio,
    } = req.body || {};

    if (!name || !email) {
      return res.status(400).json({ error: 'name and email required' });
    }
    if (!process.env.ADMIN_EMAIL) {
      return res.status(500).json({ error: 'ADMIN_EMAIL env var not configured' });
    }

    const firstName = String(name).trim().split(/\s+/)[0] || 'there';

    // ── Email 1: admin notification ────────────────────────────────────────
    const row = (label, value) => `
      <tr>
        <td style="background:#f8f4ec;width:160px;padding:10px 14px;border-bottom:1px solid #eee;vertical-align:top;"><strong>${label}</strong></td>
        <td style="padding:10px 14px;border-bottom:1px solid #eee;vertical-align:top;">${value || '—'}</td>
      </tr>`;
    const linkOrDash = (url) =>
      url ? `<a href="${esc(url)}" style="color:#0d1014;">${esc(url)}</a>` : '—';

    const adminHtml = `
      <html><body style="font-family:-apple-system,system-ui,sans-serif;background:#f4ede2;padding:32px;color:#0d1014;margin:0;">
        <div style="max-width:680px;margin:0 auto;">
          <h2 style="margin:0 0 8px;font-size:20px;">New bench application</h2>
          <p style="color:#555;margin:0 0 20px;">${esc(name)} &lt;${esc(email)}&gt;</p>
          <table cellpadding="0" cellspacing="0" style="border-collapse:collapse;width:100%;background:#fff;border:1px solid #ddd;font-size:14px;">
            ${row('Name', esc(name))}
            ${row('Email', esc(email))}
            ${row('Portfolio', linkOrDash(portfolio))}
            ${row('LinkedIn', linkOrDash(linkedin))}
            ${row('Disciplines', esc(disciplines))}
            ${row('Availability', esc(availability))}
            ${row('Hourly rate', esc(hourly_rate))}
            ${row('Min fee', esc(min_fee))}
            ${row('Experience', esc(experience))}
            ${row('Categories', esc(categories))}
            ${row('Clients', esc(clients))}
            ${row('Referral', esc(referral))}
            ${row('Bio', esc(bio).replace(/\n/g, '<br/>'))}
          </table>
          <p style="margin:24px 0 0;"><a href="https://colophon.contact/admin" style="color:#0d1014;">Open admin →</a></p>
        </div>
      </body></html>`;

    await resend.emails.send({
      from: FROM,
      to: process.env.ADMIN_EMAIL,
      subject: `New bench application — ${name}`,
      html: adminHtml,
    });

    // ── Email 2: applicant confirmation (inline CSS, Georgia serif) ────────
    const confirmHtml = `
      <div style="background:#f4ede2;padding:56px 24px;font-family:Georgia,'Times New Roman',serif;color:#0d1014;">
        <div style="max-width:520px;margin:0 auto;">
          <p style="font-size:17px;line-height:1.7;margin:0 0 18px;">We received your application, ${esc(firstName)}.</p>
          <p style="font-size:17px;line-height:1.7;margin:0 0 18px;">We review every application personally.</p>
          <p style="font-size:17px;line-height:1.7;margin:0 0 36px;">Expect to hear back within 5 days.</p>
          <p style="font-size:15px;line-height:1.7;margin:0;">— Colophon</p>
        </div>
      </div>`;

    await resend.emails.send({
      from: FROM,
      to: email,
      subject: "You're in the queue.",
      html: confirmHtml,
    });

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('join error:', err);
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
