#!/usr/bin/env python3
"""Render every page of the Flask app into plain HTML for Netlify.

Netlify serves static files, so the pages are rendered once, here, and the output in site/ is
committed. The browser does the rest: every number on every page is fetched live through the
proxies in site/_redirects, which Netlify runs at its edge the way server.py runs them locally.

    python3 freeze.py

Run it after changing a template or anything in static/, then commit site/.
"""

from __future__ import annotations

import shutil
from pathlib import Path

from server import app

HERE = Path(__file__).parent.resolve()
OUT = HERE / "site"

# URL -> file. Netlify serves these through the rewrites below, so the addresses stay the same
# as the Flask app's (/map, not /map.html).
PAGES = {
    "/": "index.html",
    "/map": "map.html",
    "/for/residents": "for/residents.html",
    "/for/planning": "for/planning.html",
    "/for/business": "for/business.html",
    "/guild": "guild.html",
    "/guild/join": "guild/join.html",
    "/alerts": "alerts.html",
    "/dictionary": "dictionary.html",
    "/about": "about.html",
}

REDIRECTS = """# Written by freeze.py. Netlify reads this top to bottom and stops at the first match.

# Live data, same origin, so the browser needs no CORS and no key (server.py does this locally).
/api/*    https://penlight.wardwise.org/api/:splat                200
/clerk/*  https://api.chicityclerkelms.chicago.gov/:splat         200
/geocode  /.netlify/functions/geocode                             200

# Old addresses
/support  /about       301
/metrics  /dictionary  301

# Pages
{pages}
"""


def main() -> None:
    if OUT.exists():
        shutil.rmtree(OUT)
    OUT.mkdir()
    client = app.test_client()

    for url, name in PAGES.items():
        response = client.get(url)
        if response.status_code != 200:
            raise SystemExit(f"{url} returned {response.status_code}")
        target = OUT / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(response.data)

    # Netlify shows 404.html for any address it can't match.
    missing = client.get("/this-page-does-not-exist")
    (OUT / "404.html").write_bytes(missing.data)

    shutil.copytree(HERE / "static", OUT / "static")
    shutil.copy(HERE / "static" / "favicon.ico", OUT / "favicon.ico")

    rewrites = "\n".join(
        f"{url:<16}  /{name}  200" for url, name in PAGES.items() if url != "/"
    )
    (OUT / "_redirects").write_text(REDIRECTS.format(pages=rewrites))
    print(f"Wrote {len(PAGES)} pages, 404.html, static/ and _redirects to {OUT.relative_to(HERE)}/")


if __name__ == "__main__":
    main()
