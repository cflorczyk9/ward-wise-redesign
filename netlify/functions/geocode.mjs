// POST /geocode on Netlify: the same job as the /geocode route in server.py.
// Zoning filings name a street address and nothing else, so the alerts preview needs a map point
// to place each one in a ward. The Census Bureau geocodes addresses for free, with no key, and
// takes a whole batch in one request, but it sends no CORS headers, so it goes through here.

const CENSUS_BATCH = "https://geocoding.geo.census.gov/geocoder/locations/addressbatch";

// Census answers in CSV with quoted fields: "id","address","Match","Exact","matched","lon,lat",...
function parseRow(line) {
  const cells = [];
  let cell = "";
  let quoted = false;
  for (const char of line) {
    if (char === '"') quoted = !quoted;
    else if (char === "," && !quoted) {
      cells.push(cell);
      cell = "";
    } else cell += char;
  }
  cells.push(cell);
  return cells;
}

export default async (request) => {
  if (request.method !== "POST") return new Response("POST only", { status: 405 });
  let body = {};
  try {
    body = await request.json();
  } catch (_error) {
    /* an empty or broken body just means no addresses */
  }
  const addresses = [...new Set((body.addresses || []).map((a) => String(a).trim()).filter(Boolean))].slice(0, 500);
  if (!addresses.length) return Response.json({});

  const rows = addresses.map((a, i) => `${i},"${a.replaceAll('"', "")}",Chicago,IL,`).join("\n");
  const form = new FormData();
  form.append("addressFile", new Blob([`${rows}\n`], { type: "text/csv" }), "batch.csv");
  form.append("benchmark", "Public_AR_Current");

  let text;
  try {
    const response = await fetch(CENSUS_BATCH, { method: "POST", body: form });
    if (!response.ok) throw new Error(`Census answered ${response.status}`);
    text = await response.text();
  } catch (error) {
    return Response.json({ error: `Geocoding failed: ${error.message}` }, { status: 502 });
  }

  const result = Object.fromEntries(addresses.map((a) => [a, null]));
  for (const line of text.split(/\r?\n/)) {
    const cells = parseRow(line);
    const index = Number(cells[0]);
    if (!Number.isInteger(index) || index >= addresses.length || cells.length < 6) continue;
    if (cells[2] === "Match" && cells[5].includes(",")) {
      const [lon, lat] = cells[5].split(",").map(Number);
      result[addresses[index]] = [lon, lat];
    }
  }
  return Response.json(result);
};
