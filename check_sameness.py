#!/usr/bin/env python3
"""Detect templating across the ward write-ups.

Twenty-five agents wrote two wards each from one brief. The failure that
produces is fifty pieces with the same skeleton and different nouns, which
reads fine one ward at a time and unbearable end to end.

This measures how much structure the write-ups share, in two ways:

  - repeated phrases: any 6-word sequence appearing in several wards
  - opening shapes: how many summaries begin the same way

    python3 check_sameness.py
    python3 check_sameness.py --strict   # exit 1 if templating looks heavy

Standard library only.
"""

from __future__ import annotations

import argparse
import collections
import json
import re
import sys
from pathlib import Path

WRITEUPS = Path(__file__).parent / "data" / "writeups"
NGRAM = 6
REPEAT_LIMIT = 4       # a 6-word run in this many wards is a template, not a coincidence


def words(text: str) -> list[str]:
    return re.findall(r"[a-z0-9']+", (text or "").lower())


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--strict", action="store_true")
    args = parser.parse_args()

    files = sorted(WRITEUPS.glob("*.json"))
    if len(files) < 3:
        print("not enough write-ups to compare yet")
        return 0

    entries = {}
    for path in files:
        try:
            entries[path.stem] = json.loads(path.read_text())
        except Exception:
            continue

    # ---- repeated 6-word runs -------------------------------------------
    where = collections.defaultdict(set)
    for ward, entry in entries.items():
        blob = " ".join(str(entry.get(f) or "") for f in ("headline", "summary", "reading_the_rankings"))
        tokens = words(blob)
        for i in range(len(tokens) - NGRAM + 1):
            where[" ".join(tokens[i:i + NGRAM])].add(ward)

    repeated = sorted(
        ((phrase, wards) for phrase, wards in where.items() if len(wards) >= REPEAT_LIMIT),
        key=lambda r: -len(r[1]),
    )

    print(f"{len(entries)} write-ups compared\n")
    if repeated:
        print(f"repeated phrasing ({len(repeated)} runs of {NGRAM}+ words in {REPEAT_LIMIT}+ wards):")
        for phrase, wards in repeated[:12]:
            print(f"  {len(wards):2} wards  \"{phrase}\"")
            print(f"           {', '.join(sorted(wards)[:12])}")
    else:
        print(f"repeated phrasing: none. No {NGRAM}-word run appears in {REPEAT_LIMIT}+ wards.")

    # ---- opening shapes --------------------------------------------------
    openings = collections.Counter()
    for ward, entry in entries.items():
        first = " ".join(words(str(entry.get("summary") or ""))[:4])
        if first:
            openings[first] += 1
    dupes = [(o, n) for o, n in openings.most_common() if n > 1]

    print()
    if dupes:
        print("summaries starting the same way:")
        for opening, n in dupes[:8]:
            print(f"  {n} wards begin \"{opening}…\"")
    else:
        print("opening shapes: all distinct in the first four words.")

    # ---- headline shapes -------------------------------------------------
    head_shapes = collections.Counter()
    for entry in entries.values():
        h = str(entry.get("headline") or "")
        shape = re.sub(r"\d+", "#", " ".join(words(h)[:5]))
        if shape:
            head_shapes[shape] += 1
    head_dupes = [(s, n) for s, n in head_shapes.most_common() if n > 2]

    print()
    if head_dupes:
        print("headlines sharing an opening shape:")
        for shape, n in head_dupes[:6]:
            print(f"  {n} headlines start \"{shape}…\"")
    else:
        print("headline shapes: no opening pattern used by more than two wards.")

    heavy = len(repeated) > 8 or any(n > len(entries) * 0.3 for _, n in dupes)
    print(f"\nverdict: {'TEMPLATED, worth a rewrite pass' if heavy else 'varied enough'}")

    if args.strict and heavy:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
