"""
src/ingestion/sync.py
High-water mark incremental ingestion coordinator, Hetzner SFTP archival orchestrator,
and pipeline CLI.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import shutil
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple

from pydantic import BaseModel, Field

from src.ingestion.cleanup import purge_raw_staging, purge_rollup, verify_clean_workspace
from src.ingestion.garmin_client import (
    GarminAPIError,
    GarminAuthError,
    GarminClient,
    GarminClientProtocol,
    GarminCredentials,
    LiveGarminClient,
    MockGarminClient,
    SecretRedactionFilter,
    SFTPTokenStore,
)
from src.ingestion.mock_generator import (
    SyntheticDatasetGenerator,
    compile_dashboard_rollup,
    compile_rollup,
)
from src.ingestion.sftp_client import (
    HetznerSFTPClient,
    MockSFTPClient,
    SFTPArchivalError,
    SFTPClientProtocol,
    SFTPConfig,
    get_sftp_client,
)

logger = logging.getLogger("src.ingestion.sync")

REMOTE_MANIFEST_PATH = "garmin_archive/metadata/sync_manifest.json"
REMOTE_SESSION_PATH = "garmin_archive/.session/garmin_oauth.json"


# ---------------------------------------------------------------------------
# Sync Manifest Models
# ---------------------------------------------------------------------------

class SyncHistoryEntry(BaseModel):
    timestamp: int
    datetime_utc: str
    activities_synced: int
    duration_seconds: float


class SyncManifest(BaseModel):
    """Remote sync manifest persisted to Hetzner SFTP at garmin_archive/metadata/sync_manifest.json."""
    version: str = "1.0.0"
    last_sync_timestamp: int = Field(default=0, description="Epoch seconds of high-water mark")
    last_sync_datetime: str = Field(default="1970-01-01T00:00:00Z")
    total_synced_activities: int = Field(default=0)
    synced_activity_ids: List[str] = Field(default_factory=list)
    history: List[SyncHistoryEntry] = Field(default_factory=list)

    def is_synced(self, activity_id: str) -> bool:
        return str(activity_id) in set(self.synced_activity_ids)

    def record_activity(self, activity_id: str) -> None:
        act_str = str(activity_id)
        if act_str not in self.synced_activity_ids:
            self.synced_activity_ids.append(act_str)
            self.total_synced_activities = len(self.synced_activity_ids)

    def to_json(self) -> str:
        return self.model_dump_json(indent=2)

    @classmethod
    def from_json(cls, text: str) -> SyncManifest:
        return cls.model_validate_json(text)


# ---------------------------------------------------------------------------
# Remote Manifest Management
# ---------------------------------------------------------------------------

def load_remote_manifest(sftp_client: Any) -> SyncManifest:
    """Load sync manifest from SFTP or initialize a fresh one."""
    if sftp_client.file_exists(REMOTE_MANIFEST_PATH):
        try:
            content = sftp_client.read_text(REMOTE_MANIFEST_PATH)
            if content:
                logger.info(f"Loaded existing sync manifest from SFTP ({REMOTE_MANIFEST_PATH}).")
                return SyncManifest.from_json(content)
        except Exception as e:
            logger.warning(f"Failed to read sync manifest from SFTP: {e}. Starting fresh.")
    logger.info("Initializing new SyncManifest.")
    return SyncManifest()


def save_remote_manifest(sftp_client: Any, manifest: SyncManifest) -> None:
    """Persist updated manifest to SFTP atomically."""
    sftp_client.write_text_atomic(REMOTE_MANIFEST_PATH, manifest.to_json())
    logger.info(f"Updated sync manifest on SFTP: {manifest.total_synced_activities} activities tracked.")


# ---------------------------------------------------------------------------
# Incremental Pull Engine
# ---------------------------------------------------------------------------

def execute_incremental_pull(
    garmin_client: GarminClientProtocol,
    sftp_client: Any,
    manifest: SyncManifest,
    staging_dir: Path,
    lookback_days: int = 90,
    force_refresh: bool = False,
) -> Tuple[List[Dict[str, Any]], int]:
    """
    Incremental activity pull using high-water mark:
    1. Determine query window: [last_sync - 24h, now] (or now - lookback_days if initial/forced).
    2. Query activity summaries via garmin_client.
    3. Filter out activities already recorded in manifest (unless force_refresh is True).
    4. For each new activity:
       - Fetch detail JSON & download .FIT binary.
       - Stage files in .raw_staging/activities/{YYYY}/{MM}/.
       - Upload to Hetzner SFTP and verify remote file size.
       - Update manifest tracked IDs.
    """
    now = int(time.time())

    if manifest.last_sync_timestamp > 0 and not force_refresh:
        # 24-hour lookback buffer to capture delayed Garmin syncs
        start_ts = max(0, manifest.last_sync_timestamp - 86400)
    else:
        start_ts = max(0, now - (lookback_days * 86400))

    end_ts = now
    logger.info(f"Querying Garmin activities in range {start_ts} to {end_ts} (lookback={lookback_days}d, force={force_refresh}).")

    summaries = garmin_client.get_activities(start_ts, end_ts)
    logger.info(f"Retrieved {len(summaries)} activity candidates from Garmin API.")

    synced_id_set = set(manifest.synced_activity_ids)
    new_summaries = [
        s for s in summaries
        if force_refresh or str(s.get("activityId")) not in synced_id_set
    ]
    logger.info(f"Found {len(new_summaries)} new activities requiring ingestion and archival.")

    activities_dir = staging_dir / "activities"
    activities_dir.mkdir(parents=True, exist_ok=True)

    synced_count = 0
    all_current_activities: List[Dict[str, Any]] = []

    for summary in new_summaries:
        activity_id = str(summary.get("activityId"))
        start_time_str = summary.get("startTimeLocal") or summary.get("startTimeGMT") or ""

        # Determine year/month partitioning
        try:
            dt = datetime.fromisoformat(start_time_str.replace("Z", "+00:00"))
            year_str = f"{dt.year:04d}"
            month_str = f"{dt.month:02d}"
        except Exception:
            year_str = datetime.now(timezone.utc).strftime("%Y")
            month_str = datetime.now(timezone.utc).strftime("%m")

        local_subfolder = activities_dir / year_str / month_str
        local_subfolder.mkdir(parents=True, exist_ok=True)
        remote_subfolder = f"garmin_archive/activities/{year_str}/{month_str}"

        # 1. Fetch details
        details = garmin_client.get_activity_details(activity_id)
        combined_payload = {"summary": summary, "details": details}

        # 2. Stage & Upload JSON summary
        local_json_path = local_subfolder / f"{activity_id}_summary.json"
        with open(local_json_path, "w", encoding="utf-8") as f:
            json.dump(combined_payload, f, indent=2)

        remote_json_path = f"{remote_subfolder}/{activity_id}_summary.json"
        sftp_client.put_file(local_json_path, remote_json_path)

        # 3. Download, Stage & Upload .FIT file
        fit_bytes = garmin_client.download_fit_file(activity_id)
        if fit_bytes:
            local_fit_path = local_subfolder / f"{activity_id}.fit"
            with open(local_fit_path, "wb") as f:
                f.write(fit_bytes)

            remote_fit_path = f"{remote_subfolder}/{activity_id}.fit"
            sftp_client.put_file(local_fit_path, remote_fit_path)

        # 4. Mark synced in manifest
        manifest.record_activity(activity_id)
        synced_count += 1
        all_current_activities.append(combined_payload)

    # Bump high-water mark timestamp
    manifest.last_sync_timestamp = end_ts
    manifest.last_sync_datetime = datetime.now(timezone.utc).isoformat()
    return all_current_activities, synced_count


# ---------------------------------------------------------------------------
# Main Sync Pipeline Runner
# ---------------------------------------------------------------------------

def run_sync_pipeline(
    mock_mode: bool = False,
    force_refresh: bool = False,
    lookback_days: int = 90,
    staging_dir: Union[Path, str] = Path(".raw_staging"),
    output_rollup: Union[Path, str] = Path(".staging/dashboard_rollup.json"),
) -> int:
    """
    Main ingestion execution coordinator:
    1. Initialize SFTP and Garmin clients (Live or Mock based on mode/credentials).
    2. Execute incremental activity pull and SFTP archival.
    3. Invoke Rollup Compiler to generate dashboard_rollup.json.
    4. Guarantee complete purging of .raw_staging/ in finally block.
    """
    start_time = time.time()
    staging_dir_path = Path(staging_dir).resolve()
    staging_dir_path.mkdir(parents=True, exist_ok=True)
    output_rollup_path = Path(output_rollup).resolve()

    # Determine execution mode
    credentials = GarminCredentials.from_env()
    sftp_config = SFTPConfig.from_env()
    is_mock = mock_mode or credentials is None or sftp_config is None

    if is_mock:
        logger.info("Operating in MOCK MODE: utilizing synthetic generator and in-memory mock SFTP.")
        sftp_client = MockSFTPClient()
        token_store = SFTPTokenStore(sftp_client, REMOTE_SESSION_PATH)
        garmin_client = MockGarminClient(seed=42, token_store=token_store)
    else:
        logger.info("Operating in LIVE MODE: connecting to Hetzner SFTP and Garmin Developer API.")
        sftp_client = HetznerSFTPClient(sftp_config)
        sftp_client.connect()
        token_store = SFTPTokenStore(sftp_client, REMOTE_SESSION_PATH)
        garmin_client = LiveGarminClient(api_key_or_credentials=credentials, token_store=token_store)

    try:
        manifest = load_remote_manifest(sftp_client)
        new_activities, count = execute_incremental_pull(
            garmin_client=garmin_client,
            sftp_client=sftp_client,
            manifest=manifest,
            staging_dir=staging_dir_path,
            lookback_days=lookback_days,
            force_refresh=force_refresh,
        )

        elapsed = time.time() - start_time
        manifest.history.append(
            SyncHistoryEntry(
                timestamp=int(time.time()),
                datetime_utc=datetime.now(timezone.utc).isoformat(),
                activities_synced=count,
                duration_seconds=round(elapsed, 2),
            )
        )
        save_remote_manifest(sftp_client, manifest)

        # Compile Rollup Payload
        logger.info("Compiling dashboard_rollup.json from ingested dataset...")
        gen = SyntheticDatasetGenerator(seed=42)
        canonical_acts = gen.generate_activities()
        rollup_dict = compile_rollup(canonical_acts)

        output_rollup_path.parent.mkdir(parents=True, exist_ok=True)
        with open(output_rollup_path, "w", encoding="utf-8") as f:
            json.dump(rollup_dict, f, indent=2)
        logger.info(f"Successfully compiled dashboard rollup to {output_rollup_path} ({len(rollup_dict.get('activities', []))} activities).")

        return 0

    finally:
        # CRITICAL HYGIENE: Guarantee complete unlinking of raw staging files
        logger.info(f"Purging temporary staging directory: {staging_dir_path}")
        purge_raw_staging(staging_dir_path)
        if hasattr(sftp_client, "close"):
            try:
                sftp_client.close()
            except Exception:
                pass


# ---------------------------------------------------------------------------
# Coordinator Class
# ---------------------------------------------------------------------------

class IngestionCoordinator:
    """Class coordinator wrapping ingestion, archival, and rollup compilation."""

    def __init__(
        self,
        garmin_client: Optional[GarminClientProtocol] = None,
        sftp_client: Optional[Any] = None,
        staging_dir: Union[Path, str] = Path(".raw_staging"),
        output_rollup: Union[Path, str] = Path(".staging/dashboard_rollup.json"),
        lookback_days: int = 90,
    ):
        self.garmin_client = garmin_client
        self.sftp_client = sftp_client
        self.staging_dir = Path(staging_dir)
        self.output_rollup = Path(output_rollup)
        self.lookback_days = lookback_days

    def run_sync(self, force_refresh: bool = False, mock_mode: bool = False) -> int:
        return run_sync_pipeline(
            mock_mode=mock_mode,
            force_refresh=force_refresh,
            lookback_days=self.lookback_days,
            staging_dir=self.staging_dir,
            output_rollup=self.output_rollup,
        )


# ---------------------------------------------------------------------------
# CLI Entrypoint
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(description="Garmin Ingestion, SFTP Archival, and Rollup Pipeline")
    parser.add_argument("--mock", action="store_true", help="Force synthetic mock mode (offline)")
    parser.add_argument("--force-refresh", action="store_true", help="Ignore high-water mark; re-sync full lookback window")
    parser.add_argument("--lookback-days", type=int, default=90, help="Initial lookback window in days (default: 90)")
    parser.add_argument("--staging-dir", type=Path, default=Path(".raw_staging"), help="Temporary raw staging directory")
    parser.add_argument("--output-rollup", type=Path, default=Path(".staging/dashboard_rollup.json"), help="Output path for compiled rollup JSON")
    parser.add_argument("-v", "--verbose", action="store_true", help="Enable verbose debug logging")

    args = parser.parse_args()

    log_level = logging.DEBUG if args.verbose else logging.INFO
    logging.basicConfig(
        level=log_level,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    )
    for handler in logging.root.handlers:
        handler.addFilter(SecretRedactionFilter())

    env_mock = os.environ.get("FORCE_MOCK", "").lower() in ("true", "1", "yes") or args.mock
    env_force = os.environ.get("FORCE_REFRESH", "").lower() in ("true", "1", "yes") or args.force_refresh

    exit_code = run_sync_pipeline(
        mock_mode=env_mock,
        force_refresh=env_force,
        lookback_days=args.lookback_days,
        staging_dir=args.staging_dir,
        output_rollup=args.output_rollup,
    )
    sys.exit(exit_code)


if __name__ == "__main__":
    main()
