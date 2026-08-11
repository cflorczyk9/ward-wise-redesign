#!/usr/bin/env python3
"""Snapshot the score matrix so the report pages can re-rank wards client-side.

Penlight's whole premise is that there is no single answer to what makes a
neighbourhood good, so readers should be able to weight the measures
themselves. The map on penlight.wardwise.org does this live; this bakes the
same matrix into static files so our pages can do it without a server.

Two outputs:

  data/equation.json  every metric's 0-100 score per ward (direction-adjusted
                      by the API, higher is always better), grouped by the
                      API's own wellbeing categories, with the API's default
                      weights so "no preference" reproduces the site's ranking
  data/menu.json      the raw values behind the menu_* measures: how each
                      ward's office spent its ~$1.5M discretionary budget,
                      with citywide medians for context

    python3 build_equation_data.py
    python3 build_equation_data.py --api-base https://other.city.example

Standard library only.
"""

from __future__ import annotations

import argparse
import json
import statistics
import sys
import urllib.request
from pathlib import Path

HERE = Path(__file__).parent


def load_city() -> dict:
    """Load the per-city config the default API root is pinned to."""
    return json.loads((HERE / "city.json").read_text())


CITY = load_city()
DEFAULT_BASE = CITY["api_base"]
EQUATION_OUT = HERE / "data" / "equation.json"
MENU_OUT = HERE / "data" / "menu.json"


def get(base: str, path: str) -> dict:
    req = urllib.request.Request(base + path, headers={"Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=90) as response:
        return json.loads(response.read())


def category_label(category_id: str) -> str:
    special = {
        "good_governance": "Good governance",
        "religion_spiritual": "Religion and spirituality",
    }
    if category_id in special:
        return special[category_id]
    return category_id.replace("_", " ").capitalize()


def menu_label(label: str) -> str:
    return label.replace("Menu $ on ", "").replace("Menu ", "").strip().capitalize()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--api-base", default=DEFAULT_BASE)
    args = parser.parse_args()

    dictionary = get(args.api_base, "/api/metrics")
    matrix = get(args.api_base, "/api/metrics/score-matrix?area_type=ward&year=latest")
    cells = matrix["matrix"][matrix.get("year", "latest")]

    metrics = {}
    categories = {}
    for entry in dictionary["metrics"]:
        metric_id = entry["metric_id"]
        category = entry.get("category") or "uncategorised"
        categories.setdefault(category, category_label(category))
        metrics[metric_id] = {
            "label": entry.get("label") or metric_id,
            "category": category,
            "weight": entry.get("default_weight", 1.0),
        }

    # Only ship scores for metrics the dictionary explains. The matrix carries
    # a handful of extra ids the dictionary does not document; a number nobody
    # can look up does not belong in a reader-facing equation.
    scores = {}
    undocumented = set()
    for ward_id, ward_cells in cells.items():
        row = {}
        for metric_id, cell in ward_cells.items():
            if metric_id not in metrics:
                undocumented.add(metric_id)
                continue
            score = cell.get("s")
            if isinstance(score, (int, float)):
                row[metric_id] = round(score, 1)
        scores[ward_id] = row

    used = {m for row in scores.values() for m in row}
    metrics = {m: v for m, v in metrics.items() if m in used}
    categories = {c: label for c, label in categories.items()
                  if any(v["category"] == c for v in metrics.values())}

    equation = {
        "generated_from": f"{args.api_base} /api/metrics + score-matrix (year=latest)",
        "categories": categories,
        "metrics": metrics,
        "scores": scores,
    }
    EQUATION_OUT.write_text(json.dumps(equation, indent=1, sort_keys=True) + "\n")

    # ---- menu money ------------------------------------------------------
    menu_metrics = {}
    for entry in dictionary["metrics"]:
        if entry["metric_id"].startswith("menu_"):
            menu_metrics[entry["metric_id"]] = {
                "label": menu_label(entry.get("label") or entry["metric_id"]),
                "unit": entry.get("unit"),
                "description": entry.get("description"),
            }

    menu_wards = {}
    for ward_id, ward_cells in cells.items():
        row = {}
        for metric_id in menu_metrics:
            cell = ward_cells.get(metric_id)
            if cell and isinstance(cell.get("v"), (int, float)):
                row[metric_id] = round(cell["v"], 2)
        menu_wards[ward_id] = row

    city = {}
    for metric_id in menu_metrics:
        values = [row[metric_id] for row in menu_wards.values() if metric_id in row]
        if values:
            city[metric_id] = {
                "median": round(statistics.median(values), 2),
                "min": round(min(values), 2),
                "max": round(max(values), 2),
                "wards_reporting": len(values),
            }

    menu = {
        "generated_from": f"{args.api_base} score-matrix (year=latest), raw values",
        "metrics": menu_metrics,
        "wards": menu_wards,
        "city": city,
    }
    MENU_OUT.write_text(json.dumps(menu, indent=1, sort_keys=True) + "\n")

    print(f"wrote {EQUATION_OUT.relative_to(HERE)}")
    print(f"  {len(scores)} wards, {len(metrics)} documented metrics, "
          f"{len(categories)} categories")
    if undocumented:
        print(f"  {len(undocumented)} matrix ids not in the dictionary, skipped: "
              f"{', '.join(sorted(undocumented)[:8])}")
    print(f"wrote {MENU_OUT.relative_to(HERE)}")
    print(f"  {len(menu_metrics)} menu measures, medians over "
          f"{min((c['wards_reporting'] for c in city.values()), default=0)}-"
          f"{max((c['wards_reporting'] for c in city.values()), default=0)} wards")
    return 0


if __name__ == "__main__":
    sys.exit(main())
