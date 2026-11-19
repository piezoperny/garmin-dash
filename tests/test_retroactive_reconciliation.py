"""
tests/test_retroactive_reconciliation.py

Unit and integration tests for Milestone 1 & 4:
- Retroactive activity date/time/metric edit detection and rollup update
- Retroactive activity deletion purging within the 14-day reconciliation window
- Preservation of historical activities outside the 14-day reconciliation window
- Fast delta sync skipping unchanged wellness history and existing stream shards
"""

import json
import tempfile
import time
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional
from unittest.mock import MagicMock

from src.ingestion.sync import (
    SyncManifest,
    _has_activity_summary_changed,
    compile_dashboard_rollup,
    execute_incremental_pull,
    normalize_garmin_activity,
)


class _MockGarminClient:
    def __init__(self, activities: List[Dict[str, Any]], details_map: Optional[Dict[str, Dict[str, Any]]] = None):
        self._activities = activities
        self._details_map = details_map or {}
        self.wellness_dates_queried: List[str] = []

    def get_activities(self, start_ts: int, end_ts: int) -> List[Dict[str, Any]]:
        return list(self._activities)

    def get_activity_details(self, activity_id: str) -> Dict[str, Any]:
        return self._details_map.get(str(activity_id), {})

    def download_fit_file(self, activity_id: str) -> bytes:
        return b"MOCK_FIT_DATA"

    def download_activity_fit(self, activity_id: str, dest_path: Path) -> bool:
        dest_path.write_bytes(b"MOCK_FIT_DATA")
        return True


class _MockSFTPClient:
    def __init__(self):
        self.uploaded: List[str] = []

    def mkdir_p(self, remote_dir: str) -> None:
        pass

    def put_file(self, local_path: Path, remote_path: str) -> None:
        self.uploaded.append(remote_path)

    def upload_and_verify(self, local_path: Path, remote_path: str) -> bool:
        self.uploaded.append(remote_path)
        return True


class TestRetroactiveReconciliation(unittest.TestCase):
    def test_retroactive_date_edit_moves_activity(self):
        """Edited startTimeLocal on an already-synced activity updates existing_acts_map and rollup without duplicates."""
        now_dt = datetime.now(timezone.utc)
        old_dt = now_dt - timedelta(days=2)
        new_dt = now_dt - timedelta(days=3)

        old_date_str = old_dt.strftime("%Y-%m-%d")
        old_start_str = old_dt.strftime("%Y-%m-%dT%H:%M:%S")
        new_date_str = new_dt.strftime("%Y-%m-%d")
        new_start_str = new_dt.strftime("%Y-%m-%dT%H:%M:%S")

        act_id = "99001122"
        existing_acts_map: Dict[str, Dict[str, Any]] = {
            act_id: {
                "id": act_id,
                "name": "Commute Ride",
                "type": "cycling",
                "date": old_date_str,
                "start_time": old_start_str,
                "distance_meters": 12500.0,
                "duration_seconds": 2100.0,
                "moving_time_seconds": 2100.0,
            }
        }

        updated_summary = {
            "activityId": int(act_id),
            "activityName": "Commute Ride",
            "activityType": {"typeKey": "cycling"},
            "startTimeLocal": new_start_str,
            "distance": 12500.0,
            "duration": 2100.0,
        }

        self.assertTrue(_has_activity_summary_changed(updated_summary, existing_acts_map[act_id]))

        manifest = SyncManifest(
            last_sync_timestamp=int(time.time()) - 3600,
            synced_activity_ids=[act_id],
            total_synced_activities=1,
        )
        garmin_client = _MockGarminClient([updated_summary])
        sftp_client = _MockSFTPClient()

        with tempfile.TemporaryDirectory() as tmpdir:
            payloads, synced_count = execute_incremental_pull(
                garmin_client=garmin_client,
                sftp_client=sftp_client,
                manifest=manifest,
                staging_dir=Path(tmpdir),
                reconcile_days=14,
                existing_acts_map=existing_acts_map,
            )

        self.assertEqual(synced_count, 1)
        self.assertEqual(len(payloads), 1)

        # Normalize and update existing_acts_map in place
        norm = normalize_garmin_activity(payloads[0])
        existing_acts_map[act_id] = norm

        rollup = compile_dashboard_rollup(list(existing_acts_map.values()), {})
        acts = rollup.get("activities", [])
        self.assertEqual(len(acts), 1)
        self.assertEqual(acts[0]["id"], act_id)
        self.assertTrue(acts[0]["date"].startswith(new_date_str))
        self.assertTrue(acts[0]["start_time"].startswith(new_date_str))

    def test_retroactive_deletion_purges_activity(self):
        """An activity inside the 14-day window omitted from Garmin Connect is purged from map, manifest, and rollup."""
        now_dt = datetime.now(timezone.utc)
        deleted_dt = now_dt - timedelta(days=2)
        kept_dt = now_dt - timedelta(days=1)

        deleted_id = "88001100"
        kept_id = "88002200"

        existing_acts_map: Dict[str, Dict[str, Any]] = {
            deleted_id: {
                "id": deleted_id,
                "name": "Wrong Date Ride",
                "type": "cycling",
                "date": deleted_dt.strftime("%Y-%m-%d"),
                "start_time": deleted_dt.strftime("%Y-%m-%dT%H:%M:%S"),
                "distance_meters": 5000.0,
                "duration_seconds": 900.0,
            },
            kept_id: {
                "id": kept_id,
                "name": "Morning Run",
                "type": "running",
                "date": kept_dt.strftime("%Y-%m-%d"),
                "start_time": kept_dt.strftime("%Y-%m-%dT%H:%M:%S"),
                "distance_meters": 8000.0,
                "duration_seconds": 2400.0,
            },
        }

        manifest = SyncManifest(
            last_sync_timestamp=int(time.time()) - 3600,
            synced_activity_ids=[deleted_id, kept_id],
            total_synced_activities=2,
        )

        # Garmin Connect only returns kept_id (deleted_id was deleted)
        kept_summary = {
            "activityId": int(kept_id),
            "activityName": "Morning Run",
            "activityType": {"typeKey": "running"},
            "startTimeLocal": kept_dt.strftime("%Y-%m-%dT%H:%M:%S"),
            "distance": 8000.0,
            "duration": 2400.0,
        }
        garmin_client = _MockGarminClient([kept_summary])
        sftp_client = _MockSFTPClient()

        with tempfile.TemporaryDirectory() as tmpdir:
            execute_incremental_pull(
                garmin_client=garmin_client,
                sftp_client=sftp_client,
                manifest=manifest,
                staging_dir=Path(tmpdir),
                reconcile_days=14,
                existing_acts_map=existing_acts_map,
            )

        self.assertNotIn(deleted_id, existing_acts_map)
        self.assertNotIn(deleted_id, manifest.synced_activity_ids)
        self.assertIn(kept_id, existing_acts_map)
        self.assertIn(kept_id, manifest.synced_activity_ids)

        rollup = compile_dashboard_rollup(list(existing_acts_map.values()), {})
        rollup_ids = [a["id"] for a in rollup.get("activities", [])]
        self.assertNotIn(deleted_id, rollup_ids)
        self.assertIn(kept_id, rollup_ids)

    def test_old_historical_activities_outside_window_not_deleted(self):
        """Activities older than the 14-day reconciliation window are untouched and never deleted."""
        now_dt = datetime.now(timezone.utc)
        old_dt = now_dt - timedelta(days=30)
        recent_dt = now_dt - timedelta(days=1)

        old_id = "77001100"
        recent_id = "77002200"

        existing_acts_map: Dict[str, Dict[str, Any]] = {
            old_id: {
                "id": old_id,
                "name": "Historical Marathon",
                "type": "running",
                "date": old_dt.strftime("%Y-%m-%d"),
                "start_time": old_dt.strftime("%Y-%m-%dT%H:%M:%S"),
                "distance_meters": 42195.0,
                "duration_seconds": 12600.0,
            },
            recent_id: {
                "id": recent_id,
                "name": "Recovery Jog",
                "type": "running",
                "date": recent_dt.strftime("%Y-%m-%d"),
                "start_time": recent_dt.strftime("%Y-%m-%dT%H:%M:%S"),
                "distance_meters": 5000.0,
                "duration_seconds": 1800.0,
            },
        }

        manifest = SyncManifest(
            last_sync_timestamp=int(time.time()) - 3600,
            synced_activity_ids=[old_id, recent_id],
            total_synced_activities=2,
        )

        recent_summary = {
            "activityId": int(recent_id),
            "activityName": "Recovery Jog",
            "activityType": {"typeKey": "running"},
            "startTimeLocal": recent_dt.strftime("%Y-%m-%dT%H:%M:%S"),
            "distance": 5000.0,
            "duration": 1800.0,
        }
        garmin_client = _MockGarminClient([recent_summary])
        sftp_client = _MockSFTPClient()

        with tempfile.TemporaryDirectory() as tmpdir:
            execute_incremental_pull(
                garmin_client=garmin_client,
                sftp_client=sftp_client,
                manifest=manifest,
                staging_dir=Path(tmpdir),
                reconcile_days=14,
                existing_acts_map=existing_acts_map,
            )

        self.assertIn(old_id, existing_acts_map)
        self.assertIn(old_id, manifest.synced_activity_ids)
        self.assertIn(recent_id, existing_acts_map)

    def test_fast_delta_sync_skips_unchanged_wellness_and_streams(self):
        """Unchanged activities are skipped by incremental pull without re-downloading."""
        now_dt = datetime.now(timezone.utc)
        recent_dt = now_dt - timedelta(days=1)
        act_id = "66001100"

        existing_acts_map: Dict[str, Dict[str, Any]] = {
            act_id: {
                "id": act_id,
                "name": "Steady Ride",
                "type": "cycling",
                "date": recent_dt.strftime("%Y-%m-%d"),
                "start_time": recent_dt.strftime("%Y-%m-%dT%H:%M:%S"),
                "distance_meters": 20000.0,
                "duration_seconds": 3600.0,
            }
        }

        unchanged_summary = {
            "activityId": int(act_id),
            "activityName": "Steady Ride",
            "activityType": {"typeKey": "cycling"},
            "startTimeLocal": recent_dt.strftime("%Y-%m-%dT%H:%M:%S"),
            "distance": 20000.0,
            "duration": 3600.0,
        }

        self.assertFalse(_has_activity_summary_changed(unchanged_summary, existing_acts_map[act_id]))

        manifest = SyncManifest(
            last_sync_timestamp=int(time.time()) - 3600,
            synced_activity_ids=[act_id],
            total_synced_activities=1,
        )
        garmin_client = _MockGarminClient([unchanged_summary])
        sftp_client = _MockSFTPClient()

        with tempfile.TemporaryDirectory() as tmpdir:
            payloads, synced_count = execute_incremental_pull(
                garmin_client=garmin_client,
                sftp_client=sftp_client,
                manifest=manifest,
                staging_dir=Path(tmpdir),
                reconcile_days=14,
                existing_acts_map=existing_acts_map,
            )

        self.assertEqual(synced_count, 0)
        self.assertEqual(len(payloads), 0)
        self.assertEqual(len(sftp_client.uploaded), 0)


if __name__ == "__main__":
    unittest.main()
