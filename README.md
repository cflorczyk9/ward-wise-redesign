# ward-wise-frontend

The frontend for **Ward Wise Penlight** — a civic-data project built at
[Chi Hack Night](https://chihacknight.org/) that turns Chicago open data into neighborhood
wellbeing metrics anyone can explore, weight, and compare. Live at
[penlight.wardwise.org](https://penlight.wardwise.org).

This repo is the **UX half** of Penlight. It holds the three main views and nothing else:

| View | Route | What it is |
|---|---|---|
| **Home** | `/` | The front door: an interactive ward and neighborhood map (`static/civic_map.js`), who the site serves, and how membership keeps it free. |
| **Map** | `/map` | The map view. A Leaflet choropleth of Chicago by ward, neighborhood, or χGRID, with a metric picker that rescores the map live. Restyled to the new design; behavior unchanged. |
| **Metric dictionary** | `/dictionary` | Every measure: what it counts, its source, its coverage years, how it enters the composite. Grouped by wellbeing domain. |
| **About** | `/about` (`/support` redirects here) | How residents contribute: nominate a metric, submit a photo, bring Penlight to another city. |

The data, the ETL pipeline, and the API live in
[HarryBrisson/ward-wise-civic-tech](https://github.com/HarryBrisson/ward-wise-civic-tech), and
will eventually move into their own APIs repo.

### Proposal pages (branch `proposal/guild-front-door`)

A clickable proposal for how Penlight could pay for itself. Nothing here writes anywhere: the
join and signup forms confirm in the browser.

| Page | Route | What it does |
|---|---|---|
| Ward report card | `/for/residents` | Ten measures for any ward, ranked against all 50, from the live API |
| Planners | `/for/planning` | Downloads any domain as a CSV for wards or community areas |
| Businesses | `/for/business` | A printable snapshot of any community area |
| Membership | `/guild` | The Ward Wise Guild: Resident (free), Community ($120), Organization ($1,500), Institution ($6,000), price finder, money split, charter, governance, FAQ |
| Join | `/guild/join` | Four-step application |
| Ward alerts | `/alerts` | One-page alert builder. Topic switches on the left, and on the right the email a subscriber would get, drawn from live records for their ward (see below) |
| About | `/about` | Restyled support page; `about.js` unchanged |

Prices, rules and council seats are drafts for the team to settle.

Your ward: `static/my_ward.js` (loaded on every page) puts a "Your ward" menu in the header,
with "Use my location" (point-in-polygon on the ward boundaries, nothing leaves the browser) and a
50-ward grid. The choice is saved in `localStorage` and every page follows it through the
`fd:myward` event. A `#ward=` link shows that ward without changing the visitor's own.

Loading and motion: `frontdoor.js` keeps each API answer for ten minutes in `sessionStorage`
(so revisits and prefetched pages paint at once), shows shaped placeholders while data loads,
and prefetches the other map geography plus the report-card data in idle time. All animation
is CSS and switches off under `prefers-reduced-motion`. The logic lives in
`static/frontdoor.js`. The styles sit at the end of `static/styles.css`: color tokens, the global
header and footer (`gn-`, `fd-footer`), and the clean white theme scoped to `body.fd-theme`. Older
scripts that still draw markup with the original class names (`metric_details.js`, `about.js`) are
restyled by rules scoped to their page (`.fd-dict`, `.fd-about`). The map page keeps its original
markup and is restyled by the "map page" section at the end of `styles.css`.

## Run it

```bash
./run.sh
```

That's the whole setup: a venv, Flask, and `requests`. Then open
<http://localhost:1837>. You get the real site with real Chicago data — no AWS credentials,
no data pipeline, no database.

## Deploy (Netlify)

Netlify serves plain files, so `freeze.py` renders every page into `site/`, which is committed.
After changing a template or anything in `static/`, run it and commit the result:

```bash
.venv/bin/python freeze.py
```

`netlify.toml` publishes `site/`. `site/_redirects` (written by `freeze.py`) does at Netlify's edge
what `server.py` does locally: it forwards `/api/*` to the Penlight API and `/clerk/*` to the City
Clerk, and maps `/map`, `/for/residents` and the rest to their files. The address lookup that
`/geocode` does in `server.py` runs as a Netlify function, `netlify/functions/geocode.mjs`.

## How it works

`server.py` is a small shell. It renders the templates, proxies `/api/*` to the live Penlight API
and `/clerk/*` to the City Clerk's legislation API, turns street addresses into map points
(`POST /geocode`, through the Census Bureau), and serves the 404 and 500 pages. Proxying (rather than calling the API cross-origin from the
browser) keeps every request same-origin, so there's no CORS to configure and no API key.

```
GET /dictionary  ->  templates/dictionary.html
GET /api/metrics ->  https://penlight.wardwise.org/api/metrics
```

The live API is the only backend you need; it's public and unauthenticated for these reads.

| Variable | Default | Purpose |
|---|---|---|
| `PENLIGHT_API_BASE` | `https://penlight.wardwise.org` | Where `/api/*` is forwarded |
| `PENLIGHT_SITE_BASE` | `https://penlight.wardwise.org` | Where out-of-scope links point |
| `PROXY_ALLOW_WRITES` | `0` | `1` forwards POSTs upstream instead of stubbing them |
| `PORT` | `1837` | The year Chicago was incorporated |

**Writes are stubbed by default.** The map view POSTs an analytics event on every metric toggle;
clicking around locally shouldn't write rows into production, so the proxy acknowledges those
without forwarding.

### Links that leave

Penlight has pages this repo deliberately doesn't carry — the reports page, metric nomination,
photo submission, the API docs, the submissions admin. Links to them resolve against
`PENLIGHT_SITE_BASE` and open on the live site rather than 404ing.

## Stack

There is no build step. No npm, no bundler, no framework.

- **Flask + Jinja2** for the shell and templates
- **Vanilla JS** in IIFEs attaching to `window` (`WardWiseExplorer`, `WardWiseIcons`, `WardWiseMetricDetails`, `WardWiseCivicMap`, `WardWiseMyWard`, `WardWiseTheme`, `WardWiseFrontDoor`)
- **One hand-written stylesheet**, `static/styles.css`, with light and dark color tokens
- **Leaflet 1.9.4** from CDN, OpenStreetMap tiles

Edit a file, reload the page. `server.py` runs in debug mode, so templates and Python reload
themselves; static assets are cache-busted by mtime.

```
server.py               views, proxies (/api, /clerk), /geocode, error pages
templates/
  base.html             layout: header, nav, theme switch, footer
  home.html             front door with the interactive map
  explorer.html         map view
  residents.html        ward report card
  business.html         neighborhood snapshot
  planning.html         planners and community groups
  guild.html            membership
  guild_join.html       application
  alerts.html           ward alert builder
  dictionary.html       metric dictionary
  about.html            about and get involved
  error.html            404 and 500
static/
  common.js             WardWiseExplorer: the API client, formatters, shared year math
  explorer.js           the map view (2,100 lines: Leaflet, choropleth, weights, modals)
  frontdoor.js          the proposal pages, report cards, alerts, email preview
  civic_map.js          the small SVG map on the home and report pages
  my_ward.js            the "Your ward" menu
  metric_details.js     renders the dictionary
  metric_icons.js       one inline SVG per metric
  about.js              about page
  dictionary.js         dictionary deep-links, search, current-domain highlight
  styles.css            everything
  logo.svg, favicon.*   the mark; logo-email.png for the alert email
```

See [CONTRIBUTING.md](CONTRIBUTING.md) — including a list of good first issues.

## Provenance

Cut from `HarryBrisson/ward-wise-civic-tech` (private) at commit `b5ba7e4`
(`apps/ward_wise_explorer/`). `explorer.js`, `metric_details.js`, `metric_icons.js` and `about.js`
are still close to upstream, so fixes port across with little work. The deliberate differences:

- `base.html` drops Google Analytics and the whole auth branch — no login, no accounts.
- The Support page's rotating signifier photos moved from server-rendered Jinja into `about.js`,
  which fetches them from the area endpoints. That removed the last server-side data dependency
  in these three views (and, upstream, an S3 read on every page render).
- The dictionary was a subtab of `/reports` behind an `i` toggle; here it's a page of its own.
  `metric_details.js` self-initializes on `#metrics-content`, as upstream.
- The redesign: `styles.css` gained color tokens and the new theme, and lost the rules for pages
  this repo doesn't carry. `common.js` lost the unused ward-profile renderer. `explorer.js` reads
  two new color variables so the map follows light and dark. `metric_details.js` shows a plain
  message instead of "Failed to fetch" when the catalog can't load.

## Ward alerts

`/alerts` shows the email before anyone signs up. Each switch on the left turns a section of the
email on or off, and "Every week" or "Every month" changes how far back (or ahead) each section looks.
The email markup in `frontdoor.js` (`emailHtml`) uses tables and inline styles so it can be mailed
as is. "Open full size" opens it as a standalone page.

| Topic | Source | How it finds the ward |
|---|---|---|
| Zoning changes | City Clerk filings in `ZONING RECLASSIFICATIONS` | Address in the title, turned into a map point by the Census Bureau (`POST /geocode`), then checked against the ward boundary |
| New legislation | City Clerk filings from the ward's office | Filing office. Sign permits, driveway permits and fee waivers are dropped |
| Hearings | City Clerk meetings | Citywide |
| Street closures | Transportation permits `jdis-5sry`, full closures only | Map point checked against the ward boundary |
| New businesses | Business licenses `r5kz-chrr`, new storefront licenses only | `ward` field |
| Construction and demolition | Building permits `ydr8-5enu` | `ward` field |
| 311 trends | 311 requests `v6vf-nfxy` | `ward` field |
| Election dates | Fixed dates | None |

Signing up sends nothing yet. To run it for real, a daily job would call the same sources, keep a
subscriber table (email, ward, topics, frequency), and send through a free email tier.

## Dark mode

Every page has a light and a dark version. An inline script at the top of `base.html` picks one
before anything paints, so a dark page never flashes white. It follows the system setting unless
the visitor chooses Light or Dark (the moon and sun button in the header, or Auto, Light and Dark
in the footer), which is saved in `localStorage` as `wardwise:theme`. The script puts `is-dark`
on `<html>` and fires `fd:theme` on `document`.

Colors come from tokens in `styles.css` ("Color tokens"), each with a light and a dark value.
Rules that only matter in dark mode start with `html.is-dark`. The alert email preview stays
light on purpose, because it shows the email as it would arrive. Printing always comes out light.

