# Project: Garmin Vault Enhancements & Full-Fidelity Ingestion

## Architecture
Garmin Vault is a zero-knowledge, client-side encrypted fitness & wellness dashboard:
1. **Backend / Ingestion (`src/ingestion/`, `src/encryption/`)**:
   - `garmin_client.py`: Queries Garmin Connect APIs (`LiveGarminClient` / `MockGarminClient`), collects full raw activity details and full daily wellness JSON bundles (`get_raw_daily_wellness_bundle`), and normalizes them via pure `normalize_daily_wellness`.
   - `sync.py`: Orchestrates incremental sync, archives unstripped raw activity summaries (`garmin_archive/activities/{YYYY}/{MM}/{id}_summary.json`) and per-year raw daily wellness bundles (`garmin_archive/raw_wellness/raw_wellness_{YYYY}.json`) to Google Drive / Hetzner SFTP, supports offline `--reprocess-archive`, shards heavy activity streams (`streams/<id>.enc`), and preserves `summary_polyline` on index items.
   - `import_garmindb.py`: Imports historical GarminDB SQLite exports while preserving `summary_polyline` and accurate `has_streams` / manifest year.
   - `mock_generator.py`: Deterministic 49-activity / 365-day wellness generator (`seed=42`) producing enriched stress zones, body battery wake/high/low, 14-day intraday samples, and `summary_polyline`.
   - `encrypt.py` & `cleanup.py`: Encrypts rollup (`data.enc`) and stream shards (`streams/*.enc`) with AES-256-GCM (PBKDF2 600k iters) and purges/verifies zero plaintext leaks.
2. **Frontend (`frontend/src/`, `frontend/index.html`, `frontend/build.js`, `public/`, `dist/`)**:
   - `main.js`: Auth gate, Web Crypto unlocking, customization persistence, and dashboard rendering coordinator (`renderTodayActivityBanner` -> `renderWellnessDashboard` -> charts).
   - `activities.js`: Today's Activity hero banner (`#today-activity-section`), async stream shard loader (`loadActivityStreamShard`), mini route SVG (`renderMiniRouteSvg`), activity table, and detail drawer (`openActivityDrawer`).
   - `chart_engine.js`: Custom zero-dependency Canvas 2D chart engine supporting `line`, `bar`, `doughnut`, `pie`, and `rangeBar` (vertical High/Low pillars + caps, multi-line tooltips, per-bar color arrays, custom 2-item legends).
   - `wellness.js`: "In Focus" (`['sleep', 'body_battery', 'stress', 'steps']`) and "At a Glance" (`['resting_hr', 'hrv', 'intensity_minutes', 'calories']`) cards, including proportional 4-zone Stress card.
   - `trends_modal.js`: Interactive trend modal (`1D`/`7D`/`1M`/`1Y`/`Custom`), Body Battery `rangeBar` + `1D` intraday curve, and Stress 4-zone color-coded visualization + breakdown table.
   - `public/icon.svg` & `frontend/build.js`: Purple obsidian vault SVG icon copied into `dist/icon.svg` alongside compiled assets.

---

## Feature Inventory

Every Survey feature from `ORIGINAL_REQUEST.md` and Step 0 Survey is assigned a milestone:

| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| 1 | Expanded Activity Raw Capture | Query & attach `typed_splits`, `split_summaries`, `power_zones`, `weather`, `exercise_sets`, `gear` in `LiveGarminClient.get_activity_details` without aborting on missing endpoints | M1 | ORIGINAL_REQUEST §1.1, Survey 1 |
| 2 | Full Raw Daily Wellness Collector | Add `LiveGarminClient.get_raw_daily_wellness_bundle(cdate)` querying all 16 daily wellness endpoint groups safely | M1 | ORIGINAL_REQUEST §1.2, Survey 1 |
| 3 | Pure `normalize_daily_wellness` & Enriched Vitals | Extract pure `normalize_daily_wellness(cdate, raw_bundle)` populating stress 4-zone durations (`stress_*_seconds`, `stress_max`), BB wake/high/low, vitals (`spo2_*`, `respiration_*`, `floors_*`, `min/max_hr`, `weight_kg`, `bmi`, `body_fat_pct`, `muscle_mass_kg`, `hydration_ml`, `training_readiness_score`, `vo2max_*`), and 15-min intraday timelines | M1 | ORIGINAL_REQUEST §1.2, Survey 1 |
| 4 | Raw Wellness Archive Persistence | Define `REMOTE_RAW_WELLNESS_DIR = "garmin_archive/raw_wellness"` and archive per-year `raw_wellness_{YYYY}.json` keyed by `YYYY-MM-DD`; keep 14-day intraday window in compiled `data.enc` | M1 | ORIGINAL_REQUEST §1.3, Survey 1 |
| 5 | Offline `--reprocess-archive` | Support `reprocess_archive=True` in live storage mode (even without Garmin creds) by re-reading archived activity summaries and raw wellness JSONs from storage without Garmin API calls | M1 | ORIGINAL_REQUEST §1.3, Survey 1 |
| 6 | Preserve `summary_polyline` & Accurate `has_streams` | Preserve `summary_polyline` on rollup/index activity items when `gps_track` is sharded/stripped in `sync.py`, `mock_generator.py`, and `import_garmindb.py`; fix `has_streams` and `manifest.record_activity` year | M1 | ORIGINAL_REQUEST §1.3 & §2.1, Survey 1 & 3 |
| 7 | Mock Wellness Enrichment | Update `mock_generator.py` (`generate_wellness_dataset`) to emit stress 4-zone durations, `stress_max`, `body_battery_at_wake`, and 14-day `intraday_body_battery` / `intraday_stress` without altering activity `seed=42` RNG | M1 | Survey 1 & 3 |
| 8 | M1 Unit Tests | Author `tests/test_daily_wellness_full_bundle.py` and `tests/test_offline_reprocess_archive.py` | M1 | ORIGINAL_REQUEST Gates, Survey 1 |
| 9 | Wire `renderTodayActivityBanner` | Call `renderTodayActivityBanner(rollup.activities || [], activeUnit)` in `frontend/src/main.js:renderDashboard` right before `renderWellnessDashboard(rollup)` | M2 | ORIGINAL_REQUEST §2.1, Survey 2 |
| 10 | Async Stream Shard Mini-Route Loader | Extract `loadActivityStreamShard(act.id)` in `activities.js`; when `act.has_streams && !act.summary_polyline && !act.gps_track`, asynchronously decrypt shard and inject mini route SVG | M2 | ORIGINAL_REQUEST §2.1, Survey 2 |
| 11 | Polish Today's Activity Hero Card | Upgrade `renderTodayActivityBanner` with emerald `TODAY` / purple `LATEST ACTIVITY • <Date>` badge, sport icon badge, TSS pill, indoor/HR fallback badge on right, and click-to-open `#activity-drawer` | M2 | ORIGINAL_REQUEST §2.1, Survey 2 |
| 12 | `rangeBar` Chart Engine Support | Add `type: 'rangeBar'` to `chart_engine.js` (`highData`, `lowData`, `chargedData`, `drainedData`, 10–14px gradient pillar scaled cleanly for 1M/1Y, `#38bdf8` High dot, `#0b0714`/`#c4b5fd` Low ring, pillar vertical hitbox, multi-line tooltip, 2-item High/Low legend, guarded `roundRect`/`createLinearGradient`) | M3 | ORIGINAL_REQUEST §3.1, Survey 2 |
| 13 | Body Battery Range Modal & 1D Intraday | Update `trends_modal.js` `body_battery` view to render `type: 'rangeBar'` with 2-item legend (`● Daily High`, `◉ Daily Low`) and `1D` intraday `00:00`–`23:59` curve when `intraday_body_battery` is present (with `rangeBar` + value labels fallback) | M3 | ORIGINAL_REQUEST §3.1, Survey 2 |
| 14 | Promote Stress to "In Focus" | Set `DEFAULT_WELLNESS_LAYOUT.in_focus = ['sleep', 'body_battery', 'stress', 'steps']` and `at_a_glance = ['resting_hr', 'hrv', 'intensity_minutes', 'calories']`; update `#wellness-in-focus` grid to `grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4`; handle legacy uncustomized localStorage & Reset Defaults cleanly | M4 | ORIGINAL_REQUEST §4.1, Survey 2 |
| 15 | 4-Zone Stress In-Focus Card | Revamp `buildStressCard` in `wellness.js` with score + Garmin qualifier badge, proportional 4-zone bar (`#38bdf8` Rest, `#fbbf24` Low, `#f97316` Med, `#f43f5e` High) from `stress_*_seconds` (with scalar fallback & `0` value preservation), and duration legend | M4 | ORIGINAL_REQUEST §4.2, Survey 2 |
| 16 | Stress Trend Modal Upgrade | Upgrade `trends_modal.js` `stress` KPIs (`Overall Avg Stress`, `Rest / Low Share`, `High Stress Peak`, `Autonomic Status`), per-bar color-coded Garmin zone bars/points over 4 zone bands (`chart_engine.js` per-bar color support if needed or M4 coordination), `1D` intraday stress support, and 5-column breakdown table | M4 | ORIGINAL_REQUEST §4.3, Survey 2 |
| 17 | Purple Obsidian Vault SVG Icon & Build Copy | Create 64×64 `public/icon.svg`, update `frontend/build.js` to copy `public/icon.svg` -> `dist/icon.svg`, update `frontend/index.html` favicon + header logo + passphrase lock badge to purple accents | M5 | ORIGINAL_REQUEST §5.1, Survey 2 |
| 18 | Comprehensive README Update & Dist Rebuild | Update `README.md` with centered `public/icon.svg` header, replace `<username>` -> `piezoperny`, document M1–M5 capabilities, GDrive bridge, `bootstrap_garmin.py`, `import_garmindb.py`, `--reprocess-archive`, GitHub About instructions, preserving all `test_ci_and_docs.py` invariants; rebuild `data.enc` (`--mock --verify`) and `dist/` | M5 | ORIGINAL_REQUEST §5.2, Survey 2 & 3 |
| 19 | E2E Testing Track (Opaque-Box Tiers 1–4) | Independently build/update opaque-box E2E tests (`tests/e2e/test_dashboard_runner.js`, `tests/e2e/test_enhancements_e2e.js`, `tests/test_e2e_m1_archive_contracts.py`) and publish `TEST_INFRA.md` & `TEST_READY.md` | E2E Track | Project Pattern Dual Track |
| 20 | Final Milestone: E2E Pass & Tier 5 Hardening | Pass 100% of E2E tests (Tiers 1–4), run Tier 5 adversarial coverage hardening (Challenger-initiated loop), run `cleanup --verify-only`, and pass Whole-Project Forensic Audit | Final | Project Pattern Final Milestone |

---

## Milestones

| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| M1 | Full-Fidelity Garmin Connect Raw Archival & Offline Reprocessing | `garmin_client.py`, `sync.py`, `import_garmindb.py`, `mock_generator.py`, `tests/test_daily_wellness_full_bundle.py`, `tests/test_offline_reprocess_archive.py` | none | DONE |
| M2 | Today's Activity Hero Card at Top of Homepage | `frontend/src/main.js`, `frontend/src/charts/activities.js`, `tests/test_m2_today_activity.js` | M1 | DONE |
| M3 | Garmin-Style Body Battery Range Chart (High/Low Pillars + Caps) | `frontend/src/charts/chart_engine.js`, `frontend/src/charts/trends_modal.js`, `tests/test_m3_body_battery_rangebar.js` | none | DONE |
| M4 | Stress In-Focus Hero Card & 4-Zone Breakdown Tab/Modal | `frontend/src/charts/wellness.js`, `frontend/src/charts/trends_modal.js`, `frontend/index.html`, `tests/test_m4_trend_modal.js` | M1, M3 | DONE |
| M5 | Purple Theme SVG Icon Revamp & Comprehensive README Update | `public/icon.svg`, `frontend/index.html`, `frontend/build.js`, `README.md`, `public/data.enc`, `dist/` | M1, M2, M3, M4 | DONE |
| E2E | E2E Testing Track (Requirements-Driven Opaque-Box Suite) | `TEST_INFRA.md`, `TEST_READY.md`, `tests/e2e/test_dashboard_runner.js`, `tests/e2e/test_enhancements_e2e.js`, `tests/test_e2e_m1_archive_contracts.py` | none | DONE |
| Final | Final Milestone: E2E Tiers 1–4 Pass + Tier 5 Adversarial Hardening | Pass all unit/integration/E2E suites + Tier 5 adversarial challenger loop + whole-project forensic audit + `cleanup --verify-only` | M1, M2, M3, M4, M5, E2E | DONE |

---

## Interface Contracts

### M1: Ingestion (`garmin_client.py` / `sync.py` / `mock_generator.py`) ↔ Frontend (`activities.js`, `wellness.js`, `trends_modal.js`)
- `LiveGarminClient.get_activity_details(activity_id)`: Safely attaches `typed_splits`, `split_summaries`, `power_zones`, `weather`, `exercise_sets`, `gear` without aborting if any sub-call raises.
- `LiveGarminClient.get_raw_daily_wellness_bundle(cdate: str) -> Optional[Dict[str, Any]]`: Safely queries all 16 daily wellness endpoint groups and returns raw bundle dict.
- `normalize_daily_wellness(cdate: str, raw_bundle: Dict[str, Any]) -> Dict[str, Any]`: Pure function emitting all existing keys plus `stress_max`, `stress_rest_seconds`, `stress_low_seconds`, `stress_medium_seconds`, `stress_high_seconds`, `stress_total_seconds`, `body_battery_at_wake`, `spo2_avg`, `spo2_low`, `respiration_waking`, `respiration_sleep`, `floors_ascended`, `floors_descended`, `min_hr`, `max_hr`, `weight_kg`, `bmi`, `body_fat_pct`, `muscle_mass_kg`, `hydration_ml`, `training_readiness_score`, `vo2max_running`, `vo2max_cycling`, and ~15-min downsampled `intraday_body_battery` / `intraday_stress` (retained for recent 14 days in `data.enc`).
- `REMOTE_RAW_WELLNESS_DIR = "garmin_archive/raw_wellness"`: Stores per-year `raw_wellness_{YYYY}.json` mapped by `YYYY-MM-DD`.
- `run_sync_pipeline(..., reprocess_archive=False)`: When `reprocess_archive=True` and storage is configured (even without Garmin credentials), skips Garmin API calls and re-normalizes activities & wellness from archived JSONs.
- **Activity Index / Rollup Entry**: Every activity in `rollup_dict["activities"]` preserves `"summary_polyline": str | None` (null for `strength`/`weights`) even when `gps_track` and `telemetry_stream` are sharded (`None`), and sets `"has_streams": bool` accurately. Top-level `strength` activity objects MUST NOT contain forbidden keys (`weight`, `kg`, `load_kg`, `tonnage`, `weight_kg`).

### M2: `main.js` ↔ `activities.js`
- `renderDashboard(rollup)` invokes `renderTodayActivityBanner(rollup.activities || [], activeUnit)` immediately before `renderWellnessDashboard(rollup)`.
- `loadActivityStreamShard(actId)`: Exported async helper fetching `./streams/${encodeURIComponent(String(actId))}.enc`, decrypting via `decryptWithRawKey(getStoredKey(), ...)`, caching/merging streams onto activity. Used by both `openActivityDrawer` and `renderTodayActivityBanner` (when `act.has_streams && !act.summary_polyline && !act.gps_track`).

### M3: `chart_engine.js` ↔ `trends_modal.js`
- `Chart` supports `type: 'rangeBar'` with dataset `{ highData, lowData, chargedData, drainedData }` (or compatible range bar config), vertical pillar (`#2d2147` / purple-slate gradient), `#38bdf8` High cap, `#0b0714` + `#c4b5fd` Low ring cap, vertical pillar hitbox, multi-line tooltip (`pt.tooltipLines`), and 2-item legend (`● Daily High`, `◉ Daily Low`). Also supports per-bar color arrays (`ds.barColors` / `Array.isArray(ds.backgroundColor)`) for M4 Stress bars.
- `chart_engine.js` MUST guard `ctx.roundRect` and `ctx.createLinearGradient` (`typeof ... === 'function'`) for Node mock-context compatibility.
- `trends_modal.js` Body Battery view: In `1d` mode with `intraday_body_battery?.length > 1`, renders smooth 0–100 intraday curve (`00:00`–`23:59`); otherwise renders `type: 'rangeBar'`.

### M4: `wellness.js` ↔ `index.html` ↔ `trends_modal.js`
- `DEFAULT_WELLNESS_LAYOUT = { in_focus: ['sleep', 'body_battery', 'stress', 'steps'], at_a_glance: ['resting_hr', 'hrv', 'intensity_minutes', 'calories'], hidden: [] }`.
- `#wellness-in-focus` uses `grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4`.
- `buildStressCard`: Proportional 4-zone bar (`#38bdf8` Rest `0–25`, `#fbbf24` Low `26–50`, `#f97316` Medium `51–75`, `#f43f5e` High `76–100`) from `stress_*_seconds` with scalar fallback and zero-value (`0`) preservation.
- `trends_modal.js` Stress view: 4 KPIs (`Overall Avg Stress`, `Rest / Low Share`, `High Stress Peak`, `Autonomic Status`), Garmin 4-zone color-coded bars/points over zone bands + `1D` intraday support, and 5-column breakdown table (`Date`, `Avg Stress`, `Rest Time`, `Low / Med / High`, `Status Badge`). Preserve `'0 pts'` for zero values and `'1 records'` in 1d mode.

### M5: `public/icon.svg` ↔ `frontend/build.js` ↔ `frontend/index.html` ↔ `README.md`
- `public/icon.svg` (64×64 purple obsidian squircle `#0b0714`->`#1b132e`, `#a855f7` border, `#c084fc`/`#a855f7` biometric pulse emblem) copied to `dist/icon.svg` by `frontend/build.js`.
- `frontend/index.html` links purple vault icon and updates header/lock badges to `text-purple-400`, `border-purple-500/30`, preserving all 12 mandatory root IDs and `#metric-trend-modal` structure.
- `README.md` preserves all `test_ci_and_docs.py` & `test_acceptance_criteria.py` required tokens, secret names, byte offsets, and CLI commands.

---

## Code Layout
- `src/ingestion/garmin_client.py`: Garmin Connect client, activity detail & wellness bundle collectors, pure `normalize_daily_wellness`.
- `src/ingestion/sync.py`: Sync orchestrator, raw wellness archival, offline `--reprocess-archive`, stream sharding, `summary_polyline` preservation.
- `src/ingestion/import_garmindb.py`: GarminDB historical importer.
- `src/ingestion/mock_generator.py`: Deterministic mock dataset & rollup compiler.
- `src/ingestion/cleanup.py`: Plaintext cleanup & `--verify-only` gate.
- `src/encryption/encrypt.py`: AES-256-GCM encryption CLI (`--mock --verify`).
- `frontend/index.html`: Dashboard HTML shell, modals, layout grids, favicon/badges.
- `frontend/build.js`: Static distribution builder (`dist/`).
- `frontend/src/main.js`: Dashboard controller & `renderDashboard`.
- `frontend/src/charts/activities.js`: Today's Activity hero banner, shard loader, activity table & drawer.
- `frontend/src/charts/chart_engine.js`: Canvas 2D charting engine (`line`, `bar`, `doughnut`, `pie`, `rangeBar`).
- `frontend/src/charts/wellness.js`: Wellness In-Focus & At-a-Glance cards + Stress 4-zone bar.
- `frontend/src/charts/trends_modal.js`: Metric trend modal (1D/7D/1M/1Y/Custom), Body Battery range bar, Stress 4-zone view.
- `public/icon.svg`: Purple vault SVG icon.
- `README.md`: Project documentation.
- `tests/`: Python unit/integration tests and Node.js / E2E test suites.
- `dist/`: Built static distribution (no plaintext secrets/raw data).
