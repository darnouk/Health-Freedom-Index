/**
 * Scoring engine: raw indicator values -> direction-aware percentile ranks -> weighted 0-100 index.
 * Percentile ranking keeps wildly different units comparable and is resistant to outliers.
 */

/** Minimal RFC-4180 CSV parser (handles quoted fields, embedded commas/newlines, BOM, CRLF). */
function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field); field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.length > 1 || row[0] !== '') rows.push(row);

  if (!rows.length) return [];
  const header = rows[0].map(h => h.trim());
  return rows.slice(1).map(r => {
    const obj = {};
    header.forEach((h, idx) => { obj[h] = (r[idx] ?? '').trim(); });
    return obj;
  });
}

/** Pads a county FIPS to the 5-digit form used by the GeoJSON GEOID property. */
function normalizeGeoid(raw) {
  const digits = String(raw ?? '').replace(/[^0-9]/g, '');
  return digits ? digits.padStart(5, '0') : null;
}

function toNumber(raw) {
  if (raw === null || raw === undefined) return null;
  const cleaned = String(raw).replace(/[$,%\s]/g, '');
  if (cleaned === '' || /^(na|n\/a|null|-|\.)$/i.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/**
 * Average-rank percentile (0-100) for every county with a value.
 * @param {Array<{id: string, v: number}>} entries
 */
function percentileRanks(entries) {
  const sorted = entries.slice().sort((a, b) => a.v - b.v);
  const n = sorted.length;
  const out = new Map();
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && sorted[j + 1].v === sorted[i].v) j++;
    const avgRank = (i + j) / 2;
    const pct = n === 1 ? 50 : (avgRank / (n - 1)) * 100;
    for (let k = i; k <= j; k++) out.set(sorted[k].id, pct);
    i = j + 1;
  }
  return out;
}

/**
 * Builds per-indicator percentile lookups.
 * @param {Map<string, {values: Object}>} dataByGeoid
 * @param {Array} indicators
 * @returns {{percentiles: Map<string, Map<string, number>>, coverage: Object}}
 */
function buildPercentiles(dataByGeoid, indicators) {
  const percentiles = new Map();
  const coverage = {};
  for (const ind of indicators) {
    const entries = [];
    for (const [geoid, rec] of dataByGeoid) {
      const v = rec.values[ind.key];
      if (typeof v === 'number' && Number.isFinite(v)) entries.push({ id: geoid, v });
    }
    coverage[ind.key] = entries.length;
    const ranks = percentileRanks(entries);
    if (ind.dir === -1) {
      for (const [id, p] of ranks) ranks.set(id, 100 - p);
    }
    percentiles.set(ind.key, ranks);
  }
  return { percentiles, coverage };
}

/** Importance level (1-7) -> weight. Level 1 ("Not at all important") contributes nothing. */
function importanceToWeight(level) {
  return Math.max(0, level - 1);
}

/**
 * Weighted index for every county.
 * @param {Map<string, Map<string, number>>} percentiles
 * @param {Iterable<string>} geoids
 * @param {Object} importance  key -> 1..7
 * @param {Array} indicators
 * @param {number} minCoverage fraction of requested weight that must have data (0-1)
 */
function computeScores(percentiles, geoids, importance, indicators, minCoverage = 0.5) {
  const active = indicators
    .map(ind => ({ ind, w: importanceToWeight(importance[ind.key] ?? 0) }))
    .filter(x => x.w > 0);

  const totalWeight = active.reduce((s, x) => s + x.w, 0);
  const scores = new Map();
  if (!totalWeight) return { scores, active: [] };

  for (const geoid of geoids) {
    let weighted = 0;
    let available = 0;
    const parts = [];
    for (const { ind, w } of active) {
      const p = percentiles.get(ind.key)?.get(geoid);
      if (p === undefined) continue;
      weighted += p * w;
      available += w;
      parts.push({ key: ind.key, label: ind.label, pct: p, weight: w, contribution: p * w });
    }
    if (available / totalWeight < minCoverage) {
      scores.set(geoid, { score: null, coverage: available / totalWeight, parts: [] });
    } else {
      scores.set(geoid, {
        score: weighted / available,
        coverage: available / totalWeight,
        parts
      });
    }
  }
  return { scores, active };
}
