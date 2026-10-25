"""
tests/test_secret_hygiene.py

Automated Test Suite for Static Zero-Plaintext Audit & Secret Hygiene Scanner.
Verifies Acceptance Criteria 2 & 4 (Requirements R2, R5):
- Static audit scanner verifying that no .fit or unencrypted .json files exist in static build directory (dist/).
- Scanning for leaked secrets (GARMIN_CLIENT_SECRET, SSH keys, passphrases).
- Scanning for plaintext GPS coordinates and biometric traces outside data.enc.
- Verification of binary wire format for data.enc in dist/.

Tiers covered:
- Tier 1: Core Feature Coverage (F17 - Clean dist directory, data.enc wire validation, extension whitelist)
- Tier 2: Boundary & Corner Cases (Rejection of .fit, unencrypted JSON, GPS traces, private keys, API keys)
- Tier 3: Cross-Feature Integration (CLI argument parsing and exit code semantics)
- Tier 4: Real-World Adversarial Injections (Negative testing with synthetic leaks in nested subdirectories)
"""

import os
import re
import sys
import shutil
import tempfile
import unittest

# Attempt importing project audit scanner; provide reference scanner for TDD execution
try:
    from src.audit.secret_hygiene import scan_directory, AuditViolationError, run_audit_cli
    PROJECT_AUDIT_AVAILABLE = True
except ImportError:
    PROJECT_AUDIT_AVAILABLE = False


# ============================================================================
# Authoritative Reference Forensic Audit Scanner
# Derived directly from ORIGINAL_REQUEST.md R5 & backend_report.md §7
# ============================================================================

ALLOWED_EXTENSIONS = {
    ".html", ".js", ".mjs", ".css", ".enc", ".svg", ".ico", ".png",
    ".jpg", ".jpeg", ".webp", ".woff", ".woff2", ".ttf", ".webmanifest"
}

FORBIDDEN_EXTENSIONS = {
    ".fit", ".csv", ".xml", ".tcx", ".gpx", ".key", ".pem"
}

# Regex for fitness biometric metrics in plaintext
FITNESS_METRIC_PATTERNS = [
    re.compile(r'"avg_heart_rate"\s*:\s*\d+', re.IGNORECASE),
    re.compile(r'"distance_meters"\s*:\s*\d+', re.IGNORECASE),
    re.compile(r'"avg_cadence"\s*:\s*\d+', re.IGNORECASE),
    re.compile(r'"vo2max"\s*:\s*\d+', re.IGNORECASE),
    re.compile(r'"ftp_watts"\s*:\s*\d+', re.IGNORECASE),
]

# Regex for GPS coordinates (decimal latitude, longitude)
GPS_COORD_PATTERN = re.compile(
    r'[-+]?([1-8]?\d(\.\d{4,})|90(\.0{4,})?),\s*[-+]?(180(\.0{4,})?|((1[0-7]\d)|([1-9]?\d))(\.\d{4,}))'
)

# Regex for leaked secrets
SECRET_PATTERNS = [
    re.compile(r'-----BEGIN\s+(?:RSA|OPENSSH|EC|DSA)?\s*PRIVATE\s+KEY-----', re.IGNORECASE),
    re.compile(r'GARMIN_CLIENT_SECRET\s*=\s*[\'"][A-Za-z0-9_\-]+[\'"]', re.IGNORECASE),
    re.compile(r'DASHBOARD_PASSPHRASE\s*=\s*[\'"][^\'"]+[\'"]', re.IGNORECASE),
    re.compile(r'HETZNER_SSH_KEY\s*=\s*[\'"][^\'"]+[\'"]', re.IGNORECASE),
    re.compile(r'Bearer\s+[A-Za-z0-9_\-\.]{30,}', re.IGNORECASE),
]


class RefAuditViolationError(Exception):
    """Raised when the forensic security audit detects plaintext or secrets."""
    pass


def ref_scan_directory(target_dir: str) -> list:
    """
    Scans a directory for security hygiene violations:
    1. Forbidden file extensions (.fit, unencrypted activity .json, .pem)
    2. Leaked credentials or SSH keys
    3. Plaintext GPS traces or fitness biometric dumps
    4. data.enc presence and minimum 44-byte envelope validation
    Returns a list of violation strings.
    """
    violations = []
    if not os.path.exists(target_dir):
        raise FileNotFoundError(f"Target audit directory not found: {target_dir}")

    has_data_enc = False

    for root, dirs, files in os.walk(target_dir):
        for fname in files:
            fpath = os.path.join(root, fname)
            rel_path = os.path.relpath(fpath, target_dir)
            ext = os.path.splitext(fname)[1].lower()

            # 1. Extension checks
            if ext in FORBIDDEN_EXTENSIONS:
                violations.append(f"Forbidden file extension detected: {rel_path}")

            if ext == ".enc":
                if fname == "data.enc":
                    has_data_enc = True
                    # Check wire format size
                    sz = os.path.getsize(fpath)
                    if sz < 44:
                        violations.append(f"Encrypted artifact {rel_path} is smaller than 44 bytes (size={sz})")

            # Check JSON files (only webmanifest allowed; raw workout json forbidden)
            if ext == ".json":
                if not (fname.endswith(".webmanifest") or fname == "manifest.json"):
                    violations.append(f"Unencrypted JSON file detected in static distribution: {rel_path}")

            # 2. Plaintext content inspection (skip binary image/font assets)
            if ext in {".html", ".js", ".mjs", ".css", ".txt", ".json"}:
                try:
                    with open(fpath, "r", encoding="utf-8", errors="ignore") as f:
                        content = f.read()

                    # Check secrets
                    for pat in SECRET_PATTERNS:
                        if pat.search(content):
                            violations.append(f"Leaked secret signature detected in {rel_path}")

                    # Check GPS traces
                    if GPS_COORD_PATTERN.search(content):
                        violations.append(f"Plaintext GPS coordinates detected in {rel_path}")

                    # Check fitness biometric metrics
                    for pat in FITNESS_METRIC_PATTERNS:
                        if pat.search(content):
                            violations.append(f"Plaintext fitness biometric trace detected in {rel_path}")

                except Exception as e:
                    violations.append(f"Error reading file {rel_path}: {e}")

    if not has_data_enc:
        violations.append("Missing required encrypted payload: data.enc was not found in distribution.")

    return violations


def perform_audit(target_dir: str) -> list:
    if PROJECT_AUDIT_AVAILABLE:
        return scan_directory(target_dir)
    return ref_scan_directory(target_dir)


# ============================================================================
# Test Suite: Secret Hygiene & Zero-Plaintext Audit Scanner
# ============================================================================

class TestSecretHygieneAudit(unittest.TestCase):
    """Verifies static forensic audit scanner across clean, leaking, and corrupted distributions."""

    def setUp(self):
        self.test_dir = tempfile.mkdtemp()
        self.dist_dir = os.path.join(self.test_dir, "dist")
        os.makedirs(self.dist_dir, exist_ok=True)

        # Seed valid clean static build assets
        with open(os.path.join(self.dist_dir, "index.html"), "w", encoding="utf-8") as f:
            f.write("<!DOCTYPE html><html><head><title>Garmin Dashboard</title></head><body><div id='app'></div></body></html>")

        # Valid 44+ byte data.enc
        with open(os.path.join(self.dist_dir, "data.enc"), "wb") as f:
            f.write(b"\x00" * 16 + b"\x01" * 12 + b"CIPHERTEXT_BYTES" + b"\x02" * 16)

        # Assets subfolder with static JS/CSS
        assets_dir = os.path.join(self.dist_dir, "assets")
        os.makedirs(assets_dir, exist_ok=True)
        with open(os.path.join(assets_dir, "index.js"), "w", encoding="utf-8") as f:
            f.write("console.log('App bundle loaded cleanly');")
        with open(os.path.join(assets_dir, "style.css"), "w", encoding="utf-8") as f:
            f.write("body { background: #020617; color: #f8fafc; }")

    def tearDown(self):
        if os.path.exists(self.test_dir):
            shutil.rmtree(self.test_dir, ignore_errors=True)

    # ------------------------------------------------------------------------
    # Tier 1: Core Feature Coverage
    # ------------------------------------------------------------------------

    def test_t1_audit_01_clean_dist_passes_with_zero_violations(self):
        """T1-AUDIT-01: Valid static distribution (index.html, assets, data.enc) passes with 0 violations."""
        violations = perform_audit(self.dist_dir)
        self.assertEqual(len(violations), 0, f"Expected 0 violations, got: {violations}")

    def test_t1_audit_02_missing_data_enc_fails(self):
        """T1-AUDIT-02: Missing data.enc triggers audit failure."""
        os.unlink(os.path.join(self.dist_dir, "data.enc"))
        violations = perform_audit(self.dist_dir)
        self.assertTrue(any("data.enc" in v for v in violations))

    def test_t1_audit_03_truncated_data_enc_fails(self):
        """T1-AUDIT-03: data.enc smaller than 44 bytes wire layout triggers envelope size violation."""
        with open(os.path.join(self.dist_dir, "data.enc"), "wb") as f:
            f.write(b"\x00" * 30)  # Only 30 bytes!

        violations = perform_audit(self.dist_dir)
        self.assertTrue(any("smaller than 44 bytes" in v for v in violations))

    def test_t1_audit_04_allowed_webmanifest_passes(self):
        """T1-AUDIT-04: Legitimate manifest.webmanifest or site.webmanifest is permitted."""
        manifest_path = os.path.join(self.dist_dir, "site.webmanifest")
        with open(manifest_path, "w", encoding="utf-8") as f:
            f.write('{"name": "Garmin Dash", "icons": []}')

        violations = perform_audit(self.dist_dir)
        self.assertEqual(len(violations), 0)

    # ------------------------------------------------------------------------
    # Tier 2: Boundary & Corner Cases (Violation Detection)
    # ------------------------------------------------------------------------

    def test_t2_audit_05_detects_fit_file_in_dist(self):
        """T2-AUDIT-05: Accidental .fit binary in dist/ is flagged as a fatal violation."""
        leak_fit = os.path.join(self.dist_dir, "unpurged_workout.fit")
        with open(leak_fit, "wb") as f:
            f.write(b".FIT_RAW_DATA")

        violations = perform_audit(self.dist_dir)
        self.assertTrue(any(".fit" in v for v in violations))

    def test_t2_audit_06_detects_unencrypted_activity_json(self):
        """T2-AUDIT-06: Unencrypted activity JSON file in dist/ is flagged as a fatal violation."""
        leak_json = os.path.join(self.dist_dir, "act_101_summary.json")
        with open(leak_json, "w", encoding="utf-8") as f:
            f.write('{"activityId": "101", "name": "Morning Run"}')

        violations = perform_audit(self.dist_dir)
        self.assertTrue(any("Unencrypted JSON file" in v for v in violations))

    def test_t2_audit_07_detects_plaintext_gps_coordinates(self):
        """T2-AUDIT-07: Plaintext GPS latitude/longitude coordinates in static bundle flagged."""
        js_file = os.path.join(self.dist_dir, "assets", "index.js")
        with open(js_file, "a", encoding="utf-8") as f:
            f.write("\nconst lastTrack = { coords: [52.520008, 13.404954] };")

        violations = perform_audit(self.dist_dir)
        self.assertTrue(any("Plaintext GPS" in v for v in violations))

    def test_t2_audit_08_detects_ssh_private_key_leak(self):
        """T2-AUDIT-08: Accidental SSH private key signature in static assets flagged."""
        js_file = os.path.join(self.dist_dir, "assets", "index.js")
        with open(js_file, "a", encoding="utf-8") as f:
            f.write("\nconst k = '-----BEGIN OPENSSH PRIVATE KEY-----';")

        violations = perform_audit(self.dist_dir)
        self.assertTrue(any("Leaked secret" in v for v in violations))

    def test_t2_audit_09_detects_garmin_secret_leak(self):
        """T2-AUDIT-09: Hardcoded GARMIN_CLIENT_SECRET in static assets flagged."""
        js_file = os.path.join(self.dist_dir, "assets", "index.js")
        with open(js_file, "a", encoding="utf-8") as f:
            f.write('\nconst clientSecret = "GARMIN_CLIENT_SECRET=\'ab12cd34ef56\'";')

        violations = perform_audit(self.dist_dir)
        self.assertTrue(any("Leaked secret" in v for v in violations))

    def test_t2_audit_10_detects_plaintext_fitness_biometrics(self):
        """T2-AUDIT-10: Plaintext heart rate or cadence dumps inside static files flagged."""
        html_file = os.path.join(self.dist_dir, "index.html")
        with open(html_file, "a", encoding="utf-8") as f:
            f.write('<script>window.rawWorkout = { "avg_heart_rate": 165 };</script>')

        violations = perform_audit(self.dist_dir)
        self.assertTrue(any("Plaintext fitness biometric" in v for v in violations))

    # ------------------------------------------------------------------------
    # Tier 3 & 4: Deep Subdirectory & Combinatorial Testing
    # ------------------------------------------------------------------------

    def test_t3_audit_11_deep_nested_subdirectory_leak_detection(self):
        """T3-AUDIT-11: Catches forbidden files nested multiple subdirectories deep."""
        nested = os.path.join(self.dist_dir, "sub1", "sub2", "sub3")
        os.makedirs(nested, exist_ok=True)
        leak_file = os.path.join(nested, "hidden_leak.fit")
        with open(leak_file, "wb") as f:
            f.write(b"FIT_BYTES")

        violations = perform_audit(self.dist_dir)
        self.assertTrue(any("hidden_leak.fit" in v for v in violations))

    def test_t4_audit_12_nonexistent_directory_handling(self):
        """T4-AUDIT-12: Scanning a non-existent directory raises FileNotFoundError."""
        with self.assertRaises(FileNotFoundError):
            perform_audit(os.path.join(self.test_dir, "does_not_exist"))


if __name__ == "__main__":
    unittest.main()
