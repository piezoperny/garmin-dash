"""
src/storage/parquet_vault.py
DuckDB + ZSTD Parquet storage engine and yearly raw .fit/.gpx zip archiver.

Designed for long-term scalability with Google Drive (Apps Script / API) and Hetzner SFTP:
- Consolidates thousands of activity JSONs into `activities.parquet` (ZSTD)
- Consolidates daily wellness into `wellness.parquet` (ZSTD)
- Partitions heavy 1-second telemetry/GPS streams by year into `streams_YYYY.parquet` (ZSTD)
- Archives original binary .fit and .gpx files into `raw_YYYY.zip` (1 standard zip per year)
"""

from __future__ import annotations

import json
import logging
import os
import re
import shutil
import tempfile
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Set, Tuple, Union

import duckdb
from pydantic import BaseModel, Field

logger = logging.getLogger("src.storage.parquet_vault")

PARQUET_VAULT_DIR = "garmin_archive/vault"
REMOTE_VAULT_MANIFEST_PATH = f"{PARQUET_VAULT_DIR}/vault_manifest.json"
REMOTE_VAULT_ACTIVITIES_PATH = f"{PARQUET_VAULT_DIR}/activities.parquet"
REMOTE_VAULT_WELLNESS_PATH = f"{PARQUET_VAULT_DIR}/wellness.parquet"


def remote_streams_parquet_path(year: str) -> str:
    return f"{PARQUET_VAULT_DIR}/streams_{year}.parquet"


def remote_raw_zip_path(year: str) -> str:
    return f"{PARQUET_VAULT_DIR}/raw_{year}.zip"


def _extract_year(date_or_ts: Any) -> str:
    s = str(date_or_ts or "").strip()
    if len(s) >= 4 and s[:4].isdigit():
        return s[:4]
    return "unknown"


def _safe_float(val: Any) -> Optional[float]:
    if val is None or val == "":
        return None
    try:
        return float(val)
    except (TypeError, ValueError):
        return None


def _safe_int(val: Any) -> Optional[int]:
    if val is None or val == "":
        return None
    try:
        return int(float(val))
    except (TypeError, ValueError):
        return None


class VaultManifest(BaseModel):
    """Metadata manifest for the DuckDB + Parquet vault."""

    schema_version: int = 2
    storage_format: str = "duckdb-parquet-zstd"
    raw_archive_format: str = "yearly-zip"
    last_sync_timestamp: int = 0
    last_sync_datetime: Optional[str] = None
    total_synced_activities: int = 0
    synced_activity_ids: List[str] = Field(default_factory=list)
    activity_years: Dict[str, List[str]] = Field(default_factory=dict)
    raw_zip_years: Dict[str, int] = Field(default_factory=dict)
    stream_years: Dict[str, int] = Field(default_factory=dict)
    total_wellness_days: int = 0
    history: List[Dict[str, Any]] = Field(default_factory=list)

    def record_activity(self, activity_id: str, year: Optional[str] = None) -> None:
        aid = str(activity_id)
        if aid not in self.synced_activity_ids:
            self.synced_activity_ids.append(aid)
        self.total_synced_activities = len(self.synced_activity_ids)
        if year:
            yr_list = self.activity_years.setdefault(str(year), [])
            if aid not in yr_list:
                yr_list.append(aid)

    def remove_activity(self, activity_id: str) -> None:
        aid = str(activity_id)
        if aid in self.synced_activity_ids:
            self.synced_activity_ids.remove(aid)
        self.total_synced_activities = len(self.synced_activity_ids)
        for yr_list in self.activity_years.values():
            if aid in yr_list:
                yr_list.remove(aid)


class RawZipArchive:
    """Manages yearly raw_<YYYY>.zip archives containing original .fit and .gpx files."""

    @staticmethod
    def append_files(zip_path: Path, files: Dict[str, bytes]) -> Tuple[int, int]:
        """
        Add or update named files (e.g. '12345.fit', '12345.gpx') inside zip_path atomically.
        Existing entries not in `files` are preserved without re-reading if unchanged,
        or copied cleanly to a temp zip to prevent duplicate zip member warnings.
        Returns (added_or_updated_count, total_members_in_zip).
        """
        zip_path.parent.mkdir(parents=True, exist_ok=True)
        if not files:
            if zip_path.exists():
                with zipfile.ZipFile(zip_path, "r") as zf:
                    return 0, len(zf.namelist())
            return 0, 0

        existing_entries: Dict[str, bytes] = {}
        if zip_path.exists():
            with zipfile.ZipFile(zip_path, "r") as zf:
                for info in zf.infolist():
                    if not info.is_dir():
                        existing_entries[info.filename] = zf.read(info.filename)

        updated = 0
        for name, data in files.items():
            clean_name = Path(name).name
            if not clean_name or data is None:
                continue
            if existing_entries.get(clean_name) != data:
                existing_entries[clean_name] = data
                updated += 1

        tmp_zip = zip_path.with_suffix(".zip.tmp")
        with zipfile.ZipFile(tmp_zip, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as zf:
            for fname in sorted(existing_entries.keys()):
                zf.writestr(fname, existing_entries[fname])

        if zip_path.exists():
            zip_path.unlink()
        tmp_zip.rename(zip_path)
        return updated, len(existing_entries)

    @staticmethod
    def list_members(zip_path: Path) -> List[str]:
        if not zip_path.exists():
            return []
        with zipfile.ZipFile(zip_path, "r") as zf:
            return sorted(zf.namelist())

    @staticmethod
    def extract_member(zip_path: Path, member_name: str, dest_path: Path) -> Path:
        if not zip_path.exists():
            raise FileNotFoundError(f"Zip archive not found: {zip_path}")
        dest_path.parent.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(zip_path, "r") as zf:
            if member_name not in zf.namelist():
                raise KeyError(f"{member_name} not found in {zip_path}")
            dest_path.write_bytes(zf.read(member_name))
        return dest_path


class ParquetVault:
    """
    DuckDB-powered Parquet vault for activities, daily wellness, year-partitioned streams,
    and yearly raw .fit/.gpx zip archives.

    Can operate purely locally (e.g. during migration) or synced against any SFTPClientProtocol
    (Google Drive Apps Script/API, Hetzner SFTP, CompositeStorageClient, MockSFTPClient).
    """

    def __init__(
        self,
        work_dir: Union[Path, str],
        storage_client: Optional[Any] = None,
        remote_vault_dir: str = PARQUET_VAULT_DIR,
    ) -> None:
        self.work_dir = Path(work_dir)
        self.work_dir.mkdir(parents=True, exist_ok=True)
        self.storage_client = storage_client
        self.remote_vault_dir = remote_vault_dir.rstrip("/")

    # ------------------------------------------------------------------
    # Path helpers
    # ------------------------------------------------------------------

    @property
    def local_manifest_path(self) -> Path:
        return self.work_dir / "vault_manifest.json"

    @property
    def local_activities_path(self) -> Path:
        return self.work_dir / "activities.parquet"

    @property
    def local_wellness_path(self) -> Path:
        return self.work_dir / "wellness.parquet"

    def local_streams_path(self, year: str) -> Path:
        return self.work_dir / f"streams_{year}.parquet"

    def local_raw_zip_path(self, year: str) -> Path:
        return self.work_dir / f"raw_{year}.zip"

    def remote_path(self, filename: str) -> str:
        return f"{self.remote_vault_dir}/{filename}"

    # ------------------------------------------------------------------
    # Remote sync helpers
    # ------------------------------------------------------------------

    def has_remote_vault(self) -> bool:
        if self.storage_client is None:
            return self.local_manifest_path.exists()
        try:
            return bool(self.storage_client.file_exists(self.remote_path("vault_manifest.json")))
        except Exception:
            return False

    def _pull_file(self, filename: str, local_dest: Path) -> bool:
        if self.storage_client is None:
            return local_dest.exists()
        rpath = self.remote_path(filename)
        try:
            if not self.storage_client.file_exists(rpath):
                return False
            local_dest.parent.mkdir(parents=True, exist_ok=True)
            self.storage_client.get_file(rpath, local_dest)
            return local_dest.exists()
        except Exception as exc:
            logger.warning(f"Could not pull {rpath}: {exc}")
            return False

    def _push_file(self, local_src: Path, filename: str) -> None:
        if self.storage_client is None or not local_src.exists():
            return
        rpath = self.remote_path(filename)
        self.storage_client.put_file(local_src, rpath)

    def load_manifest(self) -> VaultManifest:
        if self.storage_client is not None:
            rpath = self.remote_path("vault_manifest.json")
            try:
                if self.storage_client.file_exists(rpath):
                    raw = self.storage_client.read_text(rpath)
                    if raw:
                        m = VaultManifest.model_validate_json(raw)
                        self.local_manifest_path.write_text(m.model_dump_json(indent=2), encoding="utf-8")
                        return m
            except Exception as exc:
                logger.warning(f"Failed to load remote vault manifest: {exc}")
        elif self.local_manifest_path.exists():
            try:
                return VaultManifest.model_validate_json(self.local_manifest_path.read_text(encoding="utf-8"))
            except Exception as exc:
                logger.warning(f"Failed to load local vault manifest: {exc}")
        return VaultManifest()

    def save_manifest(self, manifest: VaultManifest) -> None:
        payload = manifest.model_dump_json(indent=2)
        self.local_manifest_path.write_text(payload, encoding="utf-8")
        if self.storage_client is not None:
            self.storage_client.write_text_atomic(self.remote_path("vault_manifest.json"), payload)

    # ------------------------------------------------------------------
    # DuckDB connection helper
    # ------------------------------------------------------------------

    @staticmethod
    def _connect() -> duckdb.DuckDBPyConnection:
        return duckdb.connect(database=":memory:")

    @staticmethod
    def _atomic_copy_parquet(con: duckdb.DuckDBPyConnection, table_name: str, dest: Path) -> None:
        dest.parent.mkdir(parents=True, exist_ok=True)
        tmp = dest.with_suffix(".parquet.tmp")
        if tmp.exists():
            tmp.unlink()
        escaped = str(tmp).replace("'", "''")
        con.execute(f"COPY {table_name} TO '{escaped}' (FORMAT PARQUET, COMPRESSION ZSTD)")
        if dest.exists():
            dest.unlink()
        tmp.rename(dest)

    # ------------------------------------------------------------------
    # Activities (activities.parquet)
    # ------------------------------------------------------------------

    def load_activities(self, pull_remote: bool = True) -> List[Dict[str, Any]]:
        if pull_remote and self.storage_client is not None:
            self._pull_file("activities.parquet", self.local_activities_path)
        if not self.local_activities_path.exists():
            return []
        con = self._connect()
        try:
            escaped = str(self.local_activities_path).replace("'", "''")
            rows = con.execute(
                f"SELECT payload_json FROM read_parquet('{escaped}') ORDER BY start_time ASC, id ASC"
            ).fetchall()
            out: List[Dict[str, Any]] = []
            for (payload_str,) in rows:
                if payload_str:
                    out.append(json.loads(payload_str))
            return out
        finally:
            con.close()

    def save_activities(self, activities: List[Dict[str, Any]], push_remote: bool = True) -> int:
        """Writes canonical activities (deduplicated by id, last write wins) to activities.parquet."""
        dedup: Dict[str, Dict[str, Any]] = {}
        for act in activities:
            if not isinstance(act, dict):
                continue
            aid = str(act.get("id") or "")
            if aid:
                dedup[aid] = act

        now_iso = datetime.now(timezone.utc).isoformat()
        records: List[Tuple[Any, ...]] = []
        for aid, act in dedup.items():
            # Strip heavy streams from index table (stored in streams_YYYY.parquet)
            idx_copy = dict(act)
            idx_copy.pop("gps_track", None)
            idx_copy.pop("telemetry_stream", None)

            start_t = str(idx_copy.get("start_time") or idx_copy.get("date") or "")
            date_s = str(idx_copy.get("date") or start_t[:10] or "")
            yr = _extract_year(start_t or date_s)
            records.append((
                aid,
                start_t,
                date_s,
                yr,
                str(idx_copy.get("sport") or "other"),
                str(idx_copy.get("name") or idx_copy.get("title") or ""),
                _safe_float(idx_copy.get("distance_meters")),
                _safe_float(idx_copy.get("duration_seconds")),
                _safe_float(idx_copy.get("moving_time_seconds")),
                _safe_float(idx_copy.get("elevation_gain_meters")),
                _safe_float(idx_copy.get("avg_hr")),
                _safe_float(idx_copy.get("max_hr")),
                _safe_float(idx_copy.get("calories")),
                _safe_float(idx_copy.get("avg_power")),
                bool(idx_copy.get("has_streams") or act.get("gps_track") or act.get("telemetry_stream")),
                idx_copy.get("summary_polyline"),
                now_iso,
                json.dumps(idx_copy, separators=(",", ":"), ensure_ascii=False),
            ))

        con = self._connect()
        try:
            con.execute(
                """
                CREATE TABLE activities_stage (
                    id VARCHAR,
                    start_time VARCHAR,
                    date VARCHAR,
                    year VARCHAR,
                    sport VARCHAR,
                    name VARCHAR,
                    distance_meters DOUBLE,
                    duration_seconds DOUBLE,
                    moving_time_seconds DOUBLE,
                    elevation_gain_meters DOUBLE,
                    avg_hr DOUBLE,
                    max_hr DOUBLE,
                    calories DOUBLE,
                    avg_power DOUBLE,
                    has_streams BOOLEAN,
                    summary_polyline VARCHAR,
                    updated_at VARCHAR,
                    payload_json VARCHAR
                )
                """
            )
            if records:
                con.executemany(
                    "INSERT INTO activities_stage VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    records,
                )
            self._atomic_copy_parquet(con, "activities_stage", self.local_activities_path)
        finally:
            con.close()

        if push_remote and self.storage_client is not None:
            self._push_file(self.local_activities_path, "activities.parquet")
        return len(records)

    # ------------------------------------------------------------------
    # Wellness (wellness.parquet)
    # ------------------------------------------------------------------

    def load_wellness(self, pull_remote: bool = True) -> List[Dict[str, Any]]:
        if pull_remote and self.storage_client is not None:
            self._pull_file("wellness.parquet", self.local_wellness_path)
        if not self.local_wellness_path.exists():
            return []
        con = self._connect()
        try:
            escaped = str(self.local_wellness_path).replace("'", "''")
            rows = con.execute(
                f"SELECT payload_json FROM read_parquet('{escaped}') ORDER BY date ASC"
            ).fetchall()
            out: List[Dict[str, Any]] = []
            for (payload_str,) in rows:
                if payload_str:
                    out.append(json.loads(payload_str))
            return out
        finally:
            con.close()

    def save_wellness(self, records_list: List[Dict[str, Any]], push_remote: bool = True) -> int:
        dedup: Dict[str, Dict[str, Any]] = {}
        for rec in records_list:
            if not isinstance(rec, dict) or not rec.get("date"):
                continue
            dedup[str(rec["date"])[:10]] = rec

        now_iso = datetime.now(timezone.utc).isoformat()
        rows: List[Tuple[Any, ...]] = []
        for cdate in sorted(dedup.keys()):
            rec = dedup[cdate]
            rows.append((
                cdate,
                _extract_year(cdate),
                _safe_float(rec.get("resting_hr")),
                _safe_float(rec.get("hrv_ms") if rec.get("hrv_ms") is not None else rec.get("hrv")),
                _safe_float(rec.get("sleep_seconds")),
                _safe_float(rec.get("sleep_score")),
                _safe_float(rec.get("stress_level")),
                _safe_float(rec.get("body_battery_max")),
                _safe_float(rec.get("body_battery_min")),
                _safe_int(rec.get("steps")),
                _safe_float(rec.get("vo2_max")),
                _safe_float(rec.get("training_readiness")),
                now_iso,
                json.dumps(rec, separators=(",", ":"), ensure_ascii=False),
            ))

        con = self._connect()
        try:
            con.execute(
                """
                CREATE TABLE wellness_stage (
                    date VARCHAR,
                    year VARCHAR,
                    resting_hr DOUBLE,
                    hrv_ms DOUBLE,
                    sleep_seconds DOUBLE,
                    sleep_score DOUBLE,
                    stress_level DOUBLE,
                    body_battery_max DOUBLE,
                    body_battery_min DOUBLE,
                    steps BIGINT,
                    vo2_max DOUBLE,
                    training_readiness DOUBLE,
                    updated_at VARCHAR,
                    payload_json VARCHAR
                )
                """
            )
            if rows:
                con.executemany(
                    "INSERT INTO wellness_stage VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    rows,
                )
            self._atomic_copy_parquet(con, "wellness_stage", self.local_wellness_path)
        finally:
            con.close()

        if push_remote and self.storage_client is not None:
            self._push_file(self.local_wellness_path, "wellness.parquet")
        return len(rows)

    # ------------------------------------------------------------------
    # Streams (streams_YYYY.parquet)
    # ------------------------------------------------------------------

    def load_year_streams(self, year: str, pull_remote: bool = True) -> Dict[str, Dict[str, Any]]:
        local_p = self.local_streams_path(year)
        if pull_remote and self.storage_client is not None:
            self._pull_file(f"streams_{year}.parquet", local_p)
        if not local_p.exists():
            return {}
        con = self._connect()
        try:
            escaped = str(local_p).replace("'", "''")
            rows = con.execute(
                f"SELECT activity_id, payload_json FROM read_parquet('{escaped}')"
            ).fetchall()
            out: Dict[str, Dict[str, Any]] = {}
            for aid, payload_str in rows:
                if aid and payload_str:
                    out[str(aid)] = json.loads(payload_str)
            return out
        finally:
            con.close()

    def save_year_streams(
        self,
        year: str,
        streams_map: Dict[str, Dict[str, Any]],
        push_remote: bool = True,
    ) -> int:
        local_p = self.local_streams_path(year)
        now_iso = datetime.now(timezone.utc).isoformat()
        rows: List[Tuple[str, str, str, str]] = []
        for aid in sorted(streams_map.keys()):
            shard = streams_map[aid]
            if not isinstance(shard, dict):
                continue
            shard_clean = {
                "id": str(aid),
                "gps_track": shard.get("gps_track"),
                "telemetry_stream": shard.get("telemetry_stream"),
                "splits": shard.get("splits", []),
                "laps": shard.get("laps", []),
                "hr_zones": shard.get("hr_zones", {}),
            }
            rows.append((
                str(aid),
                str(year),
                now_iso,
                json.dumps(shard_clean, separators=(",", ":"), ensure_ascii=False),
            ))

        con = self._connect()
        try:
            con.execute(
                """
                CREATE TABLE streams_stage (
                    activity_id VARCHAR,
                    year VARCHAR,
                    updated_at VARCHAR,
                    payload_json VARCHAR
                )
                """
            )
            if rows:
                con.executemany("INSERT INTO streams_stage VALUES (?, ?, ?, ?)", rows)
            self._atomic_copy_parquet(con, "streams_stage", local_p)
        finally:
            con.close()

        if push_remote and self.storage_client is not None:
            self._push_file(local_p, f"streams_{year}.parquet")
        return len(rows)

    def list_remote_stream_years(self) -> List[str]:
        years: Set[str] = set()
        if self.storage_client is not None:
            try:
                for entry in self.storage_client.listdir(self.remote_vault_dir):
                    m = re.fullmatch(r"streams_(\d{4}|unknown)\.parquet", str(entry))
                    if m:
                        years.add(m.group(1))
            except Exception:
                pass
        for p in self.work_dir.glob("streams_*.parquet"):
            m = re.fullmatch(r"streams_(\d{4}|unknown)\.parquet", p.name)
            if m:
                years.add(m.group(1))
        return sorted(years)

    # ------------------------------------------------------------------
    # Raw .fit / .gpx yearly zip archives (raw_YYYY.zip)
    # ------------------------------------------------------------------

    def append_raw_files(
        self,
        year: str,
        files: Dict[str, bytes],
        pull_remote: bool = True,
        push_remote: bool = True,
    ) -> Tuple[int, int]:
        if not files:
            return 0, 0
        local_zip = self.local_raw_zip_path(year)
        fname = f"raw_{year}.zip"
        if pull_remote and self.storage_client is not None and not local_zip.exists():
            self._pull_file(fname, local_zip)
        updated, total = RawZipArchive.append_files(local_zip, files)
        if push_remote and self.storage_client is not None and updated > 0:
            self._push_file(local_zip, fname)
        return updated, total

    def export_raw_file(
        self,
        year: str,
        member_name: str,
        dest_path: Union[Path, str],
        pull_remote: bool = True,
    ) -> Path:
        local_zip = self.local_raw_zip_path(year)
        if pull_remote and self.storage_client is not None and not local_zip.exists():
            self._pull_file(f"raw_{year}.zip", local_zip)
        return RawZipArchive.extract_member(local_zip, member_name, Path(dest_path))

    # ------------------------------------------------------------------
    # SQL Analytics Helper
    # ------------------------------------------------------------------

    def query_activities_sql(self, sql: str) -> List[Tuple[Any, ...]]:
        """Execute an ad-hoc DuckDB SQL query against activities.parquet (table name: `activities`)."""
        if not self.local_activities_path.exists():
            return []
        con = self._connect()
        try:
            escaped = str(self.local_activities_path).replace("'", "''")
            con.execute(f"CREATE VIEW activities AS SELECT * FROM read_parquet('{escaped}')")
            return con.execute(sql).fetchall()
        finally:
            con.close()
