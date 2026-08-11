/* Ward Wise Menu Money.
 *
 * Renders data/menu.json, the eight spending-share measures plus budget
 * utilization, project diversity and spending spread, for all fifty wards.
 * Every number on the page is read from that file at load time. Nothing here
 * ranks, grades, or names an officeholder. The data has none of that, and the
 * page adds none either.
 */

(function () {
  "use strict";

  var SHARE_IDS = [
    "menu_streets_share",
    "menu_lighting_share",
    "menu_sidewalks_share",
    "menu_alleys_share",
    "menu_parks_share",
    "menu_cameras_share",
    "menu_schools_share",
    "menu_active_transport_share"
  ];

  var SHORT_LABELS = {
    menu_streets_share: "Streets",
    menu_lighting_share: "Lighting",
    menu_sidewalks_share: "Sidewalks",
    menu_alleys_share: "Alleys",
    menu_parks_share: "Parks",
    menu_cameras_share: "Cameras",
    menu_schools_share: "Schools",
    menu_active_transport_share: "Active transport"
  };

  var COLS = [
    { key: "ward_number", label: "Ward", sortable: true },
    { key: null, label: "Top category", sortable: false },
    { key: "menu_streets_share", label: "Streets", sortable: true },
    { key: "menu_lighting_share", label: "Lighting", sortable: true },
    { key: "menu_sidewalks_share", label: "Sidewalks", sortable: true },
    { key: "menu_alleys_share", label: "Alleys", sortable: true },
    { key: "menu_parks_share", label: "Parks", sortable: true },
    { key: "menu_cameras_share", label: "Cameras", sortable: true },
    { key: "menu_schools_share", label: "Schools", sortable: true },
    { key: "menu_active_transport_share", label: "Active transport", sortable: true },
    { key: "menu_budget_utilization", label: "Budget used", sortable: true }
  ];

  // Shortened by hand from the menu.json metric descriptions, not pasted raw.
  var STATS = [
    {
      key: "menu_budget_utilization",
      label: "Budget used",
      desc: "Share of the year's menu allotment actually spent on projects."
    },
    {
      key: "menu_project_diversity",
      label: "Project diversity",
      desc: "How varied the spending was across project categories, 0 to 100. The dictionary calls this descriptive, since neither concentration nor variety is inherently better."
    },
    {
      key: "menu_spending_spread",
      label: "Spending spread",
      desc: "How spread out across the ward the spending was, adjusted for its size and shape. 100 is an even spread."
    }
  ];

  var el = {
    status: document.getElementById("status"),
    citywide: document.getElementById("citywide"),
    citywideBars: document.getElementById("citywide-bars"),
    citywideNote: document.getElementById("citywide-note"),
    wardsSection: document.getElementById("wards-section"),
    theadRow: document.getElementById("wards-thead-row"),
    tbody: document.getElementById("wards-tbody"),
    provenance: document.getElementById("provenance")
  };

  var state = { sortKey: "ward_number", sortDir: "asc" };
  var records = [];
  var metricsById = {};

  function text(value) {
    var node = document.createElement("span");
    node.textContent = value == null ? "" : String(value);
    return node.innerHTML;
  }

  function formatPct(value) {
    return (typeof value === "number" && isFinite(value) ? value.toFixed(1) : "0.0") + "%";
  }

  function formatByUnit(value, unit) {
    if (unit === "percent") return formatPct(value);
    return typeof value === "number" && isFinite(value) ? value.toFixed(1) : "0.0";
  }

  function clampPct(n) {
    return Math.max(0, Math.min(100, n));
  }

  function topCategory(ward) {
    var bestId = SHARE_IDS[0];
    var bestValue = ward[bestId] || 0;
    for (var i = 1; i < SHARE_IDS.length; i++) {
      var id = SHARE_IDS[i];
      var value = ward[id] || 0;
      if (value > bestValue) {
        bestValue = value;
        bestId = id;
      }
    }
    return { id: bestId, label: metricsById[bestId].label, value: bestValue };
  }

  function buildCitywideBars(data) {
    var rows = SHARE_IDS.map(function (id) {
      return { id: id, label: data.metrics[id].label, value: data.city[id].median };
    });
    rows.sort(function (a, b) { return b.value - a.value; });

    var maxVal = rows[0].value || 1;

    el.citywideBars.innerHTML = rows.map(function (row) {
      var width = clampPct((row.value / maxVal) * 100);
      return (
        '<li class="citywide-bar-row">' +
        '<span class="citywide-bar-label">' + text(row.label) + "</span>" +
        '<span class="citywide-bar-track" aria-hidden="true">' +
        '<span class="citywide-bar-fill" style="width:' + width + '%"></span>' +
        "</span>" +
        '<span class="citywide-bar-value">' + text(formatPct(row.value)) + "</span>" +
        "</li>"
      );
    }).join("");

    var top = rows[0];
    var second = rows[1];
    el.citywideNote.textContent =
      top.label + " takes the biggest median share citywide, " + formatPct(top.value) +
      " of spending. " + second.label + " comes next at " + formatPct(second.value) + ".";
  }

  function buildDetailBars(ward, data) {
    var body = SHARE_IDS.map(function (id) {
      var meta = data.metrics[id];
      var value = ward[id] || 0;
      var median = data.city[id].median;
      var scaleMax = data.city[id].max || 1;
      var fillWidth = clampPct((value / scaleMax) * 100);
      var tickLeft = clampPct((median / scaleMax) * 100);
      return (
        '<div class="detail-metric">' +
        '<div class="detail-metric-head">' +
        '<span class="detail-metric-label">' + text(meta.label) + "</span>" +
        '<span class="detail-metric-value">' + text(formatPct(value)) +
        '<span class="detail-metric-median">citywide median ' + text(formatPct(median)) +
        "</span></span>" +
        "</div>" +
        '<span class="detail-bar-track" aria-hidden="true">' +
        '<span class="detail-bar-fill" style="width:' + fillWidth + '%"></span>' +
        '<span class="detail-bar-tick" style="left:' + tickLeft + '%"></span>' +
        "</span>" +
        "</div>"
      );
    }).join("");

    return (
      '<div class="detail-bars">' +
      '<h3 class="detail-heading">Spending mix against the citywide median</h3>' +
      body +
      "</div>"
    );
  }

  function buildDetailStats(ward) {
    var items = STATS.map(function (stat) {
      var meta = metricsById[stat.key];
      var value = formatByUnit(ward[stat.key], meta.unit);
      return (
        "<li>" +
        '<span class="detail-stat-label">' + text(stat.label) + "</span>" +
        '<span class="detail-stat-value">' + text(value) + "</span>" +
        '<p class="detail-stat-desc">' + text(stat.desc) + "</p>" +
        "</li>"
      );
    }).join("");

    return (
      '<div class="detail-stats-wrap">' +
      '<h3 class="detail-heading">Other measures</h3>' +
      '<ul class="detail-stats">' + items + "</ul>" +
      "</div>"
    );
  }

  function wardRowHtml(record, data) {
    var w = record.w;
    var detailId = "ward-detail-" + record.id;

    var mainRow =
      '<tr class="ward-row">' +
      "<td>" +
      '<button type="button" class="ward-toggle" aria-expanded="false" aria-controls="' +
      detailId + '">' +
      '<span class="ward-toggle-icon" aria-hidden="true">›</span> Ward ' +
      record.wardNumber +
      "</button>" +
      "</td>" +
      '<td class="top-cat-cell">' +
      '<span class="top-cat-label">' + text(record.top.label) + "</span>" +
      '<span class="top-cat-value">' + text(formatPct(record.top.value)) + "</span>" +
      "</td>" +
      SHARE_IDS.map(function (id) { return "<td>" + text(formatPct(w[id])) + "</td>"; }).join("") +
      "<td>" + text(formatPct(w.menu_budget_utilization)) + "</td>" +
      "</tr>";

    var detailRow =
      '<tr class="ward-detail-row" id="' + detailId + '-row" hidden>' +
      '<td colspan="' + COLS.length + '">' +
      '<div class="ward-detail">' +
      buildDetailBars(w, data) +
      buildDetailStats(w) +
      "</div>" +
      "</td>" +
      "</tr>";

    return mainRow + detailRow;
  }

  function sortedRecords() {
    var key = state.sortKey;
    var dir = state.sortDir === "asc" ? 1 : -1;
    var copy = records.slice();
    copy.sort(function (a, b) {
      var av = key === "ward_number" ? a.wardNumber : a.w[key];
      var bv = key === "ward_number" ? b.wardNumber : b.w[key];
      // A ward missing this measure sinks to the bottom under either
      // direction, instead of landing wherever NaN comparisons leave it.
      var aMissing = typeof av !== "number" || isNaN(av);
      var bMissing = typeof bv !== "number" || isNaN(bv);
      if (aMissing && bMissing) return a.wardNumber - b.wardNumber;
      if (aMissing) return 1;
      if (bMissing) return -1;
      return (av - bv) * dir;
    });
    return copy;
  }

  function renderTbody(data) {
    var rows = sortedRecords();
    el.tbody.innerHTML = rows.map(function (record) { return wardRowHtml(record, data); }).join("");
  }

  function updateSortIndicators() {
    var buttons = el.theadRow.querySelectorAll(".sort-btn");
    for (var i = 0; i < buttons.length; i++) {
      var btn = buttons[i];
      var th = btn.closest("th");
      var key = btn.getAttribute("data-key");
      if (!th) continue;
      th.setAttribute("aria-sort", key === state.sortKey ? (state.sortDir === "asc" ? "ascending" : "descending") : "none");
    }
  }

  function buildTableHead() {
    el.theadRow.innerHTML = COLS.map(function (col) {
      if (!col.sortable) {
        return '<th scope="col">' + text(col.label) + "</th>";
      }
      return (
        '<th scope="col" aria-sort="none">' +
        '<button type="button" class="sort-btn" data-key="' + col.key + '">' +
        text(col.label) +
        '<span class="sort-arrow" aria-hidden="true"></span>' +
        "</button>" +
        "</th>"
      );
    }).join("");
  }

  function buildWardsTable(data) {
    var ids = Object.keys(data.wards).sort(function (a, b) { return Number(a) - Number(b); });
    records = ids.map(function (id) {
      var w = data.wards[id];
      return { id: id, wardNumber: Number(id), w: w, top: topCategory(w) };
    });

    buildTableHead();
    updateSortIndicators();
    renderTbody(data);

    el.theadRow.addEventListener("click", function (e) {
      var btn = e.target.closest(".sort-btn");
      if (!btn) return;
      var key = btn.getAttribute("data-key");
      if (state.sortKey === key) {
        state.sortDir = state.sortDir === "asc" ? "desc" : "asc";
      } else {
        state.sortKey = key;
        state.sortDir = "asc";
      }
      updateSortIndicators();
      renderTbody(data);
    });

    el.tbody.addEventListener("click", function (e) {
      var btn = e.target.closest(".ward-toggle");
      if (!btn) return;
      var expanded = btn.getAttribute("aria-expanded") === "true";
      var detailRow = document.getElementById(btn.getAttribute("aria-controls") + "-row");
      if (!detailRow) return;
      detailRow.hidden = expanded;
      btn.setAttribute("aria-expanded", expanded ? "false" : "true");
    });
  }

  function setProvenance(data) {
    var total = Object.keys(data.wards).length;
    var counts = Object.keys(data.city).map(function (id) { return data.city[id].wards_reporting; });
    var minCount = Math.min.apply(null, counts);
    el.provenance.textContent = minCount >= total
      ? "All " + total + " wards report every measure on this page."
      : minCount + " of " + total + " wards report every measure on this page, the rest are missing at least one.";
  }

  fetch("data/menu.json", { headers: { Accept: "application/json" } })
    .then(function (res) {
      if (!res.ok) throw new Error("menu.json returned " + res.status);
      return res.json();
    })
    .then(function (data) {
      metricsById = data.metrics;

      buildCitywideBars(data);
      buildWardsTable(data);
      setProvenance(data);

      el.citywide.hidden = false;
      el.wardsSection.hidden = false;
      el.status.hidden = true;
    })
    .catch(function (err) {
      el.status.hidden = false;
      el.status.classList.add("error");
      el.status.textContent =
        "Could not load the menu money report. " + err.message +
        " Check that data/menu.json exists.";
    });
})();
