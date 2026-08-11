# Ward Wise Redesign

An independent Chicago civic-data site built on the public
[Ward Wise Penlight](https://penlight.wardwise.org) API. Six pages, no build
step at runtime, no backend, no framework.

**Credit where it belongs.** The data, the collection pipeline, the API, and
the explorer's design are [Harry Brisson](https://github.com/HarryBrisson)'s
work through his [Chi Hack Night](https://chihacknight.org/) project. The
explorer, dictionary, and support pages here are rendered from the templates in
his [ward-wise-frontend](https://github.com/HarryBrisson/ward-wise-frontend)
repo. His [chicago-participatory-urbanism](https://github.com/HarryBrisson/chicago-participatory-urbanism)
repo is the companion analysis behind the menu money page's subject. This repo
adds an independent reporting layer on top of that foundation and would be an
empty shell without it.

| Page | What it is |
|---|---|
| `index.html` | **Explore.** The explorer, rendered from upstream. Address search, ward map, preset metric lists. |
| `report.html` | **Quarterly.** An index of all fifty wards. Each opens as its own article, with a researched write-up, verified local news, a photograph, and a reader-weighted re-ranking panel. |
| `reports.html` | **Reports.** Where a ward stands today across every measure, with change over time as clearly labelled secondary evidence. |
| `menu.html` | **Menu money.** How each ward office split its annual discretionary capital budget, against citywide medians. |
| `dictionary.html` | Every measure, its source, and how it is scored. Rendered from upstream. |
| `support.html` | How residents contribute. Rendered from upstream, links to the live Penlight site. |

Penlight's map answers "how does my ward score right now". These pages answer
the questions the same API can support and a map cannot show. Where does the
ward stand against the other forty-nine, what do those rankings honestly
support, what was reported locally this quarter, and what does the history say
once its artifacts are labelled instead of displayed as trends.

## Run it

```bash
python3 dev.py
```

Then open <http://localhost:1838>. Standard library only. No venv, no pip install,
no npm, no bundler.

## Where the explorer came from

The explorer, dictionary, and support pages started as a Flask app, because
[Harry's repo](https://github.com/HarryBrisson/ward-wise-frontend) is one. They
are rendered to static HTML once by `build_static.py` and the output is
committed. Re-run it after pulling template changes from a local clone of that
repo:

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

The change section was rebuilt after an eight-lane verification pass recomputed
every displayed figure against fresh API pulls. The arithmetic was exact
everywhere tested; the failures were in what honest arithmetic was allowed to
imply. The rules now standing, each one earned by a documented failure:

- **Direction matters, and unknown direction disqualifies.** The dictionary
  marks each metric `higher` or `lower`. A handful of series exist in the
  timeseries data with no dictionary entry at all, and guessing a direction for
  them once rendered a rising depression rate as an improvement. Undefined
  series are excluded and counted.
- **Measurement changes are not trends.** The six 311 service clocks jump in
  citywide lockstep in the same years, which is the measurement changing, not
  fifty wards moving together. They are excluded from the verdict columns with
  the reason printed.
- **Office decisions are not neighborhood verdicts.** Menu budget shares record
  one office reallocating a fixed pot. They render in their own neutral
  section, never as "moved the right way."
- **Small bases are flagged by absolute size, not just ratio.** One gym
  becoming two per ten thousand residents is "+133%" and used to lead a column.
  Counts under 10, per-10k rates under 5, and percents under 2 points now carry
  a low start flag and sort last when the percent is large.
- **Registers are not momentum.** A count that only ever rises is flagged as a
  running register, and the ramp trimmer skips monotonic series entirely so it
  cannot delete decades of real slow history.
- **The 2023 redraw is disclosed.** Ward-stamped records spanning the boundary
  change carry a flag, and license records dated by expiration drop their
  forward-stamped newest year.
- **Bounded scores show points, not percents.** Sparklines carry a minimum
  vertical scale so a one percent wobble cannot draw like a cliff.
- **Anchors, not exact years.** Metrics sit on different reporting calendars,
  so each one anchors to its first and last observation inside the window, and
  the anchor years print on every row.
- **One value per year, no dividing by zero.** Pipeline re-runs are deduped
  newest-wins, and percent change off a near-zero base falls back to raw
  movement.

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
report.html        the Quarterly: write-ups, news, photos, your equation
menu.html          Menu money: how each ward office spent its budget
dictionary.html    Dictionary (rendered)
support.html       Support    (rendered)
static/reports.js  the report: fetch, change math, sparklines, render
static/reports.css the report's styles; palette inherited from k3-shell.css
static/report.js   renders the compiled quarterly (data/report.json)
static/equation.js the your-equation panel: category weights, live re-rank
static/menu.js     renders the menu money page (data/menu.json)
static/site-config.js  the city constants the pages read
static/geocode.js  browser-side address lookup, replaces the Flask routes
static/k3*.js/css  the explorer, from upstream
static/styles.css  upstream's base stylesheet
build_static.py    renders upstream Jinja templates to static HTML
build_ward_data.py per-ward facts and rankings  (data/wards.json)
build_report.py    compiles the quarterly        (data/report.json)
build_equation_data.py  score matrix + menu money (data/equation.json, menu.json)
dev.py             static server + /api proxy, stdlib only
check_api.py       contract check across both surfaces
check_voice.py     mechanical prose rules for the write-ups
check_sameness.py  templating detector across the fifty write-ups
api-baseline.json  last known-good API fingerprint
_redirects         the Netlify version of the /api proxy
data/wards.json    per-ward facts: rankings, caveats, alderpeople, photos
data/report.json   the compiled quarterly the page loads
data/equation.json the score matrix snapshot behind the your-equation panel
data/menu.json     menu money raw values and citywide medians
data/writeups/     fifty researched ward write-ups with verified news
```

## Another city

Penlight's support page says it is exploring Columbus, Madison, Cincinnati,
New York, and Los Angeles. Most of this site already travels, because nothing
in it is served: the pages are static files, and every number on them comes
out of a build script pointed at an API.

To stand it up against another city's Penlight instance:

1. Point the builders at it: `python3 build_ward_data.py --api-base <url>`,
   then `python3 build_equation_data.py --api-base <url>`, then
   `python3 build_report.py`. Ranks, caveats, categories, and menu figures are
   recomputed from whatever set of areas the matrix serves. A few summary
   strings still say fifty; the ranking math does not.
2. Update `static/site-config.js`, which holds the city name, the area noun,
   and the Penlight URLs the pages link to.
3. Update `_redirects` (or `dev.py`) so `/api` proxies the new host.
4. Rewrite the editorial copy. The masthead, the how-to-read cells, and the
   fifty write-ups are journalism about one city, kept in plain HTML and JSON
   on purpose. The scripts move; the words are written per city.

## The Quarterly's evidence rules

Every number in the fifty ward write-ups traces to a field in
`data/wards.json`, which is regenerated from the live API and has been verified
byte-identical against a fresh rebuild. Every news link was fetched when the
report was compiled; `build_report.py` drops any citation that was not, any
outlet off the agreed local-press list, and any story outside the reporting
window. Two mechanical prose gates (`check_voice.py`, `check_sameness.py`) run
over the write-ups. Officeholder measures are labelled as facts about an
office, never presented as verdicts on the person holding it.

## Status

All six pages work against live data with no backend. The Quarterly carries a
researched write-up, verified news, and a verified official ward link for all
fifty wards, opens one ward at a time from its index, and re-ranks live under
reader-chosen category weights. Reads retry twice on a transient failure (502,
503, 429, or a dropped connection) before giving up, and fail immediately on a
404 or 400.

Not yet built: ward-versus-city comparison (`/api/metrics/delta` already returns
`delta_vs_city`), neighborhood and χGRID area types, and a production deploy
(the site is Netlify-ready via `_redirects`).
