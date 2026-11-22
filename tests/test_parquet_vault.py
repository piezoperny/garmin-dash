"""
tests/test_parquet_vault.py
Unit and integration tests for DuckDB + ZSTD ParquetVault, RawZipArchive,
and Parquet-backed run_sync_pipeline.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.ingestion.garmin_client import MockGarminClient
from src.ingestion.sftp_client import MockSFTPClient
from src.ingestion.sync import run_sync_pipeline
from src.storage.parquet_vault import (
    PARQUET_VAULT_DIR,
    ParquetVault,
    RawZipArchive,
    VaultManifest,
)


def test_raw_zip_archive_append_dedup_and_extract(tmp_path: Path):
    zip_path = tmp_path / "raw_2026.zip"

    updated, total = RawZipArchive.append_files(
        zip_path,
        {"101.fit": b"FIT_BYTES_101", "101.gpx": b"<gpx>101</gpx>"},
    )
    assert updated == 2
    assert total == 2
    assert RawZipArchive.list_members(zip_path) == ["101.fit", "101.gpx"]

    # Re-appending identical bytes should report 0 updates and keep 2 members
    updated2, total2 = RawZipArchive.append_files(zip_path, {"101.fit": b"FIT_BYTES_101"})
    assert updated2 == 0
    assert total2 == 2

    # Appending a new activity preserves existing entries
    updated3, total3 = RawZipArchive.append_files(zip_path, {"102.fit": b"FIT_BYTES_102"})
    assert updated3 == 1
    assert total3 == 3
    assert RawZipArchive.list_members(zip_path) == ["101.fit", "101.gpx", "102.fit"]

    extracted = RawZipArchive.extract_member(zip_path, "101.fit", tmp_path / "out" / "101.fit")
    assert extracted.read_bytes() == b"FIT_BYTES_101"


def test_parquet_vault_roundtrip_and_sql(tmp_path: Path):
    mock_sftp = MockSFTPClient()
    vault = ParquetVault(work_dir=tmp_path / "work", storage_client=mock_sftp)

    activities = [
        {
            "id": "act_1",
            "name": "Morning Run",
            "sport": "running",
            "date": "2026-03-01",
            "start_time": "2026-03-01T07:30:00Z",
            "distance_meters": 10000.0,
            "duration_seconds": 3000.0,
            "moving_time_seconds": 2980.0,
            "elevation_gain_meters": 85.0,
            "avg_hr": 152.0,
            "has_streams": True,
            "gps_track": {"polyline": "abc"},  # should be stripped from activities.parquet
        },
        {
            "id": "act_2",
            "name": "Evening Ride",
            "sport": "cycling",
            "date": "2026-03-02",
            "start_time": "2026-03-02T17:00:00Z",
            "distance_meters": 35000.0,
            "duration_seconds": 4200.0,
            "avg_power": 220.0,
            "has_streams": False,
        },
    ]

    saved_cnt = vault.save_activities(activities, push_remote=True)
    assert saved_cnt == 2
    assert mock_sftp.file_exists(f"{PARQUET_VAULT_DIR}/activities.parquet")

    # Reload into a fresh local work_dir from MockSFTPClient
    vault2 = ParquetVault(work_dir=tmp_path / "work2", storage_client=mock_sftp)
    loaded = vault2.load_activities(pull_remote=True)
    assert len(loaded) == 2
    assert loaded[0]["id"] == "act_1"
    assert "gps_track" not in loaded[0]
    assert loaded[1]["avg_power"] == 220.0

    # Verify DuckDB SQL query over activities.parquet
    sql_res = vault2.query_activities_sql("SELECT sport, SUM(distance_meters) FROM activities GROUP BY sport ORDER BY sport")
    assert sql_res == [("cycling", 35000.0), ("running", 10000.0)]

    # Wellness roundtrip
    wellness = [
        {"date": "2026-03-01", "resting_hr": 48, "sleep_seconds": 27000, "steps": 9500},
        {"date": "2026-03-02", "resting_hr": 47, "sleep_seconds": 28800, "steps": 11200},
    ]
    assert vault.save_wellness(wellness, push_remote=True) == 2
    loaded_w = vault2.load_wellness(pull_remote=True)
    assert len(loaded_w) == 2
    assert loaded_w[1]["resting_hr"] == 47

    # Year-partitioned streams roundtrip
    streams_2026 = {
        "act_1": {
            "id": "act_1",
            "gps_track": {"polyline": "abc"},
            "telemetry_stream": {"hr": [140, 150, 160]},
            "splits": [],
            "laps": [],
            "hr_zones": {},
        }
    }
    assert vault.save_year_streams("2026", streams_2026, push_remote=True) == 1
    assert vault2.list_remote_stream_years() == ["2026"]
    loaded_s = vault2.load_year_streams("2026", pull_remote=True)
    assert loaded_s["act_1"]["telemetry_stream"]["hr"] == [140, 150, 160]


def test_run_sync_pipeline_with_parquet_backend(tmp_path: Path):
    mock_sftp = MockSFTPClient()
    mock_garmin = MockGarminClient(seed=99)

    staging_dir = tmp_path / ".raw_staging"
    output_rollup = tmp_path / ".staging" / "dashboard_rollup.json"

    rc = run_sync_pipeline(
        mock_mode=False,
        lookback_days=3650,
        staging_dir=staging_dir,
        output_rollup=output_rollup,
        sftp_client=mock_sftp,
        garmin_client=mock_garmin,
        storage_backend="parquet",
    )
    assert rc == 0
    assert output_rollup.exists()
    rollup = json.loads(output_rollup.read_text(encoding="utf-8"))
    assert len(rollup["activities"]) > 0

    # Vault files exist in remote storage
    assert mock_sftp.file_exists(f"{PARQUET_VAULT_DIR}/vault_manifest.json")
    assert mock_sftp.file_exists(f"{PARQUET_VAULT_DIR}/activities.parquet")
    assert mock_sftp.file_exists(f"{PARQUET_VAULT_DIR}/wellness.parquet")

    # Individual legacy summary files were NOT uploaded
    assert not mock_sftp.file_exists("garmin_archive/metadata/activities_index.json")

    # Transient .raw_staging and .vault_work must be purged
    assert not staging_dir.exists()
    assert not (tmp_path / ".vault_work").exists()
