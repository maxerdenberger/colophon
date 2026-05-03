// /api/suggest-year-price
//
// Suggests a year-tier annual price for a buyer based on the inquiry
// they sent. Uses Anthropic when ANTHROPIC_API_KEY is set; otherwise
// falls back to a deterministic heuristic.
//
// Anchors (rough market): solo buyer $2,000-3,500 · studio $4,000-6,500 ·
// in-house team $6,500-9,500 · agency / holco $10,000+. Buyer's filters
// (narrowness) and any budget hints in the brief move within those bands.
//
// POST body:
//   {
//     buyer:    { name, email, company },
//     filters:  string  (the human-readable summary the build wizard sent)
//     matched:  number
//     filtersAvail: number  (matchedAvail at submit time)
//   }
//
// Returns:
//   { suggestion, low, high, rationale, mode: 'ai'|'heuristic' }

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
  const buyer = body.buyer || {};
  const filters = String(body.filters || '');
  const matched = Number(body.matched) || 0;
  const filtersAvail = Number(body.filtersAvail) || 0;

  // ── AI mode ──────────────────────────────────────────────────────────
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      const prompt = `You are pricing an annual access tier for a curated freelance creative directory called Colophon. A buyer just submitted an inquiry. Recommend an annual price band.

Anchors (market-rate, USD):
- Solo buyer (one person at a small studio or in-house team): $2,000 - $3,500/yr
- Studio (5-30 person agency or production company): $4,000 - $6,500/yr
- In-house brand team (Series B+ to F500 marketing org): $6,500 - $9,500/yr
- Agency / holding-company tier: $10,000 - $25,000/yr

Buyer:
- Name:    ${buyer.name || 'unknown'}
- Email:   ${buyer.email || 'unknown'}
- Company: ${buyer.company || 'unknown — infer from email domain'}

Their filters (narrowness signals usage intensity):
${filters || '(no filters applied)'}

Matched against bench at submit time: ${matched} candidates (${filtersAvail} immediately available).

Rules:
- Email domain is the primary signal. @gmail / @icloud / @hotmail / personal → solo. Studio domains → studio. Holco/agency domains (publicis, wpp, omnicom, ipg, ddb, tbwa, bbdo, wieden, droga5, mother, anomaly, etc.) → agency. F500 / known brands → in-house.
- Narrow filters (1-2 axes) imply a specific search problem; suggest the lower end. Broad/no filters imply repeat hiring; suggest the higher end.
- Don't anchor on the day/week/month rates ($42/$82/$349) — annual is a different commercial conversation.
- Return a band (low/high) plus a single suggested midpoint to lead with.

Return strictly JSON, nothing else, in this exact shape:
{ "suggestion": 4500, "low": 4000, "high": 5500, "rationale": "studio domain, narrow filters, suggesting the low-mid of studio band" }`;

      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: 'claude-3-5-sonnet-20241022',
          max_tokens: 800,
          messages: [{ role: 'user', content: prompt }],
        }),
      });
      const data = await r.json();
      if (r.ok && data.content && data.content[0] && data.content[0].text) {
        const m = data.content[0].text.match(/\{[\s\S]*\}/);
        if (m) {
          try {
            const parsed = JSON.parse(m[0]);
            if (parsed.suggestion && parsed.low && parsed.high) {
              return res.status(200).json({
                mode: 'ai',
                suggestion: parsed.suggestion,
                low: parsed.low,
                high: parsed.high,
                rationale: parsed.rationale || '',
              });
            }
          } catch {}
        }
      }
    } catch {}
  }

  // ── Heuristic fallback ───────────────────────────────────────────────
  const email = String(buyer.email || '').toLowerCase();
  const company = String(buyer.company || '').toLowerCase();
  const domain = email.split('@')[1] || '';
  const isPersonal = /^(gmail|icloud|outlook|hotmail|yahoo|protonmail|me|mac)\.com$/.test(domain);
  const HOLCO = /(publicis|wpp|omnicom|ipg|ddb|tbwa|bbdo|wieden|droga|mother|anomaly|72andsunny|r\/ga|huge|akqa)/;
  const isHolco = HOLCO.test(domain) || HOLCO.test(company);
  const isStudio = /studio|labs|works|design|collective|partners/.test(domain) || /studio|labs|works|design|collective|partners/.test(company);

  let band, rationale;
  if (isHolco) {
    band = { low: 10000, high: 18000, suggestion: 14000 };
    rationale = 'agency / holding-company domain detected';
  } else if (isPersonal) {
    band = { low: 2000, high: 3500, suggestion: 2500 };
    rationale = 'personal email domain — solo buyer band';
  } else if (isStudio) {
    band = { low: 4000, high: 6500, suggestion: 5000 };
    rationale = 'studio domain pattern — studio band';
  } else {
    band = { low: 6500, high: 9500, suggestion: 7500 };
    rationale = 'business domain — in-house band';
  }
  // Filter narrowness adjustment.
  const filterCount = (filters.match(/[a-z_]+:/gi) || []).length;
  if (filterCount >= 3) {
    band.suggestion = band.low + Math.round((band.high - band.low) * 0.3);
    rationale += ' · narrow filters → low-mid of band';
  } else if (filterCount === 0) {
    band.suggestion = band.low + Math.round((band.high - band.low) * 0.7);
    rationale += ' · broad / no filters → upper-mid of band';
  }
  return res.status(200).json({ mode: 'heuristic', ...band, rationale });
}
