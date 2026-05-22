const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

function err(message, status = 400) {
  return json({ error: message }, status);
}

async function handleGetFountains(db) {
  const { results: fountains } = await db
    .prepare(
      `SELECT f.id, f.lat, f.lon, f.name,
              ROUND(AVG(r.score), 1) AS avg_rating,
              COUNT(r.score)         AS rating_count,
              MAX(r.updated_at)      AS last_rated_at
       FROM fountains f
       LEFT JOIN ratings r ON r.fountain_id = f.id
       GROUP BY f.id`
    )
    .all();

  const { results: sources } = await db
    .prepare("SELECT fountain_id, source_type, source_id FROM fountain_sources")
    .all();

  const { results: attrs } = await db
    .prepare("SELECT fountain_id, attribute, value FROM fountain_attributes")
    .all();

  const { results: offReports } = await db
    .prepare(
      `SELECT fountain_id, COUNT(*) AS off_count, MAX(created_at) AS last_off_at
       FROM status_reports
       WHERE status = 'off'
       GROUP BY fountain_id`
    )
    .all();

  const sourceMap = {};
  for (const s of sources) {
    if (!sourceMap[s.fountain_id]) sourceMap[s.fountain_id] = [];
    sourceMap[s.fountain_id].push({
      source_type: s.source_type,
      source_id: s.source_id,
    });
  }

  const attrMap = {};
  for (const a of attrs) {
    if (!attrMap[a.fountain_id]) attrMap[a.fountain_id] = {};
    attrMap[a.fountain_id][a.attribute] = a.value === 1;
  }

  const reportMap = {};
  for (const r of offReports) {
    reportMap[r.fountain_id] = { off_count: r.off_count, last_off_at: r.last_off_at };
  }

  return json({
    fountains: fountains.map((f) => {
      const report = reportMap[f.id];
      const fa = attrMap[f.id] || {};
      return {
        ...f,
        sources: sourceMap[f.id] || [],
        reported_off: !!report,
        off_reports: report ? report.off_count : 0,
        last_off_report_at: report ? report.last_off_at : null,
        user_bottle_filler: fa.bottle_filler || false,
        user_dog_bowl: fa.dog_bowl || false,
      };
    }),
  });
}

async function handleGetRatings(db, fountainId) {
  const fountain = await db
    .prepare("SELECT id FROM fountains WHERE id = ?")
    .bind(fountainId)
    .first();
  if (!fountain) return err("Fountain not found", 404);

  const { results } = await db
    .prepare(
      "SELECT score, updated_at FROM ratings WHERE fountain_id = ? ORDER BY updated_at DESC"
    )
    .bind(fountainId)
    .all();

  return json({ fountain_id: fountainId, ratings: results });
}

async function handlePostRating(db, fountainId, request) {
  const fountain = await db
    .prepare("SELECT id FROM fountains WHERE id = ?")
    .bind(fountainId)
    .first();
  if (!fountain) return err("Fountain not found", 404);

  let body;
  try {
    body = await request.json();
  } catch {
    return err("Invalid JSON");
  }

  const { device_id, score } = body;
  if (
    typeof device_id !== "string" ||
    device_id.length < 1 ||
    device_id.length > 64
  ) {
    return err("Invalid device_id");
  }
  if (!Number.isInteger(score) || score < 1 || score > 5) {
    return err("Score must be an integer from 1 to 5");
  }

  await db
    .prepare(
      `INSERT INTO ratings (fountain_id, device_id, score, updated_at)
       VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
       ON CONFLICT (fountain_id, device_id)
       DO UPDATE SET score = excluded.score,
                     updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')`
    )
    .bind(fountainId, device_id, score)
    .run();

  const agg = await db
    .prepare(
      `SELECT ROUND(AVG(score), 1) AS avg_rating,
              COUNT(score)          AS rating_count,
              MAX(updated_at)       AS last_rated_at
       FROM ratings WHERE fountain_id = ?`
    )
    .bind(fountainId)
    .first();

  return json({
    fountain_id: fountainId,
    avg_rating: agg.avg_rating,
    rating_count: agg.rating_count,
    last_rated_at: agg.last_rated_at,
    your_score: score,
  });
}

async function handlePostReport(db, fountainId, request) {
  const fountain = await db
    .prepare("SELECT id FROM fountains WHERE id = ?")
    .bind(fountainId)
    .first();
  if (!fountain) return err("Fountain not found", 404);

  let body;
  try {
    body = await request.json();
  } catch {
    return err("Invalid JSON");
  }

  const { device_id, status } = body;
  if (
    typeof device_id !== "string" ||
    device_id.length < 1 ||
    device_id.length > 64
  ) {
    return err("Invalid device_id");
  }
  if (status !== "off" && status !== "on") {
    return err("Status must be 'off' or 'on'");
  }

  if (status === "on") {
    await db
      .prepare("DELETE FROM status_reports WHERE fountain_id = ? AND status = 'off'")
      .bind(fountainId)
      .run();
  } else {
    await db
      .prepare(
        "INSERT INTO status_reports (fountain_id, device_id, status) VALUES (?, ?, 'off')"
      )
      .bind(fountainId, device_id)
      .run();
  }

  const agg = await db
    .prepare(
      `SELECT COUNT(*) AS off_count, MAX(created_at) AS last_off_at
       FROM status_reports
       WHERE fountain_id = ? AND status = 'off'`
    )
    .bind(fountainId)
    .first();

  return json({
    fountain_id: fountainId,
    reported_off: agg.off_count > 0,
    off_reports: agg.off_count,
    last_off_report_at: agg.last_off_at,
  });
}

async function handlePostAttributes(db, fountainId, request) {
  const fountain = await db
    .prepare("SELECT id FROM fountains WHERE id = ?")
    .bind(fountainId)
    .first();
  if (!fountain) return err("Fountain not found", 404);

  let body;
  try {
    body = await request.json();
  } catch {
    return err("Invalid JSON");
  }

  const { device_id, attribute, value } = body;
  if (
    typeof device_id !== "string" ||
    device_id.length < 1 ||
    device_id.length > 64
  ) {
    return err("Invalid device_id");
  }
  if (attribute !== "bottle_filler" && attribute !== "dog_bowl") {
    return err("Attribute must be 'bottle_filler' or 'dog_bowl'");
  }
  if (value !== true && value !== false) {
    return err("Value must be true or false");
  }

  await db
    .prepare(
      `INSERT INTO fountain_attributes (fountain_id, attribute, value, device_id, updated_at)
       VALUES (?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
       ON CONFLICT (fountain_id, attribute)
       DO UPDATE SET value = excluded.value,
                     device_id = excluded.device_id,
                     updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')`
    )
    .bind(fountainId, attribute, value ? 1 : 0, device_id)
    .run();

  const { results } = await db
    .prepare("SELECT attribute, value FROM fountain_attributes WHERE fountain_id = ?")
    .bind(fountainId)
    .all();

  const out = { fountain_id: fountainId, user_bottle_filler: false, user_dog_bowl: false };
  for (const r of results) {
    if (r.attribute === "bottle_filler") out.user_bottle_filler = r.value === 1;
    if (r.attribute === "dog_bowl") out.user_dog_bowl = r.value === 1;
  }
  return json(out);
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);

    if (url.pathname === "/fountains" && request.method === "GET") {
      return handleGetFountains(env.DB);
    }

    const ratingsMatch = url.pathname.match(/^\/fountains\/(\d+)\/ratings$/);
    if (ratingsMatch && request.method === "GET") {
      return handleGetRatings(env.DB, parseInt(ratingsMatch[1]));
    }

    const ratingMatch = url.pathname.match(/^\/fountains\/(\d+)\/rating$/);
    if (ratingMatch && request.method === "POST") {
      return handlePostRating(env.DB, parseInt(ratingMatch[1]), request);
    }

    const reportMatch = url.pathname.match(/^\/fountains\/(\d+)\/report$/);
    if (reportMatch && request.method === "POST") {
      return handlePostReport(env.DB, parseInt(reportMatch[1]), request);
    }

    const attrMatch = url.pathname.match(/^\/fountains\/(\d+)\/attributes$/);
    if (attrMatch && request.method === "POST") {
      return handlePostAttributes(env.DB, parseInt(attrMatch[1]), request);
    }

    return new Response("Not Found", { status: 404, headers: CORS_HEADERS });
  },
};
