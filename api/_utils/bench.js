// Server-side bench fetch + filter. Same column indices and canonicalization
// as parseSheetCSV in index.html, kept in sync.

const SHEETS_CSV = process.env.SHEETS_CSV_URL ||
  'https://docs.google.com/spreadsheets/d/e/2PACX-1vTxk39b5nWFUyQ_1vU0JdVufD2xkyG-RJepoFzv8_P_OIm_3CM21FmZTOXGMuscST6_7kpXruKt1_Rt/pub?gid=437022839&single=true&output=csv';

const TZS = ['UTC−8','UTC−7','UTC−6','UTC−5','UTC−3','UTC+0','UTC+1','UTC+2'];

function parseRow(row) {
  const f = []; let cur = '', inQ = false;
  for (const c of row) {
    if (c === '"') { inQ = !inQ; }
    else if (c === ',' && !inQ) { f.push(cur.trim()); cur = ''; }
    else { cur += c; }
  }
  f.push(cur.trim());
  return f;
}

function canonDisc(s) {
  s = (s || '').toLowerCase();
  if (s.includes('copy')) return 'copywriting';
  if (s.includes('brand strategy')) return 'brand strategy';
  if (s.includes('art')) return 'art direction';
  if (s.includes('leadership')) return 'design leadership';
  if (s.includes('design')) return 'design leadership';
  if (s.includes('ux')) return 'ux / content design';
  if (s.includes('motion')) return 'motion design';
  return 'creative direction';
}

let cache = { data: null, ts: 0 };
const TTL_MS = 60_000; // 1 minute

export function invalidateBenchCache() { cache = { data: null, ts: 0 }; }

export async function loadBench() {
  if (cache.data && Date.now() - cache.ts < TTL_MS) return cache.data;
  const res = await fetch(SHEETS_CSV);
  if (!res.ok) throw new Error(`bench fetch failed: ${res.status}`);
  const text = await res.text();
  const lines = text.split('\n').filter((l) => l.trim());

  const DISC = 5, AVAIL = 7, RATE = 9, EXP = 13, NOTE = 15;

  const rows = lines.slice(1).map((line, i) => {
    const r = parseRow(line);
    const note = (r[NOTE] || '').toLowerCase().slice(0, 130);
    if (!note) return null;

    const rawAvail = (r[AVAIL] || '').toLowerCase();
    const availability = rawAvail.includes('immediate') || rawAvail.includes('available now') ? 'available'
                       : rawAvail.includes('waitlist') ? 'booked'
                       : 'soon';

    const rateText = String(r[RATE] || '');
    const m = rateText.match(/\d+/);
    const hourlyRate = m ? parseInt(m[0], 10) : 0;
    const rate = hourlyRate >= 400 ? '$$$$'
               : hourlyRate >= 250 ? '$$$'
               : hourlyRate >= 150 ? '$$'
               : hourlyRate > 0    ? '$'  : '$$';

    const expText = (r[EXP] || '').toLowerCase();
    const yoe = /12\+|veteran|executive/.test(expText) ? 15
              : /lead|principal|8.{0,3}12/.test(expText) ? 10
              : /senior|4.{0,3}7/.test(expText) ? 6
              : /junior|mid|1.{0,3}3/.test(expText) ? 2
              : 0;

    return {
      id: i + 1,
      // Personal fields — used by /api/lookup-applicant. Never returned in
      // public endpoints (e.g. /api/bench-count strips these implicitly by
      // only returning a count).
      name:      (r[1] || '').trim(),
      email:     (r[2] || '').trim().toLowerCase(),
      portfolio: (r[3] || '').trim(),
      linkedin:  (r[4] || '').trim(),
      // Filterable / aggregable fields
      discipline: canonDisc(r[DISC]),
      availability,
      hourlyRate,
      rate,
      yoe,
      tz: TZS[i % TZS.length],
    };
  }).filter(Boolean);

  cache = { data: rows, ts: Date.now() };
  return rows;
}

// Filter shape (matches the bench builder in index.html):
//   { disciplines: [], avail: [], experience: [], timezone: [], rate: [] }
export function matchPerson(p, filters = {}) {
  const f = filters || {};
  if (f.disciplines?.length && !f.disciplines.includes(p.discipline)) return false;
  if (f.avail?.length && !f.avail.includes(p.availability)) return false;
  if (f.experience?.length) {
    const lvl = p.yoe < 4 ? 'junior' : p.yoe < 8 ? 'mid' : p.yoe < 15 ? 'senior' : 'lead';
    if (!f.experience.includes(lvl)) return false;
  }
  if (f.timezone?.length) {
    const o = parseInt((p.tz || '').replace(/UTC|−/g, '-').replace('+', '')) || 0;
    const region = o <= -3 ? 'americas' : o <= 3 ? 'europe' : 'asia';
    if (!f.timezone.includes(region)) return false;
  }
  if (f.rate?.length && !f.rate.includes(p.rate)) return false;
  return true;
}

export function countMatches(rows, filters) {
  return rows.filter((p) => matchPerson(p, filters)).length;
}
