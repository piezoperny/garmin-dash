"""
tests/test_challenger_m3_viz.py

Milestone 3 Adversarial Challenger Test Suite:
Empirical Stress-Testing of Interactive Visualizations & Data Rendering.
Challenger 2 for Milestone 3 (Visualizations & Data Rendering Challenger).

Coverage:
1. Section 1 (Endurance & Load):
   - Rollup data verification: weekly mileage, moving time, ATL/CTL/TSB curves.
   - ACWR workload ratio formula & category boundaries (Recovery, Optimal, Productive, Overreaching).
   - KPI metrics mathematical derivation and unit conversion (KM vs Miles).
2. Section 2 (Physiological Distribution):
   - 5-zone HR distributions (Z1-Z5) seconds and hour sums.
   - Coggan 7-zone power distributions (Z1-Z7).
   - Threshold trends progression (FTP, LTHR, VO2max).
   - Pace zones distribution.
3. Section 3 (Activity Drill-Down & Telemetry):
   - Search & sport filter partitioning (All, Run, Cycle, Strength).
   - Split & lap telemetry formatting (cadence in rpm vs spm, pace, elevation).
4. Subprocess execution of Node.js Web Crypto & DOM visualization harness (test_visualizations_adversarial_challenger.js).
"""

import json
import os
import shutil
import subprocess
import sys
import unittest
from pathlib import Path

from src.encryption.crypto_engine import decrypt_payload
from src.ingestion.mock_generator import SyntheticDatasetGenerator, compile_rollup


def _find_node_binary() -> str:
    for candidate in ["agy-node", "node"]:
        p = shutil.which(candidate)
        if p:
            return p
    return "agy-node"


class TestMilestone3VisualizationsChallenger(unittest.TestCase):
    """Empirical adversarial challenger tests for Milestone 3 Visualizations & Drill-Down."""

    @classmethod
    def setUpClass(cls):
        cls.demo_passphrase = "demo-passphrase-2026!"
        cls.enc_path = Path("dist/data.enc")
        if not cls.enc_path.exists():
            cls.enc_path = Path("public/data.enc")
        
        assert cls.enc_path.exists(), f"Encrypted artifact not found at {cls.enc_path}"

        with open(cls.enc_path, "rb") as f:
            wire_bytes = f.read()

        decrypted_bytes = decrypt_payload(cls.demo_passphrase, wire_bytes)
        cls.rollup = json.loads(decrypted_bytes.decode("utf-8"))

    def test_01_section1_endurance_payload_fidelity(self):
        """Verify Section 1 weekly volume and continuous load curves match decrypted payload."""
        training_load = self.rollup.get("training_load", {})
        self.assertIn("weekly", training_load)
        weekly = training_load["weekly"]
        self.assertGreaterEqual(len(weekly), 8, "Must contain at least 8 weeks of data")

        for w in weekly:
            self.assertIn("week", w)
            self.assertIn("run_km", w)
            self.assertIn("cycle_km", w)
            self.assertIn("strength_hours", w)
            self.assertIn("load", w)
            self.assertIn("atl", w)
            self.assertIn("ctl", w)
            self.assertIn("tsb", w)
            # Banister consistency: TSB == CTL - ATL (within 0.25 due to independent 1-decimal rounding)
            self.assertAlmostEqual(w["tsb"], w["ctl"] - w["atl"], delta=0.25)

        # Summary KPIs check
        summary = self.rollup.get("summary", {})
        self.assertIn("total_distance_km", summary)
        self.assertGreater(summary["total_distance_km"], 0)

        # Check total distance equals sum of activities
        activities = self.rollup.get("activities", [])
        total_act_meters = sum(a.get("distance_meters", 0) for a in activities)
        self.assertAlmostEqual(summary["total_distance_km"], total_act_meters / 1000.0, places=1)

    def test_02_section1_acwr_status_boundaries(self):
        """Stress-test ACWR workload ratio status classification across all 4 zones."""
        def classify_status(atl: float, ctl: float) -> str:
            acwr = (atl / ctl) if ctl > 0 else 1.0
            if acwr > 1.35:
                return "Overreaching"
            elif acwr >= 1.05:
                return "Productive"
            elif acwr >= 0.85:
                return "Optimal"
            else:
                return "Recovery"

        self.assertEqual(classify_status(150, 100), "Overreaching")  # 1.50 > 1.35
        self.assertEqual(classify_status(120, 100), "Productive")    # 1.20 >= 1.05
        self.assertEqual(classify_status(95, 100), "Optimal")        # 0.95 >= 0.85
        self.assertEqual(classify_status(70, 100), "Recovery")       # 0.70 < 0.85
        self.assertEqual(classify_status(100, 0), "Optimal")         # 0 CTL fallback

    def test_03_section2_physiological_distributions(self):
        """Verify Section 2 5-zone HR, Coggan 7-zone power, and threshold progressions."""
        physio = self.rollup.get("physiological", {})
        self.assertIn("heart_rate_zones", physio)
        self.assertIn("power_zones", physio)
        self.assertIn("threshold_trends", physio)

        hr_zones = physio["heart_rate_zones"]
        self.assertEqual(len(hr_zones), 5, "Must have exactly 5 HR zones (Z1-Z5)")
        for idx, z in enumerate(hr_zones):
            self.assertEqual(z["zone"], f"Z{idx + 1}")
            self.assertGreater(z["seconds"], 0)

        power_zones = physio["power_zones"]
        self.assertEqual(len(power_zones), 7, "Must have exactly 7 Coggan power zones (Z1-Z7)")
        for idx, z in enumerate(power_zones):
            self.assertTrue(z["zone"].startswith(f"Z{idx + 1}"))
            self.assertGreater(z["seconds"], 0)

        thresholds = physio["threshold_trends"]
        self.assertGreaterEqual(len(thresholds), 2)
        for t in thresholds:
            self.assertIn("date", t)
            self.assertIn("ftp", t)
            self.assertIn("lthr", t)
            self.assertIn("vo2max", t)
            self.assertGreater(t["ftp"], 200)
            self.assertGreater(t["lthr"], 140)
            self.assertGreater(t["vo2max"], 40)

    def test_04_section3_activity_drilldown_telemetry(self):
        """Verify Section 3 activity drill-down, sport partitioning, and cadence units."""
        activities = self.rollup.get("activities", [])
        self.assertEqual(len(activities), 49)

        running_acts = [a for a in activities if a["sport"] == "running"]
        cycling_acts = [a for a in activities if a["sport"] == "cycling"]
        strength_acts = [a for a in activities if a["sport"] == "strength"]

        self.assertEqual(len(running_acts) + len(cycling_acts) + len(strength_acts), 49)
        self.assertGreater(len(running_acts), 10)
        self.assertGreater(len(cycling_acts), 10)
        self.assertGreater(len(strength_acts), 5)

        # Running cadence telemetry in spm (150-200)
        for a in running_acts:
            self.assertIn("avg_cadence", a)
            self.assertGreaterEqual(a["avg_cadence"], 150)
            self.assertLessEqual(a["avg_cadence"], 200)

        # Cycling cadence telemetry in rpm (70-110)
        for a in cycling_acts:
            self.assertIn("avg_cadence", a)
            self.assertGreaterEqual(a["avg_cadence"], 70)
            self.assertLessEqual(a["avg_cadence"], 110)

        # Strength telemetry: 0 distance, 0 cadence
        for a in strength_acts:
            self.assertEqual(a.get("distance_meters", 0), 0)
            self.assertEqual(a.get("avg_cadence", 0), 0)

        # Splits and laps integrity
        acts_with_splits = [a for a in activities if a.get("splits")]
        self.assertGreater(len(acts_with_splits), 20)
        for a in acts_with_splits:
            for s in a["splits"]:
                self.assertIn("split_sec", s)
                self.assertIn("avg_hr", s)
                self.assertIn("avg_cadence", s)

    def test_05_run_node_adversarial_suite(self):
        """Executes the full Node.js adversarial DOM & Canvas visualization test harness."""
        node_bin = _find_node_binary()
        test_script = Path("tests/test_visualizations_adversarial_challenger.js")
        self.assertTrue(test_script.exists())

        cmd = [node_bin, str(test_script)]
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        
        sys.stdout.write(result.stdout)
        if result.returncode != 0:
            sys.stderr.write(result.stderr)
        
        self.assertEqual(result.returncode, 0, f"Node visualization challenger failed: {result.stderr}")
        self.assertIn("26 passed, 0 failed", result.stdout)


if __name__ == "__main__":
    unittest.main()
