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
import re
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
    decode_polyline,
    encode_polyline,
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
REMOTE_CANONICAL_PATH = "garmin_archive/metadata/canonical_activities.json"
REMOTE_SESSION_PATH = "garmin_archive/.session/garmin_oauth.json"


SPORT_TAXONOMY_MAP: Dict[str, str] = {
    # Cycling
    "cycling": "cycling", "cycle": "cycling", "biking": "cycling",
    "road_biking": "cycling", "mountain_biking": "cycling", "gravel_cycling": "cycling",
    "virtual_ride": "cycling", "indoor_cycling": "cycling", "handcycling": "cycling", "bmx": "cycling",
    
    # Strength
    "strength": "strength", "weights": "strength", "strength_training": "strength",
    "weight": "strength", "fitness_equipment": "strength", "gym": "strength",
    "functional_strength_training": "strength",
    
    # Running
    "running": "running", "run": "running", "trail_running": "running",
    "treadmill_running": "running", "track_running": "running", "ultra_run": "running",
    "street_running": "running",
    
    # Hiking
    "hiking": "hiking", "hike": "hiking", "mountaineering": "hiking", "backpacking": "hiking",
    
    # Walking
    "walking": "walking", "walk": "walking", "speed_walking": "walking",
    "casual_walking": "walking", "strolling": "walking",
    
    # Swimming
    "swimming": "swimming", "swim": "swimming", "lap_swimming": "swimming",
    "open_water_swimming": "swimming",
    
    # Rowing & Paddling
    "rowing": "rowing", "row": "rowing", "indoor_rowing": "rowing",
    "paddling": "rowing", "kayaking": "rowing", "canoeing": "rowing",
    "stand_up_paddleboarding": "rowing", "sup": "rowing",
    
    # Yoga & Mobility
    "yoga": "yoga", "pilates": "yoga", "stretching": "yoga", "mobility": "yoga",
    
    # Cardio / Fitness
    "cardio": "cardio", "cardio_training": "cardio", "aerobic": "cardio",
    "hiit": "cardio", "elliptical": "cardio", "stair_climbing": "cardio", "floor_climbing": "cardio",
    
    # Winter sports
    "skiing": "skiing", "resort_skiing": "skiing", "cross_country_skiing": "skiing",
    "snowboarding": "snowboarding", "ice_skating": "ice_skating",
}


def resolve_sport_taxonomy(summary_or_type: Any) -> str:
    """Standardize raw Garmin activity types into canonical sport keys while preserving dynamic sports."""
    if isinstance(summary_or_type, dict):
        raw = (
            summary_or_type.get("activityType", {}).get("typeKey")
            if isinstance(summary_or_type.get("activityType"), dict)
            else summary_or_type.get("activityType")
            or summary_or_type.get("sport")
            or summary_or_type.get("typeKey")
            or ""
        )
    else:
        raw = str(summary_or_type or "")

    raw_clean = re.sub(r"[^a-zA-Z0-9_]+", "_", str(raw).strip().lower()).strip("_")
    if not raw_clean:
        return "hiking"

    if raw_clean in SPORT_TAXONOMY_MAP:
        return SPORT_TAXONOMY_MAP[raw_clean]

    # Keyword heuristic resolution
    if any(k in raw_clean for k in ("strength", "weight", "fitness_equipment", "gym")):
        return "strength"
    if any(k in raw_clean for k in ("cycl", "biking", "ride", "gravel")):
        return "cycling"
    if any(k in raw_clean for k in ("running", "trail_run", "treadmill")):
        return "running"
    if raw_clean == "run" or raw_clean.endswith("_run") or raw_clean.startswith("run_"):
        return "running"
    if any(k in raw_clean for k in ("hiking", "mountaineer", "backpack")):
        return "hiking"
    if raw_clean == "hike" or raw_clean.endswith("_hike") or raw_clean.startswith("hike_"):
        return "hiking"
    if any(k in raw_clean for k in ("walking", "stroll")):
        return "walking"
    if raw_clean == "walk" or raw_clean.endswith("_walk") or raw_clean.startswith("walk_"):
        return "walking"
    if any(k in raw_clean for k in ("swim", "swimming", "pool")):
        return "swimming"
    if any(k in raw_clean for k in ("rowing", "paddl", "kayak", "canoe", "paddleboard")):
        return "rowing"
    if any(k in raw_clean for k in ("yoga", "pilates", "stretch")):
        return "yoga"
    if any(k in raw_clean for k in ("ski", "snowboard")):
        return "skiing"

    # Preserve dynamic sport identifier
    return raw_clean


def normalize_splits(
    raw_splits: List[Dict[str, Any]],
    sport: str = "hiking",
    default_hr: int = 130,
    default_cadence: int = 0,
) -> List[Dict[str, Any]]:
    """Normalize raw Garmin lapDTOs or splits into canonical split objects."""
    if not isinstance(raw_splits, list):
        return []

    is_strength = sport in ("strength", "weights")
    zero_indexed = any(isinstance(r, dict) and r.get("lapIndex") == 0 for r in raw_splits)

    normalized: List[Dict[str, Any]] = []
    for idx, raw in enumerate(raw_splits):
        if not isinstance(raw, dict):
            continue

        # 1. split_number (1-indexed)
        if raw.get("split_number") is not None:
            split_num = int(raw["split_number"])
        elif raw.get("lapIndex") is not None:
            lap_val = int(raw["lapIndex"])
            split_num = (lap_val + 1) if zero_indexed else (lap_val if lap_val >= 1 else idx + 1)
        elif raw.get("km") is not None:
            split_num = int(raw["km"])
        elif raw.get("lap") is not None:
            split_num = int(raw["lap"])
        elif raw.get("lap_number") is not None:
            split_num = int(raw["lap_number"])
        elif raw.get("splitNumber") is not None:
            split_num = int(raw["splitNumber"])
        else:
            split_num = idx + 1

        # 2. duration_seconds & split_sec
        dur = float(
            raw.get("duration")
            or raw.get("durationInSeconds")
            or raw.get("durationSeconds")
            or raw.get("duration_seconds")
            or raw.get("movingDuration")
            or raw.get("split_sec")
            or 0.0
        )
        duration_sec = int(round(dur))

        # 3. distance_meters
        if is_strength:
            dist_m = 0.0
        else:
            dist_m = float(
                raw.get("distance")
                or raw.get("distanceInMeters")
                or raw.get("distance_meters")
                or raw.get("distanceM")
                or 0.0
            )

        # 4. avg_hr
        hr_val = (
            raw.get("averageHR")
            or raw.get("averageHeartRateInBeatsPerMinute")
            or raw.get("avg_hr")
            or raw.get("avgHr")
            or raw.get("avgHR")
            or default_hr
            or 0
        )
        avg_hr = int(round(float(hr_val)))

        # 5. avg_cadence
        if is_strength:
            avg_cadence = 0
        elif sport == "cycling":
            cad_val = (
                raw.get("averageBikingCadenceInRevPerMinute")
                or raw.get("avg_cadence")
                or raw.get("avgCadence")
                or default_cadence
                or 0
            )
            avg_cadence = int(round(float(cad_val)))
        else:
            cad_val = (
                raw.get("averageRunCadenceInStepsPerMinute")
                or raw.get("averageRunningCadenceInStepsPerMinute")
                or raw.get("avg_cadence")
                or raw.get("avgCadence")
                or default_cadence
                or 0
            )
            avg_cadence = int(round(float(cad_val)))

        # 6. elevation_diff
        if is_strength:
            elevation_diff = 0
        elif "elevation_diff" in raw:
            elevation_diff = int(round(float(raw["elevation_diff"])))
        elif "elevationGain" in raw or "elevationLoss" in raw:
            gain = float(raw.get("elevationGain") or 0.0)
            loss = float(raw.get("elevationLoss") or 0.0)
            elevation_diff = int(round(gain - loss))
        elif "elevation_gain_meters" in raw or "elevation_gain" in raw:
            elevation_diff = int(round(float(raw.get("elevation_gain_meters") or raw.get("elevation_gain") or 0.0)))
        else:
            elevation_diff = 0

        # 7. speed_mps
        raw_speed = (
            raw.get("averageSpeed")
            or raw.get("averageSpeedInMetersPerSecond")
            or raw.get("speed_mps")
            or raw.get("speed")
        )
        if raw_speed is not None and float(raw_speed) > 0:
            speed_mps: Optional[float] = round(float(raw_speed), 2)
        elif dist_m > 0 and duration_sec > 0:
            speed_mps = round(dist_m / duration_sec, 2)
        else:
            speed_mps = None if is_strength else 0.0

        canonical_split = {
            "km": split_num,
            "split_number": split_num,
            "distance_meters": round(dist_m, 1),
            "duration_seconds": duration_sec,
            "split_sec": duration_sec,
            "avg_hr": avg_hr,
            "avg_cadence": avg_cadence,
            "elevation_diff": elevation_diff,
            "speed_mps": speed_mps,
        }
        normalized.append(canonical_split)

    return normalized


def normalize_garmin_activity(payload: Dict[str, Any]) -> Dict[str, Any]:
    """Normalize a raw Garmin summary+details payload into canonical rollup format."""
    summary = payload.get("summary") or payload
    details = payload.get("details") or {}

    sport = resolve_sport_taxonomy(summary)

    act_id = str(summary.get("activityId") or summary.get("id") or int(time.time()))
    start_str = (
        summary.get("startTimeGMT")
        or summary.get("startTimeLocal")
        or summary.get("date")
        or datetime.now(timezone.utc).isoformat()
    )
    if " " in start_str and "T" not in start_str:
        start_str = start_str.replace(" ", "T") + "Z"

    dur_sec = int(float(summary.get("duration") or summary.get("durationInSeconds") or summary.get("duration_seconds") or 0))
    moving_sec = int(float(summary.get("movingDuration") or summary.get("moving_time_seconds") or dur_sec))
    dist_m = 0.0 if sport in ("strength", "weights") else float(summary.get("distance") or summary.get("distanceInMeters") or summary.get("distance_meters") or 0.0)
    avg_hr = int(float(summary.get("averageHR") or summary.get("averageHeartRateInBeatsPerMinute") or summary.get("avg_hr") or 130))
    max_hr = int(float(summary.get("maxHR") or summary.get("maxHeartRateInBeatsPerMinute") or summary.get("max_hr") or max(avg_hr + 15, 145)))
    elev_m = 0 if sport in ("strength", "weights", "swimming") else int(float(summary.get("elevationGain") or summary.get("elevation_gain_meters") or 0))
    avg_power = None if sport != "cycling" else (summary.get("avgPower") or summary.get("averagePower") or summary.get("avg_power"))

    if sport in ("strength", "weights"):
        avg_cadence = 0
    elif sport == "cycling":
        avg_cadence = int(float(summary.get("averageBikingCadenceInRevPerMinute") or summary.get("avg_cadence") or 0))
    else:
        avg_cadence = int(float(
            summary.get("averageRunCadenceInStepsPerMinute")
            or summary.get("averageRunningCadenceInStepsPerMinute")
            or summary.get("avg_cadence")
            or 0
        ))

    tss = float(summary.get("activityTrainingLoad") or summary.get("trainingStressScore") or summary.get("tss") or round((dur_sec / 3600.0) * (avg_hr / 145.0) * 55.0, 1))

    if sport in ("hiking", "running", "walking") and dist_m > 0 and dur_sec > 0:
        avg_pace_sec_km = round(dur_sec / (dist_m / 1000.0), 1)
    else:
        avg_pace_sec_km = None

    raw_splits = (
        details.get("splits")
        or details.get("lapDTOs")
        or summary.get("splits")
        or summary.get("lapDTOs")
        or []
    )
    raw_laps = (
        details.get("laps")
        or details.get("lapDTOs")
        or summary.get("laps")
        or summary.get("lapDTOs")
        or []
    )

    if not raw_splits and raw_laps:
        raw_splits = raw_laps
    if not raw_laps and raw_splits:
        raw_laps = raw_splits

    canonical_splits = normalize_splits(raw_splits, sport=sport, default_hr=avg_hr, default_cadence=avg_cadence)
    canonical_laps = normalize_splits(raw_laps, sport=sport, default_hr=avg_hr, default_cadence=avg_cadence)

    # Live GPS extraction
    gps_track = details.get("gps_track")
    telemetry_stream = details.get("telemetry_stream")

    if not gps_track and "geoPolylineDTO" in details and isinstance(details["geoPolylineDTO"], dict):
        poly_raw = details["geoPolylineDTO"].get("polyline")
        if isinstance(poly_raw, str) and poly_raw:
            pts = decode_polyline(poly_raw)
            if pts:
                min_lat = min(p[0] for p in pts)
                max_lat = max(p[0] for p in pts)
                min_lon = min(p[1] for p in pts)
                max_lon = max(p[1] for p in pts)
                gps_track = {
                    "polyline": poly_raw,
                    "points": [[p[0], p[1], 0.0, avg_hr] for p in pts],
                    "bounds": [[min_lat, min_lon], [max_lat, max_lon]],
                }
        elif isinstance(poly_raw, list) and poly_raw:
            pts_full: List[List[float]] = []
            lat_lon_pairs: List[Tuple[float, float]] = []
            time_stream: List[int] = []
            elev_stream: List[float] = []
            hr_stream: List[int] = []
            for idx_pt, pt in enumerate(poly_raw):
                if isinstance(pt, dict) and pt.get("lat") is not None and pt.get("lon") is not None:
                    lat_f = float(pt["lat"])
                    lon_f = float(pt["lon"])
                    if abs(lat_f) < 0.001 and abs(lon_f) < 0.001:
                        continue
                    alt_f = round(float(pt.get("altitude") or pt.get("elevation") or 0.0), 1)
                    hr_i = int(float(pt.get("hr") or pt.get("heartRate") or avg_hr))
                    pts_full.append([lat_f, lon_f, alt_f, hr_i])
                    lat_lon_pairs.append((lat_f, lon_f))
                    t_sec = int((idx_pt / max(1, len(poly_raw) - 1)) * dur_sec)
                    time_stream.append(t_sec)
                    elev_stream.append(alt_f)
                    hr_stream.append(hr_i)
            if pts_full:
                min_lat = min(p[0] for p in pts_full)
                max_lat = max(p[0] for p in pts_full)
                min_lon = min(p[1] for p in pts_full)
                max_lon = max(p[1] for p in pts_full)
                gps_track = {
                    "polyline": encode_polyline(lat_lon_pairs),
                    "points": pts_full,
                    "bounds": [[min_lat, min_lon], [max_lat, max_lon]],
                }
                if not telemetry_stream:
                    telemetry_stream = {
                        "time": time_stream,
                        "elevation": elev_stream,
                        "hr": hr_stream,
                    }

    # If no splits were returned by Garmin, synthesize clean per-km splits from summary so drawer is never blank
    if not canonical_splits and dur_sec > 0:
        if sport in ("strength", "weights") or dist_m <= 0:
            block_count = max(1, min(6, dur_sec // 600))
            block_dur = dur_sec // block_count
            canonical_splits = [
                {
                    "km": i + 1,
                    "split_number": i + 1,
                    "distance_meters": 0.0,
                    "duration_seconds": block_dur,
                    "split_sec": block_dur,
                    "avg_hr": avg_hr,
                    "avg_cadence": 0,
                    "elevation_diff": 0,
                    "speed_mps": None,
                }
                for i in range(block_count)
            ]
        else:
            km_count = max(1, min(50, int(round(dist_m / 1000.0))))
            split_dist = dist_m / km_count
            split_dur = int(round(dur_sec / km_count))
            split_elev = int(round(elev_m / km_count))
            split_speed = round(split_dist / max(1, split_dur), 2)
            canonical_splits = [
                {
                    "km": i + 1,
                    "split_number": i + 1,
                    "distance_meters": round(split_dist, 1),
                    "duration_seconds": split_dur,
                    "split_sec": split_dur,
                    "avg_hr": avg_hr,
                    "avg_cadence": avg_cadence,
                    "elevation_diff": split_elev,
                    "speed_mps": split_speed,
                }
                for i in range(km_count)
            ]
        canonical_laps = list(canonical_splits)

    if sport in ("strength", "weights"):
        gps_track = None
        telemetry_stream = None

    return {
        "id": act_id,
        "date": start_str,
        "start_time": start_str,
        "sport": sport,
        "title": summary.get("activityName") or summary.get("title") or sport.replace("_", " ").title(),
        "distance_meters": dist_m,
        "duration_seconds": dur_sec,
        "moving_time_seconds": moving_sec,
        "calories": int(float(summary.get("calories") or round(dur_sec * 0.18))),
        "avg_hr": avg_hr,
        "max_hr": max_hr,
        "avg_pace_sec_km": avg_pace_sec_km,
        "avg_cadence": avg_cadence,
        "avg_power": int(float(avg_power)) if avg_power is not None else None,
        "avg_power_watts": int(float(avg_power)) if avg_power is not None else None,
        "elevation_gain_meters": elev_m,
        "tss": round(tss, 1),
        "training_stress_score": round(tss, 1),
        "splits": canonical_splits,
        "laps": canonical_laps,
        "hr_zones": details.get("hr_zones") or summary.get("hr_zones") or {},
        "gps_track": gps_track,
        "telemetry_stream": telemetry_stream,
    }


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
    version: str = "1.1.0"
    last_sync_timestamp: int = Field(default=0, description="Epoch seconds of high-water mark")
    last_sync_datetime: str = Field(default="1970-01-01T00:00:00Z")
    total_synced_activities: int = Field(default=0)
    synced_activity_ids: List[str] = Field(default_factory=list)
    activities_by_year: Dict[str, int] = Field(default_factory=dict)
    formats_backed_up: Dict[str, int] = Field(default_factory=lambda: {"fit": 0, "gpx": 0, "json": 0})
    archival_health: str = Field(default="healthy", description="'healthy' | 'warning' | 'error'")
    integrity_verified: bool = Field(default=True)
    history: List[SyncHistoryEntry] = Field(default_factory=list)

    def is_synced(self, activity_id: str) -> bool:
        return str(activity_id) in set(self.synced_activity_ids)

    def record_activity(
        self,
        activity_id: str,
        year: Optional[str] = None,
        formats: Optional[List[str]] = None,
    ) -> None:
        act_str = str(activity_id)
        if act_str not in self.synced_activity_ids:
            self.synced_activity_ids.append(act_str)
            self.total_synced_activities = len(self.synced_activity_ids)

            if year:
                year_key = str(year)
                self.activities_by_year[year_key] = self.activities_by_year.get(year_key, 0) + 1

            if formats:
                for fmt in formats:
                    fmt_key = fmt.lower().strip()
                    self.formats_backed_up[fmt_key] = self.formats_backed_up.get(fmt_key, 0) + 1

    def to_json(self) -> str:
        return self.model_dump_json(indent=2)

    @classmethod
    def from_json(cls, text: str) -> SyncManifest:
        return cls.model_validate_json(text)


def verify_archive_integrity(
    sftp_client: Any,
    manifest: SyncManifest,
    base_dir: str = "garmin_archive",
) -> bool:
    """
    Reconciles remote SFTP archive inventory against manifest tracking.
    Updates manifest.archival_health and manifest.integrity_verified.
    """
    try:
        if hasattr(sftp_client, "scan_archive_inventory"):
            inv = sftp_client.scan_archive_inventory(base_dir=base_dir)
            total_inv_acts = inv.get("total_activities", 0)
        else:
            total_inv_acts = manifest.total_synced_activities

        if total_inv_acts < manifest.total_synced_activities:
            logger.warning(
                f"Archive inventory mismatch: remote has {total_inv_acts} activities, "
                f"manifest expects {manifest.total_synced_activities}."
            )
            manifest.archival_health = "warning"
            manifest.integrity_verified = False
            return False

        manifest.archival_health = "healthy"
        manifest.integrity_verified = True
        return True
    except Exception as e:
        logger.error(f"Error during archive integrity verification: {e}")
        manifest.archival_health = "warning"
        manifest.integrity_verified = False
        return False


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
        backed_up_formats = ["json"]

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
            backed_up_formats.append("fit")

        # 4. Download, Stage & Upload .GPX file (outdoor activities)
        gpx_bytes = None
        if hasattr(garmin_client, "download_gpx_file"):
            gpx_bytes = garmin_client.download_gpx_file(activity_id)
        elif hasattr(garmin_client, "fetch_gpx_file"):
            gpx_bytes = garmin_client.fetch_gpx_file(activity_id)

        if gpx_bytes:
            local_gpx_path = local_subfolder / f"{activity_id}.gpx"
            with open(local_gpx_path, "wb") as f:
                f.write(gpx_bytes)

            remote_gpx_path = f"{remote_subfolder}/{activity_id}.gpx"
            sftp_client.put_file(local_gpx_path, remote_gpx_path)
            backed_up_formats.append("gpx")

        # 5. Mark synced in manifest with multi-year and format accounting
        manifest.record_activity(activity_id, year=year_str, formats=backed_up_formats)
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

        verify_archive_integrity(sftp_client, manifest)
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
        if is_mock:
            gen = SyntheticDatasetGenerator(seed=42)
            canonical_acts = gen.generate_activities()
        else:
            existing_acts_map: Dict[str, Dict[str, Any]] = {}
            if sftp_client.file_exists(REMOTE_CANONICAL_PATH):
                try:
                    raw_existing = sftp_client.read_text(REMOTE_CANONICAL_PATH)
                    if raw_existing:
                        for item in json.loads(raw_existing):
                            act_key = str(item.get("id"))
                            splits_curr = item.get("splits") or []
                            has_broken_splits = not splits_curr or any(
                                isinstance(s, dict) and not s.get("duration_seconds") for s in splits_curr
                            )
                            is_outdoor = item.get("sport") not in ("strength", "weights", "yoga", "cardio")
                            needs_gps = is_outdoor and not item.get("gps_track")
                            if has_broken_splits or needs_gps:
                                try:
                                    fresh_details = garmin_client.get_activity_details(act_key) or {}
                                except Exception:
                                    fresh_details = {}
                                item = normalize_garmin_activity({"summary": item, "details": fresh_details})
                            existing_acts_map[act_key] = item
                except Exception as e:
                    logger.warning(f"Could not read existing canonical activities: {e}")

            for payload in new_activities:
                norm_act = normalize_garmin_activity(payload)
                existing_acts_map[str(norm_act["id"])] = norm_act

            canonical_acts = list(existing_acts_map.values())
            sftp_client.write_text_atomic(REMOTE_CANONICAL_PATH, json.dumps(canonical_acts, indent=2))

        rollup_dict = compile_rollup(canonical_acts, sync_manifest=manifest)

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
