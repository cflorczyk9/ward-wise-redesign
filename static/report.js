/* Ward Wise Quarterly.
 *
 * Renders the compiled report. It computes nothing: every ranking, caveat and
 * citation was fixed at build time by build_ward_data.py and build_report.py,
 * so the page and the data cannot drift apart.
 */

(function () {
  "use strict";

  var el = {
    status: document.getElementById("status"),
    index: document.getElementById("index"),
    indexGrid: document.getElementById("index-grid"),
    wards: document.getElementById("wards"),
    quarter: document.getElementById("quarter"),
    provenance: document.getElementById("provenance"),
  };

  function text(value) {
    var node = document.createElement("span");
    node.textContent = value == null ? "" : String(value);
    return node.innerHTML;
  }

  function ordinal(n) {
    var rem100 = n % 100;
    if (rem100 >= 11 && rem100 <= 13) return n + "th";
    return n + ["th", "st", "nd", "rd"][n % 10 > 3 ? 0 : n % 10];
  }

  function formatValue(value, unit) {
    if (value === null || value === undefined || !isFinite(value)) return "";
    var u = String(unit || "").toLowerCase();
    var abs = Math.abs(value);
    var digits = abs >= 100 ? 0 : abs >= 10 ? 1 : 2;
    if (u.indexOf("percent") > -1) return value.toFixed(digits) + "%";
    if (u.indexOf("currency") > -1 || u.indexOf("usd") > -1) return "$" + Math.round(value).toLocaleString("en-US");
    if (u.indexOf("count") > -1 || u === "units") return Math.round(value).toLocaleString("en-US");
    if (u.indexOf("mile") > -1) return value.toFixed(digits) + " mi";
    if (u.indexOf("day") > -1) return value.toFixed(digits) + " days";
    return value.toFixed(digits);
  }

  // A measure, its position, and the reasons that position is softer than it
  // looks. The caveats are the reason this page exists, so they are not tucked
  // behind a disclosure.
  function measure(entry, strong) {
    var caveats = (entry.caveats || []).map(function (c) {
      return '<li>' + text(c) + "</li>";
    }).join("");

    return (
      '<li class="measure ' + (strong ? "is-strong" : "is-weak") + '">' +
      '<div class="measure-head">' +
      '<span class="measure-name">' + text(entry.label) +
      '<span class="measure-value">' + text(formatValue(entry.value, entry.unit)) + "</span></span>" +
      '<span class="measure-rank">' + ordinal(entry.rank) +
      '<span class="measure-of"> of ' + entry.of + "</span></span>" +
      "</div>" +
      (caveats ? '<ul class="measure-caveats">' + caveats + "</ul>"
               : '<p class="measure-clean">Nothing obvious undercuts this one.</p>') +
      "</li>"
    );
  }

  function newsBlock(ward) {
    if (ward.news_status === "not_researched") {
      return '<p class="news-empty">Not researched for this edition.</p>';
    }
    if (!ward.news || !ward.news.length) {
      return '<p class="news-empty">No coverage from the agreed outlets turned up for this ward ' +
             "in the quarter. That is a gap in local reporting, not a quiet ward.</p>";
    }
    return '<ul class="news-list">' + ward.news.map(function (item) {
      return (
        "<li>" +
        '<a href="' + text(item.url) + '" rel="noopener noreferrer" target="_blank">' +
        text(item.headline) + "</a>" +
        '<span class="news-meta">' + text(item.outlet) +
        (item.date ? " · " + text(item.date) : "") + "</span>" +
        (item.note ? '<p class="news-note">' + text(item.note) + "</p>" : "") +
        "</li>"
      );
    }).join("") + "</ul>";
  }

  function alderBlock(ward) {
    var a = ward.alderperson || {};
    if (!a.name) return "";
    var link = a.website_url
      ? '<a href="' + text(a.website_url) + '" rel="noopener noreferrer" target="_blank">Official ward site</a>'
      : '<span class="alder-nosite">No official site verified for this ward.</span>';
    return (
      '<div class="alder">' +
      (a.photo_url ? '<img class="alder-photo" src="' + text(a.photo_url) + '" alt="" loading="lazy" width="56" height="56">' : "") +
      '<div class="alder-copy"><span class="alder-name">' + text(a.name) + "</span>" +
      '<span class="alder-title">' + text(a.title || "Alderperson") + "</span>" + link + "</div>" +
      "</div>"
    );
  }


  // A real photograph of a real landmark, carrying its own credit. The credit
  // line is not optional: build_ward_data.py only passes through images that
  // have one, and the page prints whatever it was given.
  function photoBlock(ward) {
    var p = ward.photo;
    if (!p || !p.url) return "";
    var caption = p.learn_more
      ? '<a href="' + text(p.learn_more) + '" rel="noopener noreferrer" target="_blank">' + text(p.caption) + "</a>"
      : text(p.caption);
    return (
      '<figure class="ward-photo">' +
      '<img src="' + text(p.url) + '" alt="' + text(p.alt) + '" loading="lazy" decoding="async">' +
      "<figcaption>" +
      '<span class="photo-caption">' + caption + "</span> " +
      '<span class="photo-credit">' + text(p.credit) + "</span>" +
      "</figcaption></figure>"
    );
  }

  function wardSection(ward) {
    var w = ward.writeup || {};
    var overall = ward.overall || {};
    var communities = (ward.communities || []).filter(Boolean).join(", ");

    return (
      '<section class="ward" id="ward-' + ward.ward_id + '">' +
      '<div class="ward-head">' +
      '<span class="ward-num">Ward ' + ward.ward_number + "</span>" +
      (overall.rank ? '<span class="ward-rank">' + ordinal(overall.rank) + " of 50 overall</span>" : "") +
      (communities ? '<span class="ward-communities">' + text(communities) + "</span>" : "") +
      "</div>" +
      (w.headline ? "<h2>" + text(w.headline) + "</h2>" : "<h2>Ward " + ward.ward_number + "</h2>") +
      photoBlock(ward) +
      alderBlock(ward) +
      (w.summary ? '<div class="ward-summary">' + w.summary.split(/\n\n+/).map(function (p) {
        return "<p>" + text(p.trim()) + "</p>";
      }).join("") + "</div>" : '<p class="ward-summary missing">Write-up pending for this ward.</p>') +

      '<div class="ward-measures">' +
      '<div><h3>Strongest here</h3><ol class="measures">' +
      (ward.strengths || []).slice(0, 5).map(function (e) { return measure(e, true); }).join("") +
      "</ol></div>" +
      '<div><h3>Weakest here</h3><ol class="measures">' +
      (ward.weaknesses || []).slice(0, 5).map(function (e) { return measure(e, false); }).join("") +
      "</ol></div>" +
      "</div>" +

      (w.reading_the_rankings
        ? '<div class="ward-reading"><h3>Reading these numbers</h3><p>' +
          text(w.reading_the_rankings) + "</p></div>"
        : "") +

      '<div class="ward-news"><h3>Reported this quarter</h3>' + newsBlock(ward) + "</div>" +

      '<p class="ward-footnote">' + ward.caveated_count + " of " + ward.ranked_count +
      " ranked measures in this ward carry at least one caveat.</p>" +
      '<a class="ward-top" href="#index">Back to the fifty</a>' +
      "</section>"
    );
  }

  fetch("data/report.json", { headers: { Accept: "application/json" } })
    .then(function (res) {
      if (!res.ok) throw new Error("report.json returned " + res.status);
      return res.json();
    })
    .then(function (report) {
      var ids = Object.keys(report.wards).sort(function (a, b) { return Number(a) - Number(b); });

      el.quarter.textContent =
        report.quarter + " · reporting window " + report.window.from + " to " + report.window.to;

      el.indexGrid.innerHTML = ids.map(function (id) {
        var w = report.wards[id];
        var rank = (w.overall || {}).rank;
        return (
          '<li><a href="#ward-' + id + '">' +
          '<span class="idx-num">' + w.ward_number + "</span>" +
          '<span class="idx-name">' + text((w.alderperson || {}).name || "") + "</span>" +
          (rank ? '<span class="idx-rank">' + ordinal(rank) + "</span>" : "") +
          "</a></li>"
        );
      }).join("");
      el.index.hidden = false;

      el.wards.innerHTML = ids.map(function (id) { return wardSection(report.wards[id]); }).join("");

      var written = ids.filter(function (id) { return report.wards[id].writeup; }).length;
      var withNews = ids.filter(function (id) { return (report.wards[id].news || []).length; }).length;
      el.provenance.textContent =
        written + " of 50 wards written up, " + withNews + " with verified local coverage in the window. " +
        "Every linked article was retrieved when the report was compiled.";

      el.status.hidden = true;
    })
    .catch(function (err) {
      el.status.hidden = false;
      el.status.classList.add("error");
      el.status.textContent =
        "Could not load the quarterly report. " + err.message +
        " Run build_ward_data.py then build_report.py to generate it.";
    });
})();
