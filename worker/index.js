function corsHeaders(allowedOrigin, requestOrigin) {
  const allowed = [allowedOrigin, "http://localhost:8080"];
  const origin = allowed.includes(requestOrigin) ? requestOrigin : allowedOrigin;
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Pilot-Token, X-Admin-Token",
  };
}

async function generatePilotToken(pin) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(pin),
    { name: "HMAC", hash: "SHA-256" },
    false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode("pilot-access"));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, "0")).join("");
}

async function verifyPilotToken(token, env) {
  if (!token || !env.PILOT_PIN) return false;
  const expected = await generatePilotToken(env.PILOT_PIN);
  return token === expected;
}

async function generateAdminToken(pin) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(pin),
    { name: "HMAC", hash: "SHA-256" },
    false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode("admin-access"));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, "0")).join("");
}

async function verifyAdminToken(token, env) {
  if (!token || !env.ADMIN_PIN) return false;
  const expected = await generateAdminToken(env.ADMIN_PIN);
  return token === expected;
}

async function requirePilotToken(request, env, cors) {
  const token = request.headers.get("X-Pilot-Token");
  if (!await verifyPilotToken(token, env)) {
    return err("Unauthorized", 401, cors);
  }
  return null;
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

const NOT_FOUND_THRESHOLD = 3;

async function handleAdminVerify(request, env, cors) {
  let body;
  try {
    body = await request.json();
  } catch {
    return err("Invalid JSON", 400, cors);
  }
  const { pin } = body;
  if (typeof pin !== "string" || pin.length === 0) {
    return err("Invalid PIN", 401, cors);
  }
  if (!env.ADMIN_PIN || pin !== env.ADMIN_PIN) {
    return err("Invalid PIN", 401, cors);
  }
  const token = await generateAdminToken(pin);
  return json({ ok: true, token }, 200, cors);
}

async function handlePilotVerify(request, env, cors) {
  let body;
  try {
    body = await request.json();
  } catch {
    return err("Invalid JSON", 400, cors);
  }
  const { pin } = body;
  if (typeof pin !== "string" || pin.length === 0) {
    return err("Invalid PIN", 401, cors);
  }
  if (!env.PILOT_PIN || pin !== env.PILOT_PIN) {
    return err("Invalid PIN", 401, cors);
  }
  const token = await generatePilotToken(pin);
  return json({ ok: true, token }, 200, cors);
}

async function handleGetFountains(db, cors) {
  const t0 = Date.now();
  try {
    const { results: fountains } = await db
      .prepare(
        `SELECT f.id, f.lat, f.lon, f.name,
                SUM(CASE WHEN r.score = 1 THEN 1 ELSE 0 END) AS thumbs_up,
                SUM(CASE WHEN r.score = 0 THEN 1 ELSE 0 END) AS thumbs_down,
                COUNT(r.score)                                AS rating_count,
                MAX(r.updated_at)                             AS last_rated_at
         FROM fountains f
         LEFT JOIN ratings r ON r.fountain_id = f.id
         GROUP BY f.id`
      )
      .all();

    const { results: sources } = await db
      .prepare("SELECT fountain_id, source_type, source_id, source_data FROM fountain_sources")
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

    const { results: nfReports } = await db
      .prepare(
        `SELECT fountain_id, COUNT(*) AS nf_count, MAX(created_at) AS last_nf_at
         FROM not_found_reports
         GROUP BY fountain_id`
      )
      .all();

    const sourceMap = {};
    for (const s of sources) {
      if (!sourceMap[s.fountain_id]) sourceMap[s.fountain_id] = [];
      sourceMap[s.fountain_id].push({
        source_type: s.source_type,
        source_id: s.source_id,
        source_data: s.source_data ? JSON.parse(s.source_data) : null,
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

    const nfMap = {};
    for (const r of nfReports) {
      nfMap[r.fountain_id] = { nf_count: r.nf_count, last_nf_at: r.last_nf_at };
    }

    log("info", "GET /fountains", { status: 200, ms: Date.now() - t0 });
    return json({
      fountains: fountains.map((f) => {
        const report = reportMap[f.id];
        const fa = attrMap[f.id] || {};
        return {
          ...f,
          thumbs_up: f.thumbs_up || 0,
          thumbs_down: f.thumbs_down || 0,
          sources: sourceMap[f.id] || [],
          reported_off: !!report,
          off_reports: report ? report.off_count : 0,
          last_off_report_at: report ? report.last_off_at : null,
          user_accessible: fa.accessible || false,
          user_bottle_filler: fa.bottle_filler || false,
          user_dog_bowl: fa.dog_bowl || false,
          not_found_count: nfMap[f.id] ? nfMap[f.id].nf_count : 0,
          not_found: nfMap[f.id] ? nfMap[f.id].nf_count >= NOT_FOUND_THRESHOLD : false,
          last_not_found_at: nfMap[f.id] ? nfMap[f.id].last_nf_at : null,
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

async function handlePostRating(db, fountainId, request, env, cors) {
  const authErr = await requirePilotToken(request, env, cors);
  if (authErr) return authErr;
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
    if (score !== 0 && score !== 1) {
      return err("Score must be 0 (thumbs down) or 1 (thumbs up)", 400, cors);
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
        `SELECT SUM(CASE WHEN score = 1 THEN 1 ELSE 0 END) AS thumbs_up,
                SUM(CASE WHEN score = 0 THEN 1 ELSE 0 END) AS thumbs_down,
                COUNT(score)                                AS rating_count,
                MAX(updated_at)                             AS last_rated_at
         FROM ratings WHERE fountain_id = ?`
      )
      .bind(fountainId)
      .first();

    const ms = Date.now() - t0;
    log("info", "POST /fountains/:id/rating", { fountainId, devicePrefix, score, status: 200, ms });
    await writeLog(db, "POST /rating", fountainId, devicePrefix, 200, ms);
    return json({
      fountain_id: fountainId,
      thumbs_up: agg.thumbs_up || 0,
      thumbs_down: agg.thumbs_down || 0,
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

async function handleDeleteRating(db, fountainId, request, env, cors) {
  const authErr = await requirePilotToken(request, env, cors);
  if (authErr) return authErr;
  const t0 = Date.now();
  let devicePrefix = "unknown";
  try {
    const fountain = await db
      .prepare("SELECT id FROM fountains WHERE id = ?")
      .bind(fountainId)
      .first();
    if (!fountain) return err("Fountain not found", 404, cors);

    let body;
    try { body = await request.json(); } catch { return err("Invalid JSON", 400, cors); }
    const { device_id } = body;
    if (typeof device_id !== "string" || device_id.length < 1 || device_id.length > 64) {
      return err("Invalid device_id", 400, cors);
    }
    devicePrefix = device_id.slice(0, 8);

    await db
      .prepare("DELETE FROM ratings WHERE fountain_id = ? AND device_id = ?")
      .bind(fountainId, device_id)
      .run();

    const agg = await db
      .prepare(
        `SELECT SUM(CASE WHEN score = 1 THEN 1 ELSE 0 END) AS thumbs_up,
                SUM(CASE WHEN score = 0 THEN 1 ELSE 0 END) AS thumbs_down,
                COUNT(score)                                AS rating_count,
                MAX(updated_at)                             AS last_rated_at
         FROM ratings WHERE fountain_id = ?`
      )
      .bind(fountainId)
      .first();

    const ms = Date.now() - t0;
    log("info", "DELETE /fountains/:id/rating", { fountainId, devicePrefix, status: 200, ms });
    await writeLog(db, "DELETE /rating", fountainId, devicePrefix, 200, ms);
    return json({
      fountain_id: fountainId,
      thumbs_up: agg.thumbs_up || 0,
      thumbs_down: agg.thumbs_down || 0,
      rating_count: agg.rating_count || 0,
      last_rated_at: agg.last_rated_at,
      your_score: null,
    }, 200, cors);
  } catch (e) {
    const ms = Date.now() - t0;
    log("error", "DELETE /fountains/:id/rating", { fountainId, devicePrefix, error: e.message, ms });
    await writeLog(db, "DELETE /rating", fountainId, devicePrefix, 500, ms);
    return err("Internal server error", 500, cors);
  }
}

async function handlePostReport(db, fountainId, request, env, cors) {
  const authErr = await requirePilotToken(request, env, cors);
  if (authErr) return authErr;
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

async function handlePostAttributes(db, fountainId, request, env, cors) {
  const authErr = await requirePilotToken(request, env, cors);
  if (authErr) return authErr;
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
    if (attribute !== "accessible" && attribute !== "bottle_filler" && attribute !== "dog_bowl") {
      return err("Attribute must be 'accessible', 'bottle_filler', or 'dog_bowl'", 400, cors);
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

    const out = { fountain_id: fountainId, user_accessible: false, user_bottle_filler: false, user_dog_bowl: false };
    for (const r of results) {
      if (r.attribute === "accessible") out.user_accessible = r.value === 1;
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

async function handlePostNotFound(db, fountainId, request, env, cors) {
  const authErr = await requirePilotToken(request, env, cors);
  if (authErr) return authErr;
  const t0 = Date.now();
  let devicePrefix = "unknown";
  try {
    const fountain = await db
      .prepare("SELECT id FROM fountains WHERE id = ?")
      .bind(fountainId)
      .first();
    if (!fountain) return err("Fountain not found", 404, cors);

    let body;
    try { body = await request.json(); } catch { return err("Invalid JSON", 400, cors); }
    const { device_id } = body;
    if (typeof device_id !== "string" || device_id.length < 1 || device_id.length > 64) {
      return err("Invalid device_id", 400, cors);
    }
    devicePrefix = device_id.slice(0, 8);

    await db
      .prepare("INSERT OR IGNORE INTO not_found_reports (fountain_id, device_id) VALUES (?, ?)")
      .bind(fountainId, device_id)
      .run();

    const agg = await db
      .prepare("SELECT COUNT(*) AS nf_count, MAX(created_at) AS last_nf_at FROM not_found_reports WHERE fountain_id = ?")
      .bind(fountainId)
      .first();

    const nfCount = agg.nf_count || 0;
    const ms = Date.now() - t0;
    log("info", "POST /fountains/:id/not-found", { fountainId, devicePrefix, status: 200, ms });
    await writeLog(db, "POST /not-found", fountainId, devicePrefix, 200, ms);
    return json({
      fountain_id: fountainId,
      not_found_count: nfCount,
      not_found: nfCount >= NOT_FOUND_THRESHOLD,
      last_not_found_at: agg.last_nf_at,
      your_report: true,
    }, 200, cors);
  } catch (e) {
    const ms = Date.now() - t0;
    log("error", "POST /fountains/:id/not-found", { fountainId, devicePrefix, error: e.message, ms });
    await writeLog(db, "POST /not-found", fountainId, devicePrefix, 500, ms);
    return err("Internal server error", 500, cors);
  }
}

async function handleDeleteNotFound(db, fountainId, request, env, cors) {
  const t0 = Date.now();
  let devicePrefix = "unknown";
  try {
    const fountain = await db
      .prepare("SELECT id FROM fountains WHERE id = ?")
      .bind(fountainId)
      .first();
    if (!fountain) return err("Fountain not found", 404, cors);

    let body;
    try { body = await request.json(); } catch { return err("Invalid JSON", 400, cors); }
    const { device_id, admin_token } = body;

    const isAdmin = await verifyAdminToken(admin_token, env);

    if (!isAdmin) {
      const authErr = await requirePilotToken(request, env, cors);
      if (authErr) return authErr;
    }

    if (isAdmin) {
      await db
        .prepare("DELETE FROM not_found_reports WHERE fountain_id = ?")
        .bind(fountainId)
        .run();
      devicePrefix = "admin";
    } else {
      if (typeof device_id !== "string" || device_id.length < 1 || device_id.length > 64) {
        return err("Invalid device_id", 400, cors);
      }
      devicePrefix = device_id.slice(0, 8);
      await db
        .prepare("DELETE FROM not_found_reports WHERE fountain_id = ? AND device_id = ?")
        .bind(fountainId, device_id)
        .run();
    }

    const agg = await db
      .prepare("SELECT COUNT(*) AS nf_count, MAX(created_at) AS last_nf_at FROM not_found_reports WHERE fountain_id = ?")
      .bind(fountainId)
      .first();

    const nfCount = agg.nf_count || 0;
    const ms = Date.now() - t0;
    log("info", "DELETE /fountains/:id/not-found", { fountainId, devicePrefix, isAdmin, status: 200, ms });
    await writeLog(db, "DELETE /not-found", fountainId, devicePrefix, 200, ms);
    return json({
      fountain_id: fountainId,
      not_found_count: nfCount,
      not_found: nfCount >= NOT_FOUND_THRESHOLD,
      last_not_found_at: agg.last_nf_at,
      your_report: false,
    }, 200, cors);
  } catch (e) {
    const ms = Date.now() - t0;
    log("error", "DELETE /fountains/:id/not-found", { fountainId, devicePrefix, error: e.message, ms });
    await writeLog(db, "DELETE /not-found", fountainId, devicePrefix, 500, ms);
    return err("Internal server error", 500, cors);
  }
}

async function handleGetContributions(db, request, env, cors) {
  const token = request.headers.get("X-Admin-Token");
  if (!await verifyAdminToken(token, env)) {
    return err("Unauthorized", 401, cors);
  }

  const url = new URL(request.url);
  const period = url.searchParams.get("period") || "7d";
  const periodDays = { "1d": 1, "7d": 7, "30d": 30, "90d": 90 }[period];
  if (!periodDays) return err("Invalid period", 400, cors);

  try {
    // Daily buckets for ratings, off reports, not-found reports
    const [ratingsRows, offRows, nfRows, avgRows, newlyRatedRows, uniqueDevicesRows, summaryRatings, summaryNewlyRated] =
      await Promise.all([
        db.prepare(
          `SELECT date(updated_at) AS day, COUNT(*) AS count
           FROM ratings
           WHERE updated_at >= datetime('now', ? || ' days')
           GROUP BY day ORDER BY day`
        ).bind(-periodDays).all(),

        db.prepare(
          `SELECT date(created_at) AS day, COUNT(*) AS count
           FROM status_reports
           WHERE status = 'off' AND created_at >= datetime('now', ? || ' days')
           GROUP BY day ORDER BY day`
        ).bind(-periodDays).all(),

        db.prepare(
          `SELECT date(created_at) AS day, COUNT(*) AS count
           FROM not_found_reports
           WHERE created_at >= datetime('now', ? || ' days')
           GROUP BY day ORDER BY day`
        ).bind(-periodDays).all(),

        db.prepare(
          `SELECT date(updated_at) AS day,
                  ROUND(CAST(COUNT(*) AS REAL) / COUNT(DISTINCT device_id), 1) AS avg_per_device
           FROM ratings
           WHERE updated_at >= datetime('now', ? || ' days')
           GROUP BY day ORDER BY day`
        ).bind(-periodDays).all(),

        db.prepare(
          `SELECT date(first_rated) AS day, COUNT(*) AS count FROM (
             SELECT fountain_id, MIN(updated_at) AS first_rated
             FROM ratings GROUP BY fountain_id
           ) WHERE first_rated >= datetime('now', ? || ' days')
           GROUP BY day ORDER BY day`
        ).bind(-periodDays).all(),

        db.prepare(
          `SELECT date(updated_at) AS day, COUNT(DISTINCT device_id) AS count
           FROM ratings
           WHERE updated_at >= datetime('now', ? || ' days')
           GROUP BY day ORDER BY day`
        ).bind(-periodDays).all(),

        db.prepare(
          `SELECT COUNT(*) AS total, COUNT(DISTINCT device_id) AS devices
           FROM ratings
           WHERE updated_at >= datetime('now', ? || ' days')`
        ).bind(-periodDays).first(),

        db.prepare(
          `SELECT COUNT(*) AS count FROM (
             SELECT fountain_id, MIN(updated_at) AS first_rated
             FROM ratings GROUP BY fountain_id
           ) WHERE first_rated >= datetime('now', ? || ' days')`
        ).bind(-periodDays).first(),
      ]);

    // Build a complete date range so charts have no gaps
    const days = [];
    for (let i = periodDays - 1; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400000);
      days.push(d.toISOString().slice(0, 10));
    }

    function toMap(rows) {
      const m = {};
      for (const r of rows.results) m[r.day] = r.count;
      return m;
    }

    const rMap  = toMap(ratingsRows);
    const oMap  = toMap(offRows);
    const nMap  = toMap(nfRows);
    const udMap = toMap(uniqueDevicesRows);
    const nrMap = toMap(newlyRatedRows);

    const avgMap = {};
    for (const r of avgRows.results) avgMap[r.day] = r.avg_per_device;

    const series = days.map(function(day) {
      return {
        day,
        ratings:              rMap[day]  || 0,
        off_reports:          oMap[day]  || 0,
        not_found_reports:    nMap[day]  || 0,
        unique_devices:       udMap[day] || 0,
        newly_rated:          nrMap[day] || 0,
        avg_ratings_per_device: avgMap[day] != null ? avgMap[day] : null,
      };
    });

    const totalRatings = summaryRatings.total || 0;
    const uniqueDevices = summaryRatings.devices || 0;
    const avgRatingsPerDevice = uniqueDevices > 0 ? Math.round((totalRatings / uniqueDevices) * 10) / 10 : 0;

    return json({
      period,
      series,
      summary: {
        total_ratings: totalRatings,
        unique_devices: uniqueDevices,
        avg_ratings_per_device: avgRatingsPerDevice,
        newly_rated_fountains: summaryNewlyRated.count || 0,
      },
    }, 200, cors);
  } catch (e) {
    log("error", "GET /admin/contributions", { error: e.message });
    return err("Internal server error", 500, cors);
  }
}

export default {
  async fetch(request, env) {
    const cors = corsHeaders(env.ALLOWED_ORIGIN, request.headers.get("Origin"));

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    const url = new URL(request.url);

    if (url.pathname === "/admin/verify" && request.method === "POST") {
      return handleAdminVerify(request, env, cors);
    }

    if (url.pathname === "/admin/contributions" && request.method === "GET") {
      return handleGetContributions(env.DB, request, env, cors);
    }

    if (url.pathname === "/pilot/verify" && request.method === "POST") {
      return handlePilotVerify(request, env, cors);
    }

    if (url.pathname === "/fountains" && request.method === "GET") {
      return handleGetFountains(env.DB, cors);
    }

    const ratingsMatch = url.pathname.match(/^\/fountains\/(\d+)\/ratings$/);
    if (ratingsMatch && request.method === "GET") {
      return handleGetRatings(env.DB, parseInt(ratingsMatch[1]), cors);
    }

    const ratingMatch = url.pathname.match(/^\/fountains\/(\d+)\/rating$/);
    if (ratingMatch && request.method === "POST") {
      return handlePostRating(env.DB, parseInt(ratingMatch[1]), request, env, cors);
    }
    if (ratingMatch && request.method === "DELETE") {
      return handleDeleteRating(env.DB, parseInt(ratingMatch[1]), request, env, cors);
    }

    const reportMatch = url.pathname.match(/^\/fountains\/(\d+)\/report$/);
    if (reportMatch && request.method === "POST") {
      return handlePostReport(env.DB, parseInt(reportMatch[1]), request, env, cors);
    }

    const attrMatch = url.pathname.match(/^\/fountains\/(\d+)\/attributes$/);
    if (attrMatch && request.method === "POST") {
      return handlePostAttributes(env.DB, parseInt(attrMatch[1]), request, env, cors);
    }

    const nfMatch = url.pathname.match(/^\/fountains\/(\d+)\/not-found$/);
    if (nfMatch && request.method === "POST") {
      return handlePostNotFound(env.DB, parseInt(nfMatch[1]), request, env, cors);
    }
    if (nfMatch && request.method === "DELETE") {
      return handleDeleteNotFound(env.DB, parseInt(nfMatch[1]), request, env, cors);
    }

    return new Response("Not Found", { status: 404, headers: cors });
  },
};
