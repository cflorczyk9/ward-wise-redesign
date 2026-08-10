#!/usr/bin/env python3
"""Compile the quarterly report from ward facts plus the research write-ups.

`build_ward_data.py` produces the numbers. Research agents produce one
write-up JSON per ward. This joins them into the single file the page loads,
and refuses to pass through anything it cannot stand behind.

    python3 build_report.py
    python3 build_report.py --strict   # fail if any ward is missing a write-up

What it drops, loudly:
  - a news item whose URL was not in the agent's own fetched list
  - an alderperson website that was not marked verified
  - a write-up for a ward that does not exist

Standard library only.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

HERE = Path(__file__).parent
WARDS = HERE / "data" / "wards.json"
WRITEUPS = HERE / "data" / "writeups"
OUT = HERE / "data" / "report.json"

QUARTER = "Q3 2026"
WINDOW = ("2026-05-11", "2026-08-09")
ALLOWED_OUTLETS = re.compile(
    r"blockclubchicago\.org|chicago\.suntimes\.com|suntimes\.com|chicagotribune\.com|"
    r"chicagobusiness\.com|wttw\.com|news\.wttw\.com|chicago\.gov|cityofchicago\.org|"
    r"chicityclerk\.com|chicago\.councilmatic\.org|illinoispolicy\.org|"
    r"axios\.com/local/chicago",
    re.I,
)


def load_writeup(path: Path) -> dict | None:
    try:
        return json.loads(path.read_text())
    except Exception as err:                       # malformed agent output
        print(f"  ! {path.name} is not valid JSON ({err}), skipped")
        return None


def host_of(url: str) -> str:
    return re.sub(r"^https?://(www\.)?", "", url or "").split("/")[0].lower()


def clean_news(entry: dict, ward: str, problems: list[str], own_site: str | None = None) -> list[dict]:
    """Keep only items the agent actually fetched from an expected outlet.

    A ward office's own site counts as a primary source for that ward, and only
    for that ward. It is self-published rather than reported, so the outlet name
    should make that obvious to a reader.
    """
    fetched = {u.strip() for u in entry.get("sources_fetched", []) if isinstance(u, str)}
    own_host = host_of(own_site) if own_site else None
    kept = []
    for item in entry.get("news") or []:
        url = (item.get("url") or "").strip()
        if not url:
            problems.append(f"ward {ward}: news item with no URL dropped")
            continue
        if url not in fetched:
            problems.append(f"ward {ward}: '{(item.get('headline') or '')[:44]}' cited but never fetched, dropped")
            continue
        if not ALLOWED_OUTLETS.search(url) and not (own_host and host_of(url) == own_host):
            problems.append(f"ward {ward}: {url[:52]} is off the agreed outlet list, dropped")
            continue
        date = (item.get("date") or "")[:10]
        if date and not (WINDOW[0] <= date <= WINDOW[1]):
            problems.append(f"ward {ward}: item dated {date} is outside the window, dropped")
            continue
        kept.append({
            "headline": item.get("headline"),
            "outlet": item.get("outlet"),
            "url": url,
            "date": date or None,
            "note": item.get("note"),
        })
    return kept[:4]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--strict", action="store_true")
    args = parser.parse_args()

    if not WARDS.exists():
        print("run build_ward_data.py first", file=sys.stderr)
        return 2

    wards = json.loads(WARDS.read_text())["wards"]
    problems: list[str] = []
    report = {
        "quarter": QUARTER,
        "window": {"from": WINDOW[0], "to": WINDOW[1]},
        "wards": {},
    }

    missing, with_news, verified_sites = [], 0, 0

    for ward_id in sorted(wards):
        facts = wards[ward_id]
        path = WRITEUPS / f"{ward_id}.json"
        entry = load_writeup(path) if path.exists() else None

        if entry is None:
            missing.append(ward_id)
            report["wards"][ward_id] = {**facts, "writeup": None, "news": [], "news_status": "not_researched"}
            continue

        supplied_site = ((entry.get("alderperson") or {}).get("website_url") or "").strip()
        news = clean_news(entry, ward_id, problems,
                          own_site=facts["alderperson"].get("website_url") or supplied_site)
        if news:
            with_news += 1

        alder = dict(facts["alderperson"])
        supplied = (entry.get("alderperson") or {})
        url = (supplied.get("website_url") or "").strip()
        if url and not alder.get("website_url"):
            if supplied.get("verified") is True:
                alder["website_url"] = url
                alder["website_verified"] = True
                alder["verification_note"] = supplied.get("verification_note")
            else:
                problems.append(f"ward {ward_id}: unverified alderperson URL withheld ({url[:44]})")
        if alder.get("website_url"):
            verified_sites += 1

        report["wards"][ward_id] = {
            **facts,
            "alderperson": alder,
            "writeup": {
                "headline": entry.get("headline"),
                "summary": entry.get("summary"),
                "reading_the_rankings": entry.get("reading_the_rankings"),
            },
            "news": news,
            "news_status": "found" if news else "none_found",
        }

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")

    print(f"wrote {OUT.relative_to(HERE)}  ({QUARTER}, {WINDOW[0]} to {WINDOW[1]})")
    print(f"  {50 - len(missing)}/50 wards have a write-up")
    print(f"  {with_news}/50 wards have at least one verified news item")
    print(f"  {verified_sites}/50 wards link to a verified alderperson site")
    if missing:
        print(f"  missing write-ups: {', '.join(missing)}")
    if problems:
        print(f"\n  {len(problems)} item(s) dropped in verification:")
        for p in problems[:20]:
            print(f"    - {p}")
        if len(problems) > 20:
            print(f"    ... and {len(problems) - 20} more")

    if args.strict and missing:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
