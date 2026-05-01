import { Resend } from 'resend';
import { findBenchRowByEmail, updateBenchRow } from './_utils/sheets.js';
import { invalidateBenchCache } from './_utils/bench.js';

const resend = new Resend(process.env.RESEND_API_KEY);
const FROM = 'Colophon <bench@colophon.contact>';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method not allowed' });
  }

  try {
    const {
      email,
      availability,
      notes,
      portfolio,
      // optional referrals
      talentRefName, talentRefContact,
      buyerRefName,  buyerRefOrg,  buyerRefContact,
      // when the lookup matched, the original CSV row owner's name
      knownName,
    } = req.body || {};

    if (!email) {
      return res.status(400).json({ error: 'email required' });
    }
    if (!process.env.ADMIN_EMAIL) {
      return res.status(500).json({ error: 'ADMIN_EMAIL env var not configured' });
    }

    const row = (label, value) => `
      <tr>
        <td style="background:#f8f4ec;width:160px;padding:10px 14px;border-bottom:1px solid #eee;vertical-align:top;"><strong>${label}</strong></td>
        <td style="padding:10px 14px;border-bottom:1px solid #eee;vertical-align:top;">${value || '—'}</td>
      </tr>`;
    const linkOrDash = (url) =>
      url ? `<a href="${esc(url)}" style="color:#0d1014;">${esc(url)}</a>` : '—';

    const sectionHeader = (label) => `
      <tr>
        <td colspan="2" style="background:#0d1014;color:#f4ede2;padding:8px 14px;font-size:11px;letter-spacing:0.12em;text-transform:uppercase;">${label}</td>
      </tr>`;

    const referralBlock = (talentRefName || buyerRefName) ? `
      ${sectionHeader('Referrals')}
      ${row('Talent — name', esc(talentRefName))}
      ${row('Talent — contact', esc(talentRefContact))}
      ${row('Buyer — name', esc(buyerRefName))}
      ${row('Buyer — org', esc(buyerRefOrg))}
      ${row('Buyer — contact', esc(buyerRefContact))}
    ` : '';

    const html = `
      <html><body style="font-family:-apple-system,system-ui,sans-serif;background:#f4ede2;padding:32px;color:#0d1014;margin:0;">
        <div style="max-width:640px;margin:0 auto;">
          <h2 style="margin:0 0 8px;font-size:20px;">Bench confirmation</h2>
          <p style="color:#555;margin:0 0 20px;">${esc(knownName ? knownName + ' · ' : '')}${esc(email)}</p>
          <table cellpadding="0" cellspacing="0" style="border-collapse:collapse;width:100%;background:#fff;border:1px solid #ddd;font-size:14px;">
            ${sectionHeader('Member')}
            ${row('Email', esc(email))}
            ${knownName ? row('Known as', esc(knownName)) : ''}
            ${row('Availability', esc(availability))}
            ${row('Notes', esc(notes).replace(/\n/g, '<br/>'))}
            ${row('Portfolio', linkOrDash(portfolio))}
            ${referralBlock}
          </table>
          <p style="margin:20px 0 0;color:#555;font-size:13px;">Match to CSV record: ${esc(email)}${knownName ? ' (' + esc(knownName) + ')' : ''}</p>
        </div>
      </body></html>`;

    await resend.emails.send({
      from: FROM,
      to: process.env.ADMIN_EMAIL,
      subject: `Bench confirmation — ${knownName ? knownName + ' · ' : ''}${email}`,
      html,
    });

    // Phase B — live update the Google Sheet. If the email matches an existing
    // bench row, patch availability + portfolio in place. Failures here don't
    // fail the request — admin email already went out, the sheet write is a
    // bonus that catches up on the next /api/lookup-applicant call.
    let sheetUpdate = null;
    try {
      const match = await findBenchRowByEmail(email);
      if (match) {
        const r = await updateBenchRow(match.rowNumber, { availability, portfolio });
        invalidateBenchCache(); // so the next /api/lookup-applicant sees the fresh data
        sheetUpdate = { matched: true, rowNumber: match.rowNumber, updated: r.updated };
      } else {
        sheetUpdate = { matched: false };
      }
    } catch (sheetErr) {
      console.error('sheet update error (non-fatal):', sheetErr);
      sheetUpdate = { matched: false, error: sheetErr.message };
    }

    return res.status(200).json({ success: true, sheetUpdate });
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
