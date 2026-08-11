#!/usr/bin/env python3
"""Mirror city.json into static/site-config.js, the copy the pages load.

city.json is the single per-city source of truth. The HTML pages cannot read
it directly, since they are static files with no build step at request time,
so this writes the same facts out as a small JS file that sets
window.WARDWISE_SITE before the page scripts run.

    python3 build_site_config.py

Key order is fixed in this script rather than taken from dict iteration, so
re-running it with an unchanged city.json produces a byte-identical file.
press_allowlist and probe_metric_id stay out of the mirror. They only matter
to the Python builders that already read city.json directly, and the pages
have no use for them. _comment is dropped too, since it documents city.json
itself, not the site.

Standard library only.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

HERE = Path(__file__).parent
CITY = HERE / "city.json"
OUT = HERE / "static" / "site-config.js"

# Ordered (city.json key, JS key) pairs for the top-level fields. Fixed order
# here, not dict iteration order, is what keeps re-runs byte-identical.
FIELDS = [
    ("city", "city"),
    ("state", "state"),
    ("area_noun", "areaNoun"),
    ("area_noun_plural", "areaNounPlural"),
    ("area_count", "areaCount"),
    ("office_title", "officeTitle"),
    ("api_base", "apiBase"),
    ("site_base", "siteBase"),
    ("survey_url", "surveyUrl"),
    ("support_url", "supportUrl"),
    ("dictionary_url", "dictionaryUrl"),
    ("boundary_redraw_year", "boundaryRedrawYear"),
    ("unstable_metric_prefixes", "unstableMetricPrefixes"),
    ("office_metric_pattern", "officeMetricPattern"),
    ("probe_area_id", "probeAreaId"),
    ("default_area_id", "defaultAreaId"),
]

# Same idea, one level down, for the geocoder sub-object.
GEOCODER_FIELDS = [
    ("primary_locator_url", "primaryLocatorUrl"),
    ("nominatim_viewbox", "nominatimViewbox"),
    ("nominatim_query_suffix", "nominatimQuerySuffix"),
]

HEADER = """/* GENERATED FILE. Built from city.json by build_site_config.py, do not
 * edit by hand, your changes will be overwritten on the next build.
 *
 * Penlight has said it wants to expand beyond Chicago. Everything mechanical
 * about this site already travels: the pages are static, the data files are
 * built by scripts that take --api-base, and the scripts recompute ranks from
 * whatever matrix the API serves. What does not travel automatically is
 * language, so the editorial copy in the HTML is written per city on purpose.
 * See the "Another city" section of the README for the full list.
 */
"""


def build_config(city: dict) -> dict:
    """Pick and rename the city.json fields the pages are allowed to see."""
    missing = [src for src, _ in FIELDS if src not in city]
    if missing:
        print(f"city.json is missing field(s): {', '.join(missing)}", file=sys.stderr)
        sys.exit(1)
    if "geocoder" not in city:
        print("city.json is missing field: geocoder", file=sys.stderr)
        sys.exit(1)
    geocoder = city["geocoder"]
    missing_geo = [src for src, _ in GEOCODER_FIELDS if src not in geocoder]
    if missing_geo:
        print(f"city.json geocoder is missing field(s): {', '.join(missing_geo)}", file=sys.stderr)
        sys.exit(1)

    config = {js_key: city[src_key] for src_key, js_key in FIELDS}
    config["geocoder"] = {js_key: geocoder[src_key] for src_key, js_key in GEOCODER_FIELDS}
    return config


def render(config: dict) -> str:
    """Serialize config to the window.WARDWISE_SITE assignment, JSON-encoded."""
    lines = [HEADER, "window.WARDWISE_SITE = {"]
    top_keys = [js_key for _, js_key in FIELDS] + ["geocoder"]
    for i, key in enumerate(top_keys):
        comma = "," if i < len(top_keys) - 1 else ""
        if key == "geocoder":
            lines.append("  geocoder: {")
            geo_keys = [js_key for _, js_key in GEOCODER_FIELDS]
            for j, geo_key in enumerate(geo_keys):
                geo_comma = "," if j < len(geo_keys) - 1 else ""
                value = json.dumps(config["geocoder"][geo_key])
                lines.append(f"    {geo_key}: {value}{geo_comma}")
            lines.append(f"  }}{comma}")
        else:
            value = json.dumps(config[key])
            lines.append(f"  {key}: {value}{comma}")
    lines.append("};\n")
    return "\n".join(lines)


def main() -> int:
    if not CITY.exists():
        print("city.json not found, nothing to build from", file=sys.stderr)
        return 2

    city = json.loads(CITY.read_text())
    config = build_config(city)
    js = render(config)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(js)

    print(f"wrote {OUT.relative_to(HERE)}  ({len(config)} top-level keys)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
