// /api/action
//
// THE unified mutation endpoint. Every admin button POSTs here.
//
// Body shape:
//   {
//     action:  'approve' | 'reject' | 'pause' | 'unpause',
//     email:   'someone@example.com'   // required
//     // when the email isn't already on the Sheet, the body should
//     // include enough fields to append a new row:
//     name, portfolio, linkedin, disciplines, timezone, availability,
//     hourlyRate, topClients, expLevel, valueProp, partners,
//     referral, social
//     // optional:
//     submissionId       // formspree submission id, for logging
//     sendWelcome        // if true, also fires /api/send-approval-email on approve
//   }
//
// Status mapping (action → canonical sheet status):
//   approve   → 'bench'
//   reject    → 'rejected'
//   pause     → 'paused'
//   unpause   → 'bench'
//
// Behavior: if email already exists on the Sheet, every matching row's
// status is flipped (no orphan duplicates). If email isn't on the Sheet
// yet, a new row is appended with the target status.
//
// Auth: Bearer ADMIN_KEY required.

import { upsertByEmail, setStatusByEmail } from './_utils/sheets-v2.js';

const ACTION_TO_STATUS = {
  approve: 'bench',
  bench:   'bench',
  unpause: 'bench',
  resume:  'bench',
  reject:  'rejected',
  deny:    'rejected',
  revoke:  'rejected',
  pause:   'paused',
};

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

  const body = req.body || {};
  const actionRaw = String(body.action || '').toLowerCase();
  const targetStatus = ACTION_TO_STATUS[actionRaw];
  if (!targetStatus) {
    return res.status(400).json({
      error: `unknown action: ${actionRaw}`,
      hint: 'use approve | reject | pause | unpause',
    });
  }

  const email = String(body.email || '').trim().toLowerCase();
  if (!email.includes('@')) {
    return res.status(400).json({ error: 'email required (must look like name@host.tld)' });
  }

  try {
    // For pause/unpause, only flip existing rows. For approve/reject,
    // upsert (append if not yet on Sheet — covers Formspree-queue approve
    // of a brand-new applicant).
    let result;
    if (actionRaw === 'pause' || actionRaw === 'unpause' || actionRaw === 'resume') {
      result = await setStatusByEmail(email, targetStatus);
      if (!result.rowsTouched) {
        return res.status(404).json({
          ok: false, action: actionRaw,
          error: `no row on Sheet matching ${email} — can't pause/unpause`,
        });
      }
    } else {
      result = await upsertByEmail({
        timestamp:   body.timestamp,
        name:        body.name,
        email,
        portfolio:   body.portfolio,
        linkedin:    body.linkedin,
        disciplines: body.disciplines || body.discipline,
        timezone:    body.timezone || body.tz,
        availability:body.availability,
        hourlyRate:  body.hourlyRate,
        topClients:  body.topClients || body.clients,
        expLevel:    body.expLevel,
        valueProp:   body.valueProp || body.summary,
        partners:    body.partners || body.partnerEmails,
        referral:    body.referral || body.referralContext || body.referrer,
        social:      body.social,
        confirmed:   body.confirmed,
      }, targetStatus);
    }

    // Optional welcome email on approve. Fire-and-forget — failures here
    // don't undo the Sheet write (welcome email is a courtesy, not state).
    let welcome = null;
    if (actionRaw === 'approve' && body.sendWelcome === true && body.name) {
      try {
        // Inline the send — keep this endpoint stateless and not dependent
        // on internal HTTP hops (which used to cause the blank-window bug).
        const { Resend } = await import('resend');
        if (process.env.RESEND_API_KEY) {
          const resend = new Resend(process.env.RESEND_API_KEY);
          const inviteUrl = body.discipline || body.disciplines
            ? `https://colophon.contact/look?discipline=${encodeURIComponent(String(body.discipline || body.disciplines).split(',')[0].trim().toLowerCase())}`
            : 'https://colophon.contact/look';
          const r = await resend.emails.send({
            from: 'Colophon <noreply@colophon.contact>',
            to: email,
            replyTo: 'noreply@colophon.contact',
            subject: `${(body.name || 'there').split(/\s+/)[0]}, you're on the Colophon bench.`,
            text: `Hi ${(body.name || 'there').split(/\s+/)[0]},\n\nQuick note to say you're now on Colophon — the directory of independent freelance creatives in advertising.\n\nYour dossier is live here: ${inviteUrl}\n\nHirers reach you direct from that page — your rate, your contact, no agency in the middle.\n\nWelcome.\n— Max\n\nColophon · https://colophon.contact`,
          });
          welcome = { sent: true, id: (r && r.data && r.data.id) || null };
        } else {
          welcome = { sent: false, error: 'RESEND_API_KEY not set' };
        }
      } catch (e) {
        welcome = { sent: false, error: e.message || 'welcome send failed' };
      }
    }

    return res.status(200).json({
      ok: true,
      action: actionRaw,
      email,
      ...result,
      welcome,
    });
  } catch (err) {
    return res.status(500).json({
      ok: false, action: actionRaw,
      error: err.message || 'action failed',
    });
  }
}
