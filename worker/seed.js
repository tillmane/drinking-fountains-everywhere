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
    outFields: "OBJECTID,PARK,LATITUDE,LONGITUDE",
    f: "json",
    resultRecordCount: "2000",
  });
  const res = await fetch(ARCGIS_URL + "?" + params);
  const data = await res.json();
  if (!data.features) throw new Error("No City GIS features returned");
  return data.features.map((f) => f.attributes);
}

async function fetchOsm() {
  const query = `[out:json];node[amenity=drinking_water](${SEATTLE_BOUNDS});out body;`;
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

async function main() {
  const [cityData, osmData] = await Promise.all([fetchCityGis(), fetchOsm()]);

  const fountains = [];
  const sourceLinks = [];
  const matchedOsmIds = new Set();

  for (const el of osmData) {
    const id = fountains.length + 1;
    fountains.push({
      id,
      lat: el.lat,
      lon: el.lon,
      name: (el.tags && el.tags.name) || null,
    });
    sourceLinks.push({ fountain_id: id, source_type: "osm", source_id: String(el.id) });
  }

  for (const f of cityData) {
    let matched = false;
    for (let i = 0; i < osmData.length; i++) {
      if (matchedOsmIds.has(i)) continue;
      const dist = haversineMeters(f.LATITUDE, f.LONGITUDE, osmData[i].lat, osmData[i].lon);
      if (dist <= MATCH_THRESHOLD_M) {
        const localId = i + 1;
        sourceLinks.push({ fountain_id: localId, source_type: "city_gis", source_id: String(f.OBJECTID) });
        if (!fountains[i].name && f.PARK) {
          fountains[i].name = f.PARK;
        }
        matchedOsmIds.add(i);
        matched = true;
        break;
      }
    }
    if (!matched) {
      const id = fountains.length + 1;
      fountains.push({
        id,
        lat: f.LATITUDE,
        lon: f.LONGITUDE,
        name: f.PARK || null,
      });
      sourceLinks.push({ fountain_id: id, source_type: "city_gis", source_id: String(f.OBJECTID) });
    }
  }

  const lines = [];
  lines.push("DELETE FROM fountain_sources;");
  lines.push("DELETE FROM ratings;");
  lines.push("DELETE FROM fountains;");
  lines.push("");

  for (const f of fountains) {
    lines.push(
      `INSERT INTO fountains (id, lat, lon, name) VALUES (${f.id}, ${f.lat}, ${f.lon}, ${escSql(f.name)});`
    );
  }
  lines.push("");

  for (const s of sourceLinks) {
    lines.push(
      `INSERT INTO fountain_sources (fountain_id, source_type, source_id) VALUES (${s.fountain_id}, ${escSql(s.source_type)}, ${escSql(s.source_id)});`
    );
  }

  process.stdout.write(lines.join("\n") + "\n");

  process.stderr.write(
    `Seeded ${fountains.length} fountains (${osmData.length} OSM, ${cityData.length} City GIS, ${matchedOsmIds.size} matched)\n`
  );
}

main().catch((err) => {
  process.stderr.write("Seed failed: " + err.message + "\n");
  process.exit(1);
});
