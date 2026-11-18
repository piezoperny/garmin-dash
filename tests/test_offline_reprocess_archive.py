"""
tests/test_offline_reprocess_archive.py

Unit & integration tests for:
- Offline `run_sync_pipeline(reprocess_archive=True)` walking archived `*_summary.json`
  and `raw_wellness_{YYYY}.json` without Garmin credentials or LiveGarminClient
- `summary_polyline` & accurate `has_streams` across `sync.py`, `mock_generator.py`, and `import_garmindb.py`
- Strength activity hygiene (no GPS/streams, no forbidden weight/exercise_sets keys)
- Stale local shard cleanup during `reprocess_archive`
- 14-day intraday retention (`apply_wellness_intraday_retention`)
- Live sync raw wellness persistence and raw backfill when `cdate` is missing from `raw_wellness_{YYYY}.json`
- `_safe_listdir` resilience on missing dirs / IOError
- `import_garmindb.py` SQLite round-trip and 4-digit `activities_by_year` manifest accounting
"""

from __future__ import annotations

import json
import os
import sqlite3
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

from src.ingestion.import_garmindb import extract_garmindb_activities, run_garmindb_import
from src.ingestion.mock_generator import compile_rollup
from src.ingestion.sftp_client import MockSFTPClient
from src.ingestion.sync import (
    REMOTE_INDEX_PATH,
    REMOTE_MANIFEST_PATH,
    REMOTE_RAW_WELLNESS_DIR,
    REMOTE_STREAMS_DIR,
    REMOTE_WELLNESS_PATH,
    IngestionCoordinator,
    apply_wellness_intraday_retention,
    run_sync_pipeline,
)


def _sample_outdoor_summary_payload(act_id: str = "1001") -> dict:
    return {
        "summary": {
            "activityId": act_id,
            "activityName": "Alpine Ridge Run",
            "activityType": {"typeKey": "trail_running"},
            "startTimeGMT": "2025-08-15T07:30:00Z",
            "duration": 3600,
            "movingDuration": 3500,
            "distance": 12400.0,
            "averageHR": 152,
            "maxHR": 178,
            "elevationGain": 420,
            "calories": 820,
        },
        "details": {
            "splits": [
                {"lapIndex": 1, "distance": 1000.0, "duration": 290.0, "averageHR": 148},
                {"lapIndex": 2, "distance": 1000.0, "duration": 295.0, "averageHR": 154},
            ],
            "geoPolylineDTO": {
                "polyline": "_p~iF~ps|U_ulLnnqC_mqNvxq`@",
            },
            "metricDescriptors": [
                {"metricsIndex": 0, "key": "directTimestamp"},
                {"metricsIndex": 1, "key": "directHeartRate"},
                {"metricsIndex": 2, "key": "directElevation"},
            ],
            "activityDetailMetrics": [
                {"metrics": [1755243000000, 145, 1100.0]},
                {"metrics": [1755244800000, 155, 1320.0]},
                {"metrics": [1755246600000, 162, 1520.0]},
            ],
            "hr_zones": {"Z1": 300, "Z2": 1200, "Z3": 1500, "Z4": 500, "Z5": 100},
        },
    }


def _sample_strength_summary_payload(act_id: str = "1002") -> dict:
    return {
        "summary": {
            "activityId": act_id,
            "activityName": "Barbell Strength",
            "activityType": {"typeKey": "strength_training"},
            "startTimeGMT": "2025-08-16T17:00:00Z",
            "duration": 2700,
            "movingDuration": 2700,
            "distance": 500.0,
            "averageHR": 126,
            "maxHR": 154,
            "calories": 380,
            "weight_kg": 90.0,
        },
        "details": {
            "splits": [],
            "exercise_sets": {"exerciseSets": [{"weight": 90000, "repetitionCount": 5}]},
            "geoPolylineDTO": {"polyline": "_p~iF~ps|U_ulLnnqC"},
        },
    }


def _sample_raw_wellness_bundle(cdate: str, steps: int = 9500) -> dict:
    dt = datetime.strptime(cdate, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    base_ms = int(dt.timestamp()) * 1000
    return {
        "date": cdate,
        "user_summary": {
            "totalSteps": steps,
            "dailyStepGoal": 10000,
            "restingHeartRate": 48,
            "averageStressLevel": 25,
            "maxStressLevel": 72,
            "restStressDuration": 40000,
            "lowStressDuration": 12000,
            "mediumStressDuration": 4000,
            "highStressDuration": 1600,
            "stressDuration": 57600,
            "bodyBatteryHighestValue": 92,
            "bodyBatteryLowestValue": 26,
            "bodyBatteryMostRecentValue": 54,
            "bodyBatteryAtWakeTime": 90,
            "moderateIntensityMinutes": 20,
            "vigorousIntensityMinutes": 10,
            "totalKilocalories": 2300,
            "activeKilocalories": 570,
            "bmrKilocalories": 1730,
        },
        "sleep": {
            "dailySleepDTO": {
                "sleepTimeSeconds": 27600,
                "deepSleepSeconds": 5800,
                "lightSleepSeconds": 15600,
                "remSleepSeconds": 5000,
                "awakeSleepSeconds": 1200,
                "sleepScores": {"overall": {"value": 86, "qualifierKey": "GOOD"}},
            }
        },
        "hrv": {
            "hrvSummary": {
                "status": "BALANCED",
                "weeklyAvg": 57,
                "lastNightAvg": 61,
                "baseline": {"balancedLow": 48, "balancedUpper": 64},
            }
        },
        "stress": {
            "avgStressLevel": 25,
            "maxStressLevel": 72,
            "stressValuesArray": [
                [base_ms, 18],
                [base_ms + 900_000, 32],
                [base_ms + 1_800_000, 58],
            ],
            "bodyBatteryValuesArray": [
                [base_ms, "MEASURED", 26, 3],
                [base_ms + 900_000, "MEASURED", 90, 3],
                [base_ms + 1_800_000, "MEASURED", 54, 3],
            ],
        },
        "spo2": {"averageSpO2": 97.2, "lowestSpO2": 93},
        "respiration": {"avgWakingRespirationValue": 14.4, "avgSleepRespirationValue": 13.0},
        "floors": {"floorsAscended": 9, "floorsDescended": 8},
        "hydration": {"valueInML": 2100},
        "training_readiness": [{"score": 79}],
        "max_metrics": [{"generic": {"vo2MaxPreciseValue": 53.6}}],
        "body_composition": {"totalAverage": {"weight": 72000, "bmi": 22.0}},
    }


class TestOfflineReprocessArchive(unittest.TestCase):
    def test_offline_reprocess_archive_walks_summaries_and_raw_wellness_without_garmin_creds(self):
        mock_sftp = MockSFTPClient()
        # Seed archived raw activity payloads
        mock_sftp.write_text_atomic(
            "garmin_archive/activities/2025/08/1001_summary.json",
            json.dumps(_sample_outdoor_summary_payload("1001")),
        )
        mock_sftp.write_text_atomic(
            "garmin_archive/activities/2025/08/1002_summary.json",
            json.dumps(_sample_strength_summary_payload("1002")),
        )
        # Seed raw wellness spanning > 14 days to test 14-day intraday retention
        raw_2025 = {
            "2025-08-01": _sample_raw_wellness_bundle("2025-08-01", steps=7100),
            "2025-08-20": _sample_raw_wellness_bundle("2025-08-20", steps=10800),
        }
        mock_sftp.write_text_atomic(
            f"{REMOTE_RAW_WELLNESS_DIR}/raw_wellness_2025.json",
            json.dumps(raw_2025),
        )

        with tempfile.TemporaryDirectory() as tmpdir:
            tmp_path = Path(tmpdir)
            staging_dir = tmp_path / ".raw_staging"
            output_rollup = tmp_path / ".staging" / "dashboard_rollup.json"
            # Plant stale shard to confirm clean purge during reprocess_archive
            stale_dir = output_rollup.parent / "streams"
            stale_dir.mkdir(parents=True, exist_ok=True)
            (stale_dir / "stale_999.json").write_text('{"id":"stale_999"}', encoding="utf-8")

            clean_env = {
                k: v for k, v in os.environ.items()
                if not k.startswith("GARMIN_")
            }
            with patch.dict(os.environ, clean_env, clear=True):
                with patch("src.ingestion.sync.LiveGarminClient") as live_cls:
                    rc = run_sync_pipeline(
                        mock_mode=False,
                        reprocess_archive=True,
                        staging_dir=staging_dir,
                        output_rollup=output_rollup,
                        sftp_client=mock_sftp,
                    )
                    self.assertEqual(rc, 0)
                    live_cls.assert_not_called()

            # Stale shard must be gone
            self.assertFalse((stale_dir / "stale_999.json").exists())

            # Check outdoor shard 1001.json
            shard_1001 = json.loads((stale_dir / "1001.json").read_text(encoding="utf-8"))
            self.assertIsNotNone(shard_1001["gps_track"])
            self.assertIsNotNone(shard_1001["telemetry_stream"])

            # Check remote index and compiled rollup
            index_acts = json.loads(mock_sftp.read_text(REMOTE_INDEX_PATH))
            rollup_dict = json.loads(output_rollup.read_text(encoding="utf-8"))
            rollup_acts = rollup_dict["activities"]

            for container_name, acts in [("REMOTE_INDEX_PATH", index_acts), ("dashboard_rollup", rollup_acts)]:
                by_id = {str(a["id"]): a for a in acts}
                self.assertIn("1001", by_id, container_name)
                self.assertIn("1002", by_id, container_name)

                a1 = by_id["1001"]
                self.assertEqual(a1["sport"], "running")
                self.assertTrue(bool(a1.get("summary_polyline")), f"{container_name} 1001 missing summary_polyline")
                self.assertIs(a1.get("has_streams"), True, container_name)
                self.assertIsNone(a1.get("gps_track"), container_name)
                self.assertIsNone(a1.get("telemetry_stream"), container_name)

                a2 = by_id["1002"]
                self.assertEqual(a2["sport"], "strength")
                self.assertIsNone(a2.get("summary_polyline"), container_name)
                self.assertIs(a2.get("has_streams"), False, container_name)
                self.assertIsNone(a2.get("gps_track"), container_name)
                self.assertIsNone(a2.get("telemetry_stream"), container_name)
                for forbidden in ("weight", "kg", "load_kg", "tonnage", "weight_kg", "exercise_sets"):
                    self.assertNotIn(forbidden, a2, f"{container_name} strength leaked {forbidden}")

            # Check streams bundle persisted remotely
            streams_2025 = json.loads(mock_sftp.read_text(f"{REMOTE_STREAMS_DIR}/streams_2025.json"))
            self.assertIn("1001", streams_2025)
            self.assertIsNotNone(streams_2025["1001"]["gps_track"])

            # Check wellness re-normalized + 14-day intraday retention
            wellness_remote = json.loads(mock_sftp.read_text(REMOTE_WELLNESS_PATH))
            w_by_date = {w["date"]: w for w in wellness_remote}
            self.assertEqual(w_by_date["2025-08-01"]["steps"], 7100)
            self.assertEqual(w_by_date["2025-08-20"]["steps"], 10800)
            self.assertEqual(w_by_date["2025-08-01"]["spo2_avg"], 97.2)
            self.assertEqual(w_by_date["2025-08-01"]["stress_max"], 72)
            # 2025-08-01 is 19 days before 2025-08-20 (> 14d cutoff) -> intraday stripped
            self.assertNotIn("intraday_body_battery", w_by_date["2025-08-01"])
            self.assertNotIn("intraday_stress", w_by_date["2025-08-01"])
            # 2025-08-20 is within 14d -> intraday kept
            self.assertIn("intraday_body_battery", w_by_date["2025-08-20"])
            self.assertIn("intraday_stress", w_by_date["2025-08-20"])
            # Rollup wellness matches
            self.assertEqual(rollup_dict["wellness"]["current"]["date"], "2025-08-20")
            self.assertEqual(len(rollup_dict["wellness"]["daily"]), 2)

            # Check manifest recorded both activities
            manifest_data = json.loads(mock_sftp.read_text(REMOTE_MANIFEST_PATH))
            self.assertEqual(manifest_data["total_synced_activities"], 2)
            self.assertEqual(manifest_data["activities_by_year"].get("2025"), 2)

    def test_reprocess_archive_handles_missing_dirs_and_listdir_ioerror(self):
        class _FailingListdirMockSFTP(MockSFTPClient):
            def listdir(self, remote_path: str):
                raise IOError(f"Simulated missing dir: {remote_path}")

        mock_sftp = _FailingListdirMockSFTP()
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp_path = Path(tmpdir)
            coord = IngestionCoordinator(
                sftp_client=mock_sftp,
                staging_dir=tmp_path / ".raw_staging",
                output_rollup=tmp_path / ".staging" / "dashboard_rollup.json",
            )
            rc = coord.run_sync(mock_mode=False, reprocess_archive=True)
            self.assertEqual(rc, 0)
            rollup = json.loads((tmp_path / ".staging" / "dashboard_rollup.json").read_text(encoding="utf-8"))
            self.assertEqual(rollup["activities"], [])

    def test_apply_wellness_intraday_retention_boundary(self):
        records = [
            {"date": "2026-10-05", "steps": 5000, "intraday_body_battery": [[1, 50]], "intraday_stress": [[1, 20]]},
            {"date": "2026-10-06", "steps": 6000, "intraday_body_battery": [[2, 55]], "intraday_stress": [[2, 22]]},
            {"date": "2026-10-07", "steps": 7000, "intraday_body_battery": [[3, 60]], "intraday_stress": [[3, 25]]},
            {"date": "2026-10-20", "steps": 9000, "intraday_body_battery": [[4, 80]], "intraday_stress": [[4, 18]]},
        ]
        retained = apply_wellness_intraday_retention(records, retention_days=14)
        by_d = {r["date"]: r for r in retained}
        # cutoff = 2026-10-20 - 14d = 2026-10-06 (strictly > cutoff keeps intraday)
        self.assertNotIn("intraday_body_battery", by_d["2026-10-05"])
        self.assertNotIn("intraday_stress", by_d["2026-10-05"])
        self.assertNotIn("intraday_body_battery", by_d["2026-10-06"])
        self.assertNotIn("intraday_stress", by_d["2026-10-06"])
        self.assertIn("intraday_body_battery", by_d["2026-10-07"])
        self.assertIn("intraday_stress", by_d["2026-10-07"])
        self.assertIn("intraday_body_battery", by_d["2026-10-20"])
        self.assertIn("intraday_stress", by_d["2026-10-20"])
        # Original input dicts must not be mutated
        self.assertIn("intraday_body_battery", records[0])

    def test_live_sync_raw_wellness_archival_and_backfill(self):
        mock_sftp = MockSFTPClient()
        today_dt = datetime.now(timezone.utc).date()
        old_date_missing_raw = (today_dt - timedelta(days=5)).isoformat()
        old_date_has_raw = (today_dt - timedelta(days=4)).isoformat()

        # Pre-seed wellness_history.json for both dates, but raw_wellness only has old_date_has_raw
        mock_sftp.write_text_atomic(
            REMOTE_WELLNESS_PATH,
            json.dumps([
                {"date": old_date_missing_raw, "steps": 4444},
                {"date": old_date_has_raw, "steps": 5555},
            ]),
        )
        y_has = old_date_has_raw[:4]
        mock_sftp.write_text_atomic(
            f"{REMOTE_RAW_WELLNESS_DIR}/raw_wellness_{y_has}.json",
            json.dumps({old_date_has_raw: _sample_raw_wellness_bundle(old_date_has_raw, steps=5555)}),
        )

        fetched_dates = []

        class _SpyGarmin:
            def get_activities(self, start_ts, end_ts, limit=100):
                return []

            def get_activity_details(self, activity_id):
                return None

            def download_fit_file(self, activity_id):
                return None

            def get_raw_daily_wellness_bundle(self, cdate):
                fetched_dates.append(cdate)
                return _sample_raw_wellness_bundle(cdate, steps=8888)

        with tempfile.TemporaryDirectory() as tmpdir:
            tmp_path = Path(tmpdir)
            rc = run_sync_pipeline(
                mock_mode=False,
                lookback_days=7,
                staging_dir=tmp_path / ".raw_staging",
                output_rollup=tmp_path / ".staging" / "dashboard_rollup.json",
                sftp_client=mock_sftp,
                garmin_client=_SpyGarmin(),
            )
            self.assertEqual(rc, 0)

        # old_date_missing_raw (d_offset=5) MUST be backfilled because it wasn't in raw_wellness_{YYYY}.json
        self.assertIn(old_date_missing_raw, fetched_dates)
        # old_date_has_raw (d_offset=4) IS in both wellness_by_date and raw_wellness_{YYYY}.json -> skipped
        self.assertNotIn(old_date_has_raw, fetched_dates)

        y_miss = old_date_missing_raw[:4]
        raw_saved = json.loads(mock_sftp.read_text(f"{REMOTE_RAW_WELLNESS_DIR}/raw_wellness_{y_miss}.json"))
        self.assertIn(old_date_missing_raw, raw_saved)

    def test_import_garmindb_sqlite_roundtrip_and_4_digit_year_manifest(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp_path = Path(tmpdir)
            db_dir = tmp_path / "garmindb"
            db_dir.mkdir(parents=True, exist_ok=True)

            act_db = db_dir / "garmin_activities.db"
            conn = sqlite3.connect(str(act_db))
            try:
                conn.execute(
                    """
                    CREATE TABLE activities (
                        activity_id TEXT PRIMARY KEY,
                        name TEXT,
                        sport TEXT,
                        sub_sport TEXT,
                        start_time TEXT,
                        elapsed_time TEXT,
                        moving_time TEXT,
                        distance REAL,
                        calories INTEGER,
                        avg_hr INTEGER,
                        max_hr INTEGER,
                        ascent INTEGER,
                        avg_cadence INTEGER,
                        training_load REAL
                    )
                    """
                )
                conn.execute(
                    """
                    CREATE TABLE activity_laps (
                        activity_id TEXT,
                        lap INTEGER,
                        elapsed_time TEXT,
                        distance REAL,
                        avg_hr INTEGER,
                        max_hr INTEGER,
                        ascent INTEGER,
                        avg_cadence INTEGER
                    )
                    """
                )
                conn.execute(
                    """
                    CREATE TABLE activity_records (
                        activity_id TEXT,
                        record INTEGER,
                        hr INTEGER,
                        altitude REAL,
                        cadence INTEGER,
                        speed REAL,
                        position_lat REAL,
                        position_long REAL
                    )
                    """
                )
                conn.execute(
                    "INSERT INTO activities VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    ("gdb_1", "Morning Run", "running", "trail_running", "2024-05-12T07:00:00Z", "00:40:00", "00:39:00", 8.0, 560, 150, 174, 210, 172, 72.0),
                )
                conn.execute(
                    "INSERT INTO activities VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    ("gdb_2", "Gym Session", "fitness_equipment", "strength_training", "2024-05-13T18:00:00Z", "00:45:00", "00:45:00", 0.0, 320, 122, 148, 0, 0, 40.0),
                )
                conn.execute(
                    "INSERT INTO activity_records VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                    ("gdb_1", 1, 142, 420.0, 170, 3.2, 46.5197, 6.6323),
                )
                conn.execute(
                    "INSERT INTO activity_records VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                    ("gdb_1", 2, 155, 445.0, 174, 3.4, 46.5250, 6.6400),
                )
                # Even if a strength activity mistakenly had GPS records, import_garmindb must suppress them
                conn.execute(
                    "INSERT INTO activity_records VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                    ("gdb_2", 1, 120, 400.0, 0, 0.0, 46.5197, 6.6323),
                )
                conn.commit()
            finally:
                conn.close()

            extracted = extract_garmindb_activities(db_dir)
            by_id = {a["id"]: a for a in extracted}
            self.assertEqual(by_id["gdb_1"]["sport"], "running")
            self.assertIn("polyline", by_id["gdb_1"]["gps_track"])
            self.assertIn("encoded_polyline", by_id["gdb_1"]["gps_track"])
            self.assertTrue(bool(by_id["gdb_1"]["summary_polyline"]))
            self.assertTrue(by_id["gdb_1"]["has_streams"])

            self.assertEqual(by_id["gdb_2"]["sport"], "strength")
            self.assertIsNone(by_id["gdb_2"]["gps_track"])
            self.assertIsNone(by_id["gdb_2"]["telemetry_stream"])
            self.assertIsNone(by_id["gdb_2"]["summary_polyline"])
            self.assertFalse(by_id["gdb_2"]["has_streams"])

            mock_storage = MockSFTPClient()
            out_rollup = tmp_path / ".staging" / "dashboard_rollup.json"
            with patch("src.ingestion.import_garmindb.get_storage_client", return_value=mock_storage):
                rc = run_garmindb_import(db_dir, output_rollup=out_rollup, encrypt_output=False)
                self.assertEqual(rc, 0)

            manifest_data = json.loads(mock_storage.read_text(REMOTE_MANIFEST_PATH))
            self.assertEqual(manifest_data["activities_by_year"], {"2024": 2})

            rollup = json.loads(out_rollup.read_text(encoding="utf-8"))
            r_by_id = {a["id"]: a for a in rollup["activities"]}
            self.assertTrue(bool(r_by_id["gdb_1"]["summary_polyline"]))
            self.assertIs(r_by_id["gdb_1"]["has_streams"], True)
            self.assertIsNone(r_by_id["gdb_2"]["summary_polyline"])
            self.assertIs(r_by_id["gdb_2"]["has_streams"], False)

    def test_compile_rollup_preserves_summary_polyline_and_has_streams(self):
        acts = [
            {
                "id": "r1",
                "date": "2026-10-01T07:00:00Z",
                "start_time": "2026-10-01T07:00:00Z",
                "sport": "running",
                "title": "Trail Run",
                "distance_meters": 5000.0,
                "duration_seconds": 1500,
                "moving_time_seconds": 1480,
                "calories": 350,
                "avg_hr": 150,
                "max_hr": 172,
                "gps_track": {"polyline": "_p~iF~ps|U_ulLnnqC", "points": [[38.5, -120.2, 100, 150]]},
                "telemetry_stream": {"hr": [145, 155]},
            },
            {
                "id": "s1",
                "date": "2026-10-02T17:00:00Z",
                "start_time": "2026-10-02T17:00:00Z",
                "sport": "strength",
                "title": "Weights",
                "distance_meters": 0.0,
                "duration_seconds": 2400,
                "moving_time_seconds": 2400,
                "calories": 300,
                "avg_hr": 122,
                "max_hr": 145,
            },
        ]
        rollup = compile_rollup(acts)
        r_by_id = {a["id"]: a for a in rollup["activities"]}
        self.assertEqual(r_by_id["r1"]["summary_polyline"], "_p~iF~ps|U_ulLnnqC")
        self.assertIs(r_by_id["r1"]["has_streams"], True)
        self.assertIsNone(r_by_id["s1"]["summary_polyline"])
        self.assertIs(r_by_id["s1"]["has_streams"], False)


if __name__ == "__main__":
    unittest.main()
