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
  };

  var el = {
    ward: document.getElementById("ward"),
    fromYear: document.getElementById("from-year"),
    toYear: document.getElementById("to-year"),
    status: document.getElementById("status"),
    lede: document.getElementById("lede"),
    headline: document.getElementById("headline"),
    subhead: document.getElementById("subhead"),
    filters: document.getElementById("filters"),
    results: document.getElementById("results"),
    snapshot: document.getElementById("snapshot"),
    rowsStrong: document.getElementById("rows-strong"),
    rowsWeak: document.getElementById("rows-weak"),
    change: document.getElementById("change"),
    changeNote: document.getElementById("change-note"),
    rowsBetter: document.getElementById("rows-better"),
    rowsWorse: document.getElementById("rows-worse"),
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
    var shown = Math.abs(pct) >= 10 ? Math.round(Math.abs(pct)) : Math.abs(pct).toFixed(1);
    return (pct >= 0 ? "+" : "−") + shown + "%";
  }

  // ---- sparkline -------------------------------------------------------

  function sparkline(points, isBetter) {
    var W = 68, H = 22, PAD = 2;
    if (points.length < 2) return "";

    var values = points.map(function (p) { return p.value; });
    var lo = Math.min.apply(null, values);
    var hi = Math.max.apply(null, values);
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
    var stroke = isBetter ? "var(--better)" : "var(--worse)";

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

    var cut = 0;
    while (points.length - cut >= 3) {
      var later = points.slice(cut + 1).map(function (p) { return Math.abs(p.value); });
      var reference = median(later);
      if (!reference) break;
      if (Math.abs(points[cut].value) < reference * 0.5) cut += 1;
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

      var trimmed = trimRampIn(points);
      if (trimmed.points.length) {
        series[entry.metric_id] = trimmed.points;
        if (trimmed.droppedTo !== null) rampIn[entry.metric_id] = trimmed.droppedTo;
      }
    });

    state.series = series;
    state.rampIn = rampIn;
    state.partialDropped = partialDropped;
    state.years = Object.keys(years).map(Number).sort(function (a, b) { return a - b; });
  }

  function loadWard(wardId) {
    status("Loading Ward " + Number(wardId) + "…");
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
        fail("Loading Ward " + Number(wardId) + " failed.", err);
      });
  }


  // ---- snapshot --------------------------------------------------------

  // Rank the selected ward against the other 49 on every current measure.
  // The matrix carries a normalised score per ward per metric, already
  // direction-corrected upstream, so a high score always means "doing well".
  function computeRanks(wardId) {
    var ranks = {};
    if (!state.matrix) return ranks;

    var metricIds = {};
    Object.keys(state.matrix).forEach(function (ward) {
      Object.keys(state.matrix[ward] || {}).forEach(function (mid) { metricIds[mid] = true; });
    });

    Object.keys(metricIds).forEach(function (mid) {
      var scored = [];
      Object.keys(state.matrix).forEach(function (ward) {
        var cell = state.matrix[ward] && state.matrix[ward][mid];
        if (cell && typeof cell.s === "number") scored.push({ ward: ward, s: cell.s });
      });
      if (scored.length < 25) return; // too thin to call it a rank out of 50
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
      ? "Ward " + Number(state.wardId) + " ranks " +
        '<span class="count">' + ordinal(overall.rank) + "</span> of 50 in Chicago today."
      : "Ward " + Number(state.wardId) + " today.";

    el.subhead.textContent =
      (counted ? "Scored on " + counted + " current measures. " : "") +
      (alderName ? "Alderperson " + alderName + "." : "");

    el.lede.hidden = false;
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

    var meta = state.metrics[metricId] || {};
    var delta = last.value - first.value;
    var base = Math.abs(first.value);
    var pct = base > 0.0001 ? (delta / base) * 100 : null;
    var lowerIsBetter = String(meta.direction || "higher") === "lower";
    var improved = lowerIsBetter ? delta < 0 : delta > 0;

    // A percent change off a small starting number is arithmetically true and
    // journalistically useless: one mural becoming fourteen is "+1300%" and
    // would outrank the poverty rate falling three points. Flag those, and
    // rank them below everything else, rather than letting them lead.
    //
    // Both halves of the test matter. A small denominator only distorts when
    // it produces a big percent, so 91 permits becoming 107 is an ordinary
    // +18% and is left alone even though the series peaks far above 91.
    var peak = Math.max.apply(null, inWindow.map(function (p) { return Math.abs(p.value); }));
    var thinBase = peak > 0 && base / peak < 0.25;
    var lowStart = pct === null || (thinBase && Math.abs(pct) >= 100);
    var magnitude = pct === null ? Math.abs(delta) : Math.abs(pct);

    return {
      metricId: metricId,
      meta: meta,
      points: inWindow,
      from: first,
      to: last,
      delta: delta,
      pct: pct,
      improved: improved,
      flat: delta === 0,
      lowStart: lowStart,
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

  function renderRow(change) {
    var meta = change.meta;
    var li = document.createElement("li");
    li.className = "row " + (change.improved ? "better" : "worse") + (change.lowStart ? " low-start" : "");

    var label = meta.label || titleCase(change.metricId);
    var deltaText = formatChange(change.pct, change.from.value, change.to.value, meta.unit);

    // Always show the two real numbers next to the percent. The percent alone
    // is what makes a low-start move look like a landslide.
    var pair =
      formatValue(change.from.value, meta.unit) + " → " + formatValue(change.to.value, meta.unit) +
      '<span class="row-years"> · ' + change.from.year + "–" + change.to.year + "</span>" +
      (change.lowStart ? '<span class="row-flag"> low start</span>' : "") +
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
      '<span class="row-right">' + sparkline(change.points, change.improved) +
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

  function render() {
    if (!state.wardId) return;

    var all = Object.keys(state.series).map(changeFor).filter(Boolean);
    renderFilters(all);

    var moved = all.filter(function (change) {
      if (change.flat) return false;
      if (state.categories.size === 0) return true;
      return state.categories.has(change.meta.category || "other");
    });

    // Solid bases first, then by how far the measure moved.
    moved.sort(function (a, b) {
      if (a.lowStart !== b.lowStart) return a.lowStart ? 1 : -1;
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

    el.changeNote.textContent =
      "Only " + moved.length + " of " + Object.keys(state.metrics).length + " measures have enough " +
      "usable history to compare " + state.fromYear + " to " + state.toYear + ". " +
      better.length + " moved the right way, " + worse.length + " moved the wrong way. " +
      "Treat this section as weaker evidence than the standings above.";

    el.change.hidden = false;
    el.results.hidden = false;

    var tracked = Object.keys(state.series).length;
    var noHistory = Object.keys(state.metrics).length - all.length;
    var lowStartCount = moved.filter(function (change) { return change.lowStart; }).length;

    el.excludedNote.textContent =
      noHistory + " of " + Object.keys(state.metrics).length + " metrics are not ranked, because the API " +
      "holds a single dated reading for them in this ward and there is no change to report yet. " +
      tracked + " metrics carry at least one dated observation. " +
      state.partialDropped + " readings dated " + CURRENT_YEAR + " were dropped, because that year is " +
      "still in progress and comparing a part-year against full years invents change that has not " +
      "happened. " +
      (lowStartCount
        ? lowStartCount + " measures are marked low start and sorted last. They begin near the bottom " +
          "of their own range, which inflates the percentage into something technically true and not " +
          "very informative."
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
          option.textContent = "Ward " + Number(ward.ward_id) + alderName;
          if (ward.ward_id === "42") option.selected = true;
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

      return loadWard(el.ward.value || "42");
    })
    .catch(function () {
      // Already surfaced above. Swallow so it does not land as an unhandled
      // rejection with no message on screen.
    });
})();
