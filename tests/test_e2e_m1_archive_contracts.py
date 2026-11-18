"""
tests/test_e2e_m1_archive_contracts.py

Opaque-Box 4-Tier E2E Test Suite for Milestone 1 (M1) Backend, Archive & CLI Contracts:
- LiveGarminClient personal SSO activity details & daily wellness normalization
- SyntheticDatasetGenerator / compile_dashboard_rollup summary_polyline & intraday telemetry
- Sharded ingestion + build_and_encrypt_rollup + stream shard encryption + cleanup hygiene
- GarminDB historical SQLite importer (activities, laps, records, wellness, multi-year sharding)
- SecretRedactionFilter & CI workflow (.github/workflows/sync.yml) contract verification
"""

from __future__ import annotations

import json
import logging
import os
import sqlite3
import subprocess
import sys
import tempfile
import types
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import MagicMock, patch

from src.encryption.crypto_engine import decrypt_payload
from src.encryption.encrypt import build_and_encrypt_rollup
from src.ingestion.cleanup import verify_clean_workspace
from src.ingestion.garmin_client import (
    LiveGarminClient,
    SecretRedactionFilter,
    normalize_daily_wellness,
)
from src.ingestion.import_garmindb import (
    extract_garmindb_activities,
    extract_garmindb_wellness,
    run_garmindb_import,
)
from src.ingestion.mock_generator import (
    SyntheticDatasetGenerator,
    compile_dashboard_rollup,
    compile_rollup,
    decode_polyline,
)
from src.ingestion.sftp_client import MockSFTPClient
from src.ingestion.sync import (
    REMOTE_INDEX_PATH,
    REMOTE_MANIFEST_PATH,
    REMOTE_RAW_WELLNESS_DIR,
    REMOTE_STREAMS_DIR,
    REMOTE_WELLNESS_PATH,
    normalize_garmin_activity,
    run_sync_pipeline,
)
from tests.test_secret_hygiene import ref_scan_directory

REPO_ROOT = Path(__file__).resolve().parent.parent


def _decode_polyline(encoded: str) -> list[tuple[float, float]]:
    coords: list[tuple[float, float]] = []
    idx = 0
    lat = 0
    lng = 0
    while idx < len(encoded):
        for is_lng in (False, True):
            shift = 0
            result = 0
            while idx < len(encoded):
                b = ord(encoded[idx]) - 63
                idx += 1
                result |= (b & 0x1F) << shift
                shift += 5
                if b < 0x20:
                    break
            delta = ~(result >> 1) if (result & 1) else (result >> 1)
            if is_lng:
                lng += delta
                coords.append((lat / 1e5, lng / 1e5))
            else:
                lat += delta
    return coords


def _create_synthetic_garmindb(db_dir: Path, years: list[int]) -> None:
    db_dir.mkdir(parents=True, exist_ok=True)
    act_db = sqlite3.connect(str(db_dir / "garmin_activities.db"))
    act_db.execute(
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
            ascent REAL,
            avg_cadence INTEGER,
            training_load REAL
        )
        """
    )
    act_db.execute(
        """
        CREATE TABLE activity_laps (
            activity_id TEXT,
            lap INTEGER,
            distance REAL,
            elapsed_time TEXT,
            avg_hr INTEGER,
            max_hr INTEGER,
            ascent REAL,
            avg_cadence INTEGER
        )
        """
    )
    act_db.execute(
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

    counter = 1
    for yr in years:
        for idx, (sport, sub, dist_km, dur) in enumerate([
            ("running", "trail", 10.5, "00:52:00"),
            ("cycling", "road", 45.0, "01:28:00"),
            ("training", "strength_training", 0.0, "00:45:00"),
        ]):
            aid = f"gdb_{yr}_{counter}"
            counter += 1
            start_ts = f"{yr}-06-{10 + idx:02d}T07:30:00"
            act_db.execute(
                "INSERT INTO activities VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (aid, f"{yr} {sport.title()} #{idx+1}", sport, sub, start_ts, dur, dur, dist_km, 550, 148, 174, 210 if dist_km > 0 else 0, 88, 65.0),
            )
            if dist_km > 0:
                act_db.execute(
                    "INSERT INTO activity_laps VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                    (aid, 1, 1.0, "00:05:00", 145, 160, 25.0, 168),
                )
                for r_idx in range(5):
                    act_db.execute(
                        "INSERT INTO activity_records VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                        (aid, r_idx, 140 + r_idx * 4, 420.0 + r_idx * 5, 170, 3.2, 47.37 + r_idx * 0.002, 8.54 + r_idx * 0.002),
                    )
    act_db.commit()
    act_db.close()

    sum_db = sqlite3.connect(str(db_dir / "garmin_summary.db"))
    sum_db.execute(
        """
        CREATE TABLE days_summary (
            day TEXT PRIMARY KEY,
            steps INTEGER,
            steps_goal INTEGER,
            rhr_avg REAL,
            stress_avg REAL,
            bb_max INTEGER,
            bb_min INTEGER,
            bb_charged INTEGER,
            calories_total INTEGER,
            calories_active INTEGER,
            calories_bmr INTEGER,
            moderate_activity_time TEXT,
            vigorous_activity_time TEXT,
            sleep_avg TEXT
        )
        """
    )
    sum_db.execute(
        """
        CREATE TABLE sleep (
            day TEXT PRIMARY KEY,
            total_sleep TEXT,
            deep_sleep TEXT,
            light_sleep TEXT,
            rem_sleep TEXT,
            awake TEXT,
            score INTEGER,
            qualifier TEXT
        )
        """
    )
    for yr in years:
        d = f"{yr}-06-10"
        sum_db.execute(
            "INSERT INTO days_summary VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (d, 11420, 10000, 48.0, 24.0, 94, 24, 70, 2450, 720, 1730, "00:30:00", "00:15:00", "07:50:00"),
        )
        sum_db.execute(
            "INSERT INTO sleep VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (d, "07:50:00", "01:30:00", "04:10:00", "01:45:00", "00:25:00", 86, "GOOD"),
        )
    sum_db.commit()
    sum_db.close()


class TestM1ArchiveContracts(unittest.TestCase):
    # =========================================================================
    # Tier 1: Core Feature Coverage
    # =========================================================================

    def test_t1_m1_01_live_garmin_client_personal_details_and_wellness(self):
        client = LiveGarminClient(
            "athlete@example.com",
            "secret",
            session_state={"access_token": "tok", "refresh_token": "ref", "expires_at": 9999999999},
        )
        base_ms = 1792972800000  # 2026-10-26T00:00:00Z
        personal = MagicMock()
        personal.get_activity_splits.return_value = {"lapDTOs": [{"distance": 1000, "duration": 295}]}
        personal.get_activity_details.return_value = {
            "geoPolylineDTO": {"polyline": [{"lat": 47.37, "lon": 8.54}, {"lat": 47.38, "lon": 8.55}]},
            "metricDescriptors": [{"key": "directHeartRate"}],
            "activityDetailMetrics": [{"metrics": [152]}],
        }
        personal.get_activity_hr_in_timezones.return_value = [
            {"zoneNumber": 2, "secsInZone": 1200},
            {"zoneNumber": 3, "secsInZone": 600},
        ]
        # §1.1 Expanded activity endpoints
        personal.get_activity_typed_splits.return_value = {"splits": [{"type": "RUN", "distance": 1000}]}
        personal.get_activity_split_summaries.return_value = {"splitSummaries": [{"splitType": "INTERVAL_ACTIVE"}]}
        personal.get_activity_power_in_timezones.return_value = [{"zoneNumber": 3, "secsInZone": 420}]
        personal.get_activity_weather.return_value = {"temp": 14, "weatherTypeDTO": {"desc": "Clear"}}
        personal.get_activity_exercise_sets.return_value = {"exerciseSets": [{"category": "BENCH_PRESS", "repetitionCount": 8}]}
        personal.get_activity_gear.return_value = [{"gearPk": 42, "customMakeModel": "Vaporfly"}]

        # §1.2 All 16 daily wellness endpoint groups
        personal.get_user_summary.return_value = {
            "totalSteps": 12345,
            "dailyStepGoal": 10000,
            "restingHeartRate": 47,
            "lastSevenDaysAvgRestingHeartRate": 48.2,
            "averageStressLevel": 26,
            "maxStressLevel": 79,
            "stressQualifier": "LOW",
            "restStressDuration": 41400,
            "lowStressDuration": 25200,
            "mediumStressDuration": 10800,
            "highStressDuration": 3600,
            "stressDuration": 81000,
            "bodyBatteryChargedValue": 68,
            "bodyBatteryDrainedValue": 62,
            "bodyBatteryHighestValue": 94,
            "bodyBatteryLowestValue": 26,
            "bodyBatteryMostRecentValue": 72,
            "bodyBatteryAtWakeTime": 91,
            "moderateIntensityMinutes": 35,
            "vigorousIntensityMinutes": 20,
            "intensityMinutesGoal": 150,
            "totalKilocalories": 2520,
            "activeKilocalories": 790,
            "bmrKilocalories": 1730,
        }
        personal.get_sleep_data.return_value = {
            "dailySleepDTO": {
                "sleepTimeSeconds": 28800,
                "deepSleepSeconds": 5400,
                "lightSleepSeconds": 15000,
                "remSleepSeconds": 6600,
                "awakeSleepSeconds": 1800,
                "sleepScores": {"overall": {"value": 87, "qualifierKey": "GOOD"}},
            }
        }
        personal.get_hrv_data.return_value = {
            "hrvSummary": {
                "status": "BALANCED",
                "weeklyAvg": 58,
                "lastNightAvg": 61,
                "baseline": {"balancedLow": 50, "balancedUpper": 70},
            }
        }
        personal.get_stress_data.return_value = {
            "stressValuesArray": [
                [base_ms + i * 180_000, 18 + (i % 10) * 5] for i in range(12)
            ],
            "bodyBatteryValuesArray": [
                [base_ms + i * 180_000, "CHARGED", 90 - i * 2] for i in range(12)
            ],
        }
        personal.get_body_battery.return_value = [{"date": "2026-10-26", "charged": 68, "drained": 62}]
        personal.get_body_battery_events.return_value = [{"eventType": "SLEEP", "impact": 65}]
        personal.get_heart_rates.return_value = {"minHeartRate": 44, "maxHeartRate": 176}
        personal.get_steps_data.return_value = [{"steps": 12345}]
        personal.get_respiration_data.return_value = {"avgWakingRespirationValue": 14.5, "avgSleepRespirationValue": 13.2}
        personal.get_spo2_data.return_value = {"averageSpO2": 97.4, "lowestSpO2": 92}
        personal.get_training_readiness.return_value = {"score": 81}
        personal.get_training_status.return_value = {"mostRecentTrainingStatus": {"trainingStatusFeedbackPhrase": "PRODUCTIVE"}}
        personal.get_max_metrics.return_value = [{"generic": {"vo2MaxValue": 55.4}, "cycling": {"vo2MaxValue": 57.1}}]
        personal.get_body_composition.return_value = {
            "totalAverage": {"weight": 71400, "bmi": 22.1, "bodyFat": 12.4, "muscleMass": 34200}
        }
        personal.get_hydration_data.return_value = {"valueInML": 2400}
        personal.get_floors.return_value = {"floorsAscended": 12, "floorsDescended": 10}
        personal.get_fitnessage_data.return_value = {"fitnessAge": 27}
        client._personal_garmin = personal

        details = client.get_activity_details("99001")
        self.assertIsNotNone(details)
        self.assertEqual(len(details["splits"]), 1)
        self.assertIn("geoPolylineDTO", details)
        self.assertEqual(details["hr_zones"], {"Z2": 1200, "Z3": 600})
        for extra_key in ("typed_splits", "split_summaries", "power_zones", "weather", "exercise_sets", "gear"):
            self.assertIn(extra_key, details, f"Missing expanded activity field {extra_key}")

        raw_bundle = client.get_raw_daily_wellness_bundle("2026-10-26")
        self.assertIsNotNone(raw_bundle)
        for bundle_key in (
            "user_summary", "sleep", "hrv", "stress", "body_battery", "body_battery_events",
            "heart_rates", "steps_data", "respiration", "spo2", "training_readiness",
            "training_status", "max_metrics", "body_composition", "hydration", "floors", "fitness_age",
        ):
            self.assertIsNotNone(raw_bundle.get(bundle_key), f"Raw bundle missing {bundle_key}")

        wellness = normalize_daily_wellness("2026-10-26", raw_bundle)
        self.assertEqual(wellness["steps"], 12345)
        self.assertEqual(wellness["resting_hr"], 47)
        self.assertEqual(wellness["sleep_seconds"], 28800)
        self.assertEqual(wellness["stress_level"], 26)
        self.assertEqual(wellness["stress_max"], 79)
        self.assertEqual(wellness["stress_rest_seconds"], 41400)
        self.assertEqual(wellness["stress_low_seconds"], 25200)
        self.assertEqual(wellness["stress_medium_seconds"], 10800)
        self.assertEqual(wellness["stress_high_seconds"], 3600)
        self.assertEqual(wellness["stress_total_seconds"], 81000)
        self.assertEqual(wellness["body_battery"], 72)
        self.assertEqual(wellness["body_battery_high"], 94)
        self.assertEqual(wellness["body_battery_low"], 26)
        self.assertEqual(wellness["body_battery_at_wake"], 91)
        self.assertEqual(wellness["hrv_last_night_avg"], 61)
        self.assertEqual(wellness["active_intensity_minutes"], 75)
        self.assertEqual(wellness["daily_calories"], 2520)
        self.assertEqual(wellness["spo2_avg"], 97.4)
        self.assertEqual(wellness["spo2_low"], 92)
        self.assertEqual(wellness["respiration_waking"], 14.5)
        self.assertEqual(wellness["respiration_sleep"], 13.2)
        self.assertEqual(wellness["floors_ascended"], 12)
        self.assertEqual(wellness["floors_descended"], 10)
        self.assertEqual(wellness["min_hr"], 44)
        self.assertEqual(wellness["max_hr"], 176)
        self.assertEqual(wellness["weight_kg"], 71.4)
        self.assertEqual(wellness["bmi"], 22.1)
        self.assertEqual(wellness["body_fat_pct"], 12.4)
        self.assertEqual(wellness["muscle_mass_kg"], 34.2)
        self.assertEqual(wellness["hydration_ml"], 2400)
        self.assertEqual(wellness["training_readiness_score"], 81)
        self.assertEqual(wellness["vo2max_running"], 55.4)
        self.assertEqual(wellness["vo2max_cycling"], 57.1)
        self.assertGreaterEqual(len(wellness["intraday_body_battery"]), 2)
        self.assertGreaterEqual(len(wellness["intraday_stress"]), 2)

    def test_t1_m1_02_mock_generator_summary_polyline_and_intraday_wellness(self):
        gen = SyntheticDatasetGenerator(seed=42)
        acts = gen.generate_activities()
        rollup = compile_dashboard_rollup(acts)

        gps_acts = [a for a in rollup["activities"] if a["sport"] in ("running", "cycling", "hiking")]
        self.assertGreater(len(gps_acts), 10)
        for act in gps_acts:
            poly = act.get("summary_polyline")
            self.assertIsInstance(poly, str)
            self.assertGreater(len(poly), 4)
            decoded = _decode_polyline(poly)
            self.assertGreaterEqual(len(decoded), 2)

        daily = rollup["wellness"]["daily"]
        self.assertEqual(len(daily), 365)
        latest = daily[-1]
        self.assertIsInstance(latest.get("intraday_body_battery"), list)
        self.assertGreater(len(latest["intraday_body_battery"]), 10)
        self.assertIsInstance(latest.get("intraday_stress"), list)
        self.assertGreater(len(latest["intraday_stress"]), 10)
        for key in ("stress_rest_seconds", "stress_low_seconds", "stress_medium_seconds", "stress_high_seconds"):
            self.assertIn(key, latest)
            self.assertIsInstance(latest[key], int)

    def test_t1_m1_03_sharded_sync_and_encryption_roundtrip(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            staging_dir = tmp_path / ".raw_staging"
            rollup_path = tmp_path / ".staging" / "dashboard_rollup.json"
            streams_dir = rollup_path.parent / "streams"
            enc_path = tmp_path / "out" / "data.enc"

            rc = run_sync_pipeline(
                mock_mode=True,
                staging_dir=staging_dir,
                output_rollup=rollup_path,
            )
            self.assertEqual(rc, 0)
            self.assertTrue(rollup_path.exists())
            self.assertFalse(staging_dir.exists(), "Raw staging directory must be purged after sync")

            # Inject a stream shard beside dashboard_rollup.json to verify stream shard encryption
            streams_dir.mkdir(parents=True, exist_ok=True)
            shard_payload = {"id": "act_001", "splits": [{"split_number": 1}], "gps_track": None}
            (streams_dir / "act_001.json").write_text(json.dumps(shard_payload), encoding="utf-8")

            out_enc = build_and_encrypt_rollup(
                passphrase="m1-e2e-passphrase-2026!",
                input_file=rollup_path,
                output_file=enc_path,
                verify=True,
                purge_input=True,
                iterations=1000,
            )
            self.assertTrue(out_enc.exists())
            self.assertFalse(rollup_path.exists(), "Plaintext dashboard_rollup.json must be purged")
            shard_enc = out_enc.parent / "streams" / "act_001.enc"
            self.assertTrue(shard_enc.exists(), "Encrypted stream shard act_001.enc must be emitted")

            wire = out_enc.read_bytes()
            decrypted_rollup = json.loads(decrypt_payload(wire, "m1-e2e-passphrase-2026!", iterations=1000).decode("utf-8"))
            self.assertGreater(len(decrypted_rollup["activities"]), 30)

            pt_shard = decrypt_payload(shard_enc.read_bytes(), "m1-e2e-passphrase-2026!", iterations=1000)
            self.assertEqual(json.loads(pt_shard.decode("utf-8")), shard_payload)

    def test_t1_m1_04_garmindb_importer_sqlite_to_sharded_vault(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            gdb_dir = tmp_path / "HealthData" / "DBs"
            _create_synthetic_garmindb(gdb_dir, [2025, 2026])
            mock_storage = MockSFTPClient()
            out_rollup = tmp_path / ".staging" / "dashboard_rollup.json"

            with patch("src.ingestion.import_garmindb.get_storage_client", return_value=mock_storage):
                rc = run_garmindb_import(garmindb_dir=gdb_dir, output_rollup=out_rollup, encrypt_output=False)

            self.assertEqual(rc, 0)
            self.assertTrue(out_rollup.exists())
            self.assertTrue(mock_storage.file_exists(REMOTE_INDEX_PATH))
            self.assertTrue(mock_storage.file_exists(REMOTE_WELLNESS_PATH))
            self.assertTrue(mock_storage.file_exists(REMOTE_MANIFEST_PATH))

            rollup = json.loads(out_rollup.read_text(encoding="utf-8"))
            self.assertEqual(len(rollup["activities"]), 6)
            self.assertEqual(len(rollup["wellness"]["daily"]), 2)
            gps_acts = [a for a in rollup["activities"] if a["sport"] != "strength"]
            str_acts = [a for a in rollup["activities"] if a["sport"] == "strength"]
            self.assertTrue(all(a.get("has_streams") for a in gps_acts))
            self.assertTrue(all(a.get("has_streams") is False for a in str_acts))
            self.assertTrue(mock_storage.file_exists(f"{REMOTE_STREAMS_DIR}/2025/gdb_2025_1.json"))

    def test_t1_m1_05_cleanup_verify_only_clean_and_dirty(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            (tmp_path / "public").mkdir()
            (tmp_path / "public" / "data.enc").write_bytes(b"\x00" * 64)

            proc_clean = subprocess.run(
                [sys.executable, "-m", "src.ingestion.cleanup", "--verify-only", "--workspace-root", str(tmp_path)],
                cwd=str(REPO_ROOT),
                capture_output=True,
                text=True,
                timeout=30,
            )
            self.assertEqual(proc_clean.returncode, 0, proc_clean.stderr)

            (tmp_path / "public" / "leaked.fit").write_bytes(b".FIT")
            proc_dirty = subprocess.run(
                [sys.executable, "-m", "src.ingestion.cleanup", "--verify-only", "--workspace-root", str(tmp_path)],
                cwd=str(REPO_ROOT),
                capture_output=True,
                text=True,
                timeout=30,
            )
            self.assertNotEqual(proc_dirty.returncode, 0)
            self.assertIn("leaked.fit", proc_dirty.stderr)

    def test_t1_m1_06_live_sync_raw_wellness_archival_and_14d_retention(self):
        today = datetime.now(timezone.utc).date()
        today_iso = today.isoformat()

        class FakeGarmin:
            def get_activities(self, start_ts, end_ts, limit=100):
                return [
                    {
                        "activityId": "live_run_1",
                        "activityName": "Live Alpine Trail Run",
                        "activityType": {"typeKey": "trail_running"},
                        "startTimeGMT": f"{today_iso}T07:00:00Z",
                        "duration": 3000,
                        "distance": 10000,
                        "averageHR": 156,
                        "elevationGain": 220,
                        "calories": 710,
                    },
                    {
                        "activityId": "live_str_2",
                        "activityName": "Live Strength Session",
                        "activityType": {"typeKey": "strength_training"},
                        "startTimeGMT": f"{today_iso}T18:00:00Z",
                        "duration": 2400,
                        "distance": 0,
                        "averageHR": 118,
                        "calories": 280,
                        "weight": 12000,
                    },
                ]

            def get_activity_details(self, activity_id):
                if activity_id == "live_run_1":
                    return {
                        "geoPolylineDTO": {
                            "polyline": [
                                {"lat": 47.37, "lon": 8.54, "altitude": 420},
                                {"lat": 47.38, "lon": 8.55, "altitude": 460},
                            ]
                        },
                        "weather": {"temp": 16},
                    }
                return {"exerciseSets": {"sets": [{"reps": 10}]}}

            def download_fit_file(self, activity_id):
                return b".FITMOCK"

            def download_gpx_file(self, activity_id):
                return b"<gpx></gpx>" if activity_id == "live_run_1" else None

            def get_raw_daily_wellness_bundle(self, cdate):
                dt = datetime.strptime(cdate, "%Y-%m-%d").date()
                base_ms = int(datetime(dt.year, dt.month, dt.day, 0, 0, tzinfo=timezone.utc).timestamp() * 1000)
                return {
                    "date": cdate,
                    "user_summary": {
                        "totalSteps": 9500,
                        "restingHeartRate": 48,
                        "averageStressLevel": 24,
                        "restStressDuration": 40000,
                        "lowStressDuration": 22000,
                        "mediumStressDuration": 9000,
                        "highStressDuration": 3000,
                        "bodyBatteryHighestValue": 93,
                        "bodyBatteryLowestValue": 24,
                        "bodyBatteryMostRecentValue": 74,
                        "bodyBatteryAtWakeTime": 90,
                    },
                    "stress": {
                        "stressValuesArray": [[base_ms + i * 900_000, 20 + i] for i in range(4)],
                        "bodyBatteryValuesArray": [[base_ms + i * 900_000, 90 - i * 3] for i in range(4)],
                    },
                }

        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            mock_storage = MockSFTPClient()
            staging_dir = tmp_path / ".raw_staging"
            rollup_path = tmp_path / ".staging" / "dashboard_rollup.json"
            enc_path = tmp_path / "dist" / "data.enc"

            rc = run_sync_pipeline(
                mock_mode=False,
                lookback_days=20,
                staging_dir=staging_dir,
                output_rollup=rollup_path,
                sftp_client=mock_storage,
                garmin_client=FakeGarmin(),
            )
            self.assertEqual(rc, 0)

            # Raw wellness per-year bundle persisted under REMOTE_RAW_WELLNESS_DIR
            self.assertEqual(REMOTE_RAW_WELLNESS_DIR, "garmin_archive/raw_wellness")
            years_seen = {(today - timedelta(days=d)).strftime("%Y") for d in range(20)}
            all_raw_dates = {}
            for yr in years_seen:
                raw_path = f"{REMOTE_RAW_WELLNESS_DIR}/raw_wellness_{yr}.json"
                self.assertTrue(mock_storage.file_exists(raw_path), f"Missing raw wellness archive {raw_path}")
                parsed_yr = json.loads(mock_storage.read_text(raw_path))
                all_raw_dates.update(parsed_yr)
            self.assertEqual(len(all_raw_dates), 20)
            self.assertIn("stress", all_raw_dates[today_iso])

            # REMOTE_INDEX_PATH preserves summary_polyline and enforces strength hygiene
            idx_acts = json.loads(mock_storage.read_text(REMOTE_INDEX_PATH))
            run_idx = next(a for a in idx_acts if a["id"] == "live_run_1")
            str_idx = next(a for a in idx_acts if a["id"] == "live_str_2")
            self.assertIsInstance(run_idx.get("summary_polyline"), str)
            self.assertTrue(run_idx.get("has_streams"))
            self.assertNotIn("gps_track", run_idx)
            self.assertIsNone(str_idx.get("summary_polyline"))
            self.assertFalse(str_idx.get("has_streams"))
            for forbidden in ("weight", "kg", "load_kg", "tonnage", "weight_kg", "exercise_sets"):
                self.assertNotIn(forbidden, str_idx)

            build_and_encrypt_rollup(
                passphrase="live-wellness-retention-2026!",
                input_file=rollup_path,
                output_file=enc_path,
                verify=True,
                purge_input=True,
                iterations=1000,
            )
            decrypted = json.loads(
                decrypt_payload(enc_path.read_bytes(), "live-wellness-retention-2026!", iterations=1000).decode("utf-8")
            )
            daily = decrypted["wellness"]["daily"]
            self.assertEqual(len(daily), 20)
            cutoff = today - timedelta(days=14)
            for rec in daily:
                rec_dt = datetime.strptime(rec["date"], "%Y-%m-%d").date()
                if rec_dt > cutoff:
                    self.assertTrue(rec.get("intraday_body_battery"), f"Expected intraday BB within 14d for {rec['date']}")
                    self.assertTrue(rec.get("intraday_stress"), f"Expected intraday stress within 14d for {rec['date']}")
                else:
                    self.assertNotIn("intraday_body_battery", rec)
                    self.assertNotIn("intraday_stress", rec)

    # =========================================================================
    # Tier 2: Boundary & Corner Cases
    # =========================================================================

    def test_t2_m1_06_bootstrap_garmin_module_and_token_export_contract(self):
        import src.ingestion.bootstrap_garmin as bg

        self.assertTrue(callable(bg.main))
        self.assertTrue(callable(bg.copy_to_clipboard))

        fake_client = types.SimpleNamespace(
            garth=types.SimpleNamespace(dumps=lambda: '{"oauth1":"abc","oauth2":"xyz"}')
        )
        exported = LiveGarminClient._export_personal_tokenstore(fake_client)
        parsed = json.loads(exported)
        self.assertIn("garth_dumps", parsed)

    def test_t2_m1_07_sync_cli_reprocess_archive_flag(self):
        proc = subprocess.run(
            [sys.executable, "-m", "src.ingestion.sync", "--help"],
            cwd=str(REPO_ROOT),
            capture_output=True,
            text=True,
            timeout=20,
        )
        self.assertEqual(proc.returncode, 0)
        for flag in ("--mock", "--force-refresh", "--reprocess-archive", "--lookback-days"):
            self.assertIn(flag, proc.stdout)

        # Real offline reprocess_archive=True over empty storage without Garmin credentials
        clean_env = {k: v for k, v in os.environ.items() if not k.startswith("GARMIN_")}
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, clean_env, clear=True):
            tmp_path = Path(tmp)
            mock_storage = MockSFTPClient()
            rollup_path = tmp_path / ".staging" / "dashboard_rollup.json"
            with patch("src.ingestion.sync.LiveGarminClient") as mock_live_cls:
                rc = run_sync_pipeline(
                    mock_mode=False,
                    reprocess_archive=True,
                    staging_dir=tmp_path / ".raw_staging",
                    output_rollup=rollup_path,
                    sftp_client=mock_storage,
                )
                mock_live_cls.assert_not_called()
            self.assertEqual(rc, 0)
            self.assertTrue(rollup_path.exists())
            rollup = json.loads(rollup_path.read_text(encoding="utf-8"))
            self.assertEqual(rollup["activities"], [])
            self.assertEqual(rollup["wellness"]["daily"], [])

    def test_t2_m1_08_garmindb_importer_empty_dir_graceful(self):
        with tempfile.TemporaryDirectory() as tmp:
            empty_dir = Path(tmp)
            self.assertEqual(extract_garmindb_activities(empty_dir), [])
            self.assertEqual(extract_garmindb_wellness(empty_dir), [])

    def test_t2_m1_09_wellness_negative_stress_sentinel_and_partial_nulls(self):
        client = LiveGarminClient(
            "athlete@example.com",
            "secret",
            session_state={"access_token": "tok", "refresh_token": "ref", "expires_at": 9999999999},
        )
        personal = MagicMock()
        personal.get_user_summary.return_value = {
            "totalSteps": 5100,
            "averageStressLevel": -1,
            "restingHeartRate": None,
        }
        personal.get_sleep_data.side_effect = RuntimeError("sleep unavailable")
        personal.get_hrv_data.return_value = None
        client._personal_garmin = personal

        wellness = client.get_daily_wellness("2026-10-25")
        self.assertIsNotNone(wellness)
        self.assertEqual(wellness["steps"], 5100)
        self.assertIsNone(wellness["stress_level"], "Garmin -1 stress sentinel must normalize to None")
        self.assertIsNone(wellness["sleep_seconds"])
        self.assertIsNone(wellness["hrv_last_night_avg"])

    def test_t2_m1_10_garmin_client_fallback_endpoints_resilience_and_empty_bundle(self):
        client = LiveGarminClient(
            "athlete@example.com",
            "secret",
            session_state={"access_token": "tok", "refresh_token": "ref", "expires_at": 9999999999},
        )
        personal = MagicMock()
        # Activity extra endpoint partial failures must not abort capture
        personal.get_activity_splits.return_value = {"lapDTOs": []}
        personal.get_activity_details.return_value = {}
        personal.get_activity_hr_in_timezones.side_effect = RuntimeError("hrz unavailable")
        personal.get_activity_typed_splits.return_value = [{"type": "ACTIVE"}]
        personal.get_activity_split_summaries.side_effect = RuntimeError("split summaries unavailable")
        personal.get_activity_power_in_timezones.side_effect = RuntimeError("no power meter")
        personal.get_activity_weather.side_effect = RuntimeError("weather unavailable")
        personal.get_activity_exercise_sets.return_value = {"exerciseSets": []}
        personal.get_activity_gear.return_value = [{"gearPk": 11}]

        # Wellness fallback endpoints (get_stats, get_all_day_stress, get_weigh_ins) + per-endpoint errors
        personal.get_user_summary.return_value = None
        personal.get_stats.return_value = {"totalSteps": 6400}
        personal.get_sleep_data.side_effect = RuntimeError("sleep timeout")
        personal.get_hrv_data.side_effect = RuntimeError("hrv timeout")
        personal.get_stress_data.side_effect = RuntimeError("stress endpoint 404")
        personal.get_all_day_stress.return_value = {"avgStressLevel": 31}
        personal.get_body_battery.side_effect = RuntimeError("bb timeout")
        personal.get_body_battery_events.side_effect = RuntimeError("bb events timeout")
        personal.get_heart_rates.side_effect = RuntimeError("hr timeout")
        personal.get_steps_data.side_effect = RuntimeError("steps timeout")
        personal.get_respiration_data.side_effect = RuntimeError("resp timeout")
        personal.get_spo2_data.side_effect = RuntimeError("spo2 timeout")
        personal.get_training_readiness.side_effect = RuntimeError("tr timeout")
        personal.get_training_status.side_effect = RuntimeError("ts timeout")
        personal.get_max_metrics.side_effect = RuntimeError("vo2 timeout")
        personal.get_body_composition.return_value = None
        personal.get_weigh_ins.return_value = {"dailyWeightSummaries": [{"latestWeight": {"weight": 70.5}}]}
        personal.get_hydration_data.side_effect = RuntimeError("hydration timeout")
        personal.get_floors.side_effect = RuntimeError("floors timeout")
        personal.get_fitnessage_data.side_effect = RuntimeError("fitnessage timeout")
        client._personal_garmin = personal

        details = client.get_activity_details("99002")
        self.assertIsNotNone(details)
        self.assertEqual(details["typed_splits"], [{"type": "ACTIVE"}])
        self.assertEqual(details["gear"], [{"gearPk": 11}])
        self.assertNotIn("weather", details)

        bundle = client.get_raw_daily_wellness_bundle("2026-10-25")
        self.assertIsNotNone(bundle)
        self.assertEqual(bundle["user_summary"], {"totalSteps": 6400})
        self.assertEqual(bundle["stress"], {"avgStressLevel": 31})
        self.assertEqual(bundle["body_composition"], {"dailyWeightSummaries": [{"latestWeight": {"weight": 70.5}}]})

        # All-empty / all-failing endpoints must return None
        empty_personal = MagicMock()
        for attr in (
            "get_user_summary", "get_stats", "get_sleep_data", "get_hrv_data",
            "get_stress_data", "get_all_day_stress", "get_body_battery",
            "get_body_battery_events", "get_heart_rates", "get_steps_data",
            "get_respiration_data", "get_spo2_data", "get_training_readiness",
            "get_training_status", "get_max_metrics", "get_body_composition",
            "get_weigh_ins", "get_daily_weigh_ins", "get_hydration_data",
            "get_floors", "get_fitnessage_data",
        ):
            setattr(empty_personal, attr, MagicMock(side_effect=RuntimeError("unavailable")))
        client._personal_garmin = empty_personal
        self.assertIsNone(client.get_raw_daily_wellness_bundle("2026-10-25"))

    def test_t2_m1_11_normalize_daily_wellness_zero_sentinels_and_downsample(self):
        base_ms = 1792886400000  # 2026-10-25T00:00:00Z
        # 3-minute interval points (180_000 ms), including -1 and -2 sentinels
        stress_pts = [
            [base_ms + 0 * 180_000, -1],
            [base_ms + 1 * 180_000, 15],
            [base_ms + 2 * 180_000, 22],
            [base_ms + 3 * 180_000, -2],
            [base_ms + 6 * 180_000, 35],   # +15 min from idx 1
            [base_ms + 11 * 180_000, 48],  # +30 min from idx 1
        ]
        bb_pts = [
            [base_ms + 0 * 180_000, "MEASURED", -1],
            [base_ms + 1 * 180_000, "MEASURED", 80],
            [base_ms + 2 * 180_000, "MEASURED", 79],
            [base_ms + 6 * 180_000, "MEASURED", 75],
            [base_ms + 11 * 180_000, "MEASURED", 70],
        ]
        raw_bundle = {
            "user_summary": {
                "totalSteps": 0,
                "averageStressLevel": 0,
                "maxStressLevel": 0,
                "restStressDuration": 0,
                "lowStressDuration": 0,
                "mediumStressDuration": 0,
                "highStressDuration": 0,
                "stressDuration": 0,
                "bodyBatteryMostRecentValue": 0,
                "bodyBatteryHighestValue": 0,
                "bodyBatteryLowestValue": 0,
                "bodyBatteryAtWakeTime": 0,
            },
            "floors": {"floorsAscended": 0, "floorsDescended": 0},
            "hydration": {"valueInML": 0},
            "training_readiness": {"score": 0},
            "stress": {
                "stressValuesArray": stress_pts,
                "bodyBatteryValuesArray": bb_pts,
            },
        }
        norm = normalize_daily_wellness("2026-10-25", raw_bundle)
        for zero_key in (
            "steps", "stress_level", "stress_max", "stress_rest_seconds", "stress_low_seconds",
            "stress_medium_seconds", "stress_high_seconds", "stress_total_seconds",
            "body_battery", "body_battery_high", "body_battery_low", "body_battery_at_wake",
            "floors_ascended", "floors_descended", "hydration_ml", "training_readiness_score",
        ):
            self.assertEqual(norm[zero_key], 0, f"Zero value for {zero_key} must be preserved")

        # Sentinels (-1, -2) must be filtered and 3-min points downsampled to >=15-min spacing
        self.assertEqual(norm["intraday_stress"], [
            [base_ms + 1 * 180_000, 15],
            [base_ms + 6 * 180_000, 35],
            [base_ms + 11 * 180_000, 48],
        ])
        self.assertEqual(norm["intraday_body_battery"], [
            [base_ms + 1 * 180_000, 80],
            [base_ms + 6 * 180_000, 75],
            [base_ms + 11 * 180_000, 70],
        ])

    def test_t2_m1_12_offline_reprocess_corrupted_archive_json_resilience(self):
        mock_storage = MockSFTPClient()
        # Valid + corrupted activity summary
        valid_act = {
            "summary": {
                "activityId": "ok_act_1",
                "activityName": "Valid Archived Run",
                "activityType": {"typeKey": "running"},
                "startTimeGMT": "2026-10-20T08:00:00Z",
                "duration": 1800,
                "distance": 6000,
                "averageHR": 150,
            },
            "details": {},
        }
        mock_storage.write_text_atomic("garmin_archive/activities/2026/10/ok_act_1_summary.json", json.dumps(valid_act))
        mock_storage.write_text_atomic("garmin_archive/activities/2026/10/bad_act_summary.json", "{not_valid_json!!!")
        # Valid + corrupted raw wellness archive
        mock_storage.write_text_atomic(
            f"{REMOTE_RAW_WELLNESS_DIR}/raw_wellness_2026.json",
            json.dumps({"2026-10-20": {"user_summary": {"totalSteps": 8800, "averageStressLevel": 22}}}),
        )
        mock_storage.write_text_atomic(f"{REMOTE_RAW_WELLNESS_DIR}/raw_wellness_2025.json", "{corrupt_wellness!!!")

        clean_env = {k: v for k, v in os.environ.items() if not k.startswith("GARMIN_")}
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, clean_env, clear=True):
            tmp_path = Path(tmp)
            rollup_path = tmp_path / ".staging" / "dashboard_rollup.json"
            with patch("src.ingestion.sync.LiveGarminClient") as mock_live_cls:
                rc = run_sync_pipeline(
                    mock_mode=False,
                    reprocess_archive=True,
                    staging_dir=tmp_path / ".raw_staging",
                    output_rollup=rollup_path,
                    sftp_client=mock_storage,
                )
                mock_live_cls.assert_not_called()
            self.assertEqual(rc, 0)
            rollup = json.loads(rollup_path.read_text(encoding="utf-8"))
            self.assertEqual([a["id"] for a in rollup["activities"]], ["ok_act_1"])
            self.assertEqual(len(rollup["wellness"]["daily"]), 1)
            self.assertEqual(rollup["wellness"]["daily"][0]["steps"], 8800)

    # =========================================================================
    # Tier 3: Cross-Feature Combinations
    # =========================================================================

    def test_t3_m1_10_sync_workflow_yaml_contracts(self):
        yml_text = (REPO_ROOT / ".github" / "workflows" / "sync.yml").read_text(encoding="utf-8")
        self.assertIn("cron: '0 */6 * * *'", yml_text)
        self.assertIn("workflow_dispatch:", yml_text)
        self.assertIn("force_refresh:", yml_text)
        self.assertIn("mock_mode:", yml_text)
        self.assertIn("if: always()", yml_text)
        self.assertIn("python -m src.ingestion.cleanup --verify-only", yml_text)
        self.assertIn("ref_scan_directory('dist')", yml_text)

    def test_t3_m1_11_sync_to_encrypt_to_cleanup_pipeline_zero_plaintext(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            staging_dir = tmp_path / ".raw_staging"
            rollup_path = tmp_path / ".staging" / "dashboard_rollup.json"
            enc_path = tmp_path / "dist" / "data.enc"

            rc = run_sync_pipeline(mock_mode=True, staging_dir=staging_dir, output_rollup=rollup_path)
            self.assertEqual(rc, 0)

            build_and_encrypt_rollup(
                passphrase="pipeline-zero-plaintext-2026!",
                input_file=rollup_path,
                output_file=enc_path,
                verify=True,
                purge_input=True,
                iterations=1000,
            )

            is_clean, violations = verify_clean_workspace(tmp_path)
            self.assertTrue(is_clean, f"Workspace violations found: {violations}")
            self.assertEqual(ref_scan_directory(str(tmp_path / "dist")), [])
            self.assertTrue(enc_path.exists())

    def test_t3_m1_12_garmindb_import_with_encryption_and_shard_decryption(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            gdb_dir = tmp_path / "DBs"
            _create_synthetic_garmindb(gdb_dir, [2026])
            mock_storage = MockSFTPClient()
            rollup_path = tmp_path / ".staging" / "dashboard_rollup.json"
            enc_path = tmp_path / "dist" / "data.enc"

            with patch("src.ingestion.import_garmindb.get_storage_client", return_value=mock_storage):
                rc = run_garmindb_import(garmindb_dir=gdb_dir, output_rollup=rollup_path, encrypt_output=False)
            self.assertEqual(rc, 0)

            build_and_encrypt_rollup(
                passphrase="garmindb-enc-2026!",
                input_file=rollup_path,
                output_file=enc_path,
                verify=True,
                purge_input=True,
                iterations=1000,
            )
            self.assertTrue(enc_path.exists())
            self.assertTrue((enc_path.parent / "streams" / "gdb_2026_1.enc").exists())
            decrypted = json.loads(decrypt_payload(enc_path.read_bytes(), "garmindb-enc-2026!", iterations=1000).decode("utf-8"))
            self.assertEqual(len(decrypted["activities"]), 3)

    # =========================================================================
    # Tier 4: Real-World & Stress Scenarios
    # =========================================================================

    def test_t4_m1_13_multi_year_garmindb_archive_and_idempotency(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            gdb_dir = tmp_path / "DBs"
            _create_synthetic_garmindb(gdb_dir, [2024, 2025, 2026])
            mock_storage = MockSFTPClient()
            rollup_path = tmp_path / ".staging" / "dashboard_rollup.json"

            with patch("src.ingestion.import_garmindb.get_storage_client", return_value=mock_storage):
                self.assertEqual(run_garmindb_import(garmindb_dir=gdb_dir, output_rollup=rollup_path, encrypt_output=False), 0)
                self.assertEqual(run_garmindb_import(garmindb_dir=gdb_dir, output_rollup=rollup_path, encrypt_output=False), 0)

            rollup = json.loads(rollup_path.read_text(encoding="utf-8"))
            self.assertEqual(len(rollup["activities"]), 9)
            by_year = rollup["backup_vault"]["activities_by_year"]
            self.assertEqual(by_year.get("2024"), 3)
            self.assertEqual(by_year.get("2025"), 3)
            self.assertEqual(by_year.get("2026"), 3)
            for act in rollup["activities"]:
                if act["sport"] == "strength":
                    self.assertFalse(act["has_streams"])
                else:
                    self.assertTrue(act["has_streams"])
                self.assertIsNone(act["gps_track"])
                self.assertIsNone(act["telemetry_stream"])

    def test_t4_m1_14_secret_redaction_filter_strips_tokens_and_keys(self):
        flt = SecretRedactionFilter()
        record = logging.LogRecord(
            name="test.ingestion",
            level=logging.ERROR,
            pathname=__file__,
            lineno=1,
            msg="Auth failed with Bearer super_secret_token_xyz123 GARMIN_CLIENT_SECRET=MyGarminSecret99! DASHBOARD_PASSPHRASE=UltraSecretPass!",
            args=(),
            exc_info=None,
        )
        self.assertTrue(flt.filter(record))
        formatted = record.getMessage()
        self.assertNotIn("super_secret_token_xyz123", formatted)
        self.assertNotIn("MyGarminSecret99!", formatted)
        self.assertNotIn("UltraSecretPass!", formatted)
        self.assertIn("[REDACTED]", formatted)

    def test_t3_m1_15_offline_reprocess_archive_to_encrypted_sharded_vault(self):
        mock_storage = MockSFTPClient()
        # Seed GPS run + strength workout (with forbidden weight keys) in raw activity archive
        gps_payload = {
            "summary": {
                "activityId": "arch_gps_101",
                "activityName": "Archived Trail Run",
                "activityType": {"typeKey": "trail_running"},
                "startTimeGMT": "2026-10-25T07:30:00Z",
                "duration": 3600,
                "distance": 12000,
                "averageHR": 154,
                "elevationGain": 310,
            },
            "details": {
                "geoPolylineDTO": {
                    "polyline": [
                        {"lat": 47.3769, "lon": 8.5417, "altitude": 410},
                        {"lat": 47.3815, "lon": 8.5480, "altitude": 455},
                        {"lat": 47.3860, "lon": 8.5530, "altitude": 490},
                    ]
                },
                "weather": {"temp": 13},
            },
        }
        str_payload = {
            "summary": {
                "activityId": "arch_str_102",
                "activityName": "Archived Strength Session",
                "activityType": {"typeKey": "strength_training"},
                "startTimeGMT": "2026-10-24T18:00:00Z",
                "duration": 2700,
                "distance": 0,
                "averageHR": 119,
                "weight": 9500,
                "tonnage": 9500,
            },
            "details": {"exerciseSets": {"sets": [{"reps": 10, "weight": 80}]}},
        }
        mock_storage.write_text_atomic(
            "garmin_archive/activities/2026/10/arch_gps_101_summary.json", json.dumps(gps_payload)
        )
        mock_storage.write_text_atomic(
            "garmin_archive/activities/2026/10/arch_str_102_summary.json", json.dumps(str_payload)
        )

        # Seed raw wellness across 2026-10-05 (old >14d) and 2026-10-25 (recent <=14d)
        old_ms = 1791158400000  # 2026-10-05T00:00:00Z
        new_ms = 1792886400000  # 2026-10-25T00:00:00Z
        raw_wellness_2026 = {
            "2026-10-05": {
                "user_summary": {"totalSteps": 7500, "averageStressLevel": 29, "restStressDuration": 36000},
                "stress": {
                    "stressValuesArray": [[old_ms + i * 900_000, 25 + i] for i in range(3)],
                    "bodyBatteryValuesArray": [[old_ms + i * 900_000, 85 - i * 4] for i in range(3)],
                },
            },
            "2026-10-25": {
                "user_summary": {"totalSteps": 11200, "averageStressLevel": 21, "restStressDuration": 43200},
                "stress": {
                    "stressValuesArray": [[new_ms + i * 900_000, 18 + i] for i in range(3)],
                    "bodyBatteryValuesArray": [[new_ms + i * 900_000, 92 - i * 3] for i in range(3)],
                },
            },
        }
        self.assertEqual(REMOTE_RAW_WELLNESS_DIR, "garmin_archive/raw_wellness")
        mock_storage.write_text_atomic(
            f"{REMOTE_RAW_WELLNESS_DIR}/raw_wellness_2026.json", json.dumps(raw_wellness_2026)
        )

        clean_env = {k: v for k, v in os.environ.items() if not k.startswith("GARMIN_")}
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, clean_env, clear=True):
            tmp_path = Path(tmp)
            staging_dir = tmp_path / ".raw_staging"
            rollup_path = tmp_path / ".staging" / "dashboard_rollup.json"
            enc_path = tmp_path / "dist" / "data.enc"

            with patch("src.ingestion.sync.LiveGarminClient") as mock_live_cls:
                rc = run_sync_pipeline(
                    mock_mode=False,
                    reprocess_archive=True,
                    staging_dir=staging_dir,
                    output_rollup=rollup_path,
                    sftp_client=mock_storage,
                )
                mock_live_cls.assert_not_called()
            self.assertEqual(rc, 0)

            build_and_encrypt_rollup(
                passphrase="offline-reprocess-vault-2026!",
                input_file=rollup_path,
                output_file=enc_path,
                verify=True,
                purge_input=True,
                iterations=1000,
            )

            # Verify zero plaintext leaks
            is_clean, violations = verify_clean_workspace(tmp_path)
            self.assertTrue(is_clean, f"Workspace violations found: {violations}")
            self.assertEqual(ref_scan_directory(str(tmp_path / "dist")), [])

            # Verify decrypted rollup + sharded stream + 14-day intraday retention
            decrypted = json.loads(
                decrypt_payload(enc_path.read_bytes(), "offline-reprocess-vault-2026!", iterations=1000).decode("utf-8")
            )
            gps_act = next(a for a in decrypted["activities"] if a["id"] == "arch_gps_101")
            str_act = next(a for a in decrypted["activities"] if a["id"] == "arch_str_102")
            self.assertIsInstance(gps_act.get("summary_polyline"), str)
            self.assertTrue(gps_act.get("has_streams"))
            self.assertIsNone(gps_act.get("gps_track"))
            self.assertIsNone(str_act.get("summary_polyline"))
            self.assertFalse(str_act.get("has_streams"))
            for forbidden in ("weight", "kg", "load_kg", "tonnage", "weight_kg", "exercise_sets"):
                self.assertNotIn(forbidden, str_act)

            shard_enc = enc_path.parent / "streams" / "arch_gps_101.enc"
            self.assertTrue(shard_enc.exists(), "Sharded GPS stream must be encrypted to dist/streams/arch_gps_101.enc")
            shard_dec = json.loads(
                decrypt_payload(shard_enc.read_bytes(), "offline-reprocess-vault-2026!", iterations=1000).decode("utf-8")
            )
            self.assertIsNotNone(shard_dec.get("gps_track"))

            w_by_date = {w["date"]: w for w in decrypted["wellness"]["daily"]}
            self.assertNotIn("intraday_body_battery", w_by_date["2026-10-05"])
            self.assertNotIn("intraday_stress", w_by_date["2026-10-05"])
            self.assertEqual(len(w_by_date["2026-10-25"]["intraday_body_battery"]), 3)
            self.assertEqual(len(w_by_date["2026-10-25"]["intraday_stress"]), 3)

    # =========================================================================
    # Tier 5: Hardening Regression Tests (Challenger A Findings 1-5)
    # =========================================================================

    def test_t5_m1_16_garmindb_wellness_zero_values_preserved(self):
        with tempfile.TemporaryDirectory() as tmp:
            gdb_dir = Path(tmp)
            db_path = gdb_dir / "garmin_summary.db"
            conn = sqlite3.connect(str(db_path))
            conn.execute(
                """
                CREATE TABLE days_summary (
                    day TEXT,
                    rhr_avg REAL,
                    rhr REAL,
                    calories_total INTEGER,
                    calories_avg REAL,
                    calories_active INTEGER,
                    calories_active_avg REAL,
                    calories_bmr INTEGER,
                    calories_bmr_avg REAL,
                    sleep_avg TEXT
                )
                """
            )
            conn.execute(
                "INSERT INTO days_summary VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                ("2025-01-01", 0.0, None, 0, None, 0, None, 0, None, "00:00:00"),
            )
            conn.commit()
            conn.close()

            records = extract_garmindb_wellness(gdb_dir)
            self.assertEqual(len(records), 1)
            rec = records[0]
            self.assertEqual(rec["date"], "2025-01-01")
            self.assertEqual(rec["resting_hr"], 0)
            self.assertEqual(rec["daily_calories"], 0)
            self.assertEqual(rec["active_calories"], 0)
            self.assertEqual(rec["bmr_calories"], 0)
            self.assertEqual(rec["sleep_seconds"], 0)

    def test_t5_m1_17_normalize_garmin_activity_dev_api_keys_zero_hr_and_non_numeric(self):
        act = normalize_garmin_activity(
            {
                "summary": {
                    "activityId": "dev_cyc_1",
                    "activityName": "Dev API Ride",
                    "activityType": {"typeKey": "cycling"},
                    "startTimeGMT": "2026-10-10T08:00:00Z",
                    "durationInSeconds": 11190,
                    "movingDurationInSeconds": 11143,
                    "distanceInMeters": 85000,
                    "totalElevationGainInMeters": 828,
                    "averagePowerInWatts": 197,
                    "activeKilocalories": 2314,
                    "averageHR": 0,
                    "maxHR": 0,
                },
                "details": {},
            }
        )
        self.assertEqual(act["duration_seconds"], 11190)
        self.assertEqual(act["moving_time_seconds"], 11143)
        self.assertEqual(act["elevation_gain_meters"], 828)
        self.assertEqual(act["avg_power"], 197)
        self.assertEqual(act["avg_power_watts"], 197)
        self.assertEqual(act["calories"], 2314)
        self.assertEqual(act["avg_hr"], 0)
        self.assertEqual(act["max_hr"], 0)

        # Non-numeric strings must not raise ValueError
        bad_act = normalize_garmin_activity(
            {
                "summary": {
                    "activityId": "bad_str_1",
                    "activityType": {"typeKey": "running"},
                    "startTimeGMT": "2026-10-10T09:00:00Z",
                    "duration": "N/A",
                    "distance": "invalid",
                },
                "details": {},
            }
        )
        self.assertEqual(bad_act["duration_seconds"], 0)
        self.assertEqual(bad_act["distance_meters"], 0.0)

    def test_t5_m1_18_decode_polyline_truncated_graceful(self):
        self.assertEqual(decode_polyline("_p~iF"), [])
        self.assertEqual(decode_polyline("_p~iF~ps|U_ulLnnqC_mqN"), [(38.5, -120.2), (40.7, -120.95)])

        norm = normalize_garmin_activity(
            {
                "summary": {
                    "activityId": "trunc_poly_1",
                    "activityType": {"typeKey": "running"},
                    "startTimeGMT": "2026-10-10T09:00:00Z",
                    "duration": 1800,
                },
                "details": {"geoPolylineDTO": {"polyline": "_p~iF"}},
            }
        )
        self.assertEqual(norm["id"], "trunc_poly_1")

    def test_t5_m1_19_compile_rollup_explicit_none_numeric_fields(self):
        rollup = compile_rollup(
            [
                {
                    "id": "none_act",
                    "date": "2026-10-01T08:00:00Z",
                    "sport": "running",
                    "distance_meters": None,
                    "duration_seconds": None,
                    "moving_time_seconds": None,
                    "calories": None,
                    "avg_hr": None,
                    "max_hr": None,
                    "avg_cadence": None,
                    "elevation_gain_meters": None,
                }
            ]
        )
        self.assertEqual(len(rollup["activities"]), 1)
        act = rollup["activities"][0]
        self.assertEqual(act["distance_meters"], 0.0)
        self.assertEqual(act["duration_seconds"], 0)
        self.assertEqual(act["moving_time_seconds"], 0)
        self.assertEqual(act["calories"], 0)
        self.assertEqual(act["avg_hr"], 0)
        self.assertEqual(act["max_hr"], 0)
        self.assertEqual(act["avg_cadence"], 0)
        self.assertEqual(act["elevation_gain_meters"], 0)

    def test_t5_m1_20_stream_recovery_across_year_month_boundary(self):
        mock_storage = MockSFTPClient()
        # Archived under startTimeLocal (2026/01) while start_time in index is startTimeGMT (2025-12-31T23:30:00Z)
        summary_payload = {
            "summary": {
                "activityId": "yb_1",
                "activityName": "New Year Eve Run",
                "activityType": {"typeKey": "running"},
                "startTimeGMT": "2025-12-31T23:30:00Z",
                "startTimeLocal": "2026-01-01T00:30:00",
                "duration": 1800,
                "distance": 5000,
            },
            "details": {
                "geoPolylineDTO": {
                    "polyline": [
                        {"lat": 47.37, "lon": 8.54, "altitude": 410},
                        {"lat": 47.38, "lon": 8.55, "altitude": 420},
                    ]
                }
            },
        }
        mock_storage.write_text_atomic(
            "garmin_archive/activities/2026/01/yb_1_summary.json",
            json.dumps(summary_payload),
        )
        mock_storage.write_text_atomic(
            REMOTE_INDEX_PATH,
            json.dumps(
                [
                    {
                        "id": "yb_1",
                        "date": "2025-12-31T23:30:00Z",
                        "start_time": "2025-12-31T23:30:00Z",
                        "sport": "running",
                        "title": "New Year Eve Run",
                        "distance_meters": 5000.0,
                        "duration_seconds": 1800,
                        "moving_time_seconds": 1800,
                        "calories": 320,
                        "avg_hr": 145,
                        "max_hr": 165,
                        "has_streams": False,
                        "summary_polyline": None,
                    }
                ]
            ),
        )
        mock_storage.write_text_atomic(REMOTE_MANIFEST_PATH, json.dumps({"synced_ids": ["yb_1"]}))
        mock_storage.write_text_atomic(REMOTE_WELLNESS_PATH, json.dumps([]))

        class EmptyFakeGarmin:
            def get_activities(self, *args, **kwargs):
                return []

            def get_raw_daily_wellness_bundle(self, *args, **kwargs):
                return None

        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            rollup_path = tmp_path / ".staging" / "dashboard_rollup.json"
            rc = run_sync_pipeline(
                mock_mode=False,
                reprocess_archive=False,
                lookback_days=1,
                staging_dir=tmp_path / ".raw_staging",
                output_rollup=rollup_path,
                sftp_client=mock_storage,
                garmin_client=EmptyFakeGarmin(),
            )
            self.assertEqual(rc, 0)
            rollup = json.loads(rollup_path.read_text(encoding="utf-8"))
            act = next(a for a in rollup["activities"] if a["id"] == "yb_1")
            self.assertTrue(act["has_streams"])
            self.assertIsInstance(act["summary_polyline"], str)
            self.assertTrue((rollup_path.parent / "streams" / "yb_1.json").exists())


if __name__ == "__main__":
    unittest.main()
