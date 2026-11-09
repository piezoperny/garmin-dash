# Project: garmin-dash Fixes & Enhancements

## Architecture
Garmin Vault is a client-side encrypted dashboard architecture.
1. **Backend / Ingestion (`src/ingestion/`, `src/analytics/`)**:
   - `sync.py`: Garmin API client and sync orchestration. Fetches activities and wellness metrics, normalizes taxonomies, computes cryptographic payloads, and archives to SFTP.
   - `training_load.py`: Banister impulse-response model (ATL $\tau=7$, CTL $\tau=42$, TSB = CTL - ATL).
   - `mock_generator.py`: Deterministic multi-sport generator creating `rollup` JSON serialized and encrypted to `data.enc`.
2. **Frontend (`frontend/src/`, `frontend/index.html`, `dist/`)**:
   - `main.js`: Dashboard controller, auth state machine, crypto unlocking (`crypto.subtle`), and chart coordinator.
   - `chart_engine.js`: Custom lightweight Canvas 2D charting engine supporting DPI scaling, tooltips, responsive rendering.
   - `wellness.js`: Wellness metric cards, gauges, sparklines, and metric interactions.
   - `physiological.js`: HR zones donut, Coggan power zones, grade pace zones, and threshold progression.
   - `endurance.js`: Weekly volume stacked bars, training load continuous curves, KPI cards.
   - `activities.js`: Activity list table, activity detail drawer, route map (Leaflet), telemetry profile charts (elevation, HR, pace, cadence).
   - `trend_modal.js`: Modular modal for detailed historical time series trends across customizable periods (1D, 7D, 1M, 1Y, Custom).

---

## Feature Inventory

| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| 1 | Aspect Ratio Fix in Card 2 | Place `emptyEl` notice inside `canvas.parentElement` or hide `canvas.parentElement` to prevent 560px height explosion | M1 | Survey (Explorer 2) |
| 2 | Canvas Bitmap Aspect Ratio Sync | Synchronize `canvas.style.width` and `height` with DPR-scaled raster buffer in `chart_engine.js` | M1 | Survey (Explorer 2) |
| 3 | Chart Container ResizeObserver | Add ResizeObserver in `chart_engine.js` to trigger clean redraw on CSS grid or flex reflows | M1 | Survey (Explorer 2) |
| 4 | Donut Chart Circular Geometry | Constrain donut chart container aspect ratio and styling so HR zone distribution remains perfectly circular | M1 | Survey (Explorer 2) |
| 5 | Ingestion Taxonomy Default | Change fallback in `sync.py:103` from `default="hiking"` to `default="other"` | M2 | Survey (Explorer 2) |
| 6 | Frontend Activity Sport Default | Default missing/null activity sports to `'OTHER'` and `'badge-other'` in `activities.js:236` | M2 | Survey (Explorer 2) |
| 7 | Sport-Filtered Weekly Load KPI | Compute `#kpi-weekly-load` based on current/recent week's sport load instead of all-time historical average | M2 | Survey (Explorer 2) |
| 8 | Walking vs Hiking Color Separation | Differentiate Walking (`#10b981`) and Hiking (`#06b6d4` / Cyan) in volume stacked bar charts | M2 | Survey (Explorer 2) |
| 9 | Synthetic Periodization Tuning | Adjust mock generator so no hiking occurs in the recent 6 weeks, matching user training phase | M2 | Survey (Explorer 2) |
| 10 | Activity Drawer Canvas Layout Race | Ensure `#activity-drawer` is unhidden before calculating canvas bounds or use responsive resize | M3 | Survey (Explorer 1) |
| 11 | Zero-Elevation Profile Handling | Suppress elevation Y-axis, ticks, and polygons for indoor/zero-elevation activities (stair stepper, cardio) | M3 | Survey (Explorer 1) |
| 12 | True Route Stream Detection | Fix `hasStream` logic so flat synthesized HR on cardio does not trigger fake route rendering | M3 | Survey (Explorer 1) |
| 13 | Single-Split Fallback Profile | Ensure `renderFallbackProfile` with $n=1$ split draws a full-width flat line instead of a 0px polygon | M3 | Survey (Explorer 1) |
| 14 | Dynamic Y-Axes for Pace & Cadence | Render dedicated Y-axis ticks and inverted pace scaling (min/km) when Elevation and HR are toggled off | M3 | Survey (Explorer 1) |
| 15 | Telemetry Array Length Normalization | Ensure coordinate, elevation, HR, speed, and cadence arrays have aligned lengths for scrubber and rendering | M3 | Survey (Explorer 1) |
| 16 | Real Garmin Telemetry Stream Extraction | Parse Garmin `metricDescriptors` and `activityDetailMetrics` in `sync.py` rather than flattening to 0 | M3 | Survey (Explorer 1) |
| 17 | Clickable Singular Metric Cards | Add click listeners and visual affordance (`cursor-pointer`, hover border) to all wellness cards | M4 | Survey (Spec Miner 3) |
| 18 | Trend Modal UI Component | Add `#metric-trend-modal` with obsidian dark styling (`#09090b` backdrop, `#111114` surface, `#1f1f24` border) | M4 | Survey (Spec Miner 3) |
| 19 | Standard Time Range Filters | Implement 1D, 7D, 1M, and 1Y timeframe buttons with dynamic active states | M4 | Survey (Spec Miner 3) |
| 20 | Customizable Date Range Selector | Support arbitrary start/end date inputs (`[YYYY-MM-DD]` to `[YYYY-MM-DD]`) with validation | M4 | Survey (Spec Miner 3) |
| 21 | Chronological Navigation & Rollup | Implement `<` and `>` period pagination, rolling averages, and metric summary KPI callouts | M4 | Survey (Spec Miner 3) |
| 22 | Metric-Specific Trend Charts | Implement high-DPI canvas charts for sleep stages, HRV baseline band, RHR, steps goal, body battery, etc. | M4 | Survey (Spec Miner 3) |
| 23 | Invariant & ID Preservation | Guarantee all 12 root IDs, dark theme, and crypto security constraints are strictly maintained | M5 | Dispatch Invariants |
| 24 | E2E & Forensic Verification | Pass all existing and new E2E tests and achieve CLEAN forensic audit verdict | M5 | Quality Gates |

---

## Milestones

| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| M1 | Physiological Distribution Aspect Ratio Fix | Fix `#card-power-zone` empty notice DOM stacking, `_setupCanvasDPI` style sync, and `ResizeObserver` in `chart_engine.js` | none | DONE |
| M2 | Endurance Load & Hiking Activity Taxonomy | Fix `sync.py` sport default, `activities.js` fallback, distinct walking/hiking chart colors, and recent weekly load KPI calculation | none | DONE |
| M3 | Activity Drawer Telemetry & Graph Overhaul | Fix drawer layout race, zero-elevation axis suppression, single-split fallback, pace/cadence axes, and telemetry array alignment | M1 | DONE |
| M4 | Singular Metric Trend Modals across Time Periods | Implement `#metric-trend-modal`, clickable wellness cards, 1D/7D/1M/1Y/Custom selectors, chronological pagination, and metric chart adapters | M1 | IN_PROGRESS |
| M5 | E2E Integration, Regression & Forensic Gate | Run full test suite, build `dist/`, verify Playwright/headless tests, and achieve clean Forensic Audit | M1, M2, M3, M4 | PLANNED |

---

## Interface Contracts

### M1: Chart Engine ↔ Containers
- `Chart.prototype._setupCanvasDPI()`: Sets `this.canvas.style.width` and `this.canvas.style.height` matching measured CSS pixels, preventing CSS stretch.
- `renderPowerZoneChart(rollup, thresholds)`: When `!hasRealPower`, sets `canvas.parentElement.style.display = 'none'` and appends `#power-zone-empty-notice` into `cardEl`, or inserts `emptyEl` inside `canvas.parentElement` with matching `min-h-[260px]`.

### M2: Activity Taxonomy & Endurance KPIs
- `resolve_sport_taxonomy(summary, default="other")`: Returns normalized sport string, defaulting to `"other"` instead of `"hiking"`.
- `renderKPICards(rollup, unit, sportFilter)`: For `#kpi-weekly-load`, computes sum of TSS for the selected sport in the most recent week (`latest.sport_loads[sportFilter] || 0`), or 0 if no activities of that sport occurred in that week.

### M3: Activity Detail Drawer ↔ Profile Chart
- `showActivityDrawer(act, unit)`: Calls `drawer.classList.remove('hidden')` before calling `renderActivityProfileChart(act, unit)` or invokes via `requestAnimationFrame`.
- `extractActivityStreams(act)`: Returns normalized arrays where `times`, `elevations`, `hrs`, `speeds`, and `cadences` share consistent array lengths or timestamps. Suppresses `elevation` when all values are 0 or NaN.

### M4: Wellness Cards ↔ Trend Modal
- Global / Module function `openMetricTrendModal(metricKey, initialRange = '7d')`.
- Event delegation on `#wellness-cards-container` for `[data-metric]`:
  - Ignores clicks on `.card-control-btn` or `button`.
  - Reads `card.dataset.metric` (e.g. `'sleep'`, `'hrv'`, `'resting_hr'`, `'steps'`, `'body_battery'`, `'stress'`, `'intensity_minutes'`, `'calories'`).
  - Fetches time series from `activeRollup.wellness.daily`.

---

## Code Layout
- `frontend/src/charts/chart_engine.js`: Base Canvas charting engine.
- `frontend/src/charts/physiological.js`: Physiological distribution & zone charts.
- `frontend/src/charts/endurance.js`: Volume and training load charts.
- `frontend/src/charts/activities.js`: Activity table, drawer, and profile chart.
- `frontend/src/charts/wellness.js`: Wellness metric cards.
- `frontend/src/charts/trend_modal.js`: Metric trend modal and time-series visualizers.
- `frontend/index.html`: Dashboard template and modal structures.
- `src/ingestion/sync.py`: Garmin sync and taxonomy resolver.
- `src/ingestion/mock_generator.py`: Synthetic generator and periodization.
- `dist/`: Compiled production output generated by `node frontend/build.js`.
