/**
 * Indicator catalog for the Health Freedom Index.
 *
 * Categories follow the topic rows of the University of Wisconsin Population Health Institute
 * 2025 Model of Health; `pillar` records where each topic sits in that model.
 *
 * `key` must match the column header in its CSV.
 * `dir: 1`  -> higher raw value is BETTER for health freedom
 * `dir: -1` -> higher raw value is WORSE (score is inverted)
 *
 * To add an indicator: add an entry here and a matching CSV column. Nothing else changes.
 */
const CATEGORIES = [
  {
    id: 'clinical_care',
    label: 'Clinical care',
    pillar: 'Health infrastructure',
    indicators: [
      { key: 'pcp_per_10k',            label: 'PCPs / 10k residents',          dir: 1,  unit: 'per 10k' },
      { key: 'mh_providers_per_10k',   label: 'Mental-health providers / 10k residents', dir: 1, unit: 'per 10k' },
      { key: 'dentists_per_10k',       label: 'Dentists / 10k residents',      dir: 1,  unit: 'per 10k' },
      { key: 'inpatient_beds_per_1k',  label: 'Inpatient beds / 1k',           dir: 1,  unit: 'per 1k' },
      { key: 'pharmacies_per_10k',     label: 'Pharmacies / 10k',              dir: 1,  unit: 'per 10k' },
      { key: 'specialty_facilities_per_100k', label: 'Specialty care facilities / 100k', dir: 1, unit: 'per 100k' },
      { key: 'uninsured_rate',         label: 'Uninsured rate',                dir: -1, unit: '%' }
    ]
  },
  {
    id: 'health_promotion',
    label: 'Health promotion & harm reduction',
    pillar: 'Health infrastructure',
    indicators: [
      { key: 'food_env_index', label: 'Food environment index', dir: 1, unit: 'out of 10' },
      { key: 'gyms_per_10k',   label: 'Gyms / 10k',             dir: 1, unit: 'per 10k' }
    ]
  },
  {
    id: 'air_water_land',
    label: 'Air, water and land',
    pillar: 'Physical environment',
    indicators: [
      { key: 'pm25', label: 'Air Quality', dir: -1, unit: 'µg/m³ PM2.5' }
    ]
  },
  {
    id: 'climate',
    label: 'Climate',
    pillar: 'Physical environment',
    indicators: [
      { key: 'extreme_heat_days', label: 'Extreme heat days', dir: -1, unit: 'heat-wave days / yr' }
    ]
  }
];

/**
 * CSV files merged (in order) to build the county table. Each needs a `geoid` column plus
 * one or more indicator columns; unknown columns are ignored and missing files are skipped.
 */
const DATA_FILES = [
  'data/indicators.csv',
  'data/pm25.csv',
  'data/extreme_heat_days.csv',
  // Provider ratio exports converted to rates (see scripts/clean_provider_ratio.py)
  'data/dentists.csv',
  'data/pcp.csv',
  'data/mh_providers.csv',
  'data/food_environment_index.csv',
  'data/uninsured.csv',
  // Census County Business Patterns, NAICS 713940 (see scripts/fetch_gyms_cbp.py)
  'data/gyms.csv'
];

const ALL_INDICATORS = CATEGORIES.flatMap(c =>
  c.indicators.map(i => ({ ...i, categoryId: c.id, categoryLabel: c.label, pillar: c.pillar }))
);

/** 1-7 importance scale shown to the user. Level 1 removes the indicator entirely. */
const IMPORTANCE_LABELS = [
  'Not at all important',
  'Slightly important',
  'Somewhat important',
  'Moderately important',
  'Important',
  'Very important',
  'Extremely important'
];

const DEFAULT_IMPORTANCE = 4;

/**
 * Quick-start weighting profiles. Any indicator omitted falls back to DEFAULT_IMPORTANCE.
 * Every profile lists all 11 keys so the effect of switching presets is fully predictable.
 */
const PRESETS = {
  balanced: { label: 'Balanced (every indicator equal)', weights: {} },
  even_topics: {
    // Clinical care holds 7 of 11 indicators, so equal per-indicator weights lean clinical.
    // These levels even out how much each of the four topics contributes.
    label: 'Even across the four topics',
    weights: {
      pcp_per_10k: 2, mh_providers_per_10k: 2, dentists_per_10k: 2, inpatient_beds_per_1k: 2,
      pharmacies_per_10k: 2, specialty_facilities_per_100k: 2, uninsured_rate: 2,
      food_env_index: 5, gyms_per_10k: 5,
      pm25: 7, extreme_heat_days: 7
    }
  },
  access: {
    label: 'Access to care first',
    weights: {
      pcp_per_10k: 7, mh_providers_per_10k: 6, dentists_per_10k: 5, inpatient_beds_per_1k: 6,
      pharmacies_per_10k: 6, specialty_facilities_per_100k: 6, uninsured_rate: 7,
      food_env_index: 3, gyms_per_10k: 2,
      pm25: 2, extreme_heat_days: 2
    }
  },
  environment: {
    label: 'Clean air & active living',
    weights: {
      pcp_per_10k: 3, mh_providers_per_10k: 3, dentists_per_10k: 3, inpatient_beds_per_1k: 2,
      pharmacies_per_10k: 3, specialty_facilities_per_100k: 2, uninsured_rate: 3,
      food_env_index: 6, gyms_per_10k: 6,
      pm25: 7, extreme_heat_days: 6
    }
  },
  family: {
    label: 'Raising a family',
    weights: {
      pcp_per_10k: 7, mh_providers_per_10k: 6, dentists_per_10k: 6, inpatient_beds_per_1k: 5,
      pharmacies_per_10k: 5, specialty_facilities_per_100k: 4, uninsured_rate: 6,
      food_env_index: 6, gyms_per_10k: 3,
      pm25: 7, extreme_heat_days: 5
    }
  },
  chronic: {
    label: 'Managing a chronic condition',
    weights: {
      pcp_per_10k: 6, mh_providers_per_10k: 5, dentists_per_10k: 3, inpatient_beds_per_1k: 6,
      pharmacies_per_10k: 7, specialty_facilities_per_100k: 7, uninsured_rate: 7,
      food_env_index: 4, gyms_per_10k: 2,
      pm25: 6, extreme_heat_days: 5
    }
  },
  mental_health: {
    label: 'Mental health & wellbeing',
    weights: {
      pcp_per_10k: 6, mh_providers_per_10k: 7, dentists_per_10k: 2, inpatient_beds_per_1k: 3,
      pharmacies_per_10k: 4, specialty_facilities_per_100k: 2, uninsured_rate: 6,
      food_env_index: 5, gyms_per_10k: 5,
      pm25: 4, extreme_heat_days: 4
    }
  },
  aging: {
    label: 'Aging in place',
    weights: {
      pcp_per_10k: 7, mh_providers_per_10k: 4, dentists_per_10k: 4, inpatient_beds_per_1k: 7,
      pharmacies_per_10k: 7, specialty_facilities_per_100k: 6, uninsured_rate: 4,
      food_env_index: 5, gyms_per_10k: 2,
      pm25: 5, extreme_heat_days: 6
    }
  }
};
