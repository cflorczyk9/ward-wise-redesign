#!/usr/bin/env python3
"""Generate the per-ward facts the quarterly report is written from.

Every number a write-up cites comes out of this file. Nothing downstream is
allowed to compute a ranking, because a ranking recomputed by hand is a ranking
that will eventually disagree with the site.

Alongside each ranking it records what undercuts it. A rank out of 50 looks
precise and often is not: the measure may be modelled rather than counted,
smeared across ward lines from census tracts, or separated from fifteen other
wards by less than a rounding error.

    python3 build_ward_data.py            # writes data/wards.json
    python3 build_ward_data.py --ward 42  # print one ward and exit

Standard library only.
"""

from __future__ import annotations

import argparse
import json
import statistics
import sys
import urllib.request
from pathlib import Path

BASE = "https://penlight.wardwise.org"
OUT = Path(__file__).parent / "data" / "wards.json"

# Allocation methods, in plain English, and whether they weaken a ward-level
# claim. The wording is what appears on the page, so it stays non-technical.
ALLOCATION_NOTES = {
    "modelled": (
        "modeled_synthetic_sae",
        "This is a statistical estimate for the ward, not a count of anything in it. "
        "It is modelled from survey data, so it describes what a ward like this one "
        "usually looks like.",
    ),
    "area": (
        "area_weighted",
        "Allocated from census tracts by area, which assumes people are spread evenly "
        "inside each tract. Where a tract straddles a ward line, some of this belongs "
        "to the neighbours.",
    ),
    "zcta": (
        "zcta_area_apportioned",
        "Apportioned from ZIP code areas, which do not follow ward lines at all.",
    ),
    "puma": (
        "puma_area_apportioned",
        "Apportioned from large census areas that cover several wards, so neighbouring "
        "wards will look similar by construction.",
    ),
    "ward_field": (
        "license_ward_field",
        "Taken from a ward field recorded by the source at the time. Ward boundaries "
        "were redrawn in 2023, so older records refer to a differently shaped ward.",
    ),
    "direct": (
        "direct_ward",
        "Reported directly against a ward by the source. Boundaries were redrawn in "
        "2023, so this counts today's ward but older figures counted a different one.",
    ),
}
BY_METHOD = {code: text for code, text in ALLOCATION_NOTES.values()}


def get(path: str) -> dict:
    req = urllib.request.Request(BASE + path, headers={"Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=90) as response:
        return json.loads(response.read())



def tidy_name(name: str | None) -> str | None:
    """Repair names that arrive with the suffix sorted to the front.

    Two of the fifty come through as "Jr., Felix Cardona", which looks like a
    "Lastname, Firstname" sort that lost its surname. Printing that under a
    photograph of a real person is not acceptable, so it is corrected here and
    reported upstream by check_api.py.
    """
    if not name:
        return name
    text = name.strip()
    for suffix in ("Jr.", "Jr", "Sr.", "Sr", "II", "III", "IV"):
        prefix = suffix + ","
        if text.startswith(prefix):
            rest = text[len(prefix):].strip()
            return f"{rest} {suffix if suffix.endswith('.') or len(suffix) > 2 else suffix + '.'}".strip()
    return text


def caveats_for(entry: dict, meta: dict, coverage: dict) -> list[str]:
    """What makes this ranking mean less than it looks like."""
    notes: list[str] = []
    md = (coverage.get(entry["metric_id"]) or {}).get("latest_metadata") or {}

    method = md.get("allocation_method")
    if method in BY_METHOD:
        notes.append(BY_METHOD[method])

    # A rank is only as meaningful as the gap it describes. When the pack is
    # this tight, first and fifteenth are the same place.
    if entry["within_two_points"] >= 10:
        notes.append(
            f"{entry['within_two_points']} wards score within two points of this one. "
            "The ranking is sharper than the difference behind it."
        )
    if entry["middle_half_spread"] < 12:
        notes.append(
            f"The middle half of all wards spans only {entry['middle_half_spread']:.0f} "
            "points on this measure, so most of the city is bunched together."
        )

    confidence = md.get("confidence")
    if confidence and confidence != "high":
        notes.append(f"The source itself rates this {confidence} confidence.")

    if (coverage.get(entry["metric_id"]) or {}).get("status") != "populated":
        notes.append("This measure is not fully populated across all 50 wards.")

    return notes


def build() -> dict:
    metrics_payload = get("/api/metrics")
    meta = {m["metric_id"]: m for m in metrics_payload["metrics"]}
    coverage = metrics_payload.get("coverage", {})
    wards_payload = get("/api/wards")
    scores = {r["area_id"]: r for r in get("/api/metrics/scores?area_type=ward")["scores"]}
    matrix_raw = get("/api/metrics/score-matrix?area_type=ward&year=latest")["matrix"]
    matrix = matrix_raw[list(matrix_raw)[0]]

    # metric -> sorted list of (ward, score), computed once
    board: dict[str, list[tuple[str, float]]] = {}
    for ward, cells in matrix.items():
        for mid, cell in (cells or {}).items():
            if cell and isinstance(cell.get("s"), (int, float)):
                board.setdefault(mid, []).append((ward, float(cell["s"])))
    for mid in board:
        board[mid].sort(key=lambda r: -r[1])

    out = {"wards": {}, "generated_from": BASE, "metric_count": len(meta)}

    for ward_row in wards_payload["wards"]:
        ward = ward_row["ward_id"]
        alder = ward_row.get("alderperson") or {}
        ranked = []

        for mid, rows in board.items():
            if len(rows) < 25:
                continue
            all_scores = [s for _, s in rows]
            position = next((i for i, (w, _) in enumerate(rows, 1) if w == ward), None)
            if position is None:
                continue
            score = matrix[ward][mid]["s"]
            quartiles = statistics.quantiles(all_scores, n=4)
            entry = {
                "metric_id": mid,
                "label": meta.get(mid, {}).get("label", mid),
                "category": meta.get(mid, {}).get("category"),
                "unit": meta.get(mid, {}).get("unit"),
                "better_when": meta.get(mid, {}).get("direction", "higher"),
                "description": meta.get(mid, {}).get("description"),
                "source": meta.get(mid, {}).get("source"),
                "rank": position,
                "of": len(rows),
                "score": round(score, 1),
                "value": matrix[ward][mid].get("v"),
                "within_two_points": sum(1 for s in all_scores if abs(s - score) <= 2.0),
                "middle_half_spread": round(quartiles[2] - quartiles[0], 1),
            }
            entry["caveats"] = caveats_for(entry, meta, coverage)
            ranked.append(entry)

        ranked.sort(key=lambda e: e["rank"])
        overall = scores.get(ward, {})

        # A real photograph of a real landmark, from the API, already credited.
        # Three of the fifty carry no credit or licence, and those are left out
        # rather than published with unknown rights.
        sig = ward_row.get("visual_signifier") or {}
        photo = None
        if sig.get("image_url") and sig.get("image_credit"):
            photo = {
                "url": sig["image_url"],          # same-origin via the /api proxy
                "alt": sig.get("alt") or sig.get("name") or "",
                "caption": sig.get("name"),
                "kind": sig.get("kind"),
                "credit": sig.get("image_credit"),
                "license": sig.get("image_license"),
                "learn_more": sig.get("wikipedia_url") or sig.get("wikidata_url"),
            }

        out["wards"][ward] = {
            "ward_id": ward,
            "ward_number": int(ward),
            "display_name": ward_row.get("display_name"),
            "alderperson": {
                "name": tidy_name(alder.get("name")),
                "title": alder.get("title"),
                "photo_url": alder.get("photo_url"),
                # Present for 27 of 50. The rest are filled in by research and
                # must be verified before they are published.
                "website_url": alder.get("website_url"),
                "website_verified": bool(alder.get("website_url")),
            },
            "overall": {"rank": overall.get("rank"), "score": overall.get("score"), "of": 50},
            "photo": photo,
            "communities": [
                c.get("name")
                for c in sorted(
                    ward_row.get("community_area_overlaps") or [],
                    key=lambda c: -(c.get("ward_area_pct") or 0),
                )[:4]
            ],
            "ranked_count": len(ranked),
            "caveated_count": sum(1 for e in ranked if e["caveats"]),
            "strengths": ranked[:6],
            "weaknesses": list(reversed(ranked[-6:])),
        }

    return out


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ward", help="print one ward instead of writing the file")
    args = parser.parse_args()

    data = build()

    if args.ward:
        ward = data["wards"].get(args.ward.zfill(2))
        if not ward:
            print(f"no ward {args.ward}", file=sys.stderr)
            return 1
        print(json.dumps(ward, indent=2))
        return 0

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n")

    missing = [w for w, v in data["wards"].items() if not v["alderperson"]["website_url"]]
    caveated = sum(v["caveated_count"] for v in data["wards"].values())
    ranked = sum(v["ranked_count"] for v in data["wards"].values())
    print(f"wrote {OUT.relative_to(Path(__file__).parent)}")
    print(f"  50 wards, {ranked} ward-measure rankings, {caveated} carrying a caveat")
    print(f"  {len(missing)} wards still need a verified alderman website: {', '.join(missing)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
