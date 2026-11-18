"""
tests/test_daily_wellness_full_bundle.py

Unit & integration tests for:
- LiveGarminClient.get_activity_details expanded 6-endpoint raw capture & MagicMock/exception resilience
- LiveGarminClient.get_raw_daily_wellness_bundle across all 16 daily endpoint groups + fallbacks
- Pure normalize_daily_wellness (all existing + stress/BB/vitals/intraday keys, zero preservation,
  negative sentinel filtering, 4-elem/2-elem BB arrays, grams-to-kg conversion, 15-min downsampling)
- MockGarminClient wellness methods & SyntheticDatasetGenerator RNG isolation (seed=42)
- Strength activity hygiene (exercise_sets stays out of canonical strength dicts)
"""

from __future__ import annotations

import unittest
from unittest.mock import MagicMock

from src.ingestion.garmin_client import (
    LiveGarminClient,
    MemoryTokenStore,
    MockGarminClient,
    OAuthSessionState,
    normalize_daily_wellness,
)
from src.ingestion.mock_generator import SyntheticDatasetGenerator
from src.ingestion.sync import normalize_garmin_activity


class _FullFakePersonalGarmin:
    """Stub implementing all personal Garmin Connect endpoints used in M1."""

    def get_activity_splits(self, activity_id):
        return {"lapDTOs": [{"lapIndex": 1, "distance": 1000.0, "duration": 300.0, "averageHR": 148}]}

    def get_activity_details(self, activity_id, maxchart=2000, maxpoly=4000):
        return {
            "geoPolylineDTO": {"polyline": "_p~iF~ps|U_ulLnnqC_mqNvxq`@"},
            "metricDescriptors": [{"metricsIndex": 0, "key": "directHeartRate"}],
            "activityDetailMetrics": [{"metrics": [145]}, {"metrics": [152]}],
        }

    def get_activity_hr_in_timezones(self, activity_id):
        return [{"zoneNumber": 2, "secsInZone": 600}, {"zoneNumber": 3, "secsInZone": 300}]

    def get_activity_typed_splits(self, activity_id):
        return {"splits": [{"type": "ACTIVE", "duration": 300}]}

    def get_activity_split_summaries(self, activity_id):
        return [{"splitType": "INTERVAL_ACTIVE", "distance": 1000.0}]

    def get_activity_power_in_timezones(self, activity_id):
        return [{"zoneNumber": 2, "secsInZone": 420}]

    def get_activity_weather(self, activity_id):
        return {"temp": 14.0, "weatherTypeDTO": {"desc": "Clear"}}

    def get_activity_exercise_sets(self, activity_id):
        return {"exerciseSets": [{"weight": 80000, "repetitionCount": 8}]}

    def get_activity_gear(self, activity_id):
        return [{"gearPk": 999, "customMakeModel": "Trail Shoes"}]

    def get_user_summary(self, cdate):
        return {
            "totalSteps": 11234,
            "dailyStepGoal": 10000,
            "restingHeartRate": 47,
            "lastSevenDaysAvgRestingHeartRate": 48.2,
            "averageStressLevel": 24,
            "maxStressLevel": 76,
            "stressQualifier": "BALANCED",
            "restStressDuration": 41000,
            "lowStressDuration": 12000,
            "mediumStressDuration": 3600,
            "highStressDuration": 1000,
            "stressDuration": 57600,
            "bodyBatteryChargedValue": 62,
            "bodyBatteryDrainedValue": 48,
            "bodyBatteryHighestValue": 94,
            "bodyBatteryLowestValue": 24,
            "bodyBatteryMostRecentValue": 52,
            "bodyBatteryAtWakeTime": 91,
            "moderateIntensityMinutes": 30,
            "vigorousIntensityMinutes": 15,
            "intensityMinutesGoal": 150,
            "totalKilocalories": 2450,
            "activeKilocalories": 720,
            "bmrKilocalories": 1730,
            "minHeartRate": 43,
            "maxHeartRate": 174,
        }

    def get_sleep_data(self, cdate):
        return {
            "dailySleepDTO": {
                "sleepTimeSeconds": 28800,
                "deepSleepSeconds": 6000,
                "lightSleepSeconds": 16200,
                "remSleepSeconds": 5400,
                "awakeSleepSeconds": 1200,
                "sleepScores": {"overall": {"value": 89, "qualifierKey": "GOOD"}},
            }
        }

    def get_hrv_data(self, cdate):
        return {
            "hrvSummary": {
                "status": "BALANCED",
                "weeklyAvg": 59,
                "lastNightAvg": 63,
                "baseline": {"balancedLow": 49, "balancedUpper": 65},
            }
        }

    def get_stress_data(self, cdate):
        base = 1760918400000
        return {
            "avgStressLevel": 24,
            "maxStressLevel": 76,
            # 3-minute intervals (180_000 ms) with negative sentinel (-1, -2)
            "stressValuesArray": [
                [base + 0 * 180_000, -1],
                [base + 1 * 180_000, 18],
                [base + 2 * 180_000, 22],
                [base + 5 * 180_000, -2],
                [base + 6 * 180_000, 42],
                [base + 12 * 180_000, 68],
            ],
            "bodyBatteryValuesArray": [
                [base + 0 * 180_000, "MEASURED", 24, 3],
                [base + 2 * 180_000, "MEASURED", 35, 3],
                [base + 6 * 180_000, "MEASURED", 94, 3],
                [base + 12 * 180_000, "MEASURED", 52, 3],
            ],
        }

    def get_body_battery(self, cdate):
        return [{"date": cdate, "charged": 62, "drained": 48}]

    def get_body_battery_events(self, cdate):
        return [{"eventType": "SLEEP", "durationInSeconds": 28800}]

    def get_heart_rates(self, cdate):
        return {"restingHeartRate": 47, "minHeartRate": 43, "maxHeartRate": 174}

    def get_steps_data(self, cdate):
        return [{"steps": 500}, {"steps": 1200}]

    def get_respiration_data(self, cdate):
        return {"avgWakingRespirationValue": 14.6, "avgSleepRespirationValue": 13.1}

    def get_spo2_data(self, cdate):
        return {"averageSpO2": 97.4, "lowestSpO2": 92}

    def get_training_readiness(self, cdate):
        return [{"score": 81, "level": "HIGH"}]

    def get_training_status(self, cdate):
        return {"mostRecentVO2Max": {"generic": {"vo2MaxPreciseValue": 54.4}}}

    def get_max_metrics(self, cdate):
        return [{"generic": {"vo2MaxPreciseValue": 54.4}, "cycling": {"vo2MaxPreciseValue": 52.8}}]

    def get_body_composition(self, start_date, end_date):
        return {"totalAverage": {"weight": 72500, "bmi": 22.15, "bodyFat": 14.2, "muscleMass": 34800}}

    def get_hydration_data(self, cdate):
        return {"valueInML": 2400}

    def get_floors(self, cdate):
        return {"floorsAscended": 12, "floorsDescended": 10}

    def get_fitnessage_data(self, cdate):
        return {"fitnessAge": 27}


class _FallbackAndPartialGarmin:
    """Stub exercising fallback endpoints (get_stats, get_all_day_stress, get_weigh_ins) and partial failures."""

    def get_stats(self, cdate):
        return {"totalSteps": 5400, "restingHeartRate": 50}

    def get_sleep_data(self, cdate):
        raise RuntimeError("Sleep endpoint unavailable")

    def get_all_day_stress(self, cdate):
        return {"avgStressLevel": 31, "stressValuesArray": [[1760918400000, 31]]}

    def get_body_battery(self, start_date, end_date):
        return [{"date": start_date, "bodyBatteryValuesArray": [[1760918400000, 40], [1760919300000, 88]]}]

    def get_body_composition(self, start_date, end_date):
        return {}

    def get_weigh_ins(self, start_date, end_date):
        return {"dailyWeightSummaries": [{"latestWeight": {"weight": 71.4, "bmi": 21.8}}]}

    def get_floors(self, cdate):
        raise RuntimeError("Floors endpoint error")


class _EmptyGarmin:
    def get_user_summary(self, cdate):
        return {}

    def get_sleep_data(self, cdate):
        return None


def _make_live_client_with_personal(personal_stub) -> LiveGarminClient:
    client = LiveGarminClient(
        "athlete@example.com",
        "dummy_secret",
        session_state={"access_token": "tok", "refresh_token": "ref", "expires_at": 9999999999},
        token_store=MemoryTokenStore(),
    )
    client._personal_garmin = personal_stub
    return client


class TestDailyWellnessFullBundle(unittest.TestCase):
    def test_activity_details_captures_all_six_extra_fields_and_survives_faults(self):
        client = _make_live_client_with_personal(_FullFakePersonalGarmin())
        details = client.get_activity_details("act_9001")
        self.assertIsInstance(details, dict)
        self.assertIn("typed_splits", details)
        self.assertIn("split_summaries", details)
        self.assertIn("power_zones", details)
        self.assertIn("weather", details)
        self.assertIn("exercise_sets", details)
        self.assertIn("gear", details)
        self.assertEqual(details["weather"]["temp"], 14.0)
        self.assertEqual(details["exercise_sets"]["exerciseSets"][0]["weight"], 80000)

        # Partial failures + missing methods must not abort
        faulty = MagicMock()
        faulty.get_activity_splits.return_value = {"lapDTOs": []}
        faulty.get_activity_details.side_effect = RuntimeError("404")
        faulty.get_activity_hr_in_timezones.return_value = []
        faulty.get_activity_weather.side_effect = RuntimeError("500")
        faulty.get_activity_exercise_sets.return_value = {"exerciseSets": [{"repetitionCount": 10}]}
        # Unconfigured MagicMock methods return MagicMock instances which must NOT be attached
        client_faulty = _make_live_client_with_personal(faulty)
        res_faulty = client_faulty.get_activity_details("act_9002")
        self.assertIsInstance(res_faulty, dict)
        self.assertIn("exercise_sets", res_faulty)
        self.assertNotIn("weather", res_faulty)
        self.assertNotIn("gear", res_faulty)

    def test_get_raw_daily_wellness_bundle_all_16_groups_fallbacks_and_empty(self):
        client = _make_live_client_with_personal(_FullFakePersonalGarmin())
        bundle = client.get_raw_daily_wellness_bundle("2026-10-20")
        self.assertIsInstance(bundle, dict)
        self.assertEqual(bundle["date"], "2026-10-20")
        expected_keys = {
            "user_summary", "sleep", "hrv", "stress", "body_battery", "body_battery_events",
            "heart_rates", "steps_data", "respiration", "spo2", "training_readiness",
            "training_status", "max_metrics", "body_composition", "hydration", "floors", "fitness_age",
        }
        for key in expected_keys:
            self.assertIn(key, bundle)
            self.assertIsNotNone(bundle[key], f"Expected non-None bundle entry for {key}")

        # Fallbacks and partial errors
        fb_client = _make_live_client_with_personal(_FallbackAndPartialGarmin())
        fb_bundle = fb_client.get_raw_daily_wellness_bundle("2026-10-21")
        self.assertIsNotNone(fb_bundle)
        self.assertEqual(fb_bundle["user_summary"]["totalSteps"], 5400)
        self.assertIsNone(fb_bundle["sleep"])
        self.assertEqual(fb_bundle["stress"]["avgStressLevel"], 31)
        self.assertIsNotNone(fb_bundle["body_battery"])
        self.assertIsNotNone(fb_bundle["body_composition"])
        self.assertIsNone(fb_bundle["floors"])

        # All empty/None -> returns None
        empty_client = _make_live_client_with_personal(_EmptyGarmin())
        self.assertIsNone(empty_client.get_raw_daily_wellness_bundle("2026-10-22"))
        self.assertIsNone(empty_client.get_daily_wellness("2026-10-22"))

    def test_normalize_daily_wellness_pure_extraction_and_edge_cases(self):
        client = _make_live_client_with_personal(_FullFakePersonalGarmin())
        bundle = client.get_raw_daily_wellness_bundle("2026-10-20")
        norm = normalize_daily_wellness("2026-10-20", bundle)

        self.assertEqual(norm["date"], "2026-10-20")
        self.assertEqual(norm["steps"], 11234)
        self.assertEqual(norm["resting_hr"], 47)
        self.assertEqual(norm["sleep_seconds"], 28800)
        self.assertEqual(norm["sleep_score"], 89)
        self.assertEqual(norm["stress_level"], 24)
        self.assertEqual(norm["stress_max"], 76)
        self.assertEqual(norm["stress_rest_seconds"], 41000)
        self.assertEqual(norm["stress_low_seconds"], 12000)
        self.assertEqual(norm["stress_medium_seconds"], 3600)
        self.assertEqual(norm["stress_high_seconds"], 1000)
        self.assertEqual(norm["stress_total_seconds"], 57600)
        self.assertEqual(norm["body_battery"], 52)
        self.assertEqual(norm["body_battery_high"], 94)
        self.assertEqual(norm["body_battery_low"], 24)
        self.assertEqual(norm["body_battery_at_wake"], 91)
        self.assertEqual(norm["spo2_avg"], 97.4)
        self.assertEqual(norm["spo2_low"], 92)
        self.assertEqual(norm["respiration_waking"], 14.6)
        self.assertEqual(norm["respiration_sleep"], 13.1)
        self.assertEqual(norm["floors_ascended"], 12)
        self.assertEqual(norm["floors_descended"], 10)
        self.assertEqual(norm["min_hr"], 43)
        self.assertEqual(norm["max_hr"], 174)
        self.assertEqual(norm["weight_kg"], 72.5)
        self.assertEqual(norm["bmi"], 22.15)
        self.assertEqual(norm["body_fat_pct"], 14.2)
        self.assertEqual(norm["muscle_mass_kg"], 34.8)
        self.assertEqual(norm["hydration_ml"], 2400)
        self.assertEqual(norm["training_readiness_score"], 81)
        self.assertEqual(norm["vo2max_running"], 54.4)
        self.assertEqual(norm["vo2max_cycling"], 52.8)

        # Negative sentinels (-1, -2) filtered out and downsampled at >= 900_000 ms
        intraday_st = norm["intraday_stress"]
        self.assertTrue(all(pt[1] >= 0 for pt in intraday_st))
        self.assertEqual([pt[1] for pt in intraday_st], [18, 42, 68])
        for i in range(1, len(intraday_st)):
            self.assertGreaterEqual(intraday_st[i][0] - intraday_st[i - 1][0], 900_000)

        intraday_bb = norm["intraday_body_battery"]
        self.assertEqual([pt[1] for pt in intraday_bb], [24, 94, 52])
        for i in range(1, len(intraday_bb)):
            self.assertGreaterEqual(intraday_bb[i][0] - intraday_bb[i - 1][0], 900_000)

    def test_zero_preservation_and_bb_array_fallbacks(self):
        base = 1760918400000
        raw_zero = {
            "user_summary": {
                "totalSteps": 0,
                "averageStressLevel": 0,
                "maxStressLevel": 0,
                "restStressDuration": 0,
                "lowStressDuration": 0,
                "mediumStressDuration": 0,
                "highStressDuration": 0,
                "stressDuration": 0,
                "moderateIntensityMinutes": 0,
                "vigorousIntensityMinutes": 0,
                "totalKilocalories": 0,
                "activeKilocalories": 0,
                "bmrKilocalories": 0,
            },
            "sleep": {
                "dailySleepDTO": {
                    "sleepTimeSeconds": 0,
                    "deepSleepSeconds": 0,
                    "lightSleepSeconds": 0,
                    "remSleepSeconds": 0,
                    "awakeSleepSeconds": 0,
                    "sleepScores": {"overall": {"value": 0}},
                }
            },
            "stress": {
                "stressValuesArray": [[base, -1], [base + 900_000, 0]],
            },
            "body_battery": [
                {
                    "date": "2026-10-20",
                    # 2-element format without user_summary BB highs/lows
                    "bodyBatteryValuesArray": [
                        [base, 19],
                        [base + 900_000, 87],
                        [base + 1_800_000, 55],
                    ],
                }
            ],
            "body_composition": {"totalAverage": {"weight": 68.4, "muscleMass": 31.2}},
            "hydration": {"valueInML": 0},
            "training_readiness": {"score": 0},
            "floors": {"floorsAscended": 0, "floorsDescended": 0},
        }
        norm = normalize_daily_wellness("2026-10-20", raw_zero)
        self.assertEqual(norm["steps"], 0)
        self.assertEqual(norm["stress_level"], 0)
        self.assertEqual(norm["stress_max"], 0)
        self.assertEqual(norm["stress_rest_seconds"], 0)
        self.assertEqual(norm["stress_total_seconds"], 0)
        self.assertEqual(norm["sleep_seconds"], 0)
        self.assertEqual(norm["sleep_score"], 0)
        self.assertEqual(norm["sleep_deep_seconds"], 0)
        self.assertEqual(norm["active_intensity_minutes"], 0)
        self.assertEqual(norm["daily_calories"], 0)
        self.assertEqual(norm["hydration_ml"], 0)
        self.assertEqual(norm["training_readiness_score"], 0)
        self.assertEqual(norm["floors_ascended"], 0)
        self.assertEqual(norm["floors_descended"], 0)
        # Derived from 2-element bodyBatteryValuesArray
        self.assertEqual(norm["body_battery_low"], 19)
        self.assertEqual(norm["body_battery_high"], 87)
        self.assertEqual(norm["body_battery"], 55)
        # Weight already in kg (<= 500) must not be divided by 1000
        self.assertEqual(norm["weight_kg"], 68.4)
        self.assertEqual(norm["muscle_mass_kg"], 31.2)

    def test_strength_activity_never_leaks_exercise_sets_or_weight_keys(self):
        payload = {
            "summary": {
                "activityId": "str_777",
                "activityName": "Heavy Squats",
                "activityType": {"typeKey": "strength_training"},
                "startTimeGMT": "2026-10-20T09:00:00Z",
                "duration": 2700,
                "averageHR": 124,
            },
            "details": {
                "splits": [],
                "exercise_sets": {"exerciseSets": [{"weight": 100000, "repetitionCount": 5}]},
                "geoPolylineDTO": {"polyline": "_p~iF~ps|U_ulLnnqC"},
            },
        }
        norm = normalize_garmin_activity(payload)
        self.assertEqual(norm["sport"], "strength")
        self.assertIsNone(norm["gps_track"])
        self.assertIsNone(norm["telemetry_stream"])
        self.assertIsNone(norm["summary_polyline"])
        self.assertFalse(norm["has_streams"])
        for forbidden in ("weight", "kg", "load_kg", "tonnage", "weight_kg", "exercise_sets"):
            self.assertNotIn(forbidden, norm)

    def test_mock_client_and_generator_wellness_enrichment_preserves_seed_42_determinism(self):
        gen_baseline = SyntheticDatasetGenerator(seed=42)
        acts_before = gen_baseline.generate_activities()
        self.assertEqual(len(acts_before), 49)

        mock_client = MockGarminClient(seed=42)
        raw_bundle = mock_client.get_raw_daily_wellness_bundle("2026-10-20")
        self.assertIsInstance(raw_bundle, dict)
        norm_day = mock_client.get_daily_wellness("2026-10-20")
        self.assertIsInstance(norm_day, dict)
        self.assertIn("stress_max", norm_day)
        self.assertIn("body_battery_at_wake", norm_day)
        self.assertGreater(len(norm_day["intraday_body_battery"]), 10)
        self.assertGreater(len(norm_day["intraday_stress"]), 10)

        wellness = gen_baseline.generate_wellness(activities=acts_before, days=56)
        daily = wellness["daily"]
        self.assertEqual(len(daily), 56)
        for idx, rec in enumerate(daily):
            self.assertIn("stress_max", rec)
            self.assertIn("stress_rest_seconds", rec)
            self.assertIn("stress_low_seconds", rec)
            self.assertIn("stress_medium_seconds", rec)
            self.assertIn("stress_high_seconds", rec)
            self.assertIn("stress_total_seconds", rec)
            self.assertIn("body_battery_at_wake", rec)
            self.assertEqual(
                rec["stress_rest_seconds"]
                + rec["stress_low_seconds"]
                + rec["stress_medium_seconds"]
                + rec["stress_high_seconds"],
                rec["stress_total_seconds"],
            )
            if idx >= len(daily) - 14:
                self.assertIn("intraday_body_battery", rec)
                self.assertIn("intraday_stress", rec)
                self.assertEqual(len(rec["intraday_body_battery"]), 96)
                self.assertEqual(len(rec["intraday_stress"]), 96)
            else:
                self.assertNotIn("intraday_body_battery", rec)
                self.assertNotIn("intraday_stress", rec)

        self.assertIn("intraday_body_battery", wellness["current"])
        self.assertIn("stress_max", wellness["current"])

        # Re-generating activities after wellness still produces exact same 49 activities
        acts_after = SyntheticDatasetGenerator(seed=42).generate_activities()
        self.assertEqual(len(acts_after), 49)
        for a1, a2 in zip(acts_before, acts_after):
            self.assertEqual(a1["id"], a2["id"])
            self.assertEqual(a1["sport"], a2["sport"])
            self.assertEqual(a1["distance_meters"], a2["distance_meters"])
            self.assertEqual(a1["tss"], a2["tss"])


if __name__ == "__main__":
    unittest.main()
