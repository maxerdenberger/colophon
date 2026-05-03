// /api/email-events
//
// Admin-only Resend event lookup. Given a list of Resend email IDs
// (the ones we wrote to localStorage / concierge_log when sending
// concierge replies + year proposals), returns each email's status:
// sent, delivered, opened (count), clicked (count + first click ts).
//
// Resend tracks opens + clicks automatically for any email sent
// through their service when those features are enabled at the
// account level (default on for Pro plans). Click tracking wraps
// outbound URLs server-side, so even raw <a href> in our HTML body
// gets tracked.
//
// POST body:
//   { ids: ['re_xxx', 're_yyy', ...] }
//
// Returns:
//   {
//     events: {
//       're_xxx': { status, last_event, opens, clicks, last_open_at, last_click_at },
//       ...
//     }
//   }

import { Resend } from 'resend';

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
  if (!process.env.RESEND_API_KEY) {
    return res.status(501).json({ error: 'RESEND_API_KEY not set' });
  }

  const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids.filter(Boolean).slice(0, 200) : [];
  if (!ids.length) return res.status(200).json({ events: {} });

  const resend = new Resend(process.env.RESEND_API_KEY);
  const events = {};
  // Resend's API doesn't support batch retrieval — fetch in parallel,
  // capped at 200/request to keep us within Vercel's serverless timeout.
  await Promise.all(ids.map(async (id) => {
    try {
      const r = await resend.emails.get(id);
      const data = r && r.data;
      if (!data) {
        events[id] = { error: (r && r.error && r.error.message) || 'no data' };
        return;
      }
      // Resend response shape:
      //   { id, last_event: 'sent'|'delivered'|'opened'|'clicked'|'bounced',
      //     created_at, to, subject,
      //     events?: [{ type, created_at, ... }]   // some plans include event log
      //   }
      const list = Array.isArray(data.events) ? data.events : [];
      const opens   = list.filter((e) => e.type === 'email.opened').length;
      const clicks  = list.filter((e) => e.type === 'email.clicked').length;
      const lastOpen  = list.filter((e) => e.type === 'email.opened').slice(-1)[0];
      const lastClick = list.filter((e) => e.type === 'email.clicked').slice(-1)[0];
      events[id] = {
        status: data.last_event || 'unknown',
        created_at: data.created_at || null,
        to: Array.isArray(data.to) ? data.to[0] : data.to,
        subject: data.subject || '',
        opens,
        clicks,
        last_open_at: lastOpen ? lastOpen.created_at : null,
        last_click_at: lastClick ? lastClick.created_at : null,
      };
    } catch (err) {
      events[id] = { error: err.message || 'fetch failed' };
    }
  }));

  return res.status(200).json({ events });
}
