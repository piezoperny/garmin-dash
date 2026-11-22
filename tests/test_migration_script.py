"""
tests/test_migration_script.py
Tests for manual non-destructive migration CLI (src/storage/migrate.py)
and automatic Parquet backend detection after upload.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.ingestion.garmin_client import MockGarminClient
from src.ingestion.sftp_client import MockSFTPClient
from src.ingestion.sync import run_sync_pipeline
from src.storage.migrate import migrate_local_archive, upload_vault_directory
from src.storage.parquet_vault import PARQUET_VAULT_DIR, ParquetVault, RawZipArchive


def _build_legacy_archive(root: Path) -> Path:
    archive = root / "garmin_archive"
    (archive / "metadata").mkdir(parents=True)
    (archive / "streams" / "2025").mkdir(parents=True)
    (archive / "raw_wellness").mkdir(parents=True)
    (archive / "activities" / "2024" / "11").mkdir(parents=True)
    (archive / "activities" / "2025" / "02").mkdir(parents=True)

    acts_index = [
        {
            "id": "1001",
            "name": "2024 Trail Run",
            "sport": "running",
            "date": "2024-11-15",
            "start_time": "2024-11-15T08:00:00Z",
            "distance_meters": 12000.0,
            "duration_seconds": 3800.0,
            "has_streams": True,
        },
        {
            "id": "2001",
            "name": "2025 Gravel Ride",
            "sport": "cycling",
            "date": "2025-02-10",
            "start_time": "2025-02-10T10:00:00Z",
            "distance_meters": 45000.0,
            "duration_seconds": 5400.0,
            "has_streams": True,
        },
    ]
    (archive / "metadata" / "activities_index.json").write_text(json.dumps(acts_index), encoding="utf-8")
    (archive / "metadata" / "sync_manifest.json").write_text(
        json.dumps({"last_sync_timestamp": 1742032800, "synced_activity_ids": ["1001", "2001"]}),
        encoding="utf-8",
    )
    (archive / "metadata" / "wellness_history.json").write_text(
        json.dumps([{"date": "2024-11-15", "resting_hr": 49, "steps": 8000}]),
        encoding="utf-8",
    )
    (archive / "raw_wellness" / "raw_wellness_2025.json").write_text(
        json.dumps({"2025-02-10": {"resting_hr": 47, "steps": 10500}}),
        encoding="utf-8",
    )

    (archive / "streams" / "streams_2024.json").write_text(
        json.dumps({"1001": {"id": "1001", "telemetry_stream": {"hr": [135, 145]}}}),
        encoding="utf-8",
    )
    (archive / "streams" / "2025" / "2001.json").write_text(
        json.dumps({"id": "2001", "telemetry_stream": {"hr": [130, 140], "power": [200, 220]}}),
        encoding="utf-8",
    )

    (archive / "activities" / "2024" / "11" / "1001.fit").write_bytes(b"FIT_2024_1001")
    (archive / "activities" / "2024" / "11" / "1001.gpx").write_bytes(b"<gpx>1001</gpx>")
    (archive / "activities" / "2025" / "02" / "2001.fit").write_bytes(b"FIT_2025_2001")
    return archive


def test_migrate_local_archive_non_destructive_and_upload(tmp_path: Path):
    archive = _build_legacy_archive(tmp_path / "backup")
    out_vault = tmp_path / "migrated_vault"

    report = migrate_local_archive(archive, out_vault)
    assert report.verified is True
    assert report.source_activities == 2
    assert report.vault_activities == 2
    assert report.source_wellness_days == 2
    assert report.vault_wellness_days == 2
    assert report.source_stream_shards == 2
    assert report.vault_stream_shards == 2
    assert report.source_raw_files == 3
    assert report.vault_raw_files == 3

    # Source files must remain completely untouched
    assert (archive / "activities" / "2024" / "11" / "1001.fit").exists()
    assert (archive / "metadata" / "activities_index.json").exists()

    # Yearly zip archives must contain the exact raw files
    assert RawZipArchive.list_members(out_vault / "raw_2024.zip") == ["1001.fit", "1001.gpx"]
    assert RawZipArchive.list_members(out_vault / "raw_2025.zip") == ["2001.fit"]

    # Upload to MockSFTPClient and verify auto-detection in sync.py
    mock_sftp = MockSFTPClient()
    uploaded = upload_vault_directory(out_vault, mock_sftp)
    assert uploaded >= 6
    assert mock_sftp.file_exists(f"{PARQUET_VAULT_DIR}/vault_manifest.json")

    staging_dir = tmp_path / "run_sync" / ".raw_staging"
    output_rollup = tmp_path / "run_sync" / ".staging" / "dashboard_rollup.json"
    rc = run_sync_pipeline(
        mock_mode=False,
        lookback_days=7,
        staging_dir=staging_dir,
        output_rollup=output_rollup,
        sftp_client=mock_sftp,
        garmin_client=MockGarminClient(seed=11),
        storage_backend="auto",
    )
    assert rc == 0
    rollup = json.loads(output_rollup.read_text(encoding="utf-8"))
    act_ids = {str(a["id"]) for a in rollup["activities"]}
    assert "1001" in act_ids
    assert "2001" in act_ids
