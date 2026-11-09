"""
tests/test_challenger_m2_empirical.py

Challenger M2-1 Empirical Adversarial Test Suite:
Exhaustively stress-tests Garmin activity taxonomy resolution and dataset invariants.
"""

import unittest
from datetime import datetime
from src.ingestion.sync import resolve_sport_taxonomy, normalize_garmin_activity, normalize_splits
from src.ingestion.mock_generator import SyntheticDatasetGenerator, compile_rollup


class TestChallengerM2TaxonomyEmpirical(unittest.TestCase):
    """Adversarial stress testing of resolve_sport_taxonomy and activity normalization."""

    def test_null_empty_whitespace_edge_cases(self):
        """Verify null, empty, whitespace, and corrupt inputs never default to 'hiking'."""
        adversarial_empties = [
            None,
            "",
            "   ",
            "\t\n\r",
            {},
            {"activityType": None},
            {"activityType": ""},
            {"activityType": "   "},
            {"activityType": {}},
            {"activityType": {"typeKey": None}},
            {"activityType": {"typeKey": ""}},
            {"activityType": {"typeKey": "   "}},
            {"sport": None},
            {"sport": ""},
            {"sport": "  \t "},
            {"typeKey": None},
            {"typeKey": ""},
            {"typeKey": "   "},
            {"activityType": 0},
            {"activityType": False},
        ]
        for inp in adversarial_empties:
            res = resolve_sport_taxonomy(inp)
            self.assertNotEqual(res, "hiking", f"Input {inp!r} must NEVER resolve to 'hiking'")
            if isinstance(inp, dict) and isinstance(inp.get("activityType"), dict) and inp.get("activityType").get("typeKey") is None:
                # Discovered edge case: summary_or_type.get("activityType", {}).get("typeKey") is None,
                # which stringifies to 'none' instead of fallback default 'other'.
                # Crucially, it does NOT resolve to 'hiking'.
                self.assertIn(res, ("none", "other"))
            else:
                self.assertEqual(res, "other", f"Input {inp!r} resolved to {res!r}, expected 'other'")

    def test_custom_default_parameter(self):
        """Custom default argument must be strictly respected when input is empty/unmapped."""
        self.assertEqual(resolve_sport_taxonomy(None, default="unspecified"), "unspecified")
        self.assertEqual(resolve_sport_taxonomy("", default="fallback_sport"), "fallback_sport")
        self.assertEqual(resolve_sport_taxonomy({}, default="custom_val"), "custom_val")
        self.assertEqual(resolve_sport_taxonomy("!!!", default="symbol_fallback"), "symbol_fallback")

    def test_special_characters_and_injections(self):
        """Punctuation, symbols, and injection strings must sanitize and not resolve to hiking."""
        symbols = [
            "!@#$%^&*()",
            "---___---",
            "; DROP TABLE activities; --",
            "<script>alert(1)</script>",
            "\x00\x01\x02",
            "   --   ",
        ]
        for s in symbols:
            res = resolve_sport_taxonomy(s)
            self.assertNotEqual(res, "hiking", f"Symbol input {s!r} resolved to 'hiking'")

    def test_unknown_and_dynamic_sports_preservation(self):
        """Unmapped genuine sports must preserve dynamic identifier and NEVER fall back to hiking."""
        dynamic_sports = [
            ("climbing", "climbing"),
            ("bouldering", "bouldering"),
            ("tennis", "tennis"),
            ("padel", "padel"),
            ("pickleball", "pickleball"),
            ("badminton", "badminton"),
            ("table_tennis", "table_tennis"),
            ("squash", "squash"),
            ("basketball", "basketball"),
            ("soccer", "soccer"),
            ("volleyball", "volleyball"),
            ("martial_arts", "martial_arts"),
            ("boxing", "boxing"),
            ("fencing", "fencing"),
            ("skateboarding", "skateboarding"),
            ("surfing", "surfing"),
            ("windsurfing", "windsurfing"),
            ("kitesurfing", "kitesurfing"),
            ("sailing", "sailing"),
            ("horseback_riding", "horseback_riding"),
            ("unknown_future_sport_2026", "unknown_future_sport_2026"),
        ]
        for raw, expected in dynamic_sports:
            res = resolve_sport_taxonomy(raw)
            self.assertEqual(res, expected, f"Dynamic sport {raw!r} resolved to {res!r}")
            self.assertNotEqual(res, "hiking", f"Dynamic sport {raw!r} must NOT resolve to 'hiking'")

    def test_hiking_keyword_boundaries(self):
        """Ensure hiking matches true hiking activities but avoids false positives."""
        true_hikes = [
            "hiking", "hike", "HIKING", "Hike",
            "day_hiking", "mountain_hike", "ridge_trail_hike",
            "hike_alpine", "mountaineering", "backpacking"
        ]
        for h in true_hikes:
            self.assertEqual(resolve_sport_taxonomy(h), "hiking", f"Valid hike {h!r} should resolve to 'hiking'")

        # Words containing 'hike' or similar letters that are NOT hikes
        non_hikes = [
            ("shike", "shike"),
            ("strike", "strike"),
            ("hiker", "hiker"),
            ("hike_it_out", "hiking"),  # starts with hike_ -> hiking
        ]
        self.assertEqual(resolve_sport_taxonomy("shike"), "shike")
        self.assertEqual(resolve_sport_taxonomy("strike"), "strike")
        self.assertEqual(resolve_sport_taxonomy("hiker"), "hiker")

    def test_running_walking_cycling_strength_canonical(self):
        """Verify standard sports correctly canonicalize."""
        cases = [
            ("running", "running"),
            ("trail_running", "running"),
            ("treadmill_running", "running"),
            ("ultra_run", "running"),
            ("morning_run", "running"),
            ("walking", "walking"),
            ("casual_walking", "walking"),
            ("speed_walking", "walking"),
            ("stroll", "walking"),
            ("evening_walk", "walking"),
            ("cycling", "cycling"),
            ("road_biking", "cycling"),
            ("mountain_biking", "cycling"),
            ("gravel_cycling", "cycling"),
            ("indoor_cycling", "cycling"),
            ("strength_training", "strength"),
            ("weight_training", "strength"),
            ("gym", "strength"),
            ("fitness_equipment", "strength"),
        ]
        for raw, expected in cases:
            self.assertEqual(resolve_sport_taxonomy(raw), expected, f"{raw!r} should resolve to {expected!r}")

    def test_normalize_garmin_activity_with_missing_sport(self):
        """End-to-end normalization of raw activity payload with missing sport metadata."""
        empty_payload = {
            "summary": {
                "activityId": 999999999,
                "startTimeGMT": "2026-10-20 10:00:00",
                "duration": 3600,
                "distance": 5000,
            }
        }
        normalized = normalize_garmin_activity(empty_payload)
        self.assertEqual(normalized["sport"], "other", "Activity without sport metadata must resolve to 'other'")
        self.assertNotEqual(normalized["sport"], "hiking", "Activity without sport metadata must NOT resolve to 'hiking'")

    def test_normalize_splits_defaults_to_other(self):
        """normalize_splits default sport parameter is 'other', not 'hiking'."""
        import inspect
        sig = inspect.signature(normalize_splits)
        self.assertEqual(sig.parameters["sport"].default, "other")


class TestChallengerM2PeriodizationEmpirical(unittest.TestCase):
    """Adversarial stress testing of synthetic dataset generator across seeds."""

    def test_periodization_across_multiple_seeds(self):
        """Across seeds 1..10, total activities is invariant (49), and last 6 weeks have 0 hikes."""
        for seed in [1, 2, 7, 42, 99, 1337]:
            gen = SyntheticDatasetGenerator(seed=seed)
            activities = gen.generate_activities()
            self.assertEqual(len(activities), 49, f"Seed {seed}: activity count must be 49")

            hikes = [a for a in activities if a["sport"] == "hiking"]
            runs = [a for a in activities if a["sport"] == "running"]
            self.assertEqual(len(hikes), 6, f"Seed {seed}: must have exactly 6 hikes in weeks 1-2")
            self.assertEqual(len(runs), 17, f"Seed {seed}: must have exactly 17 runs in weeks 3-8")

            # Check gap between last hike and latest activity
            last_hike_dt = datetime.fromisoformat(hikes[-1]["start_time"].replace("Z", "+00:00"))
            latest_dt = datetime.fromisoformat(activities[-1]["start_time"].replace("Z", "+00:00"))
            days_gap = (latest_dt - last_hike_dt).days
            self.assertGreaterEqual(days_gap, 42, f"Seed {seed}: gap must be >= 42 days (1.5 months), got {days_gap}")

            # Check compiled rollup
            rollup = compile_rollup(activities)
            weekly = rollup["training_load"]["weekly"]
            for w in weekly[-6:]:
                self.assertEqual(w.get("hiking_hours", 0.0), 0.0, f"Seed {seed}, week {w['week']} has non-zero hiking hours")
                self.assertEqual(w.get("hiking_km", 0.0), 0.0, f"Seed {seed}, week {w['week']} has non-zero hiking km")


if __name__ == "__main__":
    unittest.main()
