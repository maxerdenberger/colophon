// /api/audit-duplicates
//
// Returns duplicate bench rows grouped by lowercased email. For each
// group we identify the most-recent row (by Last Updated timestamp,
// falling back to createdAt) and tag the rest as stale.
//
// Uses the new header-based readBench helper, so it survives Sheet
// column reorders.
//
// ?onlyBench=1  — restrict to groups where multiple rows currently
//                 have status='bench' (the ones cluttering the public
//                 bench, the only ones worth deduping aggressively).
//
// Returns:
//   {
//     totalRows, duplicateGroups, duplicateRows,
//     groups: [
//       { email, count, keep: {...}, stale: [...] }
//     ]
//   }

import { readBench } from './_utils/sheets-v2.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'method not allowed' });
  }

  const auth = req.headers.authorization || '';
  const adminKey = process.env.ADMIN_KEY || process.env.ADMIN_SECRET || '590Rossmore';
  if (auth !== `Bearer ${adminKey}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  try {
    const { rows } = await readBench({ force: true });
    const onlyBench = String((req.query && req.query.onlyBench) || '') === '1';

    // Group by lowercased email
    const byEmail = new Map();
    for (const r of rows) {
      const email = String(r.email || '').trim().toLowerCase();
      if (!email || !email.includes('@')) continue;
      const list = byEmail.get(email) || [];
      list.push({
        rowNumber:   r.rowNumber,
        timestamp:   r.lastUpdatedTs ? new Date(r.lastUpdatedTs).toISOString() : (r.createdAtTs ? new Date(r.createdAtTs).toISOString() : ''),
        timestampMs: r.lastUpdatedTs || r.createdAtTs || 0,
        name:        r.name,
        portfolio:   r.portfolio,
        linkedin:    r.linkedin,
        disciplines: r.disciplines,
        availability:r.availability,
        hourlyRate:  r.hourlyRate,
        topClients:  r.topClients,
        expLevel:    r.expLevel,
        valueProp:   r.valueProp,
        partners:    r.partners,
        status:      r.status,
        confirmed:   r.confirmed,
      });
      byEmail.set(email, list);
    }

    const groups = [];
    for (const [email, list] of byEmail) {
      if (list.length < 2) continue;
      if (onlyBench) {
        const benchCount = list.filter((r) => r.status === 'bench').length;
        if (benchCount < 2) continue;   // only cares about visible-bench duplicates
      }
      // Most-recent first; bench-status rows preferred for the 'keep' position
      // (within the most-recent group, prefer the one already on the bench so
      // the dedup keeps the visible row).
      list.sort((a, b) => {
        if (a.status === 'bench' && b.status !== 'bench') return -1;
        if (b.status === 'bench' && a.status !== 'bench') return 1;
        return (b.timestampMs - a.timestampMs) || (b.rowNumber - a.rowNumber);
      });
      const [keep, ...stale] = list;
      groups.push({ email, count: list.length, keep, stale });
    }
    groups.sort((a, b) => b.count - a.count);

    return res.status(200).json({
      totalRows: rows.length,
      duplicateGroups: groups.length,
      duplicateRows: groups.reduce((s, g) => s + g.stale.length, 0),
      filter: onlyBench ? 'only-bench' : 'all',
      groups,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'audit failed' });
  }
}
