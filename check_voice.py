#!/usr/bin/env python3
"""Check every ward write-up against the hard voice rules.

The agents were told to load the humanizer. This verifies they did, on the
rules that can be checked deterministically. Judgment calls (does it sound
generic, does it have a pulse) stay with the review pass; this catches the
mechanical violations that should never survive a draft.

    python3 check_voice.py            # report
    python3 check_voice.py --strict   # exit 1 if anything is flagged

Standard library only.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

WRITEUPS = Path(__file__).parent / "data" / "writeups"
FIELDS = ("headline", "summary", "reading_the_rankings")

# Hard bans. The voice memory overrides the general catalog on all of these.
HARD = [
    ("em dash", re.compile(r"[—–]")),
    ("semicolon", re.compile(r";")),
    # A colon used to introduce prose, as opposed to one inside a time or ratio.
    ("prose colon", re.compile(r"[a-z]\s*:\s+[A-Za-z]")),
    ("contrastive fragment", re.compile(r"\.\s+Not\s+[a-z]", re.I)),
    # Only the rhetorical construction, not ordinary contrast. "from a survey,
    # not a model, but it still reaches the ward" is plain English; "not just a
    # ranking but a verdict" is the banned emphasis move.
    ("not just X but Y", re.compile(r"\bnot\s+(?:just|only|merely|simply)\b[^.]{0,50}\bbut\b", re.I)),
    ("it is not X it is Y", re.compile(r"\b(?:it'?s|it is|this is|that'?s)\s+not\s+[^.,]{2,40},\s*(?:it'?s|it is|this is)\b", re.I)),
]

# AI tells from the catalog that show up most in generated civic prose.
SOFT = [
    ("inflated significance", re.compile(
        r"\b(stands as|serves as|is a testament|testament to|pivotal|underscor\w+|"
        r"highlight\w+ the importance|speaks to the broader|reflects a broader|"
        r"a reminder (?:of|that)|marks a turning point)\b", re.I)),
    ("AI vocabulary", re.compile(
        r"\b(delve|tapestry|landscape of|realm of|navigate the|robust|seamless|"
        r"vibrant|nestled|bustling|rich (?:history|tapestry)|myriad|showcase)\b", re.I)),
    ("signposting", re.compile(r"\b(it'?s worth noting|it is worth noting|importantly|"
                               r"notably|furthermore|moreover|additionally)\b", re.I)),
    ("hedge stack", re.compile(r"\b(?:may|might|could)\s+potentially\b|"
                               r"\bsomewhat\s+of\s+a\b|\bit could be argued\b", re.I)),
    ("upbeat closer", re.compile(
        r"\b(remains to be seen|time will tell|only time|bright future|"
        r"continues to (?:evolve|grow|thrive))\b", re.I)),
]


def check(text: str, patterns) -> list[tuple[str, str]]:
    hits = []
    for name, rx in patterns:
        for m in rx.finditer(text or ""):
            start = max(0, m.start() - 34)
            snippet = re.sub(r"\s+", " ", (text[start:m.end() + 34])).strip()
            hits.append((name, snippet))
    return hits


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--strict", action="store_true")
    args = parser.parse_args()

    files = sorted(WRITEUPS.glob("*.json")) if WRITEUPS.exists() else []
    if not files:
        print("no write-ups yet")
        return 0

    hard_total = soft_total = 0
    flagged_wards = []

    for path in files:
        try:
            entry = json.loads(path.read_text())
        except Exception as err:
            print(f"{path.name}: unreadable ({err})")
            flagged_wards.append(path.stem)
            continue

        blob = "\n\n".join(str(entry.get(f) or "") for f in FIELDS)
        hard = check(blob, HARD)
        soft = check(blob, SOFT)
        if not hard and not soft:
            continue

        flagged_wards.append(path.stem)
        hard_total += len(hard)
        soft_total += len(soft)
        print(f"\nward {path.stem}")
        for name, snippet in hard:
            print(f"  HARD  {name}: …{snippet}…")
        for name, snippet in soft:
            print(f"  soft  {name}: …{snippet}…")

    print(f"\n{len(files)} write-ups checked")
    print(f"  {hard_total} hard violations (banned outright)")
    print(f"  {soft_total} soft flags (AI tells worth a rewrite)")
    print(f"  {len(files) - len(flagged_wards)} clean")

    if args.strict and (hard_total or soft_total):
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
