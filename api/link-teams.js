// /api/link-teams
//
// Sets up reciprocal team / partner relationships in the bench Sheet.
// Given a list of "groups" (each group = 2+ emails), this writes the
// partner column (R) on every member's row to include the others.
//
// Idempotent — re-running with the same groups produces the same final
// state. Existing partner emails on a row are preserved + merged with
// the new ones (deduped, lowercased).
//
// POST body:
//   {
//     groups: [
//       ["merdenberger@gmail.com", "greg.rutter@gmail.com"],
//       ["merdenberger@gmail.com", "kaceycoburn@gmail.com"],
//       ["russ@russrizzo.com", "caseyphillips.work@gmail.com"]
//     ]
//   }
//
// Returns:
//   { ok: true, updated: [{ email, rowNumber, partners }], missing: [emails…] }

import { google } from 'googleapis';
import { findBenchRowByEmail, updateBenchRow } from './_utils/sheets.js';

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
  const groups = Array.isArray(body.groups) ? body.groups : [];
  if (!groups.length) return res.status(400).json({ error: 'no groups' });

  // For each member email, build the union of every other member's email
  // across all groups they appear in. Merge with existing partners on
  // their Sheet row so we never overwrite previously-set links.
  const membersToPartners = new Map();   // email → Set<email>
  const seen = new Set();
  for (const g of groups) {
    if (!Array.isArray(g) || g.length < 2) continue;
    const cleaned = g.map((e) => String(e || '').trim().toLowerCase()).filter((e) => e.includes('@'));
    for (const e of cleaned) seen.add(e);
    for (const me of cleaned) {
      if (!membersToPartners.has(me)) membersToPartners.set(me, new Set());
      for (const other of cleaned) if (other !== me) membersToPartners.get(me).add(other);
    }
  }

  if (!membersToPartners.size) return res.status(400).json({ error: 'no valid emails in groups' });

  // Look up each member's Sheet row + existing partner column, merge, write.
  const updated = [];
  const missing = [];
  for (const [email, partnerSet] of membersToPartners) {
    try {
      const found = await findBenchRowByEmail(email);
      if (!found) { missing.push(email); continue; }
      const existing = String((found.row && found.row[17]) || '').split(/[,;\n]/).map((s) => s.trim().toLowerCase()).filter(Boolean);
      const merged = new Set([...existing, ...partnerSet]);
      // Strip self-references defensively.
      merged.delete(email);
      const partners = [...merged];
      await updateBenchRow(found.rowNumber, { partners });
      updated.push({ email, rowNumber: found.rowNumber, partners });
    } catch (err) {
      missing.push(`${email} (${err.message || 'lookup failed'})`);
    }
  }

  return res.status(200).json({ ok: true, updated, missing });
}
