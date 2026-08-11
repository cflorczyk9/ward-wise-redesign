/* Your equation.
 *
 * Penlight's survey argues there is no single answer to what makes a
 * neighbourhood good. This panel takes that idea into the quarterly: the
 * reader weights the site's own wellbeing categories and the index of fifty
 * re-ranks live, computed from the same direction-adjusted 0-100 scores the
 * map uses (snapshotted by build_equation_data.py).
 *
 * With every category at the middle setting the weights reproduce the site's
 * default equation, which matches the printed overall ranking for 48 of 50
 * wards exactly (the other two are a rounding-tie swap). Movement arrows are
 * always measured against that computed default, never against the printed
 * number, so the panel cannot disagree with itself.
 */

(function () {
  "use strict";

  var SITE = window.WARDWISE_SITE || {};

  function capitalize(str) {
    str = String(str || "");
    return str.charAt(0).toUpperCase() + str.slice(1);
  }

  var AREA_NOUN = capitalize(SITE.areaNoun || "ward"); // "Ward"

  var CHOICES = [
    { label: "Not really", value: 0 },
    { label: "Somewhat", value: 1 },
    { label: "A lot", value: 2 },
  ];

  var state = {
    data: null,          // equation.json
    baseline: null,      // ward id -> rank under the default equation
    original: null,      // index <li> nodes in printed (ward number) order
    items: null,         // ward id -> its <li> node
    printedRank: null,   // ward id -> the rank text the page shipped with
  };

  function ordinal(n) {
    var rem100 = n % 100;
    if (rem100 >= 11 && rem100 <= 13) return n + "th";
    return n + ["th", "st", "nd", "rd"][n % 10 > 3 ? 0 : n % 10];
  }

  function categoryWeights(form) {
    var weights = {};
    Object.keys(state.data.categories).forEach(function (cat) {
      var checked = form.querySelector('input[name="cat-' + cat + '"]:checked');
      weights[cat] = checked ? Number(checked.value) : 1;
    });
    return weights;
  }

  function compositeRanks(catWeights) {
    var metrics = state.data.metrics;
    var scores = state.data.scores;
    var byWard = {};
    var ids = Object.keys(scores);

    ids.forEach(function (ward) {
      var row = scores[ward];
      var num = 0;
      var den = 0;
      Object.keys(row).forEach(function (metricId) {
        var meta = metrics[metricId];
        if (!meta) return;
        var w = meta.weight * catWeights[meta.category];
        num += w * row[metricId];
        den += w;
      });
      byWard[ward] = den > 0 ? num / den : null;
    });

    var ranked = ids.filter(function (w) { return byWard[w] !== null; })
      .sort(function (a, b) { return byWard[b] - byWard[a]; });
    var ranks = {};
    ranked.forEach(function (ward, i) { ranks[ward] = i + 1; });
    return ranks;
  }

  function defaultWeights() {
    var weights = {};
    Object.keys(state.data.categories).forEach(function (cat) { weights[cat] = 1; });
    return weights;
  }

  function isDefault(weights) {
    return Object.keys(weights).every(function (cat) { return weights[cat] === 1; });
  }

  function buildForm(form) {
    var counts = {};
    Object.keys(state.data.metrics).forEach(function (metricId) {
      var cat = state.data.metrics[metricId].category;
      counts[cat] = (counts[cat] || 0) + 1;
    });

    var cats = Object.keys(state.data.categories).sort(function (a, b) {
      return state.data.categories[a].localeCompare(state.data.categories[b]);
    });

    form.innerHTML = cats.map(function (cat) {
      var legend = state.data.categories[cat] +
        ' <span class="equation-count">' + (counts[cat] || 0) + " measures</span>";
      var options = CHOICES.map(function (choice) {
        return (
          '<label class="equation-choice">' +
          '<input type="radio" name="cat-' + cat + '" value="' + choice.value + '"' +
          (choice.value === 1 ? " checked" : "") + ">" +
          "<span>" + choice.label + "</span></label>"
        );
      }).join("");
      return (
        '<fieldset class="equation-cat"><legend>' + legend + "</legend>" +
        '<div class="equation-choices">' + options + "</div></fieldset>"
      );
    }).join("") +
    '<button type="button" class="equation-reset" id="equation-reset">Back to the default equation</button>';
  }

  function restorePrinted(grid) {
    state.original.forEach(function (li) { grid.appendChild(li); });
    Object.keys(state.items).forEach(function (ward) {
      var li = state.items[ward];
      var rank = li.querySelector(".idx-rank");
      if (rank) rank.textContent = state.printedRank[ward];
      var move = li.querySelector(".idx-move");
      if (move) move.remove();
    });
  }

  function applyWeights(weights, grid, result) {
    if (isDefault(weights)) {
      restorePrinted(grid);
      result.hidden = true;
      return;
    }

    var ranks = compositeRanks(weights);
    var ordered = Object.keys(ranks).sort(function (a, b) { return ranks[a] - ranks[b]; });

    // Every category at "Not really" weights nothing, so there is nothing to
    // rank. Say so instead of rendering a ranking of zero wards.
    if (!ordered.length) {
      restorePrinted(grid);
      result.textContent =
        "With every category at Not really, no measure counts and there is " +
        "nothing to rank. The printed order below is the site's default.";
      result.hidden = false;
      return;
    }

    var biggestUp = null;
    var biggestDown = null;
    ordered.forEach(function (ward) {
      var li = state.items[ward];
      if (!li) return;
      grid.appendChild(li);

      var delta = state.baseline[ward] - ranks[ward];
      if (!biggestUp || delta > (state.baseline[biggestUp] - ranks[biggestUp])) biggestUp = ward;
      if (!biggestDown || delta < (state.baseline[biggestDown] - ranks[biggestDown])) biggestDown = ward;

      var rank = li.querySelector(".idx-rank");
      if (rank) rank.textContent = ordinal(ranks[ward]);

      var move = li.querySelector(".idx-move");
      if (!move) {
        move = document.createElement("span");
        move.className = "idx-move";
        (li.querySelector(".idx-meta") || li.querySelector("a")).appendChild(move);
      }
      if (delta > 0) {
        move.textContent = "▲" + delta;
        move.className = "idx-move is-up";
      } else if (delta < 0) {
        move.textContent = "▼" + (-delta);
        move.className = "idx-move is-down";
      } else {
        move.textContent = "";
        move.className = "idx-move";
      }
    });

    var leaderLi = state.items[ordered[0]];
    var leaderNum = leaderLi ? leaderLi.querySelector(".idx-num").textContent : ordered[0];
    // "leads the fifty" is per-city editorial prose (the count word, not the
    // area noun), left as a fixed literal on purpose. Wiring it to
    // SITE.areaNounPlural would change Chicago's rendered wording from "the
    // fifty" to "the wards", which is not this pass's job.
    var line = "Under your weights " + AREA_NOUN + " " + leaderNum + " leads the fifty.";
    var upDelta = state.baseline[biggestUp] - ranks[biggestUp];
    var downDelta = ranks[biggestDown] - state.baseline[biggestDown];
    if (upDelta > 0) {
      line += " Biggest riser " + AREA_NOUN + " " + Number(biggestUp) + ", up " + upDelta + " from the default.";
    }
    if (downDelta > 0) {
      line += " Biggest faller " + AREA_NOUN + " " + Number(biggestDown) + ", down " + downDelta + ".";
    }
    result.textContent = line;
    result.hidden = false;
  }

  function init(data) {
    state.data = data;
    state.baseline = compositeRanks(defaultWeights());

    var grid = document.getElementById("index-grid");
    var section = document.getElementById("equation");
    var form = document.getElementById("equation-form");
    var result = document.getElementById("equation-result");
    if (!grid || !section || !form || !result || !grid.children.length) return;

    state.original = Array.prototype.slice.call(grid.children);
    state.items = {};
    state.printedRank = {};
    state.original.forEach(function (li) {
      var href = li.querySelector("a").getAttribute("href") || "";
      var ward = href.replace("#ward-", "");
      state.items[ward] = li;
      var rank = li.querySelector(".idx-rank");
      state.printedRank[ward] = rank ? rank.textContent : "";
    });

    buildForm(form);
    // Delegated, because reset rebuilds the form's markup: the form node
    // itself is the only element guaranteed to survive.
    form.addEventListener("change", function () {
      applyWeights(categoryWeights(form), grid, result);
    });
    form.addEventListener("click", function (event) {
      if (event.target && event.target.id === "equation-reset") {
        buildForm(form);
        restorePrinted(grid);
        result.hidden = true;
      }
    });

    section.hidden = false;
  }

  var loaded = null;
  document.addEventListener("report:rendered", function () {
    if (loaded) return;
    loaded = fetch("data/equation.json", { headers: { Accept: "application/json" } })
      .then(function (res) {
        if (!res.ok) throw new Error("equation.json returned " + res.status);
        return res.json();
      })
      .then(init)
      .catch(function () {
        /* The printed report stands on its own; the panel just stays hidden. */
      });
  });
})();
