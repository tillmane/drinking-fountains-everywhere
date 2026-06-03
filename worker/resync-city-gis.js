const ARCGIS_URL =
  "https://services.arcgis.com/ZOyb2t4B0UYuYNYH/arcgis/rest/services/Drinking_Fountain/FeatureServer/0/query";
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

async function fetchCityGis() {
  const params = new URLSearchParams({
    where: "LIFE_CYCLE_CODE='A'",
    outFields: "OBJECTID,LATITUDE,LONGITUDE",
    f: "json",
    resultRecordCount: "2000",
  });
  const res = await fetch(ARCGIS_URL + "?" + params);
  const data = await res.json();
  if (!data.features) throw new Error("No City GIS features returned");
  return data.features.map((f) => f.attributes);
}

async function fetchD1Fountains() {
  const { execSync } = await import("child_process");
  const result = execSync(
    'npx wrangler d1 execute drinking-fountains-db --remote --json ' +
    '--command="SELECT id, lat, lon FROM fountains"',
    { encoding: "utf8" }
  );
  const parsed = JSON.parse(result);
  return parsed[0].results;
}

async function main() {
  process.stderr.write("Fetching current ArcGIS data...\n");
  const arcgisData = await fetchCityGis();
  process.stderr.write(`  ArcGIS returned ${arcgisData.length} active fountains\n`);

  process.stderr.write("Fetching fountain records from D1...\n");
  const d1Fountains = await fetchD1Fountains();
  process.stderr.write(`  D1 has ${d1Fountains.length} fountain records\n`);

  const inserts = [];
  const unmatched = [];

  for (const f of arcgisData) {
    let bestId = null;
    let bestDist = Infinity;
    for (const row of d1Fountains) {
      const dist = haversineMeters(f.LATITUDE, f.LONGITUDE, row.lat, row.lon);
      if (dist < bestDist) {
        bestDist = dist;
        bestId = row.id;
      }
    }
    if (bestDist <= MATCH_THRESHOLD_M) {
      inserts.push({ fountain_id: bestId, source_id: String(f.OBJECTID) });
    } else {
      unmatched.push({ objectid: f.OBJECTID, lat: f.LATITUDE, lon: f.LONGITUDE, nearestDist: Math.round(bestDist) });
    }
  }

  process.stderr.write(`  Matched: ${inserts.length}, Unmatched: ${unmatched.length}\n`);

  if (unmatched.length > 0) {
    process.stderr.write("\nUnmatched ArcGIS fountains (no D1 fountain within 30m):\n");
    for (const u of unmatched) {
      process.stderr.write(`  OBJECTID=${u.objectid} lat=${u.lat} lon=${u.lon} nearest=${u.nearestDist}m\n`);
    }
    process.stderr.write("\nThese will have no city_gis source link. Proceeding anyway.\n");
  }

  process.stdout.write("DELETE FROM fountain_sources WHERE source_type = 'city_gis';\n");
  for (const ins of inserts) {
    process.stdout.write(
      `INSERT INTO fountain_sources (fountain_id, source_type, source_id) VALUES (${ins.fountain_id}, 'city_gis', '${ins.source_id}');\n`
    );
  }

  process.stderr.write(`\nOutput ${inserts.length + 1} SQL statements (1 DELETE + ${inserts.length} INSERTs).\n`);
}

main().catch((err) => {
  process.stderr.write("Error: " + err.message + "\n");
  process.exit(1);
});
