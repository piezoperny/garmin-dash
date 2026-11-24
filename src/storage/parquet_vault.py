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

import hashlib
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


def _first_not_none(d: Dict[str, Any], *keys: str) -> Any:
    for k in keys:
        val = d.get(k)
        if val is not None:
            return val
    return None


def compute_file_sha256(path: Path, chunk_size: int = 1024 * 1024) -> str:
    """Compute SHA-256 hex digest of a file using bounded chunked reads."""
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while True:
            chunk = f.read(chunk_size)
            if not chunk:
                break
            h.update(chunk)
    return h.hexdigest()


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
    file_hashes: Dict[str, str] = Field(default_factory=dict)
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
        Add or update named files (e.g. '12345.fit', '12345.gpx') inside zip_path.
        When appending strictly new filenames to an existing zip (no overwrites),
        opens the zip in 'a' mode without decompressing/recompressing existing members.
        Only rewrites via a temp zip when replacing an existing member with new bytes.
        Returns (added_or_updated_count, total_members_in_zip).
        """
        zip_path.parent.mkdir(parents=True, exist_ok=True)
        clean_files: Dict[str, bytes] = {}
        for name, data in files.items():
            clean_name = Path(name).name
            if clean_name and data is not None:
                clean_files[clean_name] = data

        if not clean_files:
            if zip_path.exists():
                with zipfile.ZipFile(zip_path, "r") as zf:
                    return 0, len(zf.namelist())
            return 0, 0

        if not zip_path.exists():
            tmp_zip = zip_path.with_suffix(".zip.tmp")
            with zipfile.ZipFile(tmp_zip, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as zf:
                for fname in sorted(clean_files.keys()):
                    zf.writestr(fname, clean_files[fname])
            tmp_zip.rename(zip_path)
            return len(clean_files), len(clean_files)

        with zipfile.ZipFile(zip_path, "r") as zf:
            existing_names = {info.filename for info in zf.infolist() if not info.is_dir()}
            overlapping = [fname for fname in clean_files if fname in existing_names]
            new_only = {fname: data for fname, data in clean_files.items() if fname not in existing_names}

            needs_rewrite = False
            for fname in overlapping:
                if zf.read(fname) != clean_files[fname]:
                    needs_rewrite = True
                    break

        if not needs_rewrite:
            if not new_only:
                return 0, len(existing_names)
            with zipfile.ZipFile(zip_path, "a", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as zf:
                for fname in sorted(new_only.keys()):
                    zf.writestr(fname, new_only[fname])
            return len(new_only), len(existing_names) + len(new_only)

        # At least one existing member changed; rewrite atomically to avoid duplicate zip entries
        existing_entries: Dict[str, bytes] = {}
        with zipfile.ZipFile(zip_path, "r") as zf:
            for info in zf.infolist():
                if not info.is_dir():
                    existing_entries[info.filename] = zf.read(info.filename)

        updated = 0
        for fname, data in clean_files.items():
            if existing_entries.get(fname) != data:
                existing_entries[fname] = data
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
        self._con: Optional[duckdb.DuckDBPyConnection] = None
        self._manifest: Optional[VaultManifest] = None

    def close(self) -> None:
        if self._con is not None:
            try:
                self._con.close()
            except Exception:
                pass
            self._con = None

    def __enter__(self) -> ParquetVault:
        return self

    def __exit__(self, exc_type: Any, exc_val: Any, exc_tb: Any) -> None:
        self.close()

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

    def _push_file(self, local_src: Path, filename: str, manifest: Optional[VaultManifest] = None) -> bool:
        if self.storage_client is None or not local_src.exists():
            return False
        active_manifest = manifest or self._manifest
        digest = compute_file_sha256(local_src)
        if active_manifest is not None and active_manifest.file_hashes.get(filename) == digest:
            logger.debug(f"Skipping unchanged upload for {filename} (sha256={digest[:12]})")
            return False
        rpath = self.remote_path(filename)
        self.storage_client.put_file(local_src, rpath)
        if active_manifest is not None:
            active_manifest.file_hashes[filename] = digest
        return True

    def load_manifest(self) -> VaultManifest:
        if self.storage_client is not None:
            rpath = self.remote_path("vault_manifest.json")
            try:
                if self.storage_client.file_exists(rpath):
                    raw = self.storage_client.read_text(rpath)
                    if raw:
                        m = VaultManifest.model_validate_json(raw)
                        self.local_manifest_path.write_text(m.model_dump_json(indent=2), encoding="utf-8")
                        self._manifest = m
                        return m
            except Exception as exc:
                logger.warning(f"Failed to load remote vault manifest: {exc}")
        elif self.local_manifest_path.exists():
            try:
                m = VaultManifest.model_validate_json(self.local_manifest_path.read_text(encoding="utf-8"))
                self._manifest = m
                return m
            except Exception as exc:
                logger.warning(f"Failed to load local vault manifest: {exc}")
        m = VaultManifest()
        self._manifest = m
        return m

    def save_manifest(self, manifest: VaultManifest) -> None:
        # Ensure SHA-256 hashes for any present local vault files are recorded
        for p in (self.local_activities_path, self.local_wellness_path):
            if p.exists():
                manifest.file_hashes[p.name] = compute_file_sha256(p)
        for p in list(self.work_dir.glob("streams_*.parquet")) + list(self.work_dir.glob("raw_*.zip")):
            if p.exists():
                manifest.file_hashes[p.name] = compute_file_sha256(p)
        self._manifest = manifest
        payload = manifest.model_dump_json(indent=2)
        self.local_manifest_path.write_text(payload, encoding="utf-8")
        if self.storage_client is not None:
            self.storage_client.write_text_atomic(self.remote_path("vault_manifest.json"), payload)

    # ------------------------------------------------------------------
    # DuckDB connection helper
    # ------------------------------------------------------------------

    def _get_con(self) -> duckdb.DuckDBPyConnection:
        if self._con is None:
            self._con = duckdb.connect(database=":memory:")
        return self._con

    @staticmethod
    def _atomic_copy_parquet_query(con: duckdb.DuckDBPyConnection, select_sql: str, dest: Path) -> None:
        dest.parent.mkdir(parents=True, exist_ok=True)
        tmp = dest.with_suffix(".parquet.tmp")
        if tmp.exists():
            tmp.unlink()
        escaped = str(tmp).replace("'", "''")
        con.execute(f"COPY ({select_sql}) TO '{escaped}' (FORMAT PARQUET, COMPRESSION ZSTD)")
        if dest.exists():
            dest.unlink()
        tmp.rename(dest)

    def _bulk_write_ndjson_parquet(
        self,
        records: List[Dict[str, Any]],
        columns_spec: Dict[str, str],
        empty_ddl: str,
        dest: Path,
    ) -> None:
        con = self._get_con()
        if not records:
            con.execute(f"DROP TABLE IF EXISTS _empty_stage")
            con.execute(f"CREATE TEMP TABLE _empty_stage ({empty_ddl})")
            self._atomic_copy_parquet_query(con, "SELECT * FROM _empty_stage", dest)
            con.execute("DROP TABLE IF EXISTS _empty_stage")
            return

        tmp_ndjson = dest.with_suffix(".ndjson.tmp")
        try:
            with open(tmp_ndjson, "w", encoding="utf-8") as f:
                for rec in records:
                    f.write(json.dumps(rec, separators=(",", ":"), ensure_ascii=False))
                    f.write("\n")
            escaped_ndjson = str(tmp_ndjson).replace("'", "''")
            cols_sql = ", ".join(f"'{k}': '{v}'" for k, v in columns_spec.items())
            select_sql = (
                f"SELECT * FROM read_json('{escaped_ndjson}', "
                f"format='newline_delimited', columns={{{cols_sql}}})"
            )
            self._atomic_copy_parquet_query(con, select_sql, dest)
        finally:
            if tmp_ndjson.exists():
                tmp_ndjson.unlink()

    # ------------------------------------------------------------------
    # Activities (activities.parquet)
    # ------------------------------------------------------------------

    def load_activities(self, pull_remote: bool = True) -> List[Dict[str, Any]]:
        if pull_remote and self.storage_client is not None:
            self._pull_file("activities.parquet", self.local_activities_path)
        if not self.local_activities_path.exists():
            return []
        con = self._get_con()
        escaped = str(self.local_activities_path).replace("'", "''")
        rows = con.execute(
            f"SELECT payload_json FROM read_parquet('{escaped}') ORDER BY start_time ASC, id ASC"
        ).fetchall()
        out: List[Dict[str, Any]] = []
        for (payload_str,) in rows:
            if payload_str:
                out.append(json.loads(payload_str))
        return out

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
        records: List[Dict[str, Any]] = []
        for aid, act in dedup.items():
            # Strip heavy streams from index table (stored in streams_YYYY.parquet)
            idx_copy = dict(act)
            idx_copy.pop("gps_track", None)
            idx_copy.pop("telemetry_stream", None)

            start_t = str(idx_copy.get("start_time") or idx_copy.get("date") or "")
            date_s = str(idx_copy.get("date") or start_t[:10] or "")
            yr = _extract_year(start_t or date_s)
            raw_act_type = idx_copy.get("raw_activity_type")
            records.append({
                "id": aid,
                "start_time": start_t,
                "date": date_s,
                "year": yr,
                "sport": str(idx_copy.get("sport") or "other"),
                "name": str(idx_copy.get("name") or idx_copy.get("title") or ""),
                "distance_meters": _safe_float(idx_copy.get("distance_meters")),
                "duration_seconds": _safe_float(idx_copy.get("duration_seconds")),
                "moving_time_seconds": _safe_float(idx_copy.get("moving_time_seconds")),
                "elevation_gain_meters": _safe_float(idx_copy.get("elevation_gain_meters")),
                "avg_hr": _safe_float(idx_copy.get("avg_hr")),
                "max_hr": _safe_float(idx_copy.get("max_hr")),
                "calories": _safe_float(idx_copy.get("calories")),
                "avg_power": _safe_float(idx_copy.get("avg_power")),
                "tss": _safe_float(idx_copy.get("tss")),
                "avg_cadence": _safe_float(idx_copy.get("avg_cadence")),
                "avg_pace_sec_km": _safe_float(idx_copy.get("avg_pace_sec_km")),
                "raw_activity_type": str(raw_act_type) if raw_act_type is not None else None,
                "has_streams": bool(idx_copy.get("has_streams") or act.get("gps_track") or act.get("telemetry_stream")),
                "summary_polyline": idx_copy.get("summary_polyline"),
                "updated_at": now_iso,
                "payload_json": json.dumps(idx_copy, separators=(",", ":"), ensure_ascii=False),
            })

        columns_spec = {
            "id": "VARCHAR",
            "start_time": "VARCHAR",
            "date": "VARCHAR",
            "year": "VARCHAR",
            "sport": "VARCHAR",
            "name": "VARCHAR",
            "distance_meters": "DOUBLE",
            "duration_seconds": "DOUBLE",
            "moving_time_seconds": "DOUBLE",
            "elevation_gain_meters": "DOUBLE",
            "avg_hr": "DOUBLE",
            "max_hr": "DOUBLE",
            "calories": "DOUBLE",
            "avg_power": "DOUBLE",
            "tss": "DOUBLE",
            "avg_cadence": "DOUBLE",
            "avg_pace_sec_km": "DOUBLE",
            "raw_activity_type": "VARCHAR",
            "has_streams": "BOOLEAN",
            "summary_polyline": "VARCHAR",
            "updated_at": "VARCHAR",
            "payload_json": "VARCHAR",
        }
        empty_ddl = ", ".join(f"{k} {v}" for k, v in columns_spec.items())
        self._bulk_write_ndjson_parquet(records, columns_spec, empty_ddl, self.local_activities_path)

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
        con = self._get_con()
        escaped = str(self.local_wellness_path).replace("'", "''")
        rows = con.execute(
            f"SELECT payload_json FROM read_parquet('{escaped}') ORDER BY date ASC"
        ).fetchall()
        out: List[Dict[str, Any]] = []
        for (payload_str,) in rows:
            if payload_str:
                out.append(json.loads(payload_str))
        return out

    def save_wellness(self, records_list: List[Dict[str, Any]], push_remote: bool = True) -> int:
        dedup: Dict[str, Dict[str, Any]] = {}
        for rec in records_list:
            if not isinstance(rec, dict) or not rec.get("date"):
                continue
            dedup[str(rec["date"])[:10]] = rec

        now_iso = datetime.now(timezone.utc).isoformat()
        rows: List[Dict[str, Any]] = []
        for cdate in sorted(dedup.keys()):
            rec = dedup[cdate]
            rows.append({
                "date": cdate,
                "year": _extract_year(cdate),
                "resting_hr": _safe_float(rec.get("resting_hr")),
                "hrv_ms": _safe_float(
                    _first_not_none(rec, "hrv_last_night_avg", "hrv_ms", "hrv_weekly_avg", "hrv")
                ),
                "sleep_seconds": _safe_float(rec.get("sleep_seconds")),
                "sleep_score": _safe_float(rec.get("sleep_score")),
                "stress_level": _safe_float(rec.get("stress_level")),
                "body_battery_max": _safe_float(_first_not_none(rec, "body_battery_high", "body_battery_max")),
                "body_battery_min": _safe_float(_first_not_none(rec, "body_battery_low", "body_battery_min")),
                "steps": _safe_int(rec.get("steps")),
                "vo2_max": _safe_float(_first_not_none(rec, "vo2_max", "vo2max_running", "vo2max_cycling")),
                "training_readiness": _safe_float(_first_not_none(rec, "training_readiness", "training_readiness_score")),
                "updated_at": now_iso,
                "payload_json": json.dumps(rec, separators=(",", ":"), ensure_ascii=False),
            })

        columns_spec = {
            "date": "VARCHAR",
            "year": "VARCHAR",
            "resting_hr": "DOUBLE",
            "hrv_ms": "DOUBLE",
            "sleep_seconds": "DOUBLE",
            "sleep_score": "DOUBLE",
            "stress_level": "DOUBLE",
            "body_battery_max": "DOUBLE",
            "body_battery_min": "DOUBLE",
            "steps": "BIGINT",
            "vo2_max": "DOUBLE",
            "training_readiness": "DOUBLE",
            "updated_at": "VARCHAR",
            "payload_json": "VARCHAR",
        }
        empty_ddl = ", ".join(f"{k} {v}" for k, v in columns_spec.items())
        self._bulk_write_ndjson_parquet(rows, columns_spec, empty_ddl, self.local_wellness_path)

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
        con = self._get_con()
        escaped = str(local_p).replace("'", "''")
        rows = con.execute(
            f"SELECT activity_id, payload_json FROM read_parquet('{escaped}')"
        ).fetchall()
        out: Dict[str, Dict[str, Any]] = {}
        for aid, payload_str in rows:
            if aid and payload_str:
                out[str(aid)] = json.loads(payload_str)
        return out

    def save_year_streams(
        self,
        year: str,
        streams_map: Dict[str, Dict[str, Any]],
        push_remote: bool = True,
    ) -> int:
        local_p = self.local_streams_path(year)
        now_iso = datetime.now(timezone.utc).isoformat()
        rows: List[Dict[str, Any]] = []
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
            rows.append({
                "activity_id": str(aid),
                "year": str(year),
                "updated_at": now_iso,
                "payload_json": json.dumps(shard_clean, separators=(",", ":"), ensure_ascii=False),
            })

        columns_spec = {
            "activity_id": "VARCHAR",
            "year": "VARCHAR",
            "updated_at": "VARCHAR",
            "payload_json": "VARCHAR",
        }
        empty_ddl = ", ".join(f"{k} {v}" for k, v in columns_spec.items())
        self._bulk_write_ndjson_parquet(rows, columns_spec, empty_ddl, local_p)

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
        con = self._get_con()
        escaped = str(self.local_activities_path).replace("'", "''")
        con.execute(f"CREATE OR REPLACE VIEW activities AS SELECT * FROM read_parquet('{escaped}')")
        return con.execute(sql).fetchall()
