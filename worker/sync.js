/**
 * sync.js — Fetch upstream fountain data from ArcGIS and Overpass, then generate SQL
 * to upsert fountain positions, source links, and source_data into D1.
 *
 * Usage:
 *   npm run sync:preview          # generate worker/sync-data.sql for review
 *   npm run sync                  # generate SQL and apply to production D1
 *
 * Run this when:
 *   - ArcGIS OBJECTIDs have changed (symptoms: City GIS fountains show "Ratings coming soon")
 *   - New fountains have been added to either source
 *   - Seasonal shutoff status has changed in ArcGIS (spring/autumn)
 *   - Roughly monthly is sufficient; more frequent is fine
 *
 * What it does:
 *   1. Fetches all active City GIS fountains from the Seattle ArcGIS FeatureServer
 *   2. Fetches all drinking_water nodes from Overpass in the Seattle/Bellevue bounding box
 *   3. Matches City GIS features to existing D1 fountains by proximity (within 30m)
 *   4. Matches OSM nodes to existing D1 fountains by proximity (within 30m)
 *   5. Inserts new fountain rows for any unmatched features
 *   6. Upserts fountain_sources rows with full source_data JSON for each matched feature
 *
 * What it does NOT do:
 *   - Delete fountains that have disappeared upstream (manual decision required)
 *   - Touch ratings, attributes, reports, or any user-contributed data
 *   - Insert duplicate fountain rows if a feature already has a source link
 *
 * Output: SQL printed to stdout, progress to stderr.
 */

const ARCGIS_URL =
  "https://services.arcgis.com/ZOyb2t4B0UYuYNYH/arcgis/rest/services/Drinking_Fountain/FeatureServer/0/query";
const OVERPASS_URL = "https://overpass-api.de/api/interpreter";
const SEATTLE_BOUNDS = "47.3,-122.5,47.8,-122.1";
const MATCH_THRESHOLD_M = 30;

function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function escSql(s) {
  if (s == null) return "NULL";
  return "'" + String(s).replace(/'/g, "''") + "'";
}

async function fetchCityGis() {
  const params = new URLSearchParams({
    where: "LIFE_CYCLE_CODE='A'",
    outFields: [
      "OBJECTID", "PARK", "LATITUDE", "LONGITUDE", "LIFE_CYCLE_CODE",
      "CURRENT_STATUS", "REASON_OFF", "ACCESSIBLE_MODEL", "BOTTLE_FILLER", "DOG_BOWL",
    ].join(","),
    f: "json",
    resultRecordCount: "2000",
  });
  process.stderr.write("Fetching ArcGIS...\n");
  const res = await fetch(ARCGIS_URL + "?" + params);
  const data = await res.json();
  if (!data.features) throw new Error("No City GIS features returned");
  return data.features.map((f) => f.attributes);
}

async function fetchOsm() {
  const query = `[out:json];node[amenity=drinking_water](${SEATTLE_BOUNDS});out body;`;
  process.stderr.write("Fetching Overpass...\n");
  const res = await fetch(OVERPASS_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "DrinkingFountainsFinder/1.0",
      "Accept": "application/json",
    },
    body: "data=" + encodeURIComponent(query),
  });
  const data = await res.json();
  return data.elements || [];
}

async function fetchD1Fountains() {
  const { execSync } = await import("child_process");
  process.stderr.write("Fetching D1 fountains...\n");
  const result = execSync(
    'npx wrangler d1 execute drinking-fountains-db --remote --json ' +
    '--command="SELECT id, lat, lon FROM fountains"',
    { encoding: "utf8" }
  );
  return JSON.parse(result)[0].results;
}

async function fetchD1Sources() {
  const { execSync } = await import("child_process");
  process.stderr.write("Fetching D1 fountain_sources...\n");
  const result = execSync(
    'npx wrangler d1 execute drinking-fountains-db --remote --json ' +
    '--command="SELECT fountain_id, source_type, source_id FROM fountain_sources"',
    { encoding: "utf8" }
  );
  return JSON.parse(result)[0].results;
}

function findNearest(lat, lon, d1Fountains, excludeIds) {
  let bestId = null;
  let bestDist = Infinity;
  for (const row of d1Fountains) {
    if (excludeIds && excludeIds.has(row.id)) continue;
    const dist = haversineMeters(lat, lon, row.lat, row.lon);
    if (dist < bestDist) {
      bestDist = dist;
      bestId = row.id;
    }
  }
  return { id: bestId, dist: bestDist };
}

async function main() {
  const [cityData, osmData, d1Fountains, d1Sources] = await Promise.all([
    fetchCityGis(),
    fetchOsm(),
    fetchD1Fountains(),
    fetchD1Sources(),
  ]);

  process.stderr.write(
    `ArcGIS: ${cityData.length} active fountains\n` +
    `Overpass: ${osmData.length} nodes\n` +
    `D1 fountains: ${d1Fountains.length}\n` +
    `D1 sources: ${d1Sources.length}\n`
  );

  // Build lookup: "source_type:source_id" -> fountain_id
  const existingSourceMap = {};
  for (const s of d1Sources) {
    existingSourceMap[s.source_type + ":" + s.source_id] = s.fountain_id;
  }

  // Track next available ID for new fountain rows
  let nextId = d1Fountains.length > 0
    ? Math.max(...d1Fountains.map((f) => f.id)) + 1
    : 1;

  const newFountains = [];
  const upserts = []; // { fountain_id, source_type, source_id, source_data, lat, lon }

  // Process City GIS
  let cityMatched = 0, cityNew = 0, cityExisting = 0;
  for (const f of cityData) {
    const key = "city_gis:" + String(f.OBJECTID);
    if (existingSourceMap[key]) {
      // Already linked — just refresh source_data
      upserts.push({
        fountain_id: existingSourceMap[key],
        source_type: "city_gis",
        source_id: String(f.OBJECTID),
        source_data: JSON.stringify(f),
      });
      cityExisting++;
      continue;
    }

    const { id, dist } = findNearest(f.LATITUDE, f.LONGITUDE, d1Fountains, null);
    if (dist <= MATCH_THRESHOLD_M) {
      upserts.push({
        fountain_id: id,
        source_type: "city_gis",
        source_id: String(f.OBJECTID),
        source_data: JSON.stringify(f),
      });
      cityMatched++;
    } else {
      const newId = nextId++;
      newFountains.push({ id: newId, lat: f.LATITUDE, lon: f.LONGITUDE, name: f.PARK || null });
      upserts.push({
        fountain_id: newId,
        source_type: "city_gis",
        source_id: String(f.OBJECTID),
        source_data: JSON.stringify(f),
      });
      cityNew++;
    }
  }

  // Process OSM
  const allFountains = [...d1Fountains, ...newFountains];
  let osmMatched = 0, osmNew = 0, osmExisting = 0;
  for (const el of osmData) {
    const key = "osm:" + String(el.id);
    if (existingSourceMap[key]) {
      upserts.push({
        fountain_id: existingSourceMap[key],
        source_type: "osm",
        source_id: String(el.id),
        source_data: JSON.stringify({ id: el.id, lat: el.lat, lon: el.lon, tags: el.tags || {} }),
      });
      osmExisting++;
      continue;
    }

    const { id, dist } = findNearest(el.lat, el.lon, allFountains, null);
    if (dist <= MATCH_THRESHOLD_M) {
      upserts.push({
        fountain_id: id,
        source_type: "osm",
        source_id: String(el.id),
        source_data: JSON.stringify({ id: el.id, lat: el.lat, lon: el.lon, tags: el.tags || {} }),
      });
      osmMatched++;
    } else {
      const newId = nextId++;
      newFountains.push({ id: newId, lat: el.lat, lon: el.lon, name: (el.tags && el.tags.name) || null });
      allFountains.push({ id: newId, lat: el.lat, lon: el.lon });
      upserts.push({
        fountain_id: newId,
        source_type: "osm",
        source_id: String(el.id),
        source_data: JSON.stringify({ id: el.id, lat: el.lat, lon: el.lon, tags: el.tags || {} }),
      });
      osmNew++;
    }
  }

  process.stderr.write(
    `City GIS: ${cityExisting} existing, ${cityMatched} newly matched, ${cityNew} new fountains\n` +
    `OSM: ${osmExisting} existing, ${osmMatched} newly matched, ${osmNew} new fountains\n` +
    `New fountain rows to insert: ${newFountains.length}\n` +
    `source_data rows to upsert: ${upserts.length}\n`
  );

  const lines = [];
  lines.push("-- sync.js output — generated " + new Date().toISOString());
  lines.push("-- New fountain rows: " + newFountains.length);
  lines.push("-- source_data upserts: " + upserts.length);
  lines.push("");

  for (const f of newFountains) {
    lines.push(
      `INSERT INTO fountains (id, lat, lon, name) VALUES (${f.id}, ${f.lat}, ${f.lon}, ${escSql(f.name)});`
    );
  }

  if (newFountains.length > 0) lines.push("");

  for (const u of upserts) {
    lines.push(
      `INSERT INTO fountain_sources (fountain_id, source_type, source_id, source_data)` +
      ` VALUES (${u.fountain_id}, ${escSql(u.source_type)}, ${escSql(u.source_id)}, ${escSql(u.source_data)})` +
      ` ON CONFLICT (fountain_id, source_type, source_id) DO UPDATE SET source_data = excluded.source_data;`
    );
  }

  process.stdout.write(lines.join("\n") + "\n");
  process.stderr.write("Done.\n");
}

main().catch((err) => {
  process.stderr.write("Sync failed: " + err.message + "\n");
  process.exit(1);
});
