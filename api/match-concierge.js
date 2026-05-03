// /api/match-concierge
//
// Admin-only matcher: takes a concierge brief + a candidate set (passed
// in by the client from the live bench) and returns a ranked list with
// match scores and brief reasoning per candidate.
//
// Two modes:
//   1) ANTHROPIC_API_KEY set on Vercel → calls Claude with the brief +
//      candidate roster, asks for a ranked top-10 with reasons. This is
//      the "AI matching" path.
//   2) No key → falls back to keyword scoring (discipline overlap,
//      past-client overlap, availability gating, rate-band match,
//      experience-level match). Cheap and good enough for a first cut.
//
// POST body:
//   {
//     brief:    string  (the buyer's brief text)
//     timing?:  string
//     budget?:  string
//     aiSavvy?: 's'|'m'|'l'
//     candidates: [
//       { id, name, email, discipline, disciplines[], availability,
//         hourlyRate, rate, yoe, clients[], note, tz }
//     ]
//   }
//
// Returns:
//   { matches: [ { id, score, reasons[] } ], mode: 'ai'|'keyword' }

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
  const brief = String(body.brief || '').trim();
  const candidates = Array.isArray(body.candidates) ? body.candidates : [];
  if (!brief)              return res.status(400).json({ error: 'missing brief' });
  if (!candidates.length)  return res.status(400).json({ error: 'no candidates supplied' });

  // ── AI mode ──────────────────────────────────────────────────────────
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      const compactRoster = candidates.slice(0, 200).map((c) => ({
        id: c.id,
        name: c.name || c.realName,
        disciplines: c.disciplines || [c.discipline].filter(Boolean),
        clients: (c.clients || []).slice(0, 5),
        rate: c.rate || (c.hourlyRate ? `$${c.hourlyRate}` : ''),
        yoe: c.yoe,
        availability: c.availability,
        note: (c.note || '').slice(0, 160),
      }));
      const prompt = `You are matching a buyer's brief to creatives on a curated roster.

Brief:
"""${brief}"""

Buyer context:
- Timing: ${body.timing || 'not specified'}
- Budget: ${body.budget || 'not specified'}
- AI fluency desired: ${body.aiSavvy || 'not specified'}

Roster (${compactRoster.length} candidates, JSON):
${JSON.stringify(compactRoster)}

Rank the top 10 best matches. For each return:
- id (the candidate's id)
- score (0-100, your judgment of fit)
- reasons (1-3 short phrases explaining why this is a fit, e.g. "did Apple work", "writes for sport")

Return strictly JSON in this shape, nothing else:
{ "matches": [ { "id": ..., "score": ..., "reasons": [...] }, ... ] }`;

      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: 'claude-3-5-sonnet-20241022',
          max_tokens: 2000,
          messages: [{ role: 'user', content: prompt }],
        }),
      });
      const data = await r.json();
      if (r.ok && data.content && data.content[0] && data.content[0].text) {
        const text = data.content[0].text;
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          try {
            const parsed = JSON.parse(jsonMatch[0]);
            if (Array.isArray(parsed.matches)) {
              return res.status(200).json({ mode: 'ai', matches: parsed.matches });
            }
          } catch {}
        }
      }
      // Fall through to keyword mode if AI mode failed.
    } catch {}
  }

  // ── Keyword fallback ─────────────────────────────────────────────────
  const briefLower = brief.toLowerCase();
  const tokens = briefLower.split(/[^a-z0-9+\-]+/i).filter((t) => t.length > 2);

  // Common-word filter — focus on signal terms.
  const STOP = new Set('the and for with that this from they have your you our who not are will not but from into about when over only have just like need want some looking some best work team make help'.split(' '));
  const signal = [...new Set(tokens)].filter((t) => !STOP.has(t));

  const matches = candidates
    .map((c) => {
      let score = 0;
      const reasons = [];

      const text = [
        ...(c.disciplines || [c.discipline]).filter(Boolean),
        ...(c.clients || []),
        c.note || '',
        c.discipline || '',
      ].join(' ').toLowerCase();

      // Discipline + past-client direct hits.
      const hits = signal.filter((t) => text.includes(t));
      if (hits.length) {
        score += hits.length * 8;
        const topHits = hits.slice(0, 3);
        reasons.push(`matches: ${topHits.join(', ')}`);
      }

      // Availability — buyers asking for "now" / "immediate" prefer available.
      if (/now|immediate|asap|this week|urgent/.test(briefLower) && c.availability === 'available') {
        score += 12; reasons.push('available now');
      }
      if (/soon|next week|next month|2 weeks/.test(briefLower) && (c.availability === 'available' || c.availability === 'soon')) {
        score += 6;
      }
      if (c.availability === 'booked') score -= 20;

      // Rate band — basic budget signal.
      if (body.budget) {
        const b = String(body.budget).toLowerCase();
        if (/100k|six figure|big budget/.test(b) && c.rate === '$$$$') { score += 8; reasons.push('top rate band'); }
        if (/lean|tight|limited|under 25k/.test(b) && (c.rate === '$' || c.rate === '$$')) { score += 6; reasons.push('value rate'); }
      }

      // Experience — seniority bias.
      if ((c.yoe || 0) >= 12) { score += 4; }
      else if ((c.yoe || 0) >= 8) { score += 2; }

      return { id: c.id, score, reasons: reasons.slice(0, 3) };
    })
    .filter((m) => m.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 12);

  return res.status(200).json({ mode: 'keyword', matches });
}
