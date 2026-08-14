/** State FIPS -> USPS code, used for labels and the state filter. */
const STATE_FIPS = {
  '01': 'AL', '02': 'AK', '04': 'AZ', '05': 'AR', '06': 'CA', '08': 'CO', '09': 'CT', '10': 'DE',
  '11': 'DC', '12': 'FL', '13': 'GA', '15': 'HI', '16': 'ID', '17': 'IL', '18': 'IN', '19': 'IA',
  '20': 'KS', '21': 'KY', '22': 'LA', '23': 'ME', '24': 'MD', '25': 'MA', '26': 'MI', '27': 'MN',
  '28': 'MS', '29': 'MO', '30': 'MT', '31': 'NE', '32': 'NV', '33': 'NH', '34': 'NJ', '35': 'NM',
  '36': 'NY', '37': 'NC', '38': 'ND', '39': 'OH', '40': 'OK', '41': 'OR', '42': 'PA', '44': 'RI',
  '45': 'SC', '46': 'SD', '47': 'TN', '48': 'TX', '49': 'UT', '50': 'VT', '51': 'VA', '53': 'WA',
  '54': 'WV', '55': 'WI', '56': 'WY', '60': 'AS', '66': 'GU', '69': 'MP', '72': 'PR', '78': 'VI'
};

/**
 * Deterministic placeholder values so the map is usable before the real CSV lands.
 * Replace by dropping data/indicators.csv next to index.html - it takes priority automatically.
 */
function generateDemoValues(geoid) {
  // xmur3-style hash so every county gets a stable pseudo-random profile.
  let h = 1779033703 ^ geoid.length;
  for (let i = 0; i < geoid.length; i++) {
    h = Math.imul(h ^ geoid.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  const rand = () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  };

  // A shared "urbanicity" factor keeps the fake data spatially plausible.
  const urban = rand();
  const jitter = (base, spread) => Math.max(0, base + (rand() - 0.5) * spread);
  const round = (n, d = 2) => Number(n.toFixed(d));

  return {
    pcp_per_10k:            round(jitter(3 + urban * 9, 4)),
    mh_providers_per_10k:   round(jitter(2 + urban * 22, 8)),
    dentists_per_10k:       round(jitter(2 + urban * 6, 3)),
    inpatient_beds_per_1k:  round(jitter(0.6 + urban * 3.5, 1.5)),
    pharmacies_per_10k:     round(jitter(1.5 + urban * 3, 1.5)),
    specialty_facilities_per_100k: round(jitter(urban * 6, 2.5)),
    uninsured_rate:         round(jitter(14 - urban * 6, 8), 1),
    food_env_index:         round(jitter(6.5 + urban * 1.5, 3), 1),
    gyms_per_10k:           round(jitter(0.5 + urban * 2.5, 1.2)),
    pm25:                   round(jitter(6 + urban * 5, 4), 1),
    extreme_heat_days:      Math.round(jitter(10 + rand() * 45, 20))
  };
}
