"""
src/ingestion/garmin_client.py
Garmin Connect Developer API (Personal Tier) client, OAuth 2.0 token manager,
SFTP token store, and mock offline client.
"""

from __future__ import annotations

import base64
import io
import json
import logging
import math
import os
import random
import re
import time
import zipfile
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Protocol, Tuple, Union, runtime_checkable

from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Custom Exceptions
# ---------------------------------------------------------------------------

class GarminError(Exception):
    """Base exception for all Garmin client operations."""
    pass


class GarminAuthError(GarminError):
    """Raised when authentication, authorization, or token refresh fails."""
    pass


class GarminRateLimitError(GarminError):
    """Raised when Garmin API rate limits (HTTP 429) are exceeded after retries."""
    pass


class GarminAPIError(GarminError):
    """Raised when Garmin API returns 4xx or 5xx HTTP status codes."""
    def __init__(self, status_code: int, message: str, response_body: Optional[str] = None):
        super().__init__(f"Garmin API Error {status_code}: {message}")
        self.status_code = status_code
        self.response_body = response_body


class GarminNetworkError(GarminError):
    """Raised when underlying network connectivity, timeout, or DNS fails."""
    pass


class GarminNotFoundError(GarminAPIError):
    """Raised when an activity or file is not found (HTTP 404)."""
    pass


# ---------------------------------------------------------------------------
# Pydantic Models & Session State
# ---------------------------------------------------------------------------

class OAuthSessionState(BaseModel):
    """Durable OAuth 2.0 session state persisted to Hetzner SFTP."""
    access_token: str = Field(..., description="Active OAuth 2.0 Bearer access token")
    refresh_token: str = Field(..., description="Rotating OAuth 2.0 refresh token")
    token_type: str = Field(default="Bearer", description="Token type, usually Bearer")
    expires_at: int = Field(..., description="Epoch seconds when access_token expires")
    updated_at: str = Field(
        default_factory=lambda: datetime.now(timezone.utc).isoformat(),
        description="ISO-8601 UTC timestamp of last update"
    )
    scope: Optional[str] = Field(default=None, description="OAuth scopes granted")

    def is_expired(self, buffer_seconds: int = 300) -> bool:
        """Return True if the access token is expired or within buffer_seconds of expiration."""
        return time.time() + buffer_seconds >= self.expires_at

    def to_json(self) -> str:
        if hasattr(self, "model_dump_json"):
            return self.model_dump_json(indent=2)
        return self.json(indent=2)

    @classmethod
    def from_json(cls, data: str) -> OAuthSessionState:
        if hasattr(cls, "model_validate_json"):
            return cls.model_validate_json(data)
        return cls.parse_raw(data)

    def __getitem__(self, item: str) -> Any:
        return getattr(self, item)

    def __setitem__(self, key: str, value: Any) -> None:
        setattr(self, key, value)

    def get(self, item: str, default: Any = None) -> Any:
        return getattr(self, item, default)


class GarminCredentials(BaseModel):
    """API credentials and initial bootstrap tokens."""
    api_key: str = Field(..., description="Garmin Developer Client ID / Consumer Key")
    client_secret: str = Field(..., description="Garmin Developer Client Secret")
    bootstrap_access_token: Optional[str] = Field(default=None)
    bootstrap_refresh_token: Optional[str] = Field(default=None)

    @classmethod
    def from_env(cls) -> Optional[GarminCredentials]:
        """Load credentials from environment variables if present."""
        api_key = os.environ.get("GARMIN_API_KEY", "").strip()
        client_secret = os.environ.get("GARMIN_CLIENT_SECRET", "").strip()
        if not api_key or not client_secret:
            return None
        return cls(
            api_key=api_key,
            client_secret=client_secret,
            bootstrap_access_token=os.environ.get("GARMIN_ACCESS_TOKEN", "").strip() or None,
            bootstrap_refresh_token=os.environ.get("GARMIN_REFRESH_TOKEN", "").strip() or None,
        )


# ---------------------------------------------------------------------------
# Token Store Abstraction
# ---------------------------------------------------------------------------

@runtime_checkable
class TokenStoreProtocol(Protocol):
    """Protocol for reading and writing OAuth session states."""
    def load_session(self) -> Optional[OAuthSessionState]:
        ...

    def save_session(self, session: OAuthSessionState) -> None:
        ...


class MemoryTokenStore(TokenStoreProtocol):
    """In-memory token store for testing and ephemeral workflows."""
    def __init__(self, initial_session: Optional[OAuthSessionState] = None):
        self._session = initial_session

    def load_session(self) -> Optional[OAuthSessionState]:
        return self._session

    def save_session(self, session: OAuthSessionState) -> None:
        self._session = session


class SFTPTokenStore(TokenStoreProtocol):
    """SFTP-backed durable token store persisting to Hetzner Storage Box."""
    def __init__(self, sftp_client: Any, remote_path: str = "garmin_archive/.session/garmin_oauth.json"):
        self.sftp_client = sftp_client
        self.remote_path = remote_path

    def load_session(self) -> Optional[OAuthSessionState]:
        try:
            if not self.sftp_client.file_exists(self.remote_path):
                return None
            data = self.sftp_client.read_text(self.remote_path)
            if not data:
                return None
            return OAuthSessionState.from_json(data)
        except Exception as e:
            logger.warning(f"Failed to read OAuth session from SFTP ({self.remote_path}): {e}")
            return None

    def save_session(self, session: OAuthSessionState) -> None:
        raw_json = session.to_json()
        self.sftp_client.write_text_atomic(self.remote_path, raw_json)
        logger.info(f"Persisted refreshed OAuth session to SFTP at {self.remote_path}")


# ---------------------------------------------------------------------------
# Secret Redaction Filter
# ---------------------------------------------------------------------------

class SecretRedactionFilter(logging.Filter):
    """Logging filter that sanitizes tokens, passwords, and private keys from logs."""
    SECRET_PATTERNS = [
        (re.compile(r"(Bearer\s+)[A-Za-z0-9_\-\.]{10,}", re.IGNORECASE), r"\1[REDACTED]"),
        (re.compile(r"(Basic\s+)[A-Za-z0-9+/=]{10,}", re.IGNORECASE), r"\1[REDACTED]"),
        (re.compile(r"(refresh_token=)[A-Za-z0-9_\-\.]{10,}", re.IGNORECASE), r"\1[REDACTED]"),
        (re.compile(r"(GARMIN_API_KEY=)[^\s&]+", re.IGNORECASE), r"\1[REDACTED]"),
        (re.compile(r"(GARMIN_CLIENT_SECRET=)[^\s&]+", re.IGNORECASE), r"\1[REDACTED]"),
        (re.compile(r"(DASHBOARD_PASSPHRASE=)[^\s&]+", re.IGNORECASE), r"\1[REDACTED]"),
        (re.compile(r"-----BEGIN [A-Z ]+ PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+ PRIVATE KEY-----"), "[REDACTED PRIVATE KEY]"),
    ]

    def filter(self, record: logging.LogRecord) -> bool:
        msg = record.getMessage()
        for pattern, repl in self.SECRET_PATTERNS:
            msg = pattern.sub(repl, msg)
        record.msg = msg
        record.args = ()
        return True


# ---------------------------------------------------------------------------
# Garmin Client Protocol
# ---------------------------------------------------------------------------

@runtime_checkable
class GarminClientProtocol(Protocol):
    """Unified interface for Garmin API client operations."""

    def get_activities(
        self,
        start_timestamp: int,
        end_timestamp: int,
        limit: int = 100,
    ) -> List[Dict[str, Any]]:
        """Fetch activity summaries uploaded between start_timestamp and end_timestamp (epoch seconds)."""
        ...

    def fetch_activities(
        self,
        start_epoch: int,
        end_epoch: int,
        limit: int = 100,
    ) -> List[Dict[str, Any]]:
        """Alias for get_activities."""
        ...

    def get_activity_details(self, activity_id: str) -> Optional[Dict[str, Any]]:
        """Fetch granular lap and split details for an activity."""
        ...

    def fetch_activity_details(self, activity_id: str) -> Optional[Dict[str, Any]]:
        """Alias for get_activity_details."""
        ...

    def download_fit_file(self, activity_id: str) -> Optional[bytes]:
        """Download raw binary .FIT file bytes for an activity (extracting from ZIP if necessary)."""
        ...

    def download_gpx_file(self, activity_id: str) -> Optional[bytes]:
        """Download raw .GPX file bytes for an activity (if GPS track is present)."""
        ...

    def fetch_gpx_file(self, activity_id: str) -> Optional[bytes]:
        """Alias for download_gpx_file."""
        ...

    def refresh_tokens(self) -> OAuthSessionState:
        """Force or trigger token refresh and persist updated state."""
        ...

    def refresh_access_token(self) -> Dict[str, Any]:
        """Alias for refresh_tokens returning dict representation."""
        ...

    def is_token_expired(self, buffer_seconds: int = 300) -> bool:
        """Checks if current session token is expired or near expiry."""
        ...

    def get_session_state(self) -> Optional[OAuthSessionState]:
        """Return the current active session state."""
        ...


# ---------------------------------------------------------------------------
# Pure Daily Wellness Normalization Helpers
# ---------------------------------------------------------------------------

INTRADAY_DOWNSAMPLE_MS = 900_000  # ~15 minutes


def _first_not_none(*vals: Any) -> Any:
    """Return the first argument that is not None (zero-preserving)."""
    for v in vals:
        if v is not None:
            return v
    return None


def _safe_num(
    val: Any,
    min_val: Optional[float] = None,
    max_val: Optional[float] = None,
) -> Optional[float]:
    """Convert val to float safely, rejecting bool/None/NaN/Inf and out-of-bounds values."""
    if val is None or isinstance(val, bool):
        return None
    try:
        num = float(val)
    except (TypeError, ValueError):
        return None
    if math.isnan(num) or math.isinf(num):
        return None
    if min_val is not None and num < min_val:
        return None
    if max_val is not None and num > max_val:
        return None
    return num


def _safe_int_num(
    val: Any,
    min_val: Optional[float] = None,
    max_val: Optional[float] = None,
) -> Optional[int]:
    """Convert val to int safely, preserving 0 when within bounds."""
    num = _safe_num(val, min_val=min_val, max_val=max_val)
    if num is None:
        return None
    return int(round(num))


def _as_dict(val: Any) -> Dict[str, Any]:
    return val if isinstance(val, dict) else {}


def _first_dict(val: Any) -> Dict[str, Any]:
    if isinstance(val, dict):
        return val
    if isinstance(val, list):
        for item in val:
            if isinstance(item, dict):
                return item
    return {}


def _parse_epoch_ms(ts_raw: Any) -> Optional[int]:
    if ts_raw is None or isinstance(ts_raw, bool):
        return None
    if isinstance(ts_raw, str):
        s = ts_raw.strip()
        if not s:
            return None
        num = _safe_num(s, min_val=0)
        if num is None:
            try:
                dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
                if dt.tzinfo is None:
                    dt = dt.replace(tzinfo=timezone.utc)
                return int(dt.timestamp() * 1000)
            except Exception:
                return None
    else:
        num = _safe_num(ts_raw, min_val=0)
        if num is None:
            return None
    ts_int = int(num)
    if ts_int < 10_000_000_000:
        ts_int *= 1000
    return ts_int


def _extract_intraday_series(
    raw_items: Any,
    interval_ms: int = INTRADAY_DOWNSAMPLE_MS,
    is_body_battery: bool = False,
) -> Tuple[List[List[int]], List[List[int]]]:
    """
    Parse Garmin intraday stress or body battery points (2-element, 4-element, or dicts),
    filter out negative sentinel values, sort ascending by epoch ms, and return:
      (all_valid_sorted_points, downsampled_15min_points)
    """
    if not isinstance(raw_items, list) or not raw_items:
        return [], []

    parsed: List[List[int]] = []
    for pt in raw_items:
        ts: Optional[int] = None
        val_raw: Any = None
        if isinstance(pt, (list, tuple)):
            if len(pt) < 2:
                continue
            ts = _parse_epoch_ms(pt[0])
            if is_body_battery:
                if len(pt) >= 3 and (isinstance(pt[1], str) or pt[1] is None):
                    val_raw = pt[2]
                else:
                    val_raw = pt[1]
            else:
                val_raw = pt[1]
        elif isinstance(pt, dict):
            ts = _parse_epoch_ms(
                _first_not_none(
                    pt.get("timestamp"),
                    pt.get("timestampGMT"),
                    pt.get("startTimestampGMT"),
                    pt.get("date"),
                    pt.get("ts"),
                )
            )
            if is_body_battery:
                val_raw = _first_not_none(
                    pt.get("level"),
                    pt.get("bodyBatteryLevel"),
                    pt.get("value"),
                    pt.get("charged"),
                )
            else:
                val_raw = _first_not_none(
                    pt.get("stressLevel"),
                    pt.get("stress"),
                    pt.get("value"),
                )
        else:
            continue

        if ts is None:
            continue
        val = _safe_int_num(val_raw, min_val=0, max_val=100)
        if val is None:
            continue
        parsed.append([ts, val])

    if not parsed:
        return [], []

    parsed.sort(key=lambda item: item[0])

    downsampled: List[List[int]] = []
    last_ts: Optional[int] = None
    for ts, val in parsed:
        if last_ts is None or (ts - last_ts) >= interval_ms:
            downsampled.append([ts, val])
            last_ts = ts

    return parsed, downsampled


def normalize_daily_wellness(cdate: str, raw_bundle: Dict[str, Any]) -> Dict[str, Any]:
    """
    Pure function converting a full raw daily wellness bundle into the canonical
    daily wellness record consumed by the dashboard and stored in wellness_history.json.
    Zero-preserving across all numeric metrics.
    """
    bundle = _as_dict(raw_bundle)

    user_summary = _as_dict(bundle.get("user_summary"))
    sleep_raw = _as_dict(bundle.get("sleep"))
    sleep_dto = (
        sleep_raw["dailySleepDTO"]
        if isinstance(sleep_raw.get("dailySleepDTO"), dict) and sleep_raw["dailySleepDTO"]
        else sleep_raw
    )
    hrv_raw = _as_dict(bundle.get("hrv"))
    hrv_sum = (
        hrv_raw["hrvSummary"]
        if isinstance(hrv_raw.get("hrvSummary"), dict) and hrv_raw["hrvSummary"]
        else hrv_raw
    )
    stress_raw = _as_dict(bundle.get("stress"))

    bb_raw = bundle.get("body_battery")
    bb_entry: Dict[str, Any] = {}
    if isinstance(bb_raw, list):
        for item in bb_raw:
            if isinstance(item, dict) and str(item.get("date") or "") == cdate:
                bb_entry = item
                break
        if not bb_entry:
            bb_entry = _first_dict(bb_raw)
    elif isinstance(bb_raw, dict):
        bb_entry = bb_raw

    heart_rates = _as_dict(bundle.get("heart_rates"))
    steps_data = bundle.get("steps_data")
    respiration = _as_dict(bundle.get("respiration"))
    spo2 = _as_dict(bundle.get("spo2"))
    tr_raw = bundle.get("training_readiness")
    training_status = _as_dict(bundle.get("training_status"))
    max_metrics_raw = bundle.get("max_metrics")
    body_comp_raw = _as_dict(bundle.get("body_composition"))
    hydration = _as_dict(bundle.get("hydration"))
    floors = _as_dict(bundle.get("floors"))

    # --- Steps ---
    steps = _safe_int_num(user_summary.get("totalSteps"), min_val=0)
    if steps is None and isinstance(steps_data, list):
        step_items = [
            _safe_int_num(item.get("steps"), min_val=0)
            for item in steps_data
            if isinstance(item, dict) and item.get("steps") is not None
        ]
        valid_step_items = [s for s in step_items if s is not None]
        if valid_step_items:
            steps = sum(valid_step_items)
    steps_goal = _safe_int_num(user_summary.get("dailyStepGoal"), min_val=0)

    # --- Resting HR ---
    rhr = _first_not_none(
        _safe_int_num(user_summary.get("restingHeartRate"), min_val=1),
        _safe_int_num(user_summary.get("minAvgHeartRate"), min_val=1),
        _safe_int_num(heart_rates.get("restingHeartRate"), min_val=1),
        _safe_int_num(sleep_raw.get("restingHeartRate"), min_val=1),
        _safe_int_num(sleep_dto.get("restingHeartRate"), min_val=1),
    )
    rhr_7d = _first_not_none(
        _safe_num(user_summary.get("lastSevenDaysAvgRestingHeartRate"), min_val=1),
        _safe_num(heart_rates.get("lastSevenDaysAvgRestingHeartRate"), min_val=1),
    )

    # --- Sleep ---
    sleep_sec = _first_not_none(
        _safe_int_num(sleep_dto.get("sleepTimeSeconds"), min_val=0),
        _safe_int_num(user_summary.get("sleepingSeconds"), min_val=0),
    )
    sleep_deep = _safe_int_num(sleep_dto.get("deepSleepSeconds"), min_val=0)
    sleep_light = _safe_int_num(sleep_dto.get("lightSleepSeconds"), min_val=0)
    sleep_rem = _safe_int_num(sleep_dto.get("remSleepSeconds"), min_val=0)
    sleep_awake = _safe_int_num(sleep_dto.get("awakeSleepSeconds"), min_val=0)
    sleep_scores = _as_dict(sleep_dto.get("sleepScores"))
    overall_sleep = _as_dict(sleep_scores.get("overall"))
    sleep_score = _first_not_none(
        _safe_int_num(overall_sleep.get("value"), min_val=0),
        _safe_int_num(sleep_dto.get("sleepScore"), min_val=0),
    )
    sleep_quality_raw = _first_not_none(
        overall_sleep.get("qualifierKey"),
        sleep_dto.get("sleepQualityTypePK"),
    )
    sleep_quality = str(sleep_quality_raw).replace("_", " ").title() if sleep_quality_raw else None

    # --- Intraday Body Battery & Stress (downsampled ~15m) ---
    bb_array_raw = stress_raw.get("bodyBatteryValuesArray")
    if not (isinstance(bb_array_raw, list) and bb_array_raw):
        bb_array_raw = bb_entry.get("bodyBatteryValuesArray")
    all_bb_pts, intraday_body_battery = _extract_intraday_series(
        bb_array_raw, interval_ms=INTRADAY_DOWNSAMPLE_MS, is_body_battery=True
    )

    stress_array_raw = stress_raw.get("stressValuesArray")
    all_stress_pts, intraday_stress = _extract_intraday_series(
        stress_array_raw, interval_ms=INTRADAY_DOWNSAMPLE_MS, is_body_battery=False
    )

    # --- Stress ---
    stress_level = _first_not_none(
        _safe_int_num(user_summary.get("averageStressLevel"), min_val=0),
        _safe_int_num(stress_raw.get("avgStressLevel"), min_val=0),
        _safe_int_num(stress_raw.get("averageStressLevel"), min_val=0),
    )
    if stress_level is None and all_stress_pts:
        stress_level = int(round(sum(pt[1] for pt in all_stress_pts) / len(all_stress_pts)))

    stress_max = _first_not_none(
        _safe_int_num(user_summary.get("maxStressLevel"), min_val=0),
        _safe_int_num(stress_raw.get("maxStressLevel"), min_val=0),
    )
    if stress_max is None and all_stress_pts:
        stress_max = max(pt[1] for pt in all_stress_pts)

    stress_qual_raw = _first_not_none(
        user_summary.get("stressQualifier"),
        stress_raw.get("stressQualifier"),
    )
    stress_qualifier = str(stress_qual_raw).replace("_", " ").title() if stress_qual_raw else None
    if stress_qualifier is None and stress_level is not None:
        if stress_level <= 25:
            stress_qualifier = "Rest"
        elif stress_level <= 50:
            stress_qualifier = "Low"
        elif stress_level <= 75:
            stress_qualifier = "Medium"
        else:
            stress_qualifier = "High"

    stress_rest_sec = _first_not_none(
        _safe_int_num(user_summary.get("restStressDuration"), min_val=0),
        _safe_int_num(stress_raw.get("restStressDuration"), min_val=0),
    )
    stress_low_sec = _first_not_none(
        _safe_int_num(user_summary.get("lowStressDuration"), min_val=0),
        _safe_int_num(stress_raw.get("lowStressDuration"), min_val=0),
    )
    stress_med_sec = _first_not_none(
        _safe_int_num(user_summary.get("mediumStressDuration"), min_val=0),
        _safe_int_num(stress_raw.get("mediumStressDuration"), min_val=0),
    )
    stress_high_sec = _first_not_none(
        _safe_int_num(user_summary.get("highStressDuration"), min_val=0),
        _safe_int_num(stress_raw.get("highStressDuration"), min_val=0),
    )
    stress_total_sec = _first_not_none(
        _safe_int_num(user_summary.get("stressDuration"), min_val=0),
        _safe_int_num(user_summary.get("totalStressDuration"), min_val=0),
        _safe_int_num(stress_raw.get("stressDuration"), min_val=0),
        _safe_int_num(stress_raw.get("totalStressDuration"), min_val=0),
    )
    if stress_total_sec is None:
        zone_secs = [s for s in (stress_rest_sec, stress_low_sec, stress_med_sec, stress_high_sec) if s is not None]
        if zone_secs:
            stress_total_sec = sum(zone_secs)

    # --- Body Battery ---
    bb_charged = _first_not_none(
        _safe_int_num(user_summary.get("bodyBatteryChargedValue"), min_val=0),
        _safe_int_num(bb_entry.get("charged"), min_val=0),
        _safe_int_num(bb_entry.get("bodyBatteryChargedValue"), min_val=0),
    )
    bb_drained = _first_not_none(
        _safe_int_num(user_summary.get("bodyBatteryDrainedValue"), min_val=0),
        _safe_int_num(bb_entry.get("drained"), min_val=0),
        _safe_int_num(bb_entry.get("bodyBatteryDrainedValue"), min_val=0),
    )
    bb_high = _first_not_none(
        _safe_int_num(user_summary.get("bodyBatteryHighestValue"), min_val=0),
        _safe_int_num(bb_entry.get("bodyBatteryHighestValue"), min_val=0),
        _safe_int_num(bb_entry.get("highestValue"), min_val=0),
    )
    if bb_high is None and all_bb_pts:
        bb_high = max(pt[1] for pt in all_bb_pts)

    bb_low = _first_not_none(
        _safe_int_num(user_summary.get("bodyBatteryLowestValue"), min_val=0),
        _safe_int_num(bb_entry.get("bodyBatteryLowestValue"), min_val=0),
        _safe_int_num(bb_entry.get("lowestValue"), min_val=0),
    )
    if bb_low is None and all_bb_pts:
        bb_low = min(pt[1] for pt in all_bb_pts)

    bb_curr = _first_not_none(
        _safe_int_num(user_summary.get("bodyBatteryMostRecentValue"), min_val=0),
        _safe_int_num(bb_entry.get("bodyBatteryMostRecentValue"), min_val=0),
        _safe_int_num(bb_entry.get("mostRecentValue"), min_val=0),
        all_bb_pts[-1][1] if all_bb_pts else None,
        bb_high,
    )
    bb_at_wake = _first_not_none(
        _safe_int_num(user_summary.get("bodyBatteryAtWakeTime"), min_val=0),
        _safe_int_num(bb_entry.get("bodyBatteryAtWakeTime"), min_val=0),
        _safe_int_num(bb_entry.get("atWakeTime"), min_val=0),
    )

    # --- HRV ---
    hrv_status_raw = hrv_sum.get("status")
    hrv_status = str(hrv_status_raw).replace("_", " ").title() if hrv_status_raw else None
    hrv_weekly = _first_not_none(
        _safe_int_num(hrv_sum.get("weeklyAvg"), min_val=1),
        _safe_int_num(hrv_sum.get("weeklyAverage"), min_val=1),
    )
    hrv_night = _first_not_none(
        _safe_int_num(hrv_sum.get("lastNightAvg"), min_val=1),
        _safe_int_num(hrv_sum.get("lastNight"), min_val=1),
        _safe_int_num(hrv_sum.get("hrvValue"), min_val=1),
    )
    if hrv_night is None and isinstance(hrv_raw.get("hrvReadings"), list):
        reading_vals = [
            _safe_num(pt.get("hrvValue"), min_val=1)
            for pt in hrv_raw["hrvReadings"]
            if isinstance(pt, dict)
        ]
        valid_readings = [v for v in reading_vals if v is not None]
        if valid_readings:
            hrv_night = int(round(sum(valid_readings) / len(valid_readings)))
    baseline_obj = _as_dict(hrv_sum.get("baseline"))
    hrv_baseline = None
    b_low = _safe_num(baseline_obj.get("balancedLow"), min_val=1)
    b_high = _safe_num(baseline_obj.get("balancedUpper"), min_val=1)
    if b_low is not None and b_high is not None:
        hrv_baseline = {
            "low": int(round(b_low)) if float(b_low).is_integer() else round(b_low, 1),
            "high": int(round(b_high)) if float(b_high).is_integer() else round(b_high, 1),
        }

    # --- Intensity Minutes ---
    mod_min = _safe_int_num(user_summary.get("moderateIntensityMinutes"), min_val=0)
    vig_min = _safe_int_num(user_summary.get("vigorousIntensityMinutes"), min_val=0)
    active_intensity_min = None
    if mod_min is not None or vig_min is not None:
        active_intensity_min = (mod_min or 0) + ((vig_min or 0) * 2)
    intensity_goal = _safe_int_num(user_summary.get("intensityMinutesGoal"), min_val=0)

    # --- Calories ---
    daily_cal = _safe_int_num(user_summary.get("totalKilocalories"), min_val=0)
    act_cal = _safe_int_num(user_summary.get("activeKilocalories"), min_val=0)
    bmr_cal = _safe_int_num(user_summary.get("bmrKilocalories"), min_val=0)

    # --- SpO2 & Respiration ---
    raw_spo2_avg = _first_not_none(
        _safe_num(spo2.get("averageSpO2"), min_val=0, max_val=100),
        _safe_num(spo2.get("averageSpo2"), min_val=0, max_val=100),
        _safe_num(spo2.get("averageSpO2Value"), min_val=0, max_val=100),
        _safe_num(sleep_dto.get("averageSpO2Value"), min_val=0, max_val=100),
        _safe_num(user_summary.get("averageSpo2"), min_val=0, max_val=100),
    )
    spo2_avg = round(raw_spo2_avg, 1) if raw_spo2_avg is not None else None

    raw_spo2_low = _first_not_none(
        _safe_num(spo2.get("lowestSpO2"), min_val=0, max_val=100),
        _safe_num(spo2.get("lowestSpo2"), min_val=0, max_val=100),
        _safe_num(spo2.get("lowestSpO2Value"), min_val=0, max_val=100),
        _safe_num(sleep_dto.get("lowestSpO2Value"), min_val=0, max_val=100),
        _safe_num(user_summary.get("lowestSpo2"), min_val=0, max_val=100),
    )
    if raw_spo2_low is not None:
        spo2_low: Optional[Union[int, float]] = (
            int(round(raw_spo2_low)) if float(raw_spo2_low).is_integer() else round(raw_spo2_low, 1)
        )
    else:
        spo2_low = None

    raw_resp_waking = _first_not_none(
        _safe_num(respiration.get("avgWakingRespirationValue"), min_val=0),
        _safe_num(user_summary.get("avgWakingRespirationValue"), min_val=0),
    )
    respiration_waking = round(raw_resp_waking, 1) if raw_resp_waking is not None else None

    raw_resp_sleep = _first_not_none(
        _safe_num(respiration.get("avgSleepRespirationValue"), min_val=0),
        _safe_num(sleep_dto.get("averageRespirationValue"), min_val=0),
        _safe_num(user_summary.get("avgSleepRespirationValue"), min_val=0),
    )
    respiration_sleep = round(raw_resp_sleep, 1) if raw_resp_sleep is not None else None

    # --- Floors ---
    floor_vals = floors.get("floorValuesArray") if isinstance(floors.get("floorValuesArray"), list) else []
    asc_from_array = None
    desc_from_array = None
    if floor_vals:
        asc_items = [_safe_num(pt[2], min_val=0) for pt in floor_vals if isinstance(pt, (list, tuple)) and len(pt) >= 3]
        asc_valid = [v for v in asc_items if v is not None]
        if asc_valid:
            asc_from_array = sum(asc_valid)
        desc_items = [_safe_num(pt[3], min_val=0) for pt in floor_vals if isinstance(pt, (list, tuple)) and len(pt) >= 4]
        desc_valid = [v for v in desc_items if v is not None]
        if desc_valid:
            desc_from_array = sum(desc_valid)

    raw_floors_asc = _first_not_none(
        _safe_num(floors.get("floorsAscended"), min_val=0),
        asc_from_array,
        _safe_num(user_summary.get("floorsAscended"), min_val=0),
    )
    floors_ascended = (
        int(round(raw_floors_asc))
        if raw_floors_asc is not None and float(raw_floors_asc).is_integer()
        else (round(raw_floors_asc, 1) if raw_floors_asc is not None else None)
    )

    raw_floors_desc = _first_not_none(
        _safe_num(floors.get("floorsDescended"), min_val=0),
        desc_from_array,
        _safe_num(user_summary.get("floorsDescended"), min_val=0),
    )
    floors_descended = (
        int(round(raw_floors_desc))
        if raw_floors_desc is not None and float(raw_floors_desc).is_integer()
        else (round(raw_floors_desc, 1) if raw_floors_desc is not None else None)
    )

    # --- Min/Max Heart Rate ---
    hr_values_raw = heart_rates.get("heartRateValues")
    hr_pts: List[int] = []
    if isinstance(hr_values_raw, list):
        for pt in hr_values_raw:
            hr_v: Optional[int] = None
            if isinstance(pt, (list, tuple)) and len(pt) >= 2:
                hr_v = _safe_int_num(pt[1], min_val=1)
            elif isinstance(pt, dict):
                hr_v = _safe_int_num(_first_not_none(pt.get("heartRate"), pt.get("hr"), pt.get("value")), min_val=1)
            if hr_v is not None:
                hr_pts.append(hr_v)

    min_hr = _first_not_none(
        _safe_int_num(user_summary.get("minHeartRate"), min_val=1),
        _safe_int_num(heart_rates.get("minHeartRate"), min_val=1),
        min(hr_pts) if hr_pts else None,
    )
    max_hr = _first_not_none(
        _safe_int_num(user_summary.get("maxHeartRate"), min_val=1),
        _safe_int_num(heart_rates.get("maxHeartRate"), min_val=1),
        max(hr_pts) if hr_pts else None,
    )

    # --- Body Composition (convert grams > 500 to kg) ---
    date_weight_list = body_comp_raw.get("dateWeightList") if isinstance(body_comp_raw.get("dateWeightList"), list) else []
    daily_weight_sums = (
        body_comp_raw.get("dailyWeightSummaries")
        if isinstance(body_comp_raw.get("dailyWeightSummaries"), list)
        else []
    )
    bc_candidates = [
        _as_dict(body_comp_raw.get("totalAverage")),
        _first_dict(date_weight_list),
        _as_dict(_first_dict(daily_weight_sums).get("latestWeight")),
        body_comp_raw,
    ]
    raw_weight = _first_not_none(
        *[
            _safe_num(_first_not_none(d.get("weight"), d.get("weightKg"), d.get("weight_kg")), min_val=0.001)
            for d in bc_candidates
        ]
    )
    weight_kg = round((raw_weight / 1000.0) if raw_weight > 500.0 else raw_weight, 2) if raw_weight is not None else None

    raw_bmi = _first_not_none(*[_safe_num(d.get("bmi"), min_val=0.001) for d in bc_candidates])
    bmi = round(raw_bmi, 2) if raw_bmi is not None else None

    raw_bf = _first_not_none(
        *[
            _safe_num(_first_not_none(d.get("bodyFat"), d.get("bodyFatPercentage"), d.get("body_fat_pct")), min_val=0.001)
            for d in bc_candidates
        ]
    )
    body_fat_pct = round(raw_bf, 2) if raw_bf is not None else None

    raw_muscle = _first_not_none(
        *[
            _safe_num(_first_not_none(d.get("muscleMass"), d.get("muscle_mass_kg")), min_val=0.001)
            for d in bc_candidates
        ]
    )
    muscle_mass_kg = (
        round((raw_muscle / 1000.0) if raw_muscle > 500.0 else raw_muscle, 2)
        if raw_muscle is not None
        else None
    )

    # --- Hydration ---
    hydration_ml = _first_not_none(
        _safe_int_num(hydration.get("valueInML"), min_val=0),
        _safe_int_num(hydration.get("hydration_ml"), min_val=0),
        _safe_int_num(user_summary.get("hydrationValueInML"), min_val=0),
    )

    # --- Training Readiness ---
    training_readiness_score: Optional[int] = None
    if isinstance(tr_raw, dict):
        training_readiness_score = _first_not_none(
            _safe_int_num(tr_raw.get("score"), min_val=0),
            _safe_int_num(tr_raw.get("trainingReadinessScore"), min_val=0),
        )
    elif isinstance(tr_raw, list):
        for item in tr_raw:
            if isinstance(item, dict):
                cand = _first_not_none(
                    _safe_int_num(item.get("score"), min_val=0),
                    _safe_int_num(item.get("trainingReadinessScore"), min_val=0),
                )
                if cand is not None:
                    training_readiness_score = cand
                    break

    # --- VO2Max (Running & Cycling) ---
    max_metrics_list: List[Dict[str, Any]] = []
    if isinstance(max_metrics_raw, dict):
        max_metrics_list = [max_metrics_raw]
    elif isinstance(max_metrics_raw, list):
        max_metrics_list = [m for m in max_metrics_raw if isinstance(m, dict)]

    most_recent_vo2 = _as_dict(training_status.get("mostRecentVO2Max"))
    vo2_run_cands = [_as_dict(m.get("generic")) for m in max_metrics_list] + [_as_dict(most_recent_vo2.get("generic"))]
    vo2_cyc_cands = [_as_dict(m.get("cycling")) for m in max_metrics_list] + [_as_dict(most_recent_vo2.get("cycling"))]

    raw_vo2_run = _first_not_none(
        *[
            _first_not_none(
                _safe_num(d.get("vo2MaxPreciseValue"), min_val=1),
                _safe_num(d.get("vo2MaxValue"), min_val=1),
            )
            for d in vo2_run_cands
        ]
    )
    vo2max_running = round(raw_vo2_run, 2) if raw_vo2_run is not None else None

    raw_vo2_cyc = _first_not_none(
        *[
            _first_not_none(
                _safe_num(d.get("vo2MaxPreciseValue"), min_val=1),
                _safe_num(d.get("vo2MaxValue"), min_val=1),
            )
            for d in vo2_cyc_cands
        ]
    )
    vo2max_cycling = round(raw_vo2_cyc, 2) if raw_vo2_cyc is not None else None

    return {
        "date": cdate,
        "steps": steps,
        "steps_goal": steps_goal,
        "resting_hr": rhr,
        "resting_heart_rate": rhr,
        "resting_hr_7d_avg": float(rhr_7d) if rhr_7d is not None else None,
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
        "stress_max": stress_max,
        "stress_qualifier": stress_qualifier,
        "stress_status": stress_qualifier,
        "stress_rest_seconds": stress_rest_sec,
        "stress_low_seconds": stress_low_sec,
        "stress_medium_seconds": stress_med_sec,
        "stress_high_seconds": stress_high_sec,
        "stress_total_seconds": stress_total_sec,
        "body_battery": bb_curr,
        "body_battery_charged": bb_charged,
        "body_battery_drained": bb_drained,
        "charged": bb_charged,
        "drained": bb_drained,
        "body_battery_high": bb_high,
        "body_battery_low": bb_low,
        "body_battery_at_wake": bb_at_wake,
        "hrv_status": hrv_status,
        "hrv_weekly_avg": hrv_weekly,
        "hrv_last_night_avg": hrv_night,
        "hrv_ms": hrv_night,
        "hrv_7d_avg": hrv_weekly,
        "hrv_baseline": hrv_baseline,
        "active_intensity_minutes": active_intensity_min,
        "intensity_minutes_goal": intensity_goal,
        "intensity_minutes_moderate": mod_min,
        "intensity_minutes_vigorous": vig_min,
        "daily_calories": daily_cal,
        "active_calories": act_cal,
        "bmr_calories": bmr_cal,
        "calories_total": daily_cal,
        "calories_active": act_cal,
        "calories_bmr": bmr_cal,
        "spo2_avg": spo2_avg,
        "spo2_low": spo2_low,
        "respiration_waking": respiration_waking,
        "respiration_sleep": respiration_sleep,
        "floors_ascended": floors_ascended,
        "floors_descended": floors_descended,
        "min_hr": min_hr,
        "max_hr": max_hr,
        "weight_kg": weight_kg,
        "bmi": bmi,
        "body_fat_pct": body_fat_pct,
        "muscle_mass_kg": muscle_mass_kg,
        "hydration_ml": hydration_ml,
        "training_readiness_score": training_readiness_score,
        "vo2max_running": vo2max_running,
        "vo2max_cycling": vo2max_cycling,
        "intraday_body_battery": intraday_body_battery,
        "intraday_stress": intraday_stress,
    }


# ---------------------------------------------------------------------------
# Live Garmin Client Implementation
# ---------------------------------------------------------------------------

class LiveGarminClient:
    """
    Production client for Garmin Connect Developer API (Personal Tier).
    Supports OAuth 2.0 token management, automatic refresh, rate limit backoff,
    pagination, and ZIP FIT extraction.
    """

    OAUTH_TOKEN_URL = "https://connectapi.garmin.com/oauth-service/oauth/token"
    ACTIVITIES_URL = "https://connectapi.garmin.com/activity-api/rest/activities"
    ACTIVITY_DETAILS_URL = "https://connectapi.garmin.com/activity-api/rest/activityDetails/{activityId}"
    FILE_DOWNLOAD_URL = "https://connectapi.garmin.com/activity-api/rest/file/{activityId}"

    def __init__(
        self,
        api_key_or_credentials: Union[str, GarminCredentials],
        client_secret: str = "",
        session_state: Optional[Union[Dict[str, Any], OAuthSessionState]] = None,
        token_store: Optional[TokenStoreProtocol] = None,
        timeout: float = 30.0,
    ):
        if isinstance(api_key_or_credentials, GarminCredentials):
            self.credentials = api_key_or_credentials
        else:
            if not api_key_or_credentials or not client_secret:
                raise ValueError("GARMIN_API_KEY and GARMIN_CLIENT_SECRET are required.")
            self.credentials = GarminCredentials(
                api_key=api_key_or_credentials,
                client_secret=client_secret,
            )

        self.token_store = token_store or MemoryTokenStore()
        self.timeout = timeout
        self.refresh_call_count = 0
        self._session_state: Optional[OAuthSessionState] = None
        self._personal_garmin: Any = None
        self._is_personal_sso = "@" in self.credentials.api_key

        if session_state:
            if isinstance(session_state, OAuthSessionState):
                self._session_state = session_state
            else:
                self._session_state = OAuthSessionState(**session_state)
            self.token_store.save_session(self._session_state)
        elif self._is_personal_sso:
            self._initialize_personal_sso()
        else:
            self._initialize_session()

    @staticmethod
    def _export_personal_tokenstore(client: Any, fallback_dir: Optional[str] = None) -> str:
        """Serialize garminconnect tokenstore (supports both 0.3.x client.client and 0.2.x client.garth)."""
        import tempfile
        from pathlib import Path

        with tempfile.TemporaryDirectory() as tmp_dir:
            target_dir = fallback_dir or tmp_dir
            inner = getattr(client, "client", None) or getattr(client, "garth", None)
            if inner is not None and hasattr(inner, "dump"):
                inner.dump(target_dir)
            elif hasattr(client, "garth") and hasattr(client.garth, "dumps"):
                return json.dumps({"garth_dumps": client.garth.dumps()})
            elif inner is not None and hasattr(inner, "dumps"):
                return json.dumps({"client_dumps": inner.dumps()})

            files_map: Dict[str, str] = {}
            for p in Path(target_dir).rglob("*"):
                if p.is_file():
                    rel = p.relative_to(target_dir).as_posix()
                    files_map[rel] = p.read_text(encoding="utf-8")
            return json.dumps({"files": files_map})

    def _initialize_personal_sso(self) -> None:
        """Authenticate using personal Garmin Connect account via tokenstore on Hetzner SFTP."""
        import tempfile
        from pathlib import Path

        try:
            from garminconnect import Garmin
        except ImportError as e:
            raise GarminAuthError(
                "Personal Garmin Connect login requires 'garminconnect' package (`pip install garminconnect`)."
            ) from e

        existing = self.token_store.load_session()
        client = Garmin(self.credentials.api_key, self.credentials.client_secret)

        # Support pasting a base64 token directly into GARMIN_CLIENT_SECRET ("GARMIN_TOKEN:...")
        candidate_bundles: List[str] = []
        if existing and existing.refresh_token:
            candidate_bundles.append(existing.refresh_token)
        if self.credentials.client_secret.startswith("GARMIN_TOKEN:"):
            raw_b64 = self.credentials.client_secret.split("GARMIN_TOKEN:", 1)[1].strip()
            try:
                candidate_bundles.append(base64.b64decode(raw_b64).decode("utf-8"))
            except Exception as e:
                logger.warning(f"Could not decode GARMIN_TOKEN from GARMIN_CLIENT_SECRET: {e}")

        for raw_bundle in candidate_bundles:
            try:
                bundle = json.loads(raw_bundle)
                if isinstance(bundle, dict) and bundle.get("files"):
                    with tempfile.TemporaryDirectory() as tmp_dir:
                        for rel_path, content in bundle["files"].items():
                            dest = Path(tmp_dir) / rel_path
                            dest.parent.mkdir(parents=True, exist_ok=True)
                            dest.write_text(content, encoding="utf-8")
                        client.login(tokenstore=tmp_dir)
                        updated_tokens = self._export_personal_tokenstore(client, fallback_dir=tmp_dir)
                        self._personal_garmin = client
                        self._session_state = OAuthSessionState(
                            access_token="personal_tokenstore_active",
                            refresh_token=updated_tokens,
                            expires_at=int(time.time()) + 86400 * 30,
                        )
                        self.token_store.save_session(self._session_state)
                        logger.info("Restored personal Garmin Connect session from tokenstore.")
                        return
            except Exception as e:
                logger.warning(f"Stored personal session expired or invalid ({e}); trying next strategy...")

        with tempfile.TemporaryDirectory() as tmp_dir:
            client.login()
            dumped_tokens = self._export_personal_tokenstore(client, fallback_dir=tmp_dir)
            self._personal_garmin = client
            self._session_state = OAuthSessionState(
                access_token="personal_tokenstore_active",
                refresh_token=dumped_tokens,
                expires_at=int(time.time()) + 86400 * 30,
            )
            self.token_store.save_session(self._session_state)
            logger.info("Authenticated personal Garmin Connect account and persisted tokenstore to SFTP.")

    @property
    def session_state(self) -> Optional[OAuthSessionState]:
        return self._session_state

    @session_state.setter
    def session_state(self, val: Union[Dict[str, Any], OAuthSessionState]) -> None:
        if isinstance(val, OAuthSessionState):
            self._session_state = val
        elif isinstance(val, dict):
            self._session_state = OAuthSessionState(**val)
        else:
            self._session_state = val

    def _initialize_session(self) -> None:
        """Load session from store, or bootstrap from credentials, and refresh if expired."""
        existing = self.token_store.load_session()
        if existing:
            self._session_state = existing
            logger.info("Loaded active OAuth session from token store.")
        elif self.credentials.bootstrap_refresh_token:
            logger.info("No stored OAuth session found; bootstrapping from environment credentials.")
            self._session_state = OAuthSessionState(
                access_token=self.credentials.bootstrap_access_token or "",
                refresh_token=self.credentials.bootstrap_refresh_token,
                expires_at=0,  # Force immediate refresh
            )
        else:
            # Fallback initial empty session state
            self._session_state = OAuthSessionState(
                access_token=self.credentials.bootstrap_access_token or "",
                refresh_token="",
                expires_at=0,
            )

        if self.is_token_expired():
            try:
                self.refresh_tokens()
            except Exception as e:
                logger.warning(f"Could not refresh tokens during initialization: {e}")

    def is_token_expired(self, buffer_seconds: int = 300) -> bool:
        if not self._session_state:
            return True
        return self._session_state.is_expired(buffer_seconds)

    def refresh_tokens(self) -> OAuthSessionState:
        """Executes Garmin OAuth 2.0 token refresh request."""
        self.refresh_call_count += 1
        if not self._session_state or not self._session_state.refresh_token:
            raise GarminAuthError("Cannot refresh token: missing refresh_token.")

        basic_auth = base64.b64encode(
            f"{self.credentials.api_key}:{self.credentials.client_secret}".encode()
        ).decode()

        headers = {
            "Authorization": f"Basic {basic_auth}",
            "Content-Type": "application/x-www-form-urlencoded",
        }
        data = {
            "grant_type": "refresh_token",
            "refresh_token": self._session_state.refresh_token,
        }

        logger.info("Executing Garmin OAuth 2.0 token refresh request...")
        import requests

        try:
            resp = requests.post(
                self.OAUTH_TOKEN_URL,
                headers=headers,
                data=data,
                timeout=self.timeout,
            )
        except Exception as e:
            raise GarminNetworkError(f"Network error during token refresh: {e}") from e

        if resp.status_code in (400, 401):
            raise GarminAuthError(f"OAuth token refresh rejected ({resp.status_code}): {resp.text}")
        if resp.status_code != 200:
            raise GarminAPIError(resp.status_code, "Token refresh failed", resp.text)

        payload = resp.json()
        new_access = payload["access_token"]
        new_refresh = payload.get("refresh_token", self._session_state.refresh_token)
        expires_in = int(payload.get("expires_in", 86400))
        expires_at = int(time.time()) + expires_in

        self._session_state = OAuthSessionState(
            access_token=new_access,
            refresh_token=new_refresh,
            token_type=payload.get("token_type", "Bearer"),
            expires_at=expires_at,
            scope=payload.get("scope"),
        )
        self.token_store.save_session(self._session_state)
        logger.info(f"OAuth token refreshed successfully. Next expiry in {expires_in}s.")
        return self._session_state

    def refresh_access_token(self, post_handler: Any = None) -> Dict[str, Any]:
        session = self.refresh_tokens()
        return session.model_dump() if hasattr(session, "model_dump") else session.dict()

    def _authenticated_request(
        self,
        method: str,
        url: str,
        params: Optional[Dict[str, Any]] = None,
        headers: Optional[Dict[str, str]] = None,
        stream: bool = False,
        retry_auth: bool = True,
    ) -> Any:
        import requests

        if self.is_token_expired():
            self.refresh_tokens()

        token = self._session_state.access_token if self._session_state else ""
        req_headers = {
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
        }
        if headers:
            req_headers.update(headers)

        max_attempts = 4
        for attempt in range(max_attempts):
            try:
                resp = requests.request(
                    method=method,
                    url=url,
                    params=params,
                    headers=req_headers,
                    timeout=self.timeout,
                    stream=stream,
                )
            except Exception as e:
                raise GarminNetworkError(f"HTTP request to {url} failed: {e}") from e

            if resp.status_code == 401 and retry_auth:
                logger.warning("Received 401 Unauthorized from Garmin API. Refreshing token and retrying...")
                self.refresh_tokens()
                req_headers["Authorization"] = f"Bearer {self._session_state.access_token}"
                return self._authenticated_request(
                    method=method,
                    url=url,
                    params=params,
                    headers=headers,
                    stream=stream,
                    retry_auth=False,
                )

            if resp.status_code == 429:
                retry_after_str = resp.headers.get("Retry-After")
                if retry_after_str and retry_after_str.isdigit():
                    wait_seconds = float(retry_after_str)
                else:
                    wait_seconds = min(60.0, (2.0 ** attempt) * 2.0 + random.uniform(0.1, 1.0))
                logger.warning(f"Garmin 429 Rate Limited. Sleeping {wait_seconds:.2f}s.")
                time.sleep(wait_seconds)
                continue

            if resp.status_code == 404:
                raise GarminNotFoundError(404, f"Resource not found at {url}", resp.text)

            if resp.status_code >= 400:
                raise GarminAPIError(resp.status_code, f"API error on {url}", resp.text)

            return resp

        raise GarminRateLimitError(f"Rate limit exceeded after {max_attempts} retries on {url}")

    def get_activities(
        self,
        start_timestamp: int,
        end_timestamp: int,
        limit: int = 100,
    ) -> List[Dict[str, Any]]:
        if self._personal_garmin is not None:
            start_date = datetime.fromtimestamp(start_timestamp, tz=timezone.utc).strftime("%Y-%m-%d")
            end_date = datetime.fromtimestamp(end_timestamp, tz=timezone.utc).strftime("%Y-%m-%d")
            acts = self._personal_garmin.get_activities_by_date(start_date, end_date)
            logger.info(f"Fetched {len(acts)} activities from personal Garmin Connect.")
            return acts if isinstance(acts, list) else []

        activities: List[Dict[str, Any]] = []
        offset = 0

        while True:
            params = {
                "uploadStartTimeInSeconds": start_timestamp,
                "uploadEndTimeInSeconds": end_timestamp,
                "limit": limit,
                "start": offset,
            }
            resp = self._authenticated_request("GET", self.ACTIVITIES_URL, params=params)
            batch = resp.json()

            if not isinstance(batch, list) or not batch:
                break

            activities.extend(batch)
            if len(batch) < limit:
                break
            offset += len(batch)

        logger.info(f"Fetched {len(activities)} activities from Garmin API.")
        return activities

    def fetch_activities(self, start_epoch: int, end_epoch: int, limit: int = 100) -> List[Dict[str, Any]]:
        return self.get_activities(start_epoch, end_epoch, limit=limit)

    def get_activity_details(self, activity_id: str) -> Optional[Dict[str, Any]]:
        if self._personal_garmin is not None:
            result: Dict[str, Any] = {"activityId": activity_id, "splits": []}
            if hasattr(self._personal_garmin, "get_activity_splits"):
                try:
                    splits = self._personal_garmin.get_activity_splits(activity_id)
                    if isinstance(splits, dict):
                        result["splits"] = splits.get("lapDTOs", [])
                except Exception as e:
                    logger.warning(f"Could not fetch personal activity splits for {activity_id}: {e}")

            if hasattr(self._personal_garmin, "get_activity_details"):
                try:
                    details = self._personal_garmin.get_activity_details(activity_id, maxchart=2000, maxpoly=4000)
                    if isinstance(details, dict):
                        if "geoPolylineDTO" in details:
                            result["geoPolylineDTO"] = details["geoPolylineDTO"]
                        if "metricDescriptors" in details:
                            result["metricDescriptors"] = details["metricDescriptors"]
                        if "activityDetailMetrics" in details:
                            result["activityDetailMetrics"] = details["activityDetailMetrics"]
                except Exception as e:
                    logger.warning(f"Could not fetch personal activity GPS/chart details for {activity_id}: {e}")

            if hasattr(self._personal_garmin, "get_activity_hr_in_timezones"):
                try:
                    hr_zones_raw = self._personal_garmin.get_activity_hr_in_timezones(activity_id)
                    if isinstance(hr_zones_raw, list):
                        hz_dict: Dict[str, int] = {}
                        for z in hr_zones_raw:
                            if isinstance(z, dict) and z.get("zoneNumber") is not None:
                                z_num = int(z["zoneNumber"])
                                if 1 <= z_num <= 5:
                                    hz_dict[f"Z{z_num}"] = int(float(z.get("secsInZone") or 0))
                        if hz_dict:
                            result["hr_zones"] = hz_dict
                except Exception as e:
                    logger.debug(f"Could not fetch personal activity HR zones for {activity_id}: {e}")

            extra_activity_calls = [
                ("typed_splits", "get_activity_typed_splits"),
                ("split_summaries", "get_activity_split_summaries"),
                ("power_zones", "get_activity_power_in_timezones"),
                ("weather", "get_activity_weather"),
                ("exercise_sets", "get_activity_exercise_sets"),
                ("gear", "get_activity_gear"),
            ]
            for dest_key, method_name in extra_activity_calls:
                if hasattr(self._personal_garmin, method_name):
                    try:
                        val = getattr(self._personal_garmin, method_name)(activity_id)
                        if isinstance(val, (dict, list)):
                            result[dest_key] = val
                    except Exception as e:
                        logger.debug(
                            f"Could not fetch personal activity {dest_key} ({method_name}) for {activity_id}: {e}"
                        )

            return result

        url = self.ACTIVITY_DETAILS_URL.format(activityId=activity_id)
        try:
            resp = self._authenticated_request("GET", url)
            return resp.json()
        except GarminNotFoundError:
            logger.warning(f"Activity details not found for {activity_id}.")
            return None

    def fetch_activity_details(self, activity_id: str) -> Optional[Dict[str, Any]]:
        return self.get_activity_details(activity_id)

    def get_hrv_data(self, cdate: str) -> Optional[Dict[str, Any]]:
        if self._personal_garmin is not None and hasattr(self._personal_garmin, "get_hrv_data"):
            try:
                return self._personal_garmin.get_hrv_data(cdate)
            except Exception as e:
                logger.warning(f"Could not fetch HRV data for {cdate}: {e}")
        return None

    def _safe_personal_call(self, method_name: str, *args: Any) -> Any:
        if self._personal_garmin is None or not hasattr(self._personal_garmin, method_name):
            return None
        try:
            res = getattr(self._personal_garmin, method_name)(*args)
            if isinstance(res, (dict, list)):
                return res
        except Exception as e:
            logger.debug(f"Personal Garmin call {method_name}{args} failed: {e}")
        return None

    def get_raw_daily_wellness_bundle(self, cdate: str) -> Optional[Dict[str, Any]]:
        """Safely query all 16 Garmin daily wellness endpoint groups and return the raw bundle."""
        if self._personal_garmin is None:
            return None

        bundle: Dict[str, Any] = {"date": cdate}

        # 1. User summary (with get_stats fallback)
        user_summary = None
        for m_name in ("get_user_summary", "get_stats"):
            cand = self._safe_personal_call(m_name, cdate)
            if cand:
                user_summary = cand
                break
        bundle["user_summary"] = user_summary

        # 2. Sleep
        bundle["sleep"] = self._safe_personal_call("get_sleep_data", cdate)

        # 3. HRV
        hrv_res = self.get_hrv_data(cdate)
        bundle["hrv"] = hrv_res if isinstance(hrv_res, (dict, list)) else None

        # 4. Stress (with get_all_day_stress fallback)
        stress_res = None
        for m_name in ("get_stress_data", "get_all_day_stress"):
            cand = self._safe_personal_call(m_name, cdate)
            if cand:
                stress_res = cand
                break
        bundle["stress"] = stress_res

        # 5. Body Battery + Events
        bb_res = None
        if hasattr(self._personal_garmin, "get_body_battery"):
            try:
                cand = self._personal_garmin.get_body_battery(cdate)
                if isinstance(cand, (dict, list)):
                    bb_res = cand
            except TypeError:
                try:
                    cand = self._personal_garmin.get_body_battery(cdate, cdate)
                    if isinstance(cand, (dict, list)):
                        bb_res = cand
                except Exception as e:
                    logger.debug(f"Personal Garmin call get_body_battery({cdate}, {cdate}) failed: {e}")
            except Exception as e:
                logger.debug(f"Personal Garmin call get_body_battery({cdate}) failed: {e}")
        bundle["body_battery"] = bb_res
        bundle["body_battery_events"] = self._safe_personal_call("get_body_battery_events", cdate)

        # 6-12. Heart rates, steps, respiration, SpO2, training readiness, training status, max metrics
        bundle["heart_rates"] = self._safe_personal_call("get_heart_rates", cdate)
        bundle["steps_data"] = self._safe_personal_call("get_steps_data", cdate)
        bundle["respiration"] = self._safe_personal_call("get_respiration_data", cdate)
        bundle["spo2"] = self._safe_personal_call("get_spo2_data", cdate)
        bundle["training_readiness"] = self._safe_personal_call("get_training_readiness", cdate)
        bundle["training_status"] = self._safe_personal_call("get_training_status", cdate)
        bundle["max_metrics"] = self._safe_personal_call("get_max_metrics", cdate)

        # 13. Body composition (with single-arg and weigh-ins fallbacks)
        body_comp = None
        if hasattr(self._personal_garmin, "get_body_composition"):
            try:
                cand = self._personal_garmin.get_body_composition(cdate, cdate)
                if isinstance(cand, (dict, list)) and cand:
                    body_comp = cand
            except TypeError:
                try:
                    cand = self._personal_garmin.get_body_composition(cdate)
                    if isinstance(cand, (dict, list)) and cand:
                        body_comp = cand
                except Exception as e:
                    logger.debug(f"Personal Garmin call get_body_composition({cdate}) failed: {e}")
            except Exception as e:
                logger.debug(f"Personal Garmin call get_body_composition({cdate}, {cdate}) failed: {e}")
        if not body_comp:
            for m_name, m_args in (("get_weigh_ins", (cdate, cdate)), ("get_daily_weigh_ins", (cdate,))):
                if hasattr(self._personal_garmin, m_name):
                    try:
                        cand = getattr(self._personal_garmin, m_name)(*m_args)
                        if isinstance(cand, (dict, list)) and cand:
                            body_comp = cand
                            break
                    except TypeError:
                        try:
                            cand = getattr(self._personal_garmin, m_name)(cdate)
                            if isinstance(cand, (dict, list)) and cand:
                                body_comp = cand
                                break
                        except Exception:
                            pass
                    except Exception as e:
                        logger.debug(f"Personal Garmin call {m_name} failed: {e}")
        bundle["body_composition"] = body_comp

        # 14-16. Hydration, floors, fitness age
        bundle["hydration"] = self._safe_personal_call("get_hydration_data", cdate)
        bundle["floors"] = self._safe_personal_call("get_floors", cdate)
        bundle["fitness_age"] = self._safe_personal_call("get_fitnessage_data", cdate)

        has_data = any(bool(v) for k, v in bundle.items() if k != "date")
        if not has_data:
            return None
        return bundle

    def get_daily_wellness(self, cdate: str) -> Optional[Dict[str, Any]]:
        """Fetch genuine daily wellness metrics for cdate by collecting and normalizing the raw bundle."""
        raw_bundle = self.get_raw_daily_wellness_bundle(cdate)
        if not raw_bundle:
            return None
        return normalize_daily_wellness(cdate, raw_bundle)

    def download_fit_file(self, activity_id: str) -> Optional[bytes]:
        if self._personal_garmin is not None:
            try:
                raw_bytes = self._personal_garmin.download_activity(
                    activity_id, dl_fmt=self._personal_garmin.ActivityDownloadFormat.ORIGINAL
                )
            except Exception as e:
                logger.warning(f"Could not download personal .FIT for {activity_id}: {e}")
                return None
        else:
            url = self.FILE_DOWNLOAD_URL.format(activityId=activity_id)
            try:
                resp = self._authenticated_request("GET", url, stream=True)
                raw_bytes = resp.content
            except GarminNotFoundError:
                logger.warning(f"No .FIT file found for activity {activity_id}.")
                return None

        # Handle ZIP wrapper if present
        if raw_bytes.startswith(b"PK\x03\x04"):
            try:
                with zipfile.ZipFile(io.BytesIO(raw_bytes)) as z:
                    for name in z.namelist():
                        if name.lower().endswith(".fit"):
                            return z.read(name)
                logger.warning(f"ZIP archive for {activity_id} contained no .fit file.")
                return None
            except Exception as e:
                logger.error(f"Failed to unpack ZIP for activity {activity_id}: {e}")
                return None

        return raw_bytes

    def download_gpx_file(self, activity_id: str) -> Optional[bytes]:
        if self._personal_garmin is not None:
            try:
                raw_bytes = self._personal_garmin.download_activity(
                    activity_id, dl_fmt=self._personal_garmin.ActivityDownloadFormat.GPX
                )
                if raw_bytes and (b"<gpx" in raw_bytes or b"<?xml" in raw_bytes):
                    return raw_bytes
            except Exception as e:
                logger.debug(f"Could not download personal .GPX for {activity_id}: {e}")
                return None

        url = f"https://connectapi.garmin.com/activity-api/rest/gpx/{activity_id}"
        try:
            resp = self._authenticated_request("GET", url, stream=True)
            if resp.content and (b"<gpx" in resp.content or b"<?xml" in resp.content):
                return resp.content
        except GarminNotFoundError:
            logger.debug(f"No GPX track available for {activity_id}.")
        except Exception as e:
            logger.debug(f"Failed to fetch GPX for {activity_id}: {e}")
        return None

    def fetch_gpx_file(self, activity_id: str) -> Optional[bytes]:
        return self.download_gpx_file(activity_id)

    def get_session_state(self) -> Optional[OAuthSessionState]:
        return self._session_state


# ---------------------------------------------------------------------------
# Mock Garmin Client Implementation
# ---------------------------------------------------------------------------

class MockGarminClient:
    """
    Offline mock client producing deterministic multi-sport activity summaries,
    realistic laps/splits, and valid binary .FIT files using SyntheticDatasetGenerator.
    Requires ZERO network calls and operates fully offline.
    """

    def __init__(
        self,
        api_key_or_seed: Union[str, int] = 42,
        client_secret: str = "mock_secret",
        session_state: Optional[Union[Dict[str, Any], OAuthSessionState]] = None,
        token_store: Optional[TokenStoreProtocol] = None,
        simulate_auth_failure: bool = False,
        simulate_rate_limit: bool = False,
        seed: int = 42,
    ):
        if isinstance(api_key_or_seed, int):
            self.seed = api_key_or_seed
        else:
            self.seed = seed

        self.api_key = str(api_key_or_seed)
        self.client_secret = client_secret
        self.token_store = token_store or MemoryTokenStore()
        self.simulate_auth_failure = simulate_auth_failure
        self.simulate_rate_limit = simulate_rate_limit
        self.refresh_call_count = 0

        if session_state:
            if isinstance(session_state, OAuthSessionState):
                self._session_state = session_state
            else:
                self._session_state = OAuthSessionState(**session_state)
        else:
            self._session_state = OAuthSessionState(
                access_token="mock_access_token_initial",
                refresh_token="mock_refresh_token_initial",
                expires_at=int(time.time()) + 3600,
                token_type="Bearer",
            )
        self.token_store.save_session(self._session_state)

    @property
    def session_state(self) -> OAuthSessionState:
        return self._session_state

    @session_state.setter
    def session_state(self, val: Union[Dict[str, Any], OAuthSessionState]) -> None:
        if isinstance(val, OAuthSessionState):
            self._session_state = val
        else:
            self._session_state = OAuthSessionState(**val)

    def is_token_expired(self, buffer_seconds: int = 300) -> bool:
        return self._session_state.is_expired(buffer_seconds)

    def refresh_tokens(self) -> OAuthSessionState:
        self.refresh_call_count += 1
        if self.simulate_auth_failure:
            raise GarminAuthError("Mock authentication refresh failed")

        self._session_state = OAuthSessionState(
            access_token=f"refreshed_access_token_{self.refresh_call_count}",
            refresh_token=f"refreshed_refresh_token_{self.refresh_call_count}",
            expires_at=int(time.time()) + 86400,
            token_type="Bearer",
        )
        self.token_store.save_session(self._session_state)
        return self._session_state

    def refresh_access_token(self, post_handler: Any = None) -> Dict[str, Any]:
        self.refresh_tokens()
        return (
            self._session_state.model_dump()
            if hasattr(self._session_state, "model_dump")
            else self._session_state.dict()
        )

    def get_activities(
        self,
        start_timestamp: int,
        end_timestamp: int,
        limit: int = 100,
    ) -> List[Dict[str, Any]]:
        if self.simulate_rate_limit:
            raise GarminRateLimitError("Mock rate limit exceeded")

        from src.ingestion.mock_generator import SyntheticDatasetGenerator
        gen = SyntheticDatasetGenerator(seed=self.seed)
        all_activities = gen.generate_raw_activity_summaries()

        filtered = [
            act for act in all_activities
            if start_timestamp <= act.get("startTimeInSeconds", 0) <= end_timestamp
        ]
        return filtered[:limit]

    def fetch_activities(self, start_epoch: int, end_epoch: int, limit: int = 100) -> List[Dict[str, Any]]:
        return self.get_activities(start_epoch, end_epoch, limit=limit)

    def get_activity_details(self, activity_id: str) -> Optional[Dict[str, Any]]:
        from src.ingestion.mock_generator import SyntheticDatasetGenerator
        gen = SyntheticDatasetGenerator(seed=self.seed)
        return gen.generate_activity_detail(activity_id)

    def fetch_activity_details(self, activity_id: str) -> Optional[Dict[str, Any]]:
        return self.get_activity_details(activity_id)

    def download_fit_file(self, activity_id: str) -> Optional[bytes]:
        from src.ingestion.mock_generator import SyntheticDatasetGenerator
        gen = SyntheticDatasetGenerator(seed=self.seed)
        return gen.generate_binary_fit_file(activity_id)

    def download_gpx_file(self, activity_id: str) -> Optional[bytes]:
        from src.ingestion.mock_generator import SyntheticDatasetGenerator
        gen = SyntheticDatasetGenerator(seed=self.seed)
        return gen.generate_gpx_file(activity_id)

    def fetch_gpx_file(self, activity_id: str) -> Optional[bytes]:
        return self.download_gpx_file(activity_id)

    def get_hrv_data(self, cdate: str) -> Optional[Dict[str, Any]]:
        return None

    def get_raw_daily_wellness_bundle(self, cdate: str) -> Optional[Dict[str, Any]]:
        """Return a deterministic synthetic raw daily wellness bundle for cdate without mutating generator RNG."""
        try:
            day_dt = datetime.strptime(cdate[:10], "%Y-%m-%d").replace(tzinfo=timezone.utc)
        except Exception:
            return None

        local_rng = random.Random(f"{self.seed}:{cdate}")
        base_ms = int(day_dt.timestamp()) * 1000

        steps = local_rng.randint(6800, 12500)
        rhr = local_rng.randint(46, 53)
        sleep_sec = local_rng.randint(25200, 30600)
        sleep_deep = int(sleep_sec * 0.21)
        sleep_rem = int(sleep_sec * 0.23)
        sleep_awake = int(sleep_sec * 0.05)
        sleep_light = sleep_sec - (sleep_deep + sleep_rem + sleep_awake)
        sleep_score = local_rng.randint(78, 93)

        stress_avg = local_rng.randint(18, 34)
        stress_max = local_rng.randint(58, 86)
        stress_total = 57600
        stress_high = int(stress_total * 0.06)
        stress_med = int(stress_total * 0.14)
        stress_low = int(stress_total * 0.28)
        stress_rest = stress_total - (stress_high + stress_med + stress_low)

        bb_high = local_rng.randint(80, 96)
        bb_low = local_rng.randint(18, 35)
        bb_wake = max(bb_low, bb_high - local_rng.randint(0, 4))
        bb_curr = max(bb_low, min(bb_high, bb_wake - local_rng.randint(20, 45)))

        stress_arr: List[List[int]] = []
        bb_arr: List[List[Any]] = []
        # 3-minute intervals across 24h (480 samples)
        for idx in range(480):
            ts_ms = base_ms + idx * 180_000
            is_sleep = idx < 140
            s_val = local_rng.randint(8, 22) if is_sleep else local_rng.randint(16, stress_max)
            stress_arr.append([ts_ms, s_val])
            if is_sleep:
                bb_val = int(round(bb_low + ((bb_high - bb_low) * (idx / 139.0))))
            else:
                frac = (idx - 140) / 339.0
                bb_val = int(round(bb_high - ((bb_high - bb_low) * frac)))
            bb_arr.append([ts_ms, "MEASURED", max(5, min(100, bb_val)), 3])

        return {
            "date": cdate,
            "user_summary": {
                "totalSteps": steps,
                "dailyStepGoal": 10000,
                "restingHeartRate": rhr,
                "lastSevenDaysAvgRestingHeartRate": float(rhr),
                "averageStressLevel": stress_avg,
                "maxStressLevel": stress_max,
                "stressQualifier": "LOW" if stress_avg <= 50 else "MEDIUM",
                "restStressDuration": stress_rest,
                "lowStressDuration": stress_low,
                "mediumStressDuration": stress_med,
                "highStressDuration": stress_high,
                "stressDuration": stress_total,
                "bodyBatteryHighestValue": bb_high,
                "bodyBatteryLowestValue": bb_low,
                "bodyBatteryMostRecentValue": bb_curr,
                "bodyBatteryAtWakeTime": bb_wake,
                "bodyBatteryChargedValue": bb_high - bb_low,
                "bodyBatteryDrainedValue": bb_high - bb_curr,
                "moderateIntensityMinutes": 24,
                "vigorousIntensityMinutes": 14,
                "intensityMinutesGoal": 150,
                "totalKilocalories": 2350,
                "activeKilocalories": 620,
                "bmrKilocalories": 1730,
                "minHeartRate": rhr - 4,
                "maxHeartRate": 168,
            },
            "sleep": {
                "dailySleepDTO": {
                    "sleepTimeSeconds": sleep_sec,
                    "deepSleepSeconds": sleep_deep,
                    "lightSleepSeconds": sleep_light,
                    "remSleepSeconds": sleep_rem,
                    "awakeSleepSeconds": sleep_awake,
                    "sleepScores": {
                        "overall": {"value": sleep_score, "qualifierKey": "GOOD"},
                    },
                }
            },
            "hrv": {
                "hrvSummary": {
                    "status": "BALANCED",
                    "weeklyAvg": 58,
                    "lastNightAvg": 60,
                    "baseline": {"balancedLow": 48, "balancedUpper": 62},
                }
            },
            "stress": {
                "avgStressLevel": stress_avg,
                "maxStressLevel": stress_max,
                "stressValuesArray": stress_arr,
                "bodyBatteryValuesArray": bb_arr,
            },
            "body_battery": [
                {
                    "date": cdate,
                    "charged": bb_high - bb_low,
                    "drained": bb_high - bb_curr,
                    "bodyBatteryValuesArray": bb_arr,
                }
            ],
            "body_battery_events": [],
            "heart_rates": {"restingHeartRate": rhr, "minHeartRate": rhr - 4, "maxHeartRate": 168},
            "steps_data": [],
            "respiration": {"avgWakingRespirationValue": 14.5, "avgSleepRespirationValue": 13.2},
            "spo2": {"averageSpO2": 97.0, "lowestSpO2": 93},
            "training_readiness": [{"score": 76}],
            "training_status": {"mostRecentVO2Max": {"generic": {"vo2MaxValue": 54.0}}},
            "max_metrics": [{"generic": {"vo2MaxValue": 54.0}, "cycling": {"vo2MaxValue": 52.0}}],
            "body_composition": {"totalAverage": {"weight": 72500, "bmi": 22.1, "bodyFat": 14.5, "muscleMass": 34200}},
            "hydration": {"valueInML": 2200},
            "floors": {"floorsAscended": 8, "floorsDescended": 7},
            "fitness_age": {"fitnessAge": 28},
        }

    def get_daily_wellness(self, cdate: str) -> Optional[Dict[str, Any]]:
        raw_bundle = self.get_raw_daily_wellness_bundle(cdate)
        if not raw_bundle:
            return None
        return normalize_daily_wellness(cdate, raw_bundle)

    def get_session_state(self) -> Optional[OAuthSessionState]:
        return self._session_state


# Convenience Alias
GarminClient = LiveGarminClient
