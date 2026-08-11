/* GENERATED FILE. Built from city.json by build_site_config.py, do not
 * edit by hand, your changes will be overwritten on the next build.
 *
 * Penlight has said it wants to expand beyond Chicago. Everything mechanical
 * about this site already travels: the pages are static, the data files are
 * built by scripts that take --api-base, and the scripts recompute ranks from
 * whatever matrix the API serves. What does not travel automatically is
 * language, so the editorial copy in the HTML is written per city on purpose.
 * See the "Another city" section of the README for the full list.
 */

window.WARDWISE_SITE = {
  city: "Chicago",
  state: "Illinois",
  areaNoun: "ward",
  areaNounPlural: "wards",
  areaCount: 50,
  officeTitle: "Alderperson",
  apiBase: "https://penlight.wardwise.org",
  siteBase: "https://penlight.wardwise.org",
  surveyUrl: "https://penlight.wardwise.org/survey",
  supportUrl: "https://penlight.wardwise.org/about",
  dictionaryUrl: "https://penlight.wardwise.org/dictionary",
  boundaryRedrawYear: 2023,
  unstableMetricPrefixes: ["c311_"],
  officeMetricPattern: "^menu_|^council_attendance_pct$|^nonroutine_bills_sponsored_current_session$|^participatory_budgeting$",
  probeAreaId: "42",
  defaultAreaId: "42",
  geocoder: {
    primaryLocatorUrl: "https://gisapps.chicago.gov/arcgis/rest/services/Chicago_Addresses/GeocodeServer",
    nominatimViewbox: "-87.95,42.03,-87.50,41.62",
    nominatimQuerySuffix: ", Chicago, Illinois"
  }
};
