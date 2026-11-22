"""
src/storage/migrate.py
Manual, non-destructive migration CLI from legacy flat-file JSON archive (`garmin_archive/`)
to the DuckDB + ZSTD Parquet vault + yearly `raw_YYYY.zip` archives.

Usage:
    python -m src.storage.migrate --source-dir /path/to/garmin_archive --output-dir ./migrated_vault
    python -m src.storage.migrate --source-dir /path/to/garmin_archive --output-dir ./migrated_vault --upload
"""

from __future__ import annotations

import argparse
import json
import logging
import re
import sys
from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from src.ingestion.garmin_client import normalize_daily_wellness
from src.ingestion.gdrive_client import get_storage_client
from src.ingestion.sync import (
    apply_wellness_intraday_retention,
    normalize_garmin_activity,
    reprocess_canonical_activities,
)
from src.storage.parquet_vault import (
    PARQUET_VAULT_DIR,
    ParquetVault,
    VaultManifest,
)

logger = logging.getLogger("src.storage.migrate")


@dataclass
class MigrationReport:
    source_dir: Path
    output_dir: Path
    source_bytes: int = 0
    vault_bytes: int = 0
    source_activities: int = 0
    vault_activities: int = 0
    source_wellness_days: int = 0
    vault_wellness_days: int = 0
    source_stream_shards: int = 0
    vault_stream_shards: int = 0
    source_raw_files: int = 0
    vault_raw_files: int = 0
    stream_years: Dict[str, int] = field(default_factory=dict)
    raw_zip_years: Dict[str, int] = field(default_factory=dict)
    verified: bool = False

    def format_summary(self) -> str:
        src_mb = self.source_bytes / (1024 * 1024)
        dst_mb = self.vault_bytes / (1024 * 1024)
        ratio = (1.0 - (self.vault_bytes / self.source_bytes)) * 100.0 if self.source_bytes > 0 else 0.0
        lines = [
            "=== Garmin Archive -> DuckDB/Parquet Vault Migration Report ===",
            f"Source (untouched) : {self.source_dir}",
            f"Output Vault       : {self.output_dir}",
            f"Activities         : {self.source_activities} source -> {self.vault_activities} in activities.parquet",
            f"Wellness Days      : {self.source_wellness_days} source -> {self.vault_wellness_days} in wellness.parquet",
            f"Stream Shards      : {self.source_stream_shards} source -> {self.vault_stream_shards} in streams_YYYY.parquet {dict(sorted(self.stream_years.items()))}",
            f"Raw .fit/.gpx      : {self.source_raw_files} source -> {self.vault_raw_files} in raw_YYYY.zip {dict(sorted(self.raw_zip_years.items()))}",
            f"Total Disk Size    : {src_mb:.2f} MB -> {dst_mb:.2f} MB ({ratio:.1f}% reduction)",
            f"Verification       : {'PASSED' if self.verified else 'FAILED'}",
        ]
        return "\n".join(lines)


def _resolve_archive_root(source_dir: Path) -> Path:
    if (source_dir / "garmin_archive").is_dir():
        return source_dir / "garmin_archive"
    return source_dir


def _extract_year_from_act(act: Dict[str, Any]) -> str:
    s = str(act.get("start_time") or act.get("date") or "").strip()
    if len(s) >= 4 and s[:4].isdigit():
        return s[:4]
    return "unknown"


def migrate_local_archive(
    source_dir: Path,
    output_dir: Path,
) -> MigrationReport:
    """
    Convert a legacy local `garmin_archive/` directory into a DuckDB + Parquet + yearly zip vault
    at `output_dir`. Source files are strictly read-only and never modified or deleted.
    """
    archive_root = _resolve_archive_root(Path(source_dir).resolve())
    if not archive_root.exists() or not archive_root.is_dir():
        raise FileNotFoundError(f"Source archive directory does not exist: {archive_root}")

    out_dir = Path(output_dir).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)

    report = MigrationReport(source_dir=archive_root, output_dir=out_dir)
    for f in archive_root.rglob("*"):
        if f.is_file():
            try:
                report.source_bytes += f.stat().st_size
            except OSError:
                pass

    vault = ParquetVault(work_dir=out_dir, storage_client=None)

    # 1. Load Activities from metadata/activities_index.json or canonical_activities.json
    acts_by_id: Dict[str, Dict[str, Any]] = {}
    meta_dir = archive_root / "metadata"
    for fname in ("activities_index.json", "canonical_activities.json"):
        cand = meta_dir / fname
        if cand.is_file():
            try:
                parsed = json.loads(cand.read_text(encoding="utf-8"))
                if isinstance(parsed, list):
                    for item in parsed:
                        if isinstance(item, dict) and item.get("id") is not None:
                            acts_by_id[str(item["id"])] = item
                    break
            except Exception as exc:
                logger.warning(f"Could not read {cand}: {exc}")

    # 2. Load Streams from streams/streams_YYYY.json & streams/YYYY/*.json
    streams_by_year: Dict[str, Dict[str, Dict[str, Any]]] = defaultdict(dict)
    streams_dir = archive_root / "streams"
    if streams_dir.is_dir():
        for bundle_file in sorted(streams_dir.glob("streams_*.json")):
            m = re.fullmatch(r"streams_(\d{4}|unknown)\.json", bundle_file.name)
            if not m:
                continue
            yr = m.group(1)
            try:
                parsed = json.loads(bundle_file.read_text(encoding="utf-8"))
                if isinstance(parsed, dict):
                    for aid, shard in parsed.items():
                        if isinstance(shard, dict):
                            streams_by_year[yr][str(aid)] = shard
            except Exception as exc:
                logger.warning(f"Could not read stream bundle {bundle_file}: {exc}")

        for sub in sorted(streams_dir.iterdir()):
            if sub.is_dir() and (len(sub.name) == 4 and sub.name.isdigit() or sub.name == "unknown"):
                yr = sub.name
                for shard_file in sorted(sub.glob("*.json")):
                    aid = shard_file.stem
                    if aid not in streams_by_year[yr]:
                        try:
                            shard = json.loads(shard_file.read_text(encoding="utf-8"))
                            if isinstance(shard, dict):
                                streams_by_year[yr][aid] = shard
                        except Exception as exc:
                            logger.warning(f"Could not read stream shard {shard_file}: {exc}")

    # 3. Walk activities/YYYY/MM/ for raw .fit/.gpx and any unindexed *_summary.json
    raw_files_by_year: Dict[str, Dict[str, bytes]] = defaultdict(dict)
    activities_root = archive_root / "activities"
    if activities_root.is_dir():
        for item in sorted(activities_root.rglob("*")):
            if not item.is_file():
                continue
            rel_parts = item.relative_to(activities_root).parts
            yr = rel_parts[0] if rel_parts and len(rel_parts[0]) == 4 and rel_parts[0].isdigit() else "unknown"
            lower_name = item.name.lower()
            if lower_name.endswith(".fit") or lower_name.endswith(".gpx"):
                raw_files_by_year[yr][item.name] = item.read_bytes()
                report.source_raw_files += 1
            elif lower_name.endswith("_summary.json"):
                try:
                    raw_payload = json.loads(item.read_text(encoding="utf-8"))
                    if isinstance(raw_payload, dict):
                        norm = normalize_garmin_activity(raw_payload)
                        aid = str(norm.get("id") or "")
                        if aid:
                            if aid not in acts_by_id:
                                acts_by_id[aid] = norm
                            act_yr = _extract_year_from_act(norm)
                            if act_yr == "unknown":
                                act_yr = yr
                            if aid not in streams_by_year[act_yr] and (
                                norm.get("gps_track") or norm.get("telemetry_stream")
                            ):
                                streams_by_year[act_yr][aid] = {
                                    "id": aid,
                                    "gps_track": norm.get("gps_track"),
                                    "telemetry_stream": norm.get("telemetry_stream"),
                                    "splits": norm.get("splits", []),
                                    "laps": norm.get("laps", []),
                                    "hr_zones": norm.get("hr_zones", {}),
                                }
                except Exception as exc:
                    logger.warning(f"Could not parse summary {item}: {exc}")

    # Also extract any inline streams embedded in acts_by_id
    canonical_acts = reprocess_canonical_activities(list(acts_by_id.values()))
    for act in canonical_acts:
        aid = str(act.get("id") or "")
        if not aid:
            continue
        yr = _extract_year_from_act(act)
        if aid not in streams_by_year[yr] and (act.get("gps_track") or act.get("telemetry_stream")):
            streams_by_year[yr][aid] = {
                "id": aid,
                "gps_track": act.get("gps_track"),
                "telemetry_stream": act.get("telemetry_stream"),
                "splits": act.get("splits", []),
                "laps": act.get("laps", []),
                "hr_zones": act.get("hr_zones", {}),
            }

    report.source_activities = len(canonical_acts)
    report.source_stream_shards = sum(len(m) for m in streams_by_year.values())

    # 4. Load & merge Wellness
    wellness_by_date: Dict[str, Dict[str, Any]] = {}
    w_hist_path = meta_dir / "wellness_history.json"
    if w_hist_path.is_file():
        try:
            parsed_w = json.loads(w_hist_path.read_text(encoding="utf-8"))
            if isinstance(parsed_w, list):
                for w_rec in parsed_w:
                    if isinstance(w_rec, dict) and w_rec.get("date"):
                        wellness_by_date[str(w_rec["date"])[:10]] = w_rec
        except Exception as exc:
            logger.warning(f"Could not read {w_hist_path}: {exc}")

    raw_w_dir = archive_root / "raw_wellness"
    if raw_w_dir.is_dir():
        for raw_w_file in sorted(raw_w_dir.glob("raw_wellness_*.json")):
            try:
                bundle = json.loads(raw_w_file.read_text(encoding="utf-8"))
                if isinstance(bundle, dict):
                    for cdate, raw_day in bundle.items():
                        cdate_s = str(cdate)[:10]
                        if cdate_s not in wellness_by_date and isinstance(raw_day, dict):
                            wellness_by_date[cdate_s] = normalize_daily_wellness(cdate_s, raw_day)
            except Exception as exc:
                logger.warning(f"Could not read {raw_w_file}: {exc}")

    sorted_wellness = [wellness_by_date[k] for k in sorted(wellness_by_date.keys())]
    retained_wellness = apply_wellness_intraday_retention(sorted_wellness, retention_days=14)
    report.source_wellness_days = len(retained_wellness)

    # 5. Write Parquet & Zip Vault
    report.vault_activities = vault.save_activities(canonical_acts, push_remote=False)
    report.vault_wellness_days = vault.save_wellness(retained_wellness, push_remote=False)

    for yr in sorted(streams_by_year.keys()):
        if streams_by_year[yr]:
            cnt = vault.save_year_streams(yr, streams_by_year[yr], push_remote=False)
            report.stream_years[yr] = cnt
            report.vault_stream_shards += cnt

    for yr in sorted(raw_files_by_year.keys()):
        if raw_files_by_year[yr]:
            _, total_members = vault.append_raw_files(yr, raw_files_by_year[yr], pull_remote=False, push_remote=False)
            report.raw_zip_years[yr] = total_members
            report.vault_raw_files += total_members

    # 6. Build VaultManifest preserving legacy sync_manifest.json high-water mark & history
    manifest = VaultManifest()
    legacy_manifest_path = meta_dir / "sync_manifest.json"
    if legacy_manifest_path.is_file():
        try:
            legacy_m = json.loads(legacy_manifest_path.read_text(encoding="utf-8"))
            if isinstance(legacy_m, dict):
                manifest.last_sync_timestamp = int(legacy_m.get("last_sync_timestamp") or 0)
                manifest.last_sync_datetime = legacy_m.get("last_sync_datetime")
                manifest.history = list(legacy_m.get("history") or [])
        except Exception as exc:
            logger.warning(f"Could not read legacy sync_manifest.json: {exc}")

    for act in canonical_acts:
        aid = str(act.get("id") or "")
        if aid:
            manifest.record_activity(aid, year=_extract_year_from_act(act))
    manifest.stream_years = dict(report.stream_years)
    manifest.raw_zip_years = dict(report.raw_zip_years)
    manifest.total_wellness_days = report.vault_wellness_days
    vault.save_manifest(manifest)

    # 7. Verify roundtrip readback
    readback_acts = vault.load_activities(pull_remote=False)
    readback_well = vault.load_wellness(pull_remote=False)
    readback_streams = sum(len(vault.load_year_streams(yr, pull_remote=False)) for yr in report.stream_years)

    report.verified = (
        len(readback_acts) == report.source_activities
        and len(readback_well) == report.source_wellness_days
        and readback_streams == report.source_stream_shards
        and report.vault_raw_files == report.source_raw_files
    )

    for f in out_dir.rglob("*"):
        if f.is_file():
            report.vault_bytes += f.stat().st_size

    return report


def upload_vault_directory(vault_dir: Path, storage_client: Any, remote_vault_dir: str = PARQUET_VAULT_DIR) -> int:
    """Uploads all generated vault files (.parquet, .zip, vault_manifest.json) to remote storage."""
    uploaded = 0
    for item in sorted(vault_dir.iterdir()):
        if not item.is_file():
            continue
        if item.name == "vault_manifest.json":
            storage_client.write_text_atomic(f"{remote_vault_dir}/{item.name}", item.read_text(encoding="utf-8"))
            uploaded += 1
        elif item.suffix in (".parquet", ".zip"):
            storage_client.put_file(item, f"{remote_vault_dir}/{item.name}")
            uploaded += 1
    return uploaded


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        description="Migrate legacy garmin_archive/ JSON + .fit/.gpx files into DuckDB/Parquet + yearly zip vault."
    )
    parser.add_argument("--source-dir", type=Path, required=True, help="Path to local downloaded garmin_archive directory")
    parser.add_argument("--output-dir", type=Path, default=Path("./migrated_vault"), help="Output directory for vault files")
    parser.add_argument("--upload", action="store_true", help="Upload migrated vault/ files to configured remote storage")
    parser.add_argument("-v", "--verbose", action="store_true", help="Enable verbose logging")
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    )

    report = migrate_local_archive(args.source_dir, args.output_dir)
    print(report.format_summary())
    if not report.verified:
        logger.error("Migration verification failed: record counts do not match source!")
        return 1

    if args.upload:
        client = get_storage_client(force_mock=False)
        try:
            count = upload_vault_directory(args.output_dir.resolve(), client)
            print(f"Uploaded {count} vault files to {PARQUET_VAULT_DIR}/.")
        finally:
            if hasattr(client, "close"):
                client.close()

    return 0


if __name__ == "__main__":
    sys.exit(main())
