/* One place for the facts that tie this site to a city.
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
  areaNoun: "ward",
  areaCount: 50,
  penlight: "https://penlight.wardwise.org",
  survey: "https://penlight.wardwise.org/survey",
  support: "https://penlight.wardwise.org/about",
};
