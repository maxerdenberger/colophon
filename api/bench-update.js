// /api/bench-update
//
// Admin-only mutation endpoint for the bench Sheet — the single source of
// truth for every row's lifecycle. The four canonical states (Sheet col S):
//
//   new       — landed, never touched. The admin queue.
//   bench     — approved, visible on the public bench.
//   rejected  — never showing. Replaces old denied / cold / duplicate.
//   paused    — was on the bench, temporarily hidden (vacations, etc).
//
// Legacy values ('approved', 'active', 'pending', 'denied', 'cold',
// 'duplicate') still parse correctly on read so live behavior is unbroken
// until the step-2 migration flips every row to the new vocabulary.
//
// Actions (case-insensitive — multiple aliases map to the same write):
//   add                          → append a new row (default status='bench')
//   approve | bench              → flip to 'bench'
//   deny | reject | revoke       → flip to 'rejected' (and append if not found)
//   pause                        → flip to 'paused'
//   unpause | resume             → flip to 'bench'
//   pending | new                → flip to 'new'
//   cold                         → flip to 'rejected' (cold collapses in)
//   archive-all-pending          → bulk-flip every new/pending row to 'rejected'
//   legend | unlegend | skip     → still localStorage-only (UI tints, not Sheet state)

import { appendBenchRow, updateBenchStatusByEmail, findBenchRowByEmail, updateBenchRow, bulkArchivePending } from './_utils/sheets.js';

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
        // Persist the apply-form's referrer field to col L. Previously
        // dropped silently — now every approval keeps its source.
        referralContext: body.referralContext || body.referrer || body.referral,
        // Default new rows from the formspree queue to 'bench' so they
        // appear on the public bench immediately. The operator already
        // vetted them by clicking "approve → sheet". Pass status='new'
        // explicitly if you want a two-step review instead.
        status:        body.status || 'bench',
        confirmed:     body.confirmed,
      });
      return res.status(200).json({ ok: true, action, ...result });
    }

    // ── Smart reject ─────────────────────────────────────────────────
    // Used by the Formspree queue's reject button. If the email is already
    // on the Sheet, just flips status to 'denied'. If not, appends a fresh
    // denied row so we keep a permanent record (the rejects bin). Either
    // way the operator never sees this person in the queue again — even
    // across browsers, devices, or new submissions from the same email.
    if (action === 'reject') {
      const email = String(body.email || '').trim();
      if (email.includes('@')) {
        try {
          const found = await findBenchRowByEmail(email);
          if (found) {
            const r = await updateBenchRow(found.rowNumber, { status: 'rejected' });
            return res.status(200).json({ ok: true, action, status: 'rejected', mode: 'updated', rowNumber: found.rowNumber, updated: r.updated });
          }
        } catch (_) {}
      }
      const appended = await appendBenchRow({
        timestamp:     body.timestamp,
        name:          body.name,
        email,
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
        referralContext: body.referralContext || body.referrer || body.referral,
        status:        'rejected',
        confirmed:     body.confirmed,
      });
      return res.status(200).json({ ok: true, action, status: 'rejected', mode: 'appended', ...appended });
    }

    // ── Bulk archive ─────────────────────────────────────────────────
    // Flips every pending/empty row to 'denied'. Approved rows untouched.
    // The 'archive all remaining pending' button calls this once to clear
    // the parking-lot backlog so the only states left are approved + rejected.
    if (action === 'archive-all-pending') {
      const r = await bulkArchivePending();
      return res.status(200).json({ ok: true, action, ...r });
    }

    // Status-changing actions. All require an email to look up the row.
    // Maps action -> canonical four-state value. Old action names (deny,
    // revoke, pending, cold) keep working but write the new vocabulary.
    const STATUS_FOR_ACTION = {
      // approvals
      approve: 'bench',
      bench:   'bench',
      unpause: 'bench',
      resume:  'bench',
      // rejections — all collapse into a single 'rejected' state
      deny:     'rejected',
      reject:   'rejected',
      revoke:   'rejected',
      rejected: 'rejected',
      cold:     'rejected',
      // queue
      pending: 'new',
      new:     'new',
      // pause
      pause:  'paused',
      paused: 'paused',
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

    // legend/unlegend/skip → still localStorage-only. legend is a UI tint
    // ('star' a row in the bench browser); skip is a transient queue
    // dismissal. Neither is a Sheet status. pause/unpause now write to
    // the Sheet via STATUS_FOR_ACTION above, so they're not in this list.
    if (['legend','unlegend','skip'].includes(action)) {
      return res.status(200).json({ ok: true, action, note: 'localStorage-only — UI hint, not Sheet status' });
    }

    return res.status(400).json({ error: `unknown action: ${action}` });
  } catch (err) {
    return res.status(500).json({
      error: err.message || 'bench-update failed',
      hint:  'check GOOGLE_SERVICE_EMAIL / GOOGLE_PRIVATE_KEY / SHEETS_SPREADSHEET_ID env vars on Vercel',
    });
  }
}
