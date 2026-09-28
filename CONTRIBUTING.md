# Contributing

Penlight is a volunteer civic-data project. This repo exists so that improving the site's design
and experience doesn't require setting up a data pipeline or holding AWS credentials.

```bash
./run.sh          # http://localhost:1837, real data, no credentials
```

## Good first issues

**1. `static/styles.css` still carries rules from the original app.** The first part of the file
styles the full-screen map (`/map`), and the proposal pages and dark mode follow it. Rules for pages
that no longer exist here were removed in the redesign, but the map section was never audited rule
by rule. Before deleting anything, search the templates and every script for the class name.

**2. The map on phones.** `/map` now fits a phone screen and has a dark mode, but it was built for a
desktop layout first. Try it at 375px wide and on a real phone.

## Conventions

Match what's there — this codebase has a consistent voice.

- **No build step, and let's keep it that way.** Vanilla JS in an IIFE, attached to `window`. No
  npm, no bundler, no framework. A contributor should be able to edit a file and reload.
- **Comments explain *why*, not *what*.** The existing comments are load-bearing: they record why
  the catalog line shows a running maximum, why χGRIDs are excluded from photo captions, why the
  Support page stopped loading the history store. Write in that register or don't write.
- **Escape everything.** JS renders HTML by string interpolation; `WardWiseExplorer.escapeHtml`
  (aliased to `esc` in most files) is not optional.
- **CSS uses color tokens** (`--ink`, `--fill`, `--card`, `--blue` and the rest), defined in
  `styles.css` under "Color tokens" with a light and a dark value each. Use a token instead of a
  raw color, so the rule works in both themes.

## Where things live

This repo renders what the API returns; it doesn't produce the data. Data questions — a metric's
definition, a wrong number, coverage years, a new metric — live in the private backend repo, as
does the API itself.

You don't need access to that repo to work here. Open an issue in *this* repo for anything on the
other side of the API, including a change that needs a new API field, and it'll get routed. The
proxy in `server.py` is deliberately dumb: it forwards and streams, and does no shaping of its own.

## Testing a change

There's no test suite yet. Before opening a PR, load all three views and check the browser
console is clean:

- `/` — map renders, switching geography (ward / neighborhood / χGRID) works, toggling metrics
  rescores the choropleth and the leaderboard, a ward popover shows its photo
- `/dictionary` — entries render grouped by domain; `/dictionary#metric=<metric_id>` opens and
  scrolls to that entry
- `/support` — nomination grid, catalog-growth sparkline, four signifier photos

Sanity-check against <https://penlight.wardwise.org> if you're unsure whether something is your
change or already the case upstream.
