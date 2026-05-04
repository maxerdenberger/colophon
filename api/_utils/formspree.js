// Shared Formspree fetcher. Form-level keys use HTTP Basic;
// account-level Personal Access Tokens use Bearer. We try both
// auth schemes against both URL shapes (/submissions and /forms/{id})
// and return the first 2xx body. Mirrors the pattern that already
// lives in /api/submissions, so /api/recent-activity (and any
// future server endpoint) can use the same one-liner.

export async function fetchFormspreeSubmissions() {
  const apiKey = process.env.FORMSPREE_API_KEY;
  const formId = process.env.FORMSPREE_FORM_ID || 'xqenzjew';
  if (!apiKey) {
    return { ok: false, status: 501, error: 'FORMSPREE_API_KEY not set', submissions: [] };
  }

  const basic  = `Basic ${Buffer.from(`${apiKey}:`).toString('base64')}`;
  const bearer = `Bearer ${apiKey}`;
  const attempts = [
    { auth: basic,  url: `https://formspree.io/api/0/forms/${encodeURIComponent(formId)}/submissions` },
    { auth: bearer, url: `https://formspree.io/api/0/forms/${encodeURIComponent(formId)}/submissions` },
    { auth: basic,  url: `https://formspree.io/api/0/forms/${encodeURIComponent(formId)}` },
    { auth: bearer, url: `https://formspree.io/api/0/forms/${encodeURIComponent(formId)}` },
  ];

  let lastStatus = 0, lastError = '';
  for (const a of attempts) {
    try {
      const r = await fetch(a.url, {
        headers: { Authorization: a.auth, Accept: 'application/json' },
      });
      const text = await r.text();
      let j = null; try { j = text ? JSON.parse(text) : null; } catch {}
      if (r.ok) {
        const raw = (j && (j.submissions || j.data)) || [];
        // Stamp every submission with a stable id derived from
        // submitted_at + email + brief excerpt — same hash as
        // /api/submissions so the reviewed Set stays valid across
        // both endpoints.
        const submissions = raw.map((s) => {
          if (s && s.id != null) return { ...s, id: s.id };
          const data = (s && (s.data || s)) || {};
          const fp = `${s && s.submitted_at || ''}|${(data.email || '').toLowerCase()}|${(data.brief || data.summary || '').slice(0, 40)}`;
          return { ...s, id: 'fp:' + simpleHash(fp) };
        });
        return { ok: true, submissions };
      }
      lastStatus = r.status;
      lastError = (j && (j.error || j.message)) || (text ? text.slice(0, 200) : `status ${r.status}`);
    } catch (err) {
      lastError = err.message || 'fetch failed';
    }
  }
  return {
    ok: false,
    status: lastStatus || 502,
    error: `formspree: ${lastError}`,
    submissions: [],
  };
}

function simpleHash(s) {
  let h = 5381;
  const str = String(s);
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}

// Test/operator filter — keeps the activity feed + admin queue zeroed
// out for the operator's own self-tests. Two rules:
//   1. source name contains 'test' (catches 'apply (test)',
//      'admin-test-concierge-brief', etc.)
//   2. submitter email matches OPERATOR_EMAIL (Max's own submissions)
// Used by /api/recent-activity, /api/submissions, /api/audit-duplicates.
export function isTestOrOperatorSubmission(submission) {
  const data = (submission && (submission.data || submission)) || {};
  const source = String((data.source || submission.source || '')).toLowerCase();
  if (source.includes('test')) return true;
  const operators = new Set(
    (process.env.OPERATOR_EMAIL || 'merdenberger@gmail.com')
      .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
  );
  const email = String(data.email || submission.email || '').toLowerCase();
  if (email && operators.has(email)) return true;
  return false;
}
