# TEST_READY: End-to-End & Integration Test Infrastructure

**Project**: Client-Side Encrypted Garmin Fitness Dashboard  
**Status**: Ready for Verification & Implementation Gate  
**Date**: 2026-10-24  
**Author**: Test Writer Agent (`test_writer_e2e`)  
**Target Coverage**: Acceptance Criteria 1, 2, 3, and 4 (`ORIGINAL_REQUEST.md`)

---

## 1. Test Suite Summary & Inventory

The test infrastructure is partitioned into opaque-box integration and E2E suites located under `tests/`. It covers all four acceptance criteria without requiring live Garmin API credentials or external network access.

| Test File | Target Subsystem | Acceptance Criteria | Framework | Test Count |
| :--- | :--- | :--- | :--- | :---: |
| `tests/test_crypto_interop.py` | PBKDF2 (600k iters), AES-256-GCM, wire format slicing, tamper rejection across all slices, truncation | AC 1, R2 | Python `unittest` / `pytest` | 16 |
| `tests/test_crypto_web.js` | Native Web Crypto (`crypto.subtle`) decryption, sessionStorage raw key caching, tamper & auth errors | AC 1, R3 | Node.js (Web Crypto native) | 11 |
| `tests/test_ingestion_sftp.py` | Mocked Garmin API incremental sync, OAuth 2.0 refresh, Hetzner SFTP archival, raw file purge | AC 2, R1, R5 | Python `unittest` / `pytest` | 12 |
| `tests/test_mock_generator.py` | Deterministic 8-week multi-sport dataset, 14-byte FIT protocol 2.0 header & CRC, metric boundaries | AC 2, R1 | Python `unittest` / `pytest` | 12 |
| `tests/test_secret_hygiene.py` | Forensic zero-plaintext static scanner, `.fit` & JSON leak detection, GPS & secret detection | AC 2, R5 | Python `unittest` / `pytest` | 12 |
| `tests/e2e/dashboard.spec.js` | Playwright browser E2E: password modal gate, invalid passphrase, decrypt/render, reload bypass | AC 3, R3 | Playwright (`@playwright/test`) | 7 |
| `tests/e2e/test_dashboard_runner.js` | In-process headless DOM and auth state machine simulation runner | AC 3, R3 | Node.js (Web Crypto native) | 6 |
| **TOTAL** | | | | **76** (70 distinct) |

---

## 2. Test Breakdown by Tier

Following the project test philosophy (`TEST_INFRA.md`):

| Tier | Focus Area | Test Count | Description |
| :--- | :--- | :---: | :--- |
| **Tier 1** | Core Feature Coverage | **25** | Verifies primary happy path for every feature (PBKDF2, AES-GCM, wire format packing, incremental API fetch, SFTP token persistence, FIT binary headers, clean dist directory, and dashboard unlocking). |
| **Tier 2** | Boundary & Corner Cases | **37** | Verifies bit-flipping across all 4 wire slices (Salt, IV, Ciphertext, Tag), truncation (<44 bytes), empty payloads, unicode/emoji passphrases, token expiry, upload size mismatches, metric bounds (HR 40-215 bpm, Power 0-1500W, Cadence), and leak injections. |
| **Tier 3** | Cross-Feature Combinations | **7** | Verifies end-to-end multi-module flows: Python encryption $\leftrightarrow$ Web Crypto JS decryption, full ingestion-to-SFTP archival with staging cleanup, and sessionStorage reload bypass. |
| **Tier 4** | Real-World & Stress Scenarios | **7** | Verifies large payload rollups (>50-250 KB), multi-week periodized training schedules, chronological ordering, idempotent empty batch handling, and lock vault state purges. |
| **Grand Total** | | **76** | **100% Passing** across all executable targets. |

---

## 3. Exact Test Execution Commands

### 3.1 Python Integration & Security Suites
To run all Python test suites (`test_crypto_interop.py`, `test_ingestion_sftp.py`, `test_mock_generator.py`, `test_secret_hygiene.py`):

```bash
# Standard Python unittest runner (zero external dependencies required)
python -m unittest discover -s tests -p "test_*.py" -v

# Or using pytest (in environments with pytest installed)
pytest tests/ -v
```

### 3.2 JavaScript Web Crypto Cross-Runtime Suite
To run the Web Crypto subtle decryption, sessionStorage caching, and tamper tests:

```bash
# Using Node.js (Node 18+ or Node 24)
node tests/test_crypto_web.js

# Or using Antigravity bundled Node runtime
agy-node tests/test_crypto_web.js
```

### 3.3 Headless E2E Dashboard Simulation Suite
To run the in-process DOM state machine and auth lifecycle simulation:

```bash
# Using Node.js
node tests/e2e/test_dashboard_runner.js

# Or using Antigravity bundled Node runtime
agy-node tests/e2e/test_dashboard_runner.js
```

### 3.4 Full Browser Playwright E2E Suite (CI/CD)
To run the Playwright browser E2E tests against the built dashboard frontend (`dist/`):

```bash
# Start local static server (in background)
npx serve dist -l 3000

# Execute Playwright E2E spec
npx playwright test tests/e2e/dashboard.spec.js --headed=false
```

---

## 4. Verification & Gate Confirmation

- **Acceptance Criterion 1 (Crypto & Tamper)**:
  - Python $\leftrightarrow$ Web Crypto decryption produces byte-for-byte matching JSON (`test_t3_crypto_15_cross_runtime_python_to_webcrypto` & `T1-WEB-01`).
  - Bit-flip tamper tests across all 4 slices (Salt, IV, Ciphertext, Auth Tag) immediately reject with authentication errors (`test_t2_crypto_09` through `test_t2_crypto_12`, and `T2-WEB-05` through `T2-WEB-08`).
  - Truncated payloads (<44 bytes) rejected before cryptographic routines are invoked (`test_t2_crypto_13` & `T2-WEB-09`).
- **Acceptance Criterion 2 (Ingestion, SFTP & Forensic Hygiene)**:
  - Mocked Garmin API endpoints verify incremental fetching and OAuth token refresh (`test_t1_ingest_01`, `test_t1_ingest_03`, `test_t2_ingest_06`).
  - Mocked Paramiko SFTP client verifies upload, atomic token persistence, and upload size verification (`test_t1_ingest_02`, `test_t1_ingest_04`, `test_t2_ingest_07`, `test_t2_ingest_09`).
  - Staging scrubber purges all `.fit` and raw `.json` files (`test_t1_cleanup_05`, `test_t2_ingest_10`).
  - Static audit scanner confirms clean distribution and detects injected `.fit`, JSON, GPS traces, or SSH keys (`test_t1_audit_01` through `test_t2_audit_10`).
  - Synthetic data generator deterministic seed 42 verified with genuine 14-byte binary `.FIT` header (`test_t1_mock_01` through `test_t1_mock_04`).
- **Acceptance Criterion 3 (Dashboard UI & E2E)**:
  - Headless state machine and Playwright spec cover locked modal, invalid passphrase feedback, valid unlock rendering all 3 visualization sections, sessionStorage bypass, and manual lock vault (`TC-01` through `TC-07`).
