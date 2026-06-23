# Public Drinking Water Finder

## Vision

Access to clean drinking water for all, within 300 meters in urban areas. 

## Objective

A map of public water fountains with information about fountain conditions lets urban recreationists easily find reliable drinking water.

## Background

As an avid urban runner, I'm always on the lookout for sources of clean drinking water so that I don't have to wear a pack or carry water with me, especially on longer runs. The city of Seattle has many public water fountains, but they're not always easy to locate, and I often find them shut off or decommissioned. I want to know that I will have access to clean drinking water on my running routes, but really I want the same for anyone in our city. 

Access to clean water is a basic human right, yet even in urban areas with high standards of living, public drinking water can be elusive.

## Release History

### V3.0: Pilot Launch 
- Read Access for All
  - Allow anonymous users to be able to view the Pilot
  - Include an option to request Pilot access


### V2.4: A Simpler Rating Methodology (pushed June 14, 2026)
- Bugs/Dumb Stuff
  - Accessible filter doesn't work. Probably not pointing to the new attribute.
- Change Ratings Structure
  - I've decided to use a binary good/bad rating format instead of 1-5. Instead of stars, use thumbs up / thumbs down
  - Replace smile pins with thumb up or down (keep question mark if not rated)
  - Data transformation: change any 1-2 star ratings to thumb down and 3-5 star ratings to thumb up
  - Add tool tip guidance to help users know what a thumb up or down should really mean. (Details TBD)
- UX Updates
  - Make pins for unrated fountains grey, not blue
  - In the fountain pop-up, move the data source (OpenStreetMap or Seattle City GIS) to the bottom of the pop-up
- Missing Fountains
  - Allow users to report a fountain as Not Found
  - When a user clicks Not Found, show a dialog that says, "Are you sure this fountain is missing? Reporting it Not Found may remove it from the map."
  - Not Found fountains should not show on the map after 3 reports, except as a Layer in Admin mode

### V2.3: Make It Better for Pilot Users (pushed June 10, 2026)
- Bugs/Dumb Stuff
  - Add ability to rate Seattle City GIS fountains
- UX Improvements
  - Only show different-colored pins depending on data source when in Admin mode. The default pin color for regular users should be the darker blue.
  - Fountains that have not been rated or that were rated over 6 months ago should have a different pin (color or question mark pin? Or show a smile in pins that have been rated, with degree of smile dependent on star rating)
  - Pre-load user's location on page load to reduce processing time when using locator button. Show polite error message if location services are disabled in the browser or on the device
  - Fix map controls positioning
  - Add a map legend (map pin colors)
  - OSM fountains are all named "Drinking Fountain" but Seattle GIS fountains have a name (park name etc.). Recommend dropping fountain titles and including the Seattle GIS fountain name in the small print next to the data source.
  - When a user rates a fountain, update the icon to match the rating.
- Admin Features
  - Add admin filter to show edited and unedited fountains with counts of each
  - Secure Admin mode (authentication/PIN for attribute editing)

### V2.2: Publish to Production and Ready for Pilot Users (pushed June 2, 2026)
- Publish frontend to Cloudflare Pages at `fountainsforall.urbanfreerunning.com`
- Gate access with Cloudflare Access (email allowlist)
- Structured request logging on all Worker endpoints
- CORS restricted to `fountainsforall.urbanfreerunning.com`
- Security response headers
- Rate limiting: configure a Cloudflare WAF rate-limiting rule on POST endpoints
- D1 backups: use D1 Time Travel (point-in-time restore, 30-day retention), plus scheduled snapshots to R2 objects
- Persistent request logging (pre-pilot): add D1 `request_log` table before opening to pilot group

### V2.1: Add User Ratings Capability (pushed May 22, 2026)
- Allow users to submit water fountain ratings on a scale of 1 to 5
- Show the date of the last rating
- Anonymous ratings using device identifier (localStorage UUID) for abuse control; one rating per device per fountain (upsert)
- Allow users to report a fountain as off or on
  - Source-off (City GIS `CURRENT_STATUS`): red pin, user input disabled
  - User-reported off: orange pin, "Reported off (N) as of [date]"; reporting on clears all off reports
- Expand coverage area to include Bellevue, WA
- Filter by Accessible, Bottle Filler, and Dog Bowl attributes
- Power user mode (gear icon, bottom-left) shows Layers control and enables editing of Bottle Filler and Dog Bowl attributes on any fountain
- User-contributed attributes stored separately from source data in D1; merged at display time and for filtering
- Backend: Cloudflare Workers + D1

### V1: POC (April 29, 2026)
- Use publicly available data source(s)
- Allow searching for nearby water fountains by address, intersection, or landmark
- Give an indication whether a water fountain is currently expected to be running or if it has been shut off

## Tech Stack

**Data Sources:**
- [Seattle City GIS Drinking Fountain dataset](https://data-seattlecitygis.opendata.arcgis.com/datasets/SeattleCityGIS::drinking-fountain-1/) (ArcGIS REST API) — 212 active fountains. Authoritative for park fountains; location data is reliable but `CURRENT_STATUS` field is largely unmaintained.
- [OpenStreetMap](https://www.openstreetmap.org/) via the [Overpass API](https://wiki.openstreetmap.org/wiki/Overpass_API) — 456 nodes tagged `amenity=drinking_water` in the Seattle/Bellevue bounding box. Broader coverage (includes non-park fountains) but quality varies by contributor activity.

Upstream data is fetched and synced into D1 manually using `npm run sync` (see Sync section below). The browser never hits ArcGIS or Overpass directly.

**Coverage area:** Seattle and Bellevue, Washington (bounding box `47.3,-122.5,47.8,-122.1`). 576 total fountains after deduplication (92 matched across sources within 30m).

**Frontend:**
- Vanilla HTML/CSS/JavaScript — no framework. Chosen for bundle size and simplicity given the modest UI surface (map + search + filters + ratings).
- [Leaflet](https://leafletjs.com/) for the map. Lightweight, strong native touch support (pinch/zoom/tap), no API key required. Preferred over Mapbox GL for this app because users primarily work at a consistent high zoom (~half-mile radius) rather than exploring across zoom levels.
- [Nominatim](https://nominatim.openstreetmap.org/) (OpenStreetMap) for address/landmark geocoding. No API key.
- Browser `navigator.geolocation` for the "locate me" feature.

**Hosting:**
- **Frontend:** [Cloudflare Pages](https://pages.cloudflare.com/) — auto-deploys from `main` branch on push, no build step (static files served from repo root). Live at `fountainsforall.urbanfreerunners.com`.
- **Backend:** [Cloudflare Workers](https://workers.cloudflare.com/) + [D1](https://developers.cloudflare.com/d1/) (SQLite at the edge) at `drinking-fountains-api.urbanfreerunners.com`. Deploy with `npm run deploy`.
- Chosen over Supabase, Firebase, and Deno Deploy because:
  - Expected traffic is well within the free tier (~5k requests/month estimated for Seattle beta; free tier allows 100k/day)
  - SQL fits the relational schema (fountain → sources, fountain → ratings) better than Firestore's document model
  - No Supabase-style project pausing
  - Straightforward migration path to standard Postgres if the project grows

**Access control:**
- [Cloudflare Access](https://www.cloudflare.com/zero-trust/products/access/) gates `fountainsforall.urbanfreerunners.com` behind Google OAuth or email OTP; access restricted to an email allowlist

**Security:**
- CORS restricted to `fountainsforall.urbanfreerunners.com` via `ALLOWED_ORIGIN` env var in `wrangler.toml`
- Security response headers served by Cloudflare Pages (`_headers`): `X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`
- WAF rate-limiting rule

**Logging:**
- Ephemeral: structured JSON logs on all endpoints, viewable via `wrangler tail`
- Persistent: all POST requests (endpoint, fountain_id, device_id prefix, status, ms) written to D1 `request_log` table

**Backups:**
- CF D1 Time Travel — automatic point-in-time restore, 30-day retention, no setup required
- Daily SQL export to R2 bucket `drinking-fountains-db-backups` via GitHub Actions (`.github/workflows/db-backup.yml`)

## License and Terms Audit

Audited June 2026.

| Component | License / Terms | Attribution Required | Share-Alike | Commercial Use |
|---|---|---|---|---|
| Leaflet.js | BSD 2-Clause | No (notice embedded in JS file) | No | Yes |
| OpenStreetMap data | ODbL 1.0 | Yes — "© OpenStreetMap contributors" on map | Derivative databases only | Yes |
| Overpass API | FOSSGIS public instance usage policy | No | No | Discouraged on public instance |
| Nominatim | ODbL 1.0 (data) + OSMF usage policy | Yes (ODbL) | No | Yes, with caveats |
| Seattle City GIS | No formal license; public domain de facto | Recommended | No | Yes |
| Cloudflare Pages / Workers / D1 / Access | Cloudflare Developer Platform Terms | No | No | Yes (free tier, no restriction) |

### Notes

**OpenStreetMap data (ODbL 1.0):** The share-alike clause applies only to redistributed derivative databases — it does not reach the app's own data (ratings, reports, device IDs). A "Produced Work" such as this web app may be licensed independently. Attribution must be visible in the map UI.

**Overpass API:** The FOSSGIS public instance policy flags apps that rely on it as a backend for end users as a problematic use case. This project addresses that by querying Overpass only during `npm run sync` (manual/periodic server-side seeding), never at user page load. `sync.js` sets a `User-Agent` header identifying the app.

**Nominatim:** The public instance enforces a hard 1 request/second cap across all users of an app, with no autocomplete or bulk geocoding permitted. Geocoding calls are made client-side, so the browser's `Referer` header (your domain) satisfies the identification requirement automatically. Results are not currently cached — acceptable at pilot scale, worth revisiting if usage grows.

**Seattle City GIS:** No formal open license is attached to the dataset. It is published on the City's open data portal under Seattle's Open Data Policy (Executive Order 2016-01), which mandates open access. The dataset metadata lists "City of Seattle, Seattle Parks and Recreation" as the expected credit. Attribution is not legally enforceable but is recommended practice.

**Cloudflare free tier limits:** Workers 100k requests/day; D1 50M rows read/day, 100k rows written/day, 5 GB storage; Access 50 seats. All well within limits at current scale.

## Fountain Identity

Ratings and other user-contributed data attach to a **local fountain identifier** rather than any single upstream data source. Each local fountain may map to zero or more upstream sources (OSM node, Seattle City GIS OBJECTID, etc.), allowing:

- Ratings to aggregate correctly when the same physical fountain appears in multiple data sources
- User-submitted fountains with no upstream source to be supported
- Ratings to survive if upstream IDs change or disappear

Upstream sources are matched to local fountains by **proximity within 30 meters**. Analysis of current data shows ~92 of 212 Seattle City GIS fountains have an OSM match at this threshold, with the match curve plateauing between 20-30m.

## Fountain State Logic
| Rated? | Reported Off? | Reported Not Found 1-2 times? | Reported Not Found 3 times? | Rateable | Report Off button state | Not Found button state | Map Pin                                                 |
| ------ | ------------- | ----------------------------- | --------------------------- | -------- | ----------------------- | ---------------------- | ------------------------------------------------------- |
| N      | N             | N                             | N                           | Y        | Report off              | Not found              | grey with ?                                             |
| Y or N | Y             | N                             | N                           | Y        | Report on               | Not found              | orange with X                                           |
| Y or N | Y or N        | Y - by current user           | N                           | N        | not visible             | Undo not found         | orange with ?                                           |
| Y or N | Y or N        | Y - by other users            | N                           | N        | not visible             | Confirm not found      | orange with ?                                           |
| Y or N | Y or N        | Y or N                        | Y                           | Y        | Report on               | Undo not found         | not visible except in Admin mode shows as orange with ? |
| Y      | N             | N                             | N                           | Y        | Report off              | Not found              | blue with thumb up or down                              |

## Deployment

### Release workflow

All changes are reviewed locally before being pushed to `main`. Pushing to `main` automatically deploys the frontend via Cloudflare Pages. Worker changes require a separate `npm run deploy`.

**Frontend changes:**
1. Make changes to `index.html`, `app.js`, or `style.css`
2. `npm run serve` — starts a local server at `http://localhost:8080`
3. Open `http://localhost:8080` in the browser and review against live production data
4. When satisfied: commit and push to `main` → Cloudflare Pages auto-deploys

**Simulating pilot mode locally:**

The app is publicly accessible. Click "click here" in the banner and enter the pilot PIN to unlock write mode — this works the same locally as in production.

To skip the modal and activate pilot mode directly from the DevTools console (note: write requests will be rejected by the Worker without a valid token — use the normal PIN flow to get a real session):

```javascript
sessionStorage.setItem("pilot_unlocked", "1");
location.reload();
```

To return to anonymous read-only mode:

```javascript
sessionStorage.removeItem("pilot_unlocked");
sessionStorage.removeItem("pilot_token");
location.reload();
```

**Worker changes:**
1. Make changes to `worker/index.js`
2. Review logic; test locally with `npm run dev` if needed
3. When satisfied: commit, push to `main`, then `npm run deploy`

> The worker allows CORS from both `https://fountainsforall.urbanfreerunners.com` and `http://localhost:8080` so local review uses real production data.

### Frontend (Cloudflare Pages)

Connected to the `main` branch of this repo. Pushes to `main` trigger an automatic deploy. No build step — Pages serves static files from the repo root (`index.html`, `app.js`, `style.css`, `favicon.svg`, `_headers`).

### Worker (Cloudflare Workers + D1)

```bash
npm run serve            # serve frontend locally at localhost:8080 for review
npm run deploy           # deploy worker/index.js to production
npm run db:schema        # apply schema.sql to production D1 (idempotent)
npm run db:seed          # (initial setup only) seed production D1 from upstream sources
npm run dev              # run worker locally at localhost:8787
npm run db:schema:local  # apply schema to local D1
npm run db:seed:local    # seed local D1
npm run sync:preview     # fetch upstream data and write worker/sync-data.sql for review
npm run sync             # fetch upstream data and apply to production D1
```

### Refreshing local DB from a production backup

1. Download a backup file from the `drinking-fountains-db-backups` R2 bucket (CF dashboard → R2 → bucket → click file → Download). Save it anywhere — e.g. `worker/prod-backup-<timestamp>.sql`.
2. Run: `npm run db:restore-local -- worker/prod-backup-<timestamp>.sql`

This wipes the local D1 state and loads the backup. The `worker/prod-backup-*.sql` pattern is gitignored.

> **Note:** The backup action requires the `CLOUDFLARE_API_TOKEN` secret to have **D1 → Edit** permission to export data (not just schema).

### Access allowlist

Edit `access-allowlist.txt` (one email per line, `#` for comments) and push to `main`. The `sync-access-allowlist` GitHub Action updates the CF Access policy automatically.

### Logs

```bash
npx wrangler tail   # stream live Worker logs

# Query persistent request_log in D1:
npx wrangler d1 execute drinking-fountains-db --remote \
  --command="SELECT * FROM request_log ORDER BY created_at DESC LIMIT 50"
```

### Syncing upstream fountain data

Fountain positions, source IDs, and attributes (park name, accessible, bottle filler, etc.) are stored in D1 and served entirely from the Worker. The browser never fetches ArcGIS or Overpass directly.

Run a sync when:
- ArcGIS OBJECTIDs have drifted (symptom: City GIS fountains show "Ratings coming soon")
- New fountains have been added to either upstream source
- Seasonal shutoff status has changed (spring/autumn)
- Roughly monthly is sufficient

```bash
npm run sync:preview     # fetch upstream data, write worker/sync-data.sql — review before applying
npm run sync             # fetch upstream data and apply directly to production D1
```

The sync script (`worker/sync.js`):
- Fetches all active City GIS fountains from the ArcGIS FeatureServer
- Fetches all `amenity=drinking_water` nodes from Overpass in the Seattle/Bellevue bounding box
- Matches each upstream feature to existing D1 fountains by proximity (within 30m)
- Inserts new `fountains` rows only for unmatched features
- Upserts `fountain_sources` rows, refreshing `source_data` JSON for all matched features

**What it does NOT touch:** ratings, attributes, reports, or any user-contributed data. These are keyed to the internal integer `fountain_id` and survive syncs unchanged.

#### First-time schema migration

If upgrading from a database that predates the `source_data` column, apply the migration first:

```bash
npm run db:migrate:add-source-data
```

### Backups

D1 Time Travel provides automatic point-in-time restore (30-day retention) — no setup needed. The `db-backup` GitHub Action also runs daily at 06:00 UTC, exporting a full SQL snapshot to the `drinking-fountains-db-backups` R2 bucket.

To restore from a Time Travel bookmark:
```bash
npx wrangler d1 time-travel restore drinking-fountains-db --timestamp="2026-06-01T12:00:00Z"
```

