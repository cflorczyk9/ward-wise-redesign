/* Address lookup, in the browser.
 *
 * Upstream does this server-side in Flask (/geocode/suggest, /geocode/resolve,
 * /geocode). This site is static, so it talks to the same geocoders directly.
 * Both of them send permissive CORS headers, checked 2026-08-09:
 *
 *   gisapps.chicago.gov      access-control-allow-origin: <the calling origin>
 *   nominatim.openstreetmap  access-control-allow-origin: *
 *
 * The return shapes deliberately match what the Flask routes returned, so the
 * explorer's call sites change by one word and nothing else.
 *
 * On Nominatim: upstream proxied it partly to send a descriptive User-Agent,
 * which a browser will not let a page set. Chicago's own locator is tried
 * first and answers nearly every real address, so Nominatim is only reached
 * for the occasional neighborhood or landmark. If that ever draws rate
 * limiting, the fix is to drop the fallback rather than to add a server back.
 */

window.WardWiseGeocode = (function () {
  "use strict";

  var CHICAGO =
    "https://gisapps.chicago.gov/arcgis/rest/services/Chicago_Addresses/GeocodeServer";
  var NOMINATIM = "https://nominatim.openstreetmap.org/search";
  var VIEWBOX = "-87.95,42.03,-87.50,41.62"; // Chicago, as Nominatim wants it

  function getJson(url, timeoutMs) {
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, timeoutMs || 8000);
    return fetch(url, { signal: controller.signal, headers: { Accept: "application/json" } })
      .then(function (response) {
        if (!response.ok) throw new Error("Lookup failed (" + response.status + ").");
        return response.json();
      })
      .finally(function () { clearTimeout(timer); });
  }

  // Autocomplete against the city's address points. Returns {suggestions: [...]}.
  function suggest(query) {
    var text = String(query || "").trim();
    if (text.length < 3) return Promise.resolve({ suggestions: [] });

    var url = CHICAGO + "/suggest?f=json&maxSuggestions=6&text=" + encodeURIComponent(text);
    return getJson(url, 6000).then(function (data) {
      var raw = (data && data.suggestions) || [];
      var out = [];
      for (var i = 0; i < raw.length && out.length < 6; i += 1) {
        if (raw[i].text && !raw[i].isCollection) {
          out.push({ label: raw[i].text, key: raw[i].magicKey });
        }
      }
      return { suggestions: out };
    });
  }

  // Turn a picked suggestion into coordinates. Returns {match: {...}|null}.
  function resolve(text, key) {
    var label = String(text || "").trim();
    if (!label) return Promise.resolve({ match: null });

    var url =
      CHICAGO + "/findAddressCandidates?f=json&outSR=4326&maxLocations=1&SingleLine=" +
      encodeURIComponent(label) + (key ? "&magicKey=" + encodeURIComponent(key) : "");

    return getJson(url, 6000).then(function (data) {
      var candidates = (data && data.candidates) || [];
      if (!candidates.length) return { match: null };
      var top = candidates[0];
      return {
        match: {
          lat: top.location.y,
          lon: top.location.x,
          label: top.address || label,
        },
      };
    });
  }

  // One-shot lookup for whatever was typed. The city locator is authoritative
  // for addresses, so it goes first; Nominatim picks up neighborhoods and
  // landmarks it does not carry.
  function search(query) {
    var text = String(query || "").trim();
    if (!text) return Promise.resolve({ match: null });

    return resolve(text, null)
      .then(function (result) {
        if (result.match) return result;
        var url =
          NOMINATIM + "?format=jsonv2&limit=1&bounded=1&viewbox=" + encodeURIComponent(VIEWBOX) +
          "&q=" + encodeURIComponent(text + ", Chicago, Illinois");
        return getJson(url, 8000).then(function (rows) {
          if (!rows || !rows.length) return { match: null };
          return {
            match: {
              lat: parseFloat(rows[0].lat),
              lon: parseFloat(rows[0].lon),
              label: rows[0].display_name || text,
            },
          };
        });
      })
      .catch(function () { return { match: null }; });
  }

  return { suggest: suggest, resolve: resolve, search: search };
})();
