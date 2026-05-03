// /api/draft-year-email
//
// Drafts a personal proposal email for a year-tier inquiry, anchored
// on the price the admin selected. Uses Anthropic when available;
// falls back to a tight template otherwise.
//
// POST body:
//   {
//     buyer:    { name, email, company },
//     filters:  string
//     matched:  number
//     price:    number   (the final annual price the admin selected)
//   }
//
// Returns: { subject, body, mode: 'ai'|'template' }

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
  const price   = Number(body.price) || 0;
  if (!buyer.email || !price) {
    return res.status(400).json({ error: 'missing buyer.email / price' });
  }

  const fmt = (n) => `$${Math.round(n).toLocaleString('en-US')}`;

  // ── AI mode ──────────────────────────────────────────────────────────
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      const prompt = `You are writing a short, warm reply email from Colophon to a buyer who requested an annual ("year tier") access quote. Propose the annual price and outline what they get.

Buyer:
- Name:    ${buyer.name || 'there'}
- Company: ${buyer.company || ''}

Their filters at the time of inquiry:
${filters || '(no filters applied)'}

Matched against the bench: ${matched} candidates.

The price you are proposing this year (USD): ${fmt(price)}

What an annual subscription includes:
- Unlimited unlocked access to the live bench (rates, contact info, real availability)
- Priority concierge response (within 1 business hour, vs the standard 4-hour SLA)
- Quarterly bench reports — who joined, who's open, who's booked
- Direct introduction support — say the word, we facilitate
- No markup on any creative they hire

Write the reply with these properties:
- Plain text. Newlines as \\n.
- Open with one sentence acknowledging the inquiry.
- Propose ${fmt(price)}/year explicitly, in one clear sentence.
- Brief bulleted list of what's included (3-5 bullets, each a single short line, prefix each with "· ").
- One sentence on starting (we send a Stripe invoice, access is provisioned the same day).
- Close with: "— Max"
- Tone: warm, direct, low ego, no marketing language. Lowercase is fine. Write like a peer reaching out.
- Keep it tight: 12-16 lines total in the body.

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
    } catch {}
  }

  // ── Template fallback ────────────────────────────────────────────────
  const firstName = (buyer.name || 'there').split(' ')[0];
  const lines = [
    `Hi ${firstName},`,
    '',
    `Thanks for reaching out about an annual arrangement.`,
    '',
    `Based on your filters and what we've seen of your team's needs, I'd propose ${fmt(price)} for the year.`,
    '',
    `That covers:`,
    `· Unlimited unlocked access to the live bench (rates, contact info, real availability)`,
    `· Priority concierge — within 1 business hour, vs the standard 4-hour SLA`,
    `· Quarterly bench reports: who joined, who's open, who's booked`,
    `· Direct introduction support whenever it helps`,
    `· No markup on anyone you hire`,
    '',
    `Say the word and I'll send a Stripe invoice; access goes live the same day.`,
    '',
    `— Max`,
  ];
  return res.status(200).json({
    mode: 'template',
    subject: `Your annual Colophon proposal — ${fmt(price)}`,
    body: lines.join('\n'),
  });
}
