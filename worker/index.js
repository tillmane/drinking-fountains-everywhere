function corsHeaders(allowedOrigin) {
  return {
    "Access-Control-Allow-Origin": allowedOrigin || "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function json(data, status, cors) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { "Content-Type": "application/json", ...cors },
  });
}

function err(message, status, cors) {
  return json({ error: message }, status || 400, cors);
}

function log(level, endpoint, extra) {
  const entry = { endpoint, ...extra };
  if (level === "error") {
    console.error(JSON.stringify(entry));
  } else {
    console.log(JSON.stringify(entry));
  }
}

async function writeLog(db, endpoint, fountainId, devicePrefix, status, ms) {
  try {
    await db
      .prepare(
        "INSERT INTO request_log (endpoint, fountain_id, device_pfx, status, ms) VALUES (?, ?, ?, ?, ?)"
      )
      .bind(endpoint, fountainId ?? null, devicePrefix ?? null, status, ms)
      .run();
  } catch (e) {
    console.error(JSON.stringify({ endpoint: "writeLog", error: e.message }));
  }
}

async function handleGetFountains(db, cors) {
  const t0 = Date.now();
  try {
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

    log("info", "GET /fountains", { status: 200, ms: Date.now() - t0 });
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
    }, 200, cors);
  } catch (e) {
    log("error", "GET /fountains", { error: e.message, ms: Date.now() - t0 });
    return err("Internal server error", 500, cors);
  }
}

async function handleGetRatings(db, fountainId, cors) {
  const t0 = Date.now();
  try {
    const fountain = await db
      .prepare("SELECT id FROM fountains WHERE id = ?")
      .bind(fountainId)
      .first();
    if (!fountain) {
      log("info", "GET /fountains/:id/ratings", { fountainId, status: 404, ms: Date.now() - t0 });
      return err("Fountain not found", 404, cors);
    }

    const { results } = await db
      .prepare(
        "SELECT score, updated_at FROM ratings WHERE fountain_id = ? ORDER BY updated_at DESC"
      )
      .bind(fountainId)
      .all();

    log("info", "GET /fountains/:id/ratings", { fountainId, status: 200, ms: Date.now() - t0 });
    return json({ fountain_id: fountainId, ratings: results }, 200, cors);
  } catch (e) {
    log("error", "GET /fountains/:id/ratings", { fountainId, error: e.message, ms: Date.now() - t0 });
    return err("Internal server error", 500, cors);
  }
}

async function handlePostRating(db, fountainId, request, cors) {
  const t0 = Date.now();
  let devicePrefix = "unknown";
  try {
    const fountain = await db
      .prepare("SELECT id FROM fountains WHERE id = ?")
      .bind(fountainId)
      .first();
    if (!fountain) {
      log("info", "POST /fountains/:id/rating", { fountainId, status: 404, ms: Date.now() - t0 });
      return err("Fountain not found", 404, cors);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return err("Invalid JSON", 400, cors);
    }

    const { device_id, score } = body;
    if (
      typeof device_id !== "string" ||
      device_id.length < 1 ||
      device_id.length > 64
    ) {
      return err("Invalid device_id", 400, cors);
    }
    if (!Number.isInteger(score) || score < 1 || score > 5) {
      return err("Score must be an integer from 1 to 5", 400, cors);
    }
    devicePrefix = device_id.slice(0, 8);

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

    const ms = Date.now() - t0;
    log("info", "POST /fountains/:id/rating", { fountainId, devicePrefix, score, status: 200, ms });
    await writeLog(db, "POST /rating", fountainId, devicePrefix, 200, ms);
    return json({
      fountain_id: fountainId,
      avg_rating: agg.avg_rating,
      rating_count: agg.rating_count,
      last_rated_at: agg.last_rated_at,
      your_score: score,
    }, 200, cors);
  } catch (e) {
    const ms = Date.now() - t0;
    log("error", "POST /fountains/:id/rating", { fountainId, devicePrefix, error: e.message, ms });
    await writeLog(db, "POST /rating", fountainId, devicePrefix, 500, ms);
    return err("Internal server error", 500, cors);
  }
}

async function handlePostReport(db, fountainId, request, cors) {
  const t0 = Date.now();
  let devicePrefix = "unknown";
  try {
    const fountain = await db
      .prepare("SELECT id FROM fountains WHERE id = ?")
      .bind(fountainId)
      .first();
    if (!fountain) {
      log("info", "POST /fountains/:id/report", { fountainId, status: 404, ms: Date.now() - t0 });
      return err("Fountain not found", 404, cors);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return err("Invalid JSON", 400, cors);
    }

    const { device_id, status } = body;
    if (
      typeof device_id !== "string" ||
      device_id.length < 1 ||
      device_id.length > 64
    ) {
      return err("Invalid device_id", 400, cors);
    }
    if (status !== "off" && status !== "on") {
      return err("Status must be 'off' or 'on'", 400, cors);
    }
    devicePrefix = device_id.slice(0, 8);

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

    const ms = Date.now() - t0;
    log("info", "POST /fountains/:id/report", { fountainId, devicePrefix, status, httpStatus: 200, ms });
    await writeLog(db, "POST /report", fountainId, devicePrefix, 200, ms);
    return json({
      fountain_id: fountainId,
      reported_off: agg.off_count > 0,
      off_reports: agg.off_count,
      last_off_report_at: agg.last_off_at,
    }, 200, cors);
  } catch (e) {
    const ms = Date.now() - t0;
    log("error", "POST /fountains/:id/report", { fountainId, devicePrefix, error: e.message, ms });
    await writeLog(db, "POST /report", fountainId, devicePrefix, 500, ms);
    return err("Internal server error", 500, cors);
  }
}

async function handlePostAttributes(db, fountainId, request, cors) {
  const t0 = Date.now();
  let devicePrefix = "unknown";
  try {
    const fountain = await db
      .prepare("SELECT id FROM fountains WHERE id = ?")
      .bind(fountainId)
      .first();
    if (!fountain) {
      log("info", "POST /fountains/:id/attributes", { fountainId, status: 404, ms: Date.now() - t0 });
      return err("Fountain not found", 404, cors);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return err("Invalid JSON", 400, cors);
    }

    const { device_id, attribute, value } = body;
    if (
      typeof device_id !== "string" ||
      device_id.length < 1 ||
      device_id.length > 64
    ) {
      return err("Invalid device_id", 400, cors);
    }
    if (attribute !== "bottle_filler" && attribute !== "dog_bowl") {
      return err("Attribute must be 'bottle_filler' or 'dog_bowl'", 400, cors);
    }
    if (value !== true && value !== false) {
      return err("Value must be true or false", 400, cors);
    }
    devicePrefix = device_id.slice(0, 8);

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

    const ms = Date.now() - t0;
    log("info", "POST /fountains/:id/attributes", { fountainId, devicePrefix, attribute, value, status: 200, ms });
    await writeLog(db, "POST /attributes", fountainId, devicePrefix, 200, ms);
    return json(out, 200, cors);
  } catch (e) {
    const ms = Date.now() - t0;
    log("error", "POST /fountains/:id/attributes", { fountainId, devicePrefix, error: e.message, ms });
    await writeLog(db, "POST /attributes", fountainId, devicePrefix, 500, ms);
    return err("Internal server error", 500, cors);
  }
}

export default {
  async fetch(request, env) {
    const cors = corsHeaders(env.ALLOWED_ORIGIN);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    const url = new URL(request.url);

    if (url.pathname === "/fountains" && request.method === "GET") {
      return handleGetFountains(env.DB, cors);
    }

    const ratingsMatch = url.pathname.match(/^\/fountains\/(\d+)\/ratings$/);
    if (ratingsMatch && request.method === "GET") {
      return handleGetRatings(env.DB, parseInt(ratingsMatch[1]), cors);
    }

    const ratingMatch = url.pathname.match(/^\/fountains\/(\d+)\/rating$/);
    if (ratingMatch && request.method === "POST") {
      return handlePostRating(env.DB, parseInt(ratingMatch[1]), request, cors);
    }

    const reportMatch = url.pathname.match(/^\/fountains\/(\d+)\/report$/);
    if (reportMatch && request.method === "POST") {
      return handlePostReport(env.DB, parseInt(reportMatch[1]), request, cors);
    }

    const attrMatch = url.pathname.match(/^\/fountains\/(\d+)\/attributes$/);
    if (attrMatch && request.method === "POST") {
      return handlePostAttributes(env.DB, parseInt(attrMatch[1]), request, cors);
    }

    return new Response("Not Found", { status: 404, headers: cors });
  },
};
