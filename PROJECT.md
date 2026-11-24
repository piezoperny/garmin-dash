# Project: garmin-dash (Milestones M1–M4)

## Architecture
- **Backend / Ingestion**: Python (`src/ingestion/sync.py`, `src/ingestion/mock_generator.py`, `src/encryption/encrypt.py`, `src/cleanup.py` or `cleanup`).
- **Frontend**: Vanilla JS + Chart.js + custom Canvas (`frontend/index.html`, `frontend/src/main.js`, `frontend/src/charts/*.js`), bundled into `dist/` via `node frontend/build.js`.
- **Encrypted Data**: `public/data.enc` generated via `python3 -m src.encryption.encrypt --mock --verify`.

## Feature Inventory
| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| 1 | Calendar 0m & Wellness Fix | Fix `distance_meters`, `duration_seconds`/`moving_time_seconds`, `elevation_gain_meters`, `sleep_seconds`, `stress_level` | M1 | implementation_plan.md |
| 2 | Calendar Persistent Collapse | Persist `calendar_collapsed` in `localStorage` (`garmin_dash_calendar_collapsed` & `garmin_dash_customization`) | M1 | implementation_plan.md |
| 3 | Heatmap Tabs Data Binding | Fix `rollup.wellness.daily` lookup & `sleep_seconds` fallback in `achievements.js` | M1 | implementation_plan.md |
| 4 | Weight Training HR Stream & Profile | Preserve `telemetry_stream.hr` for strength/weights when present; render dynamic interval HR curve in `activities.js` | M2 | implementation_plan.md |
| 5 | VO2 Max Trend & Zoomed Y-Axis | `resolveVo2MaxSeries` backfill/interpolation + dynamic Y-axis (`min - 2.0` to `max + 2.0`) | M3 | implementation_plan.md |
| 6 | Main Section Reordering & Final Build | Orderable `#dashboard-main` sections persisted in `localStorage`, rebuild `dist/` & `public/data.enc`, `cleanup --verify-only` | M4 | implementation_plan.md |

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| 1 | M1: Calendar & Heatmap Fixes | `frontend/src/charts/calendar.js`, `frontend/src/charts/achievements.js`, `tests/test_m7_garmin_calendar.js`, `tests/test_m9_prs_and_heatmap.js` | none | IN_PROGRESS |
| 2 | M2: Weight Training HR Profile | `src/ingestion/sync.py`, `src/ingestion/mock_generator.py`, `frontend/src/charts/activities.js` | none | IN_PROGRESS |
| 3 | M3: VO2 Max Trend & Y-Axis | `frontend/src/charts/trends_modal.js`, `src/ingestion/mock_generator.py`, `tests/test_m8_readiness_and_vitals.js` | M2 (shared `mock_generator.py`) | PLANNED |
| 4 | M4: Section Reordering & Final Verification | `frontend/index.html`, `frontend/src/main.js`, `dist/`, `public/data.enc` | M1, M2, M3 | PLANNED |

## Optimization Wave Milestones (M1–M6)
| # | Name | Scope | Status |
|---|------|-------|--------|
| 1 | M1: Storage Vault & Packed Shards | Year-packed stream shards (`streams_YYYY.pack`), `pack_keys.enc`, deterministic archival layout | COMPLETED |
| 2 | M2: Sync & Analytics Optimization | Incremental delta sync, wellness/activity rollup optimization | COMPLETED |
| 3 | M3: Envelope Crypto & Pack Format | Envelope-encrypted packed stream format & fast range decryption | COMPLETED |
| 4 | M4: Frontend Perf & Lazy Rendering | Deferred rendering, lazy Leaflet loading, pagination & DOM optimizations | COMPLETED |
| 5 | M5: Web Worker Crypto & Shard Cache | `crypto_worker.js` off-thread decryption & `shard_cache.js` IndexedDB/memory caching | COMPLETED |
| 6 | M6: Compiled Tailwind, Minified Build & CI Tuning | Compiled Tailwind CSS, esbuild ESM minification, CDN removal, CI cache/pip tuning | COMPLETED |

## Code Layout
- `frontend/index.html` — Main HTML layout & `#customize-modal`
- `frontend/src/main.js` — Dashboard initialization, `renderDashboard()`, customization modal
- `frontend/src/charts/calendar.js` — Calendar rendering, activity/wellness extractors, collapse state
- `frontend/src/charts/achievements.js` — 365-Day Consistency Heatmap & PR Trophy Case
- `frontend/src/charts/activities.js` — Activity Drill-Down & `#activity-drawer` HR profile chart
- `frontend/src/charts/trends_modal.js` — Trends modal, KPI strip, VO2 max chart & breakdown table
- `src/ingestion/sync.py` — Garmin activity normalization (`normalize_garmin_activity`)
- `src/ingestion/mock_generator.py` — Mock data generator
- `tests/` — Python (`unittest`/`pytest`) and Node (`test_*.js`) test suites
