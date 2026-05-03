// /api/draft-concierge-email
//
// Drafts a personalized reply email to the concierge buyer using the
// brief + the curated picks + the bespoke-bench URL. Calls Anthropic
// when ANTHROPIC_API_KEY is set; falls back to a tight template when
// the key is missing or the call fails.
//
// POST body:
//   {
//     buyer:    { name, email, company },
//     brief:    string,
//     picks:    [ { name, discipline, clients[], note, reasons[] } ],
//     url:      string   (the tokenized /access?t=… link)
//     expDays:  number   (defaults to 14)
//   }
//
// Returns: { subject, body }   — both plain text, body uses \n for newlines.

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
  const brief = String(body.brief || '').trim();
  const picks = Array.isArray(body.picks) ? body.picks : [];
  const url   = String(body.url || '').trim();
  const expDays = body.expDays || 14;
  if (!buyer.email || !brief || !picks.length || !url) {
    return res.status(400).json({ error: 'missing buyer / brief / picks / url' });
  }

  // ── Try Anthropic first ──────────────────────────────────────────────
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      const compact = picks.slice(0, 12).map((p) => ({
        name: p.name,
        discipline: p.discipline,
        clients: (p.clients || []).slice(0, 3),
        note: (p.note || '').slice(0, 140),
        reasons: (p.reasons || []).slice(0, 3),
      }));
      const prompt = `You are writing a short, warm reply email from Colophon to a buyer who paid $199 for the concierge service. Your job is to introduce a curated set of creatives that match their brief.

The brief they sent:
"""${brief}"""

Buyer:
- Name: ${buyer.name || 'there'}
- Company: ${buyer.company || ''}

The curated picks (you'll list these in the body):
${JSON.stringify(compact, null, 2)}

The bespoke bench URL (paste verbatim — they click to view all picks with rates + contact):
${url}

The URL expires in ${expDays} days.

Write the reply with these properties:
- Plain text. No HTML. Newlines as \\n.
- Open with a single short sentence acknowledging what they asked for (echo a phrase from their brief).
- One sentence saying we pulled \${picks.length} names that fit.
- A short list of the picks, one per line, format: "name — discipline — one phrase about why they fit (use the reasons or note)". Don't list rates or contact info; the URL has those.
- One sentence inviting them to click the URL to see rates + reach out direct.
- Mention the URL expires in ${expDays} days.
- Close with: "— Max" (no signature block).
- Tone: warm, direct, low ego, no exclamation marks, no marketing language. Lowercase is fine. Write like you're writing to a peer.
- Keep it to 6-9 lines total in the body.

Return strictly JSON, nothing else, in this exact shape:
{ "subject": "...", "body": "..." }`;

      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: 'claude-3-5-sonnet-20241022',
          max_tokens: 1500,
          messages: [{ role: 'user', content: prompt }],
        }),
      });
      const data = await r.json();
      if (r.ok && data.content && data.content[0] && data.content[0].text) {
        const m = data.content[0].text.match(/\{[\s\S]*\}/);
        if (m) {
          try {
            const parsed = JSON.parse(m[0]);
            if (parsed.subject && parsed.body) {
              return res.status(200).json({ mode: 'ai', subject: parsed.subject, body: parsed.body });
            }
          } catch {}
        }
      }
      // Fall through to template on parse failure.
    } catch {}
  }

  // ── Template fallback ────────────────────────────────────────────────
  const firstName = (buyer.name || 'there').split(' ')[0];
  const lines = [
    `Hi ${firstName},`,
    '',
    `Thanks for the brief. Here are ${picks.length} names from the bench that look like a fit:`,
    '',
    ...picks.slice(0, 8).map((p) => `· ${p.name} — ${p.discipline}${(p.reasons && p.reasons[0]) ? ` (${p.reasons[0]})` : ''}`),
    '',
    `Real rates and direct contact for each are at the link below. Reach out directly — the introduction is yours to make.`,
    '',
    url,
    '',
    `The link is good for ${expDays} days.`,
    '',
    `— Max`,
  ];
  return res.status(200).json({
    mode: 'template',
    subject: `Your bench from Colophon — ${picks.length} names`,
    body: lines.join('\n'),
  });
}
