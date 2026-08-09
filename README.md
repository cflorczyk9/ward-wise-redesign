# Ward Wise Reports

An independent Chicago civic-data site built against the public
[Ward Wise Penlight](https://penlight.wardwise.org) API. Four pages, no build
step at runtime, no backend.

| Page | What it is |
|---|---|
| `index.html` | **Explore.** The sequenced explorer: address search, ward map, preset metric lists. |
| `reports.html` | **Reports.** What actually changed in a ward, and which way. |
| `dictionary.html` | Every measure, its source, and how it is scored. |
| `support.html` | How residents contribute. Links out to the live Penlight site. |

Penlight answers "how does my ward score right now". This answers the question the
same API can already support and the map cannot show: **what actually moved, and
which way**. Pick a ward and a window, get every measure that changed, ranked by how
far it moved, split into the ones that got better and the ones that got worse.

Independent front end. The data, the pipeline, and the API are Harry Brisson's
[Chi Hack Night](https://chihacknight.org/) project.

## Run it

```bash
python3 dev.py
```

Then open <http://localhost:1838>. Standard library only. No venv, no pip install,
no npm, no bundler.

## Where the explorer came from

The explorer, dictionary, and support pages started as a Flask app, because
Harry's repo is one. They are rendered to static HTML once by `build_static.py`
and the output is committed. Re-run it after pulling template changes:

```bash
python3 build_static.py ../ward-wise-frontend
```

Static JS and CSS are copied across separately, not rendered.

## No backend

Upstream geocodes server-side through three Flask routes. This site does it in
the browser instead (`static/geocode.js`), because both geocoders send
permissive CORS headers, checked live:

| Geocoder | Allow-Origin | Role |
|---|---|---|
| `gisapps.chicago.gov` | the calling origin | authoritative for Chicago addresses, used first |
| `nominatim.openstreetmap.org` | `*` | fallback for neighborhoods and landmarks |

The return shapes match what the Flask routes returned, so the explorer's three
call sites changed by one word each.

One caveat worth knowing. Upstream proxied Nominatim partly to send a
descriptive User-Agent, which a browser will not let a page set. Chicago's own
locator answers nearly every real address, so Nominatim is rarely reached. If it
ever draws rate limiting, drop the fallback rather than adding a server back.

## Why there is a proxy

The Penlight API is public and needs no key, but it sends no
`Access-Control-Allow-Origin` header, so a browser will not let a page on another
domain call it directly. Both environments keep every request same-origin instead:

| Environment | Mechanism |
|---|---|
| Local | `dev.py` forwards `/api/*` upstream |
| Netlify | the one line in `_redirects` does the same |

If Harry ever adds a CORS header for this domain, both can go away and the site
becomes pure static files.

## What the report is built on

Three requests total.

| Call | What it gives |
|---|---|
| `/api/metrics` | the dictionary: label, category, unit, source, and which direction counts as better |
| `/api/wards` | ward numbers and alderperson names |
| `/api/metrics/timeseries?area_type=ward&area_id=NN` | every dated observation for that ward, about 350 KB |

That third call is the whole thing. Passing no `metric_id` returns all 183 series
at once rather than one request per metric.

### How much history is actually there

Measured against the live API on 2026-08-09, for Ward 42:

- 182 distinct metrics carry at least one dated observation
- **79 of them have two or more distinct years**, which is what this report can rank
- the rest hold a single reading, so there is no change to report on them yet
- dated observations span 1971 to 2026, and the dense part is roughly the last 15 years
- poverty rate, as one example, runs 2009 through 2023 without a gap

The report says out loud how many metrics it left out and why, rather than quietly
showing a short list.

### Reading a change honestly

A few decisions that are easy to get wrong and are worth knowing about.

- **Direction matters.** The dictionary marks each metric `higher` or `lower` for
  which way is good. Crime falling and broadband rising are both improvements, and
  they sort into the same column.
- **Anchors, not exact years.** Metrics sit on different reporting calendars, so
  each one anchors to its first and last observation inside the window rather than
  demanding an exact year match. A metric is skipped if both anchors land on the
  same year.
- **One value per year.** Pipeline re-runs can emit the same year more than once.
  The newest snapshot for a year wins.
- **No dividing by zero.** Percent change off a near-zero base is meaningless, so
  those fall back to showing raw movement.

## Staying current with the API

The API is someone else's, carries no version number, and publishes no schema.
Nothing will announce a breaking change. The failure mode is quiet: a renamed
field empties a column and the page still looks fine.

So run the contract check instead of trusting it.

```bash
python3 check_api.py            # compare against api-baseline.json
python3 check_api.py --update   # accept what is live now as the new baseline
python3 check_api.py --json     # for CI
```

It covers **13 endpoints across both surfaces** (3 the reports view reads, 10 the
explorer reads) plus **both geocoders**, checking those still answer *and* still
send a CORS header. The geocoders became load-bearing when the address lookup
moved into the browser, since there is no server-side fallback left to catch them.

Exit 0 clean, 1 drift, 2 unreachable. Two kinds of finding:

- **Broken** means a field this site actually reads is gone. `direction` vanishing
  would put improvements in the wrong column. `period_end` vanishing would empty
  the whole report. It also checks that the no-`metric_id` timeseries call still
  returns every series, since the entire page is built on that one request.
- **Drift** is softer. New metrics, removed metrics, a changed ward count, a new
  category. Worth reading, usually fine.

Run it before deploying, and on a schedule if the site is public. `api-baseline.json`
is committed, so a drift report is a real diff against a known-good state rather
than a fresh guess.

Two things worth watching by hand as well. The pipeline repo behind the API is
private, so the public
[ward-wise-frontend](https://github.com/HarryBrisson/ward-wise-frontend) repo is
the closest thing to a reference client. Its `static/common.js` is where the API
calls live, so a change there usually means a change upstream. Watching that repo
is the cheapest early warning available.

## Files

```
index.html         Explore  (rendered from upstream k3.html)
reports.html       Reports  (this project's own page)
dictionary.html    Dictionary (rendered)
support.html       Support    (rendered)
static/reports.js  the report: fetch, change math, sparklines, render
static/reports.css the report's styles; palette inherited from k3-shell.css
static/geocode.js  browser-side address lookup, replaces the Flask routes
static/k3*.js/css  the explorer, from upstream
static/styles.css  upstream's base stylesheet
build_static.py    renders upstream Jinja templates to static HTML
dev.py             static server + /api proxy, stdlib only
check_api.py       contract check across both surfaces
api-baseline.json  last known-good API fingerprint
_redirects         the Netlify version of the /api proxy
```

## Status

All four pages work against live data. The explorer's address search, ward map,
and preset lists work with no backend. The reports view ranks change with
direction awareness, category filters, a year window, and per-metric detail.

Reads retry twice on a transient failure (502, 503, 429, or a dropped
connection) before giving up, and fail immediately on a 404 or 400. A single
upstream blip was otherwise enough to leave the page dead.

Not yet built: ward-versus-city comparison (`/api/metrics/delta` already returns
`delta_vs_city`), neighborhood and χGRID area types, a shareable permalink per
ward, and a deploy.
