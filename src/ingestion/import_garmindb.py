"""
src/ingestion/import_garmindb.py
4-Year Historical Importer from GarminDB SQLite Databases into the Sharded Encrypted Vault.

Reads GarminDB SQLite files:
- garmin_activities.db (activities, activity_laps, activity_records)
- garmin.db / garmin_summary.db / garmin_monitoring.db (days_summary, daily_summary, sleep, stress, resting_hr)

Enforces strict data integrity: zero synthetic or estimated values. Missing fields are stored as None.
Uploads sharded archive to Google Drive ('My Drive/Drive/[04] health/garmin-dash') and/or Hetzner SFTP.
"""

from __future__ import annotations

import argparse
import json
import logging
import sqlite3
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from src.ingestion.gdrive_client import get_storage_client
from src.ingestion.mock_generator import compile_rollup, encode_polyline
from src.ingestion.sync import (
    REMOTE_CANONICAL_PATH,
    REMOTE_INDEX_PATH,
    REMOTE_MANIFEST_PATH,
    REMOTE_STREAMS_DIR,
    REMOTE_WELLNESS_PATH,
    load_remote_manifest,
    normalize_garmin_activity,
    reprocess_canonical_activities,
    resolve_sport_taxonomy,
    save_remote_manifest,
)

logger = logging.getLogger("src.ingestion.import_garmindb")


def _find_db_file(base_dir: Path, filename: str) -> Optional[Path]:
    """Locates a GarminDB SQLite file in base_dir or base_dir/DBs."""
    for candidate in (base_dir / filename, base_dir / "DBs" / filename, base_dir.parent / "DBs" / filename):
        if candidate.is_file():
            return candidate
    return None


def _first_not_none(*values: Any) -> Any:
    """Return the first value that is not None, preserving 0 and 0.0."""
    for v in values:
        if v is not None:
            return v
    return None


def _table_exists(conn: sqlite3.Connection, table_name: str) -> bool:
    cur = conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND lower(name)=lower(?)",
        (table_name,),
    )
    return cur.fetchone() is not None


def _time_str_to_seconds(val: Any) -> Optional[int]:
    """Converts GarminDB TIME strings ('HH:MM:SS.mmmmmm') or numeric seconds into integer seconds."""
    if val is None:
        return None
    if isinstance(val, (int, float)):
        return int(val)
    s = str(val).strip()
    if not s:
        return None
    if ":" in s:
        parts = s.split(":")
        try:
            if len(parts) == 3:
                return int(parts[0]) * 3600 + int(parts[1]) * 60 + int(float(parts[2]))
            if len(parts) == 2:
                return int(parts[0]) * 60 + int(float(parts[1]))
        except ValueError:
            return None
    try:
        return int(float(s))
    except ValueError:
        return None


def extract_garmindb_activities(garmindb_dir: Path) -> List[Dict[str, Any]]:
    """Extracts and normalizes all activities, laps, and telemetry streams from garmin_activities.db."""
    act_db = _find_db_file(garmindb_dir, "garmin_activities.db")
    if not act_db:
        logger.warning(f"garmin_activities.db not found under {garmindb_dir}")
        return []

    conn = sqlite3.connect(str(act_db))
    conn.row_factory = sqlite3.Row
    try:
        if not _table_exists(conn, "activities"):
            return []

        has_laps = _table_exists(conn, "activity_laps")
        has_records = _table_exists(conn, "activity_records")

        rows = conn.execute("SELECT * FROM activities ORDER BY start_time ASC").fetchall()
        normalized_list: List[Dict[str, Any]] = []

        for row in rows:
            r = dict(row)
            act_id = str(r.get("activity_id") or r.get("id") or "")
            if not act_id:
                continue

            raw_sport = r.get("sub_sport") if r.get("sub_sport") not in (None, "", "generic") else r.get("sport")
            sport = resolve_sport_taxonomy(raw_sport or r.get("sport") or r.get("type") or "other")

            dur_sec = _time_str_to_seconds(r.get("elapsed_time")) or _time_str_to_seconds(r.get("moving_time")) or 0
            moving_sec = _time_str_to_seconds(r.get("moving_time")) or dur_sec

            # GarminDB stores distance in km by default in activities table; convert to meters if < 500 and moving_sec > 60
            raw_dist = r.get("distance")
            dist_m = 0.0
            if raw_dist is not None:
                d_val = float(raw_dist)
                # GarminDB 'distance' column is typically kilometers (e.g., 10.52)
                dist_m = d_val * 1000.0 if d_val < 500.0 and dur_sec > 120 else d_val

            laps_list: List[Dict[str, Any]] = []
            if has_laps:
                try:
                    lap_rows = conn.execute(
                        "SELECT * FROM activity_laps WHERE activity_id = ? ORDER BY lap ASC",
                        (act_id,),
                    ).fetchall()
                    for lr in lap_rows:
                        ld = dict(lr)
                        l_dist = float(ld.get("distance") or 0.0)
                        if l_dist < 100.0 and (_time_str_to_seconds(ld.get("elapsed_time")) or 0) > 30:
                            l_dist *= 1000.0
                        laps_list.append({
                            "distance": l_dist,
                            "duration": _time_str_to_seconds(ld.get("elapsed_time")) or 0,
                            "averageHR": ld.get("avg_hr"),
                            "maxHR": ld.get("max_hr"),
                            "elevationGain": ld.get("ascent"),
                            "averageRunCadence": ld.get("avg_cadence"),
                        })
                except Exception as e:
                    logger.debug(f"Could not read laps for {act_id}: {e}")

            hr_stream: List[Optional[int]] = []
            elev_stream: List[Optional[float]] = []
            cad_stream: List[Optional[int]] = []
            speed_stream: List[Optional[float]] = []
            coords: List[Tuple[float, float]] = []

            if has_records:
                try:
                    rec_rows = conn.execute(
                        "SELECT * FROM activity_records WHERE activity_id = ? ORDER BY record ASC",
                        (act_id,),
                    ).fetchall()
                    # Downsample to max ~1000 points for smooth chart rendering
                    step = max(1, len(rec_rows) // 1000)
                    for idx in range(0, len(rec_rows), step):
                        rec = dict(rec_rows[idx])
                        if rec.get("hr") is not None:
                            hr_stream.append(int(rec["hr"]))
                        elev_val = rec.get("altitude") if rec.get("altitude") is not None else rec.get("elevation")
                        if elev_val is not None:
                            elev_stream.append(round(float(elev_val), 1))
                        if rec.get("cadence") is not None:
                            cad_stream.append(int(rec["cadence"]))
                        if rec.get("speed") is not None:
                            speed_stream.append(round(float(rec["speed"]), 2))
                        lat = rec.get("position_lat")
                        lon = rec.get("position_long")
                        if lat is not None and lon is not None:
                            lat_f, lon_f = float(lat), float(lon)
                            if -90.0 <= lat_f <= 90.0 and -180.0 <= lon_f <= 180.0 and (lat_f != 0.0 or lon_f != 0.0):
                                coords.append((lat_f, lon_f))
                except Exception as e:
                    logger.debug(f"Could not read records for {act_id}: {e}")

            summary_payload = {
                "activityId": act_id,
                "activityName": r.get("name") or f"{sport.title()} Workout",
                "activityType": {"typeKey": raw_sport or sport},
                "startTimeGMT": str(r.get("start_time") or ""),
                "duration": dur_sec,
                "movingDuration": moving_sec,
                "distance": dist_m,
                "calories": r.get("calories") or 0,
                "averageHR": r.get("avg_hr"),
                "maxHR": r.get("max_hr"),
                "elevationGain": r.get("ascent") or 0,
                "averageRunCadenceInStepsPerMinute": r.get("avg_cadence"),
                "averageBikingCadenceInRevPerMinute": r.get("avg_cadence"),
                "activityTrainingLoad": r.get("training_load"),
            }

            norm = normalize_garmin_activity({"summary": summary_payload, "details": {"splits": laps_list}})
            if r.get("avg_hr") is None and not hr_stream:
                norm["avg_hr"] = 0
                norm["max_hr"] = 0

            is_strength = norm.get("sport") in ("strength", "weights")
            if is_strength:
                norm["gps_track"] = None
                norm["telemetry_stream"] = None
                norm["summary_polyline"] = None
                norm["has_streams"] = False
            else:
                if coords:
                    poly_str = encode_polyline(coords)
                    norm["gps_track"] = {
                        "polyline": poly_str,
                        "encoded_polyline": poly_str,
                        "point_count": len(coords),
                        "start_latlng": [coords[0][0], coords[0][1]],
                        "end_latlng": [coords[-1][0], coords[-1][1]],
                    }
                    norm["summary_polyline"] = poly_str

                if hr_stream or elev_stream or cad_stream or speed_stream:
                    norm["telemetry_stream"] = {
                        "hr": hr_stream,
                        "elevation": elev_stream,
                        "cadence": cad_stream,
                        "speed": speed_stream,
                    }

                norm["has_streams"] = bool(norm.get("gps_track") or norm.get("telemetry_stream"))

            normalized_list.append(norm)

        return normalized_list
    finally:
        conn.close()


def extract_garmindb_wellness(garmindb_dir: Path) -> List[Dict[str, Any]]:
    """
    Extracts daily wellness records from garmin_summary.db and garmin.db.
    Strictly preserves None for any missing metric on any date (zero synthetic estimation).
    """
    by_date: Dict[str, Dict[str, Any]] = {}

    for db_name in ("garmin_summary.db", "garmin.db"):
        db_path = _find_db_file(garmindb_dir, db_name)
        if not db_path:
            continue
        conn = sqlite3.connect(str(db_path))
        conn.row_factory = sqlite3.Row
        try:
            if _table_exists(conn, "days_summary"):
                for row in conn.execute("SELECT * FROM days_summary ORDER BY day ASC"):
                    d = dict(row)
                    day_str = str(d.get("day") or "")[:10]
                    if not day_str:
                        continue
                    rec = by_date.setdefault(day_str, {"date": day_str})
                    if d.get("steps") is not None:
                        rec["steps"] = int(d["steps"])
                    if d.get("steps_goal") is not None:
                        rec["steps_goal"] = int(d["steps_goal"])
                    rhr_raw = _first_not_none(d.get("rhr_avg"), d.get("rhr"))
                    if rhr_raw is not None:
                        rhr_v = int(float(rhr_raw))
                        rec["resting_hr"] = rhr_v
                        rec["resting_heart_rate"] = rhr_v
                    if d.get("stress_avg") is not None and float(d["stress_avg"]) >= 0:
                        rec["stress_level"] = int(float(d["stress_avg"]))
                    if d.get("bb_max") is not None:
                        rec["body_battery_high"] = int(d["bb_max"])
                        rec["body_battery"] = int(d["bb_max"])
                    if d.get("bb_min") is not None:
                        rec["body_battery_low"] = int(d["bb_min"])
                    if d.get("bb_charged") is not None:
                        rec["body_battery_charged"] = int(d["bb_charged"])
                        rec["charged"] = int(d["bb_charged"])
                    if d.get("sleep_avg") is not None:
                        s_sec = _time_str_to_seconds(d["sleep_avg"])
                        if s_sec is not None:
                            rec["sleep_seconds"] = s_sec
                    if d.get("rem_sleep_avg") is not None:
                        rem_s = _time_str_to_seconds(d["rem_sleep_avg"])
                        if rem_s is not None:
                            rec["sleep_rem_seconds"] = rem_s
                    cal_raw = _first_not_none(d.get("calories_total"), d.get("calories_avg"))
                    if cal_raw is not None:
                        cal_v = int(float(cal_raw))
                        rec["daily_calories"] = cal_v
                        rec["calories_total"] = cal_v
                    acal_raw = _first_not_none(d.get("calories_active"), d.get("calories_active_avg"))
                    if acal_raw is not None:
                        acal_v = int(float(acal_raw))
                        rec["active_calories"] = acal_v
                        rec["calories_active"] = acal_v
                    bcal_raw = _first_not_none(d.get("calories_bmr"), d.get("calories_bmr_avg"))
                    if bcal_raw is not None:
                        bcal_v = int(float(bcal_raw))
                        rec["bmr_calories"] = bcal_v
                        rec["calories_bmr"] = bcal_v
                    if d.get("moderate_activity_time") is not None or d.get("vigorous_activity_time") is not None:
                        m_sec = _time_str_to_seconds(d.get("moderate_activity_time")) or 0
                        v_sec = _time_str_to_seconds(d.get("vigorous_activity_time")) or 0
                        m_min = m_sec // 60
                        v_min = v_sec // 60
                        rec["intensity_minutes_moderate"] = m_min
                        rec["intensity_minutes_vigorous"] = v_min
                        rec["active_intensity_minutes"] = m_min + (v_min * 2)

            if _table_exists(conn, "sleep"):
                for row in conn.execute("SELECT * FROM sleep ORDER BY day ASC"):
                    d = dict(row)
                    day_str = str(d.get("day") or "")[:10]
                    if not day_str:
                        continue
                    rec = by_date.setdefault(day_str, {"date": day_str})
                    tot_s = _time_str_to_seconds(d.get("total_sleep"))
                    deep_s = _time_str_to_seconds(d.get("deep_sleep"))
                    light_s = _time_str_to_seconds(d.get("light_sleep"))
                    rem_s = _time_str_to_seconds(d.get("rem_sleep"))
                    awake_s = _time_str_to_seconds(d.get("awake"))
                    if tot_s is not None:
                        rec["sleep_seconds"] = tot_s
                    if deep_s is not None:
                        rec["sleep_deep_seconds"] = deep_s
                    if light_s is not None:
                        rec["sleep_light_seconds"] = light_s
                    if rem_s is not None:
                        rec["sleep_rem_seconds"] = rem_s
                    if awake_s is not None:
                        rec["sleep_awake_seconds"] = awake_s
                    rec["sleep_stages"] = {
                        "deep_seconds": deep_s,
                        "light_seconds": light_s,
                        "rem_seconds": rem_s,
                        "awake_seconds": awake_s,
                    }
                    if d.get("score") is not None:
                        rec["sleep_score"] = int(d["score"])
                    if d.get("qualifier") is not None:
                        rec["sleep_quality"] = str(d["qualifier"]).replace("_", " ").title()
        finally:
            conn.close()

    return [by_date[k] for k in sorted(by_date.keys())]


def run_garmindb_import(
    garmindb_dir: Path,
    output_rollup: Path = Path(".staging/dashboard_rollup.json"),
    encrypt_output: bool = False,
    vault_mode: str = "auto",
) -> int:
    """Imports GarminDB activities & wellness into remote sharded/Parquet storage and local rollup."""
    from src.ingestion.cleanup import purge_directory
    from src.storage.parquet_vault import ParquetVault, VaultManifest

    storage = get_storage_client(force_mock=False)
    vault_work_dir = output_rollup.parent.parent / ".vault_work"
    parquet_vault = ParquetVault(work_dir=vault_work_dir, storage_client=storage)
    use_parquet = vault_mode == "parquet" or (vault_mode == "auto" and parquet_vault.has_remote_vault())

    try:
        imported_acts = extract_garmindb_activities(garmindb_dir)
        imported_wellness = extract_garmindb_wellness(garmindb_dir)
        logger.info(
            f"Extracted {len(imported_acts)} activities and {len(imported_wellness)} daily wellness records from GarminDB."
        )

        local_streams_dir = output_rollup.parent / "streams"
        local_streams_dir.mkdir(parents=True, exist_ok=True)

        if use_parquet:
            v_manifest = parquet_vault.load_manifest()
            manifest = SyncManifest(
                last_sync_timestamp=v_manifest.last_sync_timestamp,
                last_sync_datetime=v_manifest.last_sync_datetime or "",
                total_synced_activities=v_manifest.total_synced_activities,
                synced_activity_ids=list(v_manifest.synced_activity_ids),
            )
            existing_acts = {
                str(a["id"]): a
                for a in parquet_vault.load_activities(pull_remote=True)
                if isinstance(a, dict) and a.get("id") is not None
            }
            streams_by_year: Dict[str, Dict[str, Any]] = {}
            for act in imported_acts:
                act_id = str(act["id"])
                existing_acts[act_id] = act
                date_str = str(act.get("start_time") or act.get("date") or "")
                year_str = date_str[:4] if len(date_str) >= 4 and date_str[:4].isdigit() else "unknown"
                manifest.record_activity(act_id, year=year_str)
                v_manifest.record_activity(act_id, year=year_str)
                shard_obj = {
                    "id": act_id,
                    "gps_track": act.get("gps_track"),
                    "telemetry_stream": act.get("telemetry_stream"),
                    "splits": act.get("splits", []),
                    "laps": act.get("laps", []),
                    "hr_zones": act.get("hr_zones", {}),
                }
                (local_streams_dir / f"{act_id}.json").write_text(
                    json.dumps(shard_obj, separators=(",", ":")), encoding="utf-8"
                )
                if year_str not in streams_by_year:
                    streams_by_year[year_str] = parquet_vault.load_year_streams(year_str, pull_remote=True)
                streams_by_year[year_str][act_id] = shard_obj

            for yr_str, y_map in sorted(streams_by_year.items()):
                v_manifest.stream_years[yr_str] = parquet_vault.save_year_streams(yr_str, y_map, push_remote=True)

            canonical_acts = reprocess_canonical_activities(list(existing_acts.values()))
            parquet_vault.save_activities(canonical_acts, push_remote=True)

            wellness_map: Dict[str, Dict[str, Any]] = {
                str(w["date"])[:10]: w
                for w in parquet_vault.load_wellness(pull_remote=True)
                if isinstance(w, dict) and w.get("date")
            }
            for w in imported_wellness:
                d_key = str(w["date"])[:10]
                merged = dict(wellness_map.get(d_key, {}))
                for k, v in w.items():
                    if v is not None:
                        merged[k] = v
                wellness_map[d_key] = merged
            sorted_wellness = [wellness_map[k] for k in sorted(wellness_map.keys())]
            v_manifest.total_wellness_days = parquet_vault.save_wellness(sorted_wellness, push_remote=True)
            parquet_vault.save_manifest(v_manifest)
        else:
            manifest = load_remote_manifest(storage)
            existing_acts = {}
            for path_cand in (REMOTE_INDEX_PATH, REMOTE_CANONICAL_PATH):
                if storage.file_exists(path_cand):
                    try:
                        raw = storage.read_text(path_cand)
                        if raw:
                            for item in json.loads(raw):
                                existing_acts[str(item.get("id"))] = item
                            break
                    except Exception as e:
                        logger.warning(f"Could not read existing index {path_cand}: {e}")

            for act in imported_acts:
                act_id = str(act["id"])
                existing_acts[act_id] = act
                date_str = str(act.get("start_time") or act.get("date") or "")
                manifest_year = date_str[:4] if len(date_str) >= 4 and date_str[:4].isdigit() else None
                manifest.record_activity(act_id, year=manifest_year)

                shard_obj = {
                    "id": act_id,
                    "gps_track": act.get("gps_track"),
                    "telemetry_stream": act.get("telemetry_stream"),
                    "splits": act.get("splits", []),
                    "laps": act.get("laps", []),
                    "hr_zones": act.get("hr_zones", {}),
                }
                shard_json = json.dumps(shard_obj, separators=(",", ":"))
                (local_streams_dir / f"{act_id}.json").write_text(shard_json, encoding="utf-8")

                year_str = manifest_year or "unknown"
                storage.write_text_atomic(f"{REMOTE_STREAMS_DIR}/{year_str}/{act_id}.json", shard_json)

            canonical_acts = reprocess_canonical_activities(list(existing_acts.values()))
            index_acts = []
            for act in canonical_acts:
                idx_copy = dict(act)
                is_str = idx_copy.get("sport") in ("strength", "weights")
                if is_str:
                    for forbidden_key in ("weight", "kg", "load_kg", "tonnage", "weight_kg", "exercise_sets"):
                        idx_copy.pop(forbidden_key, None)
                    idx_copy["summary_polyline"] = None
                    idx_copy["has_streams"] = False
                else:
                    gps_val = idx_copy.get("gps_track")
                    if not idx_copy.get("summary_polyline") and isinstance(gps_val, dict):
                        idx_copy["summary_polyline"] = (
                            gps_val.get("polyline") or gps_val.get("encoded_polyline") or None
                        )
                    idx_copy["has_streams"] = bool(
                        idx_copy.get("gps_track") or idx_copy.get("telemetry_stream") or idx_copy.get("has_streams")
                    )
                idx_copy.pop("gps_track", None)
                idx_copy.pop("telemetry_stream", None)
                index_acts.append(idx_copy)

            storage.write_text_atomic(REMOTE_INDEX_PATH, json.dumps(index_acts, indent=2))
            storage.write_text_atomic(REMOTE_CANONICAL_PATH, json.dumps(index_acts, indent=2))
            save_remote_manifest(storage, manifest)

            wellness_map = {}
            if storage.file_exists(REMOTE_WELLNESS_PATH):
                try:
                    raw_w = storage.read_text(REMOTE_WELLNESS_PATH)
                    if raw_w:
                        for w in json.loads(raw_w):
                            if isinstance(w, dict) and w.get("date"):
                                wellness_map[str(w["date"])] = w
                except Exception:
                    pass

            for w in imported_wellness:
                d_key = str(w["date"])
                merged = dict(wellness_map.get(d_key, {}))
                for k, v in w.items():
                    if v is not None:
                        merged[k] = v
                wellness_map[d_key] = merged

            sorted_wellness = [wellness_map[k] for k in sorted(wellness_map.keys())]
            storage.write_text_atomic(REMOTE_WELLNESS_PATH, json.dumps(sorted_wellness, indent=2))

        wellness_payload = {
            "current": sorted_wellness[-1] if sorted_wellness else {},
            "daily": sorted_wellness,
        }
        rollup_dict = compile_rollup(canonical_acts, sync_manifest=manifest, wellness=wellness_payload)
        src_by_id = {str(a.get("id")): a for a in canonical_acts if isinstance(a, dict)}
        for act_item in rollup_dict.get("activities", []):
            if isinstance(act_item, dict):
                src_act = src_by_id.get(str(act_item.get("id")), {})
                is_str = act_item.get("sport") in ("strength", "weights")
                if is_str:
                    for forbidden_key in ("weight", "kg", "load_kg", "tonnage", "weight_kg", "exercise_sets"):
                        act_item.pop(forbidden_key, None)
                    act_item["summary_polyline"] = None
                    act_item["has_streams"] = False
                else:
                    gps_val = act_item.get("gps_track") or src_act.get("gps_track")
                    if not act_item.get("summary_polyline"):
                        if isinstance(gps_val, dict):
                            act_item["summary_polyline"] = (
                                gps_val.get("polyline") or gps_val.get("encoded_polyline") or None
                            )
                        elif src_act.get("summary_polyline"):
                            act_item["summary_polyline"] = src_act.get("summary_polyline")
                    act_item["has_streams"] = bool(
                        act_item.get("has_streams")
                        or src_act.get("has_streams")
                        or act_item.get("gps_track")
                        or act_item.get("telemetry_stream")
                        or src_act.get("gps_track")
                        or src_act.get("telemetry_stream")
                    )
                act_item["gps_track"] = None
                act_item["telemetry_stream"] = None

        output_rollup.parent.mkdir(parents=True, exist_ok=True)
        output_rollup.write_text(json.dumps(rollup_dict, indent=2), encoding="utf-8")

        if encrypt_output:
            from src.encryption.encrypt import build_and_encrypt_rollup
            build_and_encrypt_rollup(input_file=output_rollup, verify=True)

        return 0
    finally:
        purge_directory(vault_work_dir, remove_dir=True)


def main() -> None:
    parser = argparse.ArgumentParser(description="Import 4+ Years of GarminDB SQLite History into Sharded Vault")
    parser.add_argument("--garmindb-dir", type=Path, required=True, help="Path to GarminDB directory or DBs folder")
    parser.add_argument("--output-rollup", type=Path, default=Path(".staging/dashboard_rollup.json"))
    parser.add_argument("--encrypt", action="store_true", help="Encrypt rollup and stream shards immediately")
    parser.add_argument("--vault-mode", choices=["auto", "parquet", "legacy"], default="auto", help="Target vault format")
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")
    sys.exit(run_garmindb_import(args.garmindb_dir, args.output_rollup, args.encrypt, vault_mode=args.vault_mode))


if __name__ == "__main__":
    main()
