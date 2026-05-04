// /api/submissions
//
// Admin-only proxy for Formspree submissions. The bench dashboard
// (AdminFormspreeApproval) calls this to populate the approval queue.

import { isTestOrOperatorSubmission } from './_utils/formspree.js';

//
// Why proxy: Formspree's API is auth'd with a personal API key that
// must not ride in client JS. The browser sends our admin Bearer
// token; we trade it for a Formspree call here.
//
// Required env on Vercel:
//   ADMIN_KEY (or ADMIN_SECRET)  — same value used by /api/send-invites
//   FORMSPREE_API_KEY            — Personal access token from formspree.io
//   FORMSPREE_FORM_ID            — defaults to 'xqenzjew' (our form)
//
// Without FORMSPREE_API_KEY the route returns 501 with a clear message
// so the admin panel can tell the user what's missing.

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'method not allowed' });
  }

  // Bearer auth — same key as /api/send-invites. Falls back to the
  // public admin password baked into the client (ADMIN_PW = '590Rossmore')
  // when no env var is set, so the panel works without needing to
  // configure ADMIN_KEY on Vercel. Set ADMIN_KEY for a stronger value
  // and update ADMIN_PW in the client to match.
  const auth = req.headers.authorization || '';
  const adminKey = process.env.ADMIN_KEY || process.env.ADMIN_SECRET || '590Rossmore';
  if (auth !== `Bearer ${adminKey}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const formspreeKey = process.env.FORMSPREE_API_KEY;
  const formId = process.env.FORMSPREE_FORM_ID || 'xqenzjew';

  if (!formspreeKey) {
    return res.status(501).json({
      error: 'FORMSPREE_API_KEY not set on Vercel — add it under project settings → environment variables.',
      submissions: [],
    });
  }

  // Formspree v0 read API — try multiple auth + URL combinations and
  // return the one that works. Form-level keys (Master / Read-only) use
  // HTTP Basic; account-level Personal Access Tokens use Bearer. URL
  // can be /api/0/forms/{id} OR /api/0/forms/{id}/submissions depending
  // on plan / API version. We try them in order and return the first
  // 2xx, surfacing the actual Formspree response on failure so the UI
  // has something diagnostic to show.
  const basic = `Basic ${Buffer.from(`${formspreeKey}:`).toString('base64')}`;
  const bearer = `Bearer ${formspreeKey}`;
  const attempts = [
    { auth: basic,  url: `https://formspree.io/api/0/forms/${encodeURIComponent(formId)}/submissions` },
    { auth: bearer, url: `https://formspree.io/api/0/forms/${encodeURIComponent(formId)}/submissions` },
    { auth: basic,  url: `https://formspree.io/api/0/forms/${encodeURIComponent(formId)}` },
    { auth: bearer, url: `https://formspree.io/api/0/forms/${encodeURIComponent(formId)}` },
  ];
  let lastStatus = 0, lastError = '', lastTried = '';
  for (const a of attempts) {
    try {
      const r = await fetch(a.url, {
        headers: { Authorization: a.auth, Accept: 'application/json' },
      });
      const text = await r.text();
      let j = null;
      try { j = text ? JSON.parse(text) : null; } catch {}
      if (r.ok) {
        const raw = (j && (j.submissions || j.data)) || [];
        // Stamp every submission with a stable id. Formspree responses
        // sometimes omit a top-level id; we derive one from
        // submitted_at + email + brief excerpt, which is invariant
        // across loads. Earlier we used positional index as part of
        // the fallback, but Formspree doesn't guarantee response order,
        // so the same submission could end up with a different id on a
        // later load — that broke localStorage('colophon_reviewed') and
        // caused already-rejected rows to reappear.
        const submissions = raw
          // Drop test sources + operator's own submissions before
          // they reach the queue. Same rule used by the activity feed,
          // so all admin counters agree.
          .filter((s) => !isTestOrOperatorSubmission(s))
          .map((s) => {
            if (s && s.id != null) return { ...s, id: s.id };
            const data = s && (s.data || s) || {};
            const fp = `${s && s.submitted_at || ''}|${(data.email || '').toLowerCase()}|${(data.brief || data.summary || '').slice(0, 40)}`;
            return { ...s, id: 'fp:' + simpleHash(fp) };
          });
        return res.status(200).json({ submissions, _via: { auth: a.auth.split(' ')[0], url: a.url } });
      }
      lastStatus = r.status;
      lastTried = `${a.auth.split(' ')[0]} ${a.url}`;
      lastError = (j && (j.error || j.message)) || (text ? text.slice(0, 200) : `status ${r.status}`);
    } catch (err) {
      lastError = err.message || 'fetch failed';
    }
  }
  return res.status(lastStatus === 401 ? 502 : (lastStatus || 502)).json({
    error: `formspree: ${lastError}`,
    tried: lastTried,
    hint: lastStatus === 401
      ? 'auth rejected — verify the FORMSPREE_API_KEY value (try the Master API key if Read-only fails) and that FORMSPREE_FORM_ID matches your form hashid'
      : 'check Formspree plan + form hashid',
    submissions: [],
  });
}

// Cheap deterministic hash for fallback IDs. Same input → same output
// across Vercel cold starts, so localStorage('colophon_reviewed') stays
// valid for submissions that lack a Formspree-assigned id.
function simpleHash(s) {
  let h = 5381;
  const str = String(s);
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}
