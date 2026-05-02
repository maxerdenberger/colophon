// /api/submissions
//
// Admin-only proxy for Formspree submissions. The bench dashboard
// (AdminFormspreeApproval) calls this to populate the approval queue.
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

  try {
    // Formspree v0 read API — paid plan required for full access.
    // Form-level keys (Read-only API key, Master API key) use HTTP Basic
    // with the key as username and empty password. Account-level Personal
    // Access Tokens would use Bearer instead — supporting both: if the
    // value looks like a hex form-level key, use Basic; otherwise Bearer.
    const looksLikeFormLevelKey = /^[0-9a-f]{16,}$/i.test(formspreeKey);
    const authHeader = looksLikeFormLevelKey
      ? `Basic ${Buffer.from(`${formspreeKey}:`).toString('base64')}`
      : `Bearer ${formspreeKey}`;

    const url = `https://formspree.io/api/0/forms/${encodeURIComponent(formId)}/submissions`;
    const r = await fetch(url, {
      headers: {
        Authorization: authHeader,
        Accept: 'application/json',
      },
    });
    const text = await r.text();
    let j = null;
    try { j = text ? JSON.parse(text) : null; } catch {}

    if (!r.ok) {
      return res.status(r.status === 401 ? 502 : r.status).json({
        error: (j && (j.error || j.message)) || `formspree responded ${r.status}`,
        submissions: [],
      });
    }

    // Formspree shapes: { submissions: [...] } or { data: [...] }
    // Each submission usually has { id, submitted_at, data: {...} }.
    const submissions = (j && (j.submissions || j.data)) || [];
    return res.status(200).json({ submissions });
  } catch (err) {
    return res.status(502).json({
      error: err.message || 'formspree fetch failed',
      submissions: [],
    });
  }
}
