// /api/bench-update
//
// Admin-only mutation endpoint for the bench Sheet. Single source of truth
// for whether a row appears on the public bench: the `status` column (S /
// index 18) on the source Sheet. The /admin panel POSTs here for every
// approve/deny/revoke action; the public bench reads the resulting CSV
// and filters where status === 'approved'. No more localStorage gates.
//
// Actions:
//   add       → append a new row. Defaults to status='approved' (one-click
//                approval from the formspree queue). Pass status='pending'
//                if the import should land in the pending queue instead.
//   approve   → set existing row's status='approved' (visible on public bench)
//   deny      → set status='denied' (hidden, soft-rejected — recoverable)
//   revoke    → alias for deny
//   pending   → set status='pending' (back into the review queue)
//   cold      → set status='cold'

import { appendBenchRow, updateBenchStatusByEmail } from './_utils/sheets.js';

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
  const action = String(body.action || '').toLowerCase();
  if (!action) return res.status(400).json({ error: 'missing action' });

  try {
    if (action === 'add') {
      const result = await appendBenchRow({
        timestamp:     body.timestamp,
        name:          body.name,
        email:         body.email,
        portfolio:     body.portfolio,
        linkedin:      body.linkedin,
        disciplines:   body.disciplines || body.discipline,
        timezone:      body.timezone || body.tz,
        availability:  body.availability,
        hourlyRate:    body.hourlyRate,
        topClients:    body.topClients || body.clients,
        expLevel:      body.expLevel,
        summary:       body.summary || body.valueProp,
        partnerEmails: body.partnerEmails,
        social:        body.social,
        // Default new rows from the formspree queue to 'approved' so they
        // appear on the public bench immediately. The operator already
        // vetted them by clicking "approve → sheet". Pass status='pending'
        // explicitly if you want a two-step review instead.
        status:        body.status || 'approved',
        confirmed:     body.confirmed,
      });
      return res.status(200).json({ ok: true, action, ...result });
    }

    // Status-changing actions. All require an email to look up the row.
    const STATUS_FOR_ACTION = {
      approve: 'approved',
      deny:    'denied',
      reject:  'denied',
      revoke:  'denied',
      pending: 'pending',
      cold:    'cold',
    };
    if (action in STATUS_FOR_ACTION) {
      const newStatus = STATUS_FOR_ACTION[action];
      const email = String(body.email || '').trim();
      if (!email.includes('@')) {
        return res.status(400).json({
          error: `${action} requires an email to look up the row`,
          hint:  'pass { email: "person@example.com" } in the body',
        });
      }
      const r = await updateBenchStatusByEmail(email, newStatus);
      if (!r.rowNumber) {
        return res.status(404).json({ ok: false, action, error: `no row in Sheet matching ${email}` });
      }
      return res.status(200).json({ ok: true, action, status: newStatus, ...r });
    }

    // pause/unpause/legend/unlegend → still localStorage-only (return 200
    // so the client doesn't surface an error; the UI tint state remains
    // local for these for now).
    if (['pause','unpause','resume','legend','unlegend','skip'].includes(action)) {
      return res.status(200).json({ ok: true, action, note: 'localStorage-only — Sheet status not changed' });
    }

    return res.status(400).json({ error: `unknown action: ${action}` });
  } catch (err) {
    return res.status(500).json({
      error: err.message || 'bench-update failed',
      hint:  'check GOOGLE_SERVICE_EMAIL / GOOGLE_PRIVATE_KEY / SHEETS_SPREADSHEET_ID env vars on Vercel',
    });
  }
}
