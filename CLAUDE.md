# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Public Drinking Water Finder** - A map-based application to locate public drinking water fountains in urban areas, initially focused on Seattle. The project aims to provide access to clean drinking water for all, within 300 meters in urban areas.

**Target Users:** Urban runners, recreationists, and anyone seeking access to public drinking water.

**Live site:** https://fountainsforall.urbanfreerunners.com

**Current Status:** V2.4 in production. Full feature set including map with Seattle City GIS + OpenStreetMap data, binary ratings (thumbs up/down), user-reported attributes (accessible, bottle filler, dog bowl), Report Off/On, and Not Found reports with hide-at-threshold behavior.

## Tech Stack

- **Frontend:** Static files (`index.html`, `app.js`, `style.css`) served by Cloudflare Pages, auto-deployed from `main` branch. No build step.
- **Backend:** Cloudflare Workers (`worker/index.js`) + D1 SQLite database (`worker/schema.sql`).
- **Map:** Leaflet.js. All fountain data served from D1 via the Worker — no browser-side ArcGIS or Overpass fetches at runtime.

## Development Workflow

**All changes are reviewed locally before merging to `main`.**

- Work on the `dev` branch. Never commit directly to `main`.
- `npm run serve` — serves frontend at `localhost:8080` against live production API data (CORS allows localhost).
- When satisfied: merge `dev` → `main` and push → Cloudflare Pages auto-deploys the frontend.
- Worker changes require a separate `npm run deploy` after merging to `main`.
- Schema changes: `npm run db:schema` (idempotent `CREATE TABLE IF NOT EXISTS`).

## Key Architecture Notes

- Fountain data from two sources (City GIS + OSM) is deduplicated and stored in D1 via `fountain_sources` table. Matching by proximity within 30 meters. Full upstream JSON is stored in `fountain_sources.source_data`.
- Upstream data is synced manually (not at page load) using `npm run sync`. Run this monthly or when source data changes (new fountains, seasonal shutoffs, OBJECTID drift).
- Anonymous device IDs (`localStorage`) identify users for ratings and reports — no accounts.
- Admin mode requires a PIN verified by the Worker (`POST /admin/verify`). PIN stored in `sessionStorage` for the session; also held in `adminPin` module variable for use in admin API calls.
- `fountainIndex` is a client-side map keyed by both fountain `id` (integer) and `"source_type:source_id"` strings, populated from `GET /fountains`. `fountainList` is the canonical ordered array.
- Leaflet markers store `marker._fountainId` (integer) for surgical icon updates without full re-render.
- `renderAll()` is used when fountain visibility changes (report off, not found); `updateMarkerForFountain()` for icon-only updates (rating changes).
