/* global L, CATEGORIES, ALL_INDICATORS, IMPORTANCE_LABELS, DEFAULT_IMPORTANCE, PRESETS,
   STATE_FIPS, parseCSV, normalizeGeoid, toNumber, buildPercentiles,
   computeScores, percentileRanks, importanceToWeight */

const STORAGE_KEY = 'hfi.importance.v1';
const COLORS = ['#440154', '#472d7b', '#3b528b', '#2c728e', '#21918c', '#27ad81', '#5ec962', '#aadc32', '#fde725'];
const NO_DATA_COLOR = '#2b2f36';

const state = {
  map: null,
  geoLayer: null,
  layersByGeoid: new Map(),
  dataByGeoid: new Map(),   // geoid -> { name, state, values }
  percentiles: null,
  importance: {},
  scores: new Map(),        // geoid -> { score, rank, coverage, parts }
  range: { min: 0, max: 100 },
  // Indicators with no published CSV yet: locked off so nothing fabricated reaches the map.
  unavailableKeys: new Set(),
  selectedGeoid: null
};

/* ------------------------------------------------------------------ data --- */

async function loadIndicatorCSV(path) {
  try {
    const res = await fetch(path, { cache: 'no-store' });
    if (!res.ok) return null;
    const rows = parseCSV(await res.text());
    return rows.length ? rows : null;
  } catch {
    return null; // file not present yet
  }
}

/** Merges one file's indicator columns into the county table; returns rows matched. */
function ingestCSV(rows) {
  const idField = ['geoid', 'GEOID', 'fips', 'FIPS', 'county_fips'].find(f => f in rows[0]);
  if (!idField) return 0;

  const columns = ALL_INDICATORS.filter(ind => ind.key in rows[0]);
  if (!columns.length) return 0;

  let matched = 0;
  for (const row of rows) {
    const geoid = normalizeGeoid(row[idField]);
    const rec = geoid && state.dataByGeoid.get(geoid);
    if (!rec) continue;
    for (const ind of columns) {
      rec.values[ind.key] = toNumber(row[ind.key]);
    }
    matched++;
  }
  return matched;
}

/** Indicators with no CSV yet are locked off entirely rather than filled with placeholders. */
function lockUnavailable(realKeys) {
  const missing = ALL_INDICATORS.filter(ind => !realKeys.has(ind.key)).map(ind => ind.key);
  state.unavailableKeys = new Set(missing);
  for (const key of missing) {
    state.importance[key] = 1;
    const row = document.querySelector(`.indicator[data-key="${key}"]`);
    const slider = document.getElementById(`sl-${key}`);
    const level = document.getElementById(`lv-${key}`);
    if (slider) { slider.value = 1; slider.disabled = true; }
    if (level) { level.textContent = 'Coming soon'; level.classList.add('muted'); }
    if (row) { row.classList.add('disabled', 'unavailable'); }
  }
  return missing;
}

/** Notes how complete each available indicator is; unavailable ones say so plainly. */
function annotateIndicatorSources() {
  const total = state.dataByGeoid.size;
  for (const ind of ALL_INDICATORS) {
    const el = document.getElementById(`src-${ind.key}`);
    if (!el) continue;

    if (state.unavailableKeys.has(ind.key)) {
      el.textContent = 'Data not published yet — excluded from the index';
      el.className = 'source-note unavailable';
      continue;
    }

    let withData = 0;
    for (const rec of state.dataByGeoid.values()) {
      if (rec.values[ind.key] !== null && rec.values[ind.key] !== undefined) withData++;
    }
    const missing = total - withData;
    if (missing > 0) {
      const pct = Math.round((withData / total) * 100);
      el.textContent = `${pct}% of counties (${missing} missing)`;
      el.className = 'source-note partial';
    } else {
      el.textContent = 'All counties covered';
      el.className = 'source-note real';
    }
  }
}

/* --------------------------------------------------------------- scoring --- */

function recompute() {
  const { scores } = computeScores(
    state.percentiles,
    state.dataByGeoid.keys(),
    state.importance,
    ALL_INDICATORS
  );

  const entries = [];
  for (const [geoid, s] of scores) {
    if (s.score !== null) entries.push({ id: geoid, v: s.score });
  }
  const ordered = entries.slice().sort((a, b) => b.v - a.v);
  const rankPosition = new Map(ordered.map((e, i) => [e.id, i + 1]));

  state.range = ordered.length
    ? { min: ordered[ordered.length - 1].v, max: ordered[0].v }
    : { min: 0, max: 100 };

  state.scores = new Map();
  for (const [geoid, s] of scores) {
    state.scores.set(geoid, {
      ...s,
      rank: rankPosition.get(geoid) ?? null,
      rankTotal: ordered.length
    });
  }

  restyle();
  updateLegendLabels();
  renderLeaderboard(ordered);
  if (state.selectedGeoid) renderDetail(state.selectedGeoid);
  updateActiveCount();
}

/** Maps a 0-1 position onto the sequential ramp. */
function rampColor(t) {
  const idx = Math.min(COLORS.length - 1, Math.max(0, Math.floor(t * COLORS.length)));
  return COLORS[idx];
}

/** Percentile values (0-100) always use the full ramp. */
function colorForPct(pct) {
  return rampColor(pct / 100);
}

/** Composite scores are stretched across the current min/max so the map keeps contrast. */
function colorFor(score) {
  if (score === null || score === undefined) return NO_DATA_COLOR;
  const { min, max } = state.range;
  const span = max - min;
  return rampColor(span > 0 ? (score - min) / span : 0.5);
}

function styleFor(geoid) {
  const s = state.scores.get(geoid);
  const selected = geoid === state.selectedGeoid;
  return {
    fillColor: colorFor(s?.score ?? null),
    fillOpacity: s?.score === null || s === undefined ? 0.35 : 0.85,
    color: selected ? '#ffffff' : '#0b0c10',
    weight: selected ? 2 : 0.3,
    opacity: 1
  };
}

function restyle() {
  for (const [geoid, layer] of state.layersByGeoid) {
    layer.setStyle(styleFor(geoid));
  }
}

/* -------------------------------------------------------------------- ui --- */

function loadImportance() {
  let stored = {};
  try {
    stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
  } catch { /* ignore corrupt storage */ }
  for (const ind of ALL_INDICATORS) {
    const v = Number(stored[ind.key]);
    state.importance[ind.key] = v >= 1 && v <= 7 ? v : DEFAULT_IMPORTANCE;
  }
}

function saveImportance() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.importance));
  } catch { /* storage may be unavailable */ }
}

function buildPanel() {
  const container = document.getElementById('categories');
  container.innerHTML = '';

  for (const cat of CATEGORIES) {
    const section = document.createElement('section');
    section.className = 'category';

    const head = document.createElement('div');
    head.className = 'category-head';
    head.innerHTML = `<div><h2>${cat.label}</h2>` +
      (cat.pillar ? `<p class="pillar">${cat.pillar}</p>` : '') + '</div>';

    const quick = document.createElement('div');
    quick.className = 'quick';
    for (const [label, value] of [['Off', 1], ['Mid', 4], ['Max', 7]]) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = label;
      btn.title = `Set every ${cat.label} indicator to "${IMPORTANCE_LABELS[value - 1]}"`;
      btn.addEventListener('click', () => {
        cat.indicators.forEach(ind => setImportance(ind.key, value));
        scheduleRecompute();
      });
      quick.appendChild(btn);
    }
    head.appendChild(quick);
    section.appendChild(head);

    for (const ind of cat.indicators) {
      section.appendChild(buildIndicatorRow(ind));
    }
    container.appendChild(section);
  }
}

function buildIndicatorRow(ind) {
  const row = document.createElement('div');
  row.className = 'indicator';
  row.dataset.key = ind.key;

  const value = state.importance[ind.key];
  const inverseTip = `Lower is better — measured in ${ind.unit}`;
  row.innerHTML = `
    <div class="indicator-head">
      <label for="sl-${ind.key}">${ind.label}${ind.dir === -1 ? ` <span class="inverse" title="${inverseTip}">▼</span>` : ''}</label>
      <span class="level" id="lv-${ind.key}">${IMPORTANCE_LABELS[value - 1]}</span>
    </div>
    <p class="source-note" id="src-${ind.key}"></p>
    <input type="range" id="sl-${ind.key}" min="1" max="7" step="1" value="${value}"
           aria-label="${ind.label} importance" list="importance-ticks">
  `;

  const slider = row.querySelector('input');
  slider.addEventListener('input', () => {
    setImportance(ind.key, Number(slider.value));
    scheduleRecompute();
  });
  return row;
}

function setImportance(key, value) {
  // Locked indicators have no data behind them; they stay off no matter what is requested.
  if (state.unavailableKeys.has(key)) value = 1;
  state.importance[key] = value;
  const slider = document.getElementById(`sl-${key}`);
  const level = document.getElementById(`lv-${key}`);
  if (slider) slider.value = value;
  if (level && !state.unavailableKeys.has(key)) {
    level.textContent = IMPORTANCE_LABELS[value - 1];
    level.classList.toggle('muted', value === 1);
  }
  const row = document.querySelector(`.indicator[data-key="${key}"]`);
  if (row) row.classList.toggle('disabled', value === 1);
}

let recomputeTimer = null;
function scheduleRecompute() {
  saveImportance();
  clearTimeout(recomputeTimer);
  recomputeTimer = setTimeout(recompute, 120);
}

function updateActiveCount() {
  const usable = ALL_INDICATORS.filter(i => !state.unavailableKeys.has(i.key)).length;
  const active = ALL_INDICATORS.filter(i => importanceToWeight(state.importance[i.key]) > 0).length;
  document.getElementById('active-count').textContent =
    `${active} of ${usable} available indicators active`;
}

function applyPreset(name) {
  const preset = PRESETS[name];
  if (!preset) return;
  for (const ind of ALL_INDICATORS) {
    setImportance(ind.key, preset.weights[ind.key] ?? DEFAULT_IMPORTANCE);
  }
  scheduleRecompute();
}

function buildPresetMenu() {
  const select = document.getElementById('preset');
  for (const [id, preset] of Object.entries(PRESETS)) {
    const option = document.createElement('option');
    option.value = id;
    option.textContent = preset.label;
    select.appendChild(option);
  }
}

/* ----------------------------------------------------------------- panels -- */

function countyLabel(geoid) {
  const rec = state.dataByGeoid.get(geoid);
  return rec ? `${rec.name}, ${rec.state}` : geoid;
}

const INDICATOR_BY_KEY = new Map(ALL_INDICATORS.map(ind => [ind.key, ind]));

/** Raw measured value with its unit, so a percentile is never shown without its source number. */
function indicatorValueText(key, value) {
  const ind = INDICATOR_BY_KEY.get(key);
  if (!ind) return '';
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'no data';

  const abs = Math.abs(value);
  const digits = abs >= 100 ? 0 : abs >= 10 ? 1 : 2;
  const num = Number(value.toFixed(digits)).toLocaleString();
  return ind.unit === '%' ? `${num}%` : `${num} ${ind.unit}`;
}

function renderLeaderboard(ordered) {
  const list = document.getElementById('leaderboard');
  list.innerHTML = '';
  for (const entry of ordered.slice(0, 10)) {
    const li = document.createElement('li');
    const s = state.scores.get(entry.id);
    li.innerHTML = `<span>${countyLabel(entry.id)}</span><b>${Math.round(s.score)}</b>`;
    li.addEventListener('click', () => selectCounty(entry.id, true));
    list.appendChild(li);
  }
}

function renderDetail(geoid) {
  const box = document.getElementById('detail');
  const rec = state.dataByGeoid.get(geoid);
  const s = state.scores.get(geoid);
  if (!rec || !s) { box.innerHTML = ''; return; }

  const close = '<button type="button" class="detail-close" aria-label="Close">&times;</button>';
  if (s.score === null) {
    box.innerHTML = `${close}<h3>${countyLabel(geoid)}</h3><p class="nodata">Not enough data for your current weighting.</p>`;
    wireDetailClose();
    return;
  }

  const parts = s.parts.slice().sort((a, b) => b.pct - a.pct);
  const strengths = parts.filter(p => p.pct >= 50).slice(0, 5);
  const gaps = parts.slice().reverse().filter(p => p.pct < 50).slice(0, 5);

  const bar = p => `
    <li>
      <div class="prow">
        <span class="pl">${p.label}</span>
        <span class="pval">${indicatorValueText(p.key, rec.values[p.key])}</span>
      </div>
      <div class="prow">
        <span class="pbar"><i style="width:${p.pct.toFixed(0)}%;background:${colorForPct(p.pct)}"></i></span>
        <span class="pv">${Math.round(p.pct)}</span>
      </div>
    </li>`;

  box.innerHTML = `
    ${close}
    <h3>${countyLabel(geoid)}</h3>
    <div class="score-line">
      <span class="score-chip" style="background:${colorFor(s.score)}">${Math.round(s.score)}</span>
      <span class="score-meta">rank ${s.rank.toLocaleString()} of ${s.rankTotal.toLocaleString()} counties</span>
    </div>
    ${strengths.length ? `<h4>Strengths</h4><ul class="parts">${strengths.map(bar).join('')}</ul>` : ''}
    ${gaps.length ? `<h4>Gaps</h4><ul class="parts">${gaps.map(bar).join('')}</ul>` : ''}
    <p class="hint">Each row shows this county's measured value and, on the bar, its national
    percentile among counties with data.</p>
  `;
  wireDetailClose();
}

function wireDetailClose() {
  document.querySelector('.detail-close')?.addEventListener('click', () => {
    const prev = state.selectedGeoid;
    state.selectedGeoid = null;
    if (prev && state.layersByGeoid.has(prev)) state.layersByGeoid.get(prev).setStyle(styleFor(prev));
    document.getElementById('detail').innerHTML = '';
  });
}

function selectCounty(geoid, zoom = false) {
  const prev = state.selectedGeoid;
  state.selectedGeoid = geoid;
  if (prev && state.layersByGeoid.has(prev)) state.layersByGeoid.get(prev).setStyle(styleFor(prev));
  const layer = state.layersByGeoid.get(geoid);
  if (layer) {
    layer.setStyle(styleFor(geoid));
    layer.bringToFront?.();
    if (zoom) state.map.fitBounds(layer.getBounds(), { maxZoom: 8, padding: [40, 40] });
  }
  renderDetail(geoid);
}

/* -------------------------------------------------------------------- map -- */

function buildMap(geojson) {
  state.map = L.map('map', {
    preferCanvas: true,
    center: [39.5, -98.35],
    zoom: 4,
    minZoom: 3,
    worldCopyJump: false
  });

  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; OpenStreetMap contributors &copy; CARTO | County boundaries: US Census Bureau',
    subdomains: 'abcd',
    maxZoom: 12
  }).addTo(state.map);

  state.geoLayer = L.geoJSON(geojson, {
    style: f => styleFor(f.properties.GEOID),
    onEachFeature: (feature, layer) => {
      const geoid = feature.properties.GEOID;
      state.layersByGeoid.set(geoid, layer);
      layer.on({
        mouseover: () => showHover(geoid),
        mouseout: hideHover,
        click: () => selectCounty(geoid)
      });
    }
  }).addTo(state.map);

  // Place names on top of the choropleth without intercepting clicks.
  state.map.createPane('labels');
  state.map.getPane('labels').style.zIndex = 650;
  state.map.getPane('labels').style.pointerEvents = 'none';
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}{r}.png', {
    subdomains: 'abcd', maxZoom: 12, pane: 'labels'
  }).addTo(state.map);
}

function showHover(geoid) {
  const s = state.scores.get(geoid);
  const el = document.getElementById('hover');
  el.classList.add('visible');
  el.innerHTML = s && s.score !== null
    ? `<b>${countyLabel(geoid)}</b><span class="hs" style="color:${colorFor(s.score)}">${Math.round(s.score)}</span>`
    : `<b>${countyLabel(geoid)}</b><span class="hs nodata">no data</span>`;
}

function hideHover() {
  document.getElementById('hover').classList.remove('visible');
}

function buildLegend() {
  const el = document.getElementById('legend-scale');
  el.innerHTML = COLORS.map(c => `<i style="background:${c}"></i>`).join('') +
    `<i class="nodata-swatch" style="background:${NO_DATA_COLOR}"></i>`;
}

function updateLegendLabels() {
  const { min, max } = state.range;
  document.getElementById('legend-min').textContent = Math.round(min);
  document.getElementById('legend-mid').textContent = Math.round((min + max) / 2);
  document.getElementById('legend-max').textContent = Math.round(max);
}

/* ------------------------------------------------------------------- init -- */

function setStatus(text, tone = '') {
  const el = document.getElementById('data-status');
  el.textContent = text;
  el.className = `status ${tone}`;
}

async function init() {
  buildLegend();
  loadImportance();
  buildPanel();
  buildPresetMenu();

  document.getElementById('preset').addEventListener('change', e => {
    if (e.target.value) applyPreset(e.target.value);
  });
  document.getElementById('reset').addEventListener('click', () => {
    ALL_INDICATORS.forEach(i => setImportance(i.key, DEFAULT_IMPORTANCE));
    document.getElementById('preset').value = '';
    scheduleRecompute();
  });

  const search = document.getElementById('search');
  search.addEventListener('change', () => {
    const q = search.value.trim().toLowerCase();
    if (!q) return;
    for (const [geoid, rec] of state.dataByGeoid) {
      if (`${rec.name}, ${rec.state}`.toLowerCase().startsWith(q) || rec.name.toLowerCase() === q) {
        selectCounty(geoid, true);
        return;
      }
    }
    setStatus('No county matched that search.', 'warn');
  });

  setStatus('Loading county boundaries…');
  const geojson = await (await fetch('counties.geojson')).json();

  for (const f of geojson.features) {
    const p = f.properties;
    state.dataByGeoid.set(p.GEOID, {
      name: p.NAME,
      state: STATE_FIPS[p.STATEFP] || p.STATEFP,
      values: {}
    });
  }

  const realKeys = new Set();
  for (const path of DATA_FILES) {
    const rows = await loadIndicatorCSV(path);
    if (!rows) continue;
    if (ingestCSV(rows) > 0) {
      ALL_INDICATORS.forEach(ind => { if (ind.key in rows[0]) realKeys.add(ind.key); });
    }
  }

  const missing = lockUnavailable(realKeys);
  annotateIndicatorSources();
  if (!realKeys.size) {
    setStatus('No indicator data available yet.', 'warn');
  } else if (missing.length) {
    setStatus(`Work in progress: ${realKeys.size} of ${ALL_INDICATORS.length} indicators are published. `
      + `The remaining ${missing.length} are disabled until their data is ready.`, 'warn');
  } else {
    setStatus(`All ${ALL_INDICATORS.length} indicators published.`, 'ok');
  }

  state.percentiles = buildPercentiles(state.dataByGeoid, ALL_INDICATORS).percentiles;
  buildMap(geojson);
  recompute();
}

init().catch(err => {
  console.error(err);
  setStatus('Failed to load. Serve this folder over http:// (e.g. "python -m http.server").', 'warn');
});
