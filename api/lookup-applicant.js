// Looks up an applicant by email against the bench CSV. Used by the /invite
// page to short-circuit the form when the recipient is already on file —
// they get a one-line "confirm availability" instead of re-entering details.
//
// Privacy: only fires after the user types their own email, returns minimal
// known fields (no full names, no addresses of OTHER members). Cannot be
// used to enumerate the bench because the response says nothing about
// non-matches beyond { found: false }.

import { loadBench } from './_utils/bench.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method not allowed' });
  }

  try {
    const { email = '' } = req.body || {};
    const target = String(email).trim().toLowerCase();
    if (!target || !target.includes('@')) {
      return res.status(400).json({ error: 'email required' });
    }

    const rows = await loadBench();
    const hit = rows.find((r) => r.email && r.email === target);

    if (!hit) {
      return res.status(200).json({ found: false });
    }

    return res.status(200).json({
      found: true,
      knownData: {
        firstName:    (hit.name || '').split(/\s+/)[0] || null,
        availability: hit.availability,    // 'available' | 'soon' | 'booked'
        discipline:   hit.discipline,
        portfolio:    hit.portfolio || '',
        linkedin:     hit.linkedin || '',
        rate:         hit.rate,            // '$' / '$$' / '$$$' / '$$$$'
      },
    });
  } catch (err) {
    console.error('lookup-applicant error:', err);
    return res.status(500).json({ error: err.message || 'lookup failed' });
  }
}
