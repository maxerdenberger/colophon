import { sendInviteEmail } from './_utils/invites.js';

const SLEEP_MS = 100;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method not allowed' });
  }

  // ── Auth: Bearer ADMIN_KEY (or legacy ADMIN_SECRET) ──────────────────────
  const auth = req.headers.authorization || '';
  const secret = process.env.ADMIN_KEY || process.env.ADMIN_SECRET || '590Rossmore';
  if (auth !== `Bearer ${secret}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const people = Array.isArray(req.body)
    ? req.body
    : Array.isArray(req.body?.people) ? req.body.people : [];

  if (!people.length) {
    return res.status(400).json({ error: 'no recipients' });
  }

  let sent = 0;
  const failed = [];

  for (const p of people) {
    const { name, email, referrer, discipline } = p || {};
    const r = await sendInviteEmail({ name, email, referrer, discipline });
    if (r.ok) sent++;
    else failed.push({ email: email || '?', error: r.error });
    if (SLEEP_MS) await new Promise((r2) => setTimeout(r2, SLEEP_MS));
  }

  return res.status(200).json({ sent, failed });
}
