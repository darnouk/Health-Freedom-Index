"""Normalize a county-level data export (HDPulse, CDC WONDER, etc.) for the map.

Usage:
    python scripts/clean_county_csv.py <input.csv> <output.csv> <value_column_name>

Produces: geoid,county,state,<value_column_name>
- FIPS column auto-detected and padded to 5 digits, value taken from the last column
- "NA" turned into blanks; total rows and trailing footnotes skipped
- validated against counties.geojson so unmatched rows are reported, not silently kept
"""
import csv
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

STATE_ABBR_BY_FIPS = {
    '01': 'AL', '02': 'AK', '04': 'AZ', '05': 'AR', '06': 'CA', '08': 'CO', '09': 'CT', '10': 'DE',
    '11': 'DC', '12': 'FL', '13': 'GA', '15': 'HI', '16': 'ID', '17': 'IL', '18': 'IN', '19': 'IA',
    '20': 'KS', '21': 'KY', '22': 'LA', '23': 'ME', '24': 'MD', '25': 'MA', '26': 'MI', '27': 'MN',
    '28': 'MS', '29': 'MO', '30': 'MT', '31': 'NE', '32': 'NV', '33': 'NH', '34': 'NJ', '35': 'NM',
    '36': 'NY', '37': 'NC', '38': 'ND', '39': 'OH', '40': 'OK', '41': 'OR', '42': 'PA', '44': 'RI',
    '45': 'SC', '46': 'SD', '47': 'TN', '48': 'TX', '49': 'UT', '50': 'VT', '51': 'VA', '53': 'WA',
    '54': 'WV', '55': 'WI', '56': 'WY', '60': 'AS', '66': 'GU', '69': 'MP', '72': 'PR', '78': 'VI',
}

# Retired or merged jurisdictions mapped onto the codes used by the Census GeoJSON.
FIPS_REMAP = {
    '51917': '51019',  # HDPulse's combined Bedford County + Bedford City, VA
    '51515': '51019',  # Bedford city, VA merged into Bedford County in 2013
    '46113': '46102',  # Shannon County, SD renamed Oglala Lakota County in 2015
}

MISSING = {'', 'NA', 'N/A', 'NULL', '.', '-', '*', '**', 'SUPPRESSED'}

FIPS_HEADER = re.compile(r'fips|county code|geoid', re.I)
FIPS_VALUE = re.compile(r'^\d{4,5}$')


def find_fips_column(header, body):
    for i, cell in enumerate(header):
        if FIPS_HEADER.search(cell):
            return i
    for i in range(len(header)):
        hits = sum(1 for r in body[:50] if len(r) > i and FIPS_VALUE.match(r[i].strip()))
        if hits > 25:
            return i
    raise SystemExit('Could not find a FIPS/county-code column.')


def load_geoids():
    with open(ROOT / 'counties.geojson', encoding='utf-8') as fh:
        gj = json.load(fh)
    return {f['properties']['GEOID']: f['properties']['NAME'] for f in gj['features']}


def clean(in_path: Path, out_path: Path, value_col: str):
    geoids = load_geoids()

    with open(in_path, encoding='utf-8-sig', newline='') as fh:
        rows = list(csv.reader(fh))

    header, body = rows[0], rows[1:]
    fips_i = find_fips_column(header, body)
    value_i = len(header) - 1

    cleaned, unmatched = {}, []
    for row in body:
        # Skips CDC WONDER "Total" rows and the trailing caveat block, which are short or unkeyed.
        if len(row) <= max(fips_i, value_i):
            continue
        raw_fips = row[fips_i].strip()
        if not FIPS_VALUE.match(raw_fips):
            continue

        geoid = FIPS_REMAP.get(raw_fips.zfill(5), raw_fips.zfill(5))

        if geoid not in geoids:
            unmatched.append((geoid, row[fips_i - 1].strip() if fips_i else ''))
            continue

        raw = row[value_i].strip()
        value = '' if raw.upper() in MISSING else raw

        # When two source codes collapse into one county, the first row with a value wins.
        if cleaned.get(geoid, ['', '', '', ''])[3]:
            continue

        # Names come from the Census GeoJSON so they always match what the map labels.
        cleaned[geoid] = [geoid, geoids[geoid], STATE_ABBR_BY_FIPS.get(geoid[:2], ''), value]

    out_path.parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, 'w', encoding='utf-8', newline='') as fh:
        writer = csv.writer(fh)
        writer.writerow(['geoid', 'county', 'state', value_col])
        writer.writerows(cleaned[k] for k in sorted(cleaned))

    with_value = sum(1 for r in cleaned.values() if r[3])
    print(f'{in_path.name} -> {out_path}')
    print(f'  rows in:      {len(body)}')
    print(f'  rows out:     {len(cleaned)}  ({with_value} with a value, '
          f'{len(cleaned) - with_value} blank)')
    print(f'  counties in geojson without a row: {len(set(geoids) - set(cleaned))}')
    if unmatched:
        print(f'  unmatched FIPS ({len(unmatched)}): {unmatched[:10]}')


if __name__ == '__main__':
    if len(sys.argv) != 4:
        sys.exit(__doc__)
    clean(Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3])
