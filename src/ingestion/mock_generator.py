"""
src/ingestion/mock_generator.py
Deterministic 8-week multi-sport synthetic generator, binary FIT Protocol 2.0 engine,
and canonical rollup compiler.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import random
import struct
import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple, Union

# ---------------------------------------------------------------------------
# FIT Protocol 2.0 Constants & CRC Table
# ---------------------------------------------------------------------------

FIT_HEADER_SIZE = 14
FIT_PROTOCOL_VERSION = 0x20  # Protocol 2.0
FIT_PROFILE_VERSION = 2132   # Profile version 21.32
FIT_SIGNATURE = b".FIT"
GARMIN_EPOCH_OFFSET = 631065600  # Unix epoch seconds for 1989-12-31T00:00:00Z

FIT_CRC_TABLE = [
    0x0000, 0xCC01, 0xD801, 0x1400, 0xF001, 0x3C00, 0x2800, 0xE401,
    0xA001, 0x6C00, 0x7800, 0xB401, 0x5000, 0x9C01, 0x8801, 0x4400,
]


def calculate_fit_crc(data: bytes, crc: int = 0) -> int:
    """Calculates 16-bit Garmin FIT CRC over given byte sequence using 16-entry table."""
    for b in data:
        # Lower 4 bits
        tmp = FIT_CRC_TABLE[crc & 0x0F]
        crc = (crc >> 4) & 0x0FFF
        crc = crc ^ tmp ^ FIT_CRC_TABLE[b & 0x0F]
        # Upper 4 bits
        tmp = FIT_CRC_TABLE[crc & 0x0F]
        crc = (crc >> 4) & 0x0FFF
        crc = crc ^ tmp ^ FIT_CRC_TABLE[(b >> 4) & 0x0F]
    return crc & 0xFFFF


def build_fit_header(data_size: int, crc: int = 0) -> bytes:
    """
    Constructs genuine 14-byte binary header per FIT Protocol 2.0:
    - Byte 0: Header size (14)
    - Byte 1: Protocol version (0x20 = 2.0)
    - Bytes 2..3: Profile version (uint16 little-endian: 2132)
    - Bytes 4..7: Data size (uint32 little-endian)
    - Bytes 8..11: Signature (b'.FIT')
    - Bytes 12..13: Header CRC (uint16 little-endian)
    """
    header_raw = struct.pack("<BBHI4s", FIT_HEADER_SIZE, FIT_PROTOCOL_VERSION, FIT_PROFILE_VERSION, data_size, FIT_SIGNATURE)
    header_crc = calculate_fit_crc(header_raw) if crc == 0 else crc
    return header_raw + struct.pack("<H", header_crc)


def datetime_to_garmin_timestamp(dt: datetime) -> int:
    """Converts datetime to seconds since Garmin epoch (1989-12-31T00:00:00Z)."""
    return int(dt.timestamp()) - GARMIN_EPOCH_OFFSET


# ---------------------------------------------------------------------------
# Athlete Profile & Default Zones
# ---------------------------------------------------------------------------

DEFAULT_ATHLETE_PROFILE = {
    "vo2max": 54,
    "ftp": 280,
    "lthr": 168,
    "max_hr": 192,
    "rest_hr": 48,
}

# ---------------------------------------------------------------------------
# Synthetic Dataset Generator
# ---------------------------------------------------------------------------

class SyntheticDatasetGenerator:
    """
    Deterministic multi-sport fitness generator and FIT binary builder.
    Produces 8 weeks of realistic running, cycling, and strength workouts.
    """

    def __init__(self, seed: int = 42, anchor_date: Optional[datetime] = None):
        self.seed = seed
        self.rng = random.Random(seed)
        # Default anchor date is 2026-10-24 12:00:00Z
        if anchor_date is None:
            self.anchor_date = datetime(2026, 10, 24, 12, 0, 0, tzinfo=timezone.utc)
        else:
            self.anchor_date = anchor_date if anchor_date.tzinfo else anchor_date.replace(tzinfo=timezone.utc)

        self.athlete = dict(DEFAULT_ATHLETE_PROFILE)
        self._cached_activities: Optional[List[Dict[str, Any]]] = None

    def generate_activities(self, start_date: Optional[datetime] = None) -> List[Dict[str, Any]]:
        """
        Generates 8 weeks (56 days) of activities in ascending chronological order.
        Yields ~38-42 activities across running, cycling, and strength training.
        """
        self.rng.seed(self.seed)

        if start_date is None:
            # 56 days before anchor date, aligned to start of day
            start_date = (self.anchor_date - timedelta(days=56)).replace(hour=7, minute=0, second=0, microsecond=0)
        elif not start_date.tzinfo:
            start_date = start_date.replace(tzinfo=timezone.utc)

        activities: List[Dict[str, Any]] = []
        act_id_counter = 1

        # We model 8 weeks = 56 days
        # Training load tracker: ATL (7-day EWMA), CTL (42-day EWMA)
        atl = 45.0
        ctl = 50.0

        for day in range(56):
            current_date = start_date + timedelta(days=day)
            day_of_week = current_date.weekday()  # 0=Mon, 1=Tue, ..., 6=Sun

            # Mesocycle periodization:
            # Weeks 0-2 (Days 0-20): Base / Build 1
            # Week 3 (Days 21-27): Recovery / Deload
            # Weeks 4-6 (Days 28-48): Build 2 / Peak
            # Week 7 (Days 49-55): Taper
            week_idx = day // 7
            if week_idx == 3:
                volume_mult = 0.65  # Recovery deload week
            elif week_idx in (4, 5, 6):
                volume_mult = 1.15  # Peak build
            elif week_idx == 7:
                volume_mult = 0.80  # Taper
            else:
                volume_mult = 1.00  # Base

            # Weekly schedule:
            # Mon (0): Easy Recovery Trail Hike (or rest on deload)
            # Tue (1): Cycling Intervals / Sweetspot
            # Wed (2): Weights (Strength & Core)
            # Thu (3): Hiking Mountain Ascent / Ridge Trail
            # Fri (4): Rest (or easy spin on peak weeks)
            # Sat (5): Cycling Long Endurance Ride
            # Sun (6): Alpine Summit Hike
            day_plan: Optional[Tuple[str, str]] = None
            if day_of_week == 0:
                if week_idx != 3 or day % 2 == 0:
                    day_plan = ("hiking", "Recovery Trail Hike")
            elif day_of_week == 1:
                day_plan = ("cycling", "Sweetspot Intervals" if week_idx in (1, 2, 5, 6) else "Aerobic Base Ride")
            elif day_of_week == 2:
                day_plan = ("strength", "Weights & Core Strength")
            elif day_of_week == 3:
                day_plan = ("hiking", "Mountain Ascent Hike" if week_idx in (2, 5, 6) else "Ridge Trail Hike")
            elif day_of_week == 4:
                if week_idx in (4, 5):  # Peak weeks include active recovery spin
                    day_plan = ("cycling", "Recovery Spin")
                else:
                    day_plan = None  # Rest day
            elif day_of_week == 5:
                day_plan = ("cycling", "Weekend Endurance Ride")
            elif day_of_week == 6:
                day_plan = ("hiking", "Alpine Summit Hike")

            if day_plan is None:
                # Rest day updates daily EWMA with TSS = 0
                atl += (0.0 - atl) / 7.0
                ctl += (0.0 - ctl) / 42.0
                continue

            sport, title = day_plan
            act_id = f"act_{act_id_counter:03d}"

            # Calculate activity metrics based on sport and periodization
            if sport in ("hiking", "running"):
                if "Recovery" in title:
                    base_dist = self.rng.uniform(5500, 7500) * volume_mult
                    duration_sec = int(base_dist / self.rng.uniform(1.15, 1.28))  # ~13-14.5 min/km
                    avg_hr = self.rng.randint(118, 130)
                    elevation_gain = self.rng.randint(150, 320)
                elif "Mountain" in title or "Ascent" in title:
                    base_dist = self.rng.uniform(9500, 13500) * volume_mult
                    duration_sec = int(base_dist / self.rng.uniform(0.95, 1.15))  # ~14.5-17.5 min/km
                    avg_hr = self.rng.randint(142, 156)
                    elevation_gain = self.rng.randint(480, 850)
                elif "Ridge" in title or "Trail" in title:
                    base_dist = self.rng.uniform(8500, 11500) * volume_mult
                    duration_sec = int(base_dist / self.rng.uniform(1.05, 1.20))  # ~14-16 min/km
                    avg_hr = self.rng.randint(132, 146)
                    elevation_gain = self.rng.randint(300, 580)
                else:  # Alpine Summit Hike
                    base_dist = self.rng.uniform(14000, 20000) * volume_mult
                    duration_sec = int(base_dist / self.rng.uniform(0.85, 1.05))  # ~16-19.5 min/km
                    avg_hr = self.rng.randint(138, 152)
                    elevation_gain = self.rng.randint(750, 1350)

                distance_m = round(base_dist, 1)
                moving_sec = duration_sec - self.rng.randint(60, 240)
                max_hr = min(202, avg_hr + self.rng.randint(16, 28))
                avg_cadence = self.rng.randint(92, 114)  # hiking step rate (spm)
                avg_power = None
                speed_mps = distance_m / moving_sec
                avg_pace_sec_km = round(1000.0 / speed_mps, 1)
                calories = int((distance_m / 1000.0) * self.rng.uniform(68, 82) + elevation_gain * 0.45)
                tss = round((duration_sec / 3600.0) * ((avg_hr / 168.0) ** 2) * 55.0 + (elevation_gain / 100.0) * 4.0, 1)

            elif sport == "cycling":
                if "Recovery" in title:
                    base_dist = self.rng.uniform(20000, 28000) * volume_mult
                    duration_sec = int(base_dist / self.rng.uniform(7.0, 7.8))
                    avg_hr = self.rng.randint(118, 130)
                    avg_power = self.rng.randint(130, 160)
                    elevation_gain = self.rng.randint(80, 180)
                elif "Sweetspot" in title or "Intervals" in title:
                    base_dist = self.rng.uniform(35000, 48000) * volume_mult
                    duration_sec = int(base_dist / self.rng.uniform(8.2, 9.2))
                    avg_hr = self.rng.randint(152, 166)
                    avg_power = self.rng.randint(235, 265)
                    elevation_gain = self.rng.randint(220, 520)
                elif "Aerobic" in title:
                    base_dist = self.rng.uniform(40000, 55000) * volume_mult
                    duration_sec = int(base_dist / self.rng.uniform(7.8, 8.6))
                    avg_hr = self.rng.randint(136, 148)
                    avg_power = self.rng.randint(185, 215)
                    elevation_gain = self.rng.randint(300, 600)
                else:  # Weekend Endurance Ride
                    base_dist = self.rng.uniform(65000, 95000) * volume_mult
                    duration_sec = int(base_dist / self.rng.uniform(7.5, 8.4))
                    avg_hr = self.rng.randint(138, 150)
                    avg_power = self.rng.randint(190, 220)
                    elevation_gain = self.rng.randint(600, 1200)

                distance_m = round(base_dist, 1)
                moving_sec = duration_sec - self.rng.randint(30, 120)
                max_hr = min(202, avg_hr + self.rng.randint(16, 28))
                avg_cadence = self.rng.randint(82, 94)  # cycling cadence in rpm
                avg_pace_sec_km = None
                calories = int((duration_sec / 3600.0) * avg_power * 3.6 * 1.05)
                tss = round((duration_sec / 3600.0) * ((avg_power / 280.0) ** 2) * 100.0, 1)

            else:  # Weights (strength) - Duration & HR only, no kg/weight load, no distance
                distance_m = 0.0
                duration_sec = int(self.rng.uniform(45, 62) * 60)
                moving_sec = duration_sec
                avg_hr = self.rng.randint(116, 134)
                max_hr = avg_hr + self.rng.randint(22, 36)
                avg_cadence = 0
                avg_power = None
                avg_pace_sec_km = None
                elevation_gain = 0
                calories = int((duration_sec / 3600.0) * 420)
                tss = round((duration_sec / 3600.0) * ((avg_hr / 168.0) ** 2) * 55.0, 1)

            # Heart rate zone breakdown summing strictly to duration_seconds
            z1 = int(duration_sec * 0.15)
            z2 = int(duration_sec * 0.45)
            z3 = int(duration_sec * 0.25)
            z4 = int(duration_sec * 0.12)
            z5 = duration_sec - (z1 + z2 + z3 + z4)
            hr_zones = {"z1": z1, "z2": z2, "z3": z3, "z4": z4, "z5": z5}

            # Activity splits
            splits: List[Dict[str, Any]] = []
            if distance_m > 0:
                num_full_km = max(1, int(distance_m // 1000))
                remaining_m = distance_m - (num_full_km * 1000.0)
                total_split_dist = distance_m
                avg_split_time = duration_sec / (distance_m / 1000.0)

                for k in range(1, num_full_km + 1):
                    # Slight pace variance
                    pace_jitter = self.rng.uniform(-0.06, 0.06)
                    split_sec = round(avg_split_time * (1.0 + pace_jitter), 1)
                    split_hr = min(max_hr, max(avg_hr - 8, int(avg_hr + self.rng.randint(-4, 6))))
                    split_cadence = avg_cadence + self.rng.randint(-2, 2)
                    elev_diff = self.rng.randint(25, 85) if sport in ("hiking", "running") else self.rng.randint(-4, 8)
                    splits.append({
                        "km": k,
                        "split_number": k,
                        "distance_meters": 1000.0,
                        "duration_seconds": split_sec,
                        "split_sec": split_sec,
                        "avg_hr": split_hr,
                        "avg_cadence": split_cadence,
                        "elevation_diff": elev_diff,
                    })

                if remaining_m > 50:
                    split_k = num_full_km + 1
                    fraction = remaining_m / 1000.0
                    split_sec = round(avg_split_time * fraction, 1)
                    elev_diff = self.rng.randint(8, 30) if sport in ("hiking", "running") else self.rng.randint(-2, 4)
                    splits.append({
                        "km": split_k,
                        "split_number": split_k,
                        "distance_meters": round(remaining_m, 1),
                        "duration_seconds": split_sec,
                        "split_sec": split_sec,
                        "avg_hr": avg_hr,
                        "avg_cadence": avg_cadence,
                        "elevation_diff": elev_diff,
                    })
            else:
                # Weights: elapsed time splits (intervals of ~8-10 min each)
                num_time_splits = max(4, min(8, duration_sec // 480))
                split_duration = round(duration_sec / num_time_splits, 1)
                for s_idx in range(1, num_time_splits + 1):
                    split_hr = min(max_hr, max(avg_hr - 6, int(avg_hr + self.rng.randint(-3, 6))))
                    splits.append({
                        "km": s_idx,
                        "split_number": s_idx,
                        "distance_meters": 0.0,
                        "duration_seconds": split_duration,
                        "split_sec": split_duration,
                        "avg_hr": split_hr,
                        "avg_cadence": 0,
                        "elevation_diff": 0,
                    })

            # Laps
            laps: List[Dict[str, Any]] = []
            if distance_m > 0 and len(splits) > 0:
                # Group splits into 5km autolaps or structured laps
                lap_size_km = 5 if distance_m >= 15000 else 1
                lap_idx = 1
                for i in range(0, len(splits), lap_size_km):
                    chunk = splits[i:i + lap_size_km]
                    chunk_dist = sum(s["distance_meters"] for s in chunk)
                    chunk_dur = sum(s["duration_seconds"] for s in chunk)
                    chunk_hr = int(sum(s["avg_hr"] for s in chunk) / len(chunk))
                    chunk_cadence = int(sum(s["avg_cadence"] for s in chunk) / len(chunk))
                    pace = round(chunk_dur / (chunk_dist / 1000.0), 1) if chunk_dist > 0 else 0
                    laps.append({
                        "lap": lap_idx,
                        "lap_number": lap_idx,
                        "distance_meters": round(chunk_dist, 1),
                        "duration_seconds": round(chunk_dur, 1),
                        "avg_hr": chunk_hr,
                        "avg_cadence": chunk_cadence,
                        "avg_pace_sec_km": pace,
                    })
                    lap_idx += 1
            else:
                for s in splits:
                    laps.append({
                        "lap": s["split_number"],
                        "lap_number": s["split_number"],
                        "distance_meters": 0.0,
                        "duration_seconds": s["duration_seconds"],
                        "avg_hr": s["avg_hr"],
                        "avg_cadence": 0,
                        "avg_pace_sec_km": 0,
                    })

            # Training load updates
            atl += (tss - atl) / 7.0
            ctl += (tss - ctl) / 42.0
            tsb = round(ctl - atl, 1)

            iso_date = current_date.strftime("%Y-%m-%dT%H:%M:%SZ")

            act_record = {
                "id": act_id,
                "date": iso_date,
                "start_time": iso_date,
                "sport": sport,
                "title": title,
                "distance_meters": distance_m,
                "duration_seconds": duration_sec,
                "moving_time_seconds": moving_sec,
                "calories": calories,
                "avg_hr": avg_hr,
                "max_hr": max_hr,
                "avg_cadence": avg_cadence,
                "avg_power": avg_power,
                "avg_power_watts": avg_power,
                "avg_pace_sec_km": avg_pace_sec_km,
                "elevation_gain_meters": elevation_gain,
                "tss": tss,
                "training_stress_score": tss,
                "atl": round(atl, 1),
                "ctl": round(ctl, 1),
                "tsb": tsb,
                "hr_zones": hr_zones,
                "laps": laps,
                "splits": splits,
            }

            activities.append(act_record)
            act_id_counter += 1

        self._cached_activities = activities
        return activities

    def generate_raw_activity_summaries(self) -> List[Dict[str, Any]]:
        """
        Produces activity summaries formatted like Garmin Connect Developer API responses.
        """
        activities = self.generate_activities()
        summaries = []
        for act in activities:
            dt = datetime.fromisoformat(act["start_time"].replace("Z", "+00:00"))
            epoch_sec = int(dt.timestamp())
            summary = {
                "activityId": act["id"],
                "activityName": act["title"],
                "activityType": act["sport"].upper(),
                "startTimeInSeconds": epoch_sec,
                "startTimeLocal": act["start_time"],
                "startTimeGMT": act["start_time"],
                "distanceInMeters": act["distance_meters"],
                "durationInSeconds": act["duration_seconds"],
                "movingDurationInSeconds": act["moving_time_seconds"],
                "averageHeartRateInBeatsPerMinute": act["avg_hr"],
                "maxHeartRateInBeatsPerMinute": act["max_hr"],
                "averageSpeedInMetersPerSecond": (act["distance_meters"] / act["moving_time_seconds"]) if act["moving_time_seconds"] > 0 else 0.0,
                "averagePowerInWatts": act["avg_power"],
                "activeKilocalories": act["calories"],
                "totalElevationGainInMeters": act["elevation_gain_meters"],
            }
            summaries.append(summary)
        return summaries

    def generate_activity_detail(self, activity_id: str) -> Optional[Dict[str, Any]]:
        """Returns detailed splits and laps for a specific activity ID."""
        activities = self._cached_activities or self.generate_activities()
        for act in activities:
            if act["id"] == activity_id:
                return {
                    "activityId": activity_id,
                    "splits": act["splits"],
                    "laps": act["laps"],
                    "hr_zones": act["hr_zones"],
                }
        return None

    def generate_fit_file(self, activity_data: Dict[str, Any]) -> bytes:
        """
        Builds authentic Garmin FIT Protocol 2.0 binary file for an activity:
        - 14-byte File Header (with b'.FIT' at byte 8 and CRC)
        - File ID message (global msg 0)
        - Session message (global msg 18)
        - Lap messages (global msg 19)
        - Record messages (global msg 20, sampled points)
        - 2-byte File CRC
        """
        dt_str = activity_data.get("start_time") or activity_data.get("date") or "2026-10-24T12:00:00Z"
        dt = datetime.fromisoformat(dt_str.replace("Z", "+00:00"))
        garmin_start_time = datetime_to_garmin_timestamp(dt)

        duration = int(activity_data.get("duration_seconds", 3600))
        garmin_end_time = garmin_start_time + duration
        distance_cm = int(float(activity_data.get("distance_meters", 10000.0)) * 100.0)
        calories = int(activity_data.get("calories", 500))
        avg_hr = int(activity_data.get("avg_hr", 145))
        max_hr = int(activity_data.get("max_hr", 170))
        sport_str = str(activity_data.get("sport", "running")).lower()

        # Garmin sport enum: 1=running, 2=cycling, 17=hiking, 5=fitness equipment / strength
        if sport_str in ("running", "run"):
            sport_id = 1
            sub_sport_id = 0
            avg_speed_mms = int((distance_cm / duration) * 10) if duration > 0 else 0
        elif sport_str in ("cycling", "cycle"):
            sport_id = 2
            sub_sport_id = 0
            avg_speed_mms = int((distance_cm / duration) * 10) if duration > 0 else 0
        elif sport_str in ("hiking", "hike"):
            sport_id = 17  # Garmin FIT enum for HIKING
            sub_sport_id = 0
            avg_speed_mms = int((distance_cm / duration) * 10) if duration > 0 else 0
        else:
            sport_id = 5
            sub_sport_id = 20  # Strength training (Weights)
            avg_speed_mms = 0

        # --- Message 0: File ID Definition & Data ---
        # Def Header: 0x40, reserved 0, arch 0 (little-endian), global msg 0, 5 fields
        # Fields: type (0, 1B, enum 0x00), mfr (1, 2B, uint16 0x84), product (2, 2B, uint16 0x84),
        #         serial (3, 4B, uint32z 0x8C), time_created (4, 4B, uint32 0x86)
        def_file_id = struct.pack(
            "<BBBHB"
            "BBB"
            "BBB"
            "BBB"
            "BBB"
            "BBB",
            0x40, 0, 0, 0, 5,
            0, 1, 0x00,
            1, 2, 0x84,
            2, 2, 0x84,
            3, 4, 0x8C,
            4, 4, 0x86,
        )
        serial_num = 12345678
        data_file_id = struct.pack("<BBHHII", 0x00, 4, 1, 1, serial_num, garmin_start_time)

        # --- Message 1: Session Definition & Data ---
        # Global msg 18, 11 fields:
        # timestamp (253, 4B, uint32 0x86), start_time (2, 4B, uint32 0x86),
        # total_elapsed_time (7, 4B, uint32 0x86, ms), total_timer_time (8, 4B, uint32 0x86, ms),
        # total_distance (9, 4B, uint32 0x86, cm), total_calories (11, 2B, uint16 0x84),
        # avg_speed (14, 2B, uint16 0x84, mm/s), avg_heart_rate (16, 1B, uint8 0x02),
        # max_heart_rate (17, 1B, uint8 0x02), sport (5, 1B, enum 0x00), sub_sport (6, 1B, enum 0x00)
        def_session = struct.pack(
            "<BBBHB"
            "BBB" "BBB" "BBB" "BBB"
            "BBB" "BBB" "BBB" "BBB"
            "BBB" "BBB" "BBB",
            0x41, 0, 0, 18, 11,
            253, 4, 0x86,
            2, 4, 0x86,
            7, 4, 0x86,
            8, 4, 0x86,
            9, 4, 0x86,
            11, 2, 0x84,
            14, 2, 0x84,
            16, 1, 0x02,
            17, 1, 0x02,
            5, 1, 0x00,
            6, 1, 0x00,
        )
        data_session = struct.pack(
            "<BIIIIIHHBBBB",
            0x01,
            garmin_end_time,
            garmin_start_time,
            duration * 1000,
            duration * 1000,
            distance_cm,
            calories,
            min(65535, avg_speed_mms),
            avg_hr,
            max_hr,
            sport_id,
            sub_sport_id,
        )

        # --- Message 2: Lap Definition & Data ---
        # Global msg 19, 6 fields:
        # timestamp (253, 4B, 0x86), start_time (2, 4B, 0x86),
        # total_elapsed_time (7, 4B, 0x86), total_timer_time (8, 4B, 0x86),
        # total_distance (9, 4B, 0x86), avg_heart_rate (15, 1B, 0x02)
        def_lap = struct.pack(
            "<BBBHB"
            "BBB" "BBB" "BBB" "BBB" "BBB" "BBB",
            0x42, 0, 0, 19, 6,
            253, 4, 0x86,
            2, 4, 0x86,
            7, 4, 0x86,
            8, 4, 0x86,
            9, 4, 0x86,
            15, 1, 0x02,
        )

        laps_data = bytearray()
        laps_list = activity_data.get("laps", [])
        if not laps_list:
            laps_list = [{"lap_number": 1, "distance_meters": activity_data.get("distance_meters", 0), "duration_seconds": duration, "avg_hr": avg_hr}]

        accum_time = 0
        for lp in laps_list:
            lap_dur = int(lp.get("duration_seconds", duration))
            lap_dist_cm = int(float(lp.get("distance_meters", 0)) * 100.0)
            lap_hr = int(lp.get("avg_hr", avg_hr))
            lap_start = garmin_start_time + accum_time
            lap_end = lap_start + lap_dur
            accum_time += lap_dur
            laps_data.extend(struct.pack(
                "<BIIIIIB",
                0x02,
                lap_end,
                lap_start,
                lap_dur * 1000,
                lap_dur * 1000,
                lap_dist_cm,
                lap_hr,
            ))

        # --- Message 3: Record Definition & Data ---
        # Global msg 20, 5 fields:
        # timestamp (253, 4B, 0x86), distance (5, 4B, 0x86, cm),
        # speed (6, 2B, 0x84, mm/s), heart_rate (3, 1B, 0x02), cadence (4, 1B, 0x02)
        def_record = struct.pack(
            "<BBBHB"
            "BBB" "BBB" "BBB" "BBB" "BBB",
            0x43, 0, 0, 20, 5,
            253, 4, 0x86,
            5, 4, 0x86,
            6, 2, 0x84,
            3, 1, 0x02,
            4, 1, 0x02,
        )

        records_data = bytearray()
        # Sample every 10 seconds (up to 300 points max to keep FIT size manageable)
        sample_step = max(5, duration // 120)
        cum_dist = 0.0
        avg_cad = int(activity_data.get("avg_cadence", 170))

        for sec in range(0, duration + 1, sample_step):
            t_offset = sec
            p_time = garmin_start_time + t_offset
            if duration > 0:
                fraction = sec / duration
                p_dist_cm = int(distance_cm * fraction)
                p_speed = avg_speed_mms
            else:
                p_dist_cm = 0
                p_speed = 0

            p_hr = min(max_hr, max(45, avg_hr + int(math.sin(sec / 180.0) * 8)))
            p_cad = avg_cad if avg_cad > 0 else 0

            records_data.extend(struct.pack(
                "<BIIHBB",
                0x03,
                p_time,
                p_dist_cm,
                min(65535, p_speed),
                p_hr,
                p_cad,
            ))

        # Assemble full records bytes
        records_bytes = (
            def_file_id + data_file_id +
            def_session + data_session +
            def_lap + bytes(laps_data) +
            def_record + bytes(records_data)
        )

        data_size = len(records_bytes)
        header_14 = build_fit_header(data_size)
        file_crc = calculate_fit_crc(header_14 + records_bytes)
        return header_14 + records_bytes + struct.pack("<H", file_crc)

    def generate_binary_fit_file(self, activity_id: str) -> Optional[bytes]:
        """Finds activity by ID and returns its binary FIT payload."""
        activities = self._cached_activities or self.generate_activities()
        for act in activities:
            if act["id"] == activity_id:
                return self.generate_fit_file(act)
        return None

    def build_fit_binary(self, activity: Dict[str, Any]) -> bytes:
        """Alias for generate_fit_file."""
        return self.generate_fit_file(activity)


# ---------------------------------------------------------------------------
# Canonical Rollup Compiler
# ---------------------------------------------------------------------------

def compile_rollup(
    activities: List[Dict[str, Any]],
    athlete_profile: Optional[Dict[str, Any]] = None,
    generated_at: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Compiles list of activities into canonical dashboard_rollup.json matching
    PROJECT.md § Interface Contracts 1.
    """
    if athlete_profile is None:
        athlete_profile = dict(DEFAULT_ATHLETE_PROFILE)

    if generated_at is None:
        generated_at = datetime.now(timezone.utc).isoformat()

    # Sort activities chronologically
    sorted_acts = sorted(
        activities,
        key=lambda a: a.get("start_time") or a.get("date") or ""
    )

    # 1. Weekly Aggregations
    weekly_map: Dict[str, Dict[str, Any]] = {}
    monthly_map: Dict[str, Dict[str, Any]] = {}

    # Total physiological zone seconds
    hr_zone_seconds = {"Z1": 0, "Z2": 0, "Z3": 0, "Z4": 0, "Z5": 0}
    power_zone_seconds = {"Z1": 0, "Z2": 0, "Z3": 0, "Z4": 0, "Z5": 0, "Z6": 0, "Z7": 0}
    pace_zone_seconds = {"Recovery": 0, "Aerobic": 0, "Tempo": 0, "Threshold": 0, "Interval": 0}

    ftp = float(athlete_profile.get("ftp", 280))

    for act in sorted_acts:
        date_str = act.get("start_time") or act.get("date") or "2026-10-24T00:00:00Z"
        try:
            dt = datetime.fromisoformat(date_str.replace("Z", "+00:00"))
        except Exception:
            dt = datetime.now(timezone.utc)

        # Week identifier (ISO: YYYY-Www)
        year, week_num, _ = dt.isocalendar()
        week_key = f"{year}-W{week_num:02d}"

        # Month identifier (YYYY-MM)
        month_key = dt.strftime("%Y-%m")

        sport = act.get("sport", "hiking")
        dist_km = float(act.get("distance_meters", 0.0)) / 1000.0
        dur_hours = float(act.get("duration_seconds", 0.0)) / 3600.0
        load = float(act.get("tss") or act.get("training_stress_score") or 0.0)

        # Weekly map entry
        if week_key not in weekly_map:
            weekly_map[week_key] = {
                "week": week_key,
                "hiking_hours": 0.0,
                "cycling_hours": 0.0,
                "strength_hours": 0.0,
                "hiking_km": 0.0,
                "cycle_km": 0.0,
                "run_km": 0.0,
                "load": 0.0,
                "atl": float(act.get("atl", 50.0)),
                "ctl": float(act.get("ctl", 50.0)),
                "tsb": float(act.get("tsb", 0.0)),
            }
        entry = weekly_map[week_key]
        if sport in ("hiking", "running"):
            entry["hiking_km"] = round(entry["hiking_km"] + dist_km, 1)
            entry["hiking_hours"] = round(entry["hiking_hours"] + dur_hours, 1)
            entry["run_km"] = entry["hiking_km"]
        elif sport in ("cycling", "cycle"):
            entry["cycle_km"] = round(entry["cycle_km"] + dist_km, 1)
            entry["cycling_hours"] = round(entry["cycling_hours"] + dur_hours, 1)
        elif sport in ("strength", "weights"):
            entry["strength_hours"] = round(entry["strength_hours"] + dur_hours, 1)
        entry["load"] = round(entry["load"] + load, 1)
        entry["atl"] = float(act.get("atl", entry["atl"]))
        entry["ctl"] = float(act.get("ctl", entry["ctl"]))
        entry["tsb"] = float(act.get("tsb", entry["tsb"]))

        # Monthly map entry
        if month_key not in monthly_map:
            monthly_map[month_key] = {
                "month": month_key,
                "hiking_hours": 0.0,
                "cycling_hours": 0.0,
                "strength_hours": 0.0,
                "hiking_km": 0.0,
                "cycle_km": 0.0,
                "run_km": 0.0,
                "load": 0.0,
            }
        m_entry = monthly_map[month_key]
        if sport in ("hiking", "running"):
            m_entry["hiking_km"] = round(m_entry["hiking_km"] + dist_km, 1)
            m_entry["hiking_hours"] = round(m_entry["hiking_hours"] + dur_hours, 1)
            m_entry["run_km"] = m_entry["hiking_km"]
        elif sport in ("cycling", "cycle"):
            m_entry["cycle_km"] = round(m_entry["cycle_km"] + dist_km, 1)
            m_entry["cycling_hours"] = round(m_entry["cycling_hours"] + dur_hours, 1)
        elif sport in ("strength", "weights"):
            m_entry["strength_hours"] = round(m_entry["strength_hours"] + dur_hours, 1)
        m_entry["load"] = round(m_entry["load"] + load, 1)

        # Physiological accumulations
        dur_sec = int(act.get("duration_seconds", 0))
        # HR zones
        hz = act.get("hr_zones")
        if isinstance(hz, dict):
            hr_zone_seconds["Z1"] += int(hz.get("z1") or hz.get("Z1") or 0)
            hr_zone_seconds["Z2"] += int(hz.get("z2") or hz.get("Z2") or 0)
            hr_zone_seconds["Z3"] += int(hz.get("z3") or hz.get("Z3") or 0)
            hr_zone_seconds["Z4"] += int(hz.get("z4") or hz.get("Z4") or 0)
            hr_zone_seconds["Z5"] += int(hz.get("z5") or hz.get("Z5") or 0)
        else:
            # Fallback estimation
            hr_zone_seconds["Z1"] += int(dur_sec * 0.15)
            hr_zone_seconds["Z2"] += int(dur_sec * 0.45)
            hr_zone_seconds["Z3"] += int(dur_sec * 0.25)
            hr_zone_seconds["Z4"] += int(dur_sec * 0.12)
            hr_zone_seconds["Z5"] += int(dur_sec * 0.03)

        # Power zones (for cycling)
        if sport in ("cycling", "cycle"):
            power_zone_seconds["Z1"] += int(dur_sec * 0.12)
            power_zone_seconds["Z2"] += int(dur_sec * 0.48)
            power_zone_seconds["Z3"] += int(dur_sec * 0.22)
            power_zone_seconds["Z4"] += int(dur_sec * 0.12)
            power_zone_seconds["Z5"] += int(dur_sec * 0.04)
            power_zone_seconds["Z6"] += int(dur_sec * 0.015)
            power_zone_seconds["Z7"] += int(dur_sec * 0.005)

        # Pace zones (for hiking / running)
        if sport in ("hiking", "running"):
            pace_zone_seconds["Recovery"] += int(dur_sec * 0.15)
            pace_zone_seconds["Aerobic"] += int(dur_sec * 0.50)
            pace_zone_seconds["Tempo"] += int(dur_sec * 0.20)
            pace_zone_seconds["Threshold"] += int(dur_sec * 0.12)
            pace_zone_seconds["Interval"] += int(dur_sec * 0.03)

    # Format canonical physiological blocks
    heart_rate_zones_list = [
        {"zone": "Z1", "min": 96, "max": 134, "seconds": hr_zone_seconds["Z1"]},
        {"zone": "Z2", "min": 135, "max": 153, "seconds": hr_zone_seconds["Z2"]},
        {"zone": "Z3", "min": 154, "max": 167, "seconds": hr_zone_seconds["Z3"]},
        {"zone": "Z4", "min": 168, "max": 182, "seconds": hr_zone_seconds["Z4"]},
        {"zone": "Z5", "min": 183, "max": 192, "seconds": hr_zone_seconds["Z5"]},
    ]

    power_zones_list = [
        {"zone": "Z1", "min": 0, "max": int(ftp * 0.55), "seconds": power_zone_seconds["Z1"]},
        {"zone": "Z2", "min": int(ftp * 0.55) + 1, "max": int(ftp * 0.75), "seconds": power_zone_seconds["Z2"]},
        {"zone": "Z3", "min": int(ftp * 0.75) + 1, "max": int(ftp * 0.90), "seconds": power_zone_seconds["Z3"]},
        {"zone": "Z4", "min": int(ftp * 0.90) + 1, "max": int(ftp * 1.05), "seconds": power_zone_seconds["Z4"]},
        {"zone": "Z5", "min": int(ftp * 1.05) + 1, "max": int(ftp * 1.20), "seconds": power_zone_seconds["Z5"]},
        {"zone": "Z6", "min": int(ftp * 1.20) + 1, "max": int(ftp * 1.50), "seconds": power_zone_seconds["Z6"]},
        {"zone": "Z7", "min": int(ftp * 1.50) + 1, "max": 999, "seconds": power_zone_seconds["Z7"]},
    ]

    pace_zones_list = [
        {"zone": "Recovery", "short_label": "Rec", "min_sec_km": 600, "max_sec_km": 720, "seconds": pace_zone_seconds["Recovery"]},
        {"zone": "Aerobic", "short_label": "Aer", "min_sec_km": 500, "max_sec_km": 599, "seconds": pace_zone_seconds["Aerobic"]},
        {"zone": "Tempo", "short_label": "Tempo", "min_sec_km": 420, "max_sec_km": 499, "seconds": pace_zone_seconds["Tempo"]},
        {"zone": "Threshold", "short_label": "Thr", "min_sec_km": 360, "max_sec_km": 419, "seconds": pace_zone_seconds["Threshold"]},
        {"zone": "Interval", "short_label": "Int", "min_sec_km": 280, "max_sec_km": 359, "seconds": pace_zone_seconds["Interval"]},
    ]

    threshold_trends = [
        {"date": "2026-09-01", "vo2max": 51, "ftp": 268, "lthr": 165},
        {"date": "2026-09-15", "vo2max": 52, "ftp": 272, "lthr": 166},
        {"date": "2026-10-01", "vo2max": 53, "ftp": 276, "lthr": 167},
        {"date": "2026-10-15", "vo2max": 54, "ftp": 280, "lthr": 168},
    ]

    # Clean activity representation conforming to PROJECT.md § Interface Contracts 1
    canonical_activities = []
    for act in sorted_acts:
        date_iso = act.get("date") or act.get("start_time") or ""
        sport_val = act.get("sport", "hiking")
        is_strength = sport_val in ("strength", "weights")

        clean_act = {
            "id": act.get("id", ""),
            "date": date_iso,
            "start_time": date_iso,
            "sport": sport_val,
            "title": act.get("title", ""),
            "distance_meters": 0.0 if is_strength else float(act.get("distance_meters", 0.0)),
            "duration_seconds": int(act.get("duration_seconds", 0)),
            "moving_time_seconds": int(act.get("moving_time_seconds", 0)),
            "calories": int(act.get("calories", 0)),
            "avg_hr": int(act.get("avg_hr", 0)),
            "max_hr": int(act.get("max_hr", 0)),
            "avg_pace_sec_km": None if is_strength else act.get("avg_pace_sec_km"),
            "avg_cadence": 0 if is_strength else int(act.get("avg_cadence", 0)),
            "avg_power": None if is_strength else act.get("avg_power"),
            "avg_power_watts": None if is_strength else act.get("avg_power"),
            "elevation_gain_meters": 0 if is_strength else int(act.get("elevation_gain_meters", 0)),
            "tss": float(act.get("tss") or act.get("training_stress_score") or 0.0),
            "training_stress_score": float(act.get("tss") or act.get("training_stress_score") or 0.0),
            "atl": act.get("atl"),
            "ctl": act.get("ctl"),
            "tsb": act.get("tsb"),
            "laps": act.get("laps", []),
            "splits": act.get("splits", []),
            "hr_zones": act.get("hr_zones", {}),
        }
        canonical_activities.append(clean_act)

    # Top-level summary for instant KPI display
    total_km = sum(a["distance_meters"] for a in canonical_activities) / 1000.0
    total_moving_hours = sum(a["moving_time_seconds"] for a in canonical_activities) / 3600.0
    total_calories = sum(a["calories"] for a in canonical_activities)

    return {
        "version": "1.0.0",
        "generated_at": generated_at,
        "athlete": athlete_profile,
        "summary": {
            "total_activities": len(canonical_activities),
            "total_distance_km": round(total_km, 1),
            "total_moving_hours": round(total_moving_hours, 1),
            "total_calories": total_calories,
            "hiking_count": sum(1 for a in canonical_activities if a["sport"] in ("hiking", "running")),
            "cycling_count": sum(1 for a in canonical_activities if a["sport"] in ("cycling", "cycle")),
            "strength_count": sum(1 for a in canonical_activities if a["sport"] in ("strength", "weights")),
            "running_count": sum(1 for a in canonical_activities if a["sport"] in ("hiking", "running")),
        },
        "training_load": {
            "weekly": [weekly_map[k] for k in sorted(weekly_map.keys())],
            "monthly": [monthly_map[k] for k in sorted(monthly_map.keys())],
        },
        "physiological": {
            "heart_rate_zones": heart_rate_zones_list,
            "power_zones": power_zones_list,
            "pace_zones": pace_zones_list,
            "threshold_trends": threshold_trends,
        },
        "activities": canonical_activities,
    }


def compile_dashboard_rollup(
    activities: Optional[List[Dict[str, Any]]] = None,
    sftp_client: Any = None,
    staging_dir: Optional[Path] = None,
    is_mock: bool = True,
) -> Dict[str, Any]:
    """Compiles dashboard rollup JSON dictionary."""
    if activities is None or len(activities) == 0:
        gen = SyntheticDatasetGenerator(seed=42)
        activities = gen.generate_activities()
    return compile_rollup(activities)


def generate_8_week_dataset(seed: int = 42) -> List[Dict[str, Any]]:
    """Helper function generating 8-week activity list."""
    gen = SyntheticDatasetGenerator(seed=seed)
    return gen.generate_activities()


# Convenience aliases for contract flexibility
SyntheticGenerator = SyntheticDatasetGenerator
MockDataGenerator = SyntheticDatasetGenerator


# ---------------------------------------------------------------------------
# CLI Entrypoint
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(description="Deterministic Multi-Sport Synthetic Generator")
    parser.add_argument("--seed", type=int, default=42, help="RNG seed (default: 42)")
    parser.add_argument("--output-dir", type=Path, default=Path(".raw_staging"), help="Staging output directory")
    parser.add_argument("--output-rollup", type=Path, default=Path(".staging/dashboard_rollup.json"), help="Rollup output path")
    parser.add_argument("--generate-fit", action="store_true", help="Generate binary .fit files in staging directory")
    parser.add_argument("--rollup-only", action="store_true", help="Only compile and output dashboard_rollup.json")

    args = parser.parse_args()

    generator = SyntheticDatasetGenerator(seed=args.seed)
    activities = generator.generate_activities()
    rollup = compile_rollup(activities)

    # Write rollup
    args.output_rollup.parent.mkdir(parents=True, exist_ok=True)
    with open(args.output_rollup, "w", encoding="utf-8") as f:
        json.dump(rollup, f, indent=2)
    print(f"Compiled rollup to {args.output_rollup} ({len(activities)} activities)")

    if not args.rollup_only and args.generate_fit:
        args.output_dir.mkdir(parents=True, exist_ok=True)
        for act in activities:
            act_id = act["id"]
            fit_bytes = generator.generate_fit_file(act)
            fit_path = args.output_dir / f"{act_id}.fit"
            with open(fit_path, "wb") as f:
                f.write(fit_bytes)

            json_path = args.output_dir / f"{act_id}_summary.json"
            with open(json_path, "w", encoding="utf-8") as f:
                json.dump(act, f, indent=2)
        print(f"Generated raw .fit and .json files in {args.output_dir}")


if __name__ == "__main__":
    main()
