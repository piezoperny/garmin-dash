"""
tests/test_packed_encryption_and_range.py
Tests Gzip-compressed data.enc encryption and yearly streams_YYYY.pack generation
plus roundtrip verification.
"""

from __future__ import annotations

import gzip
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.encryption.crypto_engine import decrypt_payload
from src.encryption.encrypt import build_and_encrypt_rollup


def test_gzip_rollup_and_yearly_stream_packfiles(tmp_path: Path):
    staging_dir = tmp_path / ".staging"
    streams_dir = staging_dir / "streams"
    streams_dir.mkdir(parents=True)

    rollup = {
        "schema_version": "1.0",
        "activities": [
            {"id": "101", "start_time": "2025-05-01T08:00:00Z", "sport": "running"},
            {"id": "202", "start_time": "2026-01-15T09:00:00Z", "sport": "cycling"},
        ],
        "wellness": {"current": {}, "daily": []},
    }
    rollup_path = staging_dir / "dashboard_rollup.json"
    rollup_path.write_text(json.dumps(rollup), encoding="utf-8")

    (streams_dir / "101.json").write_text(
        json.dumps({"id": "101", "telemetry_stream": {"hr": [140, 145, 150]}}),
        encoding="utf-8",
    )
    (streams_dir / "202.json").write_text(
        json.dumps({"id": "202", "telemetry_stream": {"hr": [125, 130], "power": [210, 230]}}),
        encoding="utf-8",
    )

    out_enc = tmp_path / "public" / "data.enc"
    passphrase = "test-pack-passphrase!"

    build_and_encrypt_rollup(
        passphrase=passphrase,
        input_file=rollup_path,
        output_file=out_enc,
        verify=True,
        purge_input=False,
        iterations=1000,
        compress=True,
        pack_streams=True,
    )

    assert out_enc.exists()
    pack_2025 = tmp_path / "public" / "streams" / "streams_2025.pack"
    pack_2026 = tmp_path / "public" / "streams" / "streams_2026.pack"
    assert pack_2025.exists()
    assert pack_2026.exists()

    # Verify data.enc is gzip-compressed inside AES-256-GCM and contains stream_pack_index
    decrypted_raw = decrypt_payload(out_enc.read_bytes(), passphrase=passphrase, iterations=1000)
    assert decrypted_raw[:2] == b"\x1f\x8b"
    decrypted_rollup = json.loads(gzip.decompress(decrypted_raw).decode("utf-8"))
    pack_index = decrypted_rollup["stream_pack_index"]
    assert set(pack_index.keys()) == {"101", "202"}
    assert pack_index["101"]["year"] == "2025"
    assert pack_index["202"]["year"] == "2026"

    # Verify slicing exact byte ranges from streams_YYYY.pack decrypts each shard cleanly
    p25_bytes = pack_2025.read_bytes()
    e101 = pack_index["101"]
    slice_101 = p25_bytes[e101["offset"]: e101["offset"] + e101["length"]]
    dec_101_raw = decrypt_payload(slice_101, passphrase=passphrase, iterations=1000)
    assert dec_101_raw[:2] == b"\x1f\x8b"
    shard_101 = json.loads(gzip.decompress(dec_101_raw).decode("utf-8"))
    assert shard_101["telemetry_stream"]["hr"] == [140, 145, 150]
