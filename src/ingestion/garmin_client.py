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
        return self.model_dump_json(indent=2)

    @classmethod
    def from_json(cls, data: str) -> OAuthSessionState:
        return cls.model_validate_json(data)

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
        return session.model_dump()

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
            try:
                splits = self._personal_garmin.get_activity_splits(activity_id)
                if isinstance(splits, dict):
                    result["splits"] = splits.get("lapDTOs", [])
            except Exception as e:
                logger.warning(f"Could not fetch personal activity splits for {activity_id}: {e}")

            try:
                details = self._personal_garmin.get_activity_details(activity_id, maxchart=200, maxpoly=400)
                if isinstance(details, dict):
                    if "geoPolylineDTO" in details:
                        result["geoPolylineDTO"] = details["geoPolylineDTO"]
                    if "metricDescriptors" in details:
                        result["metricDescriptors"] = details["metricDescriptors"]
                    if "activityDetailMetrics" in details:
                        result["activityDetailMetrics"] = details["activityDetailMetrics"]
            except Exception as e:
                logger.warning(f"Could not fetch personal activity GPS/chart details for {activity_id}: {e}")

            try:
                if hasattr(self._personal_garmin, "get_activity_hr_in_timezones"):
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
        return self._session_state.model_dump()

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

    def get_session_state(self) -> Optional[OAuthSessionState]:
        return self._session_state


# Convenience Alias
GarminClient = LiveGarminClient
