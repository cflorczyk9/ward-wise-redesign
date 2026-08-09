#!/usr/bin/env python3
"""Contract check against the live Penlight API.

This site reads an API it does not control, that carries no version number and
publishes no schema. Nothing announces a breaking change. The failure mode is
quiet: a renamed field empties a column, and the page still looks fine.

So instead of trusting it, pin the handful of assumptions the app actually
makes and check them. This records a baseline fingerprint of the API and tells
you exactly what moved since the last one.

    python3 check_api.py            # compare against api-baseline.json
    python3 check_api.py --update   # accept what is live now as the baseline
    python3 check_api.py --json     # machine-readable, for CI

Exit codes: 0 clean, 1 drift found, 2 could not reach the API.
Standard library only.
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.request
from pathlib import Path

API_BASE = "https://penlight.wardwise.org"
BASELINE = Path(__file__).parent / "api-baseline.json"
PROBE_WARD = "42"

# Every field static/app.js actually reads. If one of these disappears or is
# renamed upstream, some part of the report silently stops working.
REQUIRED = {
    "/api/metrics": {
        "top_level": ["metrics", "coverage", "snapshots"],
        # app.js: label, category, unit, direction, description, source
        "metric_fields": ["metric_id", "label", "category", "unit", "direction"],
    },
    "/api/wards": {
        "top_level": ["wards"],
        "ward_fields": ["ward_id", "alderperson"],
    },
    "/api/metrics/timeseries": {
        "top_level": ["timeseries"],
        "series_fields": ["metric_id", "observations"],
        # the change math is built entirely on these three
        "observation_fields": ["value", "period_end", "collected_at"],
    },
}


def fetch(path: str) -> dict:
    request = urllib.request.Request(API_BASE + path, headers={"Accept": "application/json"})
    with urllib.request.urlopen(request, timeout=45) as response:
        return json.loads(response.read())


def fingerprint() -> dict:
    """Reduce the live API to the few numbers and names worth watching."""
    metrics = fetch("/api/metrics")
    wards = fetch("/api/wards")
    series = fetch(f"/api/metrics/timeseries?area_type=ward&area_id={PROBE_WARD}")

    metric_entries = metrics.get("metrics", [])
    ward_entries = wards.get("wards", [])
    series_entries = series.get("timeseries", [])

    # How many metrics carry enough dated history for this report to rank them.
    # This is the number that decides whether the page has anything to say.
    rankable = 0
    for entry in series_entries:
        years = {
            str(obs.get("period_end"))[:4]
            for obs in entry.get("observations", [])
            if obs.get("period_end") and obs.get("value") is not None
        }
        if len(years) >= 2:
            rankable += 1

    return {
        "metric_count": len(metric_entries),
        "metric_ids": sorted(entry.get("metric_id", "") for entry in metric_entries),
        "ward_count": len(ward_entries),
        "series_count": len(series_entries),
        "rankable_in_ward_%s" % PROBE_WARD: rankable,
        "directions": sorted({entry.get("direction", "") for entry in metric_entries}),
        "categories": sorted({entry.get("category", "") for entry in metric_entries}),
        "metrics_top_level": sorted(metrics.keys()),
        "wards_top_level": sorted(wards.keys()),
        "timeseries_top_level": sorted(series.keys()),
    }


def check_required_fields() -> list[str]:
    """Hard failures. These break the page rather than merely change it."""
    problems: list[str] = []

    metrics = fetch("/api/metrics")
    for key in REQUIRED["/api/metrics"]["top_level"]:
        if key not in metrics:
            problems.append(f"/api/metrics lost top-level key '{key}'")
    if metrics.get("metrics"):
        sample = metrics["metrics"][0]
        for field in REQUIRED["/api/metrics"]["metric_fields"]:
            if field not in sample:
                problems.append(f"/api/metrics entries lost field '{field}'")

    wards = fetch("/api/wards")
    for key in REQUIRED["/api/wards"]["top_level"]:
        if key not in wards:
            problems.append(f"/api/wards lost top-level key '{key}'")
    if wards.get("wards"):
        sample = wards["wards"][0]
        for field in REQUIRED["/api/wards"]["ward_fields"]:
            if field not in sample:
                problems.append(f"/api/wards entries lost field '{field}'")

    series = fetch(f"/api/metrics/timeseries?area_type=ward&area_id={PROBE_WARD}")
    for key in REQUIRED["/api/metrics/timeseries"]["top_level"]:
        if key not in series:
            problems.append(f"/api/metrics/timeseries lost top-level key '{key}'")
    entries = series.get("timeseries", [])
    if not entries:
        problems.append("/api/metrics/timeseries returned no series for ward " + PROBE_WARD)
    else:
        for field in REQUIRED["/api/metrics/timeseries"]["series_fields"]:
            if field not in entries[0]:
                problems.append(f"timeseries entries lost field '{field}'")
        observations = entries[0].get("observations") or []
        if not observations:
            problems.append("timeseries entries carry no observations")
        else:
            for field in REQUIRED["/api/metrics/timeseries"]["observation_fields"]:
                if field not in observations[0]:
                    problems.append(f"observations lost field '{field}'")

    # Passing no metric_id is how the app gets every series in one request.
    # If that ever starts filtering, the page would quietly show one metric.
    if len(entries) < 50:
        problems.append(
            f"timeseries returned only {len(entries)} series; the app relies on the "
            "no-metric_id call returning all of them"
        )

    return problems


def compare(old: dict, new: dict) -> list[str]:
    """Soft drift. Worth knowing about, not necessarily broken."""
    notes: list[str] = []

    old_ids = set(old.get("metric_ids", []))
    new_ids = set(new.get("metric_ids", []))
    added = sorted(new_ids - old_ids)
    removed = sorted(old_ids - new_ids)

    if added:
        notes.append(f"{len(added)} new metric(s): {', '.join(added[:8])}"
                     + (" …" if len(added) > 8 else ""))
    if removed:
        notes.append(f"{len(removed)} metric(s) GONE: {', '.join(removed[:8])}"
                     + (" …" if len(removed) > 8 else ""))

    for key in ("ward_count", "series_count", "metric_count", f"rankable_in_ward_{PROBE_WARD}"):
        before, after = old.get(key), new.get(key)
        if before != after and before is not None:
            notes.append(f"{key}: {before} -> {after}")

    for key in ("directions", "categories", "metrics_top_level", "wards_top_level",
                "timeseries_top_level"):
        before, after = old.get(key), new.get(key)
        if before is not None and before != after:
            notes.append(f"{key} changed: {before} -> {after}")

    return notes


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--update", action="store_true", help="accept the live API as the new baseline")
    parser.add_argument("--json", action="store_true", help="machine-readable output")
    args = parser.parse_args()

    try:
        problems = check_required_fields()
        current = fingerprint()
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError) as err:
        print(f"could not reach {API_BASE}: {err}", file=sys.stderr)
        return 2

    drift: list[str] = []
    had_baseline = BASELINE.exists()
    if had_baseline:
        previous = json.loads(BASELINE.read_text())
        drift = compare(previous, current)

    if args.update or not had_baseline:
        BASELINE.write_text(json.dumps(current, indent=2, sort_keys=True) + "\n")

    if args.json:
        print(json.dumps({"broken": problems, "drift": drift, "fingerprint": current}, indent=2))
        return 1 if problems or drift else 0

    if problems:
        print("BROKEN, the app depends on these:")
        for problem in problems:
            print("  x " + problem)
    if drift:
        print("Changed since the last baseline:")
        for note in drift:
            print("  ~ " + note)

    if not had_baseline:
        print(f"No baseline existed, wrote one to {BASELINE.name}.")
    elif args.update:
        print(f"Baseline updated ({BASELINE.name}).")

    if not problems and not drift:
        print("API matches the baseline. Nothing to do.")
    print(
        f"\n{current['metric_count']} metrics, {current['ward_count']} wards, "
        f"{current[f'rankable_in_ward_{PROBE_WARD}']} rankable in ward {PROBE_WARD}."
    )

    return 1 if (problems or drift) else 0


if __name__ == "__main__":
    sys.exit(main())
