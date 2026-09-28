// Ward Wise MCP server: tool definitions and Penlight API helpers.
//
// One rule drives most of this file: build a fresh McpServer on every call to buildServer(),
// because a stateless Streamable HTTP transport can only handle one request, and an McpServer
// can only be connected to one transport at a time. netlify/functions/mcp.mjs calls
// buildServer() per invocation. Module-scope caching below (the manifest, the ward polygons,
// the ward and community area lists) survives across invocations only when Netlify reuses a
// warm container, which is a bonus, not something the correctness of any tool depends on.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const API_BASE = (process.env.PENLIGHT_API_BASE || "https://penlight.wardwise.org").replace(/\/+$/, "");
const WEBSITE_URL = "https://wardwise-redesign.netlify.app";
const LIVE_SITE_BASE = "https://penlight.wardwise.org";
const FETCH_TIMEOUT_MS = 15000;
const CACHE_TTL_MS = 10 * 60 * 1000;
const CENSUS_ONELINE = "https://geocoding.geo.census.gov/geocoder/locations/onelineaddress";

const CATEGORIES = [
  "community_vitality",
  "culture",
  "good_governance",
  "health",
  "lifelong_learning",
  "material_wellbeing",
  "physical_environment",
  "psychological_wellbeing",
  "religion_spiritual",
  "social_connectedness",
  "time_balance"
];

const CAVEAT_TEXT = {
  modeled: "A statistical small-area model estimate, not a direct measurement.",
  areal_allocation: "Allocated from a larger source area by geographic overlap, not measured at this boundary directly.",
  acs_5yr: "Based on a five year Census survey average, not a single year snapshot.",
  current_boundaries: "Earlier years are recalculated onto today's ward or community area lines.",
  forward_carried: "The newest year repeats the last real measurement because a newer one is not out yet.",
  small_base: "Based on a small sample, so the value can swing on a handful of records."
};

// ---------------------------------------------------------------------------
// Fetch helpers
// ---------------------------------------------------------------------------

async function timeoutFetch(url, options = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

class UpstreamError extends Error {}

async function fetchUpstream(path, params) {
  const url = new URL(`${API_BASE}/api${path}`);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null || value === "") continue;
      url.searchParams.set(key, String(value));
    }
  }
  let response;
  try {
    response = await timeoutFetch(url);
  } catch (error) {
    if (error.name === "AbortError") {
      throw new UpstreamError(`Penlight API timed out after ${FETCH_TIMEOUT_MS / 1000} seconds calling ${url.pathname}.`);
    }
    throw new UpstreamError(`Could not reach the Penlight API at ${url.pathname}. ${error.message || error}`);
  }
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new UpstreamError(
      `Penlight API returned ${response.status} for ${url.pathname}${url.search}.${text ? ` ${text.slice(0, 200)}` : ""}`
    );
  }
  return response.json();
}

// ---------------------------------------------------------------------------
// Module-scope caches (short TTL, best effort across warm invocations)
// ---------------------------------------------------------------------------

const cache = {
  manifest: null,
  manifestAt: 0,
  wardsGeo: null,
  wardsGeoAt: 0,
  wardsList: null,
  wardsListAt: 0,
  communityAreas: null,
  communityAreasAt: 0
};

function fresh(entry, at) {
  return entry !== null && Date.now() - at < CACHE_TTL_MS;
}

async function getManifest() {
  if (fresh(cache.manifest, cache.manifestAt)) return cache.manifest;
  const data = await fetchUpstream("/explorer/manifest");
  cache.manifest = data;
  cache.manifestAt = Date.now();
  return data;
}

async function getWardsGeoJson() {
  if (fresh(cache.wardsGeo, cache.wardsGeoAt)) return cache.wardsGeo;
  const data = await fetchUpstream("/wards.geojson");
  cache.wardsGeo = data;
  cache.wardsGeoAt = Date.now();
  return data;
}

async function getWardsList() {
  if (fresh(cache.wardsList, cache.wardsListAt)) return cache.wardsList;
  const data = await fetchUpstream("/explorer/wards");
  cache.wardsList = data;
  cache.wardsListAt = Date.now();
  return data;
}

async function getCommunityAreasList() {
  if (fresh(cache.communityAreas, cache.communityAreasAt)) return cache.communityAreas;
  const data = await fetchUpstream("/community-areas");
  cache.communityAreas = data;
  cache.communityAreasAt = Date.now();
  return data;
}

async function getAreaNameMap(areaType) {
  if (areaType === "ward") {
    const data = await getWardsList();
    return new Map(data.wards.map((w) => [w.ward_id, w.display_name]));
  }
  const data = await getCommunityAreasList();
  return new Map(data.community_areas.map((c) => [c.community_area_id, c.display_name || c.name]));
}

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

function errorResult(message) {
  return { isError: true, content: [{ type: "text", text: message }] };
}

function normalizeAreaId(input, max) {
  if (input === undefined || input === null) return null;
  const match = String(input).match(/\d+/);
  if (!match) return null;
  const n = Number(match[0]);
  if (!Number.isInteger(n) || n < 1 || n > max) return null;
  return String(n).padStart(2, "0");
}

const normalizeWardId = (input) => normalizeAreaId(input, 50);
const normalizeCommunityAreaId = (input) => normalizeAreaId(input, 77);

function round(value, decimals = 2) {
  if (typeof value !== "number" || !Number.isFinite(value)) return value === undefined ? null : value;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function roundForUnit(value, unit) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (unit === "currency" || unit === "USD" || unit === "count" || unit === "units") {
    return Math.round(value);
  }
  return round(value, 2);
}

// Values as a reader would say them: $137,022, 48.97%, 59,956, 12.4 miles.
function fmtValue(value, unit) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "no data";
  const n = roundForUnit(value, unit);
  const grouped = n.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (unit === "currency" || unit === "USD") return `${n < 0 ? "-" : ""}$${Math.abs(n).toLocaleString("en-US")}`;
  if (unit === "percent") return `${grouped}%`;
  if (unit === "count" || unit === "units") return grouped;
  return `${grouped} ${String(unit).replaceAll("_", " ")}`;
}

// A change in a value, so percent metrics read as points and money keeps its dollar sign.
function fmtChange(value, unit) {
  const abs = Math.abs(value);
  if (unit === "percent") return `${roundForUnit(abs, unit).toLocaleString("en-US", { maximumFractionDigits: 2 })} points`;
  return fmtValue(abs, unit);
}

function latestYear(manifest, metricId) {
  const years = manifest.metric_data_years?.[metricId];
  return Array.isArray(years) && years.length ? Math.max(...years) : null;
}

function median(values) {
  const nums = values.filter((v) => typeof v === "number" && Number.isFinite(v)).sort((a, b) => a - b);
  if (!nums.length) return null;
  const mid = Math.floor(nums.length / 2);
  return nums.length % 2 ? nums[mid] : round((nums[mid - 1] + nums[mid]) / 2, 4);
}

function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[m][n];
}

function findCloseMetrics(query, metrics, limit = 5) {
  const q = String(query).toLowerCase().trim();
  const qSpaced = q.replace(/[_-]+/g, " ");
  const qUnderscored = q.replace(/\s+/g, "_");
  const scored = metrics.map((m) => {
    const id = m.metric_id.toLowerCase();
    const label = (m.label || "").toLowerCase();
    let score = levenshtein(q, id);
    if (label.includes(qSpaced) || id.includes(qUnderscored)) score -= 25;
    if (id.startsWith(q) || q.startsWith(id.slice(0, Math.min(6, id.length)))) score -= 5;
    return { id: m.metric_id, score };
  });
  scored.sort((a, b) => a.score - b.score);
  return scored.slice(0, limit).map((s) => s.id);
}

function getMetricCaveats(manifest, areaType, metricId) {
  const keys = manifest.metric_methodology?.[areaType]?.[metricId] || [];
  return keys.map((key) => ({ key, note: CAVEAT_TEXT[key] || key }));
}

function isModeled(manifest, areaType, metricId) {
  return (manifest.metric_methodology?.[areaType]?.[metricId] || []).includes("modeled");
}

function dictionaryUrl(metricId) {
  return `${WEBSITE_URL}/dictionary#metric-entry-${encodeURIComponent(metricId)}`;
}

function wardReportUrl(wardId) {
  return `${LIVE_SITE_BASE}/report/ward/${wardId}`;
}

async function validateMetricIds(ids) {
  const manifest = await getManifest();
  const known = new Map(manifest.metrics.map((m) => [m.metric_id, m]));
  const valid = [];
  const invalid = [];
  for (const id of ids) {
    if (known.has(id)) valid.push(id);
    else invalid.push(id);
  }
  return { manifest, known, valid, invalid };
}

function metricIdErrorText(invalidIds, manifest) {
  const lines = invalidIds.map((id) => {
    const close = findCloseMetrics(id, manifest.metrics, 5);
    return `"${id}" is not a known metric id. Closest matches are ${close.join(", ")}.`;
  });
  return `${lines.join("\n")}\nUse search_metrics to browse valid metric ids and their labels.`;
}

// ---------------------------------------------------------------------------
// Point-in-polygon (ray casting, handles Polygon and MultiPolygon with holes)
// ---------------------------------------------------------------------------

function pointInRing(point, ring) {
  const [x, y] = point;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const crosses = yi > y !== yj > y;
    if (crosses) {
      const xIntersect = ((xj - xi) * (y - yi)) / (yj - yi) + xi;
      if (x < xIntersect) inside = !inside;
    }
  }
  return inside;
}

function pointInPolygonCoords(point, coords) {
  if (!coords.length || !pointInRing(point, coords[0])) return false;
  for (let i = 1; i < coords.length; i++) {
    if (pointInRing(point, coords[i])) return false;
  }
  return true;
}

function pointInGeometry(point, geometry) {
  if (!geometry) return false;
  if (geometry.type === "Polygon") return pointInPolygonCoords(point, geometry.coordinates);
  if (geometry.type === "MultiPolygon") return geometry.coordinates.some((poly) => pointInPolygonCoords(point, poly));
  return false;
}

function findWardForPoint(lon, lat, geojson) {
  for (const feature of geojson.features) {
    if (pointInGeometry([lon, lat], feature.geometry)) return feature.properties;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Server + tools
// ---------------------------------------------------------------------------

export function buildServer() {
  const server = new McpServer(
    {
      name: "wardwise",
      title: "Ward Wise",
      version: "0.1.0",
      websiteUrl: WEBSITE_URL,
      icons: [
        { src: `${WEBSITE_URL}/static/logo.svg`, mimeType: "image/svg+xml" },
        { src: `${WEBSITE_URL}/static/favicon-32.png`, mimeType: "image/png", sizes: ["32x32"] },
        { src: `${WEBSITE_URL}/static/apple-touch-icon.png`, mimeType: "image/png", sizes: ["180x180"] }
      ]
    },
    {
      capabilities: { tools: {} },
      instructions:
        "Ward Wise reports civic wellbeing data for the City of Chicago. " +
        "It covers 50 wards, 77 community areas, and 271 measures pulled from public sources through Penlight. " +
        "Most measures are direct counts or survey figures. A few measures are modeled statistical estimates " +
        "rather than direct measurements, and those come back with an estimate caveat attached. " +
        "Always cite the source given with each value when you share it."
    }
  );

  const readOnlyAnnotations = (title) => ({ title, readOnlyHint: true, openWorldHint: true, idempotentHint: true });

  // --- 1. search_metrics -----------------------------------------------------

  server.registerTool(
    "search_metrics",
    {
      title: "Search metrics",
      description:
        "Search the 271 Ward Wise measures by keyword, wellbeing category, or geography. " +
        "Use this first to find a metric id before calling another tool.",
      inputSchema: {
        query: z.string().optional().describe("Text to match against the metric label and description, e.g. \"walking at night\""),
        area_type: z.enum(["ward", "community_area", "chi"]).optional().describe("Only show metrics measured at this geography"),
        category: z.enum(CATEGORIES).optional().describe("Only show metrics in this wellbeing category"),
        limit: z.number().int().min(1).max(25).optional().describe("Max results to return, default 15")
      },
      outputSchema: {
        query: z.string().nullable(),
        area_type: z.string().nullable(),
        category: z.string().nullable(),
        total_matches: z.number().int(),
        shown: z.number().int(),
        metrics: z.array(
          z.object({
            metric_id: z.string(),
            label: z.string(),
            description: z.string().nullable(),
            unit: z.string(),
            direction: z.enum(["higher", "lower"]),
            category: z.string(),
            source: z.string().nullable(),
            source_url: z.string().nullable(),
            modeled: z.boolean(),
            available_at: z.array(z.string()),
            dictionary_url: z.string()
          })
        )
      },
      annotations: readOnlyAnnotations("Search metrics")
    },
    async ({ query, area_type, category, limit }) => {
      try {
        const manifest = await getManifest();
        let results = manifest.metrics;
        if (category) results = results.filter((m) => m.category === category);
        if (area_type) results = results.filter((m) => (manifest.metric_area_types[m.metric_id] || []).includes(area_type));
        if (query) {
          const q = query.toLowerCase();
          results = results.filter(
            (m) =>
              m.metric_id.toLowerCase().includes(q) ||
              (m.label || "").toLowerCase().includes(q) ||
              (m.description || "").toLowerCase().includes(q)
          );
        }
        const cap = limit || 15;
        const trimmed = results.slice(0, cap);
        const metrics = trimmed.map((m) => {
          const modeledAny = ["ward", "community_area", "chi"].some((at) => isModeled(manifest, at, m.metric_id));
          return {
            metric_id: m.metric_id,
            label: m.label,
            description: m.description || null,
            unit: m.unit,
            direction: m.direction,
            category: m.category,
            source: m.source || null,
            source_url: m.source_url || null,
            modeled: modeledAny,
            available_at: manifest.metric_area_types[m.metric_id] || [],
            dictionary_url: dictionaryUrl(m.metric_id)
          };
        });
        const summaryLines = metrics.map((m) => `- ${m.label} (${m.metric_id}), ${m.unit}${m.modeled ? ", modeled estimate" : ""}`);
        const summary =
          `${results.length} metric${results.length === 1 ? "" : "s"} matched` +
          `${results.length > cap ? `, showing the first ${cap}` : ""}.\n` +
          summaryLines.join("\n") +
          (query && /population|residents|people live/i.test(query)
            ? "\nWard Wise has no population measure over time. ward_profile gives each ward's current population as one number."
            : "");
        return {
          content: [{ type: "text", text: summary }],
          structuredContent: {
            query: query || null,
            area_type: area_type || null,
            category: category || null,
            total_matches: results.length,
            shown: metrics.length,
            metrics
          }
        };
      } catch (error) {
        return errorResult(`search_metrics failed. ${error.message || error}`);
      }
    }
  );

  // --- 2. ward_profile ---------------------------------------------------------

  server.registerTool(
    "ward_profile",
    {
      title: "Ward profile",
      description:
        "Get a compact profile for one Chicago ward, including its alderperson, population, its biggest community area " +
        "overlaps, and a count of mapped places by category. Accepts a ward number 1 through 50.",
      inputSchema: {
        ward: z.union([z.string(), z.number()]).describe("Ward number, 1 through 50, e.g. 5 or \"05\""),
        include_places: z.boolean().optional().describe("Also include a short list of featured places in the ward, default false")
      },
      outputSchema: {
        ward_id: z.string(),
        ward_number: z.number().int(),
        display_name: z.string(),
        population: z.number().int().nullable(),
        alderperson: z.object({
          name: z.string().nullable(),
          title: z.string().nullable(),
          email: z.string().nullable(),
          website_url: z.string().nullable(),
          city_hall_office: z.string().nullable(),
          ward_office: z.string().nullable()
        }),
        top_community_area_overlaps: z.array(
          z.object({ name: z.string(), ward_area_pct: z.number().nullable(), community_area_pct: z.number().nullable() })
        ),
        places_summary: z.object({ total_count: z.number().int(), counts_by_category: z.record(z.string(), z.number()) }),
        featured_places: z
          .array(z.object({ name: z.string(), category: z.string(), address: z.string().nullable() }))
          .optional(),
        full_report_url: z.string()
      },
      annotations: readOnlyAnnotations("Ward profile")
    },
    async ({ ward, include_places }) => {
      try {
        const wardId = normalizeWardId(ward);
        if (!wardId) return errorResult(`"${ward}" is not a valid ward number. Chicago wards run 1 through 50.`);
        const data = await fetchUpstream(`/wards/${wardId}`);
        const w = data.ward;
        const alderperson = data.alderperson || {};
        const overlaps = [...(w.community_area_overlaps || [])]
          .sort((a, b) => (b.ward_area_pct || 0) - (a.ward_area_pct || 0))
          .slice(0, 3)
          .map((o) => ({ name: o.name, ward_area_pct: round(o.ward_area_pct), community_area_pct: round(o.community_area_pct) }));
        const structuredContent = {
          ward_id: w.ward_id,
          ward_number: w.ward_number,
          display_name: w.display_name,
          population: w.population ?? null,
          alderperson: {
            name: alderperson.name || null,
            title: alderperson.title || null,
            email: alderperson.email || null,
            website_url: alderperson.website_url || null,
            city_hall_office: alderperson.city_hall_office
              ? `${alderperson.city_hall_office.address}, ${alderperson.city_hall_office.city} ${alderperson.city_hall_office.state} ${alderperson.city_hall_office.zipcode}`
              : null,
            ward_office: alderperson.ward_office
              ? `${alderperson.ward_office.address}, ${alderperson.ward_office.city} ${alderperson.ward_office.state} ${alderperson.ward_office.zipcode}`
              : null
          },
          top_community_area_overlaps: overlaps,
          places_summary: {
            total_count: w.poi_summary?.total_count ?? 0,
            counts_by_category: w.poi_summary?.counts_by_category || {}
          },
          full_report_url: wardReportUrl(w.ward_id)
        };
        if (include_places) {
          const places = await fetchUpstream(`/wards/${wardId}/places`);
          structuredContent.featured_places = (places.ward_places?.featured_places || [])
            .slice(0, 10)
            .map((p) => ({ name: p.name, category: p.category, address: p.address || null }));
        }
        const text =
          `${structuredContent.display_name}, population ${structuredContent.population != null ? structuredContent.population.toLocaleString("en-US") : "unknown"}. ` +
          `Alderperson ${structuredContent.alderperson.name || "unlisted"}. ` +
          `${overlaps[0] ? `Its largest community area overlap is ${overlaps[0].name}, ${overlaps[0].ward_area_pct}% of the ward.` : "It has no community area overlap on record."} ` +
          `${structuredContent.places_summary.total_count} mapped places. Full report at ${structuredContent.full_report_url}.`;
        return { content: [{ type: "text", text }], structuredContent };
      } catch (error) {
        return errorResult(`ward_profile failed. ${error.message || error}`);
      }
    }
  );

  // --- 3. rank_wards -------------------------------------------------------------

  server.registerTool(
    "rank_wards",
    {
      title: "Rank wards or community areas",
      description:
        "Rank Chicago wards or community areas by one measure's raw value, or by a weighted composite wellbeing score " +
        "built from several measures. Leave metric_ids empty to use Ward Wise's own default composite score.",
      inputSchema: {
        metric_ids: z.array(z.string()).optional().describe("One or more metric ids. Omit for the site's default composite score."),
        weights: z
          .record(z.string(), z.number())
          .optional()
          .describe(
            "Optional weight per metric id. Passing any weight switches rank_wards from ranking one metric's " +
              "raw value to building a weighted composite score, even with a single metric id."
          ),
        area_type: z.enum(["ward", "community_area"]).optional().describe("Default ward"),
        top_n: z.number().int().min(1).max(77).optional().describe("How many areas to return, default 10"),
        direction: z.enum(["best", "worst"]).optional().describe("Show the top or the bottom of the ranking, default best")
      },
      outputSchema: {
        area_type: z.string(),
        ranking_type: z.enum(["single_metric_value", "composite_score"]),
        metric_ids: z.array(z.string()),
        direction: z.enum(["best", "worst"]),
        total_areas: z.number().int(),
        source: z.string().nullable().optional(),
        source_url: z.string().nullable().optional(),
        modeled: z.boolean().optional(),
        estimate_caveat: z.string().nullable().optional(),
        metric_sources: z
          .array(
            z.object({
              metric_id: z.string(),
              label: z.string(),
              source: z.string().nullable(),
              source_url: z.string().nullable(),
              modeled: z.boolean(),
              estimate_caveat: z.string().nullable()
            })
          )
          .optional(),
        composite_sources_note: z.string().optional(),
        results: z.array(
          z.object({
            area_id: z.string(),
            display_name: z.string().nullable(),
            rank: z.number().int(),
            value: z.number().nullable().optional(),
            score: z.number().nullable().optional()
          })
        )
      },
      annotations: readOnlyAnnotations("Rank wards or community areas")
    },
    async ({ metric_ids, weights, area_type, top_n, direction }) => {
      try {
        const areaType = area_type || "ward";
        const dir = direction || "best";
        const n = top_n || 10;
        const idsToCheck = [...new Set([...(metric_ids || []), ...Object.keys(weights || {})])];
        let manifest;
        if (idsToCheck.length) {
          const validation = await validateMetricIds(idsToCheck);
          if (validation.invalid.length) return errorResult(metricIdErrorText(validation.invalid, validation.manifest));
          manifest = validation.manifest;
        } else {
          manifest = await getManifest();
        }
        const nameMap = await getAreaNameMap(areaType);

        // A single metric with no explicit weights: rank the raw value, not a normalized score.
        if (metric_ids && metric_ids.length === 1 && !weights) {
          const metricId = metric_ids[0];
          const available = manifest.metric_area_types[metricId] || [];
          if (!available.includes(areaType)) {
            return errorResult(`"${metricId}" is not measured at the ${areaType} level. It is available at ${available.join(", ") || "no geography"}.`);
          }
          const metricObj = manifest.metrics.find((m) => m.metric_id === metricId);
          const caveats = getMetricCaveats(manifest, areaType, metricId);
          const modeledMetric = caveats.some((c) => c.key === "modeled");
          const comparison = await fetchUpstream("/metrics/comparison", { metrics: metricId, area_type: areaType });
          const rows = comparison.rows.filter((r) => typeof r.values[metricId] === "number");
          const higherIsBetter = metricObj.direction === "higher";
          const sortedBest = [...rows].sort((a, b) => {
            const av = a.values[metricId];
            const bv = b.values[metricId];
            return higherIsBetter ? bv - av : av - bv;
          });
          sortedBest.forEach((r, i) => {
            r._rank = i + 1;
          });
          const ordered = dir === "worst" ? [...sortedBest].reverse() : sortedBest;
          const results = ordered.slice(0, n).map((r) => ({
            area_id: r.area_id,
            display_name: nameMap.get(r.area_id) || r.display_name || null,
            rank: r._rank,
            value: roundForUnit(r.values[metricId], metricObj.unit)
          }));
          const sourceLine =
            `Source is ${metricObj.source || "not on file"}.` + (modeledMetric ? ` ${CAVEAT_TEXT.modeled}` : "");
          const text =
            `Ranked by ${metricObj.label} (${dir === "worst" ? "lowest" : "best"} first), ${areaType} level, ${sortedBest.length} areas${latestYear(manifest, metricId) ? `, ${latestYear(manifest, metricId)} data` : ""}.\n` +
            results.map((r) => `${r.rank}. ${r.display_name}, ${fmtValue(r.value, metricObj.unit)}`).join("\n") +
            `\n${sourceLine}`;
          return {
            content: [{ type: "text", text }],
            structuredContent: {
              area_type: areaType,
              ranking_type: "single_metric_value",
              metric_ids: [metricId],
              direction: dir,
              total_areas: sortedBest.length,
              source: metricObj.source || null,
              source_url: metricObj.source_url || null,
              modeled: modeledMetric,
              estimate_caveat: modeledMetric ? CAVEAT_TEXT.modeled : null,
              results
            }
          };
        }

        // Otherwise: composite score from /api/metrics/scores, weighted if metric_ids/weights given,
        // or the site's own default weights when both are omitted.
        const params = { area_type: areaType };
        const weightIds = metric_ids && metric_ids.length ? metric_ids : Object.keys(weights || {});
        for (const id of weightIds) {
          const w = weights && weights[id] !== undefined ? weights[id] : 1;
          params[`weight_${id}`] = w;
        }
        const scores = await fetchUpstream("/metrics/scores", params);
        const sorted = [...scores.scores].sort((a, b) => (dir === "worst" ? a.rank - b.rank : a.rank - b.rank));
        // API ranks best-first already (rank 1 = best). For "worst" we want the bottom of the ranking.
        const total = sorted.length;
        const ordered = dir === "worst" ? [...sorted].sort((a, b) => b.rank - a.rank) : sorted.sort((a, b) => a.rank - b.rank);
        const results = ordered.slice(0, n).map((s) => ({
          area_id: s.area_id,
          display_name: nameMap.get(s.area_id) || null,
          rank: s.rank,
          score: round(s.score)
        }));

        // Composite mode: when the caller named specific input metrics, list each one's own
        // source and flag any that are modeled. The true site default (no metric_ids, no
        // weights) blends all 271 measures with their own default weights, too many to list
        // one by one, so it gets a plain note pointing at metric_detail instead.
        let metricSources = [];
        let compositeSourcesNote;
        if (weightIds.length) {
          metricSources = weightIds.map((id) => {
            const mObj = manifest.metrics.find((m) => m.metric_id === id);
            const mCaveats = getMetricCaveats(manifest, areaType, id);
            const mModeled = mCaveats.some((c) => c.key === "modeled");
            return {
              metric_id: id,
              label: mObj ? mObj.label : id,
              source: mObj && mObj.source ? mObj.source : null,
              source_url: mObj && mObj.source_url ? mObj.source_url : null,
              modeled: mModeled,
              estimate_caveat: mModeled ? CAVEAT_TEXT.modeled : null
            };
          });
        } else {
          compositeSourcesNote =
            "This is Ward Wise's own default composite score. It blends all 271 measures with their own default " +
            "weights. Call metric_detail on one measure id to see its source and whether it is modeled.";
        }
        const modeledInputs = metricSources.filter((m) => m.modeled);
        const sourceLines = weightIds.length
          ? metricSources.map((m) => `${m.label} source is ${m.source || "not on file"}.`).join(" ") +
            (modeledInputs.length
              ? ` Modeled inputs are ${modeledInputs.map((m) => m.label).join(", ")}. ${CAVEAT_TEXT.modeled}`
              : "")
          : compositeSourcesNote;

        const text =
          `${weightIds.length ? `Composite score from ${weightIds.length} weighted measure${weightIds.length === 1 ? "" : "s"}` : "Ward Wise's default composite wellbeing score"}, ${areaType} level, ${dir === "worst" ? "lowest" : "best"} first, ${total} areas.\n` +
          results.map((r) => `${r.rank}. ${r.display_name}, score ${r.score} of 100`).join("\n") +
          `\n${sourceLines}`;
        return {
          content: [{ type: "text", text }],
          structuredContent: {
            area_type: areaType,
            ranking_type: "composite_score",
            metric_ids: weightIds,
            direction: dir,
            total_areas: total,
            metric_sources: metricSources.length ? metricSources : undefined,
            composite_sources_note: weightIds.length ? undefined : compositeSourcesNote,
            results
          }
        };
      } catch (error) {
        return errorResult(`rank_wards failed. ${error.message || error}`);
      }
    }
  );

  // --- 4. compare_areas_on_metric --------------------------------------------------

  server.registerTool(
    "compare_areas_on_metric",
    {
      title: "Compare areas on one metric",
      description:
        "Get one measure's value for a set of wards or community areas, or for all of them, along with the citywide " +
        "median so a single number has context.",
      inputSchema: {
        metric_id: z.string().describe("A metric id from search_metrics or metric_detail"),
        areas: z
          .array(z.union([z.string(), z.number()]))
          .optional()
          .describe("Ward or community area numbers to include. Omit to return every area."),
        area_type: z.enum(["ward", "community_area"]).optional().describe("Default ward")
      },
      outputSchema: {
        metric_id: z.string(),
        area_type: z.string(),
        unit: z.string(),
        direction: z.enum(["higher", "lower"]),
        source: z.string().nullable(),
        source_url: z.string().nullable(),
        modeled: z.boolean(),
        estimate_caveat: z.string().nullable(),
        citywide_median: z.number().nullable(),
        total_areas: z.number().int(),
        shown: z.number().int(),
        areas: z.array(z.object({ area_id: z.string(), display_name: z.string(), value: z.number().nullable() })),
        dictionary_url: z.string()
      },
      annotations: readOnlyAnnotations("Compare areas on one metric")
    },
    async ({ metric_id, areas, area_type }) => {
      try {
        const areaType = area_type || "ward";
        const { manifest, invalid } = await validateMetricIds([metric_id]);
        if (invalid.length) return errorResult(metricIdErrorText(invalid, manifest));
        const metricObj = manifest.metrics.find((m) => m.metric_id === metric_id);
        const available = manifest.metric_area_types[metric_id] || [];
        if (!available.includes(areaType)) {
          return errorResult(`"${metric_id}" is not measured at the ${areaType} level. It is available at ${available.join(", ") || "no geography"}.`);
        }
        const comparison = await fetchUpstream("/metrics/comparison", { metrics: metric_id, area_type: areaType });
        const allRows = comparison.rows;
        const cityMedian = median(allRows.map((r) => r.values[metric_id]));

        let rows = allRows;
        if (areas && areas.length) {
          const wantedIds = new Set(
            areas.map((a) => (areaType === "ward" ? normalizeWardId(a) : normalizeCommunityAreaId(a))).filter(Boolean)
          );
          rows = allRows.filter((r) => wantedIds.has(r.area_id));
        }
        const cap = 50;
        const shownRows = rows.slice(0, cap);
        const caveats = getMetricCaveats(manifest, areaType, metric_id);
        const modeled = caveats.some((c) => c.key === "modeled");
        const structuredContent = {
          metric_id,
          area_type: areaType,
          unit: metricObj.unit,
          direction: metricObj.direction,
          source: metricObj.source || null,
          source_url: metricObj.source_url || null,
          modeled,
          estimate_caveat: modeled ? CAVEAT_TEXT.modeled : null,
          citywide_median: roundForUnit(cityMedian, metricObj.unit),
          total_areas: rows.length,
          shown: shownRows.length,
          areas: shownRows.map((r) => ({
            area_id: r.area_id,
            display_name: r.display_name,
            value: roundForUnit(r.values[metric_id], metricObj.unit)
          })),
          dictionary_url: dictionaryUrl(metric_id)
        };
        const text =
          `${metricObj.label}${latestYear(manifest, metric_id) ? `, ${latestYear(manifest, metric_id)} data` : ""}${modeled ? ", modeled estimate" : ""}. Citywide median ${fmtValue(structuredContent.citywide_median, metricObj.unit)}. Source is ${metricObj.source}.\n` +
          structuredContent.areas.map((a) => `${a.display_name}, ${fmtValue(a.value, metricObj.unit)}`).join("\n") +
          (rows.length > cap ? `\n(showing ${cap} of ${rows.length} areas)` : "");
        return { content: [{ type: "text", text }], structuredContent };
      } catch (error) {
        return errorResult(`compare_areas_on_metric failed. ${error.message || error}`);
      }
    }
  );

  // --- 5. metric_trend --------------------------------------------------------------

  server.registerTool(
    "metric_trend",
    {
      title: "Metric trend over time",
      description:
        "Get one measure's history for one area, either its full year-by-year series or, when both a from year " +
        "and a to year are given, a two-point change compared with the citywide change over the same span.",
      inputSchema: {
        metric_id: z.string().describe("A metric id from search_metrics or metric_detail"),
        area: z.union([z.string(), z.number()]).describe("Ward or community area number"),
        area_type: z.enum(["ward", "community_area"]).optional().describe("Default ward"),
        from_year: z.number().int().optional().describe("Start year, for a two point change"),
        to_year: z.number().int().optional().describe("End year, for a two point change")
      },
      outputSchema: {
        metric_id: z.string(),
        area_id: z.string(),
        area_type: z.string(),
        mode: z.enum(["series", "delta"]),
        unit: z.string(),
        source: z.string().nullable(),
        source_url: z.string().nullable(),
        modeled: z.boolean(),
        estimate_caveat: z.string().nullable(),
        series: z.array(z.object({ year: z.number().int().nullable(), value: z.number().nullable() })).optional(),
        from_year: z.number().int().optional(),
        to_year: z.number().int().optional(),
        from_value: z.number().nullable().optional(),
        to_value: z.number().nullable().optional(),
        delta: z.number().nullable().optional(),
        delta_vs_city: z.number().nullable().optional(),
        city_delta: z.number().nullable().optional()
      },
      annotations: readOnlyAnnotations("Metric trend over time")
    },
    async ({ metric_id, area, area_type, from_year, to_year }) => {
      try {
        const areaType = area_type || "ward";
        const { manifest, invalid } = await validateMetricIds([metric_id]);
        if (invalid.length) return errorResult(metricIdErrorText(invalid, manifest));
        const metricObj = manifest.metrics.find((m) => m.metric_id === metric_id);
        const available = manifest.metric_area_types[metric_id] || [];
        if (!available.includes(areaType)) {
          return errorResult(`"${metric_id}" is not measured at the ${areaType} level. It is available at ${available.join(", ") || "no geography"}.`);
        }
        const areaId = areaType === "ward" ? normalizeWardId(area) : normalizeCommunityAreaId(area);
        if (!areaId) return errorResult(`"${area}" is not a valid ${areaType === "ward" ? "ward number (1-50)" : "community area number (1-77)"}.`);
        const caveats = getMetricCaveats(manifest, areaType, metric_id);
        const modeled = caveats.some((c) => c.key === "modeled");
        const base = {
          metric_id,
          area_id: areaId,
          area_type: areaType,
          unit: metricObj.unit,
          source: metricObj.source || null,
          source_url: metricObj.source_url || null,
          modeled,
          estimate_caveat: modeled ? CAVEAT_TEXT.modeled : null
        };

        if (from_year && to_year) {
          const delta = await fetchUpstream("/metrics/delta", { metric_id, from_year, to_year, area_type: areaType });
          const row = delta.deltas.find((d) => d.area_id === areaId);
          if (!row) return errorResult(`No delta data for ${areaType} ${areaId} on "${metric_id}" between ${from_year} and ${to_year}.`);
          const structuredContent = {
            ...base,
            mode: "delta",
            from_year,
            to_year,
            from_value: roundForUnit(row.from_value, metricObj.unit),
            to_value: roundForUnit(row.to_value, metricObj.unit),
            delta: roundForUnit(row.delta, metricObj.unit),
            delta_vs_city: roundForUnit(row.delta_vs_city, metricObj.unit),
            city_delta: roundForUnit(delta.city_delta, metricObj.unit)
          };
          // A percent-unit metric's change is a change in percentage points, not a relative
          // percent change, so say "points" there instead of repeating the unit "percent".
          const areaLabel = areaType === "ward" ? `Ward ${Number(areaId)}` : `Community area ${Number(areaId)}`;
          const changeSentence = (label, value) => {
            if (value === null) return `${label} has no data for this span.`;
            if (value > 0) return `${label} rose ${fmtChange(value, metricObj.unit)}.`;
            if (value < 0) return `${label} fell ${fmtChange(value, metricObj.unit)}.`;
            return `${label} held steady.`;
          };
          const higherIsBetter = metricObj.direction === "higher";
          const compareToCity = (areaDelta, cityDelta) => {
            if (areaDelta === null || cityDelta === null) return "a citywide comparison is not available";
            const areaScore = higherIsBetter ? areaDelta : -areaDelta;
            const cityScore = higherIsBetter ? cityDelta : -cityDelta;
            const areaImproved = areaScore > 0;
            const cityImproved = cityScore > 0;
            if (areaScore === cityScore) return "the same size change as the city";
            if (areaImproved && cityImproved) {
              return Math.abs(areaScore) > Math.abs(cityScore) ? "a bigger improvement than the city" : "a smaller improvement than the city";
            }
            if (!areaImproved && !cityImproved) {
              return Math.abs(areaScore) > Math.abs(cityScore) ? "a bigger decline than the city" : "a smaller decline than the city";
            }
            return areaImproved ? "an improvement while the city declined" : "a decline while the city improved";
          };
          const comparison = compareToCity(structuredContent.delta, structuredContent.city_delta);
          const text =
            `${metricObj.label} for ${areaLabel}, ${from_year} to ${to_year}${modeled ? ", a modeled estimate" : ""}. ` +
            `${areaLabel} went from ${fmtValue(structuredContent.from_value, metricObj.unit)} in ${from_year} to ${fmtValue(structuredContent.to_value, metricObj.unit)} in ${to_year}. ` +
            `${changeSentence(areaLabel, structuredContent.delta)} ${changeSentence("The city", structuredContent.city_delta)} ` +
            `That is ${comparison}.` +
            `${modeled ? ` ${CAVEAT_TEXT.modeled}` : ""} ` +
            `Source is ${metricObj.source || "not on file"}.`;
          return { content: [{ type: "text", text }], structuredContent };
        }

        const timeseries = await fetchUpstream("/metrics/timeseries", { metric_id, area_type: areaType, area_id: areaId });
        const seriesRow = timeseries.timeseries?.[0];
        if (!seriesRow) return errorResult(`No history for ${areaType} ${areaId} on "${metric_id}".`);
        const points = seriesRow.observations.map((o) => ({
          year: o.period_end ? Number(String(o.period_end).slice(0, 4)) : null,
          value: roundForUnit(o.value, metricObj.unit)
        }));
        const structuredContent = { ...base, mode: "series", series: points };
        const first = points[0];
        const last = points[points.length - 1];
        const text =
          `${metricObj.label} for ${areaType} ${areaId}, ${points.length} recorded years, ` +
          `${first ? `${first.year} was ${fmtValue(first.value, metricObj.unit)}` : "no data"} through ${last ? `${last.year} was ${fmtValue(last.value, metricObj.unit)}` : "no data"}. ` +
          `Source is ${metricObj.source || "not on file"}.${modeled ? ` ${CAVEAT_TEXT.modeled}` : ""}`;
        return { content: [{ type: "text", text }], structuredContent };
      } catch (error) {
        return errorResult(`metric_trend failed. ${error.message || error}`);
      }
    }
  );

  // --- 6. find_ward_for_address ------------------------------------------------------

  server.registerTool(
    "find_ward_for_address",
    {
      title: "Find ward for an address",
      description:
        "Look up which Chicago ward an address falls in. Geocodes the address with the free Census Bureau geocoder, " +
        "then checks it against ward boundaries. Address matching depends on that third party government service and " +
        "can occasionally fail to match an address.",
      inputSchema: {
        address: z.string().describe("A street address, e.g. \"5400 S Hyde Park Blvd\". \"Chicago, IL\" is added if missing.")
      },
      outputSchema: {
        address_input: z.string(),
        matched_address: z.string().nullable(),
        matched: z.boolean(),
        longitude: z.number().nullable(),
        latitude: z.number().nullable(),
        ward_id: z.string().nullable(),
        ward_number: z.number().int().nullable(),
        display_name: z.string().nullable(),
        alderperson_name: z.string().nullable(),
        full_report_url: z.string().nullable(),
        note: z.string()
      },
      annotations: readOnlyAnnotations("Find ward for an address")
    },
    async ({ address }) => {
      try {
        // Only add "Chicago, IL" when the input names no city at all. A comma-separated
        // part after the street ("123 Main St, Evanston"), a state token, or a ZIP code
        // all mean the caller already gave a full address, so leave it alone. Appending
        // ", Chicago" onto an address that already names a different city corrupts the
        // geocoder input and can pull back a match in the wrong town.
        const hasCityPart = address.includes(",");
        const hasState = /\bIL\b/i.test(address) || /illinois/i.test(address);
        const hasZip = /\b\d{5}(-\d{4})?\b/.test(address);
        let fullAddress = address.trim();
        if (!hasCityPart && !hasState && !hasZip) fullAddress += ", Chicago, IL";

        const url = new URL(CENSUS_ONELINE);
        url.searchParams.set("address", fullAddress);
        url.searchParams.set("benchmark", "Public_AR_Current");
        url.searchParams.set("format", "json");

        let response;
        try {
          response = await timeoutFetch(url);
        } catch (error) {
          if (error.name === "AbortError") {
            return errorResult(`The Census geocoder timed out after ${FETCH_TIMEOUT_MS / 1000} seconds. Try again.`);
          }
          return errorResult(`Could not reach the Census geocoder. ${error.message || error}`);
        }
        if (!response.ok) {
          return errorResult(`The Census geocoder returned ${response.status}.`);
        }
        const payload = await response.json();
        const matches = payload.result?.addressMatches || [];
        if (!matches.length) {
          return {
            content: [{ type: "text", text: `No match for "${address}". Check the spelling, or add a ZIP code.` }],
            structuredContent: {
              address_input: address,
              matched_address: null,
              matched: false,
              longitude: null,
              latitude: null,
              ward_id: null,
              ward_number: null,
              display_name: null,
              alderperson_name: null,
              full_report_url: null,
              note: "The Census geocoder found no match for this address."
            }
          };
        }
        const match = matches[0];
        const lon = match.coordinates.x;
        const lat = match.coordinates.y;

        // Census returns "STREET, CITY, STATE, ZIP". Check the matched city by exact name,
        // not by a "chicago" substring test, so a real match in a different town that happens
        // to contain the word Chicago (North Chicago, West Chicago, Chicago Heights, Chicago
        // Ridge) is rejected instead of treated as the City of Chicago.
        const addressParts = String(match.matchedAddress || "").split(",").map((p) => p.trim());
        const matchedCity = addressParts.length >= 2 ? addressParts[1] : null;
        if (!matchedCity || matchedCity.toUpperCase() !== "CHICAGO") {
          return {
            content: [
              {
                type: "text",
                text: `"${match.matchedAddress}" is outside Chicago. It matched to ${matchedCity || "a city that is not Chicago"}.`
              }
            ],
            structuredContent: {
              address_input: address,
              matched_address: match.matchedAddress,
              matched: true,
              longitude: round(lon, 6),
              latitude: round(lat, 6),
              ward_id: null,
              ward_number: null,
              display_name: null,
              alderperson_name: null,
              full_report_url: null,
              note: `This address matched to ${matchedCity || "a city outside Chicago"}. Ward Wise only covers the City of Chicago.`
            }
          };
        }

        const geojson = await getWardsGeoJson();
        const wardProps = findWardForPoint(lon, lat, geojson);
        if (!wardProps) {
          return {
            content: [{ type: "text", text: `"${match.matchedAddress}" geocoded, but the point falls outside Chicago's 50 wards.` }],
            structuredContent: {
              address_input: address,
              matched_address: match.matchedAddress,
              matched: true,
              longitude: round(lon, 6),
              latitude: round(lat, 6),
              ward_id: null,
              ward_number: null,
              display_name: null,
              alderperson_name: null,
              full_report_url: null,
              note: "This point is outside Chicago's 50 ward boundaries."
            }
          };
        }
        const wardId = String(wardProps.ward_id).padStart(2, "0");
        let alderpersonName = null;
        try {
          const wardData = await fetchUpstream(`/wards/${wardId}`);
          alderpersonName = wardData.alderperson?.name || null;
        } catch (_error) {
          // A missing alderperson lookup should not fail the whole address match.
        }
        const structuredContent = {
          address_input: address,
          matched_address: match.matchedAddress,
          matched: true,
          longitude: round(lon, 6),
          latitude: round(lat, 6),
          ward_id: wardId,
          ward_number: wardProps.ward_number,
          display_name: `Ward ${wardProps.ward_number}`,
          alderperson_name: alderpersonName,
          full_report_url: wardReportUrl(wardId),
          note: "Matched by the Census Bureau geocoder, then checked against ward boundaries."
        };
        const text = `"${match.matchedAddress}" is in Ward ${wardProps.ward_number}${alderpersonName ? `, alderperson ${alderpersonName}` : ""}.`;
        return { content: [{ type: "text", text }], structuredContent };
      } catch (error) {
        return errorResult(`find_ward_for_address failed. ${error.message || error}`);
      }
    }
  );

  // --- 7. area_overlaps -----------------------------------------------------------

  server.registerTool(
    "area_overlaps",
    {
      title: "Ward and community area overlaps",
      description:
        "Chicago wards and community areas don't share the same boundaries. Give one ward or one community area " +
        "and get every area it overlaps, with the percentage of each side.",
      inputSchema: {
        ward: z.union([z.string(), z.number()]).optional().describe("A ward number, 1 through 50"),
        community_area: z.union([z.string(), z.number()]).optional().describe("A community area number, 1 through 77")
      },
      outputSchema: {
        lookup_type: z.enum(["ward", "community_area"]),
        area_id: z.string(),
        display_name: z.string(),
        overlaps: z.array(
          z.object({ name: z.string(), ward_area_pct: z.number().nullable(), community_area_pct: z.number().nullable() })
        )
      },
      annotations: readOnlyAnnotations("Ward and community area overlaps")
    },
    async ({ ward, community_area }) => {
      try {
        if ((ward === undefined) === (community_area === undefined)) {
          return errorResult("Give exactly one of ward or community_area, not both and not neither.");
        }
        if (ward !== undefined) {
          const wardId = normalizeWardId(ward);
          if (!wardId) return errorResult(`"${ward}" is not a valid ward number. Chicago wards run 1 through 50.`);
          const data = await fetchUpstream(`/wards/${wardId}/community-areas`);
          const overlaps = (data.community_area_overlaps?.community_areas || []).map((c) => ({
            name: c.name,
            ward_area_pct: round(c.ward_area_pct),
            community_area_pct: round(c.community_area_pct)
          }));
          const structuredContent = { lookup_type: "ward", area_id: wardId, display_name: `Ward ${Number(wardId)}`, overlaps };
          const text = `Ward ${Number(wardId)} overlaps ${overlaps.length} community area${overlaps.length === 1 ? "" : "s"}.\n${overlaps.map((o) => `${o.name}, ${o.ward_area_pct}% of the ward, ${o.community_area_pct}% of ${o.name}`).join("\n")}`;
          return { content: [{ type: "text", text }], structuredContent };
        }
        const caId = normalizeCommunityAreaId(community_area);
        if (!caId) return errorResult(`"${community_area}" is not a valid community area number. Chicago has community areas 1 through 77.`);
        const list = await getCommunityAreasList();
        const area = list.community_areas.find((c) => c.community_area_id === caId);
        if (!area) return errorResult(`Community area ${caId} was not found.`);
        const overlaps = (area.ward_overlaps || []).map((w) => ({
          name: w.display_name,
          ward_area_pct: round(w.ward_area_pct),
          community_area_pct: round(w.community_area_pct)
        }));
        const structuredContent = {
          lookup_type: "community_area",
          area_id: caId,
          display_name: area.display_name || area.name,
          overlaps
        };
        const text = `${structuredContent.display_name} overlaps ${overlaps.length} ward${overlaps.length === 1 ? "" : "s"}.\n${overlaps.map((o) => `${o.name}, ${o.community_area_pct}% of ${structuredContent.display_name}, ${o.ward_area_pct}% of ${o.name}`).join("\n")}`;
        return { content: [{ type: "text", text }], structuredContent };
      } catch (error) {
        return errorResult(`area_overlaps failed. ${error.message || error}`);
      }
    }
  );

  // --- 8. places_in_ward ----------------------------------------------------------

  server.registerTool(
    "places_in_ward",
    {
      title: "Places in a ward",
      description:
        "List mapped places of interest in one Chicago ward, such as parks, libraries, museums, and faith institutions. " +
        "Optionally filter to one category.",
      inputSchema: {
        ward: z.union([z.string(), z.number()]).describe("Ward number, 1 through 50"),
        category: z
          .string()
          .optional()
          .describe("Filter to one category, e.g. park, library, museum, faith, garden, landmark, arts_culture"),
        limit: z.number().int().min(1).max(50).optional().describe("Max places to list, default 20")
      },
      outputSchema: {
        ward_id: z.string(),
        display_name: z.string(),
        total_count: z.number().int(),
        counts_by_category: z.record(z.string(), z.number()),
        category_filter: z.string().nullable(),
        shown: z.number().int(),
        places: z.array(
          z.object({
            name: z.string(),
            category: z.string(),
            address: z.string().nullable(),
            rating: z.number().nullable(),
            website_url: z.string().nullable()
          })
        )
      },
      annotations: readOnlyAnnotations("Places in a ward")
    },
    async ({ ward, category, limit }) => {
      try {
        const wardId = normalizeWardId(ward);
        if (!wardId) return errorResult(`"${ward}" is not a valid ward number. Chicago wards run 1 through 50.`);
        const data = await fetchUpstream(`/wards/${wardId}/places`);
        const wp = data.ward_places || {};
        // Use the full place list, not featured_places: featured_places is a small curated
        // highlight set and can be missing whole categories the ward actually has (confirmed
        // against the live API, e.g. a ward with 11 parks whose featured_places had none).
        let places = wp.places || wp.featured_places || [];
        if (category) places = places.filter((p) => p.category.toLowerCase() === category.toLowerCase());
        const cap = limit || 20;
        const shown = places.slice(0, cap).map((p) => ({
          name: p.name,
          category: p.category,
          address: p.address || null,
          rating: typeof p.rating === "number" ? p.rating : null,
          website_url: p.website_url || null
        }));
        const structuredContent = {
          ward_id: wardId,
          display_name: `Ward ${Number(wardId)}`,
          total_count: wp.total_count ?? 0,
          counts_by_category: wp.counts_by_category || {},
          category_filter: category || null,
          shown: shown.length,
          places: shown
        };
        const text =
          `Ward ${Number(wardId)} has ${structuredContent.total_count} mapped places` +
          `${category ? `, ${places.length} in category "${category}"` : ""}.\n` +
          shown.map((p) => `${p.name} (${p.category})${p.address ? `, ${p.address}` : ""}${p.rating ? `, rating ${p.rating}` : ""}`).join("\n");
        return { content: [{ type: "text", text }], structuredContent };
      } catch (error) {
        return errorResult(`places_in_ward failed. ${error.message || error}`);
      }
    }
  );

  // --- 9. metric_detail -------------------------------------------------------------

  server.registerTool(
    "metric_detail",
    {
      title: "Metric detail",
      description:
        "Look up the full definition of one measure, including what it means, its unit, its source, how it is " +
        "calculated, which years and geographies it covers, and whether it is a modeled estimate.",
      inputSchema: {
        metric_id: z.string().describe("A metric id from search_metrics")
      },
      outputSchema: {
        metric_id: z.string(),
        label: z.string(),
        description: z.string().nullable(),
        unit: z.string(),
        direction: z.enum(["higher", "lower"]),
        category: z.string(),
        source: z.string().nullable(),
        source_url: z.string().nullable(),
        calculation: z.string().nullable(),
        methodology: z.string().nullable(),
        available_at: z.array(z.string()),
        data_years: z.array(z.number()).optional(),
        time_invariant: z.boolean(),
        caveats_by_area_type: z.record(z.string(), z.array(z.string())),
        modeled_at: z.array(z.string()),
        dictionary_url: z.string()
      },
      annotations: readOnlyAnnotations("Metric detail")
    },
    async ({ metric_id }) => {
      try {
        const { manifest, invalid } = await validateMetricIds([metric_id]);
        if (invalid.length) return errorResult(metricIdErrorText(invalid, manifest));
        const m = manifest.metrics.find((x) => x.metric_id === metric_id);
        const availableAt = manifest.metric_area_types[metric_id] || [];
        const caveatsByAreaType = {};
        const modeledAt = [];
        for (const at of availableAt) {
          const keys = manifest.metric_methodology?.[at]?.[metric_id] || [];
          if (keys.length) caveatsByAreaType[at] = keys.map((k) => CAVEAT_TEXT[k] || k);
          if (keys.includes("modeled")) modeledAt.push(at);
        }
        const structuredContent = {
          metric_id,
          label: m.label,
          description: m.description || null,
          unit: m.unit,
          direction: m.direction,
          category: m.category,
          source: m.source || null,
          source_url: m.source_url || null,
          calculation: m.calculation || null,
          methodology: m.methodology || m.methodology_short || null,
          available_at: availableAt,
          data_years: manifest.metric_data_years?.[metric_id] || undefined,
          time_invariant: (manifest.time_invariant_metrics || []).includes(metric_id),
          caveats_by_area_type: caveatsByAreaType,
          modeled_at: modeledAt,
          dictionary_url: dictionaryUrl(metric_id)
        };
        const years = structuredContent.data_years;
        const yearsText = years && years.length ? `data from ${years[0]} to ${years[years.length - 1]}` : "no year data listed";
        const text =
          `${m.label}. ${m.description || "No description on file."} Measured in ${m.unit}, ${m.direction === "higher" ? "higher is better" : "lower is better"}. ` +
          `Source is ${m.source}${m.source_url ? ` (${m.source_url})` : ""}. It is available at ${availableAt.join(", ") || "no geography"}. ${yearsText}.` +
          `${modeledAt.length ? ` It is a modeled estimate at ${modeledAt.join(", ")}. ${CAVEAT_TEXT.modeled}` : ""}`;
        return { content: [{ type: "text", text }], structuredContent };
      } catch (error) {
        return errorResult(`metric_detail failed. ${error.message || error}`);
      }
    }
  );

  return server;
}
