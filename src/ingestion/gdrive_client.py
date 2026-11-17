"""
src/ingestion/gdrive_client.py
Native Google Drive storage client targeting 'My Drive/Drive/health/garmin-dash'
and CompositeStorageClient for primary + backup redundancy (Google Drive + Hetzner SFTP).
"""

from __future__ import annotations

import io
import json
import logging
import os
import posixpath
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple, Union

from src.ingestion.sftp_client import (
    HetznerSFTPClient,
    MockSFTPClient,
    SFTPArchivalError,
    SFTPClientProtocol,
    SFTPConfig,
    SFTPFileStat,
)

logger = logging.getLogger(__name__)

FOLDER_MIME_TYPE = "application/vnd.google-apps.folder"
DEFAULT_GDRIVE_ROOT_PATH = "Drive/health/garmin-dash"


@dataclass
class GDriveConfig:
    """Configuration for Google Drive API storage."""
    credentials_json: str
    root_folder_path: str = DEFAULT_GDRIVE_ROOT_PATH
    base_dir: str = "garmin_archive"

    @classmethod
    def from_env(cls) -> Optional[GDriveConfig]:
        creds = os.environ.get("GDRIVE_CREDENTIALS_JSON", "").strip()
        if not creds:
            return None
        root_path = os.environ.get("GDRIVE_ROOT_PATH", DEFAULT_GDRIVE_ROOT_PATH).strip() or DEFAULT_GDRIVE_ROOT_PATH
        return cls(credentials_json=creds, root_folder_path=root_path)


class GoogleDriveStorageClient:
    """
    Google Drive API v3 client implementing SFTPClientProtocol.
    Points directly to 'My Drive/Drive/health/garmin-dash' without rclone.
    """

    def __init__(self, config: GDriveConfig) -> None:
        self.config = config
        self._service: Any = None
        self._root_folder_id: Optional[str] = None
        self._folder_cache: Dict[str, str] = {}

    def connect(self) -> None:
        """Authenticates with Google Drive API and resolves the root folder hierarchy."""
        if self._service is not None and self._root_folder_id is not None:
            return

        try:
            from google.oauth2 import service_account
            from google.oauth2.credentials import Credentials
            from googleapiclient.discovery import build
        except ImportError as exc:
            raise SFTPArchivalError(
                "google-api-python-client and google-auth are required for Google Drive storage."
            ) from exc

        raw_creds = self.config.credentials_json.strip()
        if Path(raw_creds).is_file():
            raw_creds = Path(raw_creds).read_text(encoding="utf-8")

        try:
            cred_info = json.loads(raw_creds)
        except Exception as exc:
            raise SFTPArchivalError(f"Invalid GDRIVE_CREDENTIALS_JSON format: {exc}") from exc

        scopes = ["https://www.googleapis.com/auth/drive"]
        if cred_info.get("type") == "service_account":
            creds = service_account.Credentials.from_service_account_info(cred_info, scopes=scopes)
        else:
            creds = Credentials.from_authorized_user_info(cred_info, scopes=scopes)

        self._service = build("drive", "v3", credentials=creds, cache_discovery=False)
        self._root_folder_id = self._resolve_or_create_path(self.config.root_folder_path, parent_id="root")
        self._folder_cache[""] = self._root_folder_id
        logger.info(f"Connected to Google Drive folder '{self.config.root_folder_path}' (id={self._root_folder_id}).")

    def close(self) -> None:
        if self._service is not None:
            try:
                self._service.close()
            except Exception:
                pass
            self._service = None

    def __enter__(self) -> GoogleDriveStorageClient:
        self.connect()
        return self

    def __exit__(self, exc_type: Any, exc_val: Any, exc_tb: Any) -> None:
        self.close()

    def _normalize_rel_path(self, remote_path: str) -> str:
        clean = posixpath.normpath(remote_path.strip().lstrip("/"))
        return "" if clean in (".", "/") else clean

    def _find_child(self, parent_id: str, name: str, is_folder: Optional[bool] = None) -> Optional[Dict[str, Any]]:
        self.connect()
        escaped_name = name.replace("'", "\\'")
        q_parts = [
            f"'{parent_id}' in parents",
            f"name = '{escaped_name}'",
            "trashed = false",
        ]
        if is_folder is True:
            q_parts.append(f"mimeType = '{FOLDER_MIME_TYPE}'")
        elif is_folder is False:
            q_parts.append(f"mimeType != '{FOLDER_MIME_TYPE}'")

        query = " and ".join(q_parts)
        resp = (
            self._service.files()
            .list(
                q=query,
                spaces="drive",
                fields="files(id, name, mimeType, size, modifiedTime)",
                pageSize=5,
                supportsAllDrives=True,
                includeItemsFromAllDrives=True,
            )
            .execute()
        )
        files = resp.get("files", [])
        return files[0] if files else None

    def _create_folder(self, parent_id: str, name: str) -> str:
        self.connect()
        meta = {
            "name": name,
            "mimeType": FOLDER_MIME_TYPE,
            "parents": [parent_id],
        }
        created = (
            self._service.files()
            .create(body=meta, fields="id", supportsAllDrives=True)
            .execute()
        )
        return str(created["id"])

    def _resolve_or_create_path(self, folder_path: str, parent_id: str = "root") -> str:
        parts = [p for p in folder_path.strip("/").split("/") if p and p != "."]
        curr_parent = parent_id
        accum = ""
        for idx, part in enumerate(parts):
            accum = f"{accum}/{part}" if accum else part
            cache_key = f"{parent_id}:{accum}"
            if cache_key in self._folder_cache:
                curr_parent = self._folder_cache[cache_key]
                continue

            found = self._find_child(curr_parent, part, is_folder=True)
            if not found and parent_id == "root" and idx == 0:
                # Also search shared folders if the user shared 'garmin-dash' or 'Drive' with a Service Account
                escaped = part.replace("'", "\\'")
                resp = (
                    self._service.files()
                    .list(
                        q=f"name = '{escaped}' and mimeType = '{FOLDER_MIME_TYPE}' and trashed = false",
                        spaces="drive",
                        fields="files(id, name)",
                        pageSize=5,
                        supportsAllDrives=True,
                        includeItemsFromAllDrives=True,
                    )
                    .execute()
                )
                shared = resp.get("files", [])
                if shared:
                    found = shared[0]

            if found:
                curr_parent = str(found["id"])
            else:
                curr_parent = self._create_folder(curr_parent, part)
            self._folder_cache[cache_key] = curr_parent
        return curr_parent

    def _resolve_parent_and_name(self, remote_path: str, create_dirs: bool = False) -> Tuple[Optional[str], str]:
        self.connect()
        rel = self._normalize_rel_path(remote_path)
        if not rel:
            return self._root_folder_id, ""
        dir_part, file_part = posixpath.split(rel)
        if not dir_part:
            return self._root_folder_id, file_part

        if dir_part in self._folder_cache:
            return self._folder_cache[dir_part], file_part

        curr_parent = str(self._root_folder_id)
        accum = ""
        for part in [p for p in dir_part.split("/") if p]:
            accum = f"{accum}/{part}" if accum else part
            if accum in self._folder_cache:
                curr_parent = self._folder_cache[accum]
                continue
            found = self._find_child(curr_parent, part, is_folder=True)
            if found:
                curr_parent = str(found["id"])
            elif create_dirs:
                curr_parent = self._create_folder(curr_parent, part)
            else:
                return None, file_part
            self._folder_cache[accum] = curr_parent

        return curr_parent, file_part

    def mkdir_p(self, remote_dir: str) -> None:
        self.connect()
        rel = self._normalize_rel_path(remote_dir)
        if not rel:
            return
        self._resolve_parent_and_name(f"{rel}/_placeholder", create_dirs=True)

    def upload_bytes(self, data: bytes, remote_path: str, atomic: bool = True) -> bool:
        self.connect()
        from googleapiclient.http import MediaIoBaseUpload

        parent_id, filename = self._resolve_parent_and_name(remote_path, create_dirs=True)
        if not parent_id or not filename:
            raise SFTPArchivalError(f"Invalid Google Drive target path: {remote_path}")

        media = MediaIoBaseUpload(io.BytesIO(data), mimetype="application/octet-stream", resumable=False)
        existing = self._find_child(parent_id, filename, is_folder=False)
        if existing:
            self._service.files().update(
                fileId=existing["id"],
                media_body=media,
                supportsAllDrives=True,
            ).execute()
        else:
            meta = {"name": filename, "parents": [parent_id]}
            self._service.files().create(
                body=meta,
                media_body=media,
                fields="id",
                supportsAllDrives=True,
            ).execute()
        return True

    def put_bytes(self, remote_path: str, data: bytes) -> None:
        self.upload_bytes(data, remote_path, atomic=True)

    def upload_file(self, local_path: Union[Path, str], remote_path: str, atomic: bool = True) -> bool:
        data = Path(local_path).read_bytes()
        return self.upload_bytes(data, remote_path, atomic=atomic)

    def upload_file_verified(self, local_path: Union[Path, str], remote_path: str) -> None:
        self.upload_file(local_path, remote_path, atomic=True)

    def put_file(self, local_path: Union[Path, str], remote_path: str) -> None:
        self.upload_file(local_path, remote_path, atomic=True)

    def download_bytes(self, remote_path: str) -> bytes:
        self.connect()
        from googleapiclient.http import MediaIoBaseDownload

        parent_id, filename = self._resolve_parent_and_name(remote_path, create_dirs=False)
        if not parent_id or not filename:
            raise FileNotFoundError(f"Remote file not found on Google Drive: {remote_path}")
        existing = self._find_child(parent_id, filename, is_folder=False)
        if not existing:
            raise FileNotFoundError(f"Remote file not found on Google Drive: {remote_path}")

        request = self._service.files().get_media(fileId=existing["id"], supportsAllDrives=True)
        buf = io.BytesIO()
        downloader = MediaIoBaseDownload(buf, request)
        done = False
        while not done:
            _, done = downloader.next_chunk()
        return buf.getvalue()

    def get_bytes(self, remote_path: str) -> bytes:
        return self.download_bytes(remote_path)

    def download_file(self, remote_path: str, local_path: Union[Path, str]) -> None:
        data = self.download_bytes(remote_path)
        target = Path(local_path)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)

    def get_file(self, remote_path: str, local_path: Union[Path, str]) -> None:
        self.download_file(remote_path, local_path)

    def read_text(self, remote_path: str) -> Optional[str]:
        try:
            return self.download_bytes(remote_path).decode("utf-8")
        except FileNotFoundError:
            return None

    def write_text_atomic(self, remote_path: str, content: str) -> None:
        self.upload_bytes(content.encode("utf-8"), remote_path, atomic=True)

    def file_exists(self, remote_path: str) -> bool:
        self.connect()
        parent_id, filename = self._resolve_parent_and_name(remote_path, create_dirs=False)
        if not parent_id or not filename:
            return False
        return self._find_child(parent_id, filename, is_folder=False) is not None

    def stat(self, remote_path: str) -> SFTPFileStat:
        self.connect()
        parent_id, filename = self._resolve_parent_and_name(remote_path, create_dirs=False)
        if not parent_id or not filename:
            raise FileNotFoundError(f"Remote path not found: {remote_path}")
        item = self._find_child(parent_id, filename)
        if not item:
            raise FileNotFoundError(f"Remote path not found: {remote_path}")
        is_dir = item.get("mimeType") == FOLDER_MIME_TYPE
        size_b = int(item.get("size") or 0)
        return SFTPFileStat(
            filename=filename,
            size_bytes=size_b,
            mtime=int(time.time()),
            is_dir=is_dir,
        )

    def listdir(self, remote_dir: str) -> List[str]:
        self.connect()
        rel = self._normalize_rel_path(remote_dir)
        if not rel:
            folder_id = self._root_folder_id
        else:
            parent_id, folder_name = self._resolve_parent_and_name(rel, create_dirs=False)
            if not parent_id or not folder_name:
                return []
            found = self._find_child(parent_id, folder_name, is_folder=True)
            if not found:
                return []
            folder_id = str(found["id"])

        resp = (
            self._service.files()
            .list(
                q=f"'{folder_id}' in parents and trashed = false",
                spaces="drive",
                fields="files(name)",
                pageSize=1000,
                supportsAllDrives=True,
                includeItemsFromAllDrives=True,
            )
            .execute()
        )
        return sorted(str(f["name"]) for f in resp.get("files", []))

    def remove(self, remote_path: str) -> None:
        self.connect()
        parent_id, filename = self._resolve_parent_and_name(remote_path, create_dirs=False)
        if not parent_id or not filename:
            return
        existing = self._find_child(parent_id, filename)
        if existing:
            self._service.files().delete(fileId=existing["id"], supportsAllDrives=True).execute()

    def rename(self, old_path: str, new_path: str) -> None:
        data = self.download_bytes(old_path)
        self.upload_bytes(data, new_path, atomic=True)
        self.remove(old_path)

    def load_oauth_session(self, remote_path: str = "garmin_archive/.session/garmin_oauth.json") -> Optional[Dict[str, Any]]:
        raw = self.read_text(remote_path)
        if not raw:
            return None
        try:
            return json.loads(raw)
        except Exception:
            return None

    def save_oauth_session(self, session_data: Union[Dict[str, Any], Any], remote_path: str = "garmin_archive/.session/garmin_oauth.json") -> None:
        if hasattr(session_data, "to_dict"):
            payload = session_data.to_dict()
        elif isinstance(session_data, dict):
            payload = session_data
        else:
            payload = dict(session_data)
        self.write_text_atomic(remote_path, json.dumps(payload, indent=2))

    def archive_activity(
        self,
        activity_id: str,
        start_time_iso: str,
        summary_json_bytes: Optional[bytes] = None,
        fit_bytes: Optional[bytes] = None,
        gpx_bytes: Optional[bytes] = None,
        base_dir: str = "garmin_archive",
    ) -> Dict[str, str]:
        from datetime import datetime
        try:
            cleaned = str(start_time_iso).replace("Z", "+00:00").replace(" ", "T")
            dt = datetime.fromisoformat(cleaned)
            year_str = f"{dt.year:04d}"
            month_str = f"{dt.month:02d}"
        except Exception:
            year_str = time.strftime("%Y", time.gmtime())
            month_str = time.strftime("%m", time.gmtime())

        remote_dir = f"{base_dir}/activities/{year_str}/{month_str}"
        self.mkdir_p(remote_dir)

        results: Dict[str, str] = {}
        if summary_json_bytes is not None:
            json_path = f"{remote_dir}/{activity_id}_summary.json"
            self.upload_bytes(summary_json_bytes, json_path, atomic=True)
            results["summary"] = json_path

        if fit_bytes is not None:
            fit_path = f"{remote_dir}/{activity_id}.fit"
            self.upload_bytes(fit_bytes, fit_path, atomic=True)
            results["fit"] = fit_path

        if gpx_bytes is not None:
            gpx_path = f"{remote_dir}/{activity_id}.gpx"
            self.upload_bytes(gpx_bytes, gpx_path, atomic=True)
            results["gpx"] = gpx_path

        return results

    def scan_archive_inventory(self, base_dir: str = "garmin_archive") -> Dict[str, Any]:
        activities_root = f"{base_dir.rstrip('/')}/activities"
        activities_by_year: Dict[str, int] = {}
        formats_backed_up: Dict[str, int] = {"fit": 0, "gpx": 0, "json": 0}
        activity_ids_by_year: Dict[str, Set[str]] = {}
        all_activity_ids: Set[str] = set()
        file_count = 0

        try:
            year_dirs = self.listdir(activities_root)
        except Exception:
            year_dirs = []

        for y in year_dirs:
            if not (len(y) == 4 and y.isdigit()):
                continue
            y_path = f"{activities_root}/{y}"
            try:
                month_dirs = self.listdir(y_path)
            except Exception:
                month_dirs = []

            for m in month_dirs:
                m_path = f"{y_path}/{m}"
                try:
                    entries = self.listdir(m_path)
                except Exception:
                    entries = []

                for entry in entries:
                    file_count += 1
                    lower_entry = entry.lower()
                    if lower_entry.endswith("_summary.json"):
                        act_id = entry[:-13]
                        formats_backed_up["json"] += 1
                    elif lower_entry.endswith(".fit"):
                        act_id = entry[:-4]
                        formats_backed_up["fit"] += 1
                    elif lower_entry.endswith(".gpx"):
                        act_id = entry[:-4]
                        formats_backed_up["gpx"] += 1
                    else:
                        continue

                    activity_ids_by_year.setdefault(y, set()).add(act_id)
                    all_activity_ids.add(act_id)

        for y, ids in activity_ids_by_year.items():
            activities_by_year[y] = len(ids)

        return {
            "total_activities": len(all_activity_ids),
            "activities_by_year": activities_by_year,
            "formats_backed_up": formats_backed_up,
            "years": sorted(list(activities_by_year.keys())),
            "file_count": file_count,
        }


class CompositeStorageClient:
    """
    Wraps a primary storage client and an optional secondary backup storage client.
    Reads from primary (falling back to secondary if missing on primary) and mirrors all writes to both.
    """

    def __init__(self, primary: SFTPClientProtocol, backup: Optional[SFTPClientProtocol] = None) -> None:
        self.primary = primary
        self.backup = backup

    def connect(self) -> None:
        if hasattr(self.primary, "connect"):
            self.primary.connect()
        if self.backup and hasattr(self.backup, "connect"):
            try:
                self.backup.connect()
            except Exception as e:
                logger.warning(f"Backup storage connect warning: {e}")

    def close(self) -> None:
        if hasattr(self.primary, "close"):
            self.primary.close()
        if self.backup and hasattr(self.backup, "close"):
            try:
                self.backup.close()
            except Exception:
                pass

    def __enter__(self) -> CompositeStorageClient:
        self.connect()
        return self

    def __exit__(self, exc_type: Any, exc_val: Any, exc_tb: Any) -> None:
        self.close()

    def mkdir_p(self, remote_dir: str) -> None:
        self.primary.mkdir_p(remote_dir)
        if self.backup:
            try:
                self.backup.mkdir_p(remote_dir)
            except Exception as e:
                logger.warning(f"Backup mkdir_p warning ({remote_dir}): {e}")

    def upload_bytes(self, data: bytes, remote_path: str, atomic: bool = True) -> bool:
        res = self.primary.upload_bytes(data, remote_path, atomic=atomic)
        if self.backup:
            try:
                self.backup.upload_bytes(data, remote_path, atomic=atomic)
            except Exception as e:
                logger.warning(f"Backup upload_bytes warning ({remote_path}): {e}")
        return res

    def put_bytes(self, remote_path: str, data: bytes) -> None:
        self.upload_bytes(data, remote_path, atomic=True)

    def upload_file(self, local_path: Union[Path, str], remote_path: str, atomic: bool = True) -> bool:
        res = self.primary.upload_file(local_path, remote_path, atomic=atomic)
        if self.backup:
            try:
                self.backup.upload_file(local_path, remote_path, atomic=atomic)
            except Exception as e:
                logger.warning(f"Backup upload_file warning ({remote_path}): {e}")
        return res

    def upload_file_verified(self, local_path: Union[Path, str], remote_path: str) -> None:
        self.upload_file(local_path, remote_path, atomic=True)

    def put_file(self, local_path: Union[Path, str], remote_path: str) -> None:
        self.upload_file(local_path, remote_path, atomic=True)

    def download_bytes(self, remote_path: str) -> bytes:
        try:
            return self.primary.download_bytes(remote_path)
        except Exception:
            if self.backup:
                return self.backup.download_bytes(remote_path)
            raise

    def get_bytes(self, remote_path: str) -> bytes:
        return self.download_bytes(remote_path)

    def download_file(self, remote_path: str, local_path: Union[Path, str]) -> None:
        data = self.download_bytes(remote_path)
        Path(local_path).write_bytes(data)

    def get_file(self, remote_path: str, local_path: Union[Path, str]) -> None:
        self.download_file(remote_path, local_path)

    def read_text(self, remote_path: str) -> Optional[str]:
        txt = self.primary.read_text(remote_path)
        if txt is None and self.backup:
            try:
                txt = self.backup.read_text(remote_path)
            except Exception:
                return None
        return txt

    def write_text_atomic(self, remote_path: str, content: str) -> None:
        self.primary.write_text_atomic(remote_path, content)
        if self.backup:
            try:
                self.backup.write_text_atomic(remote_path, content)
            except Exception as e:
                logger.warning(f"Backup write_text_atomic warning ({remote_path}): {e}")

    def file_exists(self, remote_path: str) -> bool:
        if self.primary.file_exists(remote_path):
            return True
        if self.backup:
            try:
                return self.backup.file_exists(remote_path)
            except Exception:
                return False
        return False

    def stat(self, remote_path: str) -> SFTPFileStat:
        try:
            return self.primary.stat(remote_path)
        except Exception:
            if self.backup:
                return self.backup.stat(remote_path)
            raise

    def listdir(self, remote_dir: str) -> List[str]:
        items = set(self.primary.listdir(remote_dir))
        if self.backup:
            try:
                items.update(self.backup.listdir(remote_dir))
            except Exception:
                pass
        return sorted(items)

    def remove(self, remote_path: str) -> None:
        self.primary.remove(remote_path)
        if self.backup:
            try:
                self.backup.remove(remote_path)
            except Exception:
                pass

    def rename(self, old_path: str, new_path: str) -> None:
        self.primary.rename(old_path, new_path)
        if self.backup:
            try:
                self.backup.rename(old_path, new_path)
            except Exception:
                pass

    def load_oauth_session(self, remote_path: str = "garmin_archive/.session/garmin_oauth.json") -> Optional[Dict[str, Any]]:
        sess = self.primary.load_oauth_session(remote_path)
        if sess is None and self.backup:
            try:
                sess = self.backup.load_oauth_session(remote_path)
            except Exception:
                return None
        return sess

    def save_oauth_session(self, session_data: Union[Dict[str, Any], Any], remote_path: str = "garmin_archive/.session/garmin_oauth.json") -> None:
        self.primary.save_oauth_session(session_data, remote_path)
        if self.backup:
            try:
                self.backup.save_oauth_session(session_data, remote_path)
            except Exception as e:
                logger.warning(f"Backup save_oauth_session warning: {e}")

    def archive_activity(
        self,
        activity_id: str,
        start_time_iso: str,
        summary_json_bytes: Optional[bytes] = None,
        fit_bytes: Optional[bytes] = None,
        gpx_bytes: Optional[bytes] = None,
        base_dir: str = "garmin_archive",
    ) -> Dict[str, str]:
        res = self.primary.archive_activity(
            activity_id=activity_id,
            start_time_iso=start_time_iso,
            summary_json_bytes=summary_json_bytes,
            fit_bytes=fit_bytes,
            gpx_bytes=gpx_bytes,
            base_dir=base_dir,
        )
        if self.backup:
            try:
                self.backup.archive_activity(
                    activity_id=activity_id,
                    start_time_iso=start_time_iso,
                    summary_json_bytes=summary_json_bytes,
                    fit_bytes=fit_bytes,
                    gpx_bytes=gpx_bytes,
                    base_dir=base_dir,
                )
            except Exception as e:
                logger.warning(f"Backup archive_activity warning ({activity_id}): {e}")
        return res

    def scan_archive_inventory(self, base_dir: str = "garmin_archive") -> Dict[str, Any]:
        return self.primary.scan_archive_inventory(base_dir=base_dir)


def get_storage_client(force_mock: bool = False) -> SFTPClientProtocol:
    """
    Resolves the active storage client(s) based on environment configuration:
    - Supports PRIMARY_STORAGE=gdrive|sftp (defaults to gdrive if GDRIVE_CREDENTIALS_JSON is set).
    - Automatically pairs Google Drive + Hetzner SFTP in CompositeStorageClient when both are configured.
    """
    if force_mock or os.environ.get("FORCE_MOCK", "").lower() in ("true", "1", "yes"):
        return MockSFTPClient()

    gdrive_cfg = GDriveConfig.from_env()
    sftp_cfg = SFTPConfig.from_env()

    gdrive_client: Optional[SFTPClientProtocol] = None
    sftp_client: Optional[SFTPClientProtocol] = None

    if gdrive_cfg:
        try:
            gd = GoogleDriveStorageClient(gdrive_cfg)
            gd.connect()
            gdrive_client = gd
        except Exception as e:
            logger.warning(f"Could not initialize Google Drive storage ({e}).")

    if sftp_cfg:
        try:
            sf = HetznerSFTPClient(sftp_cfg)
            sf.connect()
            sftp_client = sf
        except Exception as e:
            logger.warning(f"Could not initialize Hetzner SFTP storage ({e}).")

    primary_pref = os.environ.get("PRIMARY_STORAGE", "gdrive").strip().lower()

    if gdrive_client and sftp_client:
        if primary_pref == "sftp":
            logger.info("Using Hetzner SFTP as primary storage and Google Drive as redundant backup.")
            return CompositeStorageClient(primary=sftp_client, backup=gdrive_client)
        logger.info("Using Google Drive as primary storage and Hetzner SFTP as redundant backup.")
        return CompositeStorageClient(primary=gdrive_client, backup=sftp_client)

    if gdrive_client:
        return gdrive_client
    if sftp_client:
        return sftp_client

    logger.info("Neither Google Drive nor Hetzner SFTP credentials configured; using MockSFTPClient.")
    return MockSFTPClient()
