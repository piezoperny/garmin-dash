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

from src.analytics.training_load import calculate_continuous_training_load

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
# Polyline Encoding / Decoding Utilities
# ---------------------------------------------------------------------------

def encode_polyline(points: List[Tuple[float, float]]) -> str:
    """
    Encodes a list of (lat, lon) coordinate tuples into Google Encoded Polyline format
    with 5-decimal precision (~1 meter resolution).
    """
    result = []
    prev_lat = 0
    prev_lon = 0

    for lat, lon in points:
        lat_e5 = int(round(lat * 1e5))
        lon_e5 = int(round(lon * 1e5))

        d_lat = lat_e5 - prev_lat
        d_lon = lon_e5 - prev_lon
        prev_lat = lat_e5
        prev_lon = lon_e5

        for delta in (d_lat, d_lon):
            val = ~(delta << 1) if delta < 0 else (delta << 1)
            while val >= 0x20:
                result.append(chr((0x20 | (val & 0x1F)) + 63))
                val >>= 5
            result.append(chr(val + 63))

    return "".join(result)


def decode_polyline(encoded: str) -> List[Tuple[float, float]]:
    """
    Decodes a Google Encoded Polyline string back into a list of (lat, lon) float tuples.
    """
    coords = []
    idx = 0
    lat = 0
    lon = 0
    length = len(encoded)

    while idx < length:
        shift = 0
        result = 0
        while True:
            b = ord(encoded[idx]) - 63
            idx += 1
            result |= (b & 0x1F) << shift
            shift += 5
            if b < 0x20:
                break
        d_lat = ~(result >> 1) if (result & 1) else (result >> 1)
        lat += d_lat

        shift = 0
        result = 0
        while True:
            b = ord(encoded[idx]) - 63
            idx += 1
            result |= (b & 0x1F) << shift
            shift += 5
            if b < 0x20:
                break
        d_lon = ~(result >> 1) if (result & 1) else (result >> 1)
        lon += d_lon

        coords.append((lat / 1e5, lon / 1e5))

    return coords


def generate_synthetic_gps_track(
    sport: str,
    distance_meters: float,
    duration_seconds: int,
    elevation_gain_meters: int,
    avg_hr: int,
    max_hr: int,
    act_seed: int = 42,
) -> Tuple[Optional[Dict[str, Any]], Optional[Dict[str, List[Any]]]]:
    """
    Generates realistic synthetic GPS track, polyline, and synchronized
    elevation and HR telemetry stream for outdoor activities (hiking, cycling, running, walking).
    Returns (None, None) for indoor/strength activities.
    """
    sport_lower = str(sport).lower()
    if sport_lower in ("strength", "weights") or distance_meters <= 0 or duration_seconds <= 0:
        return None, None

    rng = random.Random(act_seed)

    # 5 Scenic Alpine / European routes
    anchors = [
        (45.9237, 6.8694, 1035.0),   # Chamonix / Mont Blanc
        (45.9765, 7.7491, 1620.0),   # Zermatt / Matterhorn
        (46.5405, 12.1357, 1224.0),  # Cortina d'Ampezzo / Dolomites
        (46.4950, 6.7450, 420.0),    # Lake Geneva / Lavaux
        (46.4685, 10.3725, 1225.0),  # Stelvio / Bormio
    ]
    anchor_idx = rng.randint(0, len(anchors) - 1)
    base_lat, base_lon, base_elev = anchors[anchor_idx]

    # Sample density: 50-150 points per activity
    num_points = min(150, max(50, duration_seconds // 45))
    step_sec = duration_seconds / max(1, num_points - 1)

    # Parametric Fourier closed loop route
    a1, a2 = rng.uniform(0.1, 0.3), rng.uniform(-0.15, 0.15)
    b1, b2 = rng.uniform(-0.25, 0.25), rng.uniform(-0.15, 0.15)
    phi1, phi2 = rng.uniform(0, math.pi), rng.uniform(0, math.pi)
    psi1, psi2 = rng.uniform(0, math.pi), rng.uniform(0, math.pi)

    raw_x, raw_y = [], []
    for i in range(num_points):
        u = 2.0 * math.pi * (i / max(1, num_points - 1))
        x = (math.cos(u) - 1.0) + a1 * (math.cos(2*u + phi1) - math.cos(phi1)) + a2 * (math.sin(3*u + phi2) - math.sin(phi2))
        y = math.sin(u) + b1 * (math.sin(2*u + psi1) - math.sin(psi1)) + b2 * (math.cos(3*u + psi2) - math.cos(psi2))
        raw_x.append(x)
        raw_y.append(y)

    # Perimeter scaling to match distance_meters
    raw_len = sum(
        math.hypot(raw_x[i] - raw_x[i-1], raw_y[i] - raw_y[i-1])
        for i in range(1, num_points)
    )
    scale = (distance_meters / raw_len) if raw_len > 0 else 1.0
    cos_lat = math.cos(math.radians(base_lat))

    points = []
    times = []
    elevations = []
    hrs = []

    current_hr = float(avg_hr - rng.randint(5, 12))

    for i in range(num_points):
        t_sec = int(round(i * step_sec))
        x_m = raw_x[i] * scale
        y_m = raw_y[i] * scale

        lat = round(base_lat + (y_m / 111320.0), 5)
        lon = round(base_lon + (x_m / (111320.0 * cos_lat)), 5)

        # Elevation curve with mountain ascent profile
        u = math.pi * (i / max(1, num_points - 1))
        undulation = 0.12 * elevation_gain_meters * math.sin(4 * u)
        elev_i = base_elev + (elevation_gain_meters * (math.sin(u) ** 1.5)) + undulation
        elev_i = max(50.0, round(elev_i, 1))

        # Slope-responsive heart rate
        if i > 0:
            elev_diff = elev_i - elevations[-1]
            if elev_diff > 0:
                target_hr = avg_hr + (max_hr - avg_hr) * min(0.9, (elev_diff / 8.0))
            else:
                target_hr = avg_hr - 8.0
        else:
            target_hr = avg_hr - 5.0

        current_hr += 0.25 * (target_hr - current_hr) + rng.uniform(-1.0, 1.0)
        hr_i = int(round(min(max_hr, max(45, current_hr))))

        points.append([lat, lon, elev_i, hr_i])
        times.append(t_sec)
        elevations.append(elev_i)
        hrs.append(hr_i)

    polyline = encode_polyline([(p[0], p[1]) for p in points])
    min_lat = min(p[0] for p in points)
    max_lat = max(p[0] for p in points)
    min_lon = min(p[1] for p in points)
    max_lon = max(p[1] for p in points)

    gps_track = {
        "polyline": polyline,
        "points": points,
        "bounds": [[min_lat, min_lon], [max_lat, max_lon]],
    }
    telemetry_stream = {
        "time": times,
        "elevation": elevations,
        "hr": hrs,
    }
    return gps_track, telemetry_stream


# ---------------------------------------------------------------------------
# Athlete Profile & Default Zones
# ---------------------------------------------------------------------------

DEFAULT_ATHLETE_PROFILE = {
    "vo2max": 54,
    "cycling_ftp": 280,
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
                    if week_idx < 2:
                        day_plan = ("hiking", "Recovery Trail Hike")
                    else:
                        day_plan = ("running", "Recovery Trail Run")
            elif day_of_week == 1:
                day_plan = ("cycling", "Sweetspot Intervals" if week_idx in (1, 2, 5, 6) else "Aerobic Base Ride")
            elif day_of_week == 2:
                day_plan = ("strength", "Weights & Core Strength")
            elif day_of_week == 3:
                if week_idx < 2:
                    day_plan = ("hiking", "Mountain Ascent Hike" if week_idx in (2, 5, 6) else "Ridge Trail Hike")
                else:
                    day_plan = ("running", "Threshold Trail Run" if week_idx in (2, 5, 6) else "Ridge Trail Run")
            elif day_of_week == 4:
                if week_idx in (4, 5):  # Peak weeks include active recovery spin
                    day_plan = ("cycling", "Recovery Spin")
                else:
                    day_plan = None  # Rest day
            elif day_of_week == 5:
                day_plan = ("cycling", "Weekend Endurance Ride")
            elif day_of_week == 6:
                if week_idx < 2:
                    day_plan = ("hiking", "Alpine Summit Hike")
                else:
                    day_plan = ("running", "Alpine Trail Run")

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
                avg_cadence = self.rng.randint(92, 114) if sport == "hiking" else self.rng.randint(155, 175)
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
                        "duration_seconds": int(round(split_sec)),
                        "split_sec": int(round(split_sec)),
                        "avg_hr": split_hr,
                        "avg_cadence": split_cadence,
                        "elevation_diff": elev_diff,
                        "speed_mps": round(1000.0 / split_sec, 2) if split_sec > 0 else 0.0,
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
                        "duration_seconds": int(round(split_sec)),
                        "split_sec": int(round(split_sec)),
                        "avg_hr": avg_hr,
                        "avg_cadence": avg_cadence,
                        "elevation_diff": elev_diff,
                        "speed_mps": round(remaining_m / split_sec, 2) if split_sec > 0 else 0.0,
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
                        "duration_seconds": int(round(split_duration)),
                        "split_sec": int(round(split_duration)),
                        "avg_hr": split_hr,
                        "avg_cadence": 0,
                        "elevation_diff": 0,
                        "speed_mps": None,
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

            gps_track, telemetry_stream = generate_synthetic_gps_track(
                sport=sport,
                distance_meters=distance_m,
                duration_seconds=duration_sec,
                elevation_gain_meters=elevation_gain,
                avg_hr=avg_hr,
                max_hr=max_hr,
                act_seed=self.seed * 10000 + act_id_counter,
            )

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
                "gps_track": gps_track,
                "telemetry_stream": telemetry_stream,
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
                    "gps_track": act.get("gps_track"),
                    "telemetry_stream": act.get("telemetry_stream"),
                }
        return None

    def generate_gpx_file(self, activity_id_or_data: Union[str, Dict[str, Any]]) -> Optional[bytes]:
        """
        Builds authentic GPX 1.1 XML track for outdoor activities (hiking, cycling, running, walking).
        Returns None for non-GPS activities (e.g. strength training).
        """
        if isinstance(activity_id_or_data, str):
            activities = self._cached_activities or self.generate_activities()
            act = next((a for a in activities if str(a["id"]) == str(activity_id_or_data)), None)
            if act is None:
                return None
        else:
            act = activity_id_or_data

        sport = str(act.get("sport", "")).lower()
        dist_m = float(act.get("distance_meters", 0.0))
        if sport in ("strength", "weights") or dist_m <= 0:
            return None

        dt_str = act.get("start_time") or act.get("date") or "2026-10-24T08:00:00Z"
        dt = datetime.fromisoformat(dt_str.replace("Z", "+00:00"))
        duration = int(act.get("duration_seconds", 3600))
        title = act.get("title") or f"{sport.capitalize()} Workout"
        elev_gain = float(act.get("elevation_gain_meters", 100))
        avg_hr = int(act.get("avg_hr", 140))
        avg_cad = int(act.get("avg_cadence", 85))

        gps = act.get("gps_track")
        points = gps.get("points") if isinstance(gps, dict) else None

        trkpt_elements = []
        if points and len(points) >= 2:
            step_sec = duration / max(1, len(points) - 1)
            for i, pt in enumerate(points):
                sec = int(round(i * step_sec))
                p_time = (dt + timedelta(seconds=sec)).strftime("%Y-%m-%dT%H:%M:%SZ")
                lat, lon, ele, hr = pt[0], pt[1], pt[2], pt[3]
                pt_xml = (
                    f'      <trkpt lat="{lat}" lon="{lon}">\n'
                    f'        <ele>{ele}</ele>\n'
                    f'        <time>{p_time}</time>\n'
                    f'        <extensions>\n'
                    f'          <gpxtpx:TrackPointExtension xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v1">\n'
                    f'            <gpxtpx:hr>{hr}</gpxtpx:hr>\n'
                    f'            <gpxtpx:cad>{avg_cad}</gpxtpx:cad>\n'
                    f'          </gpxtpx:TrackPointExtension>\n'
                    f'        </extensions>\n'
                    f'      </trkpt>'
                )
                trkpt_elements.append(pt_xml)
        else:
            base_lat = 46.582
            base_lon = 7.905
            base_ele = 1050.0
            step_sec = max(10, duration // 120)
            num_points = max(2, duration // step_sec)
            for i in range(num_points):
                sec = i * step_sec
                p_time = (dt + timedelta(seconds=sec)).strftime("%Y-%m-%dT%H:%M:%SZ")
                frac = sec / max(1, duration)
                lat = round(base_lat + math.sin(frac * math.pi * 2) * 0.018 + (frac * 0.025), 6)
                lon = round(base_lon + math.cos(frac * math.pi * 2) * 0.022 + (frac * 0.030), 6)
                ele = round(base_ele + math.sin(frac * math.pi) * elev_gain, 1)
                hr = min(205, max(45, avg_hr + int(math.sin(sec / 180.0) * 8)))
                pt_xml = (
                    f'      <trkpt lat="{lat}" lon="{lon}">\n'
                    f'        <ele>{ele}</ele>\n'
                    f'        <time>{p_time}</time>\n'
                    f'        <extensions>\n'
                    f'          <gpxtpx:TrackPointExtension xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v1">\n'
                    f'            <gpxtpx:hr>{hr}</gpxtpx:hr>\n'
                    f'            <gpxtpx:cad>{avg_cad}</gpxtpx:cad>\n'
                    f'          </gpxtpx:TrackPointExtension>\n'
                    f'        </extensions>\n'
                    f'      </trkpt>'
                )
                trkpt_elements.append(pt_xml)

        trkpts_body = "\n".join(trkpt_elements)
        gpx_xml = (
            '<?xml version="1.0" encoding="UTF-8"?>\n'
            '<gpx version="1.1" creator="garmin-dash"\n'
            '     xmlns="http://www.topografix.com/GPX/1/1"\n'
            '     xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"\n'
            '     xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd">\n'
            '  <metadata>\n'
            f'    <name>{title}</name>\n'
            f'    <time>{dt.strftime("%Y-%m-%dT%H:%M:%SZ")}</time>\n'
            '  </metadata>\n'
            '  <trk>\n'
            f'    <name>{title}</name>\n'
            f'    <type>{sport}</type>\n'
            '    <trkseg>\n'
            f'{trkpts_body}\n'
            '    </trkseg>\n'
            '  </trk>\n'
            '</gpx>'
        )
        return gpx_xml.encode("utf-8")

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

    def generate_wellness(self, activities: Optional[List[Dict[str, Any]]] = None, days: Optional[int] = None) -> Dict[str, Any]:
        """Generates deterministic Garmin wellness metrics aligned with activities."""
        acts = activities if activities is not None else (self._cached_activities or self.generate_activities())
        return generate_wellness_dataset(
            activities=acts,
            athlete_profile=self.athlete,
            seed=self.seed,
            anchor_date=self.anchor_date,
            days=days,
        )


# ---------------------------------------------------------------------------
# Garmin Daily Wellness Telemetry Generator
# ---------------------------------------------------------------------------

def generate_wellness_dataset(
    activities: Optional[List[Dict[str, Any]]] = None,
    athlete_profile: Optional[Dict[str, Any]] = None,
    seed: int = 42,
    anchor_date: Optional[datetime] = None,
    days: Optional[int] = None,
) -> Dict[str, Any]:
    """
    Generates deterministic Garmin daily wellness metrics and current snapshot.
    Compiles all 8 Garmin wellness metrics conforming to PROJECT.md § Interface Contracts:
    - Daily steps (steps, steps_goal)
    - Resting heart rate (resting_hr, resting_hr_7d_avg)
    - Sleep (sleep_seconds, sleep_score, sleep_quality, stages)
    - Stress (stress_level, stress_qualifier, stress_status)
    - Body battery (body_battery, charged, drained, body_battery_high, body_battery_low)
    - HRV status (hrv_status, hrv_weekly_avg, hrv_last_night_avg, hrv_baseline)
    - Active intensity minutes (active_intensity_minutes, intensity_minutes_goal, intensity_minutes_weekly)
    - Daily calories (daily_calories, active_calories, bmr_calories)
    """
    if athlete_profile is None:
        athlete_profile = dict(DEFAULT_ATHLETE_PROFILE)

    # Determine timeline boundaries
    if activities and len(activities) > 0:
        parsed_dates = []
        for a in activities:
            d_str = a.get("start_time") or a.get("date") or ""
            if d_str:
                try:
                    dt = datetime.fromisoformat(d_str.replace("Z", "+00:00"))
                    parsed_dates.append(dt)
                except Exception:
                    pass
        if parsed_dates:
            min_dt = min(parsed_dates).replace(hour=0, minute=0, second=0, microsecond=0)
            max_dt = max(parsed_dates).replace(hour=0, minute=0, second=0, microsecond=0)
            if days is not None:
                span_days = max(1, int(days))
            else:
                span_days = max(56, (max_dt - min_dt).days + 1)
            start_dt = max_dt - timedelta(days=span_days - 1)
            end_dt = max_dt
            num_days = span_days
        else:
            end_dt = (anchor_date or datetime(2026, 10, 26, 12, 0, 0, tzinfo=timezone.utc)).replace(hour=0, minute=0, second=0, microsecond=0)
            num_days = int(days) if days is not None else 56
            start_dt = end_dt - timedelta(days=num_days - 1)
    else:
        end_dt = (anchor_date or datetime(2026, 10, 26, 12, 0, 0, tzinfo=timezone.utc)).replace(hour=0, minute=0, second=0, microsecond=0)
        num_days = int(days) if days is not None else 56
        start_dt = end_dt - timedelta(days=num_days - 1)

    acts_by_date: Dict[str, List[Dict[str, Any]]] = {}
    if activities:
        for a in activities:
            d_str = str(a.get("start_time") or a.get("date") or "")
            if len(d_str) >= 10:
                d_key = d_str[:10]
                acts_by_date.setdefault(d_key, []).append(a)

    w_rng = random.Random(seed + 88888)
    rest_hr_base = int(athlete_profile.get("rest_hr") or 48)
    bmr_base = int(athlete_profile.get("bmr") or 1730)

    daily_records: List[Dict[str, Any]] = []
    rhr_history: List[int] = []
    hrv_history: List[int] = []
    intensity_history: List[int] = []

    for day_offset in range(num_days):
        day_date = start_dt + timedelta(days=day_offset)
        date_str = day_date.strftime("%Y-%m-%d")
        day_acts = acts_by_date.get(date_str, [])

        day_tss = sum(float(a.get("tss") or a.get("training_stress_score") or 0.0) for a in day_acts)
        day_dur_sec = sum(int(a.get("duration_seconds") or 0) for a in day_acts)
        day_cal = sum(int(a.get("calories") or 0) for a in day_acts)
        day_dist_m = sum(float(a.get("distance_meters") or 0.0) for a in day_acts)

        # 1. Steps
        steps_goal = 10000
        base_steps = w_rng.randint(6400, 8900)
        act_steps = 0
        for a in day_acts:
            sp = str(a.get("sport") or "").lower()
            dist = float(a.get("distance_meters") or 0.0)
            if sp in ("running", "run"):
                act_steps += int((dist / 1000.0) * 1250)
            elif sp in ("hiking", "hike", "walking", "walk"):
                act_steps += int((dist / 1000.0) * 1350)
            else:
                act_steps += w_rng.randint(600, 1400)
        total_steps = base_steps + act_steps

        # 2. Resting Heart Rate
        stress_bump = 2 if day_tss > 100 else (1 if day_tss > 50 else w_rng.choice([0, 0, 1, -1]))
        rhr = max(42, min(65, rest_hr_base + stress_bump))
        rhr_history.append(rhr)
        rhr_7d_avg = round(sum(rhr_history[-7:]) / len(rhr_history[-7:]), 1)

        # 3. Sleep
        sleep_sec = w_rng.randint(24600, 31200)
        base_score = w_rng.randint(78, 93)
        if day_tss > 120:
            base_score = max(70, base_score - 4)
        sleep_score = base_score
        if sleep_score >= 88:
            sleep_quality = "Excellent"
        elif sleep_score >= 78:
            sleep_quality = "Good"
        elif sleep_score >= 68:
            sleep_quality = "Fair"
        else:
            sleep_quality = "Poor"

        sleep_deep = int(sleep_sec * w_rng.uniform(0.18, 0.23))
        sleep_rem = int(sleep_sec * w_rng.uniform(0.20, 0.25))
        sleep_awake = int(sleep_sec * w_rng.uniform(0.04, 0.07))
        sleep_light = sleep_sec - (sleep_deep + sleep_rem + sleep_awake)

        # 4. Stress
        if day_tss > 100:
            stress_level = w_rng.randint(28, 38)
        elif day_tss > 50:
            stress_level = w_rng.randint(22, 29)
        else:
            stress_level = w_rng.randint(16, 24)
        stress_qualifier = "Low" if stress_level < 26 else ("Rest" if stress_level < 18 else "Medium")

        # 5. Body Battery
        charged = min(92, max(48, int(sleep_score * w_rng.uniform(0.78, 0.92))))
        drain_load = int(day_tss * 0.35 + (total_steps / 1000.0) * 1.8 + w_rng.randint(12, 22))
        drained = min(90, max(28, drain_load))
        bb_high = min(100, max(75, 20 + charged))
        bb_low = max(5, bb_high - drained)
        current_bb = max(10, min(100, bb_high - int(drained * 0.65)))

        # 6. HRV Status
        hrv_night = max(42, min(75, int(54 + (sleep_score - 82) * 0.35 - (day_tss / 45.0) + w_rng.randint(-3, 3))))
        hrv_history.append(hrv_night)
        hrv_weekly = round(sum(hrv_history[-7:]) / len(hrv_history[-7:]), 1)
        hrv_status = "Balanced" if 48 <= hrv_night <= 62 else ("Unbalanced" if hrv_night < 48 else "High")

        # 7. Active Intensity Minutes
        intensity_goal = 150
        if day_dur_sec > 0:
            mod_min = int((day_dur_sec / 60) * 0.65)
            vig_min = int((day_dur_sec / 60) * 0.35)
            active_intensity_min = mod_min + (vig_min * 2) + w_rng.randint(2, 8)
        else:
            active_intensity_min = w_rng.randint(5, 18)
            mod_min = int(active_intensity_min * 0.8)
            vig_min = active_intensity_min - mod_min
        intensity_history.append(active_intensity_min)
        weekly_intensity = sum(intensity_history[-7:])

        # 8. Daily Calories
        step_cal = int(total_steps * 0.04)
        act_cal = day_cal + step_cal
        daily_cal = bmr_base + act_cal

        rec = {
            "date": date_str,
            "steps": total_steps,
            "steps_goal": steps_goal,
            "resting_hr": rhr,
            "resting_heart_rate": rhr,
            "resting_hr_7d_avg": rhr_7d_avg,
            "sleep_seconds": sleep_sec,
            "sleep_score": sleep_score,
            "sleep_quality": sleep_quality,
            "sleep_deep_seconds": sleep_deep,
            "sleep_light_seconds": sleep_light,
            "sleep_rem_seconds": sleep_rem,
            "sleep_awake_seconds": sleep_awake,
            "sleep_stages": {
                "deep_seconds": sleep_deep,
                "light_seconds": sleep_light,
                "rem_seconds": sleep_rem,
                "awake_seconds": sleep_awake,
            },
            "stress_level": stress_level,
            "stress_qualifier": stress_qualifier,
            "stress_status": stress_qualifier,
            "body_battery": current_bb,
            "body_battery_charged": charged,
            "body_battery_drained": drained,
            "charged": charged,
            "drained": drained,
            "body_battery_high": bb_high,
            "body_battery_low": bb_low,
            "hrv_status": hrv_status,
            "hrv_weekly_avg": int(round(hrv_weekly)),
            "hrv_last_night_avg": hrv_night,
            "hrv_7d_avg": int(round(hrv_weekly)),
            "hrv_baseline": {"low": 48, "high": 62},
            "active_intensity_minutes": active_intensity_min,
            "intensity_minutes_goal": intensity_goal,
            "intensity_minutes_weekly": weekly_intensity,
            "intensity_minutes_moderate": mod_min,
            "intensity_minutes_vigorous": vig_min,
            "daily_calories": daily_cal,
            "active_calories": act_cal,
            "bmr_calories": bmr_base,
            "calories_total": daily_cal,
            "calories_active": act_cal,
            "calories_bmr": bmr_base,
        }
        daily_records.append(rec)

    latest = daily_records[-1] if daily_records else {}
    current_snapshot = {
        "steps": latest.get("steps", 10000),
        "steps_goal": latest.get("steps_goal", 10000),
        "resting_hr": latest.get("resting_hr", 48),
        "resting_heart_rate": latest.get("resting_heart_rate", 48),
        "resting_hr_7d_avg": latest.get("resting_hr_7d_avg", 48.0),
        "sleep_seconds": latest.get("sleep_seconds", 27900),
        "sleep_score": latest.get("sleep_score", 88),
        "sleep_quality": latest.get("sleep_quality", "Good"),
        "sleep_deep_seconds": latest.get("sleep_deep_seconds", 6300),
        "sleep_light_seconds": latest.get("sleep_light_seconds", 16200),
        "sleep_rem_seconds": latest.get("sleep_rem_seconds", 5400),
        "sleep_awake_seconds": latest.get("sleep_awake_seconds", 1800),
        "sleep_stages": latest.get("sleep_stages", {}),
        "stress_level": latest.get("stress_level", 24),
        "stress_qualifier": latest.get("stress_qualifier", "Low"),
        "stress_status": latest.get("stress_status", "Low"),
        "body_battery": latest.get("body_battery", 82),
        "body_battery_charged": latest.get("body_battery_charged", 65),
        "body_battery_drained": latest.get("body_battery_drained", 43),
        "charged": latest.get("charged", 65),
        "drained": latest.get("drained", 43),
        "body_battery_high": latest.get("body_battery_high", 90),
        "body_battery_low": latest.get("body_battery_low", 25),
        "hrv_status": latest.get("hrv_status", "Balanced"),
        "hrv_weekly_avg": latest.get("hrv_weekly_avg", 58),
        "hrv_last_night_avg": latest.get("hrv_last_night_avg", 62),
        "hrv_7d_avg": latest.get("hrv_7d_avg", 58),
        "hrv_baseline": latest.get("hrv_baseline", {"low": 48, "high": 62}),
        "active_intensity_minutes": latest.get("active_intensity_minutes", 52),
        "intensity_minutes_goal": latest.get("intensity_minutes_goal", 150),
        "intensity_minutes_weekly": latest.get("intensity_minutes_weekly", 285),
        "intensity_minutes_moderate": latest.get("intensity_minutes_moderate", 34),
        "intensity_minutes_vigorous": latest.get("intensity_minutes_vigorous", 18),
        "daily_calories": latest.get("daily_calories", 2410),
        "active_calories": latest.get("active_calories", 680),
        "bmr_calories": latest.get("bmr_calories", 1730),
        "calories_total": latest.get("calories_total", 2410),
        "calories_active": latest.get("calories_active", 680),
        "calories_bmr": latest.get("calories_bmr", 1730),
    }

    return {
        "current": current_snapshot,
        "daily": daily_records,
    }


# ---------------------------------------------------------------------------
# Canonical Rollup Compiler
# ---------------------------------------------------------------------------

def compile_rollup(
    activities: List[Dict[str, Any]],
    athlete_profile: Optional[Dict[str, Any]] = None,
    generated_at: Optional[str] = None,
    sync_manifest: Optional[Any] = None,
    backup_vault: Optional[Dict[str, Any]] = None,
    wellness: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """
    Compiles list of activities into canonical dashboard_rollup.json matching
    PROJECT.md § Interface Contracts 1 & 2.
    """
    if athlete_profile is None:
        athlete_profile = dict(DEFAULT_ATHLETE_PROFILE)
    else:
        athlete_profile = dict(athlete_profile)
        if "cycling_ftp" in athlete_profile and "ftp" not in athlete_profile:
            athlete_profile["ftp"] = athlete_profile["cycling_ftp"]
        elif "ftp" in athlete_profile and "cycling_ftp" not in athlete_profile:
            athlete_profile["cycling_ftp"] = athlete_profile["ftp"]

    if generated_at is None:
        generated_at = datetime.now(timezone.utc).isoformat()

    # Dynamic physiological threshold derivations from athlete profile
    ftp = float(athlete_profile.get("cycling_ftp") or athlete_profile.get("ftp") or 280)
    max_hr = int(athlete_profile.get("max_hr") or 192)
    rest_hr = int(athlete_profile.get("rest_hr") or 48)
    lthr = int(athlete_profile.get("lthr") or int(max_hr * 0.875))

    # 5-zone HR boundaries (PROJECT.md § 2 & TEST_INFRA.md § 5.2)
    z1_min = max(rest_hr, int(max_hr * 0.50))
    z1_max = int(max_hr * 0.70)
    z2_min = z1_max + 1
    z2_max = int(max_hr * 0.80)
    z3_min = z2_max + 1
    z3_max = max(z3_min, lthr - 1)
    z4_min = z3_max + 1
    z4_max = max(z4_min, int(max_hr * 0.95))
    z5_min = z4_max + 1
    z5_max = max(z5_min, max_hr)

    # Sort activities chronologically
    sorted_acts = sorted(
        activities,
        key=lambda a: a.get("start_time") or a.get("date") or ""
    )

    # Calculate Continuous Training Load EWMA curves
    load_results = calculate_continuous_training_load(sorted_acts, athlete_profile=athlete_profile)
    weekly_list = load_results["weekly"]
    daily_timeline = load_results["daily"]
    snapshots = load_results["activity_snapshots"]

    # Check if genuine cycling power data exists
    has_cycling_power = any(
        a.get("sport") in ("cycling", "cycle") and (
            (a.get("avg_power") is not None and float(a.get("avg_power")) > 0) or
            (a.get("avg_power_watts") is not None and float(a.get("avg_power_watts")) > 0) or
            (isinstance(a.get("telemetry_stream"), dict) and any(float(p or 0) > 0 for p in a["telemetry_stream"].get("power", [])))
        )
        for a in sorted_acts
    )

    # Monthly aggregations & physiological zone accumulations
    monthly_map: Dict[str, Dict[str, Any]] = {}

    # Total physiological zone seconds
    hr_zone_seconds = {"Z1": 0, "Z2": 0, "Z3": 0, "Z4": 0, "Z5": 0}
    power_zone_seconds = {"Z1": 0.0, "Z2": 0.0, "Z3": 0.0, "Z4": 0.0, "Z5": 0.0, "Z6": 0.0, "Z7": 0.0}
    pace_zone_seconds = {"Recovery": 0, "Aerobic": 0, "Tempo": 0, "Threshold": 0, "Interval": 0}

    for act in sorted_acts:
        date_str = act.get("start_time") or act.get("date") or "2026-10-24T00:00:00Z"
        try:
            dt = datetime.fromisoformat(date_str.replace("Z", "+00:00"))
        except Exception:
            dt = datetime.now(timezone.utc)

        # Month identifier (YYYY-MM)
        month_key = dt.strftime("%Y-%m")

        sport = act.get("sport", "other")
        dist_km = float(act.get("distance_meters", 0.0)) / 1000.0
        dur_hours = float(act.get("duration_seconds", 0.0)) / 3600.0
        load = float(act.get("tss") or act.get("training_stress_score") or 0.0)

        # Monthly map entry
        if month_key not in monthly_map:
            monthly_map[month_key] = {
                "month": month_key,
                "running_hours": 0.0,
                "walking_hours": 0.0,
                "hiking_hours": 0.0,
                "cycling_hours": 0.0,
                "strength_hours": 0.0,
                "run_km": 0.0,
                "walk_km": 0.0,
                "hiking_km": 0.0,
                "cycle_km": 0.0,
                "load": 0.0,
            }
        m_entry = monthly_map[month_key]
        if sport in ("running", "run"):
            m_entry["run_km"] = round(m_entry["run_km"] + dist_km, 1)
            m_entry["running_hours"] = round(m_entry["running_hours"] + dur_hours, 1)
        elif sport in ("walking", "walk"):
            m_entry["walk_km"] = round(m_entry["walk_km"] + dist_km, 1)
            m_entry["walking_hours"] = round(m_entry["walking_hours"] + dur_hours, 1)
        elif sport in ("hiking", "hike"):
            m_entry["hiking_km"] = round(m_entry["hiking_km"] + dist_km, 1)
            m_entry["hiking_hours"] = round(m_entry["hiking_hours"] + dur_hours, 1)
        elif sport in ("cycling", "cycle"):
            m_entry["cycle_km"] = round(m_entry["cycle_km"] + dist_km, 1)
            m_entry["cycling_hours"] = round(m_entry["cycling_hours"] + dur_hours, 1)
        elif sport in ("strength", "weights"):
            m_entry["strength_hours"] = round(m_entry["strength_hours"] + dur_hours, 1)
        m_entry["load"] = round(m_entry["load"] + load, 1)

        # Physiological accumulations
        dur_sec = int(act.get("duration_seconds", 0))

        # HR zones accumulation
        hz = act.get("hr_zones")
        if isinstance(hz, dict) and any(int(hz.get(k) or 0) > 0 for k in ("z1", "Z1", "z2", "Z2", "z3", "Z3", "z4", "Z4", "z5", "Z5")):
            act_z1 = int(hz.get("z1") or hz.get("Z1") or 0)
            act_z2 = int(hz.get("z2") or hz.get("Z2") or 0)
            act_z3 = int(hz.get("z3") or hz.get("Z3") or 0)
            act_z4 = int(hz.get("z4") or hz.get("Z4") or 0)
            act_z5 = int(hz.get("z5") or hz.get("Z5") or 0)
            tot_z = act_z1 + act_z2 + act_z3 + act_z4 + act_z5
            if tot_z != dur_sec and dur_sec > 0:
                act_z5 += (dur_sec - tot_z)
            hr_zone_seconds["Z1"] += act_z1
            hr_zone_seconds["Z2"] += act_z2
            hr_zone_seconds["Z3"] += act_z3
            hr_zone_seconds["Z4"] += act_z4
            hr_zone_seconds["Z5"] += act_z5
        elif act.get("telemetry_stream") and isinstance(act["telemetry_stream"].get("hr"), list) and len(act["telemetry_stream"]["hr"]) > 0:
            hr_stream = act["telemetry_stream"]["hr"]
            stream_len = len(hr_stream)
            ratio = dur_sec / max(1, stream_len)
            stream_zones = {"Z1": 0.0, "Z2": 0.0, "Z3": 0.0, "Z4": 0.0, "Z5": 0.0}
            for reading in hr_stream:
                val = int(reading or 0)
                if val >= z5_min:
                    stream_zones["Z5"] += ratio
                elif val >= z4_min:
                    stream_zones["Z4"] += ratio
                elif val >= z3_min:
                    stream_zones["Z3"] += ratio
                elif val >= z2_min:
                    stream_zones["Z2"] += ratio
                else:
                    stream_zones["Z1"] += ratio
            z1_acc = int(round(stream_zones["Z1"]))
            z2_acc = int(round(stream_zones["Z2"]))
            z3_acc = int(round(stream_zones["Z3"]))
            z4_acc = int(round(stream_zones["Z4"]))
            z5_acc = dur_sec - (z1_acc + z2_acc + z3_acc + z4_acc)
            hr_zone_seconds["Z1"] += z1_acc
            hr_zone_seconds["Z2"] += z2_acc
            hr_zone_seconds["Z3"] += z3_acc
            hr_zone_seconds["Z4"] += z4_acc
            hr_zone_seconds["Z5"] += z5_acc
        else:
            # Fallback estimation strictly summing to dur_sec
            fb_z1 = int(dur_sec * 0.15)
            fb_z2 = int(dur_sec * 0.45)
            fb_z3 = int(dur_sec * 0.25)
            fb_z4 = int(dur_sec * 0.12)
            fb_z5 = dur_sec - (fb_z1 + fb_z2 + fb_z3 + fb_z4)
            hr_zone_seconds["Z1"] += fb_z1
            hr_zone_seconds["Z2"] += fb_z2
            hr_zone_seconds["Z3"] += fb_z3
            hr_zone_seconds["Z4"] += fb_z4
            hr_zone_seconds["Z5"] += fb_z5

        # Power zones (for cycling)
        if sport in ("cycling", "cycle") and has_cycling_power:
            # Check if telemetry stream has power readings
            p_stream = act.get("telemetry_stream", {}).get("power") if isinstance(act.get("telemetry_stream"), dict) else None
            if isinstance(p_stream, list) and len(p_stream) > 0 and any(float(p or 0) > 0 for p in p_stream):
                stream_len = len(p_stream)
                ratio = dur_sec / max(1, stream_len)
                for reading in p_stream:
                    val = float(reading or 0)
                    if val > ftp * 1.50:
                        power_zone_seconds["Z7"] += ratio
                    elif val > ftp * 1.20:
                        power_zone_seconds["Z6"] += ratio
                    elif val > ftp * 1.05:
                        power_zone_seconds["Z5"] += ratio
                    elif val > ftp * 0.90:
                        power_zone_seconds["Z4"] += ratio
                    elif val > ftp * 0.75:
                        power_zone_seconds["Z3"] += ratio
                    elif val > ftp * 0.55:
                        power_zone_seconds["Z2"] += ratio
                    else:
                        power_zone_seconds["Z1"] += ratio
            else:
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

    # Format canonical physiological blocks with percentage and dynamic boundaries
    total_hr_sec = sum(hr_zone_seconds.values())
    hr_specs = [
        ("Z1", z1_min, z1_max, hr_zone_seconds["Z1"]),
        ("Z2", z2_min, z2_max, hr_zone_seconds["Z2"]),
        ("Z3", z3_min, z3_max, hr_zone_seconds["Z3"]),
        ("Z4", z4_min, z4_max, hr_zone_seconds["Z4"]),
        ("Z5", z5_min, z5_max, hr_zone_seconds["Z5"]),
    ]
    heart_rate_zones_list = []
    for zone_name, b_min, b_max, z_sec in hr_specs:
        pct = round((z_sec / total_hr_sec) * 100.0, 1) if total_hr_sec > 0 else 0.0
        heart_rate_zones_list.append({
            "zone": zone_name,
            "min": b_min,
            "max": b_max,
            "seconds": z_sec,
            "percentage": pct,
        })

    total_power_sec = sum(int(round(s)) for s in power_zone_seconds.values()) if has_cycling_power else 0

    z1_max = int(round(ftp * 0.55))
    z2_min = z1_max + 1
    z2_max = int(round(ftp * 0.75))
    z3_min = z2_max + 1
    z3_max = int(round(ftp * 0.90))
    z4_min = z3_max + 1
    z4_max = int(round(ftp * 1.05))
    z5_min = z4_max + 1
    z5_max = int(round(ftp * 1.20))
    z6_min = z5_max + 1
    z6_max = int(round(ftp * 1.50))
    z7_min = z6_max + 1

    power_specs = [
        ("Z1 Active Recovery", "Active Recovery", 0, z1_max, f"< {z1_max} W", int(round(power_zone_seconds["Z1"]))),
        ("Z2 Endurance", "Endurance", z2_min, z2_max, f"{z2_min}–{z2_max} W", int(round(power_zone_seconds["Z2"]))),
        ("Z3 Tempo", "Tempo", z3_min, z3_max, f"{z3_min}–{z3_max} W", int(round(power_zone_seconds["Z3"]))),
        ("Z4 Threshold", "Threshold", z4_min, z4_max, f"{z4_min}–{z4_max} W", int(round(power_zone_seconds["Z4"]))),
        ("Z5 VO2 Max", "VO2 Max", z5_min, z5_max, f"{z5_min}–{z5_max} W", int(round(power_zone_seconds["Z5"]))),
        ("Z6 Anaerobic", "Anaerobic", z6_min, z6_max, f"{z6_min}–{z6_max} W", int(round(power_zone_seconds["Z6"]))),
        ("Z7 Neuromuscular", "Neuromuscular", z7_min, 999, f"> {z6_max} W", int(round(power_zone_seconds["Z7"]))),
    ]

    power_zones_list = []
    for z_label, z_name, b_min, b_max, range_label, z_sec in power_specs:
        actual_sec = z_sec if has_cycling_power else 0
        pct = round((actual_sec / total_power_sec) * 100.0, 1) if total_power_sec > 0 else 0.0
        power_zones_list.append({
            "zone": z_label,
            "name": z_name,
            "min": b_min,
            "max": b_max,
            "range_label": range_label,
            "seconds": actual_sec,
            "percent": pct,
            "percentage": pct,
        })

    pace_zones_list = [
        {"zone": "Recovery", "short_label": "Rec", "min_sec_km": 600, "max_sec_km": 720, "seconds": pace_zone_seconds["Recovery"]},
        {"zone": "Aerobic", "short_label": "Aer", "min_sec_km": 500, "max_sec_km": 599, "seconds": pace_zone_seconds["Aerobic"]},
        {"zone": "Tempo", "short_label": "Tempo", "min_sec_km": 420, "max_sec_km": 499, "seconds": pace_zone_seconds["Tempo"]},
        {"zone": "Threshold", "short_label": "Thr", "min_sec_km": 360, "max_sec_km": 419, "seconds": pace_zone_seconds["Threshold"]},
        {"zone": "Interval", "short_label": "Int", "min_sec_km": 280, "max_sec_km": 359, "seconds": pace_zone_seconds["Interval"]},
    ]

    threshold_trends = [
        {"date": "2025-11-01", "vo2max": 48, "cycling_ftp": 252, "ftp": 252, "lthr": 162},
        {"date": "2025-12-15", "vo2max": 49, "cycling_ftp": 258, "ftp": 258, "lthr": 163},
        {"date": "2026-02-01", "vo2max": 50, "cycling_ftp": 262, "ftp": 262, "lthr": 164},
        {"date": "2026-04-15", "vo2max": 50, "cycling_ftp": 265, "ftp": 265, "lthr": 164},
        {"date": "2026-06-01", "vo2max": 51, "cycling_ftp": 268, "ftp": 268, "lthr": 165},
        {"date": "2026-07-15", "vo2max": 51, "cycling_ftp": 270, "ftp": 270, "lthr": 165},
        {"date": "2026-09-01", "vo2max": 51, "cycling_ftp": 268, "ftp": 268, "lthr": 165},
        {"date": "2026-09-15", "vo2max": 52, "cycling_ftp": 272, "ftp": 272, "lthr": 166},
        {"date": "2026-10-01", "vo2max": 53, "cycling_ftp": 276, "ftp": 276, "lthr": 167},
        {"date": "2026-10-15", "vo2max": 54, "cycling_ftp": 280, "ftp": 280, "lthr": 168},
    ]

    # Clean activity representation conforming to PROJECT.md § Interface Contracts 1
    canonical_activities = []
    for act in sorted_acts:
        date_iso = act.get("date") or act.get("start_time") or ""
        sport_val = act.get("sport", "other")
        is_strength = sport_val in ("strength", "weights")

        act_id = str(act.get("id", ""))
        snap = snapshots.get(act_id)
        atl_val = snap["atl"] if snap else act.get("atl")
        ctl_val = snap["ctl"] if snap else act.get("ctl")
        tsb_val = snap["tsb"] if snap else act.get("tsb")

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
            "atl": atl_val,
            "ctl": ctl_val,
            "tsb": tsb_val,
            "laps": act.get("laps", []),
            "splits": act.get("splits", []),
            "hr_zones": act.get("hr_zones", {}),
            "gps_track": None if is_strength else act.get("gps_track"),
            "telemetry_stream": None if is_strength else act.get("telemetry_stream"),
        }
        canonical_activities.append(clean_act)

    # Top-level summary for instant KPI display
    total_km = sum(a["distance_meters"] for a in canonical_activities) / 1000.0
    total_moving_hours = sum(a["moving_time_seconds"] for a in canonical_activities) / 3600.0
    total_calories = sum(a["calories"] for a in canonical_activities)

    # -----------------------------------------------------------------------
    # Backup Vault Rollup Metadata (F20)
    # -----------------------------------------------------------------------
    if backup_vault is not None and isinstance(backup_vault, dict):
        vault_entry = dict(backup_vault)
    elif sync_manifest is not None:
        if hasattr(sync_manifest, "archival_health"):
            health = sync_manifest.archival_health
            total_acts = sync_manifest.total_synced_activities or len(canonical_activities)
            by_year = dict(sync_manifest.activities_by_year) if sync_manifest.activities_by_year else {}
            last_sync = sync_manifest.last_sync_datetime
            verified = sync_manifest.integrity_verified
        elif isinstance(sync_manifest, dict):
            health = sync_manifest.get("archival_health", "healthy")
            total_acts = sync_manifest.get("total_synced_activities", len(canonical_activities))
            by_year = dict(sync_manifest.get("activities_by_year", {}))
            last_sync = sync_manifest.get("last_sync_datetime")
            verified = sync_manifest.get("integrity_verified", True)
        else:
            health = "healthy"
            total_acts = len(canonical_activities)
            by_year = {}
            last_sync = None
            verified = True

        if not by_year:
            for act in canonical_activities:
                d_str = act.get("start_time") or act.get("date") or ""
                if len(d_str) >= 4 and d_str[:4].isdigit():
                    yr = d_str[:4]
                    by_year[yr] = by_year.get(yr, 0) + 1

        if not last_sync or str(last_sync).startswith("1970"):
            last_sync = generated_at

        sorted_by_year = {k: by_year[k] for k in sorted(by_year.keys())} if by_year else {datetime.now(timezone.utc).strftime("%Y"): len(canonical_activities)}

        vault_entry = {
            "status": health,
            "storage_provider": "Hetzner Storage Box",
            "total_activities": total_acts if total_acts > 0 else len(canonical_activities),
            "activities_by_year": sorted_by_year,
            "last_backup_datetime": last_sync,
            "formats": ["FIT", "GPX", "JSON"],
            "verified_integrity": bool(verified),
        }
    else:
        # Mock mode / synthetic generation: synthesize directly from dataset
        by_year: Dict[str, int] = {}
        for act in canonical_activities:
            d_str = act.get("start_time") or act.get("date") or ""
            if len(d_str) >= 4 and d_str[:4].isdigit():
                yr = d_str[:4]
                by_year[yr] = by_year.get(yr, 0) + 1

        sorted_by_year = {k: by_year[k] for k in sorted(by_year.keys())} if by_year else {datetime.now(timezone.utc).strftime("%Y"): len(canonical_activities)}

        vault_entry = {
            "status": "healthy",
            "storage_provider": "Hetzner Storage Box",
            "total_activities": len(canonical_activities),
            "activities_by_year": sorted_by_year,
            "last_backup_datetime": generated_at,
            "formats": ["FIT", "GPX", "JSON"],
            "verified_integrity": True,
        }

    return {
        "version": "1.0.0",
        "generated_at": generated_at,
        "athlete": {
            "vo2max": athlete_profile.get("vo2max", 54),
            "cycling_ftp": int(ftp),
            "ftp": int(ftp),
            "lthr": lthr,
            "max_hr": max_hr,
            "rest_hr": rest_hr,
        },
        "summary": {
            "total_activities": len(canonical_activities),
            "total_distance_km": round(total_km, 1),
            "total_moving_hours": round(total_moving_hours, 1),
            "total_calories": total_calories,
            "hiking_count": sum(1 for a in canonical_activities if a.get("sport") in ("hiking", "hike")),
            "cycling_count": sum(1 for a in canonical_activities if a.get("sport") in ("cycling", "cycle")),
            "strength_count": sum(1 for a in canonical_activities if a.get("sport") in ("strength", "weights")),
            "running_count": sum(1 for a in canonical_activities if a.get("sport") in ("running", "run")),
            "walking_count": sum(1 for a in canonical_activities if a.get("sport") in ("walking", "walk")),
        },
        "training_load": {
            "weekly": weekly_list,
            "monthly": [monthly_map[k] for k in sorted(monthly_map.keys())],
            "daily": daily_timeline,
        },
        "physiological": {
            "has_power_data": bool(has_cycling_power),
            "ftp": int(ftp),
            "heart_rate_zones": heart_rate_zones_list,
            "power_zones": power_zones_list,
            "pace_zones": pace_zones_list,
            "threshold_trends": threshold_trends,
        },
        "activities": canonical_activities,
        "backup_vault": vault_entry,
        "wellness": wellness if (wellness is not None and isinstance(wellness, dict)) else generate_wellness_dataset(activities=canonical_activities, athlete_profile=athlete_profile, seed=42, days=365),
    }


def compile_dashboard_rollup(
    activities: Optional[List[Dict[str, Any]]] = None,
    sftp_client: Any = None,
    staging_dir: Optional[Path] = None,
    is_mock: bool = True,
    sync_manifest: Optional[Any] = None,
    backup_vault: Optional[Dict[str, Any]] = None,
    wellness: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Compiles dashboard rollup JSON dictionary."""
    if activities is None or len(activities) == 0:
        gen = SyntheticDatasetGenerator(seed=42)
        activities = gen.generate_activities()
    return compile_rollup(
        activities,
        sync_manifest=sync_manifest,
        backup_vault=backup_vault,
        wellness=wellness,
    )


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
