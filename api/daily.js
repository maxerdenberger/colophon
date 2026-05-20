// /api/daily — the freshness cron.
//
// Fires once a day via Vercel Cron (configured in vercel.json). One pass
// over the bench Sheet does three things in order:
//
//   1. AUTO-PAUSE — any bench row with lastUpdated >90 days → status='paused'.
//      They come off the public bench until they respond.
//
//   2. AUTO-SELECTIVE — any bench row with lastUpdated >45 days and
//      availability != 'selective' → availability flips to 'selective'.
//      They stay on the bench but signal "ask first".
//
//   3. PING THE STALE 25 — bench rows past 21 days, sorted oldest first,
//      take the top 25, send each the availability ping email. Their click
//      writes their new state straight to the Sheet via /api/update-availability.
//
// Configuration (env vars, with defaults):
//   FRESH_DAYS=21              — days inside which a row is considered fresh
//   SELECTIVE_DAYS=45          — days past which row flips to 'selective'
//   PAUSE_DAYS=90              — days past which row flips to 'paused'
//   DAILY_BATCH_SIZE=25        — max rows to ping per run (Resend free tier 100/day)
//   CRON_SECRET                — if set, requires Authorization: Bearer <secret>
//                                 (Vercel Cron sends this automatically if set)
//
// Admin-only ping (manual trigger) also accepted: same endpoint with
// admin Bearer token.

import { Resend } from 'resend';
import crypto from 'crypto';
import { readBench, setStatusByEmail } from './_utils/sheets-v2.js';
import { google } from 'googleapis';

const FROM     = 'Colophon <noreply@colophon.contact>';
const REPLY_TO = 'noreply@colophon.contact';
const SITE     = 'https://colophon.contact';

const FRESH_DAYS     = parseInt(process.env.FRESH_DAYS || '21', 10);
const SELECTIVE_DAYS = parseInt(process.env.SELECTIVE_DAYS || '45', 10);
const PAUSE_DAYS     = parseInt(process.env.PAUSE_DAYS || '90', 10);
const DAILY_BATCH    = parseInt(process.env.DAILY_BATCH_SIZE || '25', 10);

const DAY = 24 * 60 * 60 * 1000;

function tokenFor(email) {
  const secret = process.env.AVAILABILITY_TOKEN_SECRET || process.env.ADMIN_KEY || '590Rossmore';
  return crypto.createHmac('sha256', secret).update(String(email).trim().toLowerCase()).digest('hex').slice(0, 32);
}

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function buildPingEmail(name, email) {
  const firstName = String(name || '').trim().split(/\s+/)[0] || 'there';
  const tok = tokenFor(email);
  const link = (value) => `${SITE}/api/update-availability?email=${encodeURIComponent(email)}&token=${tok}&value=${encodeURIComponent(value)}`;
  const subject = `${firstName.charAt(0).toUpperCase() + firstName.slice(1)}, quick availability update?`;
  const text = [
    `Hi ${firstName},`,
    ``,
    `quick one — the bench runs in real time. tap whichever line fits today — your status updates now. no reply needed.`,
    ``,
    `Available now:           ${link('available')}`,
    `Available in 2–4 weeks:  ${link('soon')}`,
    `Booked / waitlist:       ${link('booked')}`,
    ``,
    `— Max`,
    `Colophon · ${SITE}`,
  ].join('\n');
  const safeFirst = esc(firstName);
  const html = `<!doctype html>
<html><body style="margin:0;padding:0;background:#f4ede2;">
  <div style="background:#f4ede2;padding:48px 24px;font-family:Georgia,'Times New Roman',serif;color:#0d1014;">
    <div style="max-width:560px;margin:0 auto;font-size:16px;line-height:1.7;">
      <p style="font-size:11px;letter-spacing:0.18em;color:#888580;text-transform:uppercase;margin:0 0 24px;font-family:'IBM Plex Mono','Menlo',monospace;">availability check-in</p>
      <p style="margin:0 0 16px;">Hi ${safeFirst},</p>
      <p style="margin:0 0 24px;">Quick one — the bench runs in real time. Tap whichever line fits today — your status updates now. No reply needed.</p>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 28px;">
        <tr><td style="padding:0 0 10px;">
          <a href="${link('available')}" style="display:block;background:#3F7F4A;color:#f4ede2;padding:14px 18px;text-decoration:none;font-family:'IBM Plex Mono','Menlo',monospace;font-size:13px;letter-spacing:0.04em;border-radius:2px;text-align:left;">
            <strong style="font-weight:500;">available now</strong>
          </a>
        </td></tr>
        <tr><td style="padding:0 0 10px;">
          <a href="${link('soon')}" style="display:block;background:#C87C18;color:#f4ede2;padding:14px 18px;text-decoration:none;font-family:'IBM Plex Mono','Menlo',monospace;font-size:13px;letter-spacing:0.04em;border-radius:2px;text-align:left;">
            <strong style="font-weight:500;">available in 2–4 weeks</strong>
          </a>
        </td></tr>
        <tr><td>
          <a href="${link('booked')}" style="display:block;background:#0d1014;color:#f4ede2;padding:14px 18px;text-decoration:none;font-family:'IBM Plex Mono','Menlo',monospace;font-size:13px;letter-spacing:0.04em;border-radius:2px;text-align:left;">
            <strong style="font-weight:500;">booked / waitlist only</strong>
          </a>
        </td></tr>
      </table>
      <p style="margin:0 0 32px;">— Max · Colophon</p>
    </div>
  </div>
</body></html>`;
  return { subject, text, html };
}

// Directly write to the Sheet's Availability column using header-name lookup.
async function setAvailability(rowNumber, headerMap, value) {
  const availCol = headerMap.map.availability;
  const lastUpdatedCol = headerMap.map.lastUpdated;
  if (availCol == null) return { skipped: 'no availability column' };
  const sheets = google.sheets({
    version: 'v4',
    auth: new google.auth.JWT({
      email: process.env.GOOGLE_SERVICE_EMAIL,
      key: String(process.env.GOOGLE_PRIVATE_KEY).replace(/\\n/g, '\n'),
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    }),
  });
  const colLetter = (n) => {
    let s = '', m = n + 1;
    while (m > 0) { const mod = (m - 1) % 26; s = String.fromCharCode(65 + mod) + s; m = Math.floor((m - 1) / 26); }
    return s;
  };
  const data = [{ range: `${process.env.SHEETS_TAB_NAME || 'Form Responses 1'}!${colLetter(availCol)}${rowNumber}`, values: [[value]] }];
  if (lastUpdatedCol != null) {
    data.push({ range: `${process.env.SHEETS_TAB_NAME || 'Form Responses 1'}!${colLetter(lastUpdatedCol)}${rowNumber}`, values: [[new Date().toISOString()]] });
  }
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: process.env.SHEETS_SPREADSHEET_ID,
    requestBody: { valueInputOption: 'RAW', data },
  });
  return { updated: true };
}

export default async function handler(req, res) {
  // Auth: accept Vercel Cron OR admin Bearer.
  const cronAuth = req.headers.authorization || '';
  const cronSecret = process.env.CRON_SECRET;
  const adminKey = process.env.ADMIN_KEY || process.env.ADMIN_SECRET || '590Rossmore';
  const isVercelCron = !!req.headers['x-vercel-cron'] || (cronSecret && cronAuth === `Bearer ${cronSecret}`);
  const isAdmin = cronAuth === `Bearer ${adminKey}`;
  if (!isVercelCron && !isAdmin) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const dryRun = !!(req.query && req.query.dryRun === '1');
  const now = Date.now();

  try {
    const { rows, headerMap } = await readBench({ force: true });

    // Operate only on bench rows (visible on public bench)
    const benchRows = rows.filter((r) => r.status === 'bench' && r.email);

    // --- Step 1: auto-pause anything >90 days stale ---
    const toPause = benchRows.filter((r) => {
      if (!r.lastUpdatedTs) return false; // never set — leave alone, will be pinged
      return (now - r.lastUpdatedTs) > PAUSE_DAYS * DAY;
    });
    const paused = [];
    if (!dryRun) {
      for (const r of toPause) {
        try {
          await setStatusByEmail(r.email, 'paused');
          paused.push(r.email);
        } catch (e) {
          // continue — best effort
        }
      }
    }

    // --- Step 2: flip 45-90 day stale to 'selective' availability ---
    const toSelective = benchRows.filter((r) => {
      if (!r.lastUpdatedTs) return false;
      const ageDays = (now - r.lastUpdatedTs) / DAY;
      const isAvailSelective = String(r.availability || '').toLowerCase().includes('selective');
      return ageDays > SELECTIVE_DAYS && ageDays <= PAUSE_DAYS && !isAvailSelective && r.status === 'bench';
    });
    const madeSelective = [];
    if (!dryRun) {
      for (const r of toSelective) {
        try {
          await setAvailability(r.rowNumber, headerMap, 'selective');
          madeSelective.push(r.email);
        } catch (e) { /* best effort */ }
      }
    }

    // --- Step 3: ping the 25 stalest rows past 21 days ---
    // Re-read bench so pause/selective flips above don't get re-pinged.
    const { rows: fresh } = await readBench({ force: true });
    const eligible = fresh.filter((r) => r.status === 'bench' && r.email);
    const stale = eligible
      .map((r) => ({ ...r, ageDays: r.lastUpdatedTs ? (now - r.lastUpdatedTs) / DAY : Infinity }))
      .filter((r) => r.ageDays > FRESH_DAYS)
      .sort((a, b) => b.ageDays - a.ageDays);  // most stale first
    const batch = stale.slice(0, DAILY_BATCH);

    let sent = 0;
    const failures = [];
    if (!dryRun && process.env.RESEND_API_KEY) {
      const resend = new Resend(process.env.RESEND_API_KEY);
      for (const r of batch) {
        try {
          const msg = buildPingEmail(r.name, r.email);
          await resend.emails.send({
            from: FROM,
            to: r.email,
            replyTo: REPLY_TO,
            subject: msg.subject,
            text: msg.text,
            html: msg.html,
          });
          sent++;
        } catch (err) {
          failures.push({ email: r.email, error: err.message || 'send failed' });
        }
      }
    }

    return res.status(200).json({
      ok: true,
      ts: new Date().toISOString(),
      mode: dryRun ? 'dryRun' : (isVercelCron ? 'cron' : 'manual'),
      thresholds: { freshDays: FRESH_DAYS, selectiveDays: SELECTIVE_DAYS, pauseDays: PAUSE_DAYS, dailyBatch: DAILY_BATCH },
      counts: {
        benchEligible: eligible.length,
        autoPaused: paused.length,
        autoSelective: madeSelective.length,
        stalePool: stale.length,
        pingedThisRun: sent,
        pingFailures: failures.length,
      },
      paused,
      madeSelective,
      pinged: batch.slice(0, 50).map((r) => ({ email: r.email, name: r.name, ageDays: Math.round(r.ageDays * 10) / 10 })),
      failures: failures.slice(0, 12),
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err.message || 'daily run failed',
    });
  }
}
