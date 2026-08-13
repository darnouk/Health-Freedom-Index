"""Build data/gyms.csv (gyms per 10,000 residents) from the Census County Business Patterns API.

Source
    Establishments: https://api.census.gov/data/2023/cbp
        NAICS 713940 = Fitness and Recreational Sports Centers
    Population:     https://api.census.gov/data/2023/acs/acs5  (B01003_001E)

Usage
    python scripts/fetch_gyms_cbp.py --key YOUR_CENSUS_API_KEY [--year 2023]
    (or set CENSUS_API_KEY; free key at https://api.census.gov/data/key_signup.html)

Output: data/gyms.csv with geoid,county,state,gyms,population,gyms_per_10k,gyms_year
CBP omits a row both for true zeros and for counts withheld for disclosure. We separate the
two using the parent industry 7139. Because suppression is redrawn each year, counties hidden
in the target year are backfilled from up to --backfill-years earlier vintages, and gyms_year
records which vintage each count came from. Counties suppressed in every year stay blank so
they are treated as missing data rather than as counties with no gyms.
"""
import argparse
import csv
import json
import os
import re
import sys
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
NAICS_GYMS = '713940'
# Parent industry and its full set of 6-digit children, used to detect suppression.
NAICS_PARENT = '7139'
NAICS_SIBLINGS = ['713910', '713920', '713930', '713940', '713950', '713990']

STATE_ABBR_BY_FIPS = {
    '01': 'AL', '02': 'AK', '04': 'AZ', '05': 'AR', '06': 'CA', '08': 'CO', '09': 'CT', '10': 'DE',
    '11': 'DC', '12': 'FL', '13': 'GA', '15': 'HI', '16': 'ID', '17': 'IL', '18': 'IN', '19': 'IA',
    '20': 'KS', '21': 'KY', '22': 'LA', '23': 'ME', '24': 'MD', '25': 'MA', '26': 'MI', '27': 'MN',
    '28': 'MS', '29': 'MO', '30': 'MT', '31': 'NE', '32': 'NV', '33': 'NH', '34': 'NJ', '35': 'NM',
    '36': 'NY', '37': 'NC', '38': 'ND', '39': 'OH', '40': 'OK', '41': 'OR', '42': 'PA', '44': 'RI',
    '45': 'SC', '46': 'SD', '47': 'TN', '48': 'TX', '49': 'UT', '50': 'VT', '51': 'VA', '53': 'WA',
    '54': 'WV', '55': 'WI', '56': 'WY', '60': 'AS', '66': 'GU', '69': 'MP', '72': 'PR', '78': 'VI',
}


def get_json(url: str, params: dict):
    query = urllib.parse.urlencode({k: v for k, v in params.items() if v})
    with urllib.request.urlopen(f'{url}?{query}', timeout=120) as res:
        body = res.read().decode('utf-8')
    # The API answers with an HTML "Missing Key" / error page instead of a 4xx status.
    if not body.lstrip().startswith('['):
        snippet = re.sub(r'\s+', ' ', re.sub(r'<[^>]+>', ' ', body))[:200].strip()
        raise SystemExit(
            f'Census API did not return JSON for {url}\n  {snippet}\n'
            '  A key is required: request one at https://api.census.gov/data/key_signup.html\n'
            '  then pass --key YOUR_KEY or set CENSUS_API_KEY.'
        )
    return json.loads(body)


def to_rows(payload):
    """Census returns [[header...], [row...]]; turn it into dicts."""
    header, *body = payload
    return [dict(zip(header, row)) for row in body]


def fetch_naics(year: int, key: str | None, naics: str):
    """{geoid: ESTAB} for one NAICS code. Counties absent from the response are not zeros."""
    naics_param = 'NAICS2017' if year >= 2017 else 'NAICS2012'
    rows = to_rows(get_json(f'https://api.census.gov/data/{year}/cbp', {
        'get': 'NAME,ESTAB',
        'for': 'county:*',
        'in': 'state:*',
        naics_param: naics,
        'key': key,
    }))
    return {r['state'] + r['county']: int(r['ESTAB'] or 0) for r in rows}


def fetch_establishments(year: int, key: str | None, backfill_years: int = 0):
    """Gym counts, separating a true 0 from a suppressed cell.

    CBP omits a county/NAICS row both when the count is genuinely zero and when it is
    withheld for disclosure, so a bare absence is ambiguous. We disambiguate using the
    parent industry 7139 ("Other amusement and recreation"): if the published children of
    7139 account for the parent total, nothing is hidden and a missing 713940 is a real
    zero. If children fall short of the parent, the shortfall is suppressed detail and
    713940 may be part of it, so the county is left blank rather than scored as zero.

    Suppression is redrawn each year, so a county hidden in the target year is often
    published in a nearby one. With `backfill_years` we walk backwards and adopt the most
    recent published count, recording which year each fallback came from.

    Returns (gyms_by_geoid, suppressed_geoids, source_year_by_geoid).
    """
    gyms = fetch_naics(year, key, NAICS_GYMS)
    source_year = {geoid: year for geoid in gyms}

    parent = fetch_naics(year, key, NAICS_PARENT)
    children = {}
    for code in NAICS_SIBLINGS:
        for geoid, estab in fetch_naics(year, key, code).items():
            children[geoid] = children.get(geoid, 0) + estab

    suppressed = set()
    for geoid, total in parent.items():
        if geoid in gyms:
            continue  # published outright, nothing to infer
        if children.get(geoid, 0) < total:
            suppressed.add(geoid)

    # Only suppressed counties are backfilled. A county with a real zero already has a
    # trustworthy value, so reaching into older years could only make it worse.
    for offset in range(1, backfill_years + 1):
        if not suppressed:
            break
        past = year - offset
        print(f'  backfilling {len(suppressed)} suppressed counties from CBP {past}…')
        try:
            older = fetch_naics(past, key, NAICS_GYMS)
        except Exception as exc:  # a vintage may not exist or may use another NAICS basis
            print(f'    skipped {past}: {exc}')
            continue
        for geoid in sorted(suppressed & older.keys()):
            gyms[geoid] = older[geoid]
            source_year[geoid] = past
        suppressed -= older.keys()

    # A county missing from 7139 entirely has no establishments in the whole parent
    # industry, which does make its gym count a legitimate zero.
    return gyms, suppressed, source_year


def fetch_population(year: int, key: str | None):
    rows = to_rows(get_json(f'https://api.census.gov/data/{year}/acs/acs5', {
        'get': 'B01003_001E',
        'for': 'county:*',
        'in': 'state:*',
        'key': key,
    }))
    return {r['state'] + r['county']: int(r['B01003_001E'] or 0) for r in rows}


def load_geoids():
    with open(ROOT / 'counties.geojson', encoding='utf-8') as fh:
        gj = json.load(fh)
    return {f['properties']['GEOID']: f['properties']['NAME'] for f in gj['features']}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--year', type=int, default=2023)
    ap.add_argument('--key', default=os.environ.get('CENSUS_API_KEY'),
                    help='Census API key (defaults to $CENSUS_API_KEY)')
    ap.add_argument('--out', default='data/gyms.csv')
    ap.add_argument('--backfill-years', type=int, default=3, metavar='N',
                    help='For counties suppressed in the target year, look back up to N '
                         'earlier CBP vintages for a published count (0 disables)')
    args = ap.parse_args()

    geoids = load_geoids()
    print(f'Fetching CBP {args.year} NAICS {NAICS_GYMS}…')
    estabs, suppressed, source_year = fetch_establishments(
        args.year, args.key, args.backfill_years)
    current = sum(1 for y in source_year.values() if y == args.year)
    print(f'  {current} counties with a {args.year} gym count')
    print(f'  {len(source_year) - current} counties backfilled from an earlier vintage')
    print(f'  {len(suppressed)} counties still suppressed (left blank)')
    print(f'Fetching ACS {args.year} 5-year population…')
    pop = fetch_population(args.year, args.key)

    out_path = ROOT / args.out
    out_path.parent.mkdir(parents=True, exist_ok=True)
    missing_pop = n_suppressed = n_zero = 0
    with open(out_path, 'w', encoding='utf-8', newline='') as fh:
        w = csv.writer(fh)
        w.writerow(['geoid', 'county', 'state', 'gyms', 'population', 'gyms_per_10k',
                    'gyms_year'])
        for geoid in sorted(geoids):
            people = pop.get(geoid, 0)
            year_used = source_year.get(geoid, args.year if geoid not in suppressed else '')
            if geoid in suppressed and geoid not in estabs:
                # Withheld by Census in every year checked: blank so the app treats it as
                # missing, not as a county with no gyms.
                gyms, rate, n_suppressed = '', '', n_suppressed + 1
            else:
                gyms = estabs.get(geoid, 0)
                if not gyms:
                    n_zero += 1
                if people:
                    rate = f'{gyms / people * 10000:.2f}'
                else:
                    rate, missing_pop = '', missing_pop + 1
            w.writerow([geoid, geoids[geoid], STATE_ABBR_BY_FIPS.get(geoid[:2], ''),
                        gyms, people or '', rate, year_used])

    print(f'Wrote {out_path}')
    print(f'  {len(geoids)} counties: {len(geoids) - n_suppressed - missing_pop} with a rate, '
          f'{n_suppressed} suppressed, {missing_pop} without population')
    print(f'  {n_zero} counties have a true zero gym count')


if __name__ == '__main__':
    sys.exit(main())
