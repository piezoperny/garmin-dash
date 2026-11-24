"""
tests/test_opt_m1_storage_vault.py
Unit tests for Milestone M1 (Storage & Parquet Vault Hardening):
- gdrive_client.py: resumable 5MB uploads, num_retries=3, nextPageToken pagination,
  bounded backoff on 429/403 rateLimitExceeded/5xx, CompositeStorageClient error propagation,
  and get_storage_client no-silent-mock-fallback.
- sftp_client.py: HETZNER_HOST_KEY pinning (RejectPolicy vs AutoAddPolicy), posix_rename
  with EOPNOTSUPP fallback, keepalive(30) + transport.is_active() + reconnect-once on
  EOFError/SSHException, and get_sftp_client no-silent-mock-fallback.
- parquet_vault.py: wellness vo2_max/training_readiness mapping, typed activity columns,
  DuckDB connection reuse & bulk insert, incremental RawZipArchive.append_files,
  and VaultManifest SHA-256 content hash tracking & skip-unchanged uploads.
- cleanup.py: 1 MB chunked secure zero-fill and expanded PROHIBITED_PATTERNS.
"""

from __future__ import annotations

import base64
import errno
import io
import json
import os
import tempfile
import unittest
import urllib.error
import zipfile
from pathlib import Path
from unittest.mock import MagicMock, patch

import duckdb
import paramiko

from src.ingestion.cleanup import PROHIBITED_PATTERNS, purge_file, verify_clean_workspace
from src.ingestion.gdrive_client import (
    CompositeStorageClient,
    GDriveConfig,
    GoogleDriveStorageClient,
    StorageWriteError,
    _execute_with_backoff,
    get_storage_client,
)
from src.ingestion.sftp_client import (
    HetznerSFTPClient,
    MockSFTPClient,
    SFTPArchivalError,
    SFTPConfig,
    get_sftp_client,
)
from src.storage.parquet_vault import (
    ParquetVault,
    RawZipArchive,
    VaultManifest,
    compute_file_sha256,
)


class _MockHttpError(Exception):
    def __init__(self, status: int, message: str = "error", content: bytes = b"") -> None:
        super().__init__(message)
        self.resp = MagicMock(status=status)
        self.content = content


class TestGDriveHardening(unittest.TestCase):
    def test_resumable_upload_5mb_and_num_retries(self):
        cfg = GDriveConfig(credentials_json="{}")
        client = GoogleDriveStorageClient(cfg)
        mock_service = MagicMock()
        client._service = mock_service
        client._root_folder_id = "root_id"
        client._folder_cache[""] = "root_id"

        # _find_child returns no existing file
        mock_service.files.return_value.list.return_value.execute.return_value = {"files": []}
        mock_service.files.return_value.create.return_value.execute.return_value = {"id": "file_123"}

        with patch("googleapiclient.http.MediaIoBaseUpload") as mock_media_cls:
            ok = client.upload_bytes(b"hello world", "test.bin")
            self.assertTrue(ok)
            mock_media_cls.assert_called_once()
            _, kwargs = mock_media_cls.call_args
            self.assertTrue(kwargs["resumable"])
            self.assertEqual(kwargs["chunksize"], 5 * 1024 * 1024)

        mock_service.files.return_value.list.return_value.execute.assert_called_with(num_retries=3)
        mock_service.files.return_value.create.return_value.execute.assert_called_with(num_retries=3)

    def test_listdir_paginates_next_page_token(self):
        cfg = GDriveConfig(credentials_json="{}")
        client = GoogleDriveStorageClient(cfg)
        mock_service = MagicMock()
        client._service = mock_service
        client._root_folder_id = "root_id"
        client._folder_cache[""] = "root_id"

        mock_service.files.return_value.list.return_value.execute.side_effect = [
            {"files": [{"name": "a.json"}, {"name": "b.json"}], "nextPageToken": "tok_2"},
            {"files": [{"name": "c.json"}], "nextPageToken": None},
        ]

        items = client.listdir("")
        self.assertEqual(items, ["a.json", "b.json", "c.json"])
        self.assertEqual(mock_service.files.return_value.list.call_count, 2)
        second_call_kwargs = mock_service.files.return_value.list.call_args_list[1].kwargs
        self.assertEqual(second_call_kwargs.get("pageToken"), "tok_2")
        self.assertIn("nextPageToken", second_call_kwargs.get("fields", ""))

    def test_backoff_retries_429_403_ratelimit_and_5xx(self):
        for exc in (
            _MockHttpError(429, "Too Many Requests"),
            _MockHttpError(403, "Forbidden", b'{"error":"rateLimitExceeded"}'),
            _MockHttpError(503, "Service Unavailable"),
        ):
            attempts = {"n": 0}

            def _fn(e=exc):
                attempts["n"] += 1
                if attempts["n"] < 3:
                    raise e
                return "ok"

            with patch("src.ingestion.gdrive_client.time.sleep") as mock_sleep:
                self.assertEqual(_execute_with_backoff(_fn, max_attempts=3, base_delay=0.1), "ok")
                self.assertEqual(attempts["n"], 3)
                self.assertEqual(mock_sleep.call_count, 2)

        # Non-rate-limit 403 must not retry
        attempts_perm = {"n": 0}

        def _perm_denied():
            attempts_perm["n"] += 1
            raise _MockHttpError(403, "Permission Denied", b'{"error":"forbidden"}')

        with patch("src.ingestion.gdrive_client.time.sleep") as mock_sleep:
            with self.assertRaises(_MockHttpError):
                _execute_with_backoff(_perm_denied, max_attempts=3, base_delay=0.1)
            self.assertEqual(attempts_perm["n"], 1)
            mock_sleep.assert_not_called()

    def test_webapp_request_backoff_on_http_429(self):
        cfg = GDriveConfig(credentials_json="https://script.google.com/macros/s/abc/exec")
        client = GoogleDriveStorageClient(cfg)
        client._webapp_url = cfg.credentials_json

        http_429 = urllib.error.HTTPError(
            cfg.credentials_json, 429, "Too Many Requests", hdrs=None, fp=io.BytesIO(b"")
        )
        ok_resp = MagicMock()
        ok_resp.__enter__.return_value.read.return_value = json.dumps({"ok": True, "exists": True}).encode("utf-8")

        with patch("urllib.request.urlopen", side_effect=[http_429, ok_resp]) as mock_open, patch(
            "src.ingestion.gdrive_client.time.sleep"
        ) as mock_sleep:
            res = client._webapp_request("exists", "a.txt")
            self.assertTrue(res["exists"])
            self.assertEqual(mock_open.call_count, 2)
            mock_sleep.assert_called_once()

    def test_composite_raises_when_both_primary_and_backup_fail(self):
        primary = MagicMock()
        backup = MagicMock()
        primary.write_text_atomic.side_effect = IOError("primary down")
        backup.write_text_atomic.side_effect = IOError("backup down")
        primary.upload_file.side_effect = IOError("primary down")
        backup.upload_file.side_effect = IOError("backup down")

        comp = CompositeStorageClient(primary=primary, backup=backup)
        with self.assertRaises(StorageWriteError):
            comp.write_text_atomic("a/b.json", "{}")
        with self.assertRaises(StorageWriteError):
            comp.put_file("local.bin", "a/b.bin")

        # If backup succeeds, composite succeeds
        backup.write_text_atomic.side_effect = None
        comp.write_text_atomic("a/b.json", "{}")

    def test_get_storage_client_no_silent_mock_fallback_when_configured(self):
        # Unconfigured env -> MockSFTPClient
        clean_env = {
            k: v
            for k, v in os.environ.items()
            if k not in ("GDRIVE_CREDENTIALS_JSON", "HETZNER_HOST", "HETZNER_USER", "HETZNER_SSH_KEY", "FORCE_MOCK")
        }
        with patch.dict(os.environ, clean_env, clear=True):
            self.assertIsInstance(get_storage_client(force_mock=False), MockSFTPClient)

        # force_mock=True -> MockSFTPClient even when env vars set
        with patch.dict(os.environ, {"GDRIVE_CREDENTIALS_JSON": "{bad}"}, clear=False):
            self.assertIsInstance(get_storage_client(force_mock=True), MockSFTPClient)

        # Configured GDRIVE_CREDENTIALS_JSON that fails -> RuntimeError
        with patch.dict(os.environ, {**clean_env, "GDRIVE_CREDENTIALS_JSON": "{invalid_json"}, clear=True):
            with self.assertRaises(RuntimeError):
                get_storage_client(force_mock=False)

        # Configured HETZNER_HOST with missing user/key -> RuntimeError
        with patch.dict(os.environ, {**clean_env, "HETZNER_HOST": "u123.your-storagebox.de"}, clear=True):
            with self.assertRaises(RuntimeError):
                get_storage_client(force_mock=False)


class TestSFTPHardening(unittest.TestCase):
    def _dummy_rsa_pair(self):
        key = paramiko.RSAKey.generate(2048)
        buf = io.StringIO()
        key.write_private_key(buf)
        priv_pem = buf.getvalue()
        pub_b64 = base64.b64encode(key.asbytes()).decode("ascii")
        return priv_pem, f"ssh-rsa {pub_b64}"

    def test_host_key_pinning_reject_vs_autoadd(self):
        priv_pem, host_key_line = self._dummy_rsa_pair()

        with patch("paramiko.SSHClient") as mock_ssh_cls:
            mock_ssh = MagicMock()
            mock_transport = MagicMock()
            mock_transport.is_active.return_value = True
            mock_ssh.get_transport.return_value = mock_transport
            mock_ssh_cls.return_value = mock_ssh

            cfg_pinned = SFTPConfig(
                host="box.example.com",
                port=23,
                user="u1",
                ssh_key=priv_pem,
                host_key=host_key_line,
            )
            client = HetznerSFTPClient(cfg_pinned)
            client.connect()
            policy_arg = mock_ssh.set_missing_host_key_policy.call_args.args[0]
            self.assertIsInstance(policy_arg, paramiko.RejectPolicy)
            mock_ssh.get_host_keys.return_value.add.assert_any_call(
                "box.example.com", "ssh-rsa", unittest.mock.ANY
            )
            mock_ssh.get_host_keys.return_value.add.assert_any_call(
                "[box.example.com]:23", "ssh-rsa", unittest.mock.ANY
            )
            mock_transport.set_keepalive.assert_called_with(30)

        # Unset HETZNER_HOST_KEY -> AutoAddPolicy with warning
        with patch.dict(os.environ, {"HETZNER_HOST_KEY": ""}, clear=False), patch(
            "paramiko.SSHClient"
        ) as mock_ssh_cls:
            mock_ssh = MagicMock()
            mock_transport = MagicMock()
            mock_transport.is_active.return_value = True
            mock_ssh.get_transport.return_value = mock_transport
            mock_ssh_cls.return_value = mock_ssh

            cfg_unpinned = SFTPConfig(host="box.example.com", port=23, user="u1", ssh_key=priv_pem)
            with self.assertLogs("src.ingestion.sftp_client", level="WARNING") as cm:
                HetznerSFTPClient(cfg_unpinned).connect()
            self.assertTrue(any("HETZNER_HOST_KEY" in msg for msg in cm.output))
            policy_arg = mock_ssh.set_missing_host_key_policy.call_args.args[0]
            self.assertIsInstance(policy_arg, paramiko.AutoAddPolicy)

    def test_posix_rename_and_eopnotsupp_fallback(self):
        priv_pem, _ = self._dummy_rsa_pair()
        client = HetznerSFTPClient(SFTPConfig(host="box.example.com", user="u1", ssh_key=priv_pem))
        mock_sftp = MagicMock()
        mock_transport = MagicMock()
        mock_transport.is_active.return_value = True
        mock_ssh = MagicMock()
        mock_ssh.get_transport.return_value = mock_transport

        client._ssh_client = mock_ssh
        client._sftp = mock_sftp
        client.connected = True

        # posix_rename succeeds -> remove/rename not called
        client.rename("a.tmp", "a.bin")
        mock_sftp.posix_rename.assert_called_once_with("a.tmp", "a.bin")
        mock_sftp.remove.assert_not_called()
        mock_sftp.rename.assert_not_called()

        # posix_rename raises EOPNOTSUPP -> falls back to remove + rename
        mock_sftp.reset_mock()
        err = OSError(errno.EOPNOTSUPP, "Operation not supported")
        mock_sftp.posix_rename.side_effect = err
        client.rename("b.tmp", "b.bin")
        mock_sftp.remove.assert_called_once_with("b.bin")
        mock_sftp.rename.assert_called_once_with("b.tmp", "b.bin")

    def test_ensure_connected_and_reconnect_once_on_eof(self):
        priv_pem, _ = self._dummy_rsa_pair()
        client = HetznerSFTPClient(SFTPConfig(host="box.example.com", user="u1", ssh_key=priv_pem))

        mock_sftp_1 = MagicMock()
        mock_sftp_1.listdir.side_effect = EOFError("connection reset")
        mock_sftp_2 = MagicMock()
        mock_sftp_2.listdir.return_value = ["file1.txt"]

        mock_transport = MagicMock()
        mock_transport.is_active.return_value = True
        mock_ssh = MagicMock()
        mock_ssh.get_transport.return_value = mock_transport

        client._ssh_client = mock_ssh
        client._sftp = mock_sftp_1
        client.connected = True

        def _fake_connect():
            client._ssh_client = mock_ssh
            client._sftp = mock_sftp_2
            client.connected = True

        with patch.object(client, "connect", side_effect=_fake_connect) as mock_conn:
            res = client.listdir("garmin_archive")
            self.assertEqual(res, ["file1.txt"])
            mock_conn.assert_called_once()

    def test_get_sftp_client_no_silent_mock_fallback(self):
        priv_pem, _ = self._dummy_rsa_pair()
        cfg = SFTPConfig(host="unreachable.invalid", port=23, user="u1", ssh_key=priv_pem)
        with patch.object(HetznerSFTPClient, "connect", side_effect=SFTPArchivalError("timeout")):
            with self.assertRaises(RuntimeError):
                get_sftp_client(force_mock=False, config=cfg)
        self.assertIsInstance(get_sftp_client(force_mock=True, config=cfg), MockSFTPClient)


class TestParquetVaultHardening(unittest.TestCase):
    def test_wellness_vo2max_training_readiness_and_activity_typed_columns(self):
        with tempfile.TemporaryDirectory() as tmp:
            vault = ParquetVault(work_dir=Path(tmp))
            with vault:
                vault.save_wellness(
                    [
                        {
                            "date": "2026-10-01",
                            "vo2max_running": 56.2,
                            "training_readiness_score": 78,
                        },
                        {
                            "date": "2026-10-02",
                            "vo2max_cycling": 58.0,
                            "training_readiness_score": 0,
                        },
                    ],
                    push_remote=False,
                )
                con = duckdb.connect(database=":memory:")
                rows = con.execute(
                    f"SELECT date, vo2_max, training_readiness FROM read_parquet('{vault.local_wellness_path}') ORDER BY date"
                ).fetchall()
                con.close()
                self.assertEqual(rows[0], ("2026-10-01", 56.2, 78.0))
                self.assertEqual(rows[1], ("2026-10-02", 58.0, 0.0))

                vault.save_activities(
                    [
                        {
                            "id": "a1",
                            "start_time": "2026-10-01T07:00:00Z",
                            "sport": "running",
                            "tss": 84.5,
                            "avg_cadence": 176.0,
                            "avg_pace_sec_km": 275.0,
                            "raw_activity_type": "trail_running",
                        }
                    ],
                    push_remote=False,
                )
                sql_rows = vault.query_activities_sql(
                    "SELECT id, tss, avg_cadence, avg_pace_sec_km, raw_activity_type FROM activities"
                )
                self.assertEqual(sql_rows, [("a1", 84.5, 176.0, 275.0, "trail_running")])

    def test_incremental_raw_zip_append_and_manifest_sha256_skip(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            zip_path = tmp_path / "raw_2026.zip"

            # Initial creation
            u1, t1 = RawZipArchive.append_files(zip_path, {"101.fit": b"FIT_101"})
            self.assertEqual((u1, t1), (1, 1))

            # Strictly new member uses append mode ("a") without rewriting existing members
            orig_zipfile = zipfile.ZipFile
            modes_used = []

            def _spy_zipfile(file, mode="r", *args, **kwargs):
                modes_used.append(mode)
                return orig_zipfile(file, mode, *args, **kwargs)

            with patch("src.storage.parquet_vault.zipfile.ZipFile", side_effect=_spy_zipfile):
                u2, t2 = RawZipArchive.append_files(zip_path, {"102.fit": b"FIT_102"})
            self.assertEqual((u2, t2), (1, 2))
            self.assertIn("a", modes_used)
            self.assertEqual(RawZipArchive.list_members(zip_path), ["101.fit", "102.fit"])

            # Overwriting existing member with new bytes rewrites cleanly with no duplicate entries
            u3, t3 = RawZipArchive.append_files(zip_path, {"101.fit": b"FIT_101_V2"})
            self.assertEqual((u3, t3), (1, 2))
            with orig_zipfile(zip_path, "r") as zf:
                self.assertEqual(zf.namelist(), ["101.fit", "102.fit"])
                self.assertEqual(zf.read("101.fit"), b"FIT_101_V2")

            # Manifest SHA-256 skip unchanged uploads
            mock_sftp = MockSFTPClient()
            vault = ParquetVault(work_dir=tmp_path / "work", storage_client=mock_sftp)
            manifest = vault.load_manifest()
            vault.save_activities([{"id": "a1", "start_time": "2026-10-01T07:00:00Z"}], push_remote=True)
            vault.save_manifest(manifest)

            expected_hash = compute_file_sha256(vault.local_activities_path)
            self.assertEqual(manifest.file_hashes.get("activities.parquet"), expected_hash)

            with patch.object(mock_sftp, "put_file") as mock_put:
                pushed = vault._push_file(vault.local_activities_path, "activities.parquet")
                self.assertFalse(pushed)
                mock_put.assert_not_called()


class TestCleanupHardening(unittest.TestCase):
    def test_chunked_zero_fill_and_expanded_prohibited_patterns(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            # > 1 MB file to exercise multi-chunk zero-fill loop
            big_file = tmp_path / "big.fit"
            big_file.write_bytes(b"A" * (1024 * 1024 + 512))
            self.assertTrue(purge_file(big_file, secure=True))
            self.assertFalse(big_file.exists())

            for rel in (
                "garmin_oauth.json",
                "vault_manifest.json",
                "raw_2026.zip",
                "wellness_history.json",
                "activities_index.json",
                ".staging/streams/act1.json",
            ):
                p = tmp_path / rel
                p.parent.mkdir(parents=True, exist_ok=True)
                p.write_text("{}", encoding="utf-8")

            is_clean, violations = verify_clean_workspace(tmp_path)
            self.assertFalse(is_clean)
            for rel in (
                "garmin_oauth.json",
                "vault_manifest.json",
                "raw_2026.zip",
                "wellness_history.json",
                "activities_index.json",
                ".staging/streams/act1.json",
            ):
                self.assertIn(rel, violations)

            for pat in (
                "garmin_oauth.json",
                "vault_manifest.json",
                "raw_*.zip",
                "wellness_history.json",
                "activities_index.json",
                ".staging/streams/*.json",
            ):
                self.assertIn(pat, PROHIBITED_PATTERNS)


if __name__ == "__main__":
    unittest.main()
