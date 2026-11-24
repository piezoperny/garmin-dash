"""
src/encryption/encrypt.py
Build-time CLI script and orchestrator for zero-knowledge payload encryption.

Responsibilities:
- Reads DASHBOARD_PASSPHRASE from environment or CLI arguments.
- Ingests canonical dashboard rollup from .staging/dashboard_rollup.json or generates
  synthetic multi-sport dataset on the fly (--mock mode).
- Serializes rollup JSON to compact UTF-8 bytes.
- Encrypts payload via AES-256-GCM using crypto_engine.py.
- Writes binary wire format artifact data.enc to target static directory.
- Enforces zero-plaintext hygiene by purging staging files after encryption.
- Validates in-memory roundtrip decryption with --verify flag.
"""

from __future__ import annotations

import argparse
import base64
import gzip
import hashlib
import json
import logging
import os
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple, Union

from src.encryption.crypto_engine import (
    KEY_SIZE,
    MIN_WIRE_SIZE,
    PBKDF2_ITERATIONS,
    SALT_SIZE,
    decrypt_payload,
    decrypt_with_key,
    derive_key,
    encrypt_payload,
    encrypt_with_key,
)

logger = logging.getLogger("src.encryption.encrypt")

DEFAULT_STAGING_ROLLUP = Path(".staging/dashboard_rollup.json")
DEFAULT_STAGING_STREAMS_DIR = Path(".staging/streams")
DEFAULT_OUTPUT_ENC = Path("public/data.enc")
MOCK_DEFAULT_PASSPHRASE = "demo-passphrase-2026!"


def build_and_encrypt_rollup(
    passphrase: Optional[str] = None,
    input_file: Optional[Union[str, Path]] = None,
    output_file: Optional[Union[str, Path]] = None,
    mock: bool = False,
    seed: int = 42,
    verify: bool = False,
    purge_input: bool = True,
    iterations: int = PBKDF2_ITERATIONS,
    compress: bool = True,
    pack_streams: bool = True,
) -> Path:
    """
    Compiles, compresses, encrypts, and packages fitness data rollup into data.enc
    and yearly encrypted stream packfiles into streams/streams_YYYY.pack.

    Returns:
        Path to generated data.enc binary artifact.
    """
    # 1. Resolve Master Passphrase
    resolved_passphrase = passphrase or os.environ.get("DASHBOARD_PASSPHRASE")
    if not resolved_passphrase:
        if mock:
            resolved_passphrase = MOCK_DEFAULT_PASSPHRASE
            logger.info("Operating in MOCK mode: using demo master passphrase.")
        else:
            raise ValueError(
                "DASHBOARD_PASSPHRASE environment variable is required. "
                "Set DASHBOARD_PASSPHRASE or provide --passphrase."
            )

    # 2. Acquire Rollup Data
    rollup_data: Dict[str, Any]
    input_path = Path(input_file) if input_file else DEFAULT_STAGING_ROLLUP

    if mock:
        logger.info(f"Generating synthetic multi-sport dataset rollup (seed={seed})...")
        from src.ingestion.mock_generator import SyntheticDatasetGenerator, compile_rollup

        generator = SyntheticDatasetGenerator(seed=seed)
        canonical_activities = generator.generate_activities()
        rollup_data = compile_rollup(canonical_activities)
        logger.info(f"Generated {len(rollup_data.get('activities', []))} synthetic activities.")
    else:
        if not input_path.exists():
            raise FileNotFoundError(
                f"Ingestion rollup not found at {input_path}. "
                "Run sync pipeline first (`python -m src.ingestion.sync`) or pass --mock."
            )
        logger.info(f"Loading rollup payload from {input_path}...")
        with open(input_path, "r", encoding="utf-8") as f:
            rollup_data = json.load(f)

    target_path = Path(output_file) if output_file else DEFAULT_OUTPUT_ENC
    target_path.parent.mkdir(parents=True, exist_ok=True)

    # Derive shared key once so data.enc and stream packfiles share the same salt & session key
    salt = os.urandom(SALT_SIZE)
    shared_key = derive_key(resolved_passphrase, salt, iterations=iterations)

    # 2b. Pack & encrypt sharded activity stream files into yearly streams/streams_YYYY.pack
    streams_staging = input_path.parent / "streams" if input_file else DEFAULT_STAGING_STREAMS_DIR
    should_mirror = output_file is None or target_path == DEFAULT_OUTPUT_ENC
    mirror_dirs = [Path("dist"), Path("frontend"), Path("frontend/public")]

    if streams_staging.exists() and streams_staging.is_dir():
        out_streams_dir = target_path.parent / "streams"
        out_streams_dir.mkdir(parents=True, exist_ok=True)

        if pack_streams:
            act_year_map: Dict[str, str] = {}
            for act in rollup_data.get("activities", []):
                if isinstance(act, dict) and act.get("id") is not None:
                    ds = str(act.get("start_time") or act.get("date") or "")
                    yr = ds[:4] if len(ds) >= 4 and ds[:4].isdigit() else "unknown"
                    act_year_map[str(act["id"])] = yr

            files_by_year: Dict[str, List[Path]] = {}
            for shard_file in sorted(streams_staging.glob("*.json")):
                yr = act_year_map.get(shard_file.stem, "unknown")
                files_by_year.setdefault(yr, []).append(shard_file)

            pack_keys_path = out_streams_dir / "pack_keys.enc"
            existing_manifest: Dict[str, Any] = {}
            if pack_keys_path.exists() and pack_keys_path.is_file():
                try:
                    raw_manifest = decrypt_payload(
                        wire=pack_keys_path.read_bytes(),
                        passphrase=resolved_passphrase,
                        iterations=iterations,
                    )
                    loaded_manifest = json.loads(raw_manifest.decode("utf-8"))
                    if isinstance(loaded_manifest, dict):
                        existing_manifest = loaded_manifest
                except Exception as e:
                    logger.warning(f"Could not decrypt existing pack_keys.enc ({e}); rebuilding packfiles.")
                    existing_manifest = {}

            existing_years = existing_manifest.get("years") if isinstance(existing_manifest.get("years"), dict) else {}
            current_year = datetime.now(timezone.utc).year

            pack_index: Dict[str, Dict[str, Any]] = {}
            year_deks: Dict[str, bytes] = {}
            new_manifest_years: Dict[str, Any] = {}
            packed_count = 0
            reused_years = 0

            for yr, shard_files in sorted(files_by_year.items()):
                pack_path = out_streams_dir / f"streams_{yr}.pack"
                shard_bytes_map: Dict[str, bytes] = {}
                shard_hashes: Dict[str, str] = {}
                for shard_file in shard_files:
                    raw_shard = shard_file.read_bytes()
                    shard_bytes_map[shard_file.stem] = raw_shard
                    shard_hashes[shard_file.stem] = hashlib.sha256(raw_shard).hexdigest()

                can_reuse = False
                prev_entry = existing_years.get(yr)
                if (
                    yr.isdigit()
                    and int(yr) < current_year
                    and pack_path.exists()
                    and pack_path.is_file()
                    and isinstance(prev_entry, dict)
                    and prev_entry.get("compress") == compress
                    and prev_entry.get("shards") == shard_hashes
                ):
                    prev_dek_b64 = prev_entry.get("dek")
                    prev_yr_index = prev_entry.get("pack_index")
                    if isinstance(prev_dek_b64, str) and isinstance(prev_yr_index, dict):
                        try:
                            prev_dek = base64.b64decode(prev_dek_b64, validate=True)
                        except Exception:
                            prev_dek = b""
                        pack_size = pack_path.stat().st_size
                        if (
                            len(prev_dek) == KEY_SIZE
                            and set(prev_yr_index.keys()) == set(shard_hashes.keys())
                            and all(
                                isinstance(v, dict)
                                and v.get("year") == yr
                                and isinstance(v.get("offset"), int)
                                and isinstance(v.get("length"), int)
                                and v["offset"] >= 0
                                and v["length"] >= MIN_WIRE_SIZE
                                and v["offset"] + v["length"] <= pack_size
                                for v in prev_yr_index.values()
                            )
                        ):
                            can_reuse = True
                            year_deks[yr] = prev_dek
                            pack_index.update(prev_yr_index)
                            new_manifest_years[yr] = prev_entry
                            packed_count += len(shard_files)
                            reused_years += 1
                            logger.info(
                                f"Reusing immutable historical packfile streams_{yr}.pack ({len(shard_files)} shards)."
                            )

                if not can_reuse:
                    year_dek = os.urandom(KEY_SIZE)
                    year_deks[yr] = year_dek
                    yr_pack_index: Dict[str, Dict[str, Any]] = {}

                    tmp_pack = pack_path.with_suffix(".pack.tmp")
                    offset = 0
                    with open(tmp_pack, "wb") as pf:
                        for shard_file in shard_files:
                            act_id = shard_file.stem
                            shard_bytes = shard_bytes_map[act_id]
                            if compress:
                                shard_bytes = gzip.compress(shard_bytes, compresslevel=9, mtime=0)
                            aad = f"garmin-dash:v1:stream:{yr}:{act_id}".encode("utf-8")
                            enc_chunk = encrypt_with_key(shard_bytes, key=year_dek, salt=salt, aad=aad)
                            pf.write(enc_chunk)
                            entry = {
                                "year": yr,
                                "offset": offset,
                                "length": len(enc_chunk),
                            }
                            yr_pack_index[act_id] = entry
                            pack_index[act_id] = entry
                            offset += len(enc_chunk)
                            packed_count += 1
                        pf.flush()
                        os.fsync(pf.fileno())
                    if pack_path.exists():
                        pack_path.unlink()
                    tmp_pack.rename(pack_path)

                    new_manifest_years[yr] = {
                        "dek": base64.b64encode(year_dek).decode("ascii"),
                        "compress": compress,
                        "shards": shard_hashes,
                        "pack_index": yr_pack_index,
                    }

            # Persist per-year DEKs + shard hash manifest wrapped with passphrase KEK
            manifest_payload = {
                "version": 1,
                "years": new_manifest_years,
            }
            manifest_enc = encrypt_with_key(manifest_payload, key=shared_key, salt=salt)
            tmp_keys = pack_keys_path.with_suffix(".enc.tmp")
            with open(tmp_keys, "wb") as kf:
                kf.write(manifest_enc)
                kf.flush()
                os.fsync(kf.fileno())
            if pack_keys_path.exists():
                pack_keys_path.unlink()
            tmp_keys.rename(pack_keys_path)

            # Prune orphaned *.enc (excluding pack_keys.enc) and removed-year *.pack before mirroring
            active_packs = {f"streams_{yr}.pack" for yr in files_by_year.keys()}
            for stale_enc in out_streams_dir.glob("*.enc"):
                if stale_enc.name != "pack_keys.enc":
                    stale_enc.unlink()
            for stale_pack in out_streams_dir.glob("*.pack"):
                if stale_pack.name not in active_packs:
                    stale_pack.unlink()

            if should_mirror:
                for mirror_dir in mirror_dirs:
                    if mirror_dir.exists() and mirror_dir.is_dir() and mirror_dir != target_path.parent:
                        m_streams = mirror_dir / "streams"
                        m_streams.mkdir(parents=True, exist_ok=True)
                        for stale_enc in m_streams.glob("*.enc"):
                            stale_enc.unlink()
                        for stale_pack in m_streams.glob("*.pack"):
                            if stale_pack.name not in active_packs:
                                stale_pack.unlink()
                        for yr in files_by_year.keys():
                            shutil.copyfile(out_streams_dir / f"streams_{yr}.pack", m_streams / f"streams_{yr}.pack")

            if packed_count > 0:
                rollup_data["stream_pack_index"] = pack_index
                rollup_data["stream_pack_keys"] = {
                    yr: base64.b64encode(dek).decode("ascii")
                    for yr, dek in sorted(year_deks.items())
                }
                rollup_data["aad_version"] = 1
                logger.info(
                    f"Packed & encrypted {packed_count} activity streams into {len(files_by_year)} yearly packfile(s) "
                    f"({reused_years} reused verbatim) under {out_streams_dir}"
                )
        else:
            shard_files_list = sorted(streams_staging.glob("*.json"))
            active_encs = {f"{sf.stem}.enc" for sf in shard_files_list}

            # Prune orphaned *.enc and *.pack before writing/mirroring
            for stale_pack in out_streams_dir.glob("*.pack"):
                stale_pack.unlink()
            for stale_enc in out_streams_dir.glob("*.enc"):
                if stale_enc.name not in active_encs:
                    stale_enc.unlink()

            if should_mirror:
                for mirror_dir in mirror_dirs:
                    if mirror_dir.exists() and mirror_dir.is_dir() and mirror_dir != target_path.parent:
                        m_streams = mirror_dir / "streams"
                        m_streams.mkdir(parents=True, exist_ok=True)
                        for stale_pack in m_streams.glob("*.pack"):
                            stale_pack.unlink()
                        for stale_enc in m_streams.glob("*.enc"):
                            if stale_enc.name not in active_encs:
                                stale_enc.unlink()

            shard_count = 0
            for shard_file in shard_files_list:
                shard_bytes = shard_file.read_bytes()
                if compress:
                    shard_bytes = gzip.compress(shard_bytes, compresslevel=9, mtime=0)
                enc_shard = encrypt_with_key(shard_bytes, key=shared_key, salt=salt)
                enc_target = out_streams_dir / f"{shard_file.stem}.enc"
                enc_target.write_bytes(enc_shard)
                shard_count += 1
                if should_mirror:
                    for mirror_dir in mirror_dirs:
                        if mirror_dir.exists() and mirror_dir.is_dir() and mirror_dir != target_path.parent:
                            m_streams = mirror_dir / "streams"
                            m_streams.mkdir(parents=True, exist_ok=True)
                            shutil.copyfile(enc_target, m_streams / f"{shard_file.stem}.enc")
            if shard_count > 0:
                logger.info(f"Encrypted {shard_count} activity stream shards to {out_streams_dir}")

    # 3. Serialize, Optionally Gzip-Compress, and Encrypt data.enc
    logger.info("Serializing rollup to compact UTF-8 JSON...")
    plaintext_bytes = json.dumps(rollup_data, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    payload_bytes = gzip.compress(plaintext_bytes, compresslevel=9, mtime=0) if compress else plaintext_bytes
    plaintext_size_kb = len(plaintext_bytes) / 1024.0
    payload_size_kb = len(payload_bytes) / 1024.0
    logger.info(
        f"Encrypting {payload_size_kb:.2f} KB payload (raw JSON {plaintext_size_kb:.2f} KB, "
        f"gzip={'on' if compress else 'off'}) with AES-256-GCM (PBKDF2 {iterations:,} iterations)..."
    )

    wire_bytes = encrypt_with_key(
        data=payload_bytes,
        key=shared_key,
        salt=salt,
    )
    logger.info(f"Generated binary wire payload: {len(wire_bytes)} bytes.")

    # 4. Write Atomically
    temp_target = target_path.with_suffix(".tmp")
    with open(temp_target, "wb") as f:
        f.write(wire_bytes)
        f.flush()
        os.fsync(f.fileno())

    if target_path.exists():
        target_path.unlink()
    temp_target.rename(target_path)
    logger.info(f"Successfully published encrypted binary artifact: {target_path}")

    # Mirror to dist/ or frontend/public if generating the default output artifact
    if should_mirror:
        for mirror_dir in mirror_dirs:
            if mirror_dir.exists() and mirror_dir.is_dir() and mirror_dir != target_path.parent:
                mirror_path = mirror_dir / "data.enc"
                shutil.copyfile(target_path, mirror_path)
                logger.info(f"Mirrored data.enc to {mirror_path}")

    # Free intermediate buffers before verification to reduce peak RAM
    del plaintext_bytes, payload_bytes, wire_bytes

    # 5. In-Memory Roundtrip Verification
    if verify:
        logger.info("Executing in-memory verification roundtrip...")
        with open(target_path, "rb") as f:
            written_bytes = f.read()

        decrypted_raw = decrypt_payload(
            wire=written_bytes,
            passphrase=resolved_passphrase,
            iterations=iterations,
        )
        if len(decrypted_raw) >= 2 and decrypted_raw[:2] == b"\x1f\x8b":
            decrypted_raw = gzip.decompress(decrypted_raw)
        decrypted_dict = json.loads(decrypted_raw.decode("utf-8"))

        if decrypted_dict != rollup_data:
            raise RuntimeError("Verification failed: decrypted payload does not match original rollup.")

        v_pack_index = decrypted_dict.get("stream_pack_index")
        if isinstance(v_pack_index, dict) and v_pack_index:
            v_pack_keys = decrypted_dict.get("stream_pack_keys")
            if not isinstance(v_pack_keys, dict):
                raise RuntimeError("Verification failed: missing stream_pack_keys for stream_pack_index.")
            if decrypted_dict.get("aad_version") != 1:
                raise RuntimeError(f"Verification failed: unexpected aad_version {decrypted_dict.get('aad_version')!r}.")

            pack_cache: Dict[str, bytes] = {}
            for act_id, entry in v_pack_index.items():
                if not isinstance(entry, dict):
                    raise RuntimeError(f"Verification failed: invalid stream_pack_index entry for {act_id}.")
                yr = entry.get("year")
                offset = entry.get("offset")
                length = entry.get("length")
                if not isinstance(yr, str) or yr not in v_pack_keys:
                    raise RuntimeError(f"Verification failed: missing DEK for year {yr!r} (activity {act_id}).")
                dek = base64.b64decode(v_pack_keys[yr])
                if len(dek) != KEY_SIZE:
                    raise RuntimeError(f"Verification failed: invalid DEK length for year {yr!r}.")

                if yr not in pack_cache:
                    p_path = target_path.parent / "streams" / f"streams_{yr}.pack"
                    if not p_path.exists():
                        raise RuntimeError(f"Verification failed: missing packfile {p_path}.")
                    pack_cache[yr] = p_path.read_bytes()
                pack_bytes = pack_cache[yr]

                if (
                    not isinstance(offset, int)
                    or not isinstance(length, int)
                    or offset < 0
                    or length < MIN_WIRE_SIZE
                    or offset + length > len(pack_bytes)
                ):
                    raise RuntimeError(
                        f"Verification failed: out-of-bounds offset/length ({offset}, {length}) "
                        f"for activity {act_id} in streams_{yr}.pack (size={len(pack_bytes)})."
                    )

                chunk = pack_bytes[offset : offset + length]
                aad = f"garmin-dash:v1:stream:{yr}:{act_id}".encode("utf-8")
                dec_chunk = decrypt_with_key(chunk, key=dek, aad=aad)
                if len(dec_chunk) >= 2 and dec_chunk[:2] == b"\x1f\x8b":
                    dec_chunk = gzip.decompress(dec_chunk)
                json.loads(dec_chunk.decode("utf-8"))

        logger.info(
            f"Verification PASSED: Roundtrip decryption verified {len(decrypted_dict.get('activities', []))} "
            f"activities and {len(written_bytes)} wire bytes."
        )

    # 6. Hygiene Purge: Remove Unencrypted Staging Artifacts
    if purge_input:
        from src.ingestion.cleanup import purge_directory, purge_file

        if input_path.exists() and input_path.is_file():
            logger.info(f"Purging unencrypted staging file: {input_path}")
            purge_file(input_path, secure=True)

        if DEFAULT_STAGING_ROLLUP.exists():
            logger.info(f"Purging unencrypted staging file: {DEFAULT_STAGING_ROLLUP}")
            purge_file(DEFAULT_STAGING_ROLLUP, secure=True)

        staging_dir = Path(".staging")
        if staging_dir.exists() and staging_dir.is_dir():
            try:
                purge_directory(staging_dir, secure=True, remove_dir=True)
            except Exception as e:
                logger.debug(f"Staging directory purge non-fatal notice: {e}")

    return target_path


def parse_args(args: Optional[List[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Zero-Knowledge Build-Time Encryption Pipeline for Garmin Dashboard."
    )
    parser.add_argument(
        "--passphrase", "-p",
        default=None,
        help="Master dashboard passphrase. Defaults to DASHBOARD_PASSPHRASE env var.",
    )
    parser.add_argument(
        "--input-file", "-i",
        default=None,
        help="Path to plaintext dashboard_rollup.json (defaults to .staging/dashboard_rollup.json).",
    )
    parser.add_argument(
        "--output-file", "-o",
        default=None,
        help="Path for encrypted data.enc output (defaults to public/data.enc).",
    )
    parser.add_argument(
        "--mock", "-m",
        action="store_true",
        help="Generate synthetic multi-sport dataset on the fly without requiring prior ingestion.",
    )
    parser.add_argument(
        "--seed",
        type=int,
        default=42,
        help="Random seed for deterministic synthetic dataset generator (default: 42).",
    )
    parser.add_argument(
        "--verify", "-v",
        action="store_true",
        help="Perform in-memory roundtrip decryption test verifying integrity of generated data.enc.",
    )
    parser.add_argument(
        "--no-purge",
        action="store_true",
        help="Do not purge unencrypted input files after encryption (defaults to purging).",
    )
    parser.add_argument(
        "--no-compress",
        action="store_true",
        help="Disable Gzip compression before AES-256-GCM encryption.",
    )
    parser.add_argument(
        "--no-pack-streams",
        action="store_true",
        help="Write individual streams/<id>.enc shards instead of yearly streams_YYYY.pack.",
    )
    parser.add_argument(
        "--iterations",
        type=int,
        default=PBKDF2_ITERATIONS,
        help=f"PBKDF2 iterations for key derivation (default: {PBKDF2_ITERATIONS}).",
    )
    return parser.parse_args(args)


def main() -> int:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    )
    args = parse_args()
    try:
        build_and_encrypt_rollup(
            passphrase=args.passphrase,
            input_file=args.input_file,
            output_file=args.output_file,
            mock=args.mock,
            seed=args.seed,
            verify=args.verify,
            purge_input=not args.no_purge,
            iterations=args.iterations,
            compress=not args.no_compress,
            pack_streams=not args.no_pack_streams,
        )
        return 0
    except Exception as e:
        logger.error(f"Encryption pipeline failed: {e}", exc_info=True)
        return 1


if __name__ == "__main__":
    sys.exit(main())
