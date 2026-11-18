# Test Readiness & Verification Inventory (`TEST_READY.md`)

## 1. Test Inventory

### Owned E2E & Test Infrastructure Deliverables
| File | Layer | Coverage | Tests |
|---|---|---|---|
| [`tests/test_e2e_m1_archive_contracts.py`](file:///home/antigravity/piezoperny/garmin-dash/tests/test_e2e_m1_archive_contracts.py) | Python (`unittest`) | M1 Backend, `LiveGarminClient` (6 activity + 16 wellness endpoints), `normalize_daily_wellness`, `MockGenerator` (`summary_polyline` & intraday), sharded sync + `raw_wellness` archival + 14d retention + offline `reprocess_archive=True`, `import_garmindb.py`, `cleanup.py`, `SecretRedactionFilter`, `.github/workflows/sync.yml` | 19 (Tiers 1–4) |
| [`tests/e2e/test_dashboard_runner.js`](file:///home/antigravity/piezoperny/garmin-dash/tests/e2e/test_dashboard_runner.js) | Node.js ESM + Web Crypto | Part A: 6 baseline auth state-machine checks (`TC-01`..`TC-06`); Part B: 4 real-module M2–M5 enhancement E2E checks + shared headless DOM/Canvas2D harness (`--strict` / `E2E_STRICT=1` gate) | 6 Baseline + 4 Enhancement |
| [`tests/e2e/test_enhancements_e2e.js`](file:///home/antigravity/piezoperny/garmin-dash/tests/e2e/test_enhancements_e2e.js) | Node.js ESM + Web Crypto | Opaque-box 4-tier E2E suite for M2 (12 tests), M3 (12 tests), M4 (12 tests), M5 (10 tests), Cross-Feature (6 tests) | 52 (Tiers 1–4) |
| [`TEST_INFRA.md`](file:///home/antigravity/piezoperny/garmin-dash/TEST_INFRA.md) | Documentation | Headless DOM/Canvas2D/WebCrypto harness design, suite exit policies, workspace hygiene & isolation rules | — |
| [`TEST_READY.md`](file:///home/antigravity/piezoperny/garmin-dash/TEST_READY.md) | Documentation | Complete test inventory, exact runnable commands, and verbatim verified baseline counts | — |

### Full Repository Test Suites
- **Python Suite (`tests/test_*.py`)**: `test_acceptance_criteria.py`, `test_ci_and_docs.py`, `test_crypto.py`, `test_daily_wellness_full_bundle.py`, `test_e2e_m1_archive_contracts.py`, `test_ingestion_pipeline.py`, `test_offline_reprocess_archive.py`, `test_secret_hygiene.py`, `test_visualizations.py`
- **Node.js Suites (`tests/*.js`, `tests/e2e/*.js`)**: `test_crypto_web.js`, `test_frontend_modules.js`, `test_m2_today_activity.js`, `test_m3_body_battery_rangebar.js`, `test_m4_trend_modal.js`, `test_chart_layout_integrity.js`, `e2e/test_dashboard_runner.js`, `e2e/test_enhancements_e2e.js`

---

## 2. Exact Runnable Commands

```bash
# 1. Full Python Unit, Integration, Hygiene & M1 E2E Suite
python3 -m unittest discover -s tests -p "test_*.py" -v

# 2. M1 E2E Contracts Standalone
python3 -m unittest tests/test_e2e_m1_archive_contracts.py -v

# 3. Frontend Web Crypto & DOM Contracts
node tests/test_crypto_web.js
node tests/test_frontend_modules.js
node tests/test_m2_today_activity.js
node tests/test_m3_body_battery_rangebar.js
node tests/test_m4_trend_modal.js
node tests/test_chart_layout_integrity.js

# 4. E2E Runner (Default: Baseline 6/6 gate; --strict: requires 100% M2-M5 pass)
node tests/e2e/test_dashboard_runner.js
node tests/e2e/test_dashboard_runner.js --strict

# 5. M2-M5 Opaque-Box 4-Tier Enhancements E2E Suite (TDD Red-to-Green Gate)
node tests/e2e/test_enhancements_e2e.js

# 6. Zero-Plaintext Workspace Forensic Hygiene Audit
python3 -m src.ingestion.cleanup --verify-only
```

---

## 3. Verbatim Verified Results (Iteration 3 Polish Snapshot)

| Command | Result | Verbatim Summary |
|---|---|---|
| `python3 -m unittest discover -s tests -p "test_*.py" -v` | Exit `0` | `Ran 188 tests in 32.568s` — `OK` (includes `19` M1 E2E archive contract tests) |
| `python3 -m unittest tests/test_e2e_m1_archive_contracts.py -v` | Exit `0` | `Ran 19 tests in 14.368s` — `OK` |
| `node tests/test_crypto_web.js` | Exit `0` | `=== Web Crypto Results: 11 passed, 0 failed (Total: 11) ===` |
| `node tests/test_frontend_modules.js` | Exit `0` | `=== Frontend Modules Results: 6 passed, 0 failed (Total: 6) ===` |
| `node tests/test_m2_today_activity.js` | Exit `0` | `=== M2 Test Results: 15 passed, 0 failed (Total: 15) ===` |
| `node tests/test_m3_body_battery_rangebar.js` | Exit `0` | `ALL 21 M3 BODY BATTERY RANGEBAR TESTS PASSED.` |
| `node tests/test_m4_trend_modal.js` | Exit `0` | `Milestone 4 Test Suite Results: 24 passed, 0 failed (Total: 24)` |
| `node tests/test_chart_layout_integrity.js` | Exit `0` | `[PASS] All chart layouts verified: zero legend clipping, zero X-axis collisions across all viewports.` |
| `node tests/e2e/test_dashboard_runner.js` | Exit `0` | `Baseline Checks: 6 passed, 0 failed (Total: 6)` / `M2-M5 Enhancement E2E Checks: 2 passed, 2 pending-impl, 0 errors (Total: 4)` |
| `node tests/e2e/test_dashboard_runner.js --strict` | Exit `1` | `STRICT MODE: Exiting 1 because M2-M5 enhancement checks are still pending implementation.` |
| `node tests/e2e/test_enhancements_e2e.js` | Exit `1` | `=== Enhancements E2E Total: 27 passed, 25 pending_impl, 0 errors (Total: 52) ===` (`M2: 12/12`, `M3: 12/12`, `M4: 1/12`, `M5: 0/10`, `CROSS: 2/6`; `Tier 1: 12/23`, `Tier 2: 11/20`, `Tier 3: 2/5`, `Tier 4: 2/4`) |
| `python3 -m src.ingestion.cleanup --verify-only` | Exit `0` | `PASS: Workspace is clean. Zero raw .fit or unencrypted activity summaries detected.` |
