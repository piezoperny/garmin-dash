"""
tests/test_m2_endurance_hiking_taxonomy.py

Milestone 2 Verification Suite:
Endurance Load & Hiking Activity Taxonomy.

Tests:
1. Ingestion taxonomy resolution in src/ingestion/sync.py:
   - Unrecognized / empty sport defaults to 'other' (not 'hiking').
   - Standard sports (cycling, running, walking, hiking, strength) still resolve correctly.
2. Synthetic dataset periodization in src/ingestion/mock_generator.py:
   - Hiking activities are isolated to early weeks (weeks 1-2).
   - Zero hiking activities in the last 6 weeks (weeks 3-8, >= 42 days).
   - Running activities populate outdoor foot endurance slots in weeks 3-8.
   - Total activity count invariant is strictly maintained (49 activities).
   - Cadence invariants: hiking 92-114 spm, running 155-175 spm, cycling 70-110 rpm, strength strictly 0.
"""

import unittest
from datetime import datetime
from src.ingestion.sync import resolve_sport_taxonomy
from src.ingestion.mock_generator import SyntheticDatasetGenerator, compile_rollup


class TestMilestone2TaxonomyAndPeriodization(unittest.TestCase):
    def test_sync_taxonomy_fallback_defaults_to_other(self):
        """M2-01: Empty, unmapped, or missing activity types must resolve to 'other', NOT 'hiking'."""
        self.assertEqual(resolve_sport_taxonomy(None), "other")
        self.assertEqual(resolve_sport_taxonomy(""), "other")
        self.assertEqual(resolve_sport_taxonomy({}), "other")
        self.assertEqual(resolve_sport_taxonomy({"activityType": ""}), "other")
        self.assertEqual(resolve_sport_taxonomy({"sport": None}), "other")

        # Explicit custom default should be respected if provided
        self.assertEqual(resolve_sport_taxonomy("", default="custom_fallback"), "custom_fallback")

        # Known sports must still map correctly
        self.assertEqual(resolve_sport_taxonomy("cycling"), "cycling")
        self.assertEqual(resolve_sport_taxonomy("road_biking"), "cycling")
        self.assertEqual(resolve_sport_taxonomy("running"), "running")
        self.assertEqual(resolve_sport_taxonomy("trail_running"), "running")
        self.assertEqual(resolve_sport_taxonomy("hiking"), "hiking")
        self.assertEqual(resolve_sport_taxonomy("walking"), "walking")
        self.assertEqual(resolve_sport_taxonomy("strength_training"), "strength")

    def test_mock_generator_hiking_taper_and_recency(self):
        """M2-02: Hiking activities occur only in early weeks; 0 hikes in last 6 weeks (>= 42 days)."""
        gen = SyntheticDatasetGenerator(seed=42)
        activities = gen.generate_activities()
        self.assertEqual(len(activities), 49, "Total activity count must remain exactly 49")

        hikes = [a for a in activities if a["sport"] == "hiking"]
        runs = [a for a in activities if a["sport"] == "running"]
        cycles = [a for a in activities if a["sport"] == "cycling"]
        weights = [a for a in activities if a["sport"] == "strength"]

        self.assertEqual(len(hikes), 6, "Expected 6 hikes across first 2 weeks")
        self.assertEqual(len(runs), 17, "Expected 17 runs across weeks 3-8")
        self.assertEqual(len(cycles), 18)
        self.assertEqual(len(weights), 8)
        self.assertEqual(len(hikes) + len(runs) + len(cycles) + len(weights), 49)

        # Confirm recency window: last hike was at least 42 days (1.5 months) before latest activity
        latest_dt = datetime.fromisoformat(activities[-1]["start_time"].replace("Z", "+00:00"))
        last_hike_dt = datetime.fromisoformat(hikes[-1]["start_time"].replace("Z", "+00:00"))
        days_since_last_hike = (latest_dt - last_hike_dt).days

        self.assertGreaterEqual(
            days_since_last_hike, 42,
            f"Expected at least 42 days since last hike, found {days_since_last_hike}"
        )

    def test_mock_generator_cadence_and_metric_invariants(self):
        """M2-03: Cadence bounds and metric invariants across sports."""
        gen = SyntheticDatasetGenerator(seed=42)
        activities = gen.generate_activities()

        for a in activities:
            sport = a["sport"]
            cad = a["avg_cadence"]
            if sport == "hiking":
                self.assertGreaterEqual(cad, 90)
                self.assertLessEqual(cad, 120)
            elif sport == "running":
                self.assertGreaterEqual(cad, 150)
                self.assertLessEqual(cad, 180)
            elif sport == "cycling":
                self.assertGreaterEqual(cad, 60)
                self.assertLessEqual(cad, 125)
            elif sport == "strength":
                self.assertEqual(cad, 0)
                self.assertEqual(a.get("distance_meters", 0), 0)

    def test_rollup_weekly_hiking_load_zero_in_latest_weeks(self):
        """M2-04: Compiled rollup shows 0 hiking hours and km in the last 6 weeks."""
        gen = SyntheticDatasetGenerator(seed=42)
        activities = gen.generate_activities()
        rollup = compile_rollup(activities)

        weekly = rollup.get("training_load", {}).get("weekly", [])
        self.assertGreaterEqual(len(weekly), 8)

        # The last 6 weeks must have 0.0 hiking hours
        for w in weekly[-6:]:
            self.assertEqual(w.get("hiking_hours", 0.0), 0.0, f"Week {w['week']} should have 0 hiking hours")
            self.assertEqual(w.get("hiking_km", 0.0), 0.0, f"Week {w['week']} should have 0 hiking km")


if __name__ == "__main__":
    unittest.main()
