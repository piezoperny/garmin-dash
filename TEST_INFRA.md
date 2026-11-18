# Test Infrastructure (`TEST_INFRA.md`)

## 1. Overview & Runtime Environments

`garmin-dash` is verified across two complementary, zero-external-dependency runtimes:

| Layer | Runtime | Runner Command | Scope |
|---|---|---|---|
| **Backend, Crypto & Ingestion** | Python 3.12 (`unittest`) | `python3 -m unittest discover -s tests -p "test_*.py" -v` | AES-256-GCM + PBKDF2-HMAC-SHA256 (`src/encryption/`), synthetic generator, sharded archive, `import_garmindb.py`, `LiveGarminClient`, `cleanup.py`, secret hygiene, CI/docs contracts |
| **Frontend Crypto & UI E2E** | Node.js v24+ (native `crypto.subtle` + ESM) | `node tests/e2e/test_dashboard_runner.js` & `node tests/e2e/test_enhancements_e2e.js` | Browser Web Crypto parity, `frontend/src/*` ESM modules, headless DOM/Canvas2D rendering, Today's Activity Banner (M2), Body Battery Range Bars (M3), Stress In-Focus & Modal (M4), Branding & Build (M5) |

No Playwright/Puppeteer or browser binary download is required. All frontend E2E tests execute directly against the real ES modules under `frontend/src/` using a Node.js v24+ headless DOM, Canvas 2D, Storage, and `fetch` harness.

---

## 2. Shared Headless DOM, Canvas 2D & Web Crypto Harness

Defined in [`tests/e2e/test_dashboard_runner.js`](file:///home/antigravity/piezoperny/garmin-dash/tests/e2e/test_dashboard_runner.js) (`createHeadlessEnv`) and shared by [`tests/e2e/test_enhancements_e2e.js`](file:///home/antigravity/piezoperny/garmin-dash/tests/e2e/test_enhancements_e2e.js):

1. **DOM Tree & Event Bubbling (`MockDocument`, `MockElement`, `MockClassList`)**:
   - Registers all mandatory root IDs (`passphrase-modal`, `dashboard-content`, `dashboard-main`, `today-activity-section`, `wellness-dashboard`, `wellness-in-focus`, `wellness-at-a-glance`, `activity-table`, `activities-table-body`, `activity-drawer`, `metric-trend-modal`, `customize-modal`, etc.).
   - Implements a stack-based recursive HTML parser inside `innerHTML` setters and dynamic `childNodes` serialization inside `innerHTML` getters (so nested child mutations such as async shard SVG slot injection propagate to parent `innerHTML` and `querySelector('svg polyline')`), plus `setAttribute('id', ...)` `elementsById` synchronization, `textContent`, inline `style` attributes, and compound `querySelector`/`querySelectorAll`/`closest` matching.
   - Sets `document.readyState = 'loading'` before importing `frontend/src/main.js` so `initApp()` is invoked deterministically per test environment rather than auto-firing on import.
   - Provides `waitForCondition(fn, timeoutMs, intervalMs)` polling for async PBKDF2 / AES-GCM / stream shard operations instead of brittle fixed sleeps, plus a dedicated `PendingImplError` (`assert.AssertionError` subclass) and `console.error` + `console.warn` spy so swallowed runtime exceptions (`Decryption failed:`, `Failed to render trend chart:`) fail immediately as `HARNESS_ERROR` / `ERROR` rather than masquerading as `PENDING_IMPL`.

2. **Canvas 2D Call Recorder (`MockCanvasContext2D`)**:
   - Captures every `fillRect`, `rect`, `roundRect`, `arc`, `moveTo`, `lineTo`, `bezierCurveTo`, `fill`, `stroke`, `fillText`, `setLineDash`, and `createLinearGradient` operation with active `fillStyle`, `strokeStyle`, `lineWidth`, and text strings.
   - Supports `options.minimalCtx = true` to omit `roundRect` and `createLinearGradient`, verifying fallback paths for restricted Canvas 2D contexts.
   - Supports custom `_rect` dimensions (e.g., `width: 0`) to test zero-dimension guard behavior in `Chart`.

3. **Dual-Bound Storage & Exact-Buffer Fetch**:
   - Binds `MockSessionStorage` instances simultaneously to `global.sessionStorage` / `global.window.sessionStorage` and `global.localStorage` / `global.window.localStorage` so both `session.js` and `wellness.js` / `main.js` share consistent per-test storage state.
   - `mockFetch` serves `./data.enc` and `./streams/<id>.enc` via exact `ArrayBuffer` byte slicing (`buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)`), preventing Node `Buffer` pool offset corruption in `crypto.subtle.decrypt`.
   - Helper `encryptShardWithRawKey` encrypts synthetic `.enc` stream shards using the session's raw AES-256-GCM key for opaque-box M1→M2→Drawer shard hydration testing.

---

## 3. E2E Suite Structure & Exit Code Policy

### 3.1 `tests/e2e/test_dashboard_runner.js`
- **Part A (Baseline Checks, `TC-01`–`TC-06`)**: Verifies the core auth state machine (initial lock, invalid passphrase rejection, valid unlock + 3 sections rendered, `sessionStorage` reload bypass, GCM tamper rejection, Lock Vault purge).
- **Part B (Real-Module M2–M5 E2E Checks)**: Imports real `frontend/src/*.js` modules, unlocks `dist/data.enc`, and verifies M2–M5 contracts (including Today card → `#activity-drawer` click-through and Stress 4-zone colors).
- **Exit Policy**:
  - Default mode (`node tests/e2e/test_dashboard_runner.js`): exits `0` when Baseline 6/6 passes and 0 harness errors occur; pending M2–M5 features (strict `PendingImplError` / `AssertionError` only) are reported as `[PENDING_IMPL]`.
  - Strict mode (`node tests/e2e/test_dashboard_runner.js --strict` or `E2E_STRICT=1`): exits `1` unless both Baseline 6/6 AND all M2–M5 enhancement checks pass 100%.

### 3.2 `tests/e2e/test_enhancements_e2e.js`
- **52 Opaque-Box Tests** across **Tiers 1–4**:
  - **Tier 1 (23 tests)**: Core feature coverage for M2 (6), M3 (6), M4 (6), M5 (5).
  - **Tier 2 (20 tests)**: Boundary & corner cases (5 per milestone M2–M5) including indoor/strength right-side HR badge, 404/truncated shards, Null Island polylines, 0/100 extremes, `width=0` canvas, minimal Canvas 2D context, zero stress (`0` vs `24`), scalar-only 4-zone fallback, legacy vs explicit `localStorage` layout migration, corrupted JSON recovery, and isolated temp-dir `frontend/build.js` verification.
  - **Tier 3 (5 tests)**: Cross-feature M1→M2, M1→M3/M4 intraday, M1→M4 stress breakdown, M5 `build.js` + `cleanup` + `ref_scan_directory`, and M1 shard→M2 mini-route→Drawer splits.
  - **Tier 4 (4 tests)**: Full unlock-to-drawer, Stress card action vs modal navigation, Body Battery rangeBar→1D intraday flow, and reload bypass + Lock Vault cleanup.
- **Exit Policy**: Exits `1` whenever any test is `[PENDING_IMPL]` or `ERROR`; exits `0` once all 52 tests pass.

### 3.3 `tests/test_e2e_m1_archive_contracts.py`
- **19 Opaque-Box Python Tests** across **Tiers 1–4** (Tier 1: 6, Tier 2: 7, Tier 3: 4, Tier 4: 2) covering `LiveGarminClient` (all 6 expanded activity endpoints + 16 daily wellness endpoint groups + fallbacks/fault resilience), pure `normalize_daily_wellness` (zero preservation, `-1`/`-2` sentinels, ~15m intraday downsampling), `SyntheticDatasetGenerator` / `compile_dashboard_rollup`, `run_sync_pipeline` (including `REMOTE_RAW_WELLNESS_DIR/raw_wellness_{YYYY}.json` persistence, 14-day intraday retention, and real offline `reprocess_archive=True` without Garmin credentials), `build_and_encrypt_rollup` (including stream shard encryption), `import_garmindb.py` (with real temporary SQLite databases), `cleanup.py --verify-only`, `SecretRedactionFilter`, and `.github/workflows/sync.yml` contracts.

---

## 4. Workspace Hygiene & Isolation Guarantees

- All file-generating Python tests run inside `tempfile.TemporaryDirectory()` and never write to `dist/`, `public/`, `.staging/`, `.raw_staging/`, or `README.md`.
- `frontend/build.js` verification copies `frontend/` and `public/` into an isolated `os.tmpdir()` directory, builds there, verifies `dist/icon.svg` and zero-plaintext `ref_scan_directory`, and deletes the temp directory in a `finally` block.
- All Garmin API and storage interactions in tests use `MockSFTPClient` or `unittest.mock.patch` on external network boundaries only—never patching out internal rollup, encryption, or normalization logic.
