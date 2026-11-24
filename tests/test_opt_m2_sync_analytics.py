"""
tests/test_opt_m2_sync_analytics.py

Unit tests for Milestone M2: Garmin API, Delta Sync & Analytics optimizations:
1. src/ingestion/sync.py
2. src/ingestion/garmin_client.py
3. src/analytics/training_load.py
4. src/ingestion/mock_generator.py
"""

from __future__ import annotations

import json
import tempfile
import unittest
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List
from unittest.mock import MagicMock, patch

from src.analytics.training_load import calculate_continuous_training_load
from src.ingestion.garmin_client import (
    LiveGarminClient,
    MemoryTokenStore,
    OAuthSessionState,
    SFTPTokenStore,
)
from src.ingestion.mock_generator import compile_rollup
from src.ingestion.sftp_client import MockSFTPClient
from src.ingestion.sync import (
    SyncManifest,
    _has_activity_summary_changed,
    derive_athlete_profile,
    execute_incremental_pull,
    normalize_garmin_activity,
    parse_garmin_activity_detail_metrics,
    reprocess_canonical_activities,
    run_sync_pipeline,
)


class _FakeHttpError(Exception):
    def __init__(self, status_code: int, retry_after: str | None = None):
        super().__init__(f"HTTP {status_code}")
        self.response = MagicMock()
        self.response.status_code = status_code
        self.response.headers = {"Retry-After": retry_after} if retry_after is not None else {}


class TestSyncM2(unittest.TestCase):
    def test_has_activity_summary_changed_normalizes_utc_minute(self):
        summary = {
            "activityId": 101,
            "activityName": "Morning Run",
            "startTimeGMT": "2026-10-20 07:30:45",
            "startTimeLocal": "2026-10-20 09:30:45",
            "distance": 10000.0,
            "duration": 2700.0,
        }
        existing = {
            "id": "101",
            "title": "Morning Run",
            "start_time": "2026-10-20T07:30:00Z",
            "distance_meters": 10000.0,
            "duration_seconds": 2700,
        }
        self.assertFalse(_has_activity_summary_changed(summary, existing))

        # Offset timestamp converting to same UTC minute should also match
        summary_offset = dict(summary, startTimeGMT="2026-10-20T09:30:12+02:00")
        self.assertFalse(_has_activity_summary_changed(summary_offset, existing))

        # Different minute should trigger change
        summary_changed = dict(summary, startTimeGMT="2026-10-20 07:35:00")
        self.assertTrue(_has_activity_summary_changed(summary_changed, existing))

    def test_execute_incremental_pull_skips_indoor_gpx_and_passes_extended_flag(self):
        calls: Dict[str, List[Any]] = {"details": [], "gpx": []}

        class _StubClient:
            def get_activities(self, start_ts: int, end_ts: int) -> List[Dict[str, Any]]:
                return [
                    {
                        "activityId": "1",
                        "activityName": "Bench & Squats",
                        "activityType": {"typeKey": "strength_training"},
                        "startTimeGMT": "2026-10-20T08:00:00Z",
                        "hasPolyline": False,
                    },
                    {
                        "activityId": "2",
                        "activityName": "Zwift Ride",
                        "activityType": {"typeKey": "indoor_cycling"},
                        "startTimeGMT": "2026-10-21T08:00:00Z",
                        "hasPolyline": False,
                    },
                    {
                        "activityId": "3",
                        "activityName": "Treadmill",
                        "activityType": {"typeKey": "treadmill_running"},
                        "startTimeGMT": "2026-10-22T08:00:00Z",
                        "hasPolyline": False,
                    },
                    {
                        "activityId": "4",
                        "activityName": "Morning Yoga",
                        "activityType": {"typeKey": "yoga"},
                        "startTimeGMT": "2026-10-23T08:00:00Z",
                        "hasPolyline": False,
                    },
                    {
                        "activityId": "5",
                        "activityName": "Outdoor Trail",
                        "activityType": {"typeKey": "trail_running"},
                        "startTimeGMT": "2026-10-24T08:00:00Z",
                        "hasPolyline": True,
                    },
                ]

            def get_activity_details(self, activity_id: str, include_extended_details: bool = True) -> Dict[str, Any]:
                calls["details"].append((activity_id, include_extended_details))
                return {}

            def download_fit_file(self, activity_id: str) -> bytes:
                return b"FIT"

            def download_gpx_file(self, activity_id: str) -> bytes:
                calls["gpx"].append(activity_id)
                return b"<gpx></gpx>"

        manifest = SyncManifest()
        sftp = MockSFTPClient()
        with tempfile.TemporaryDirectory() as tmp:
            execute_incremental_pull(
                garmin_client=_StubClient(),
                sftp_client=sftp,
                manifest=manifest,
                staging_dir=Path(tmp),
                archive_individual_files=False,
            )

        self.assertEqual(calls["gpx"], ["5"])
        self.assertTrue(all(ext is False for _, ext in calls["details"]))

    def test_reprocess_preserves_garmin_tss_and_strength_hr_stream(self):
        acts = [
            {
                "id": "a_garmin_tss",
                "sport": "running",
                "duration_seconds": 3600,
                "distance_meters": 10000.0,
                "avg_hr": 150,
                "tss": 88.4,
                "training_stress_score": 88.4,
                "tss_source": "garmin",
            },
            {
                "id": "a_strength",
                "sport": "strength",
                "duration_seconds": 2400,
                "avg_hr": 120,
                "telemetry_stream": {"time": [0, 60, 120], "hr": [110, 125, 130], "elevation": [10, 10, 10]},
                "gps_track": {"polyline": "abc"},
                "exercise_sets": [{"weight": 100}],
            },
        ]
        res = reprocess_canonical_activities(acts)
        by_id = {a["id"]: a for a in res}
        self.assertEqual(by_id["a_garmin_tss"]["tss"], 88.4)
        self.assertEqual(by_id["a_garmin_tss"]["tss_source"], "garmin")

        st = by_id["a_strength"]
        self.assertIsNone(st["gps_track"])
        self.assertIsNone(st["summary_polyline"])
        self.assertNotIn("exercise_sets", st)
        self.assertTrue(st["has_streams"])
        self.assertEqual(st["telemetry_stream"], {"time": [0, 60, 120], "hr": [110, 125, 130]})

    def test_normalize_garmin_activity_missing_hr_is_none(self):
        act = normalize_garmin_activity({
            "summary": {
                "activityId": 777,
                "activityName": "Swim",
                "activityType": {"typeKey": "lap_swimming"},
                "duration": 1800,
                "distance": 1500,
            }
        })
        self.assertIsNone(act["avg_hr"])
        self.assertIsNone(act["max_hr"])

    def test_parse_detail_metrics_power_and_distance_carry_forward(self):
        details = {
            "metricDescriptors": [
                {"metricsIndex": 0, "key": "directTimestamp"},
                {"metricsIndex": 1, "key": "directPower"},
                {"metricsIndex": 2, "key": "directDistance"},
            ],
            "activityDetailMetrics": [
                {"metrics": [0, 210.0, 100.0]},
                {"metrics": [1, 225.0, None]},
                {"metrics": [2, 240.0, 350.0]},
            ],
        }
        stream = parse_garmin_activity_detail_metrics(details, dur_sec=3)
        self.assertIsNotNone(stream)
        self.assertEqual(stream["power"], [210.0, 225.0, 240.0])
        self.assertEqual(stream["distance"], [100.0, 100.0, 350.0])

    def test_derive_athlete_profile(self):
        wellness = [
            {"date": f"2026-10-{d:02d}", "resting_hr": 44 + (d % 3), "vo2max_running": 56.2 if d == 20 else 55.0}
            for d in range(1, 21)
        ]
        # 20-min power stream at 300W -> 300 * 0.95 = 285W FTP
        activities = [
            {"id": "r1", "sport": "running", "max_hr": 186, "duration_seconds": 1800},
            {
                "id": "c1",
                "sport": "cycling",
                "max_hr": 194,
                "duration_seconds": 1500,
                "telemetry_stream": {
                    "time": [0, 600, 1200, 1500],
                    "power": [300, 300, 300, 200],
                },
            },
        ]
        profile = derive_athlete_profile(activities, wellness)
        self.assertEqual(profile["rest_hr"], 45)
        self.assertEqual(profile["vo2max"], 56.2)
        self.assertEqual(profile["max_hr"], 194)
        self.assertEqual(profile["ftp"], 285)
        self.assertEqual(profile["cycling_ftp"], 285)

    def test_vault_manifest_content_hashes_skip_unchanged_upload(self):
        from src.storage.parquet_vault import ParquetVault, VaultManifest

        # Subclass VaultManifest with content_hashes field
        class _HashedVaultManifest(VaultManifest):
            content_hashes: Dict[str, str] = {}

        sftp = MockSFTPClient()
        put_calls: List[str] = []
        orig_put = sftp.put_file

        def _tracked_put(local_path: Path, remote_path: str) -> None:
            put_calls.append(remote_path)
            orig_put(local_path, remote_path)

        sftp.put_file = _tracked_put  # type: ignore[method-assign]

        class _StaticClient:
            def get_activities(self, s: int, e: int) -> List[Dict[str, Any]]:
                return []

            def get_activity_details(self, aid: str, include_extended_details: bool = True) -> Dict[str, Any]:
                return {}

            def download_fit_file(self, aid: str) -> bytes:
                return b""

        with tempfile.TemporaryDirectory() as tmp:
            vault_dir = Path(tmp) / "vault_seed"
            seed_vault = ParquetVault(work_dir=vault_dir, storage_client=sftp)
            m = _HashedVaultManifest(last_sync_timestamp=int(datetime.now(timezone.utc).timestamp()))
            seed_vault.save_activities([], push_remote=True)
            seed_vault.save_wellness([], push_remote=True)
            # Populate content_hashes from local files
            from src.ingestion.sync import _file_sha256
            m.content_hashes["activities.parquet"] = _file_sha256(seed_vault.local_activities_path)
            m.content_hashes["wellness.parquet"] = _file_sha256(seed_vault.local_wellness_path)
            seed_vault.save_manifest(m)

            put_calls.clear()
            with patch("src.storage.parquet_vault.ParquetVault.load_manifest", return_value=m):
                rc = run_sync_pipeline(
                    mock_mode=False,
                    storage_backend="parquet",
                    sftp_client=sftp,
                    garmin_client=_StaticClient(),
                    staging_dir=Path(tmp) / "staging",
                    output_rollup=Path(tmp) / "rollup.json",
                )
            self.assertEqual(rc, 0)
            # Neither activities.parquet nor wellness.parquet should be re-uploaded
            self.assertNotIn("garmin_archive/vault/activities.parquet", put_calls)
            self.assertNotIn("garmin_archive/vault/wellness.parquet", put_calls)


class TestGarminClientM2(unittest.TestCase):
    def test_safe_personal_call_retries_429_and_5xx(self):
        session = OAuthSessionState(
            access_token="tok",
            refresh_token="ref",
            expires_at=int(datetime.now(timezone.utc).timestamp()) + 3600,
        )
        client = LiveGarminClient("key", "sec", session_state=session, token_store=MemoryTokenStore())

        attempts = {"count": 0}

        class _PersonalStub:
            def get_sleep_data(self, cdate: str) -> Dict[str, Any]:
                attempts["count"] += 1
                if attempts["count"] == 1:
                    raise _FakeHttpError(429, retry_after="0")
                if attempts["count"] == 2:
                    raise _FakeHttpError(503)
                return {"dailySleepDTO": {"sleepTimeSeconds": 28000}}

        client._personal_garmin = _PersonalStub()
        with patch("time.sleep", return_value=None):
            res = client._safe_personal_call("get_sleep_data", "2026-10-20")
        self.assertEqual(attempts["count"], 3)
        self.assertEqual(res["dailySleepDTO"]["sleepTimeSeconds"], 28000)

    def test_authenticated_request_reuses_session_and_retries_5xx(self):
        session = OAuthSessionState(
            access_token="tok",
            refresh_token="ref",
            expires_at=int(datetime.now(timezone.utc).timestamp()) + 3600,
        )
        client = LiveGarminClient("key", "sec", session_state=session, token_store=MemoryTokenStore())

        resp_502 = MagicMock(status_code=502, headers={}, text="Bad Gateway")
        resp_200 = MagicMock(status_code=200, headers={}, json=lambda: {"ok": True})
        fake_session = MagicMock()
        fake_session.request.side_effect = [resp_502, resp_200]
        client._http_session = fake_session

        with patch("time.sleep", return_value=None):
            resp = client._authenticated_request("GET", "https://example.test/api")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(fake_session.request.call_count, 2)

    def test_get_activity_details_skips_extended_when_false(self):
        session = OAuthSessionState(
            access_token="tok",
            refresh_token="ref",
            expires_at=int(datetime.now(timezone.utc).timestamp()) + 3600,
        )
        client = LiveGarminClient("key", "sec", session_state=session, token_store=MemoryTokenStore())
        called: List[str] = []

        class _PersonalStub:
            def get_activity_splits(self, aid: str) -> Dict[str, Any]:
                called.append("splits")
                return {"lapDTOs": []}

            def get_activity_details(self, aid: str, maxchart: int = 2000, maxpoly: int = 4000) -> Dict[str, Any]:
                called.append("details")
                return {}

            def get_activity_hr_in_timezones(self, aid: str) -> List[Dict[str, Any]]:
                called.append("hr_zones")
                return []

            def get_activity_typed_splits(self, aid: str) -> Dict[str, Any]:
                called.append("typed_splits")
                return {}

            def get_activity_weather(self, aid: str) -> Dict[str, Any]:
                called.append("weather")
                return {}

        client._personal_garmin = _PersonalStub()
        res = client.get_activity_details("act_1", include_extended_details=False)
        self.assertIsNotNone(res)
        self.assertEqual(called, ["splits", "details", "hr_zones"])
        self.assertNotIn("typed_splits", res)
        self.assertNotIn("weather", res)

    def test_get_wellness_range_bundles_batches_and_parallelizes(self):
        session = OAuthSessionState(
            access_token="tok",
            refresh_token="ref",
            expires_at=int(datetime.now(timezone.utc).timestamp()) + 3600,
        )
        client = LiveGarminClient("key", "sec", session_state=session, token_store=MemoryTokenStore())
        bb_calls: List[tuple] = []
        bc_calls: List[tuple] = []

        class _PersonalStub:
            def get_body_battery(self, s: str, e: str | None = None) -> List[Dict[str, Any]]:
                bb_calls.append((s, e))
                return [
                    {"date": "2026-10-20", "charged": 60, "drained": 40},
                    {"date": "2026-10-21", "charged": 70, "drained": 35},
                ]

            def get_body_composition(self, s: str, e: str | None = None) -> Dict[str, Any]:
                bc_calls.append((s, e))
                return {
                    "dateWeightList": [
                        {"calendarDate": "2026-10-20", "weight": 70500},
                        {"calendarDate": "2026-10-21", "weight": 70200},
                    ]
                }

            def get_user_summary(self, cdate: str) -> Dict[str, Any]:
                return {"totalSteps": 9000, "restingHeartRate": 47}

        client._personal_garmin = _PersonalStub()
        bundles = client.get_wellness_range_bundles("2026-10-20", "2026-10-21", max_workers=4)
        self.assertEqual(len(bb_calls), 1)
        self.assertEqual(len(bc_calls), 1)
        self.assertIn("2026-10-20", bundles)
        self.assertIn("2026-10-21", bundles)
        self.assertEqual(bundles["2026-10-20"]["body_composition"]["totalAverage"]["weight"], 70500)

    def test_sftp_token_store_skips_unchanged_write(self):
        sftp = MockSFTPClient()
        writes: List[str] = []
        orig_write = sftp.write_text_atomic

        def _tracked_write(path: str, content: str) -> None:
            writes.append(path)
            orig_write(path, content)

        sftp.write_text_atomic = _tracked_write  # type: ignore[method-assign]
        store = SFTPTokenStore(sftp)
        s1 = OAuthSessionState(access_token="a1", refresh_token='{"files":{"t":"1"}}', expires_at=9999999999)
        store.save_session(s1)
        self.assertEqual(len(writes), 1)

        # New OAuthSessionState with updated_at/expires_at different, but same tokenstore payload
        s2 = OAuthSessionState(access_token="a1", refresh_token='{"files":{"t":"1"}}', expires_at=9999999999 + 100)
        store.save_session(s2)
        self.assertEqual(len(writes), 1)


class TestTrainingLoadM2(unittest.TestCase):
    def test_end_date_decays_atl_ctl_through_today(self):
        acts = [
            {"id": "1", "start_time": "2026-10-01T08:00:00Z", "sport": "running", "tss": 100.0},
        ]
        res = calculate_continuous_training_load(
            acts,
            initial_atl=50.0,
            initial_ctl=50.0,
            end_date=date(2026, 10, 10),
        )
        self.assertEqual(len(res["daily"]), 10)
        self.assertEqual(res["daily"][-1]["date"], "2026-10-10")
        self.assertLess(res["daily"][-1]["atl"], res["daily"][0]["atl"])

    def test_span_over_42_days_starts_from_zero(self):
        acts = [
            {"id": "1", "start_time": "2026-08-01T08:00:00Z", "sport": "running", "tss": 70.0},
            {"id": "2", "start_time": "2026-10-01T08:00:00Z", "sport": "running", "tss": 70.0},
        ]
        res = calculate_continuous_training_load(acts, end_date=date(2026, 10, 1))
        # Day 1 ATL = 0 + (70 - 0)/7 = 10.0, CTL = 0 + (70 - 0)/42 = 1.7
        self.assertEqual(res["daily"][0]["atl"], 10.0)
        self.assertEqual(res["daily"][0]["ctl"], 1.7)

    def test_weekly_agg_single_round(self):
        acts = [
            {"id": "1", "start_time": "2026-10-19T08:00:00Z", "sport": "running", "distance_meters": 1040.0, "duration_seconds": 360, "tss": 10.04},
            {"id": "2", "start_time": "2026-10-20T08:00:00Z", "sport": "running", "distance_meters": 1040.0, "duration_seconds": 360, "tss": 10.04},
            {"id": "3", "start_time": "2026-10-21T08:00:00Z", "sport": "running", "distance_meters": 1040.0, "duration_seconds": 360, "tss": 10.04},
        ]
        res = calculate_continuous_training_load(acts, end_date=date(2026, 10, 21))
        w = res["weekly"][0]
        # 1.04 * 3 = 3.12 -> 3.1 (old repeated rounding would give 1.0+1.0+1.0=3.0)
        self.assertEqual(w["run_km"], 3.1)
        # 10.04 * 3 = 30.12 -> 30.1 (old repeated rounding would give 10.0+10.0+10.0=30.0)
        self.assertEqual(w["load"], 30.1)


class TestMockGeneratorM2(unittest.TestCase):
    def test_z5_reconciliation_does_not_inflate_or_negate_z5(self):
        acts = [
            {
                "id": "gap_act",
                "start_time": "2026-10-20T08:00:00Z",
                "sport": "running",
                "duration_seconds": 3600,
                "moving_time_seconds": 3600,
                "distance_meters": 10000.0,
                "avg_hr": 140,
                "max_hr": 165,
                "hr_zones": {"z1": 600, "z2": 600, "z3": 300, "z4": 100, "z5": 50},
            },
            {
                "id": "over_act",
                "start_time": "2026-10-21T08:00:00Z",
                "sport": "running",
                "duration_seconds": 1000,
                "moving_time_seconds": 1000,
                "distance_meters": 3000.0,
                "avg_hr": 140,
                "max_hr": 165,
                "hr_zones": {"z1": 500, "z2": 500, "z3": 200, "z4": 100, "z5": 10},
            },
        ]
        rollup = compile_rollup(acts)
        hz = {z["zone"]: z["seconds"] for z in rollup["physiological"]["heart_rate_zones"]}
        # Z5 must stay 50 + 10 = 60 (not inflated by 1950s gap or negated by -310s)
        self.assertEqual(hz["Z5"], 60)
        self.assertGreaterEqual(hz["Z1"], 600 + 500 + 1950)

    def test_power_and_pace_zones_from_streams_and_dynamic_storage_provider(self):
        acts = [
            {
                "id": "c1",
                "start_time": "2026-10-20T08:00:00Z",
                "sport": "cycling",
                "duration_seconds": 1000,
                "moving_time_seconds": 1000,
                "distance_meters": 8000.0,
                "avg_power": 250,
                "telemetry_stream": {"power": [250, 250, 250, 250]},
            },
            {
                "id": "r1",
                "start_time": "2026-10-21T08:00:00Z",
                "sport": "running",
                "duration_seconds": 1000,
                "moving_time_seconds": 1000,
                "distance_meters": 3000.0,
                "telemetry_stream": {"speed": [3.0, 3.0, 3.0, 3.0]},  # 333.3 sec/km -> Interval
            },
        ]
        rollup = compile_rollup(acts, storage_provider="Google Drive")
        self.assertEqual(rollup["backup_vault"]["storage_provider"], "Google Drive")
        self.assertFalse(rollup["physiological"]["power_zones_estimated"])
        self.assertFalse(rollup["physiological"]["pace_zones_estimated"])
        pace_map = {p["zone"]: p["seconds"] for p in rollup["physiological"]["pace_zones"]}
        self.assertEqual(pace_map["Interval"], 1000)


if __name__ == "__main__":
    unittest.main()
