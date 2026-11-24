"""
tests/test_opt_m3_envelope_crypto.py
Unit and integration tests for Milestone M3:
- AAD binding & tamper rejection in encrypt_with_key / decrypt_with_key and ctypes fallback
- Key (32B) and Salt (16B) validation
- Thread-safe OpenSSL ctypes initialization & operation
- Per-year DEK wrapping in pack_keys.enc and stream_pack_keys / aad_version in data.enc
- Historical yearly packfile immutability across builds
- Orphaned *.enc and removed-year *.pack pruning
- --verify packfile roundtrip & offset/length bounds validation
"""

from __future__ import annotations

import base64
import concurrent.futures
import gzip
import json
import os
import shutil
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

from src.encryption.crypto_engine import (
    HEADER_SIZE,
    KEY_SIZE,
    MIN_WIRE_SIZE,
    SALT_SIZE,
    AuthenticationError,
    MalformedWireError,
    _ctypes_aes_gcm_decrypt,
    _ctypes_aes_gcm_encrypt,
    decrypt_payload,
    decrypt_with_key,
    encrypt_with_key,
)
from src.encryption.encrypt import build_and_encrypt_rollup


class TestEnvelopeCryptoEngine(unittest.TestCase):
    def setUp(self):
        self.key = os.urandom(KEY_SIZE)
        self.salt = os.urandom(SALT_SIZE)
        self.aad = b"garmin-dash:v1:stream:2024:act_101"

    def test_aad_roundtrip_and_backward_compat(self):
        plaintext = b'{"hr":[140,145,150]}'
        # Default aad=None
        wire_no_aad = encrypt_with_key(plaintext, key=self.key, salt=self.salt)
        self.assertGreaterEqual(len(wire_no_aad), MIN_WIRE_SIZE)
        self.assertEqual(wire_no_aad[:SALT_SIZE], self.salt)
        self.assertEqual(decrypt_with_key(wire_no_aad, key=self.key), plaintext)

        # With explicit AAD
        wire_with_aad = encrypt_with_key(plaintext, key=self.key, salt=self.salt, aad=self.aad)
        self.assertEqual(decrypt_with_key(wire_with_aad, key=self.key, aad=self.aad), plaintext)
        self.assertEqual(
            decrypt_with_key(wire_with_aad, key=self.key, salt=self.salt, aad=self.aad),
            plaintext,
        )

    def test_aad_tamper_and_mismatch_rejected(self):
        wire = encrypt_with_key(b"secret-stream", key=self.key, salt=self.salt, aad=self.aad)

        # Missing AAD when encrypted with AAD
        with self.assertRaises(AuthenticationError):
            decrypt_with_key(wire, key=self.key, aad=None)

        # Wrong activity_id in AAD
        with self.assertRaises(AuthenticationError):
            decrypt_with_key(wire, key=self.key, aad=b"garmin-dash:v1:stream:2024:act_999")

        # Wrong year in AAD
        with self.assertRaises(AuthenticationError):
            decrypt_with_key(wire, key=self.key, aad=b"garmin-dash:v1:stream:2025:act_101")

        # Unexpected AAD when encrypted without AAD
        wire_no_aad = encrypt_with_key(b"secret-stream", key=self.key, salt=self.salt)
        with self.assertRaises(AuthenticationError):
            decrypt_with_key(wire_no_aad, key=self.key, aad=self.aad)

    def test_ctypes_fallback_aad_and_thread_safety(self):
        iv = os.urandom(12)
        plaintext = b"ctypes-aad-payload-\x00-binary"
        ct_tag = _ctypes_aes_gcm_encrypt(self.key, iv, plaintext, aad=self.aad)
        ct, tag = ct_tag[:-16], ct_tag[-16:]

        self.assertEqual(_ctypes_aes_gcm_decrypt(self.key, iv, ct, tag, aad=self.aad), plaintext)
        with self.assertRaises(AuthenticationError):
            _ctypes_aes_gcm_decrypt(self.key, iv, ct, tag, aad=b"wrong-aad")

        # Concurrent encrypt/decrypt across threads
        def worker(idx: int) -> bytes:
            msg = f"thread-msg-{idx}".encode("utf-8")
            aad_i = f"garmin-dash:v1:stream:2024:{idx}".encode("utf-8")
            iv_i = os.urandom(12)
            res = _ctypes_aes_gcm_encrypt(self.key, iv_i, msg, aad=aad_i)
            return _ctypes_aes_gcm_decrypt(self.key, iv_i, res[:-16], res[-16:], aad=aad_i)

        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(worker, range(32)))
        for idx, out in enumerate(results):
            self.assertEqual(out, f"thread-msg-{idx}".encode("utf-8"))

    def test_key_and_salt_validation(self):
        for bad_key in [b"", b"short", b"x" * 31, b"x" * 33]:
            with self.assertRaises(ValueError):
                encrypt_with_key(b"abc", key=bad_key, salt=self.salt)
            with self.assertRaises(ValueError):
                decrypt_with_key(b"x" * MIN_WIRE_SIZE, key=bad_key)

        for bad_type_key in ["not-bytes", 123, None]:
            with self.assertRaises(TypeError):
                encrypt_with_key(b"abc", key=bad_type_key, salt=self.salt)  # type: ignore[arg-type]
            with self.assertRaises(TypeError):
                decrypt_with_key(b"x" * MIN_WIRE_SIZE, key=bad_type_key)  # type: ignore[arg-type]

        for bad_salt in [b"", b"short", b"s" * 15, b"s" * 17]:
            with self.assertRaises(ValueError):
                encrypt_with_key(b"abc", key=self.key, salt=bad_salt)
            with self.assertRaises(ValueError):
                decrypt_with_key(b"x" * MIN_WIRE_SIZE, key=self.key, salt=bad_salt)

        for bad_type_salt in ["not-bytes", 123]:
            with self.assertRaises(TypeError):
                encrypt_with_key(b"abc", key=self.key, salt=bad_type_salt)  # type: ignore[arg-type]
            with self.assertRaises(TypeError):
                decrypt_with_key(b"x" * MIN_WIRE_SIZE, key=self.key, salt=bad_type_salt)  # type: ignore[arg-type]

        with self.assertRaises(MalformedWireError):
            decrypt_with_key(b"x" * (MIN_WIRE_SIZE - 1), key=self.key)


class TestM3PackfileEnvelopeAndImmutability(unittest.TestCase):
    def setUp(self):
        self.tmp_dir = Path(tempfile.mkdtemp())
        self.staging_dir = self.tmp_dir / ".staging"
        self.streams_dir = self.staging_dir / "streams"
        self.streams_dir.mkdir(parents=True)
        self.out_enc = self.tmp_dir / "public" / "data.enc"
        self.out_streams = self.tmp_dir / "public" / "streams"
        self.passphrase = "m3-envelope-test-passphrase!"
        self.current_year = str(datetime.now(timezone.utc).year)
        self.hist_year = str(datetime.now(timezone.utc).year - 2)

    def tearDown(self):
        shutil.rmtree(self.tmp_dir, ignore_errors=True)

    def _write_dataset(self, include_extra_current: bool = False, hist_hr: int = 140):
        activities = [
            {"id": "101", "start_time": f"{self.hist_year}-05-01T08:00:00Z", "sport": "running"},
            {"id": "202", "start_time": f"{self.current_year}-01-15T09:00:00Z", "sport": "cycling"},
        ]
        if include_extra_current:
            activities.append(
                {"id": "303", "start_time": f"{self.current_year}-02-01T10:00:00Z", "sport": "running"}
            )
            (self.streams_dir / "303.json").write_text(
                json.dumps({"id": "303", "telemetry_stream": {"hr": [155, 160]}}),
                encoding="utf-8",
            )

        rollup_path = self.staging_dir / "dashboard_rollup.json"
        rollup_path.write_text(
            json.dumps({"schema_version": "1.0", "activities": activities, "wellness": {"current": {}, "daily": []}}),
            encoding="utf-8",
        )
        (self.streams_dir / "101.json").write_text(
            json.dumps({"id": "101", "telemetry_stream": {"hr": [hist_hr, hist_hr + 5]}}),
            encoding="utf-8",
        )
        (self.streams_dir / "202.json").write_text(
            json.dumps({"id": "202", "telemetry_stream": {"hr": [125, 130], "power": [210, 230]}}),
            encoding="utf-8",
        )
        return rollup_path

    def test_envelope_dek_wrapping_aad_and_verify(self):
        rollup_path = self._write_dataset()
        build_and_encrypt_rollup(
            passphrase=self.passphrase,
            input_file=rollup_path,
            output_file=self.out_enc,
            verify=True,
            purge_input=False,
            iterations=1000,
            compress=True,
            pack_streams=True,
        )

        # pack_keys.enc exists and is encrypted with passphrase KEK
        pack_keys_path = self.out_streams / "pack_keys.enc"
        self.assertTrue(pack_keys_path.exists())
        manifest = json.loads(
            decrypt_payload(pack_keys_path.read_bytes(), passphrase=self.passphrase, iterations=1000).decode("utf-8")
        )
        self.assertEqual(manifest["version"], 1)
        self.assertIn(self.hist_year, manifest["years"])
        self.assertIn(self.current_year, manifest["years"])

        # data.enc keeps 28-byte header wire format and embeds stream_pack_keys + aad_version
        enc_bytes = self.out_enc.read_bytes()
        self.assertGreaterEqual(len(enc_bytes), HEADER_SIZE + 16)
        dec_raw = decrypt_payload(enc_bytes, passphrase=self.passphrase, iterations=1000)
        self.assertEqual(dec_raw[:2], b"\x1f\x8b")
        rollup = json.loads(gzip.decompress(dec_raw).decode("utf-8"))

        self.assertEqual(rollup["aad_version"], 1)
        self.assertEqual(set(rollup["stream_pack_keys"].keys()), {self.hist_year, self.current_year})
        dek_hist = base64.b64decode(rollup["stream_pack_keys"][self.hist_year])
        self.assertEqual(len(dek_hist), KEY_SIZE)

        # Decrypting chunk with wrong AAD fails; right DEK + AAD succeeds
        e101 = rollup["stream_pack_index"]["101"]
        pack_hist = (self.out_streams / f"streams_{self.hist_year}.pack").read_bytes()
        chunk_101 = pack_hist[e101["offset"] : e101["offset"] + e101["length"]]

        with self.assertRaises(AuthenticationError):
            decrypt_with_key(chunk_101, key=dek_hist, aad=b"garmin-dash:v1:stream:2024:999")

        aad_101 = f"garmin-dash:v1:stream:{self.hist_year}:101".encode("utf-8")
        shard_101 = json.loads(gzip.decompress(decrypt_with_key(chunk_101, key=dek_hist, aad=aad_101)).decode("utf-8"))
        self.assertEqual(shard_101["telemetry_stream"]["hr"], [140, 145])

    def test_historical_packfile_immutable_across_builds(self):
        rollup_path = self._write_dataset(include_extra_current=False)
        build_and_encrypt_rollup(
            passphrase=self.passphrase,
            input_file=rollup_path,
            output_file=self.out_enc,
            verify=True,
            purge_input=False,
            iterations=1000,
            compress=True,
            pack_streams=True,
        )

        hist_pack = self.out_streams / f"streams_{self.hist_year}.pack"
        curr_pack = self.out_streams / f"streams_{self.current_year}.pack"
        hist_bytes_b1 = hist_pack.read_bytes()
        hist_mtime_b1 = hist_pack.stat().st_mtime_ns
        curr_bytes_b1 = curr_pack.read_bytes()

        rollup_b1 = json.loads(
            gzip.decompress(
                decrypt_payload(self.out_enc.read_bytes(), passphrase=self.passphrase, iterations=1000)
            ).decode("utf-8")
        )

        # Build 2: add activity in current_year, keep historical year untouched
        rollup_path = self._write_dataset(include_extra_current=True)
        build_and_encrypt_rollup(
            passphrase=self.passphrase,
            input_file=rollup_path,
            output_file=self.out_enc,
            verify=True,
            purge_input=False,
            iterations=1000,
            compress=True,
            pack_streams=True,
        )

        # Historical packfile was reused verbatim (same bytes, same mtime_ns, same DEK)
        self.assertEqual(hist_pack.read_bytes(), hist_bytes_b1)
        self.assertEqual(hist_pack.stat().st_mtime_ns, hist_mtime_b1)
        # Current year packfile was rebuilt
        self.assertNotEqual(curr_pack.read_bytes(), curr_bytes_b1)

        rollup_b2 = json.loads(
            gzip.decompress(
                decrypt_payload(self.out_enc.read_bytes(), passphrase=self.passphrase, iterations=1000)
            ).decode("utf-8")
        )
        self.assertEqual(
            rollup_b2["stream_pack_keys"][self.hist_year],
            rollup_b1["stream_pack_keys"][self.hist_year],
        )
        self.assertNotEqual(
            rollup_b2["stream_pack_keys"][self.current_year],
            rollup_b1["stream_pack_keys"][self.current_year],
        )

        # Build 3: mutate historical shard -> historical packfile MUST rebuild
        rollup_path = self._write_dataset(include_extra_current=True, hist_hr=175)
        build_and_encrypt_rollup(
            passphrase=self.passphrase,
            input_file=rollup_path,
            output_file=self.out_enc,
            verify=True,
            purge_input=False,
            iterations=1000,
            compress=True,
            pack_streams=True,
        )
        self.assertNotEqual(hist_pack.read_bytes(), hist_bytes_b1)

    def test_orphan_pruning_removes_stale_enc_and_old_year_packs(self):
        rollup_path = self._write_dataset()
        self.out_streams.mkdir(parents=True, exist_ok=True)
        orphan_enc = self.out_streams / "999999.enc"
        orphan_pack = self.out_streams / "streams_1999.pack"
        orphan_enc.write_bytes(b"stale-enc")
        orphan_pack.write_bytes(b"stale-pack")

        build_and_encrypt_rollup(
            passphrase=self.passphrase,
            input_file=rollup_path,
            output_file=self.out_enc,
            verify=True,
            purge_input=False,
            iterations=1000,
            compress=True,
            pack_streams=True,
        )

        self.assertFalse(orphan_enc.exists())
        self.assertFalse(orphan_pack.exists())
        self.assertTrue((self.out_streams / "pack_keys.enc").exists())
        self.assertTrue((self.out_streams / f"streams_{self.hist_year}.pack").exists())
        self.assertTrue((self.out_streams / f"streams_{self.current_year}.pack").exists())


if __name__ == "__main__":
    unittest.main()
