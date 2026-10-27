import json
import unittest
from pathlib import Path
from src.encryption.crypto_engine import decrypt_payload

class TestFinalAcceptanceCriteria(unittest.TestCase):
    def setUp(self):
        self.repo_root = Path(__file__).resolve().parent.parent
        self.frontend_html = (self.repo_root / "frontend" / "index.html").read_text(encoding="utf-8")
        self.dist_html = (self.repo_root / "dist" / "index.html").read_text(encoding="utf-8")

    def test_ac1_no_section_prefixes(self):
        """Acceptance Criteria 1: No literal Section 1:, Section 2:, Section 3: prefixes."""
        for name, html in [("frontend/index.html", self.frontend_html), ("dist/index.html", self.dist_html)]:
            self.assertNotIn("Section 1:", html, f"{name} contains literal 'Section 1:'")
            self.assertNotIn("Section 2:", html, f"{name} contains literal 'Section 2:'")
            self.assertNotIn("Section 3:", html, f"{name} contains literal 'Section 3:'")

    def test_ac1_required_dom_ids(self):
        """Acceptance Criteria 1 & 8: Target DOM IDs must exist intact."""
        required_ids = [
            "passphrase-modal",
            "dashboard-main",
            "weekly-volume-chart",
            "training-load-chart",
            "hr-zone-chart",
            "power-zone-chart",
            "pace-zone-chart",
            "threshold-trends-chart",
            "activities-table-body",
            "activity-drawer",
            "dashboard-content",
            "activity-table",
        ]
        for name, html in [("frontend/index.html", self.frontend_html), ("dist/index.html", self.dist_html)]:
            for rid in required_ids:
                self.assertIn(f'id="{rid}"', html, f"{name} missing required id='{rid}'")

    def test_ac1_dist_asset_references_integrity(self):
        """Acceptance Criteria 1: dist/index.html asset links resolve to existing files on disk."""
        self.assertNotIn("./src/", self.dist_html, "dist/index.html must not contain un-transformed ./src/ links")
        self.assertIn('href="./assets/style.css"', self.dist_html, "dist/index.html must link to ./assets/style.css")
        self.assertTrue((self.repo_root / "dist" / "assets" / "style.css").exists(), "dist/assets/style.css must exist")
        self.assertIn('src="./assets/main.js"', self.dist_html, "dist/index.html must link to ./assets/main.js")
        self.assertTrue((self.repo_root / "dist" / "assets" / "main.js").exists(), "dist/assets/main.js must exist")

    def test_ac1_chart_legends_and_x_axis_labels_no_clip_or_overlap(self):
        """Acceptance Criteria 1: Automated test verifies chart legends and X-axis labels do not clip or overlap."""
        import os
        import shutil
        import subprocess

        node_bin = shutil.which("agy-node") or shutil.which("node")
        if not node_bin:
            appdata_agy = os.path.expandvars(r"%APPDATA%\Antigravity\bin\agy-node.cmd")
            if os.path.exists(appdata_agy):
                node_bin = appdata_agy
            else:
                node_bin = "agy-node"

        test_script = self.repo_root / "tests" / "test_chart_layout_integrity.js"
        self.assertTrue(test_script.exists(), "test_chart_layout_integrity.js must exist")

        proc = subprocess.run(
            [str(node_bin), str(test_script)],
            capture_output=True,
            text=True,
            timeout=30,
            cwd=str(self.repo_root),
            shell=True if os.name == "nt" else False
        )
        if proc.returncode != 0:
            print(proc.stdout)
            print(proc.stderr)
        self.assertEqual(proc.returncode, 0, f"Chart layout integrity test failed: {proc.stderr}")
        self.assertIn("All chart layouts verified: zero legend clipping, zero X-axis collisions", proc.stdout)

    def test_ac3_sport_taxonomy_and_weights_no_kg(self):
        """Acceptance Criteria 3: Weights (strength) has zero kg/weight load and duration/HR only."""
        enc_path = self.repo_root / "dist" / "data.enc"
        self.assertTrue(enc_path.exists(), "dist/data.enc must exist")
        raw_bytes = enc_path.read_bytes()
        decrypted_raw = decrypt_payload(wire=raw_bytes, passphrase="demo-passphrase-2026!")
        decrypted = json.loads(decrypted_raw.decode("utf-8"))

        activities = decrypted.get("activities", [])
        self.assertEqual(len(activities), 49)

        sports = set(a["sport"] for a in activities)
        self.assertIn("strength", sports)
        self.assertIn("cycling", sports)
        self.assertIn("hiking", sports)

        strength_acts = [a for a in activities if a["sport"] == "strength"]
        self.assertGreater(len(strength_acts), 5)
        for act in strength_acts:
            self.assertGreater(act["duration_seconds"], 0)
            self.assertGreater(act["avg_hr"], 0)
            self.assertEqual(act.get("distance_meters", 0), 0)
            # Ensure zero kg / tonnage fields
            for forbidden_key in ["weight", "kg", "load_kg", "tonnage", "weight_kg"]:
                self.assertNotIn(forbidden_key, act, f"Strength activity contains forbidden weight metric {forbidden_key}")

    def test_ac5_cron_and_readme(self):
        """Acceptance Criteria 5: 6-hour recurring cron and README documentation."""
        workflow_text = (self.repo_root / ".github" / "workflows" / "sync.yml").read_text(encoding="utf-8")
        self.assertIn("cron: '0 */6 * * *'", workflow_text)
        self.assertIn("workflow_dispatch:", workflow_text)

        readme_text = (self.repo_root / "README.md").read_text(encoding="utf-8")
        self.assertIn("0 */6 * * *", readme_text)
        self.assertIn("GARMIN_API_KEY", readme_text)
        self.assertIn("GARMIN_CLIENT_SECRET", readme_text)
        self.assertIn("DASHBOARD_PASSPHRASE", readme_text)


if __name__ == "__main__":
    unittest.main()
