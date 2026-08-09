# Ward Wise Reports

A reporting view for Chicago ward data, built against the public
[Ward Wise Penlight](https://penlight.wardwise.org) API.

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
no npm, no build step.

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
index.html        the shell
static/app.js     everything: fetch, change math, sparklines, render
static/styles.css one stylesheet
static/logo.svg   penlight mark
dev.py            static server + /api proxy, stdlib only
check_api.py      contract check against the live API
api-baseline.json last known-good API fingerprint
_redirects        the Netlify version of that proxy
```

## Status

Scaffold. The change ranking, category filters, year window, and per-metric detail
work against live data. Not yet built: ward-versus-city comparison (the
`/api/metrics/delta` endpoint returns `delta_vs_city` and is not wired in yet),
neighborhood and χGRID area types, and a shareable permalink per ward.
