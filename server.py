"""Ward Wise Penlight — frontend shell.

This app renders the three views and nothing else. Every byte of data comes from the
Penlight API, which lives in another repo and is reached through the `/api/*` proxy
below. Proxying (rather than calling the API cross-origin from the browser) keeps every
request same-origin, so there is no CORS to configure and no API key to hand out.

Environment:
  PENLIGHT_API_BASE   where /api/* is forwarded   (default: https://penlight.wardwise.org)
  PENLIGHT_SITE_BASE  where out-of-scope links go (default: https://penlight.wardwise.org)
  PROXY_ALLOW_WRITES  1 to forward POSTs upstream (default: 0, stubbed — see proxy())
  PORT                default 1837, the year Chicago was incorporated
"""

from __future__ import annotations

import csv
import io
import os
from pathlib import Path

import requests
from flask import Flask, Response, jsonify, redirect, render_template, request, url_for

API_BASE = os.environ.get("PENLIGHT_API_BASE", "https://penlight.wardwise.org").rstrip("/")
SITE_BASE = os.environ.get("PENLIGHT_SITE_BASE", "https://penlight.wardwise.org").rstrip("/")
ALLOW_WRITES = os.environ.get("PROXY_ALLOW_WRITES", "0") == "1"

# Headers that describe the *hop*, not the payload — forwarding them would corrupt the
# response (a re-chunked body carrying the upstream's Content-Length, say).
HOP_BY_HOP = {"content-encoding", "content-length", "transfer-encoding", "connection"}

app = Flask(__name__)

STATIC_DIR = Path(app.static_folder)

# Cache-bust static assets: one version per change = newest mtime among css/js, so editing
# any stylesheet or script forces a refetch. Templates pass `v=asset_version`.
ASSET_VERSION = int(max(
    (path.stat().st_mtime for path in STATIC_DIR.rglob("*") if path.suffix in (".css", ".js")),
    default=0,
))


@app.context_processor
def inject_globals():
    return {
        "asset_version": ASSET_VERSION,
        # Features that stayed behind in the monorepo — nominate a metric, submit a photo,
        # the reports page, the API docs. They link out to the live site rather than 404.
        "live_url": lambda path: f"{SITE_BASE}{path}",
    }


# --- Views -------------------------------------------------------------------

@app.get("/")
def home():
    return render_template("home.html")


@app.get("/map")
def explore():
    return render_template("explorer.html")


# --- Proposal: audience pages and the Guild -----------------------------------
# Everything below is a clickable proposal. The join and signup forms confirm in the
# browser and send nothing, because there is no members table or mailing list yet.

@app.get("/for/residents")
def residents():
    return render_template("residents.html")


@app.get("/for/planning")
def planning():
    return render_template("planning.html")


@app.get("/for/business")
def business():
    return render_template("business.html")


@app.get("/guild")
def guild():
    return render_template("guild.html")


@app.get("/guild/join")
def guild_join():
    return render_template("guild_join.html")


@app.get("/alerts")
def alerts():
    return render_template("alerts.html")


# The City Clerk's legislation API (eLMS) sends no CORS headers, so the browser can't read it
# directly. Same idea as the /api proxy: forward GETs, stream bytes, shape nothing. The city's
# data portal (Socrata) allows cross-origin reads, so frontdoor.js calls it directly.
CLERK_API = "https://api.chicityclerkelms.chicago.gov"


@app.get("/clerk/<path:clerk_path>")
def clerk_proxy(clerk_path: str):
    try:
        response = requests.get(f"{CLERK_API}/{clerk_path}", params=request.args, timeout=30)
    except requests.RequestException as error:
        return jsonify({"error": f"Clerk request failed: {error}"}), 502
    headers = [
        (key, value)
        for key, value in response.headers.items()
        if key.lower() not in HOP_BY_HOP
    ]
    return Response(response.content, status=response.status_code, headers=headers)


# Zoning filings name a street address and nothing else, so the alerts preview needs a map point
# to place each one in a ward. The Census Bureau geocodes addresses for free, with no key, and
# takes up to 10,000 in one request. It sends no CORS headers either, so it goes through here.
# Addresses don't move, so answers are kept for the life of the process.
CENSUS_BATCH = "https://geocoding.geo.census.gov/geocoder/locations/addressbatch"
_geocoded: dict[str, list[float] | None] = {}


@app.post("/geocode")
def geocode():
    addresses = [str(a).strip() for a in (request.get_json(silent=True) or {}).get("addresses", []) if str(a).strip()]
    addresses = list(dict.fromkeys(addresses))[:500]
    todo = [a for a in addresses if a not in _geocoded]
    if todo:
        rows = "\n".join(f'{i},"{a.replace(chr(34), "")}",Chicago,IL,' for i, a in enumerate(todo))
        try:
            response = requests.post(
                CENSUS_BATCH,
                files={"addressFile": ("batch.csv", rows + "\n", "text/csv")},
                data={"benchmark": "Public_AR_Current"},
                timeout=60,
            )
            response.raise_for_status()
        except requests.RequestException as error:
            return jsonify({"error": f"Geocoding failed: {error}"}), 502
        for line in csv.reader(io.StringIO(response.text)):
            if len(line) < 6 or not line[0].isdigit() or int(line[0]) >= len(todo):
                continue
            point = None
            if line[2] == "Match" and "," in line[5]:
                lon, lat = line[5].split(",")
                point = [float(lon), float(lat)]
            _geocoded[todo[int(line[0])]] = point
    return jsonify({a: _geocoded.get(a) for a in addresses})


@app.get("/dictionary")
def dictionary():
    return render_template("dictionary.html")


@app.get("/favicon.ico")
def favicon():
    # Browsers ask for /favicon.ico on their own, whatever the page links.
    return app.send_static_file("favicon.ico")


@app.get("/metrics")
def metrics_redirect():
    # Upstream 301s /metrics to the page carrying the dictionary; keep the habit.
    return redirect(url_for("dictionary"), 301)


@app.get("/about")
def about():
    return render_template("about.html")


@app.get("/support")
def support_redirect():
    # The live site calls this page "Support Penlight". Old links keep working and land on About.
    return redirect(url_for("about"), 301)


# --- Errors --------------------------------------------------------------------
# A mistyped address gets a page in the site's own design instead of Flask's plain default.

@app.errorhandler(404)
def not_found(_error):
    return render_template(
        "error.html",
        code="404",
        heading="This page isn't here.",
        message="The address may be mistyped, or the page may have moved. Everything on Ward Wise starts from the home page or the map.",
    ), 404


@app.errorhandler(500)
def server_error(_error):
    return render_template(
        "error.html",
        code="500",
        heading="Something went wrong.",
        message="The page hit an error on our side. Try again in a minute.",
    ), 500


# --- API proxy ---------------------------------------------------------------

@app.route("/api/<path:api_path>", methods=["GET", "POST"])
def proxy(api_path: str):
    """Forward to the Penlight API, streaming bytes through untouched.

    Bytes, not JSON: /api/civic-assets/... serves the signifier JPEGs that the map view
    and Support page render, so the proxy has to stay content-type agnostic.
    """
    if request.method == "POST" and not ALLOW_WRITES:
        # The map view POSTs an analytics event on every metric toggle. Clicking around
        # locally shouldn't write rows into production, so acknowledge without forwarding.
        return jsonify({"ok": True, "stubbed": True})

    upstream = f"{API_BASE}/api/{api_path}"
    try:
        response = requests.request(
            request.method,
            upstream,
            params=request.args,
            data=request.get_data(),
            headers={"Content-Type": request.content_type} if request.content_type else {},
            timeout=30,
        )
    except requests.RequestException as error:
        return jsonify({"error": f"Upstream request failed: {error}"}), 502

    headers = [
        (key, value)
        for key, value in response.headers.items()
        if key.lower() not in HOP_BY_HOP
    ]
    return Response(response.content, status=response.status_code, headers=headers)


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 1837)), debug=True)
