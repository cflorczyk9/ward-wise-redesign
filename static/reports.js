/* Ward Wise Reports
 *
 * Penlight answers "how does my ward score right now". This answers the other
 * question the same API can already support: what actually moved, and which way.
 *
 * The whole report is three requests. /api/metrics for the dictionary,
 * /api/wards for names, and one /api/metrics/timeseries call per ward that
 * returns every dated observation the API holds for it.
 */

(function () {
  "use strict";

  var API = "/api"; // same-origin; _redirects (prod) and dev.py (local) proxy it

  // Wired to the per-city config (window.WARDWISE_SITE, built from city.json).
  // Every reader-facing literal below falls back to today's Chicago wording
  // when the config is missing, so an unconfigured page reads exactly as it
  // always has.
  var SITE = window.WARDWISE_SITE || {};

  function capitalize(str) {
    str = String(str || "");
    return str.charAt(0).toUpperCase() + str.slice(1);
  }

  var AREA_NOUN = capitalize(SITE.areaNoun || "ward"); // "Ward"
  var CITY = SITE.city || "Chicago";
  var DEFAULT_AREA_ID = SITE.defaultAreaId || "42";
  var REDRAW_YEAR = SITE.boundaryRedrawYear; // null/undefined -> redraw flag never fires

  // Builds a regex matching any of the given literal prefixes, escaping each
  // one. A missing config falls back to the fixed regex this site shipped
  // with; an explicit empty list means the city declares no unstable
  // measures, and returns null so nothing is excluded.
  function prefixRegex(prefixes, fallback) {
    if (!prefixes) return fallback;
    if (!prefixes.length) return null;
    var escaped = prefixes.map(function (p) {
      return String(p).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    });
    return new RegExp("^(?:" + escaped.join("|") + ")");
  }

  var state = {
    metrics: {},      // metric_id -> dictionary entry
    wards: [],
    wardId: null,
    series: {},       // metric_id -> [{year, value}] sorted ascending
    years: [],        // every year present for the selected ward
    fromYear: null,
    toYear: null,
    categories: new Set(),  // active category filters; empty means "all"
    rampIn: {},       // metric_id -> first trustworthy year, when trimmed
    matrix: null,     // ward -> metric -> {s: score, v: value}, current snapshot
    ranks: {},        // metric_id -> {rank, of} for the selected ward
    overall: {},      // ward -> {rank, score}
    snapshotSkipped: { office: 0, undefined_: 0 },  // counts behind the snapshot note
  };

  var el = {
    ward: document.getElementById("ward"),
    fromYear: document.getElementById("from-year"),
    toYear: document.getElementById("to-year"),
    status: document.getElementById("status"),
    lede: document.getElementById("lede"),
    headline: document.getElementById("headline"),
    subhead: document.getElementById("subhead"),
    snapshotNote: document.getElementById("snapshot-note"),
    filters: document.getElementById("filters"),
    results: document.getElementById("results"),
    snapshot: document.getElementById("snapshot"),
    rowsStrong: document.getElementById("rows-strong"),
    rowsWeak: document.getElementById("rows-weak"),
    change: document.getElementById("change"),
    changeNote: document.getElementById("change-note"),
    rowsBetter: document.getElementById("rows-better"),
    rowsWorse: document.getElementById("rows-worse"),
    rowsOffice: document.getElementById("rows-office"),
    officeChanges: document.getElementById("office-changes"),
    excluded: document.getElementById("excluded"),
    excludedNote: document.getElementById("excluded-note"),
    provenance: document.getElementById("provenance"),
  };

  // ---- helpers ---------------------------------------------------------

  // Every request here is a read against an API this site does not run, and a
  // single transient blip was enough to leave the whole page dead pending a
  // manual retry (seen live: one 502 on /wards while the API was otherwise
  // healthy). Retry the failures that are worth retrying, and only those: a
  // 404 or a 400 will not fix itself, so those fail immediately.
  var RETRY_DELAYS = [400, 1200];

  function retriable(status) {
    return status === 0 || status === 429 || (status >= 500 && status < 600);
  }

  function getJson(path, attempt) {
    attempt = attempt || 0;
    return fetch(API + path, { headers: { Accept: "application/json" } })
      .then(function (res) {
        if (!res.ok) {
          var err = new Error(path + " returned " + res.status);
          err.status = res.status;
          throw err;
        }
        return res.json();
      })
      .catch(function (err) {
        var status = err.status === undefined ? 0 : err.status; // 0 = network/DNS
        if (attempt < RETRY_DELAYS.length && retriable(status)) {
          return new Promise(function (resolve) {
            setTimeout(resolve, RETRY_DELAYS[attempt]);
          }).then(function () {
            return getJson(path, attempt + 1);
          });
        }
        throw err;
      });
  }

  function status(message, isError) {
    el.status.hidden = !message;
    el.status.textContent = message || "";
    el.status.classList.toggle("error", Boolean(isError));
  }

  // A blank page is the worst possible failure, because it looks the same as a
  // page that is still loading. Anything that goes wrong says so on screen,
  // names the step that failed, and offers a way to try again. The full error
  // also goes to the console so a stack is available.
  function fail(step, err) {
    console.error("[wardwise-reports] " + step, err);
    el.status.hidden = false;
    el.status.classList.add("error");
    el.status.textContent = "";

    var line = document.createElement("div");
    line.textContent = step + " " + ((err && err.message) || err || "unknown error");
    el.status.appendChild(line);

    var retry = document.createElement("button");
    retry.type = "button";
    retry.className = "retry";
    retry.textContent = "Try again";
    retry.addEventListener("click", function () { location.reload(); });
    el.status.appendChild(retry);
  }

  function titleCase(slug) {
    return String(slug || "")
      .split("_")
      .map(function (word) { return word.charAt(0).toUpperCase() + word.slice(1); })
      .join(" ");
  }

  // Units come from the dictionary as free text, so match loosely.
  function formatValue(value, unit) {
    if (value === null || value === undefined || !isFinite(value)) return "n/a";
    var u = String(unit || "").toLowerCase();
    var abs = Math.abs(value);
    var digits = abs >= 100 ? 0 : abs >= 10 ? 1 : 2;

    if (u.indexOf("percent") > -1) return value.toFixed(digits) + "%";
    if (u.indexOf("currency") > -1 || u.indexOf("usd") > -1) {
      return "$" + Math.round(value).toLocaleString("en-US");
    }
    if (u.indexOf("count") > -1 || u === "units") {
      return Math.round(value).toLocaleString("en-US");
    }
    if (u.indexOf("mile") > -1) return value.toFixed(digits) + " mi";
    if (u.indexOf("day") > -1) return value.toFixed(digits) + " days";
    if (u.indexOf("minute") > -1) return value.toFixed(digits) + " min";
    return value.toFixed(digits);
  }

  function formatChange(pct, fromValue, toValue, unit) {
    // A percent change off a zero (or near-zero) base is noise, so fall back
    // to the raw movement rather than printing an infinity.
    if (pct === null) {
      var raw = toValue - fromValue;
      return (raw >= 0 ? "+" : "−") + formatValue(Math.abs(raw), unit);
    }
    var shown = Math.abs(pct) >= 100 ? Math.round(Math.abs(pct)) : Math.abs(pct).toFixed(1);
    return (pct >= 0 ? "+" : "−") + shown + "%";
  }

  // ---- sparkline -------------------------------------------------------

  function sparkline(points, tone) {
    var W = 68, H = 22, PAD = 2;
    if (points.length < 2) return "";

    var values = points.map(function (p) { return p.value; });
    var lo = Math.min.apply(null, values);
    var hi = Math.max.apply(null, values);
    // A floor on the y-domain, so a wobble of a few percent renders nearly
    // flat instead of stretching to fill the full height like a real swing.
    var minSpan = 0.12 * Math.max(Math.abs(hi), Math.abs(lo));
    if (hi - lo < minSpan) {
      var mid = (hi + lo) / 2;
      lo = mid - minSpan / 2;
      hi = mid + minSpan / 2;
    }
    var span = hi - lo || 1;
    var firstYear = points[0].year;
    var yearSpan = points[points.length - 1].year - firstYear || 1;

    var coords = points.map(function (p) {
      var x = PAD + ((p.year - firstYear) / yearSpan) * (W - PAD * 2);
      var y = H - PAD - ((p.value - lo) / span) * (H - PAD * 2);
      return [x, y];
    });

    var d = coords.map(function (c, i) {
      return (i === 0 ? "M" : "L") + c[0].toFixed(1) + " " + c[1].toFixed(1);
    }).join(" ");

    var last = coords[coords.length - 1];
    var stroke = tone === "neutral" ? "var(--ink-soft)"
      : tone === "better" ? "var(--better)" : "var(--worse)";

    return (
      '<svg class="spark" width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + " " + H + '" aria-hidden="true">' +
      '<path d="' + d + '" fill="none" stroke="' + stroke + '" stroke-width="1.5" ' +
      'stroke-linecap="round" stroke-linejoin="round" opacity="0.85"/>' +
      '<circle cx="' + last[0].toFixed(1) + '" cy="' + last[1].toFixed(1) + '" r="2" fill="' + stroke + '"/>' +
      "</svg>"
    );
  }

  // ---- data ------------------------------------------------------------

  function loadDictionary() {
    return Promise.all([
      getJson("/metrics"),
      getJson("/wards"),
      // The snapshot. Every ward scored on every measure at one moment, so
      // this is the half of the report that owes nothing to the time series.
      getJson("/metrics/score-matrix?area_type=ward&year=latest"),
      getJson("/metrics/scores?area_type=ward"),
    ]).then(function (results) {
      var metricsPayload = results[0];
      var wardsPayload = results[1];
      var matrixPayload = results[2];
      var scoresPayload = results[3];

      var matrix = matrixPayload.matrix || {};
      state.matrix = matrix[Object.keys(matrix)[0]] || {};

      (scoresPayload.scores || []).forEach(function (row) {
        state.overall[row.area_id] = { rank: row.rank, score: row.score };
      });

      (metricsPayload.metrics || []).forEach(function (metric) {
        state.metrics[metric.metric_id] = metric;
      });
      state.coverage = metricsPayload.coverage || {};

      state.wards = (wardsPayload.wards || []).slice().sort(function (a, b) {
        return Number(a.ward_id) - Number(b.ward_id);
      });

      var snapshots = metricsPayload.snapshots || [];
      var newest = snapshots.length ? snapshots[snapshots.length - 1].collected_at : null;
      el.provenance.textContent =
        Object.keys(state.metrics).length + " metrics in the dictionary" +
        (newest ? ", pipeline last collected " + newest.slice(0, 10) : "") + ".";
    });
  }

  // Collapse the observation list into one value per calendar year. The API
  // dates observations by period_end, and re-runs of the pipeline can emit the
  // same year more than once, so the newest snapshot for a year wins.
  //
  // The current year is dropped on purpose. Several series carry a
  // year-to-date reading for it (period_end 2026-06-30, 2026-08-06,
  // 2026-09-30), and comparing a partial year against full ones invents
  // collapses that never happened. A metric that had spent nothing yet this
  // year would otherwise read as down 100 percent.
  var CURRENT_YEAR = new Date().getFullYear();

  // Measures that record what the ward office did with its own budget, not
  // what the ward is like. They are shown without a better/worse verdict,
  // matching the standard the Quarterly applies to the same measures.
  var OFFICE_METRIC = SITE.officeMetricPattern
    ? new RegExp(SITE.officeMetricPattern)
    : /^menu_|^council_attendance_pct$|^nonroutine_bills_sponsored_current_session$|^participatory_budgeting$/;

  // The 311 clocks jump in lockstep citywide (2015, 2017, 2018, 2019, and
  // again later) by amounts no set of neighborhoods produces together, so the
  // measurement changed, not the service. A trend read off any two years is a
  // statement about the measurement eras it happens to span.
  var UNSTABLE_METRIC = prefixRegex(SITE.unstableMetricPrefixes, /^c311_/);

  // A bounded score is not a quantity; "+62%" on a diversity score misleads
  // where "up 9.8 points" informs. These units always show the raw movement.
  var BOUNDED_UNIT = /score|index|rating/i;

  function allocationOf(metricId) {
    var cov = (state.coverage || {})[metricId] || {};
    return String(((cov.latest_metadata || {}).allocation_method) || "");
  }

  // Business-license measures are dated by license expiration, so their
  // newest rows sit in the future. Dropping the current year is not enough
  // for them; the last retained year comes off the same forward-dated stock
  // snapshot, so it goes too.
  function isForwardStamped(metricId) {
    var cov = (state.coverage || {})[metricId] || {};
    return allocationOf(metricId) === "license_ward_field" &&
      String(cov.latest_period_end || "") > new Date().toISOString().slice(0, 10);
  }

  function isMonotonicNonDecreasing(points) {
    for (var i = 1; i < points.length; i++) {
      if (points[i].value < points[i - 1].value) return false;
    }
    return true;
  }

  // Several measures were phased in rather than switched on, so their first
  // years are the collection ramping up and not the world changing. Chicago's
  // crash reporting is the clearest case: ward 42 reads 30 injuries in 2015,
  // 128 in 2016, 454 in 2017, then settles near 750. Measured from 2015 that
  // is "+2,430%", which is a fact about the database, not about the street.
  //
  // So drop leading points that sit far below where the series actually lives.
  // The median of the later points is the reference because it ignores the
  // ramp itself. Verified against a 50-ward pass: this lands on 2017 for both
  // crash metrics, matching the citywide onset computed independently.
  function median(values) {
    var sorted = values.slice().sort(function (a, b) { return a - b; });
    var mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  function trimRampIn(points) {
    if (points.length < 4) return { points: points, droppedTo: null };

    // A series that only ever rises is a real slow trend or a register, not a
    // collection ramp. Trimming it would delete decades of genuine history
    // (landmark designations, TIF increments growing by design), so leave it
    // alone; registers get their own flag downstream.
    if (isMonotonicNonDecreasing(points)) return { points: points, droppedTo: null };

    var cut = 0;
    while (points.length - cut >= 3) {
      var later = points.slice(cut + 1).map(function (p) { return Math.abs(p.value); });
      var reference = median(later);
      if (!reference) break;
      // 0.6, not 0.5: a 50-ward check showed onset years settling one point
      // later than the old cutoff caught (crash counts at 49%, Divvy's
      // partial first season at 54% of the later median).
      if (Math.abs(points[cut].value) < reference * 0.6) cut += 1;
      else break;
    }

    if (!cut) return { points: points, droppedTo: null };
    return { points: points.slice(cut), droppedTo: points[cut].year };
  }

  function buildSeries(payload) {
    var series = {};
    var years = {};
    var rampIn = {};
    var partialDropped = 0;
    var forwardDropped = 0;

    (payload.timeseries || []).forEach(function (entry) {
      var byYear = {};
      (entry.observations || []).forEach(function (obs) {
        if (obs.period_end === null || obs.period_end === undefined) return;
        if (obs.value === null || obs.value === undefined || !isFinite(obs.value)) return;
        var year = Number(String(obs.period_end).slice(0, 4));
        if (!year) return;
        if (year >= CURRENT_YEAR) { partialDropped += 1; return; }
        var prior = byYear[year];
        if (!prior || String(obs.collected_at || "") >= prior.collected_at) {
          byYear[year] = { value: Number(obs.value), collected_at: String(obs.collected_at || "") };
        }
        years[year] = true;
      });

      var points = Object.keys(byYear)
        .map(function (year) { return { year: Number(year), value: byYear[year].value }; })
        .sort(function (a, b) { return a.year - b.year; });

      if (points.length && isForwardStamped(entry.metric_id)) {
        points.pop();
        forwardDropped += 1;
      }

      var trimmed = trimRampIn(points);
      if (trimmed.points.length) {
        series[entry.metric_id] = trimmed.points;
        if (trimmed.droppedTo !== null) rampIn[entry.metric_id] = trimmed.droppedTo;
      }
    });

    state.series = series;
    state.rampIn = rampIn;
    state.partialDropped = partialDropped;
    state.forwardDropped = forwardDropped;
    state.years = Object.keys(years).map(Number).sort(function (a, b) { return a - b; });
  }

  function loadWard(wardId) {
    status("Loading " + AREA_NOUN + " " + Number(wardId) + "…");
    el.results.hidden = true;
    el.excluded.hidden = true;
    el.change.hidden = true;

    // The snapshot needs nothing but data already in hand, so paint it before
    // waiting on the history call. It is the part of the page that is always
    // trustworthy, and it should never be blocked by the part that is not.
    state.wardId = wardId;
    state.ranks = computeRanks(wardId);
    renderSnapshotHeader();
    renderSnapshot();

    return getJson("/metrics/timeseries?area_type=ward&area_id=" + encodeURIComponent(wardId))
      .then(function (payload) {
        buildSeries(payload);
        populateYears();
        render();
      })
      .catch(function (err) {
        fail("Loading " + AREA_NOUN + " " + Number(wardId) + " failed.", err);
      });
  }


  // ---- snapshot --------------------------------------------------------

  // Two kinds of measure stay out of "Strongest here" and "Weakest here".
  //
  // Office measures record what the ward office chose to do with its own
  // budget, not what the ward is like. Ranking one here prints "menu money on
  // sidewalks, 50th of 50" under a heading a reader takes as a verdict on
  // their neighborhood. The change section already refuses that framing and
  // gives these measures their own neutral block. The snapshot was the one
  // place the rule was written down and not applied.
  //
  // Undefined measures are scored by the API but carry no dictionary entry,
  // so there is no label, no source, and no stated direction. renderSnapshotRow
  // falls back to a title-cased raw id and defaults "better when" to higher,
  // which is backwards for depression_pct and social_isolation_pct and prints
  // as a statement of fact. A measure the site cannot describe is a measure it
  // should not rank.
  function snapshotSkipReason(mid) {
    if (OFFICE_METRIC.test(mid)) return "office";
    if (!state.metrics[mid]) return "undefined_";
    return null;
  }

  // Rank the selected ward against the other 49 on every current measure.
  // The matrix carries a normalised score per ward per metric, already
  // direction-corrected upstream, so a high score always means "doing well".
  function computeRanks(wardId) {
    var ranks = {};
    state.snapshotSkipped = { office: 0, undefined_: 0 };
    if (!state.matrix) return ranks;

    var metricIds = {};
    Object.keys(state.matrix).forEach(function (ward) {
      Object.keys(state.matrix[ward] || {}).forEach(function (mid) { metricIds[mid] = true; });
    });

    Object.keys(metricIds).forEach(function (mid) {
      var skip = snapshotSkipReason(mid);
      if (skip) {
        // Only count a skip the ward actually carries, so the note describes
        // this ward's page rather than the catalog.
        var here = state.matrix[wardId] && state.matrix[wardId][mid];
        if (here && typeof here.s === "number") state.snapshotSkipped[skip] += 1;
        return;
      }
      var scored = [];
      Object.keys(state.matrix).forEach(function (ward) {
        var cell = state.matrix[ward] && state.matrix[ward][mid];
        if (cell && typeof cell.s === "number") scored.push({ ward: ward, s: cell.s });
      });
      if (scored.length < Math.ceil((SITE.areaCount || 50) / 2)) return; // too thin to call it a rank out of 50
      scored.sort(function (a, b) { return b.s - a.s; });
      for (var i = 0; i < scored.length; i += 1) {
        if (scored[i].ward === wardId) {
          var cell = state.matrix[wardId][mid];
          ranks[mid] = { rank: i + 1, of: scored.length, score: cell.s, value: cell.v };
          break;
        }
      }
    });
    return ranks;
  }

  function ordinal(n) {
    var rem100 = n % 100;
    if (rem100 >= 11 && rem100 <= 13) return n + "th";
    return n + ["th", "st", "nd", "rd"][n % 10 > 3 ? 0 : n % 10];
  }

  function renderSnapshotRow(mid, info, strong) {
    var meta = state.metrics[mid] || {};
    var li = document.createElement("li");
    li.className = "row " + (strong ? "better" : "worse");

    var li_label = meta.label || titleCase(mid);
    var head = document.createElement("button");
    head.type = "button";
    head.className = "row-head";
    head.setAttribute("aria-expanded", "false");
    head.innerHTML =
      '<span class="row-label">' + li_label +
      '<span class="row-cat">' + titleCase(meta.category || "other") + "</span>" +
      '<span class="row-pair">' + formatValue(info.value, meta.unit) + "</span></span>" +
      '<span class="row-right"><span class="row-delta">' +
      ordinal(info.rank) + '<span class="row-of"> of ' + info.of + "</span></span></span>";

    var detail = document.createElement("div");
    detail.className = "row-detail";
    detail.hidden = true;
    detail.innerHTML =
      "<dl>" +
      "<dt>Value</dt><dd>" + formatValue(info.value, meta.unit) + "</dd>" +
      "<dt>Rank</dt><dd>" + ordinal(info.rank) + " of " + info.of + " wards</dd>" +
      "<dt>Better when</dt><dd>" + (meta.direction === "lower" ? "lower" : "higher") + "</dd>" +
      "</dl>" +
      (meta.description ? '<p class="desc">' + meta.description + "</p>" : "") +
      (meta.source ? '<p class="src">Source: ' + meta.source + "</p>" : "");

    head.addEventListener("click", function () {
      var open = detail.hidden;
      detail.hidden = !open;
      head.setAttribute("aria-expanded", open ? "true" : "false");
    });

    li.appendChild(head);
    li.appendChild(detail);
    return li;
  }


  // The lede is the ward's standing today: one composite rank out of 50, built
  // from measures collected at a single moment. No time series involved.
  function renderSnapshotHeader() {
    var ward = state.wards.filter(function (w) { return w.ward_id === state.wardId; })[0] || {};
    var alderName = ward.alderperson && ward.alderperson.name ? ward.alderperson.name : null;
    var overall = state.overall[state.wardId];
    var counted = Object.keys(state.ranks).length;

    el.headline.innerHTML = overall
      ? AREA_NOUN + " " + Number(state.wardId) + " ranks " +
        '<span class="count">' + ordinal(overall.rank) + "</span> of " + (state.wards.length || SITE.areaCount || 50) + " in " + CITY + " today."
      : AREA_NOUN + " " + Number(state.wardId) + " today.";

    el.subhead.textContent =
      (counted ? "Scored on " + counted + " current measures. " : "") +
      (alderName ? "Alderperson " + alderName + "." : "");

    // Say what the two lists leave out rather than quietly shortening them.
    var note = snapshotNote();
    el.snapshotNote.textContent = note;
    el.snapshotNote.hidden = !note;

    el.lede.hidden = false;
  }

  // Reads off the counters computeRanks filled while it was filtering.
  function snapshotNote() {
    var skipped = state.snapshotSkipped || { office: 0, undefined_: 0 };
    var noun = String(AREA_NOUN).toLowerCase();
    var parts = [];

    if (skipped.office) {
      parts.push(
        skipped.office + " budget and attendance measures are not ranked here, because they " +
        "record what the " + noun + " office decided rather than what the " + noun + " is like. " +
        "They are further down, under What changed over time."
      );
    }
    if (skipped.undefined_) {
      parts.push(
        skipped.undefined_ + " more are scored by the API but missing from the metric dictionary, " +
        "so there is no source and no stated direction to show for them."
      );
    }
    return parts.join(" ");
  }

  function renderSnapshot() {
    var ranked = Object.keys(state.ranks).map(function (mid) {
      return { mid: mid, info: state.ranks[mid] };
    });
    if (!ranked.length) { el.snapshot.hidden = true; return 0; }

    ranked.sort(function (a, b) { return a.info.rank - b.info.rank; });

    el.rowsStrong.innerHTML = "";
    el.rowsWeak.innerHTML = "";
    ranked.slice(0, 10).forEach(function (r) {
      el.rowsStrong.appendChild(renderSnapshotRow(r.mid, r.info, true));
    });
    ranked.slice(-10).reverse().forEach(function (r) {
      el.rowsWeak.appendChild(renderSnapshotRow(r.mid, r.info, false));
    });

    el.snapshot.hidden = false;
    return ranked.length;
  }

  // ---- change math -----------------------------------------------------

  // Anchor to the observation nearest each end of the window rather than
  // demanding an exact year, because the metrics are on different reporting
  // calendars. A metric only counts if its two anchors are different years.
  function changeFor(metricId) {
    var points = state.series[metricId];
    if (!points || points.length < 2) return null;

    var inWindow = points.filter(function (p) {
      return p.year >= state.fromYear && p.year <= state.toYear;
    });
    if (inWindow.length < 2) return null;

    var first = inWindow[0];
    var last = inWindow[inWindow.length - 1];
    if (first.year === last.year) return null;

    var meta = state.metrics[metricId];
    var unit = String((meta || {}).unit || "").toLowerCase();
    var delta = last.value - first.value;
    var base = Math.abs(first.value);

    // A series with no dictionary entry has no direction; guessing one turned
    // a rising depression rate green. Those render in the excluded note, not
    // in a verdict column. Office-budget and 311 measures get their own
    // treatment for the reasons on their constants above.
    var kind = !meta ? "undefined"
      : OFFICE_METRIC.test(metricId) ? "office"
      : UNSTABLE_METRIC && UNSTABLE_METRIC.test(metricId) ? "unstable"
      : "trend";
    meta = meta || {};

    // Percent change on a bounded score misleads; those show raw movement.
    var usePct = !BOUNDED_UNIT.test(unit);
    var pct = usePct && base > 0.0001 ? (delta / base) * 100 : null;
    var lowerIsBetter = String(meta.direction || "higher") === "lower";
    var improved = lowerIsBetter ? delta < 0 : delta > 0;

    // A percent change off a small starting number is arithmetically true and
    // journalistically useless: one mural becoming fourteen is "+1300%" and
    // would outrank the poverty rate falling three points. Flag those, and
    // rank them below everything else, rather than letting them lead.
    //
    // Two tests, either is enough when the percent is big. The relative one
    // catches a series starting far below its own peak. The absolute one
    // catches a series that lives entirely in single digits, where the ratio
    // test goes blind: one gym becoming two per ten thousand residents is
    // "+133%" with a perfectly healthy base-to-peak ratio.
    var peak = Math.max.apply(null, inWindow.map(function (p) { return Math.abs(p.value); }));
    var thinBase = peak > 0 && base / peak < 0.5;
    var absFloor =
      unit.indexOf("count") > -1 || unit === "units" ? base < 10 :
      unit.indexOf("10") > -1 ? base < 5 :
      unit.indexOf("percent") > -1 ? base < 2 : false;
    var zeroBase = usePct && base <= 0.0001;
    var lowStart = zeroBase ||
      (pct !== null && Math.abs(pct) >= 40 && (thinBase || absFloor));
    var magnitude = pct === null ? Math.abs(delta) : Math.abs(pct);

    // A count that only ever rises is a register. Its "change" is
    // accumulation, so it carries a flag and sorts with the low starts.
    var cumulative = (unit.indexOf("count") > -1 || unit === "units") &&
      inWindow.length >= 5 && delta > 0 && isMonotonicNonDecreasing(inWindow);

    // "Changed" implies recent movement. If the series has sat still for
    // five-plus years, say when the movement actually happened.
    var staleSince = null;
    var i = inWindow.length - 1;
    while (i > 0 && inWindow[i - 1].value === last.value) i -= 1;
    if (i > 0 && last.year - inWindow[i].year >= 5) staleSince = inWindow[i].year;

    // Ward-stamped records changed shape with the boundary redraw, so a
    // window spanning it compares two differently shaped wards. No redraw
    // year configured means this never fires.
    var alloc = allocationOf(metricId);
    var redraw = REDRAW_YEAR != null &&
      (alloc === "license_ward_field" || alloc === "direct_ward") &&
      first.year <= REDRAW_YEAR - 1 && last.year >= REDRAW_YEAR;

    return {
      metricId: metricId,
      meta: meta,
      kind: kind,
      points: inWindow,
      from: first,
      to: last,
      delta: delta,
      pct: pct,
      improved: improved,
      flat: delta === 0 || (pct !== null && Math.abs(pct) < 0.05),
      lowStart: lowStart,
      cumulative: cumulative,
      staleSince: staleSince,
      redraw: redraw,
      magnitude: magnitude,
    };
  }

  // ---- rendering -------------------------------------------------------

  function populateYears() {
    var years = state.years;
    if (!years.length) return;

    // Ignore the long tail of one-off historical points when choosing the
    // default window; the last 15 years is where nearly every series lives.
    var newest = years[years.length - 1];
    var defaultFrom = years.filter(function (y) { return y >= newest - 15; })[0] || years[0];

    function fill(select, chosen) {
      select.innerHTML = "";
      years.forEach(function (year) {
        var option = document.createElement("option");
        option.value = String(year);
        option.textContent = String(year);
        if (year === chosen) option.selected = true;
        select.appendChild(option);
      });
      select.disabled = false;
    }

    if (state.fromYear === null || years.indexOf(state.fromYear) === -1) state.fromYear = defaultFrom;
    if (state.toYear === null || years.indexOf(state.toYear) === -1) state.toYear = newest;

    fill(el.fromYear, state.fromYear);
    fill(el.toYear, state.toYear);
  }

  function renderFilters(changes) {
    var counts = {};
    changes.forEach(function (change) {
      var cat = change.meta.category || "other";
      counts[cat] = (counts[cat] || 0) + 1;
    });

    var cats = Object.keys(counts).sort();
    el.filters.innerHTML = "";
    el.filters.hidden = cats.length < 2;

    cats.forEach(function (cat) {
      var chip = document.createElement("button");
      chip.type = "button";
      chip.className = "chip";
      chip.setAttribute("aria-pressed", state.categories.has(cat) ? "true" : "false");
      chip.textContent = titleCase(cat) + " (" + counts[cat] + ")";
      chip.addEventListener("click", function () {
        if (state.categories.has(cat)) state.categories.delete(cat);
        else state.categories.add(cat);
        render();
      });
      el.filters.appendChild(chip);
    });
  }

  function renderRow(change, neutral) {
    var meta = change.meta;
    var li = document.createElement("li");
    li.className = neutral
      ? "row office-row"
      : "row " + (change.improved ? "better" : "worse") + (change.lowStart ? " low-start" : "");

    var label = meta.label || titleCase(change.metricId);
    var deltaText = formatChange(change.pct, change.from.value, change.to.value, meta.unit);

    // Always show the two real numbers next to the percent. The percent alone
    // is what makes a low-start move look like a landslide.
    var pair =
      formatValue(change.from.value, meta.unit) + " → " + formatValue(change.to.value, meta.unit) +
      '<span class="row-years"> · ' + change.from.year + "–" + change.to.year + "</span>" +
      (change.lowStart ? '<span class="row-flag"> low start</span>' : "") +
      (change.cumulative ? '<span class="row-flag"> running register</span>' : "") +
      (change.staleSince ? '<span class="row-flag"> unchanged since ' + change.staleSince + "</span>" : "") +
      (change.redraw ? '<span class="row-flag"> spans the ' + REDRAW_YEAR + ' redraw</span>' : "") +
      (state.rampIn[change.metricId] > state.fromYear
        ? '<span class="row-flag"> data begins ' + state.rampIn[change.metricId] + "</span>"
        : "");

    var head = document.createElement("button");
    head.type = "button";
    head.className = "row-head";
    head.setAttribute("aria-expanded", "false");
    head.innerHTML =
      '<span class="row-label">' + label +
      '<span class="row-cat">' + titleCase(meta.category || "other") + "</span>" +
      '<span class="row-pair">' + pair + "</span></span>" +
      '<span class="row-right">' +
      sparkline(change.points, neutral ? "neutral" : change.improved ? "better" : "worse") +
      '<span class="row-delta">' + deltaText + "</span></span>";

    var detail = document.createElement("div");
    detail.className = "row-detail";
    detail.hidden = true;
    detail.innerHTML =
      "<dl>" +
      "<dt>" + change.from.year + "</dt><dd>" + formatValue(change.from.value, meta.unit) + "</dd>" +
      "<dt>" + change.to.year + "</dt><dd>" + formatValue(change.to.value, meta.unit) + "</dd>" +
      "<dt>Change</dt><dd>" + formatValue(change.delta, meta.unit) + " (" + deltaText + ")</dd>" +
      "<dt>Points</dt><dd>" + change.points.length + " years of data</dd>" +
      (state.rampIn[change.metricId] > state.fromYear
        ? "<dt>Trimmed</dt><dd>earlier years dropped, this measure was still being " +
          "phased in until " + state.rampIn[change.metricId] + "</dd>"
        : "") +
      (change.redraw
        ? "<dt>Boundaries</dt><dd>this record is stamped with a ward number at collection " +
          "time, and ward boundaries were redrawn in " + REDRAW_YEAR + ", so the two ends of this " +
          "comparison describe differently shaped wards</dd>"
        : "") +
      (neutral
        ? "<dt>Read as</dt><dd>a choice made by the ward office, not a condition of " +
          "the neighborhood</dd>"
        : "<dt>Better when</dt><dd>" + (meta.direction === "lower" ? "lower" : "higher") + "</dd>") +
      "</dl>" +
      (meta.description ? '<p class="desc">' + meta.description + "</p>" : "") +
      (meta.source ? '<p class="src">Source: ' + meta.source + "</p>" : "");

    head.addEventListener("click", function () {
      var open = detail.hidden;
      detail.hidden = !open;
      head.setAttribute("aria-expanded", open ? "true" : "false");
    });

    li.appendChild(head);
    li.appendChild(detail);
    return li;
  }

  function render() {
    if (!state.wardId) return;

    var all = Object.keys(state.series).map(changeFor).filter(Boolean);

    var trends = all.filter(function (change) { return change.kind === "trend"; });
    var office = all.filter(function (change) { return change.kind === "office" && !change.flat; });
    var unstable = all.filter(function (change) { return change.kind === "unstable"; });
    var undefinedCount = all.filter(function (change) { return change.kind === "undefined"; }).length;

    renderFilters(trends);

    var moved = trends.filter(function (change) {
      if (change.flat) return false;
      if (state.categories.size === 0) return true;
      return state.categories.has(change.meta.category || "other");
    });
    var flatCount = trends.filter(function (change) { return change.flat; }).length;

    // Solid bases first, then by how far the measure moved. A register's
    // accumulation is demoted the same way a low start is.
    moved.sort(function (a, b) {
      var aDemoted = a.lowStart || a.cumulative;
      var bDemoted = b.lowStart || b.cumulative;
      if (aDemoted !== bDemoted) return aDemoted ? 1 : -1;
      return b.magnitude - a.magnitude;
    });

    var better = moved.filter(function (change) { return change.improved; });
    var worse = moved.filter(function (change) { return !change.improved; });

    el.rowsBetter.innerHTML = "";
    el.rowsWorse.innerHTML = "";
    better.forEach(function (change) { el.rowsBetter.appendChild(renderRow(change)); });
    worse.forEach(function (change) { el.rowsWorse.appendChild(renderRow(change)); });

    if (!better.length) el.rowsBetter.innerHTML = '<li class="row"><div class="row-head">Nothing in this window.</div></li>';
    if (!worse.length) el.rowsWorse.innerHTML = '<li class="row"><div class="row-head">Nothing in this window.</div></li>';

    office.sort(function (a, b) { return b.magnitude - a.magnitude; });
    el.rowsOffice.innerHTML = "";
    office.forEach(function (change) { el.rowsOffice.appendChild(renderRow(change, true)); });
    el.officeChanges.hidden = !office.length;

    el.changeNote.textContent =
      moved.length + " measures moved between their earliest and latest readings inside this " +
      "window; the anchor years vary by measure and are printed on each row. " +
      better.length + " moved the right way, " + worse.length + " moved the wrong way, and " +
      flatCount + " held flat. Treat this section as weaker evidence than the standings above.";

    el.change.hidden = false;
    el.results.hidden = false;

    var defined = Object.keys(state.metrics).length;
    var insufficient = defined - trends.length - office.length - unstable.length;
    var lowStartCount = moved.filter(function (change) { return change.lowStart; }).length;

    el.excludedNote.textContent =
      "Of " + defined + " defined measures, " + insufficient + " lack two usable readings " +
      "inside this window, from having no dated history at all up to having one reading. " +
      (unstable.length
        ? unstable.length + " track the 311 request system, whose measurement changed repeatedly " +
          "citywide (synchronized jumps in 2015, 2017, 2018 and 2019 across wards), so a trend " +
          "read across those years describes the measurement, not the ward, and they are left out. "
        : "") +
      (undefinedCount
        ? (undefinedCount === 1
            ? "1 more series carries no dictionary definition, so which direction is " +
              "better cannot be known and it is left out too. "
            : undefinedCount + " more series carry no dictionary definition, so which " +
              "direction is better cannot be known and they are left out too. ")
        : "") +
      state.partialDropped + " readings dated " + CURRENT_YEAR + " were dropped, because that " +
      "year is still in progress. " +
      (state.forwardDropped
        ? state.forwardDropped + " newest license readings were dropped as well, because " +
          "license records are dated by expiration and sit ahead of today. "
        : "") +
      (lowStartCount
        ? lowStartCount + " measures are marked low start and sorted last. They begin near the " +
          "bottom of their own range or from a small base, which inflates the percentage into " +
          "something technically true and not very informative."
        : "");
    el.excluded.hidden = false;

    status("");
  }

  // ---- wiring ----------------------------------------------------------

  el.ward.addEventListener("change", function () { loadWard(el.ward.value); });

  el.fromYear.addEventListener("change", function () {
    state.fromYear = Number(el.fromYear.value);
    if (state.fromYear > state.toYear) {
      state.toYear = state.fromYear;
      el.toYear.value = String(state.toYear);
    }
    render();
  });

  el.toYear.addEventListener("change", function () {
    state.toYear = Number(el.toYear.value);
    if (state.toYear < state.fromYear) {
      state.fromYear = state.toYear;
      el.fromYear.value = String(state.fromYear);
    }
    render();
  });

  // The dictionary and the ward list are separate failure points from the
  // report itself, so they report separately. Lumping them together is how a
  // working API produced the message "could not reach the API".
  loadDictionary()
    .catch(function (err) {
      fail("Could not load the metric dictionary from the API.", err);
      throw err;
    })
    .then(function () {
      try {
        el.ward.innerHTML = "";
        state.wards.forEach(function (ward) {
          var option = document.createElement("option");
          option.value = ward.ward_id;
          var alderName = ward.alderperson && ward.alderperson.name ? " · " + ward.alderperson.name : "";
          option.textContent = AREA_NOUN + " " + Number(ward.ward_id) + alderName;
          if (ward.ward_id === DEFAULT_AREA_ID) option.selected = true;
          el.ward.appendChild(option);
        });
        el.ward.disabled = false;
      } catch (err) {
        fail("Building the ward list failed.", err);
        throw err;
      }

      if (!state.wards.length) {
        fail("The API returned no wards, so there is nothing to report on.", new Error("0 wards"));
        return null;
      }

      return loadWard(el.ward.value || DEFAULT_AREA_ID);
    })
    .catch(function () {
      // Already surfaced above. Swallow so it does not land as an unhandled
      // rejection with no message on screen.
    });
})();
