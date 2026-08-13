"""Convert a county provider-ratio export into a providers-per-10k rate for the map.

Usage:
    python scripts/clean_provider_ratio.py <input.csv> <output.csv> <value_column_name>

Input rows look like `FIPS,State,County,<Something> Ratio` where the ratio is
"residents:providers" (e.g. "3320:1"). A rate is used instead of the raw ratio because
counties with no provider at all are published as "1585:0", which has no finite ratio but a
perfectly well-defined rate of 0 per 10k.

Produces: geoid,county,state,<value_column_name>
"""
import csv
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from clean_county_csv import (  # noqa: E402
    FIPS_REMAP, FIPS_VALUE, MISSING, STATE_ABBR_BY_FIPS, load_geoids,
)

RATIO = re.compile(r'^([\d,]+)\s*:\s*([\d,]+)$')


def to_rate(raw: str):
    """residents:providers -> providers per 10,000 residents."""
    if raw.upper() in MISSING:
        return ''
    m = RATIO.match(raw)
    if not m:
        return ''
    residents = int(m.group(1).replace(',', ''))
    providers = int(m.group(2).replace(',', ''))
    if residents == 0:
        return ''
    return f'{10000 * providers / residents:.2f}'


def clean(in_path: Path, out_path: Path, value_col: str):
    geoids = load_geoids()

    with open(in_path, encoding='utf-8-sig', newline='') as fh:
        rows = list(csv.reader(fh))[1:]

    cleaned, skipped = {}, 0
    for row in rows:
        if len(row) < 4:
            continue
        raw_fips = row[0].strip()
        # State totals arrive as SS000 and drop out here along with retired county codes.
        if not FIPS_VALUE.match(raw_fips):
            continue
        geoid = FIPS_REMAP.get(raw_fips.zfill(5), raw_fips.zfill(5))
        if geoid not in geoids:
            skipped += 1
            continue
        if cleaned.get(geoid, ['', '', '', ''])[3]:
            continue
        cleaned[geoid] = [geoid, geoids[geoid], STATE_ABBR_BY_FIPS.get(geoid[:2], ''),
                          to_rate(row[3].strip())]

    out_path.parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, 'w', encoding='utf-8', newline='') as fh:
        writer = csv.writer(fh)
        writer.writerow(['geoid', 'county', 'state', value_col])
        writer.writerows(cleaned[k] for k in sorted(cleaned))

    with_value = sum(1 for r in cleaned.values() if r[3])
    zeros = sum(1 for r in cleaned.values() if r[3] == '0.00')
    print(f'{in_path.name} -> {out_path}')
    print(f'  rows out: {len(cleaned)}  ({with_value} with a value, '
          f'{len(cleaned) - with_value} blank, {zeros} with no provider)')
    print(f'  counties in geojson without a row: {len(set(geoids) - set(cleaned))}')
    print(f'  rows dropped (state totals / unknown FIPS): {skipped}')


if __name__ == '__main__':
    if len(sys.argv) != 4:
        sys.exit(__doc__)
    clean(Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3])
