// /api/bench
//
// THE bench data endpoint. Reads the Sheet directly via service account
// (NOT Google's publish-to-web CSV — that's the 5-minute cache that
// caused months of drift). 15-second function-level cache, then a
// fresh read.
//
// Auth: public read (the bench page calls this). Admin gets richer
// fields when Authorization: Bearer <ADMIN_KEY> is set.
//
// Query params:
//   ?status=bench|new|rejected|paused   — filter to one status
//   ?status=all                         — return all rows regardless
// Default behavior:
//   - public (no auth)   → status=bench only, sanitized fields
//   - admin (with auth)  → status=all, full fields

import { readBench } from './_utils/sheets-v2.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'method not allowed' });
  }

  const auth = req.headers.authorization || '';
  const adminKey = process.env.ADMIN_KEY || process.env.ADMIN_SECRET || '590Rossmore';
  const isAdmin = auth === `Bearer ${adminKey}`;

  // Status filter defaults: admin sees everything, public only bench
  const wantStatus = String((req.query && req.query.status) || '').toLowerCase();
  const statusFilter =
    wantStatus === 'all' ? null :
    wantStatus ? [wantStatus] :
    (isAdmin ? null : ['bench']);

  try {
    const { rows, headerMap } = await readBench();
    let filtered = rows;
    if (statusFilter) filtered = filtered.filter((r) => statusFilter.includes(r.status));

    // Public-facing: strip raw email + admin-internal columns. Admin
    // gets everything. The shape mirrors how the React side renders.
    const projected = filtered.map((r) => {
      const base = {
        rowNumber:    r.rowNumber,
        name:         r.name,
        portfolio:    r.portfolio,
        linkedin:     r.linkedin,
        disciplines:  r.disciplines,
        timezone:     r.timezone,
        availability: r.availability,
        hourlyRate:   r.hourlyRate,
        topClients:   r.topClients,
        expLevel:     r.expLevel,
        yoe:          r.yoe,
        valueProp:    r.valueProp,
        social:       r.social,
        status:       r.status,
        lastUpdatedTs:r.lastUpdatedTs,
        createdAtTs:  r.createdAtTs,
      };
      if (isAdmin) {
        base.email     = r.email;
        base.referral  = r.referral;
        base.partners  = r.partners;
        base.confirmed = r.confirmed;
        base.statusRaw = r.statusRaw;
      }
      return base;
    });

    return res.status(200).json({
      rows: projected,
      count: projected.length,
      filtered: !!statusFilter,
      statusFilter,
      isAdmin,
      headerColumns: Object.keys(headerMap.map),
      unknownHeaders: headerMap.unknown,
      cachedTtlSec: 15,
      ts: new Date().toISOString(),
    });
  } catch (err) {
    return res.status(500).json({
      error: err.message || 'bench read failed',
      hint: 'check GOOGLE_SERVICE_EMAIL / GOOGLE_PRIVATE_KEY / SHEETS_SPREADSHEET_ID env vars',
    });
  }
}
