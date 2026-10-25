"""
src/ingestion/sftp_client.py
Paramiko SFTP client with Hetzner Storage Box archival, atomic uploads, and in-memory mock.
"""

from __future__ import annotations

import io
import json
import logging
import os
import posixpath
import stat as stat_module
import time
import uuid
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional, Protocol, Tuple, Union, runtime_checkable

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Exceptions
# ---------------------------------------------------------------------------

class SFTPArchivalError(Exception):
    """Raised when SFTP connection, transfer, or verification fails."""
    pass


# ---------------------------------------------------------------------------
# Data Models & Config
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class SFTPFileStat:
    """Normalized file metadata returned by stat queries."""
    filename: str
    size_bytes: int
    mtime: int
    is_dir: bool

    @property
    def st_size(self) -> int:
        return self.size_bytes


@dataclass
class SFTPConfig:
    """Connection configuration for Hetzner Storage Box."""
    host: str
    port: int = 23
    user: str = ""
    ssh_key: str = ""
    key_passphrase: Optional[str] = None
    timeout: float = 30.0
    base_dir: str = "garmin_archive"

    @classmethod
    def from_env(cls) -> Optional[SFTPConfig]:
        host = os.environ.get("HETZNER_HOST", "").strip()
        user = os.environ.get("HETZNER_USER", "").strip()
        ssh_key = os.environ.get("HETZNER_SSH_KEY", "").strip()
        if not host or not user or not ssh_key:
            return None
        port = int(os.environ.get("HETZNER_PORT", "23"))
        key_passphrase = os.environ.get("HETZNER_KEY_PASSPHRASE", "").strip() or None
        return cls(
            host=host,
            port=port,
            user=user,
            ssh_key=ssh_key,
            key_passphrase=key_passphrase,
        )


# ---------------------------------------------------------------------------
# SSH Key Parser
# ---------------------------------------------------------------------------

def parse_private_key(key_input: str, passphrase: Optional[str] = None) -> Any:
    """
    Parses an SSH private key from either:
    1. A raw PEM/OpenSSH string containing the key
    2. A filesystem path pointing to a private key file

    Supports Ed25519, RSA, and ECDSA key types.
    Normalizes literal escaped newlines ('\\n' -> '\n').
    """
    import paramiko

    if not key_input or not key_input.strip():
        raise ValueError("SSH private key cannot be empty.")

    clean_input = key_input.strip()

    # Check if key_input is a path to an existing file
    potential_path = Path(clean_input)
    if potential_path.is_file():
        key_str = potential_path.read_text(encoding="utf-8").strip()
    else:
        # Normalize escaped newlines that frequently occur in GitHub Secrets
        if "\\n" in clean_input and "\n" not in clean_input:
            clean_input = clean_input.replace("\\n", "\n")
        key_str = clean_input

    if "PRIVATE KEY" not in key_str:
        raise ValueError("Invalid SSH key format: missing private key header.")

    key_classes = [
        paramiko.Ed25519Key,
        paramiko.RSAKey,
        paramiko.ECDSAKey,
    ]

    last_error: Optional[Exception] = None
    for key_cls in key_classes:
        key_stream = io.StringIO(key_str)
        try:
            return key_cls.from_private_key(key_stream, password=passphrase)
        except Exception as e:
            last_error = e
            continue

    raise ValueError(
        f"Failed to parse SSH private key as Ed25519, RSA, or ECDSA: {last_error}"
    ) from last_error


# ---------------------------------------------------------------------------
# SFTP Client Protocol
# ---------------------------------------------------------------------------

@runtime_checkable
class SFTPClientProtocol(Protocol):
    """Abstract interface contract for SFTP storage box interactions."""

    def connect(self) -> None:
        """Establishes the SFTP connection."""
        ...

    def disconnect(self) -> None:
        """Closes the SFTP connection and underlying transport."""
        ...

    def close(self) -> None:
        """Alias for disconnect."""
        ...

    def __enter__(self) -> "SFTPClientProtocol":
        ...

    def __exit__(self, exc_type: Any, exc_val: Any, exc_tb: Any) -> None:
        ...

    def mkdir_p(self, remote_dir: str) -> None:
        """Recursively creates remote directories if they do not exist."""
        ...

    def upload_file(self, local_path: Union[Path, str], remote_path: str, atomic: bool = True) -> bool:
        """Uploads a local file to the remote path. Verifies upload size."""
        ...

    def upload_file_verified(self, local_path: Union[Path, str], remote_path: str) -> None:
        """Uploads a local file and verifies exact byte size match."""
        ...

    def upload_bytes(self, data: bytes, remote_path: str, atomic: bool = True) -> bool:
        """Uploads raw bytes directly to the remote path. Verifies upload size."""
        ...

    def put_bytes(self, remote_path: str, data: bytes) -> None:
        """Alias / direct byte write."""
        ...

    def download_file(self, remote_path: str, local_path: Union[Path, str]) -> None:
        """Downloads a remote file to a local destination."""
        ...

    def download_bytes(self, remote_path: str) -> bytes:
        """Downloads a remote file directly into memory as bytes."""
        ...

    def get_bytes(self, remote_path: str) -> bytes:
        """Alias for download_bytes."""
        ...

    def read_text(self, remote_path: str) -> Optional[str]:
        """Reads a remote UTF-8 text file."""
        ...

    def write_text_atomic(self, remote_path: str, content: str) -> None:
        """Atomically writes UTF-8 text to a remote path."""
        ...

    def put_file(self, local_path: Union[Path, str], remote_path: str) -> None:
        """Uploads local file (atomic)."""
        ...

    def get_file(self, remote_path: str, local_path: Union[Path, str]) -> None:
        """Downloads remote file."""
        ...

    def file_exists(self, remote_path: str) -> bool:
        """Returns True if the remote path exists and is a file."""
        ...

    def stat(self, remote_path: str) -> SFTPFileStat:
        """Returns metadata for the remote path."""
        ...

    def listdir(self, remote_dir: str) -> List[str]:
        """Lists entries in a remote directory."""
        ...

    def remove(self, remote_path: str) -> None:
        """Removes a remote file."""
        ...

    def rename(self, old_path: str, new_path: str) -> None:
        """Renames or moves a remote file."""
        ...

    def load_oauth_session(self, remote_path: str = "garmin_archive/.session/garmin_oauth.json") -> Optional[Dict[str, Any]]:
        """Loads and parses the OAuth token session JSON from remote storage."""
        ...

    def save_oauth_session(self, session_data: Union[Dict[str, Any], Any], remote_path: str = "garmin_archive/.session/garmin_oauth.json") -> None:
        """Atomically saves the OAuth token session JSON to remote storage."""
        ...

    def archive_activity(
        self,
        activity_id: str,
        start_time_iso: str,
        summary_json_bytes: Optional[bytes] = None,
        fit_bytes: Optional[bytes] = None,
        base_dir: str = "garmin_archive",
    ) -> Dict[str, str]:
        """Archives raw activity summary and FIT file into partitioned YYYY/MM directory."""
        ...


# ---------------------------------------------------------------------------
# Hetzner SFTP Client Implementation
# ---------------------------------------------------------------------------

class HetznerSFTPClient:
    """
    Paramiko-based SFTP client for Hetzner Storage Box.
    Supports port fallback (23 -> 22), atomic uploads with stat verification,
    and recursive directory creation.
    """

    def __init__(
        self,
        host_or_config: Union[str, SFTPConfig],
        user: str = "",
        ssh_key: str = "",
        port: int = 23,
        key_passphrase: Optional[str] = None,
        timeout: float = 30.0,
        base_dir: str = "garmin_archive",
    ):
        if isinstance(host_or_config, SFTPConfig):
            self.config = host_or_config
        else:
            if not host_or_config or not user or not ssh_key:
                raise ValueError("HETZNER_HOST, HETZNER_USER, and HETZNER_SSH_KEY are required.")
            if "PRIVATE KEY" not in ssh_key:
                raise ValueError("Invalid SSH key format: missing private key header.")
            self.config = SFTPConfig(
                host=host_or_config,
                port=port,
                user=user,
                ssh_key=ssh_key,
                key_passphrase=key_passphrase,
                timeout=timeout,
                base_dir=base_dir,
            )

        self._ssh_client: Optional[Any] = None
        self._sftp: Optional[Any] = None
        self.connected: bool = False

    @classmethod
    def from_env(cls) -> HetznerSFTPClient:
        cfg = SFTPConfig.from_env()
        if not cfg:
            raise ValueError("Missing Hetzner SFTP credentials in environment variables.")
        return cls(cfg)

    def connect(self) -> None:
        """Connect to Hetzner Storage Box with configurable port (default 23, fallback 22)."""
        import paramiko

        if self.connected and self._sftp:
            return

        pkey = parse_private_key(self.config.ssh_key, self.config.key_passphrase)

        ports_to_try = [self.config.port]
        if self.config.port == 23:
            ports_to_try.append(22)
        elif self.config.port == 22:
            ports_to_try.append(23)

        last_exc: Optional[Exception] = None
        for port in ports_to_try:
            try:
                ssh = paramiko.SSHClient()
                ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
                logger.info(f"Connecting to Hetzner Storage Box {self.config.host}:{port} as {self.config.user}...")
                ssh.connect(
                    hostname=self.config.host,
                    port=port,
                    username=self.config.user,
                    pkey=pkey,
                    timeout=self.config.timeout,
                    banner_timeout=self.config.timeout,
                    auth_timeout=self.config.timeout,
                    allow_agent=False,
                    look_for_keys=False,
                )
                self._ssh_client = ssh
                self._sftp = ssh.open_sftp()
                self.connected = True
                logger.info(f"Connected successfully to Hetzner Storage Box on port {port}.")
                return
            except Exception as e:
                logger.warning(f"Failed to connect to Hetzner SFTP on port {port}: {e}")
                last_exc = e
                if self._ssh_client:
                    try:
                        self._ssh_client.close()
                    except Exception:
                        pass
                    self._ssh_client = None

        raise SFTPArchivalError(f"Could not connect to Hetzner Storage Box {self.config.host}: {last_exc}") from last_exc

    def disconnect(self) -> None:
        self.close()

    def close(self) -> None:
        if self._sftp:
            try:
                self._sftp.close()
            except Exception:
                pass
            self._sftp = None
        if self._ssh_client:
            try:
                self._ssh_client.close()
            except Exception:
                pass
            self._ssh_client = None
        self.connected = False

    def __enter__(self) -> HetznerSFTPClient:
        self.connect()
        return self

    def __exit__(self, exc_type: Any, exc_val: Any, exc_tb: Any) -> None:
        self.disconnect()

    def _ensure_connected(self) -> Any:
        if not self.connected or not self._sftp:
            self.connect()
        return self._sftp

    def _normalize(self, path: str) -> str:
        return path.replace("\\", "/").strip("/")

    def mkdir_p(self, remote_dir: str) -> None:
        """Recursively creates remote directories, equivalent to 'mkdir -p'."""
        sftp = self._ensure_connected()
        normalized = self._normalize(remote_dir)
        if not normalized:
            return

        parts = [p for p in normalized.split("/") if p]
        current_path = ""
        for part in parts:
            current_path = f"{current_path}/{part}" if current_path else part
            try:
                sftp.stat(current_path)
            except (IOError, FileNotFoundError):
                try:
                    sftp.mkdir(current_path)
                except IOError:
                    # Directory may have been created concurrently
                    pass

    def file_exists(self, remote_path: str) -> bool:
        sftp = self._ensure_connected()
        norm = self._normalize(remote_path)
        try:
            stat_res = sftp.stat(norm)
            return not stat_module.S_ISDIR(stat_res.st_mode)
        except (IOError, FileNotFoundError):
            return False

    def stat(self, remote_path: str) -> SFTPFileStat:
        sftp = self._ensure_connected()
        norm = self._normalize(remote_path)
        try:
            res = sftp.stat(norm)
            return SFTPFileStat(
                filename=posixpath.basename(norm),
                size_bytes=res.st_size,
                mtime=res.st_mtime or int(time.time()),
                is_dir=stat_module.S_ISDIR(res.st_mode),
            )
        except Exception as e:
            raise FileNotFoundError(f"Remote path not found: {remote_path}") from e

    def listdir(self, remote_dir: str) -> List[str]:
        sftp = self._ensure_connected()
        norm = self._normalize(remote_dir)
        try:
            return sftp.listdir(norm)
        except Exception as e:
            raise IOError(f"Failed to list remote directory {remote_dir}: {e}") from e

    def remove(self, remote_path: str) -> None:
        sftp = self._ensure_connected()
        norm = self._normalize(remote_path)
        try:
            sftp.remove(norm)
        except (IOError, FileNotFoundError):
            pass

    def rename(self, old_path: str, new_path: str) -> None:
        sftp = self._ensure_connected()
        old_norm = self._normalize(old_path)
        new_norm = self._normalize(new_path)
        # Pre-emptively remove destination if exists for OpenSSH compatibility
        try:
            sftp.remove(new_norm)
        except (IOError, FileNotFoundError):
            pass
        sftp.rename(old_norm, new_norm)

    def upload_file(self, local_path: Union[Path, str], remote_path: str, atomic: bool = True) -> bool:
        """Uploads local file to remote_path with atomic rename and size verification."""
        local = Path(local_path)
        if not local.is_file():
            raise FileNotFoundError(f"Local file not found: {local_path}")
        with open(local, "rb") as f:
            data = f.read()
        return self.upload_bytes(data, remote_path, atomic=atomic)

    def upload_file_verified(self, local_path: Union[Path, str], remote_path: str) -> None:
        self.upload_file(local_path, remote_path, atomic=True)

    def upload_bytes(self, data: bytes, remote_path: str, atomic: bool = True) -> bool:
        """Uploads raw bytes to remote_path with atomic rename and size verification."""
        sftp = self._ensure_connected()
        norm = self._normalize(remote_path)
        parent = posixpath.dirname(norm)
        if parent:
            self.mkdir_p(parent)

        expected_size = len(data)

        if not atomic:
            with sftp.file(norm, "wb") as f:
                f.write(data)
            stat_res = sftp.stat(norm)
            if stat_res.st_size != expected_size:
                raise IOError(f"SFTP upload verification failed for {remote_path}: size mismatch")
            return True

        tmp_path = f"{norm}.tmp.{uuid.uuid4().hex[:8]}"
        try:
            with sftp.file(tmp_path, "wb") as f:
                f.write(data)

            stat_res = sftp.stat(tmp_path)
            if stat_res.st_size != expected_size:
                try:
                    sftp.remove(tmp_path)
                except Exception:
                    pass
                raise IOError(
                    f"SFTP upload size mismatch verification failed for {remote_path}: "
                    f"expected {expected_size} bytes, got {stat_res.st_size}"
                )

            # Atomically replace destination
            try:
                sftp.remove(norm)
            except (IOError, FileNotFoundError):
                pass
            sftp.rename(tmp_path, norm)
            return True
        except Exception:
            try:
                sftp.remove(tmp_path)
            except Exception:
                pass
            raise

    def put_bytes(self, remote_path: str, data: bytes) -> None:
        self.upload_bytes(data, remote_path, atomic=True)

    def put_file(self, local_path: Union[Path, str], remote_path: str) -> None:
        self.upload_file(local_path, remote_path, atomic=True)

    def download_bytes(self, remote_path: str) -> bytes:
        sftp = self._ensure_connected()
        norm = self._normalize(remote_path)
        try:
            with sftp.file(norm, "rb") as f:
                return f.read()
        except Exception as e:
            raise FileNotFoundError(f"Remote file not found: {remote_path}") from e

    def get_bytes(self, remote_path: str) -> bytes:
        return self.download_bytes(remote_path)

    def download_file(self, remote_path: str, local_path: Union[Path, str]) -> None:
        data = self.download_bytes(remote_path)
        local = Path(local_path)
        local.parent.mkdir(parents=True, exist_ok=True)
        with open(local, "wb") as f:
            f.write(data)

    def get_file(self, remote_path: str, local_path: Union[Path, str]) -> None:
        self.download_file(remote_path, local_path)

    def read_text(self, remote_path: str) -> Optional[str]:
        try:
            raw = self.download_bytes(remote_path)
            return raw.decode("utf-8")
        except (FileNotFoundError, IOError):
            return None

    def write_text_atomic(self, remote_path: str, content: str) -> None:
        self.upload_bytes(content.encode("utf-8"), remote_path, atomic=True)

    def load_oauth_session(self, remote_path: str = "garmin_archive/.session/garmin_oauth.json") -> Optional[Dict[str, Any]]:
        text = self.read_text(remote_path)
        if not text:
            return None
        try:
            return json.loads(text)
        except Exception as e:
            logger.warning(f"Corrupted OAuth session JSON on SFTP: {e}")
            return None

    def save_oauth_session(self, session_data: Union[Dict[str, Any], Any], remote_path: str = "garmin_archive/.session/garmin_oauth.json") -> None:
        if hasattr(session_data, "model_dump_json"):
            json_str = session_data.model_dump_json(indent=2)
        elif hasattr(session_data, "to_json"):
            json_str = session_data.to_json()
        elif isinstance(session_data, dict):
            json_str = json.dumps(session_data, indent=2)
        else:
            json_str = json.dumps(dict(session_data), indent=2)

        self.write_text_atomic(remote_path, json_str)
        logger.info(f"Persisted OAuth session state to SFTP: {remote_path}")

    def archive_activity(
        self,
        activity_id: str,
        start_time_iso: str,
        summary_json_bytes: Optional[bytes] = None,
        fit_bytes: Optional[bytes] = None,
        base_dir: str = "garmin_archive",
    ) -> Dict[str, str]:
        try:
            dt = datetime.fromisoformat(start_time_iso.replace("Z", "+00:00"))
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

        return results


# ---------------------------------------------------------------------------
# In-Memory Mock SFTP Client Implementation
# ---------------------------------------------------------------------------

class MockSFTPClient:
    """
    In-memory mock SFTP client implementing SFTPClientProtocol.
    Used for local testing and offline execution.
    """

    def __init__(
        self,
        host_or_config: Union[str, SFTPConfig] = "",
        user: str = "",
        ssh_key: str = "",
        port: int = 23,
        base_dir: str = "garmin_archive",
        **kwargs: Any,
    ):
        self.base_dir = base_dir.rstrip("/")
        self.files: Dict[str, bytes] = {}
        self.dirs: set[str] = {
            self.base_dir,
            f"{self.base_dir}/.session",
            f"{self.base_dir}/metadata",
            f"{self.base_dir}/activities",
        }
        self.connected: bool = True
        self._fault_hooks: Dict[str, Exception] = {}

    def connect(self) -> None:
        self.connected = True

    def disconnect(self) -> None:
        self.connected = False

    def close(self) -> None:
        self.connected = False

    def __enter__(self) -> MockSFTPClient:
        self.connect()
        return self

    def __exit__(self, exc_type: Any, exc_val: Any, exc_tb: Any) -> None:
        self.disconnect()

    def _check_connected(self) -> None:
        if not self.connected:
            raise IOError("SFTP connection is closed.")

    def _normalize(self, path: str) -> str:
        return posixpath.normpath(path.replace("\\", "/")).lstrip("/")

    def mkdir_p(self, remote_dir: str) -> None:
        self._check_connected()
        norm = self._normalize(remote_dir)
        if not norm or norm == ".":
            return
        parts = norm.split("/")
        curr = ""
        for p in parts:
            curr = f"{curr}/{p}" if curr else p
            self.dirs.add(curr)

    def file_exists(self, remote_path: str) -> bool:
        self._check_connected()
        norm = self._normalize(remote_path)
        return norm in self.files

    def stat(self, remote_path: str) -> SFTPFileStat:
        self._check_connected()
        norm = self._normalize(remote_path)
        if norm in self.files:
            return SFTPFileStat(
                filename=posixpath.basename(norm),
                size_bytes=len(self.files[norm]),
                mtime=int(time.time()),
                is_dir=False,
            )
        if norm in self.dirs:
            return SFTPFileStat(
                filename=posixpath.basename(norm),
                size_bytes=0,
                mtime=int(time.time()),
                is_dir=True,
            )
        raise FileNotFoundError(f"Remote path not found: {remote_path}")

    def listdir(self, remote_dir: str) -> List[str]:
        self._check_connected()
        norm = self._normalize(remote_dir)
        prefix = f"{norm}/" if norm and norm != "." else ""
        results = set()
        for p in list(self.files.keys()) + list(self.dirs):
            if prefix and p.startswith(prefix):
                rel = p[len(prefix):]
                top = rel.split("/")[0]
                if top:
                    results.add(top)
            elif not prefix:
                top = p.split("/")[0]
                if top:
                    results.add(top)
        return sorted(list(results))

    def remove(self, remote_path: str) -> None:
        self._check_connected()
        norm = self._normalize(remote_path)
        self.files.pop(norm, None)

    def rename(self, old_path: str, new_path: str) -> None:
        self._check_connected()
        old_norm = self._normalize(old_path)
        new_norm = self._normalize(new_path)
        if old_norm not in self.files:
            raise FileNotFoundError(f"Source file not found: {old_path}")
        parent = posixpath.dirname(new_norm)
        if parent:
            self.mkdir_p(parent)
        self.files[new_norm] = self.files.pop(old_norm)

    def upload_bytes(self, data: bytes, remote_path: str, atomic: bool = True) -> bool:
        self._check_connected()
        if "upload" in self._fault_hooks:
            raise self._fault_hooks["upload"]
        norm = self._normalize(remote_path)
        parent = posixpath.dirname(norm)
        if parent:
            self.mkdir_p(parent)

        if atomic:
            tmp_path = f"{norm}.tmp.{uuid.uuid4().hex[:8]}"
            self.files[tmp_path] = bytes(data)
            if len(self.files[tmp_path]) != len(data):
                self.files.pop(tmp_path, None)
                raise IOError(f"SFTP upload verification failed for {remote_path}: size mismatch")
            self.files[norm] = self.files.pop(tmp_path)
        else:
            self.files[norm] = bytes(data)
        return True

    def put_bytes(self, remote_path: str, data: bytes) -> None:
        norm = self._normalize(remote_path)
        parent = posixpath.dirname(norm)
        if parent:
            self.mkdir_p(parent)
        self.files[norm] = bytes(data)

    def upload_file(self, local_path: Union[Path, str], remote_path: str, atomic: bool = True) -> bool:
        with open(local_path, "rb") as f:
            data = f.read()
        return self.upload_bytes(data, remote_path, atomic=atomic)

    def upload_file_verified(self, local_path: Union[Path, str], remote_path: str) -> None:
        with open(local_path, "rb") as f:
            data = f.read()
        norm = self._normalize(remote_path)
        parent = posixpath.dirname(norm)
        if parent:
            self.mkdir_p(parent)
        # If remote_filesystem already recorded different bytes, verify
        if norm in self.files and len(self.files[norm]) != len(data):
            raise IOError(f"SFTP upload verification failed for {remote_path}: size mismatch")
        self.files[norm] = data
        if len(self.files[norm]) != os.path.getsize(local_path):
            raise IOError(f"SFTP upload verification failed for {remote_path}: size mismatch")

    def put_file(self, local_path: Union[Path, str], remote_path: str) -> None:
        self.upload_file(local_path, remote_path, atomic=True)

    def download_bytes(self, remote_path: str) -> bytes:
        self._check_connected()
        norm = self._normalize(remote_path)
        if norm not in self.files:
            raise FileNotFoundError(f"Remote file not found: {remote_path}")
        return self.files[norm]

    def get_bytes(self, remote_path: str) -> bytes:
        return self.download_bytes(remote_path)

    def download_file(self, remote_path: str, local_path: Union[Path, str]) -> None:
        data = self.download_bytes(remote_path)
        local = Path(local_path)
        local.parent.mkdir(parents=True, exist_ok=True)
        with open(local, "wb") as f:
            f.write(data)

    def get_file(self, remote_path: str, local_path: Union[Path, str]) -> None:
        self.download_file(remote_path, local_path)

    def read_text(self, remote_path: str) -> Optional[str]:
        try:
            return self.download_bytes(remote_path).decode("utf-8")
        except FileNotFoundError:
            return None

    def write_text_atomic(self, remote_path: str, content: str) -> None:
        self.upload_bytes(content.encode("utf-8"), remote_path, atomic=True)

    def load_oauth_session(self, remote_path: str = "garmin_archive/.session/garmin_oauth.json") -> Optional[Dict[str, Any]]:
        text = self.read_text(remote_path)
        if not text:
            return None
        try:
            return json.loads(text)
        except Exception:
            return None

    def save_oauth_session(self, session_data: Union[Dict[str, Any], Any], remote_path: str = "garmin_archive/.session/garmin_oauth.json") -> None:
        if hasattr(session_data, "model_dump_json"):
            json_str = session_data.model_dump_json(indent=2)
        elif hasattr(session_data, "to_json"):
            json_str = session_data.to_json()
        elif isinstance(session_data, dict):
            json_str = json.dumps(session_data, indent=2)
        else:
            json_str = json.dumps(dict(session_data), indent=2)
        self.write_text_atomic(remote_path, json_str)

    def archive_activity(
        self,
        activity_id: str,
        start_time_iso: str,
        summary_json_bytes: Optional[bytes] = None,
        fit_bytes: Optional[bytes] = None,
        base_dir: str = "garmin_archive",
    ) -> Dict[str, str]:
        from datetime import datetime
        try:
            dt = datetime.fromisoformat(start_time_iso.replace("Z", "+00:00"))
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

        return results


# ---------------------------------------------------------------------------
# Factory
# ---------------------------------------------------------------------------

def get_sftp_client(force_mock: bool = False, config: Optional[SFTPConfig] = None) -> SFTPClientProtocol:
    """
    Returns an SFTPClientProtocol instance.
    If force_mock is True, or if HETZNER_HOST/HETZNER_SSH_KEY are missing from environment,
    returns an instance of MockSFTPClient.
    """
    if force_mock or os.environ.get("FORCE_MOCK", "").lower() in ("true", "1", "yes"):
        logger.info("Using MockSFTPClient (mock mode requested)")
        return MockSFTPClient()

    resolved_config = config or SFTPConfig.from_env()
    if not resolved_config:
        logger.info("Hetzner SFTP credentials not found in environment; falling back to MockSFTPClient.")
        return MockSFTPClient()

    try:
        client = HetznerSFTPClient(resolved_config)
        client.connect()
        return client
    except Exception as e:
        logger.warning(f"Could not connect live Hetzner SFTP ({e}); falling back to MockSFTPClient.")
        return MockSFTPClient()
