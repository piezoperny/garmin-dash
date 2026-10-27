# Client-Side Encrypted Garmin Fitness Dashboard

[![CI/CD Garmin Sync & Deploy](https://github.com/<username>/garmin-dash/actions/workflows/sync.yml/badge.svg)](https://github.com/<username>/garmin-dash/actions/workflows/sync.yml)
[![Zero-Knowledge Security](https://img.shields.io/badge/Security-Zero--Knowledge%20AES--256--GCM-blue.svg)](https://github.com/<username>/garmin-dash)
[![Web Crypto API](https://img.shields.io/badge/Web%20Crypto-Subtle%20API-success.svg)](https://w3c.github.io/webcrypto/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A fully automated, **zero-knowledge, client-side encrypted personal fitness dashboard** hosted on **GitHub Pages** from a public repository.

This project automatically ingests activity summaries, physiological metrics, and raw `.FIT` files from the **Garmin Connect Developer API (Personal Tier)**, permanently archives raw workouts off-site to a remote **Hetzner Storage Box over SFTP**, and publishes an **AES-256-GCM encrypted binary wire payload (`data.enc`)** that is decrypted **exclusively in-browser** using your master passphrase.

---

## Table of Contents

1. [Architecture & Zero-Knowledge Security Model](#1-architecture--zero-knowledge-security-model)
2. [Binary Wire Format Specification](#2-binary-wire-format-specification)
3. [Setup Guides](#3-setup-guides)
   - [3.1 Garmin Connect Developer API (Personal Tier)](#31-garmin-connect-developer-api-personal-tier)
   - [3.2 Hetzner Storage Box SFTP Archival](#32-hetzner-storage-box-sftp-archival)
   - [3.3 Master Passphrase Generation](#33-master-passphrase-generation)
   - [3.4 GitHub Repository Secrets Configuration](#34-github-repository-secrets-configuration)
4. [Local Execution & Development Commands](#4-local-execution--development-commands)
   - [4.1 Synthetic Mock Demo Mode (Offline)](#41-synthetic-mock-demo-mode-offline)
   - [4.2 Build-Time Encryption CLI](#42-build-time-encryption-cli)
   - [4.3 Workspace Cleanup & Forensic Verification](#43-workspace-cleanup--forensic-verification)
   - [4.4 Static Frontend Build & Local Preview](#44-static-frontend-build--local-preview)
   - [4.5 Running the Automated Test Suite](#45-running-the-automated-test-suite)
5. [Interactive Visualizations & Metrics](#5-interactive-visualizations--metrics)
6. [Troubleshooting & FAQ](#6-troubleshooting--faq)

---

## 1. Architecture & Zero-Knowledge Security Model

### High-Level Architecture Diagram

```
+----------------------------------------------------------------------------------------------------+
|                                    EPHEMERAL RUNNER / LOCAL MACHINE                                |
|                                                                                                    |
|  +--------------------+         Incremental Ingestion         +---------------------------------+  |
|  |   Garmin Connect   |  ==================================>  |        src.ingestion.sync       |  |
|  |   Developer API    |   (JSON Summaries & Raw .FIT Files)   |   (High-Water Mark Incremental) |  |
|  +--------------------+                                       +---------------------------------+  |
|                                                                          |             |           |
|                 +--------------------------------------------------------+             |           |
|                 | OAuth Refresh Tokens & Raw Archival                                  |           |
|                 v                                                                      v           |
|  +-----------------------------+                                        +-----------------------+  |
|  |     HETZNER STORAGE BOX     |                                        | Transient JSON Rollup |  |
|  |     (Remote Off-Site SFTP)  |                                        | dashboard_rollup.json |  |
|  |  garmin_archive/            |                                        +-----------------------+  |
|  |   ├── .session/ (OAuth)     |                                                   |               |
|  |   ├── metadata/ (Manifest)  |                                                   v               |
|  |   └── activities/ (FIT/JSON)|                                        +-----------------------+  |
|  +-----------------------------+                                        | src.encryption.encrypt|  |
|                                                                         |  PBKDF2 600,000 iters |  |
|                                                                         |  AES-256-GCM AEAD     |  |
|                                                                         +-----------------------+  |
|                                                                                    |               |
|  +-------------------------------------------------------------+                  v               |
|  |              MANDATORY FORENSIC CLEANUP & AUDIT             |       +-----------------------+   |
|  |  Purges .raw_staging, .staging, and validates zero          |       | Strict Binary Payload |   |
|  |  plaintext fitness traces or credentials in workspace.      |       |      data.enc         |   |
|  +-------------------------------------------------------------+       +-----------------------+   |
|                                                                                    |               |
+------------------------------------------------------------------------------------+---------------+
                                                                                     |
                                                                                     | Deploy Bundle
                                                                                     v
+----------------------------------------------------------------------------------------------------+
|                                      PUBLIC GITHUB PAGES HOSTING                                   |
|                                                                                                    |
|            index.html             assets/*.js, *.css             data.enc (Encrypted Binary)       |
|     (Static Dark-Mode App)         (Zero Plaintext)          (AES-GCM Ciphertext + Salt + IV)      |
+----------------------------------------------------------------------------------------------------+
                                                                                     |
                                                                                     | HTTPS Fetch
                                                                                     v
+----------------------------------------------------------------------------------------------------+
|                                         USER'S WEB BROWSER                                         |
|                                                                                                    |
|   1. Prompts for Master Passphrase in locked modal.                                                |
|   2. window.crypto.subtle derives 256-bit key (PBKDF2-HMAC-SHA256, 600k iterations).               |
|   3. AES-256-GCM decrypts data.enc in memory. Any tampering triggers authentication rejection.    |
|   4. Raw key cached in DOM sessionStorage for instant reload bypass without re-prompting.          |
|   5. Chart.js renders interactive Endurance, Physiological, and Activity drill-down views.         |
+----------------------------------------------------------------------------------------------------+
```

### Zero-Knowledge Threat Model & Guarantees

1. **Zero Plaintext at Rest**: No heart rate metrics, GPS coordinates, power zones, workout notes, or personal summaries ever enter Git commits, build artifacts, or GitHub Pages. Only the mathematically opaque `data.enc` binary file is published.
2. **True In-Memory Decryption**: Key derivation and decryption happen strictly inside your browser's private memory space using the hardware-accelerated W3C Web Crypto Subtle API (`window.crypto.subtle`). Decrypted data is never transmitted to any server or telemetry service.
3. **Off-Site Historical Archival**: Raw `.FIT` and JSON files are uploaded directly over SFTP to your private Hetzner Storage Box and then immediately scrubbed from the local or CI runner file system.
4. **Credential Isolation**: Ephemeral CI runners access credentials only via protected GitHub Secrets. All console logs pass through an automated `SecretRedactionFilter` regex scanner that strips Bearer tokens, private keys, and passwords.
5. **Tamper Resistance**: AES-256-GCM includes a 128-bit authentication tag covering the payload. Any tampering with salt, IV, ciphertext, or auth tag causes `crypto.subtle` to reject the payload immediately, returning zero partial data.

---

## 2. Binary Wire Format Specification

The encrypted payload `data.enc` conforms to a strict, fixed-header binary layout designed for seamless cross-runtime interoperability between Python and the browser's native Web Crypto API:

### Layout Diagram

```
+---------------------------------------------------------------------------------------------+
|                                    BINARY WIRE FORMAT (data.enc)                            |
+-----------------------+----------------------+---------------------------+------------------+
|      PBKDF2 Salt      |     AES-GCM IV       |   AES-256-GCM Ciphertext  |  GCM Auth Tag    |
|       (16 Bytes)      |      (12 Bytes)      |      (Variable Length)    |    (16 Bytes)    |
|       Offset 0..15    |     Offset 16..27    |      Offset 28..N-16      |   Offset N-16..N |
+-----------------------+----------------------+---------------------------+------------------+
|<-------- Header: 28 Bytes ---------->|                                   |<- Tag: 16 Bytes->|
|<------------------------------ Minimum Total Length: 44 Bytes ----------------------------->|
```

### Byte Offset & Slicing Table

| Slice Offset | Field Name | Size | Purpose / Cryptographic Primitive |
| :--- | :--- | :---: | :--- |
| `0 .. 15` | **Salt** | 16 Bytes | Cryptographically random salt (`os.urandom(16)`) input to PBKDF2-HMAC-SHA256. |
| `16 .. 27` | **Initialization Vector (IV)** | 12 Bytes | Random 96-bit nonce (`os.urandom(12)`) required for AES-256-GCM AEAD encryption. |
| `28 .. N-16` | **Ciphertext** | $N - 44$ Bytes | Compact UTF-8 JSON rollup encrypted under the derived 256-bit symmetric key. |
| `N-16 .. N` | **Authentication Tag** | 16 Bytes | 128-bit AES-GCM authentication tag verifying ciphertext and header integrity. |

### Cryptographic Parameters
- **Key Derivation Function (KDF)**: `PBKDF2-HMAC-SHA256`
  - **Salt Length**: 16 bytes (128 bits)
  - **Iterations**: 600,000 (compliant with OWASP / NIST SP 800-132 recommendations)
  - **Derived Key Length**: 32 bytes (256 bits)
- **Authenticated Encryption (AEAD)**: `AES-256-GCM` (NIST SP 800-38D)
  - **IV / Nonce**: 12 bytes (96 bits)
  - **Authentication Tag**: 16 bytes (128 bits)
  - **Associated Data (AAD)**: None (`associated_data=None`)
- **Minimum Payload Size**: Exactly 44 bytes (16 salt + 12 IV + 0 ciphertext + 16 auth tag). Any payload smaller than 44 bytes is rejected with `MalformedWireError` before cryptographic operations execute.

---

## 3. Setup Guides

### 3.1 Garmin Connect Developer API (Personal Tier)

To automatically pull your workouts, register for the Garmin Connect Developer API (Personal Tier):

1. **Create a Developer Account**:
   - Visit the [Garmin Developer Portal](https://developer.garmin.com/).
   - Sign in with your existing Garmin account and register as a developer.
2. **Create an Application**:
   - Under your developer dashboard, select **Create New App**.
   - Select **Personal Tier** (free for individual access to your own workouts).
   - Configure permissions for **Activities** and **Health & Fitness Metrics**.
3. **Acquire OAuth Credentials**:
   - Note your **Consumer Key** (`GARMIN_API_KEY`) and **Consumer Secret** (`GARMIN_CLIENT_SECRET`).
4. **Initial Token Bootstrapping**:
   - Perform the initial one-time OAuth 2.0 handshake using Garmin's OAuth portal or our bootstrap helper to obtain an initial `GARMIN_ACCESS_TOKEN` and `GARMIN_REFRESH_TOKEN`.
   - **Continuous Persistence**: You do not need to manually rotate tokens after initial setup! The pipeline automatically persists rotated OAuth 2.0 refresh tokens directly to `garmin_archive/.session/garmin_oauth.json` on your Hetzner Storage Box over SFTP during each scheduled run.

### 3.2 Hetzner Storage Box SFTP Archival

A Hetzner Storage Box (e.g. BX11, BX21) provides cost-effective, off-site, private storage for your full workout archive:

1. **Order or Access your Storage Box**:
   - Log in to the [Hetzner Robot Console](https://robot.hetzner.com/) under **Storage Boxes**.
2. **Enable SSH/SFTP Access**:
   - Under your Storage Box settings, check **SSH Support**.
   - Note your assigned hostname (e.g. `u123456.your-storagebox.de`) and username (e.g. `u123456`).
3. **Generate an SSH Key Pair**:
   Generate a dedicated, passwordless Ed25519 SSH key pair for CI/CD automation:
   ```bash
   ssh-keygen -t ed25519 -C "garmin-dash-ci" -f ~/.ssh/garmin_dash_hetzner
   ```
4. **Install Public Key on Hetzner Storage Box**:
   Upload the public key (`~/.ssh/garmin_dash_hetzner.pub`) via the Hetzner Robot panel (under *SSH Keys*) or using SFTP:
   ```bash
   # Connect to Storage Box (Port 23)
   sftp -P 23 u123456@u123456.your-storagebox.de
   mkdir .ssh
   chmod 700 .ssh
   put ~/.ssh/garmin_dash_hetzner.pub .ssh/authorized_keys
   chmod 600 .ssh/authorized_keys
   bye
   ```
5. **Storage Box Directory Hierarchy**:
   The ingestion client automatically creates and manages the following hierarchy:
   ```
   garmin_archive/
   ├── .session/
   │   └── garmin_oauth.json        # Durable OAuth 2.0 session token store
   ├── metadata/
   │   └── sync_manifest.json       # Incremental sync high-water mark manifest
   └── activities/
       └── 2026/
           └── 10/
               ├── act_12345_summary.json
               └── act_12345.fit
   ```

### 3.3 Master Passphrase Generation

Your master passphrase protects your entire fitness dataset against unauthorized inspection.

- **Entropy Recommendation**: Use a 5-to-6 word random passphrase generated via Diceware, or a random string of at least 32 characters (e.g. `correct-horse-battery-staple-2026!`).
- **Save Securely**: Store this passphrase in your password manager. Because encryption is zero-knowledge, **there is no password reset mechanism**. If you lose your passphrase, existing `data.enc` payloads cannot be recovered.
- Configure `DASHBOARD_PASSPHRASE` locally or in GitHub Secrets.

### 3.4 GitHub Repository Secrets & Automated 6-Hour Sync

The automated sync pipeline (`.github/workflows/sync.yml`) runs on a **6-hour recurring schedule** (`cron: '0 */6 * * *'` at 00:00, 06:00, 12:00, and 18:00 UTC) as well as on-demand via `workflow_dispatch`.

To enable automated synchronization, configure the following repository secrets under **Settings** $\rightarrow$ **Secrets and variables** $\rightarrow$ **Actions** $\rightarrow$ **New repository secret**:

- **`GARMIN_API_KEY`** & **`GARMIN_CLIENT_SECRET`**: Client ID and secret provisioned through the Garmin Developer Portal (Personal Tier). Used by `src.ingestion.sync` to authenticate and ingest recent workout summaries and `.FIT` binaries.
- **`DASHBOARD_PASSPHRASE`**: Master passphrase used by `src.encryption.encrypt` to derive the AES-256-GCM encryption key (PBKDF2-HMAC-SHA256, 600,000 iterations). Must match the passphrase you enter in the browser vault modal.
- **`HETZNER_HOST`**, **`HETZNER_USER`**, & **`HETZNER_SSH_KEY`**: Off-site SFTP archival credentials for Hetzner Storage Box storage of raw `.FIT` binaries, manifests, and durable OAuth session tokens.

| Secret Name | Required | Description | Example / Format |
| :--- | :---: | :--- | :--- |
| `GARMIN_API_KEY` | **Yes** | Garmin Developer Client ID / Consumer Key | `9b8a7c6d-5e4f-3a2b-1c0d-e9f8a7b6c5d4` |
| `GARMIN_CLIENT_SECRET`| **Yes** | Garmin Developer Client Secret | `xK9#mP2$vL8*qR4!wT6^yZ1@` |
| `HETZNER_HOST` | **Yes** | Hetzner Storage Box SFTP hostname | `u123456.your-storagebox.de` |
| `HETZNER_USER` | **Yes** | Hetzner Storage Box username | `u123456` |
| `HETZNER_SSH_KEY` | **Yes** | Private SSH Key (Ed25519 or RSA, raw PEM or OpenSSH string) | `-----BEGIN OPENSSH PRIVATE KEY-----\n...` |
| `DASHBOARD_PASSPHRASE`| **Yes** | Master passphrase for build-time AES-256-GCM encryption | `correct-horse-battery-staple-2026!` |
| `HETZNER_PORT` | *Optional*| Custom SFTP port (defaults to 23 with auto-fallback to 22) | `23` or `22` |
| `HETZNER_KEY_PASSPHRASE`| *Optional*| Passphrase for encrypted private SSH key (if configured) | `my-ssh-key-password` |
| `GARMIN_ACCESS_TOKEN` | *Optional*| Initial bootstrap OAuth access token (before first SFTP write) | `eyJhbGciOi...` |
| `GARMIN_REFRESH_TOKEN`| *Optional*| Initial bootstrap OAuth refresh token (before first SFTP write) | `1000.abc123...` |

---

## 4. Local Execution & Development Commands

### Environment Prerequisites
- **Python**: 3.11 or higher
- **Node.js**: 20 LTS or higher (`npm` included)

```bash
# Clone the repository
git clone https://github.com/<username>/garmin-dash.git
cd garmin-dash

# Create and activate Python virtual environment
python -m venv .venv
source .venv/bin/activate       # On Linux/macOS
# or .venv\Scripts\Activate.ps1 # On Windows PowerShell

# Install Python dependencies
pip install -r requirements.txt

# Install Frontend dependencies
cd frontend
npm install
cd ..
```

### 4.1 Synthetic Mock Demo Mode (Offline)

Test the entire pipeline locally without Garmin API credentials or external network access. The synthetic data generator produces 8 weeks of deterministic workouts focused on **Weights** (`strength` — duration and heart rate load only, no kg/weight load or distance), **Cycling** (`cycling`), and **Hiking** (`hiking` — with elevation ascent and cadence):

```bash
# 1. Run incremental ingestion in synthetic mock mode
python -m src.ingestion.sync --mock

# 2. Compile and encrypt the rollup into public/data.enc (uses demo passphrase: demo-passphrase-2026!)
python -m src.encryption.encrypt --mock --verify

# 3. Verify that zero plaintext files remain in the staging directory
python -m src.ingestion.cleanup --verify-only
```

### 4.2 Build-Time Encryption CLI

The encryption CLI (`src.encryption.encrypt`) compiles `dashboard_rollup.json`, derives a 256-bit key from `DASHBOARD_PASSPHRASE`, packages `data.enc`, and scrubs temporary files:

```bash
# Encrypt from default staging location with in-memory roundtrip verification
export DASHBOARD_PASSPHRASE="your-secure-passphrase"
python -m src.encryption.encrypt --verify

# CLI Options & Flags:
#   -p, --passphrase TEXT    Master dashboard passphrase (defaults to DASHBOARD_PASSPHRASE)
#   -i, --input-file PATH    Path to plaintext rollup (default: .staging/dashboard_rollup.json)
#   -o, --output-file PATH   Target encrypted file path (default: public/data.enc)
#   -m, --mock               Generate synthetic multi-sport dataset on the fly
#   --seed INT               Deterministic seed for synthetic generator (default: 42)
#   -v, --verify             Execute in-memory roundtrip decryption test
#   --no-purge               Do not unlink unencrypted input files after encryption
#   --iterations INT         PBKDF2 iteration count (default: 600,000)
```

### 4.3 Workspace Cleanup & Forensic Verification

Ensure that no raw `.FIT` files, unencrypted activity summaries, or transient JSON rollups remain in your workspace before deploying:

```bash
# Automatically purge .raw_staging/ and .staging/ directories
python -m src.ingestion.cleanup

# Forensic validation mode (verifies zero leaks without deleting; exits 1 if violations found)
python -m src.ingestion.cleanup --verify-only

# Secure wipe (overwrites sensitive staging files with 0x00 null bytes before unlinking)
python -m src.ingestion.cleanup --secure
```

### 4.4 Static Frontend Build & Local Preview

Build the dark-mode dashboard SPA and preview it locally:

```bash
cd frontend

# Start local development server with hot-reload (http://localhost:3000)
npm run dev

# Compile static assets into ../dist/ (base: './' for GitHub Pages subpath compatibility)
npm run build

# Preview the compiled production build
npm run preview
```

You can also serve `dist/` directly using standard HTTP servers:
```bash
npx serve dist -l 3000
```
Open `http://localhost:3000` in your browser, enter your passphrase, and view your decrypted dashboard.

### 4.5 Running the Automated Test Suite

The test suite covers cryptographic wire format validation, Web Crypto interoperability, SFTP archival, and headless browser E2E flows:

```bash
# 1. Run all Python unit and integration tests (unittest)
python -m unittest discover -s tests -p "test_*.py" -v

# Or using pytest:
pytest tests/ -v

# 2. Run Web Crypto subtle cross-runtime interoperability tests (Node.js)
node tests/test_crypto_web.js

# 3. Run Headless DOM and auth state machine simulation
node tests/e2e/test_dashboard_runner.js

# 4. Run Playwright Browser E2E suite (against built dist/)
npx playwright test tests/e2e/dashboard.spec.js
```

---

## 5. Interactive Visualizations & Metrics
 
Once unlocked with your master passphrase, the dashboard renders three interactive sections built with Chart.js, styled in a minimalist dark aesthetic with hairline borders and tabular numerals:

### 1. Endurance & Training Load
- **Stacked Weekly Volume**: Multi-sport duration chart plotting Weekly Duration (Hours) across Cycling, Hiking, and Weights, allowing cross-discipline volume analysis.
- **Dynamic Sport Filter Pills**: Instant filtering across **All · Cycling · Hiking · Weights** that dynamically updates KPI cards, volume charts, and activity records. Weights displays workout duration and heart rate metrics while displaying `—` for distance.
- **Physiological Training Load Curves**:
  - **ATL (Acute Training Load)**: 7-day exponentially weighted moving average representing fatigue.
  - **CTL (Chronic Training Load)**: 42-day exponentially weighted moving average representing fitness.
  - **TSB (Training Stress Balance)**: Form curve ($TSB = CTL - ATL$) indicating freshness vs. overtraining risk.

### 2. Physiological Distribution
- **Heart Rate Zones (Z1 - Z5)**: Wrapped donut chart displaying time in zone breakdowns calculated from resting and maximum heart rates.
- **Coggan Power Zones (Z1 - Z7)**: Cycling power output distribution relative to Functional Threshold Power (FTP).
- **Pace Zones**: Concise, non-colliding pace distribution for endurance activities (Hiking / Running) partitioned into Recovery, Aerobic, Tempo, Threshold, and Interval paces.
- **Historical Threshold Trends**: Longitudinal progression curves for VO2Max, FTP (watts), and Lactate Threshold Heart Rate (LTHR).

### 3. Activity Drill-Down
- **Filterable & Searchable Table**: Instant search across activity titles, sports (Weights, Cycling, Hiking), dates, and metrics with high-contrast sport badges.
- **Activity Detail Drawer**: Per-kilometer/mile split breakdowns with synchronized elevation ascent and cadence (spm for hiking, rpm for cycling), and HR curves for weight training workouts.

---

## 6. Troubleshooting & FAQ

### Q: Why does decrypting take 200–500 milliseconds?
**A**: PBKDF2 with 600,000 iterations is computationally intensive by design. It makes brute-force attacks against `data.enc` mathematically infeasible even if your encrypted file is downloaded from GitHub Pages. Once unlocked, the raw key is cached in `sessionStorage` so subsequent reloads in the same browser tab are instantaneous.

### Q: What happens if I forget my master passphrase?
**A**: The encryption pipeline is strictly zero-knowledge. Your passphrase is never saved, transmitted, or escrowed. If you forget your passphrase, `data.enc` cannot be decrypted. You can regenerate a new `data.enc` with a new passphrase during your next GitHub Actions sync.

### Q: SFTP connection to Hetzner Storage Box times out or fails.
**A**:
1. Check whether port 23 is blocked by your firewall or cloud provider. The client automatically falls back to port 22, or you can force port 22 by setting `HETZNER_PORT=22`.
2. Ensure `HETZNER_SSH_KEY` includes the complete private key header and footer:
   `-----BEGIN OPENSSH PRIVATE KEY-----` and `-----END OPENSSH PRIVATE KEY-----`.
3. If pasting into GitHub Secrets, ensure newlines are preserved or literal `\n` characters are used (the parser handles both).

### Q: How do I lock my dashboard when I'm done?
**A**: Click the **Lock Vault** button in the top navigation bar, or simply close your browser tab. Closing the tab immediately destroys the in-memory keys and wipes `sessionStorage`.

---

## License

This project is licensed under the MIT License — see the [LICENSE](LICENSE) file for details.
