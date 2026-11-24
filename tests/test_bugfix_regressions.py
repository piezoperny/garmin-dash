import tempfile
import unittest
from pathlib import Path

from src.ingestion.garmin_client import normalize_daily_wellness
from src.ingestion.mock_generator import compile_rollup
from src.ingestion.sync import build_current_wellness_snapshot, resolve_sport_taxonomy
from src.storage.parquet_vault import ParquetVault


class TestBugfixRegressions(unittest.TestCase):
    def test_hrv_103_preserved_and_missing_stays_none(self):
        rec = normalize_daily_wellness("2026-11-22", {
            "hrv": {
                "hrvSummary": {
                    "lastNightAvg": 103,
                    "weeklyAvg": 96,
                    "status": "BALANCED",
                    "baseline": {"balancedLow": 75, "balancedUpper": 110},
                }
            }
        })
        self.assertEqual(rec["hrv_last_night_avg"], 103)
        self.assertEqual(rec["hrv_ms"], 103)
        self.assertEqual(rec["hrv_weekly_avg"], 96)
        self.assertEqual(rec["hrv_baseline"], {"low": 75, "high": 110})

        empty_rec = normalize_daily_wellness("2026-11-23", {})
        self.assertIsNone(empty_rec["hrv_last_night_avg"])
        self.assertIsNone(empty_rec["body_battery_high"])
        self.assertIsNone(empty_rec["body_battery_low"])

    def test_parquet_wellness_stores_hrv_ms_and_bb_columns(self):
        with tempfile.TemporaryDirectory() as tmp:
            vault = ParquetVault(work_dir=Path(tmp))
            vault.save_wellness([
                {
                    "date": "2026-11-22",
                    "hrv_last_night_avg": 103,
                    "body_battery_high": 88,
                    "body_battery_low": 24,
                }
            ], push_remote=False)
            con = vault._connect()
            try:
                row = con.execute(
                    f"SELECT hrv_ms, body_battery_max, body_battery_min FROM read_parquet('{vault.local_wellness_path}')"
                ).fetchone()
            finally:
                con.close()
            self.assertEqual(row, (103.0, 88.0, 24.0))

    def test_sport_taxonomy_filters_unknownenumvalue_and_road(self):
        self.assertEqual(resolve_sport_taxonomy("UnknownEnumValue_85"), "other")
        self.assertEqual(resolve_sport_taxonomy("unknownenumvalue_85"), "other")
        self.assertEqual(resolve_sport_taxonomy("road"), "cycling")
        self.assertEqual(resolve_sport_taxonomy("bouldering"), "bouldering")

    def test_compile_rollup_uses_real_threshold_trends_when_wellness_present(self):
        acts = [
            {
                "id": "1",
                "date": "2026-11-20T08:00:00Z",
                "start_time": "2026-11-20T08:00:00Z",
                "sport": "hiking",
                "title": "Hike",
                "distance_meters": 5000,
                "duration_seconds": 3600,
                "moving_time_seconds": 3500,
                "avg_hr": 135,
            }
        ]
        wellness = {
            "current": {"date": "2026-11-22", "vo2max_running": 56.4},
            "daily": [
                {"date": "2026-11-20", "vo2max_running": 55.8},
                {"date": "2026-11-21"},
                {"date": "2026-11-22", "vo2max_running": 56.4},
            ],
        }
        rollup = compile_rollup(acts, wellness=wellness)
        trends = rollup["physiological"]["threshold_trends"]
        self.assertEqual(len(trends), 2)
        self.assertEqual(trends[0]["date"], "2026-11-20")
        self.assertEqual(trends[0]["vo2max"], 55.8)
        self.assertIsNone(trends[0]["cycling_ftp"])
        self.assertNotEqual(trends[0]["date"], "2025-11-01")

    def test_build_current_wellness_snapshot_backfills_only_current(self):
        daily = [
            {"date": "2026-11-22", "hrv_last_night_avg": 103, "hrv_weekly_avg": 96},
            {"date": "2026-11-23", "hrv_last_night_avg": None, "steps": 4200},
        ]
        snap = build_current_wellness_snapshot(daily)
        self.assertEqual(snap["hrv_last_night_avg"], 103)
        self.assertEqual(snap["steps"], 4200)
        self.assertIsNone(daily[1]["hrv_last_night_avg"])


if __name__ == "__main__":
    unittest.main()
