// /api/bench-update
//
// Admin-only mutation endpoint for the bench Sheet. Called by the admin
// panel for: approve / deny / pause / unpause / legend / unlegend /
// revoke / add (manual or from-formspree).
//
// Currently implemented:
//   action: 'add'      → append a new row to the Sheet (used by the
//                        formspree → bench approval queue's "approve →
//                        sheet" button, plus the manual-entry form)
//
// To-do (returns 501 with a clear message until wired):
//   approve, deny, pause, unpause, legend, unlegend, revoke
//   These currently rely on a Sheet column we haven't added yet
//   (e.g. column 21 for "approved=yes"). The client already records
//   them in localStorage, which drives the public bench's visibility
//   filter on each browser, so the absence of a server-side column
//   doesn't block launch — it just means approval state isn't shared
//   across browsers yet.

import { appendBenchRow } from './_utils/sheets.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method not allowed' });
  }

  // Bearer auth — same fallback chain as /api/submissions and /api/send-invites.
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
      // Sheet append. The Formspree submission shape gets flattened by
      // the panel's call site (...data spread), so all expected fields
      // are top-level here.
      const result = await appendBenchRow({
        timestamp:     body.timestamp,
        name:          body.name,
        email:         body.email,
        portfolio:     body.portfolio,
        linkedin:      body.linkedin,
        disciplines:   body.disciplines || body.discipline,
        availability:  body.availability,
        hourlyRate:    body.hourlyRate,
        topClients:    body.topClients || body.clients,
        expLevel:      body.expLevel,
        summary:       body.summary || body.valueProp,
        partnerEmails: body.partnerEmails,
        status:        body.status || 'active',
        confirmed:     body.confirmed,
      });
      return res.status(200).json({ ok: true, action, ...result });
    }

    // Other actions — placeholder. The client already persists these in
    // localStorage so the bench browser's three-state buttons work today;
    // server-side persistence is the next iteration.
    if (['approve','deny','pause','unpause','legend','unlegend','revoke'].includes(action)) {
      return res.status(501).json({
        ok: false,
        error: `action '${action}' not implemented server-side yet — client-side localStorage gate handles this for now`,
      });
    }

    return res.status(400).json({ error: `unknown action: ${action}` });
  } catch (err) {
    return res.status(500).json({
      error: err.message || 'bench-update failed',
      hint:  'check GOOGLE_SERVICE_EMAIL / GOOGLE_PRIVATE_KEY / SHEETS_SPREADSHEET_ID env vars on Vercel; service account must have edit access to the Sheet',
    });
  }
}
