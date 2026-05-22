# Public Drinking Water Finder

## Background

As an avid urban runner, I'm always on the lookout for sources of clean drinking water so that I don't have to wear a pack or carry water with me, especially on longer runs. The city of Seattle has many public water fountains, but they are not always easy to locate, or are sometimes shut off. I want to know that I will have access to clean drinking water on my running routes. Access to clean water is a basic human right, yet even in urban areas with high standards of living, public drinking water can be elusive.

I see this project starting for and by runners, but it's really about the bigger issue of clean water.

## Vision

Access to clean drinking water for all, within 300 meters in urban areas. 

## Objective

Create a map of public water fountains for urban recreationists and others to easily see where they can expect drinking water nearby or near a planned destination.

## Tech Stack

**Frontend:**
- Vanilla HTML/CSS/JavaScript — no framework. Chosen for bundle size and simplicity given the modest UI surface (map + search + filters + ratings).
- [Leaflet](https://leafletjs.com/) for the map. Lightweight, strong native touch support (pinch/zoom/tap), no API key required. Preferred over Mapbox GL for this app because users primarily work at a consistent high zoom (~half-mile radius) rather than exploring across zoom levels.
- [Nominatim](https://nominatim.openstreetmap.org/) (OpenStreetMap) for address/landmark geocoding. No API key.
- Browser `navigator.geolocation` for the "locate me" feature.

**Hosting:**
- Static site hosting (Netlify, Vercel, Cloudflare Pages, or GitHub Pages — TBD). The app is fully client-side for V1.

**Backend (V2.1+):**
- [Cloudflare Workers](https://workers.cloudflare.com/) + [D1](https://developers.cloudflare.com/d1/) (SQLite at the edge).
- Chosen over Supabase, Firebase, and Deno Deploy because:
  - Expected V2.1 traffic is well within the free tier (~5k requests/month estimated for Seattle beta; free tier allows 100k/day)
  - SQL fits the relational schema (fountain → sources, fountain → ratings) better than Firestore's document model
  - No Supabase-style project pausing
  - Straightforward migration path to standard Postgres if the project grows

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

## Requirements

**V1:**
- Use publicly available data source(s)
- Allow searching for nearby water fountains by address, intersection, or landmark
- Give an indication whether a water fountain is currently expected to be running or if it has been shut off

**V2.1:**
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

**V2.2:**
- Publish site to a tillworks.com subdomain
- Do nightly backups of data (or are backups or some other fallback included in D1 by default?)
- Apply safeguards against OWASP top 10
- Implement logging

**V3:**
- Allow users to rate water fountains for cleanliness, water pressure, taste

**V4:**
- Add public bathrooms

**Backlog:**
- Fix map controls positioning
- Add admin filter to show edited and unedited fountains with counts of each
- Add doesn't exist option which requires validation
- Pre-load user's location on page load to reduce processing time when using locator button. Show polite error message if location services are disabled in the browser or on the device
- OSM fountains are all named "Drinking Fountain" but Seattle GIS fountains have a name (park name etc.). Recommend dropping fountain titles and including the Seattle GIS fountain name in the small print next to the data source.
- Allow users to note any access limitations
- Tech stack and data source licensing audit
- Accessibility audit
- Secure power user mode (authentication/PIN for attribute editing)
- Add branding
- Add about pages with background information and project context
- Caching strategy for upstream API fetches and the fountain index endpoint
- DB seed refresh strategy (detect new upstream fountains, periodic re-seed)
- Check Seattle City GIS data quality: do the City GIS fountains not in OSM actually exist? Is the Seattle City GIS data valuable?
- Create a map showing the availability of working fountains in lower-income areas
- Allow users to add water fountains
	- Require access restriction input (either confirm open to the public or add access restriction)
	- Add way for other users to verify
- Identify and add additional public data sources
- Add link to Google street view?
