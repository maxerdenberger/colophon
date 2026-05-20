// /api/queue
//
// THE review queue endpoint. Pulls Formspree submissions, cross-references
// each against the current bench Sheet, returns ONLY submissions whose
// email isn't already on the Sheet in any status. That's the entire dedup
// logic — no localStorage 'reviewed' set, no per-browser state, no drift.
//
// A submission that's already on the bench, in rejects, or paused: hidden.
// Re-applications from someone previously rejected: shown with a flag.
//
// Auth: Bearer ADMIN_KEY required.

import { readBench } from './_utils/sheets-v2.js';
import { isTestOrOperatorSubmission } from './_utils/formspree.js';

function simpleHash(s) {
  let h = 5381;
  const str = String(s);
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}

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

  const formspreeKey = process.env.FORMSPREE_API_KEY;
  const formId = process.env.FORMSPREE_FORM_ID || 'xqenzjew';
  if (!formspreeKey) {
    return res.status(501).json({
      error: 'FORMSPREE_API_KEY not set on Vercel',
      queue: [], newsletter: [],
    });
  }

  // Pull bench in parallel with Formspree fetch
  let benchByEmail = new Map();
  let benchError = null;
  const benchPromise = readBench().then(({ rows }) => {
    for (const r of rows) {
      if (r.email) benchByEmail.set(r.email, r.status);
    }
  }).catch((e) => { benchError = e.message; });

  // Formspree v0 — try the standard auth/url combos like the old code did
  const basic = `Basic ${Buffer.from(`${formspreeKey}:`).toString('base64')}`;
  const bearer = `Bearer ${formspreeKey}`;
  const attempts = [
    { auth: basic,  url: `https://formspree.io/api/0/forms/${encodeURIComponent(formId)}/submissions` },
    { auth: bearer, url: `https://formspree.io/api/0/forms/${encodeURIComponent(formId)}/submissions` },
    { auth: basic,  url: `https://formspree.io/api/0/forms/${encodeURIComponent(formId)}` },
    { auth: bearer, url: `https://formspree.io/api/0/forms/${encodeURIComponent(formId)}` },
  ];
  let fpRaw = null, fpVia = null, fpErr = '';
  for (const a of attempts) {
    try {
      const r = await fetch(a.url, { headers: { Authorization: a.auth, Accept: 'application/json' } });
      const text = await r.text();
      let j = null;
      try { j = text ? JSON.parse(text) : null; } catch {}
      if (r.ok) {
        fpRaw = (j && (j.submissions || j.data)) || [];
        fpVia = { auth: a.auth.split(' ')[0], url: a.url };
        break;
      }
      fpErr = (j && (j.error || j.message)) || `status ${r.status}`;
    } catch (e) { fpErr = e.message || 'fetch failed'; }
  }
  if (!fpRaw) {
    return res.status(502).json({ error: `formspree: ${fpErr}`, queue: [], newsletter: [] });
  }

  await benchPromise;

  // Classify Formspree submissions
  const NEWSLETTER_SOURCES = new Set(['bench-newsletter']);
  const queue = [];
  const newsletter = [];

  for (const sub of fpRaw) {
    if (isTestOrOperatorSubmission(sub)) continue;
    const data = (sub.data || sub) || {};
    const email = String(data.email || '').trim().toLowerCase();
    const source = String(data.source || sub.source || '').toLowerCase();

    // Newsletter: separate list, never enters the review queue
    if (NEWSLETTER_SOURCES.has(source)) {
      newsletter.push({
        id: sub.id || ('fp:' + simpleHash(`${sub.submitted_at || ''}|${email}`)),
        email, name: data.name || '',
        submittedAt: sub.submitted_at || sub.created_at || '',
      });
      continue;
    }

    // Concierge briefs + year-tier inquiries route through other admin
    // panels — they're not "candidates" for the bench review queue.
    if (source === 'concierge-brief' || source === 'year-tier-inquiry') continue;

    // Dedup against the Sheet — every status hides except for those
    // we want to surface as re-applications (rejected → previously rejected).
    const benchStatus = email ? benchByEmail.get(email) : null;
    if (benchStatus === 'bench' || benchStatus === 'paused') {
      // Already approved or paused — no action needed, hide silently.
      continue;
    }
    if (benchStatus === 'new') {
      // Already in the Sheet awaiting review — surface here too, but
      // flag so the operator can see they have a Sheet row already.
      // (In practice 'new' rows come from the apply form via Formspree;
      // we shouldn't need to act on them twice. But surface for safety.)
      queue.push(buildQueueEntry(sub, data, email, source, { duplicateOnSheet: true, benchStatus }));
      continue;
    }
    if (benchStatus === 'rejected') {
      queue.push(buildQueueEntry(sub, data, email, source, { previouslyRejected: true, benchStatus }));
      continue;
    }
    // Fresh email, never seen — normal queue entry.
    queue.push(buildQueueEntry(sub, data, email, source, {}));
  }

  // Sort queue: oldest first (FIFO — first-in first-out, fairer to applicants)
  queue.sort((a, b) => (a.submittedAtTs || 0) - (b.submittedAtTs || 0));
  newsletter.sort((a, b) => (Date.parse(b.submittedAt) || 0) - (Date.parse(a.submittedAt) || 0));

  return res.status(200).json({
    queue,
    queueCount: queue.length,
    newsletter,
    newsletterCount: newsletter.length,
    benchError,
    via: fpVia,
    ts: new Date().toISOString(),
  });
}

function buildQueueEntry(sub, data, email, source, flags) {
  const submittedAt = sub.submitted_at || sub.created_at || '';
  return {
    id: sub.id || ('fp:' + simpleHash(`${submittedAt}|${email}|${(data.brief || data.summary || '').slice(0, 40)}`)),
    email, source,
    submittedAt,
    submittedAtTs: Date.parse(submittedAt) || 0,
    name:        data.name || '',
    portfolio:   data.portfolio || '',
    linkedin:    data.linkedin || '',
    disciplines: data.disciplines || data.discipline || '',
    timezone:    data.timezone || data.tz || '',
    availability:data.availability || '',
    hourlyRate:  data.hourlyRate || '',
    topClients:  data.topClients || data.clients || '',
    expLevel:    data.expLevel || '',
    valueProp:   data.valueProp || data.summary || '',
    referral:    data.referral || data.referralContext || data.referrer || '',
    partners:    data.partnerEmails || data.partners || '',
    social:      data.social || '',
    rawData:     data,
    ...flags,
  };
}
