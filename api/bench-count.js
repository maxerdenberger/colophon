// Returns the count of bench rows that match a given filter set.
// Used by the look page to preview "your look would show X creatives"
// BEFORE purchase — so a 1-creative result isn't a surprise after.
import { loadBench, countMatches } from './_utils/bench.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'method not allowed' });
  }

  // Filters can come in two shapes:
  //   ?filters=<urlencoded JSON>     (preferred — matches the structured form)
  //   ?disciplines=a,b&avail=c&...   (flat fallback)
  let filters = {};
  if (req.query.filters) {
    try { filters = JSON.parse(req.query.filters); } catch {}
  } else {
    const parseList = (v) => (v ? String(v).split(',').filter(Boolean) : []);
    filters = {
      disciplines: parseList(req.query.disciplines),
      avail:       parseList(req.query.avail),
      experience:  parseList(req.query.experience),
      timezone:    parseList(req.query.timezone),
      rate:        parseList(req.query.rate),
    };
  }

  try {
    const rows = await loadBench();
    const count = countMatches(rows, filters);
    const total = rows.length;
    const available = rows.filter((p) => p.availability === 'available').length;
    return res
      .setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300')
      .status(200)
      .json({ count, total, available });
  } catch (err) {
    console.error('bench-count error:', err);
    return res.status(500).json({ error: err.message || 'bench-count failed' });
  }
}
