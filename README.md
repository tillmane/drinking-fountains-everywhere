# Public Drinking Water Finder

## Background

As an avid urban runner, I'm always on the lookout for sources of clean drinking water so that I don't have to wear a pack or carry water with me, especially on longer runs. The city of Seattle has many public water fountains, but they are not always easy to locate, or are sometimes shut off. I want to know that I will have access to clean drinking water on my running routes. Access to clean water is a basic human right, yet even in urban areas with high standards of living, public drinking water can be elusive.

This project was founded by and for runners, but it's really about the bigger issue of clean water.

## Vision

Access to clean drinking water for all, within 300 meters in urban areas. 

## Objective

A map of public water fountains with information about fountain conditions lets urban recreationists easily find reliable drinking water.

## Requirements

### V1: POC (April 29, 2026)
- Use publicly available data source(s)
- Allow searching for nearby water fountains by address, intersection, or landmark
- Give an indication whether a water fountain is currently expected to be running or if it has been shut off

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
- Backend: Cloudflare Workers + D1, deployed at `drinking-fountains-api.tillmane.workers.dev`

### V2.2: Publish to Production and Ready for Pilot Users (pushed June 2, 2026)
- Publish frontend to Cloudflare Pages at `fountainsforall.urbanfreerunning.com`
- Gate access with Cloudflare Access (email allowlist)
- Structured request logging on all Worker endpoints
- CORS restricted to `fountainsforall.urbanfreerunning.com`
- Security response headers
- Rate limiting: configure a Cloudflare WAF rate-limiting rule on POST endpoints
- D1 backups: use D1 Time Travel (point-in-time restore, 30-day retention), plus scheduled snapshots to R2 objects
- Persistent request logging (pre-pilot): add D1 `request_log` table before opening to pilot group

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

### V2.4: A Simpler Rating Methodology
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
  - When a user clicks Not Found, show a dialog that says, "Are you sure this fountain is missing? Reporting it Not Found will remove it from the map."
  - Not Found fountains should not show on the map, except as a Layer in Admin mode
- Read Access for All
  - Allow anonymous users to be able to view the Pilot
  - Include an option to request Pilot access

### V3:
- Allow users to add water fountains
  - Require access restriction input (either confirm open to the public or add access restriction)
  - Add way for other users to verify

### V4:
- Add public bathrooms

### Backlog:
- Terms of Use
- Tech stack and data source licensing audit
- Accessibility audit
- Allow users to note any access limitations
- Add branding
- Add about pages with background information and project context
- Caching strategy for upstream API fetches and the fountain index endpoint
- DB seed refresh strategy (detect new upstream fountains, periodic re-seed)
- Find out how reliable / predictable seasonal shutoffs are. If they don't seem reliable consider re-introducing the unrated 6-month time delay requirement
- Check Seattle City GIS data quality: do the City GIS fountains not in OSM actually exist? Is the Seattle City GIS data valuable?
- Create a map showing the availability of working fountains in lower-income areas
- Identify and add additional public data sources
- Add link to Google street view?

## Tech Stack

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
- WAF rate-limiting rule: 4 POST req / 10 sec per IP on `drinking-fountains-api.urbanfreerunners.com` (CF Zone Ruleset API, `http_ratelimit` phase)

**Logging:**
- Ephemeral: structured JSON logs on all endpoints, viewable via `wrangler tail`
- Persistent: all POST requests (endpoint, fountain_id, device_id prefix, status, ms) written to D1 `request_log` table

**Backups:**
- CF D1 Time Travel — automatic point-in-time restore, 30-day retention, no setup required
- Daily SQL export to R2 bucket `drinking-fountains-db-backups` via GitHub Actions (`.github/workflows/db-backup.yml`)

**Data Sources:**
- [Seattle City GIS Drinking Fountain dataset](https://data-seattlecitygis.opendata.arcgis.com/datasets/SeattleCityGIS::drinking-fountain-1/) (ArcGIS REST API) — 212 active fountains. Authoritative for park fountains; location data is reliable but `CURRENT_STATUS` field is unmaintained (207 of 212 records are null).
- [OpenStreetMap](https://www.openstreetmap.org/) via the [Overpass API](https://wiki.openstreetmap.org/wiki/Overpass_API) — 456 nodes tagged `amenity=drinking_water` in the Seattle/Bellevue bounding box. Broader coverage (includes non-park fountains) but quality varies by contributor activity.

Fetches are live at page load for V1; a caching strategy will be needed before broader release.

**Coverage area:** Seattle and Bellevue, Washington (bounding box `47.3,-122.5,47.8,-122.1`). 576 total fountains after deduplication (92 matched across sources within 30m).

## Fountain Identity

Ratings and other user-contributed data attach to a **local fountain identifier** rather than any single upstream data source. Each local fountain may map to zero or more upstream sources (OSM node, Seattle City GIS OBJECTID, etc.), allowing:

- Ratings to aggregate correctly when the same physical fountain appears in multiple data sources
- User-submitted fountains with no upstream source to be supported
- Ratings to survive if upstream IDs change or disappear

Upstream sources are matched to local fountains by **proximity within 30 meters**. Analysis of current data shows ~92 of 212 Seattle City GIS fountains have an OSM match at this threshold, with the match curve plateauing between 20-30m.

## Deployment

### Release workflow

All changes are reviewed locally before being pushed to `main`. Pushing to `main` automatically deploys the frontend via Cloudflare Pages. Worker changes require a separate `npm run deploy`.

**Frontend changes:**
1. Make changes to `index.html`, `app.js`, or `style.css`
2. `npm run serve` — starts a local server at `http://localhost:8080`
3. Open `http://localhost:8080` in the browser and review against live production data
4. When satisfied: commit and push to `main` → Cloudflare Pages auto-deploys

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
npm run db:seed          # fetch upstream data and seed production D1
npm run dev              # run worker locally at localhost:8787
npm run db:schema:local  # apply schema to local D1
npm run db:seed:local    # seed local D1
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

### Backups

D1 Time Travel provides automatic point-in-time restore (30-day retention) — no setup needed. The `db-backup` GitHub Action also runs daily at 06:00 UTC, exporting a full SQL snapshot to the `drinking-fountains-db-backups` R2 bucket.

To restore from a Time Travel bookmark:
```bash
npx wrangler d1 time-travel restore drinking-fountains-db --timestamp="2026-06-01T12:00:00Z"
```

