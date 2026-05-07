// /api/send-approval-email
//
// Admin-only "you're on the bench" email. Triggered from the admin
// panel whenever a creative is approved — from the Formspree queue,
// the bench browser, or the bulk-approve-by-emails flow. Idempotent
// at the client side (the AdminBenchBrowser stamps a 'welcome'
// op in localStorage so the same row doesn't fire twice on a
// re-click), so this endpoint just sends.
//
// POST body:
//   {
//     to:          string  (creative's email — required)
//     name:        string  (display name; first name parsed for the salute)
//     discipline:  string  (optional — used to deep-link the bench filter)
//     customMessage: string (optional — operator can prepend a note)
//   }
//
// Replies-to bench@colophon.contact so creatives can write back.
// Logs to a "welcome_log" tab in the source spreadsheet (best-effort,
// failures don't block the response) so we can see how many of these
// have gone out without trawling Resend's dashboard.

import { Resend } from 'resend';
import { google } from 'googleapis';

const FROM = 'Colophon <bench@colophon.contact>';
const REPLY_TO = process.env.REPLY_TO_EMAIL || 'merdenberger@gmail.com';
const SITE = 'https://colophon.contact';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method not allowed' });
  }

  const auth = req.headers.authorization || '';
  const adminKey = process.env.ADMIN_KEY || process.env.ADMIN_SECRET || '590Rossmore';
  if (auth !== `Bearer ${adminKey}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  if (!process.env.RESEND_API_KEY) {
    return res.status(501).json({ error: 'RESEND_API_KEY not configured on Vercel' });
  }

  const body = req.body || {};
  const to = String(body.to || '').trim();
  if (!to.includes('@')) return res.status(400).json({ error: 'missing or invalid `to` email' });

  const fullName = String(body.name || '').trim();
  const firstName = (fullName.split(/\s+/)[0] || '').trim() || 'there';
  const discipline = String(body.discipline || '').trim();
  const customMessage = String(body.customMessage || '').trim();

  // Bench deep-link — focus=<base64 email> opens the bench with the
  // creative's row scrolled-to + selected. preview=1 bypasses the paywall
  // for THIS visit so they can actually see their profile (a creative
  // doesn't have a hirer pass; without preview they'd hit the lock screen).
  // share-friendly variant: the same link, minus preview, points to the
  // discipline-filtered bench for them to forward to a hirer.
  const focusToken  = Buffer.from(to.toLowerCase()).toString('base64');
  const benchUrl    = `${SITE}/look?preview=1&focus=${encodeURIComponent(focusToken)}`;
  const shareUrl    = discipline
    ? `${SITE}/look?discipline=${encodeURIComponent(disciplineSlug(discipline))}`
    : `${SITE}/look`;

  const subject = `${firstName.charAt(0).toUpperCase() + firstName.slice(1)}, you're on the Colophon bench.`;

  // Plain text version — what most creatives prefer to read.
  const text = [
    `Hi ${firstName},`,
    ``,
    `Quick note to say you're now on Colophon — the directory of independent freelance creatives in advertising.`,
    ``,
    customMessage ? `${customMessage}\n` : null,
    `Your dossier is live here:`,
    `${benchUrl}`,
    ``,
    `Hirers reach you direct from that page — your rate, your contact, no agency in the middle. The bench is small on purpose, and you made it.`,
    ``,
    `If you'd like to share that you're on the bench, here are a few options you can copy as-is (these point at the public bench, not your private preview link):`,
    ``,
    `LinkedIn / general post:`,
    `Just joined Colophon — a directory of independent freelance creatives in advertising. Editor-curated, no agency markup, every name vouched for. ${shareUrl}`,
    ``,
    `Twitter / X / Threads:`,
    `Now on Colophon. The group text, made legible. ${shareUrl}`,
    ``,
    `Instagram caption:`,
    `on the bench. ${shareUrl} (link in your bio works best — IG eats raw URLs)`,
    ``,
    `Reply to this email if anything on your profile needs editing or if you want to update your availability — I read every reply.`,
    ``,
    `Welcome.`,
    `— Max`,
    ``,
    `Colophon · ${SITE}`,
  ].filter(Boolean).join('\n');

  // HTML — uses the same brand-mark styling as the year-renewal mail.
  // Cream paper, serif body, mono labels for the share-snippet headers.
  const safeFirst   = esc(firstName);
  const safeBench   = esc(benchUrl);
  const safeCustom  = esc(customMessage);
  const safeSubject = esc(subject);
  // Wordmark uses Space Grotesk Bold to match the site. Loaded via the
  // <link> in <head> for clients that support web fonts (Gmail web, Apple
  // Mail, iOS Mail). Outlook desktop falls through to Helvetica/Arial —
  // never to a serif (so the wordmark stays sans-serif everywhere).
  const html = `<!doctype html>
<html>
<head>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@700&display=swap" rel="stylesheet">
</head>
<body style="margin:0;padding:0;background:#f4ede2;">
  <div style="background:#f4ede2;padding:48px 24px;font-family:Georgia,'Times New Roman',serif;color:#0d1014;">
    <div style="max-width:560px;margin:0 auto;font-size:16px;line-height:1.7;">

      <!-- Brand lockup — circle-in-circle dot stacked above the "colophon" wordmark, left-justified. Wordmark in Space Grotesk Bold, last 4 letters orange. Matches the site header. -->
      <div style="margin:0 0 28px;text-align:left;">
        <div style="margin:0 0 12px;line-height:0;">
          <span style="display:inline-block;width:24px;height:24px;background:#f4ede2;border:1.5px solid #0d1014;border-radius:50%;box-sizing:border-box;text-align:center;line-height:20px;"><span style="display:inline-block;width:9px;height:9px;background:#FF5100;border-radius:50%;vertical-align:1px;"></span></span>
        </div>
        <div style="font-family:'Space Grotesk','Helvetica Neue',Helvetica,Arial,sans-serif;font-weight:700;font-size:26px;letter-spacing:-0.02em;color:#0d1014;line-height:1;">colo<span style="color:#FF5100;">phon</span></div>
      </div>

      <p style="font-size:11px;letter-spacing:0.18em;color:#888580;text-transform:uppercase;margin:0 0 24px;font-family:'IBM Plex Mono','Menlo',monospace;">welcome to the bench</p>

      <p style="margin:0 0 16px;">Hi ${safeFirst},</p>

      <p style="margin:0 0 16px;">Quick note to say you're now on <span style="font-family:'Space Grotesk','Helvetica Neue',Helvetica,Arial,sans-serif;font-weight:700;">Colophon</span> — the directory of independent freelance creatives in advertising.</p>

      ${safeCustom ? `<p style="margin:0 0 16px;font-style:italic;color:#3D3C38;">${safeCustom}</p>` : ''}

      <p style="margin:0 0 8px;">Your dossier is live here:</p>
      <p style="margin:0 0 24px;"><a href="${safeBench}" style="display:inline-block;background:#0d1014;color:#f4ede2;padding:12px 18px;text-decoration:none;font-family:'IBM Plex Mono','Menlo',monospace;font-size:12px;letter-spacing:0.06em;border-radius:2px;">view your bench page →</a></p>

      <p style="margin:0 0 24px;">Hirers reach you direct from that page — your rate, your contact, no agency in the middle. The bench is small on purpose, and you made it.</p>

      <hr style="border:0;border-top:1px solid rgba(13,16,20,0.12);margin:32px 0;" />

      <p style="font-size:11px;letter-spacing:0.18em;color:#888580;text-transform:uppercase;margin:0 0 8px;font-family:'IBM Plex Mono','Menlo',monospace;">share with the world</p>
      <p style="margin:0 0 16px;color:#3D3C38;font-size:14px;">A few drop-in posts you can copy as-is. Or write your own — whatever fits.</p>

      ${shareBlock('LinkedIn / general post',
        `Just joined Colophon — a directory of independent freelance creatives in advertising. Editor-curated, no agency markup, every name vouched for. ${shareUrl}`,
        `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(shareUrl)}`)}

      ${shareBlock('Twitter / X / Threads',
        `Now on Colophon. The group text, made legible. ${shareUrl}`,
        `https://twitter.com/intent/tweet?text=${encodeURIComponent('Now on Colophon. The group text, made legible.')}&url=${encodeURIComponent(shareUrl)}`)}

      ${shareBlock('Instagram caption',
        `on the bench. ${shareUrl} (link in your bio works best — IG eats raw URLs)`,
        null)}

      <hr style="border:0;border-top:1px solid rgba(13,16,20,0.12);margin:32px 0;" />

      <p style="margin:0 0 16px;">Reply to this email if anything on your profile needs editing or if you want to update your availability — I read every reply.</p>

      <p style="margin:0 0 8px;">Welcome.</p>
      <p style="margin:0 0 32px;">— Max</p>

      <p style="font-size:11px;color:#888580;font-family:'IBM Plex Mono','Menlo',monospace;letter-spacing:0.04em;text-transform:uppercase;margin:0;">colophon · <a href="${SITE}" style="color:#888580;text-decoration:underline;">${SITE.replace(/^https?:\/\//, '')}</a></p>
    </div>
  </div>
  </body></html>`;

  let sentId = null;
  try {
    const resend = new Resend(process.env.RESEND_API_KEY);
    const r = await resend.emails.send({
      from: FROM,
      to,
      replyTo: REPLY_TO,
      subject,
      text,
      html,
    });
    sentId = r && r.data && r.data.id;
  } catch (err) {
    return res.status(502).json({ error: err.message || 'resend send failed' });
  }

  // Best-effort log row — separate tab so it doesn't pollute concierge_log.
  // Useful for double-checking nobody got a welcome twice across sessions
  // even if a different operator browser doesn't have the localStorage stamp.
  let logged = false;
  try {
    if (process.env.GOOGLE_SERVICE_EMAIL && process.env.GOOGLE_PRIVATE_KEY && process.env.SHEETS_SPREADSHEET_ID) {
      const auth2 = new google.auth.JWT({
        email: process.env.GOOGLE_SERVICE_EMAIL,
        key: String(process.env.GOOGLE_PRIVATE_KEY).replace(/\\n/g, '\n'),
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
      });
      const sheets = google.sheets({ version: 'v4', auth: auth2 });
      const tab = process.env.WELCOME_LOG_TAB || 'welcome_log';
      await sheets.spreadsheets.values.append({
        spreadsheetId: process.env.SHEETS_SPREADSHEET_ID,
        range: `${tab}!A:E`,
        valueInputOption: 'RAW',
        insertDataOption: 'INSERT_ROWS',
        requestBody: {
          values: [[
            new Date().toISOString(),
            to,
            fullName,
            discipline || '',
            sentId || '',
          ]],
        },
      });
      logged = true;
    }
  } catch {
    // Sheet log failure is not fatal — the email still went out.
  }

  return res.status(200).json({ ok: true, id: sentId, logged, to, subject });
}

// Inline helper — a labeled block with the share copy and an optional
// "open share dialog" link. Keeps the email clean and scannable.
function shareBlock(label, text, shareUrl) {
  const safeLabel = esc(label);
  const safeText = esc(text);
  const opener = shareUrl
    ? `<a href="${shareUrl}" style="font-family:'IBM Plex Mono','Menlo',monospace;font-size:11px;color:#0d1014;text-decoration:underline;letter-spacing:0.04em;">open share dialog →</a>`
    : '';
  return `
    <div style="margin:0 0 22px;padding:14px 16px;background:rgba(13,16,20,0.04);border-left:2px solid #0d1014;">
      <p style="font-size:10px;letter-spacing:0.16em;color:#3D3C38;text-transform:uppercase;margin:0 0 8px;font-family:'IBM Plex Mono','Menlo',monospace;">${safeLabel}</p>
      <p style="margin:0 0 ${opener ? '10px' : '0'};font-size:14px;line-height:1.55;color:#0d1014;">${safeText}</p>
      ${opener}
    </div>
  `;
}

// Map a discipline string to the bench page's filter slug. Best-effort —
// if no match, the welcome links to /look bare which still works.
function disciplineSlug(d) {
  const s = String(d || '').toLowerCase();
  if (/(copy|writer)/.test(s))               return 'writer';
  if (/(art\s*direct|^ad\b)/.test(s))        return 'art-director';
  if (/(design\s*lead|design\s*direct)/.test(s)) return 'design-lead';
  if (/(brand\s*strat|strateg)/.test(s))     return 'strategist';
  if (/(creative\s*direct|^cd\b)/.test(s))   return 'creative-director';
  if (/design/.test(s))                      return 'designer';
  return '';
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
