// Shared invite-email helper. Used by /api/send-invites (admin-fired batch)
// and /api/invite-confirm (auto-fired when a bench-confirmed creative
// refers someone with an email contact).
//
// Templates match the existing /api/send-invites copy exactly — same
// brand mark, same subject pattern, same /invite deep link. Single source
// of truth so future copy changes only edit this file.

import { Resend } from 'resend';

const FROM     = 'Colophon <noreply@colophon.contact>';
const REPLY_TO = 'noreply@colophon.contact';
const SITE     = 'https://colophon.contact';

const BRAND_MARK = `
  <table cellpadding="0" cellspacing="0" border="0" style="margin: 0 0 28px;">
    <tr>
      <td>
        <div style="display:inline-block;width:44px;height:44px;background:#f4f1ec;border:2px solid #0d0d0b;border-radius:50%;text-align:center;line-height:40px;vertical-align:middle;">
          <span style="display:inline-block;width:14px;height:14px;background:#ff5100;border-radius:50%;vertical-align:middle;"></span>
        </div>
      </td>
      <td style="padding-left:12px;font-family:'Space Grotesk',Georgia,serif;font-weight:700;font-size:16px;letter-spacing:-0.02em;color:#0d0d0b;vertical-align:middle;">
        colo<span style="color:#ff5100;">phon</span>
      </td>
    </tr>
  </table>`;

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Sends one "X recommended you to Colophon" email and returns
//   { ok: true, id }  on success
//   { ok: false, error } on failure
// `referrer` is the display name that appears in the subject + body.
// `discipline` is unused in the copy but kept for future template variants.
export async function sendInviteEmail({ name, email, referrer, discipline }) {
  if (!email || !name || !referrer) {
    return { ok: false, error: 'missing required fields (name, email, referrer)' };
  }
  if (!process.env.RESEND_API_KEY) {
    return { ok: false, error: 'RESEND_API_KEY not configured' };
  }
  const resend = new Resend(process.env.RESEND_API_KEY);
  const inviteUrl = `${SITE}/invite?name=${encodeURIComponent(name)}&ref=${encodeURIComponent(referrer)}`;
  const subject = `${referrer} recommended you to Colophon.`;
  const html = `
    <div style="background:#f4ede2;padding:56px 24px;font-family:Georgia,'Times New Roman',serif;color:#0d1014;">
      <div style="max-width:520px;margin:0 auto;">
        ${BRAND_MARK}
        <p style="font-size:17px;line-height:1.7;margin:0 0 18px;">${esc(referrer)} thought you'd be a good fit.</p>
        <p style="font-size:17px;line-height:1.7;margin:0 0 18px;">Colophon is a private bench of vetted creative talent — writers, directors, designers, strategists. Hirers come to us when they need the right person fast.</p>
        <p style="font-size:17px;line-height:1.7;margin:0 0 14px;">Confirm your details here — takes 60 seconds:</p>
        <p style="font-size:16px;line-height:1.7;margin:0 0 36px;"><a href="${inviteUrl}" style="color:#0d1014;text-decoration:underline;">${inviteUrl}</a></p>
        <p style="font-size:15px;line-height:1.7;margin:0;">— Colophon</p>
      </div>
    </div>`;
  try {
    const r = await resend.emails.send({
      from: FROM,
      to: email,
      replyTo: REPLY_TO,
      subject,
      html,
    });
    return { ok: true, id: (r && r.data && r.data.id) || null };
  } catch (err) {
    return { ok: false, error: err.message || 'send failed' };
  }
}

// Cheap email-shape check. Same heuristic the apply form uses.
export function looksLikeEmail(s) {
  if (!s || typeof s !== 'string') return false;
  const trimmed = s.trim();
  if (!trimmed.includes('@')) return false;
  // Reject obvious LinkedIn / URL contacts. talentRefContact can be either.
  if (/^https?:\/\//i.test(trimmed)) return false;
  if (/^linkedin\.com/i.test(trimmed)) return false;
  // Crude RFC-ish — local@host.tld
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed);
}
