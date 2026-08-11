#!/usr/bin/env python3
"""Render the explorer's Jinja templates into plain static HTML.

The explorer was written as a Flask app, because Harry's repo is one. This site
is static, so the templates get rendered once, here, and the output is
committed. Run this again after pulling template changes from upstream.

    python3 build_static.py ../path/to/ward-wise-frontend

The Jinja in these templates is mechanical: extends, a few blocks, one include,
url_for, and live_url. That is small enough to resolve directly and avoids
adding Jinja and Flask as dependencies to a site that otherwise has none.

Standard library only.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

HERE = Path(__file__).parent.resolve()
SITE_BASE = "https://penlight.wardwise.org"

# Flask endpoint name -> the static file it becomes here. The explorer takes
# the front door, since it is the richer surface; the reports view is its own
# page rather than the landing.
ROUTES = {
    "index": "index.html",
    "dictionary": "dictionary.html",
    "about": "support.html",
}

# template file -> (output file, endpoint name for the active-nav highlight)
PAGES = {
    "k3.html": ("index.html", "index"),
    "dictionary.html": ("dictionary.html", "dictionary"),
    "about.html": ("support.html", "about"),
}

# Nav as it should read on this site. Upstream has three entries; Reports is
# the one this project adds, so it is appended rather than replacing anything.
NAV = [
    ("index.html", "index", "Explore"),
    ("reports.html", "reports", "Reports"),
    ("report.html", "report", "Quarterly"),
    ("menu.html", "menu", "Menu money"),
    ("dictionary.html", "dictionary", "Dictionary"),
    ("support.html", "about", "Support"),
]

BLOCK = re.compile(r"{%\s*block\s+(\w+)\s*%}(.*?){%\s*endblock\s*%}", re.S)
INCLUDE = re.compile(r"""{%\s*include\s+["']([^"']+)["']\s*%}""")
URL_STATIC = re.compile(
    r"""{{\s*url_for\(\s*['"]static['"]\s*,\s*filename=['"]([^'"]+)['"][^}]*\)\s*}}"""
)
URL_ENDPOINT = re.compile(r"""{{\s*url_for\(\s*['"](\w+)['"]\s*\)\s*}}""")
LIVE_URL = re.compile(r"""{{\s*live_url\(\s*['"]([^'"]+)['"]\s*\)\s*}}""")
COMMENT = re.compile(r"{#.*?#}", re.S)


def blocks_of(text: str) -> dict[str, str]:
    return {name: body for name, body in BLOCK.findall(text)}


def render_nav(active: str) -> str:
    links = []
    for href, endpoint, label in NAV:
        css = "nav-link is-active" if endpoint == active else "nav-link"
        links.append(f'<a class="{css}" href="{href}">{label}</a>')
    return "\n        ".join(links)


def resolve(text: str, templates: Path, active: str) -> str:
    text = COMMENT.sub("", text)

    def include(match: re.Match) -> str:
        return (templates / match.group(1)).read_text()

    text = INCLUDE.sub(include, text)
    text = URL_STATIC.sub(lambda m: f"static/{m.group(1)}", text)
    text = URL_ENDPOINT.sub(lambda m: ROUTES.get(m.group(1), m.group(1) + ".html"), text)
    text = LIVE_URL.sub(lambda m: SITE_BASE + m.group(1), text)
    text = text.replace("{{ request.endpoint }}", active)
    return text


def build(upstream: Path) -> list[str]:
    templates = upstream / "templates"
    if not templates.is_dir():
        raise SystemExit(f"no templates/ directory under {upstream}")

    base_raw = (templates / "base.html").read_text()
    written = []

    for template_name, (out_name, active) in PAGES.items():
        source = templates / template_name
        if not source.exists():
            print(f"  skip {template_name} (not in upstream)")
            continue

        child = blocks_of(source.read_text())
        page = base_raw

        # Fill each block base.html declares with the child's version, or with
        # the base default when the child does not override it.
        def fill(match: re.Match) -> str:
            name, default = match.group(1), match.group(2)
            return child.get(name, default)

        page = BLOCK.sub(fill, page)
        page = resolve(page, templates, active)

        # Swap upstream's three-link nav for this site's four.
        page = re.sub(
            r'(<nav class="site-nav"[^>]*>)(.*?)(</nav>)',
            lambda m: m.group(1) + "\n        " + render_nav(active) + "\n      " + m.group(3),
            page,
            flags=re.S,
        )

        leftover = re.findall(r"{%.*?%}|{{.*?}}", page)
        if leftover:
            print(f"  WARNING unresolved template syntax in {out_name}: {leftover[:3]}")

        (HERE / out_name).write_text(page)
        written.append(out_name)
        print(f"  wrote {out_name} ({len(page):,} bytes)")

    return written


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    upstream = Path(sys.argv[1]).expanduser().resolve()
    print(f"rendering from {upstream}")
    build(upstream)
    print("\nNote: static/*.js and static/*.css are copied separately, not rendered.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
