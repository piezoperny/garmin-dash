"""
tests/test_challenger_m1_m4_adversarial.py

Adversarial Verification Suite for Challenger 1:
Backend & Ingestion Focus:
1. Stress test reprocess_canonical_activities with malicious/edge-case activities:
   - Missing fields, null fields, malformed sports, ancient timestamps, extreme elevation gain,
     null summaries, corrupt splits, negative durations, non-dict payloads.
   - Stale/falsely tagged "hiking" activities without hiking summary remapped to "other" or "walking",
     with zero ghost load spikes.
2. Stress test generate_wellness_dataset:
   - Sparse activities, single activity, leap years, dates spanning multiple years.
   - Boundary enforcement: all dates prior to the earliest activity date have steps == 0,
     unrecorded == True, and NEVER synthesize randint(6400, 8900) base steps.
"""

import unittest
from datetime import datetime, timezone, timedelta
from typing import Any, Dict, List

from src.ingestion.sync import (
    reprocess_canonical_activities,
    resolve_sport_taxonomy,
    compute_activity_tss,
)
from src.ingestion.mock_generator import (
    generate_wellness_dataset,
    compile_rollup,
    SyntheticDatasetGenerator,
)


class TestAdversarialReprocessCanonicalActivities(unittest.TestCase):
    """Stress testing reprocess_canonical_activities against adversarial payloads."""

    def test_non_dict_and_corrupt_records_handling(self):
        """Must gracefully handle None, string, int, list items without crashing."""
        malicious_input = [
            None,
            "corrupt string",
            12345,
            ["nested", "list"],
            {},
            {"id": None},
            {"id": "valid_1", "sport": "running", "duration_seconds": 3600, "avg_hr": 150},
        ]
        result = reprocess_canonical_activities(malicious_input)
        # Should filter non-dicts and preserve dicts
        self.assertIsInstance(result, list)
        self.assertEqual(len(result), 3)  # {}, {"id": None}, and {"id": "valid_1", ...}

    def test_falsely_tagged_hiking_without_summary(self):
        """
        Verify that activities falsely tagged as 'hiking' without hiking summary
        are remapped to 'other' or 'walking' and do not produce ghost load spikes.
        """
        # Case A: Falsely tagged as hiking, title has "walk" -> remapped to "walking"
        act_walk = {
            "id": "act_walk_1",
            "sport": "hiking",
            "title": "Evening Walk with dog",
            "duration_seconds": 3600,
            "distance_meters": 4000,
            "elevation_gain_meters": 1500,  # Falsely inflated or barometric error
            "avg_hr": 110,
        }
        res_walk = reprocess_canonical_activities([act_walk])[0]
        self.assertEqual(res_walk["sport"], "walking")
        # In walking, elevation factor is NOT added in compute_activity_tss (only hiking adds elev_factor)
        # Check that TSS does not have the massive elevation spike:
        # Walking TSS = dur_h * (hr/168)^2 * 35 = 1.0 * (110/168)^2 * 35 ~= 15.0
        # If it were hiking, elev_factor = (1500/100)*4 = 60.0 TSS!
        self.assertLess(res_walk["tss"], 30.0)

        # Case B: Falsely tagged as hiking, title has gym/workout -> remapped to "strength"
        act_gym = {
            "id": "act_gym_1",
            "sport": "hiking",
            "title": "Leg Day Strength Workout",
            "duration_seconds": 3600,
            "distance_meters": 5000,
            "elevation_gain_meters": 800,
            "avg_hr": 135,
        }
        res_gym = reprocess_canonical_activities([act_gym])[0]
        self.assertEqual(res_gym["sport"], "strength")
        self.assertEqual(res_gym["distance_meters"], 0.0)  # Strength resets distance
        self.assertEqual(res_gym["elevation_gain_meters"], 0)  # Strength resets elevation
        self.assertIsNone(res_gym["avg_pace_sec_km"])

        # Case C: Falsely tagged as hiking, title has cardio/aerobic -> remapped to "other"
        act_cardio = {
            "id": "act_cardio_1",
            "sport": "hiking",
            "title": "Indoor cardio session",
            "duration_seconds": 3600,
            "elevation_gain_meters": 500,
            "avg_hr": 145,
        }
        res_cardio = reprocess_canonical_activities([act_cardio])[0]
        self.assertEqual(res_cardio["sport"], "other")
        # Other TSS formula = dur_h * (hr/145) * 55 = 1 * 1 * 55 = 55.0 (no elevation bonus)
        self.assertEqual(res_cardio["tss"], 55.0)

        # Case D: Falsely tagged as hiking with raw activity type empty/whitespace -> remapped to "other"
        act_raw_other = {
            "id": "act_other_1",
            "sport": "hiking",
            "raw_activity_type": "",
            "title": "Evening routine",
            "duration_seconds": 3600,
            "elevation_gain_meters": 2000,
            "avg_hr": 120,
        }
        res_other = reprocess_canonical_activities([act_raw_other])[0]
        self.assertEqual(res_other["sport"], "other")
        self.assertLess(res_other["tss"], 60.0)  # Elevation bonus eliminated!

        # Case D2: Falsely tagged as hiking with raw activity type saying "walking" -> remapped to "walking"
        act_raw_walk = {
            "id": "act_raw_walk_1",
            "sport": "hiking",
            "raw_activity_type": "casual_walking",
            "duration_seconds": 3600,
            "elevation_gain_meters": 1500,
            "avg_hr": 115,
        }
        res_raw_walk = reprocess_canonical_activities([act_raw_walk])[0]
        self.assertEqual(res_raw_walk["sport"], "walking")
        self.assertLess(res_raw_walk["tss"], 30.0)

        # Case E: Genuine hike preserved if title contains hike/trail/alpine
        act_hike = {
            "id": "act_hike_1",
            "sport": "hiking",
            "title": "Mountain Trail Hike",
            "duration_seconds": 7200,
            "distance_meters": 10000,
            "elevation_gain_meters": 1000,
            "avg_hr": 140,
        }
        res_hike = reprocess_canonical_activities([act_hike])[0]
        self.assertEqual(res_hike["sport"], "hiking")
        self.assertGreater(res_hike["tss"], 50.0)

    def test_reprocess_with_raw_summary_getter(self):
        """Verify raw summary getter overrides stale sport and recomputes correctly."""
        raw_db = {
            "act_100": {
                "activityId": 100,
                "activityType": {"typeKey": "treadmill_running"},
            },
            "act_101": {
                "activityId": 101,
                "activityType": {"typeKey": "indoor_cycling"},
            },
            "act_102": {
                "activityId": 102,
                "activityType": {"typeKey": "open_water_swimming"},
            },
        }

        def dummy_getter(act_id: str):
            return raw_db.get(act_id)

        acts = [
            {"id": "act_100", "sport": "hiking", "duration_seconds": 1800, "avg_hr": 160},
            {"id": "act_101", "sport": "hiking", "duration_seconds": 3600, "avg_hr": 140, "avg_power": 200},
            {"id": "act_102", "sport": "hiking", "duration_seconds": 2400, "avg_hr": 130, "elevation_gain_meters": 500},
        ]

        reprocessed = reprocess_canonical_activities(acts, raw_summaries_getter=dummy_getter)
        self.assertEqual(reprocessed[0]["sport"], "running")
        self.assertEqual(reprocessed[1]["sport"], "cycling")
        self.assertEqual(reprocessed[2]["sport"], "swimming")
        self.assertEqual(reprocessed[2]["elevation_gain_meters"], 0)  # Swimming elevation zeroed out

    def test_extreme_and_malformed_inputs(self):
        """Stress test extreme elevation, negative duration, string numbers, corrupt splits."""
        extreme_act = {
            "id": "act_extreme",
            "sport": "running",
            "duration_seconds": "-500",  # negative string
            "distance_meters": "999999999",  # huge string
            "elevation_gain_meters": "1000000",  # stratospheric elevation
            "avg_hr": "-20",  # negative hr
            "splits": [{"split": "bad", "distance": None}],
            "telemetry_stream": "corrupt_not_a_dict",
        }
        # Should not raise exception
        result = reprocess_canonical_activities([extreme_act])
        self.assertEqual(len(result), 1)
        res = result[0]
        # negative duration converted to <= 0 -> tss must be 0.0
        self.assertEqual(res["tss"], 0.0)

    def test_ancient_timestamps_and_none_attributes(self):
        """Verify ancient timestamps (e.g. year 1970, year 2000) pass safely."""
        ancient_act = {
            "id": "ancient_1",
            "start_time": "1970-01-01T00:00:00Z",
            "sport": None,
            "duration_seconds": None,
            "distance_meters": None,
            "elevation_gain_meters": None,
            "avg_hr": None,
        }
        result = reprocess_canonical_activities([ancient_act])
        self.assertEqual(len(result), 1)
        res = result[0]
        self.assertEqual(res["sport"], "other")
        self.assertEqual(res["tss"], 0.0)
        self.assertEqual(res["elevation_gain_meters"], 0)
        self.assertEqual(res["distance_meters"], 0.0)


class TestAdversarialGenerateWellnessDataset(unittest.TestCase):
    """Stress testing generate_wellness_dataset against sparse data, leap years, and pre-sync boundaries."""

    def test_sparse_and_single_activity_unrecorded_boundaries(self):
        """
        Verify that for any date strictly prior to the earliest activity:
        - steps == 0
        - unrecorded == True
        - NEVER synthesizes randint(6400, 8900) base steps.
        """
        anchor = datetime(2026, 10, 15, 10, 0, 0, tzinfo=timezone.utc)
        # Single activity on 2026-10-10
        single_act = [{
            "id": "single_1",
            "start_time": "2026-10-10T08:00:00Z",
            "sport": "running",
            "duration_seconds": 3600,
            "distance_meters": 10000,
            "avg_hr": 150,
            "tss": 60.0,
        }]

        # Request 30 days of wellness
        wellness = generate_wellness_dataset(activities=single_act, days=30)
        history = wellness.get("daily", [])
        self.assertGreater(len(history), 0)

        earliest_act_date = "2026-10-10"
        for rec in history:
            date_str = rec["date"]
            if date_str < earliest_act_date:
                self.assertTrue(
                    rec["unrecorded"],
                    f"Day {date_str} is prior to {earliest_act_date} but unrecorded is {rec.get('unrecorded')}"
                )
                self.assertEqual(
                    rec["steps"],
                    0,
                    f"Day {date_str} is prior to {earliest_act_date} but steps = {rec.get('steps')} != 0"
                )
            elif date_str == earliest_act_date:
                self.assertFalse(rec["unrecorded"])
                # Activity day should have steps from activity (10km run = ~12500 steps) + base_steps
                self.assertGreater(rec["steps"], 10000)

    def test_no_activities_empty_list_behavior(self):
        """When activities list is empty or None, it defaults to standard mock generator timeline."""
        wellness_empty = generate_wellness_dataset(activities=[], days=14)
        history = wellness_empty.get("daily", [])
        self.assertEqual(len(history), 14)
        for rec in history:
            # When no activities are provided at all (pure synthetic mode), unrecorded is False
            self.assertFalse(rec["unrecorded"])
            self.assertGreaterEqual(rec["steps"], 6000)

    def test_leap_year_handling(self):
        """Verify timeline spanning February 29 on leap year (2024 or 2028)."""
        leap_acts = [
            {
                "id": "leap_1",
                "start_time": "2024-02-28T10:00:00Z",
                "sport": "running",
                "distance_meters": 5000,
                "duration_seconds": 1800,
            },
            {
                "id": "leap_2",
                "start_time": "2024-02-29T10:00:00Z",
                "sport": "running",
                "distance_meters": 5000,
                "duration_seconds": 1800,
            },
            {
                "id": "leap_3",
                "start_time": "2024-03-01T10:00:00Z",
                "sport": "running",
                "distance_meters": 5000,
                "duration_seconds": 1800,
            },
        ]
        # Request 10 days of wellness spanning leap day
        wellness = generate_wellness_dataset(activities=leap_acts, days=10)
        history = wellness.get("daily", [])
        dates = [r["date"] for r in history]
        self.assertIn("2024-02-29", dates)
        self.assertIn("2024-03-01", dates)

        # Dates prior to 2024-02-28 must be unrecorded and steps == 0
        for r in history:
            if r["date"] < "2024-02-28":
                self.assertTrue(r["unrecorded"])
                self.assertEqual(r["steps"], 0)
            elif r["date"] == "2024-02-29":
                self.assertFalse(r["unrecorded"])
                self.assertGreater(r["steps"], 5000)

    def test_multi_year_spanning_timeline(self):
        """Stress test with activities spanning across multiple years (e.g. 2024 to 2026)."""
        multi_year_acts = [
            {
                "id": "old_act",
                "start_time": "2024-12-31T23:00:00Z",
                "sport": "running",
                "distance_meters": 5000,
                "duration_seconds": 1800,
            },
            {
                "id": "new_act",
                "start_time": "2026-01-01T08:00:00Z",
                "sport": "running",
                "distance_meters": 10000,
                "duration_seconds": 3600,
            },
        ]
        # Request span covering the period
        wellness = generate_wellness_dataset(activities=multi_year_acts, days=400)
        history = wellness.get("daily", [])
        self.assertEqual(len(history), 400)

        # Dates prior to 2024-12-31 must be unrecorded with 0 steps
        for r in history:
            if r["date"] < "2024-12-31":
                self.assertTrue(r["unrecorded"])
                self.assertEqual(r["steps"], 0)
            elif r["date"] >= "2024-12-31":
                self.assertFalse(r["unrecorded"])
                self.assertGreater(r["steps"], 0)

    def test_corrupt_date_strings_in_activities(self):
        """Activities with garbage date strings should be ignored gracefully in date range discovery."""
        bad_date_acts = [
            {"id": "bad_1", "start_time": "NOT_A_DATE"},
            {"id": "bad_2", "start_time": ""},
            {"id": "bad_3", "start_time": None},
            {"id": "good_1", "start_time": "2026-09-01T07:00:00Z", "sport": "running", "distance_meters": 5000},
        ]
        wellness = generate_wellness_dataset(activities=bad_date_acts, days=10)
        history = wellness.get("daily", [])
        self.assertEqual(len(history), 10)
        for r in history:
            if r["date"] < "2026-09-01":
                self.assertTrue(r["unrecorded"])
                self.assertEqual(r["steps"], 0)


if __name__ == "__main__":
    unittest.main()
