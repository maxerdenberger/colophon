// /api/fire-brief
//
// One-shot brief-to-outreach pipeline (admin only).
//
// 1. Reads available creatives from the bench sheet.
// 2. Ranks them against the brief (Claude AI when ANTHROPIC_API_KEY is set,
//    otherwise keyword scoring).
// 3. Drafts a soft-availability email per top match.
// 4. Fires via Resend and stamps Last Pinged on each sent row.
//
// POST body:
//   {
//     brief:    string   — what the project needs
//     timing?:  string   — e.g. "immediate", "next 2 weeks"
//     budget?:  string   — e.g. "lean", "mid-range"
//     topN?:    number   — how many to reach out to (default 15, max 40)
//     dryRun?:  boolean  — skip send + stamp, just return what would fire
//   }
//
// Returns:
//   { ok, sent, failed, matched, dryRun, briefId, results }

import { Resend } from 'resend';
import crypto from 'crypto';
import { readBench } from './_utils/sheets-v2.js';
import { appendPingLog } from './_utils/sheets.js';

const FROM      = 'Colophon <bench@colophon.contact>';
const REPLY_TO  = 'bench@colophon.contact';
const SITE      = 'https://colophon.contact';

function tokenFor(email) {
  const secret = process.env.AVAILABILITY_TOKEN_SECRET || process.env.ADMIN_KEY || '590Rossmore';
  return crypto.createHmac('sha256', secret).update(String(email).trim().toLowerCase()).digest('hex').slice(0, 32);
}

function responseLinks(email, briefId) {
  const tok = tokenFor(email);
  const base = `${SITE}/api/update-availability?email=${encodeURIComponent(email)}&token=${tok}&briefId=${encodeURIComponent(briefId)}`;
  return {
    yes:  `${base}&value=available`,
    no:   `${base}&value=booked`,
  };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method not allowed' });
  }

  const auth     = req.headers.authorization || '';
  const adminKey = process.env.ADMIN_KEY || process.env.ADMIN_SECRET || '590Rossmore';
  if (auth !== `Bearer ${adminKey}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  if (!process.env.RESEND_API_KEY) {
    return res.status(501).json({ error: 'RESEND_API_KEY not configured' });
  }

  const body         = req.body || {};
  const brief        = String(body.brief  || '').trim();
  const timing       = String(body.timing || '').trim();
  const rates        = Array.isArray(body.rates) ? body.rates.filter(Boolean) : [];
  const topN         = Math.min(40, Math.max(1, Number(body.topN) || 15));
  const dryRun       = body.dryRun === true || body.dryRun === 'true' || body.dryRun === '1';
  const includeTeams = body.includeTeams === true || body.includeTeams === 'true';

  if (!brief) return res.status(400).json({ error: 'missing brief' });

  const briefId = `brief_${Date.now()}`;

  // ── 1. Read bench ────────────────────────────────────────────────────────
  let candidates;
  try {
    const { rows } = await readBench();
    candidates = rows
      .filter((r) => {
        if (r.status !== 'bench' || !r.email || /booked/i.test(r.availability || '')) return false;
        // teams: skip unless includeTeams param is set
        if (!includeTeams && r.partners && String(r.partners).trim()) return false;
        if (!rates.length) return true;
        const hr = r.hourlyRate || 0;
        const tier = hr >= 400 ? '$$$$' : hr >= 250 ? '$$$' : hr >= 150 ? '$$' : hr > 0 ? '$' : '$$';
        return rates.includes(tier);
      })
      .map((r) => {
        // disciplines and clients come back as comma-separated strings from the sheet
        const discs   = String(r.disciplines || '').split(/[,;\/]+/).map(s => s.trim().toLowerCase()).filter(Boolean);
        const clients = String(r.topClients  || '').split(/[,;\/\n]+/).map(s => s.trim().toLowerCase()).filter(Boolean);
        return {
          rowNumber:   r.rowNumber,
          name:        r.name || '',
          email:       r.email || '',
          discipline:  discs[0] || '',
          disciplines: discs,
          clients,
          availability:r.availability || '',
          rate:        r.hourlyRate   ? `$${r.hourlyRate}` : '',
          yoe:         r.yoe          || 0,
          note:        (r.valueProp   || '').toLowerCase(),
          tz:          r.timezone     || '',
        };
      });
  } catch (err) {
    return res.status(502).json({ error: 'bench read failed: ' + err.message });
  }

  if (!candidates.length) {
    return res.status(200).json({ ok: true, sent: 0, failed: 0, matched: 0, briefId, results: [] });
  }

  // ── 2. Rank candidates ───────────────────────────────────────────────────
  let ranked = [];
  let matchMode = 'keyword';

  if (process.env.ANTHROPIC_API_KEY) {
    try {
      const roster = candidates.slice(0, 250).map((c) => ({
        id:    c.email,
        name:  c.name,
        disciplines: c.disciplines,
        clients: c.clients.slice(0, 5),
        availability: c.availability,
        yoe:   c.yoe,
        note:  (c.note || '').slice(0, 120),
      }));
      const prompt =
`Rank creatives on a bench against this buyer brief. Return only the top ${topN} best matches.

Brief: """${brief}"""
Timing: ${timing || 'not specified'}
Budget: ${budget || 'not specified'}

Roster (${roster.length} people, JSON):
${JSON.stringify(roster)}

Return strictly JSON, nothing else:
{ "matches": [ { "id": "<email>", "score": 0-100, "reason": "<one short phrase>" } ] }`;

      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model:      'claude-3-5-sonnet-20241022',
          max_tokens: 2000,
          messages:   [{ role: 'user', content: prompt }],
        }),
      });
      const data = await r.json();
      if (r.ok && data.content?.[0]?.text) {
        const m = data.content[0].text.match(/\{[\s\S]*\}/);
        if (m) {
          const parsed = JSON.parse(m[0]);
          if (Array.isArray(parsed.matches) && parsed.matches.length) {
            const byEmail = new Map(candidates.map((c) => [c.email, c]));
            ranked = parsed.matches
              .filter((m) => byEmail.has(m.id))
              .map((m) => ({ ...byEmail.get(m.id), score: m.score, reason: m.reason || '' }));
            matchMode = 'ai';
          }
        }
      }
    } catch { /* fall through to keyword */ }
  }

  if (!ranked.length) {
    const bl = brief.toLowerCase();
    // generic words that appear in every creative's profile — not useful signal
    const STOP = new Set('the and for with that this from they have your you our who not are will but into about when over only just like need want some looking best work team make help a an is it be do go us we also very creative'.split(' '));
    const signal = [...new Set(bl.split(/[^a-z0-9]+/).filter((t) => t.length > 2))].filter((t) => !STOP.has(t));

    ranked = candidates
      .map((c) => {
        let score = 0;
        // discipline matches are the strongest signal — score separately from bio/clients
        const discHay  = c.disciplines.join(' ');
        const otherHay = [...c.clients, c.note].join(' ');
        const discHits  = signal.filter((t) => discHay.includes(t));
        const otherHits = signal.filter((t) => otherHay.includes(t) && !discHay.includes(t));
        score += discHits.length * 15;  // discipline match: high weight
        score += otherHits.length * 4;  // client/bio match: secondary
        if (/immediate|asap|now|this week|urgent/.test(bl) && /immediate/i.test(c.availability)) score += 12;
        if (/booked/i.test(c.availability)) score -= 30;
        if ((c.yoe || 0) >= 12) score += 4;
        else if ((c.yoe || 0) >= 8) score += 2;
        const allHits = [...new Set([...discHits, ...otherHits])];
        return { ...c, score, reason: allHits.length ? allHits.slice(0, 2).join(', ') : '' };
      })
      .filter((c) => c.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, topN);
  }

  if (!ranked.length) {
    return res.status(200).json({ ok: true, sent: 0, failed: 0, matched: 0, matchMode, briefId, results: [] });
  }

  // ── 3. Draft outreach emails ─────────────────────────────────────────────
  // Soft-availability tone: brand redacted, discipline + timeline shared.
  // Replies come back to bench@colophon.contact.
  let drafts = [];

  if (process.env.ANTHROPIC_API_KEY) {
    try {
      const mini = ranked.map((c) => ({
        email: c.email,
        first: (c.name || '').split(' ')[0] || 'there',
        discipline: c.discipline,
        reason: c.reason,
      }));
      const draftPrompt =
`You are Colophon, a private bench for vetted creatives. Draft a direct availability-check email to each creative below. The email tells them they're a strong match and asks for a quick reply.

Brief (keep the client brand redacted): """${brief}"""
Timing: ${timing || 'not specified'}

Rules:
- 4-6 lines total, plain text, lowercase preferred
- Open with "hey,"  — no first name
- One sentence: "we think you'd be a great match for a project we're staffing" + one detail about the project (no brand name)
- One sentence on timing if provided
- Tell them to respond within 5 hours to be put in front of the hiring manager
- Close: "— colophon.contact"
- No exclamation marks, no warm/soft language, direct and brief

Creatives (JSON):
${JSON.stringify(mini)}

Return strictly JSON, nothing else:
{ "drafts": [ { "email": "...", "subject": "...", "body": "..." } ] }`;

      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model:      'claude-3-5-sonnet-20241022',
          max_tokens: 3000,
          messages:   [{ role: 'user', content: draftPrompt }],
        }),
      });
      const data = await r.json();
      if (r.ok && data.content?.[0]?.text) {
        const m = data.content[0].text.match(/\{[\s\S]*\}/);
        if (m) {
          const parsed = JSON.parse(m[0]);
          if (Array.isArray(parsed.drafts) && parsed.drafts.length) {
            drafts = parsed.drafts;
          }
        }
      }
    } catch { /* fall through to template */ }
  }

  // Template fallback — one per creative
  if (!drafts.length) {
    const excerpt = brief.length > 100 ? brief.slice(0, 97) + '…' : brief;
    drafts = ranked.map((c) => {
      return {
        email:   c.email,
        subject: `we think you'd be a great match — ${c.discipline || 'creative'} project`,
        body:    [
          `hey,`,
          '',
          `we think you'd be a great match for a project we're staffing — ${excerpt}${timing ? '. timing: ' + timing : ''}.`,
          '',
          `if you're open, respond within 5 hours to be put in front of the hiring manager.`,
          '\n— colophon.contact',
        ].join('\n'),
      };
    });
  }

  // Append one-click response links to every draft
  for (const d of drafts) {
    const links = responseLinks(d.email, briefId);
    d.body += `\n\n---\nyes, I'm open:     ${links.yes}\nnot right now:    ${links.no}`;
  }

  // Align drafts to ranked list by email
  const draftByEmail = new Map(drafts.map((d) => [d.email, d]));

  // ── 4. Fire via Resend ───────────────────────────────────────────────────
  const resend  = new Resend(process.env.RESEND_API_KEY);
  const nowIso  = new Date().toISOString();
  const results = [];

  for (const c of ranked) {
    const draft = draftByEmail.get(c.email);
    if (!draft || !draft.subject || !draft.body) {
      results.push({ email: c.email, error: 'no draft generated' });
      continue;
    }

    if (dryRun) {
      results.push({ email: c.email, name: c.name, dryRun: true, subject: draft.subject, score: c.score });
      continue;
    }

    let sentId = null;
    try {
      const html = wrapHtml(draft.body);
      const out  = await resend.emails.send({
        from:    FROM,
        to:      c.email,
        replyTo: REPLY_TO,
        subject: draft.subject,
        text:    draft.body,
        html,
        tags: [
          { name: 'brief_id', value: briefId.slice(0, 80) },
          { name: 'channel',  value: 'email' },
        ],
      });
      sentId = out?.data?.id;
    } catch (err) {
      results.push({ email: c.email, name: c.name, error: err.message || 'send failed' });
      continue;
    }

    let stamped = false;
    try {
      await appendPingLog([{ name: c.name, email: c.email, emailId: sentId, status: 'sent', priorAvailability: c.availability, briefId }]);
      stamped = true;
    } catch {}
    results.push({ email: c.email, name: c.name, id: sentId, stamped, score: c.score, reason: c.reason });
  }

  const sent   = results.filter((x) => x.id || x.dryRun).length;
  const failed = results.filter((x) => x.error).length;
  return res.status(200).json({ ok: failed === 0, sent, failed, matched: ranked.length, matchMode, dryRun, briefId, results });
}

function wrapHtml(text) {
  const safe = escapeHtml(text).replace(/(https?:\/\/\S+)/g, '<a href="$1" style="color:#0d1014;">$1</a>');
  return `<div style="font-family:Georgia,'Times New Roman',serif;color:#0d1014;background:#f4ede2;padding:48px 24px;">` +
         `<div style="max-width:520px;margin:0 auto;font-size:16px;line-height:1.7;white-space:pre-wrap;">${safe}</div></div>`;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
