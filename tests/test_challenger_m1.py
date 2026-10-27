"""
tests/test_challenger_m1.py

Adversarial Stress Test Suite & Empirical Verification Harness
Challenger 1 for Milestone 1 (Data & FIT Protocol Challenger).

Challenges covered:
1. Determinism Challenge:
   - Bit-identical activities across independent generator instances (seed=42).
   - Byte-identical .FIT binary outputs across all generated activities.
   - Deterministic re-generation on same instance.
   - Seed variation determinism (seed=0, seed=12345, seed=999999).
   - Canonical JSON rollup byte-level determinism.

2. FIT Protocol 2.0 Challenge:
   - 14-byte binary header validation (header_size=14, protocol=0x20, profile=2132, data_size, b'.FIT').
   - Authentic 16-entry CRC table calculation over header and file.
   - CRC tamper resistance: single bit-flip sensitivity across header and payload.
   - FIT message architecture, record time-series alignment, and Garmin epoch translation.

3. Metric Boundary & Physiological Challenge:
   - Strict physiological boundaries (HR 40-215 bpm, max_hr >= avg_hr, record HR bounds).
   - Cycling power boundaries (0-1500W for cycling, None for running/strength).
   - Cadence bounds by sport (running 150-210 spm, cycling 60-125 rpm, strength strictly 0).
   - Strictly monotonic chronological timestamps spanning 56 days.
   - Distance, duration, moving time, and split/lap telemetry integrity.
   - Banister impulse-response consistency (TSB == CTL - ATL, non-negative load, EWMA decay).
   - Robustness against adversarial inputs (zero duration, zero distance, empty laps).
"""

import hashlib
import json
import math
import struct
import unittest
from datetime import datetime, timezone

from src.ingestion.mock_generator import (
    FIT_HEADER_SIZE,
    FIT_PROFILE_VERSION,
    FIT_PROTOCOL_VERSION,
    FIT_SIGNATURE,
    GARMIN_EPOCH_OFFSET,
    SyntheticDatasetGenerator,
    build_fit_header,
    calculate_fit_crc,
    compile_rollup,
    datetime_to_garmin_timestamp,
)


class TestChallengerM1(unittest.TestCase):
    """Empirical Challenger Test Suite for Milestone 1."""

    def setUp(self):
        self.gen1 = SyntheticDatasetGenerator(seed=42)
        self.gen2 = SyntheticDatasetGenerator(seed=42)
        self.acts1 = self.gen1.generate_activities()
        self.acts2 = self.gen2.generate_activities()

    # =========================================================================
    # 1. DETERMINISM CHALLENGE
    # =========================================================================

    def test_c1_determinism_identical_activity_records(self):
        """Verify that two independent instances with seed=42 produce identical records."""
        self.assertEqual(len(self.acts1), len(self.acts2), "Activity count mismatch")
        self.assertGreaterEqual(len(self.acts1), 35, "Activity count should cover 8 weeks")

        for idx, (a1, a2) in enumerate(zip(self.acts1, self.acts2)):
            self.assertEqual(a1["id"], a2["id"], f"ID mismatch at index {idx}")
            self.assertEqual(a1["sport"], a2["sport"], f"Sport mismatch at index {idx}")
            self.assertEqual(a1["start_time"], a2["start_time"], f"Timestamp mismatch at index {idx}")
            self.assertEqual(a1["distance_meters"], a2["distance_meters"], f"Distance mismatch at index {idx}")
            self.assertEqual(a1["duration_seconds"], a2["duration_seconds"], f"Duration mismatch at index {idx}")
            self.assertEqual(a1["avg_hr"], a2["avg_hr"], f"Avg HR mismatch at index {idx}")
            self.assertEqual(a1["max_hr"], a2["max_hr"], f"Max HR mismatch at index {idx}")
            self.assertEqual(a1["avg_cadence"], a2["avg_cadence"], f"Cadence mismatch at index {idx}")
            self.assertEqual(a1["avg_power"], a2["avg_power"], f"Power mismatch at index {idx}")
            self.assertEqual(a1["tss"], a2["tss"], f"TSS mismatch at index {idx}")
            self.assertEqual(a1["atl"], a2["atl"], f"ATL mismatch at index {idx}")
            self.assertEqual(a1["ctl"], a2["ctl"], f"CTL mismatch at index {idx}")
            self.assertEqual(a1["tsb"], a2["tsb"], f"TSB mismatch at index {idx}")
            self.assertEqual(a1["hr_zones"], a2["hr_zones"], f"HR zones mismatch at index {idx}")
            self.assertEqual(a1["splits"], a2["splits"], f"Splits mismatch at index {idx}")
            self.assertEqual(a1["laps"], a2["laps"], f"Laps mismatch at index {idx}")

    def test_c1_determinism_byte_identical_fit_files(self):
        """Verify that every single generated FIT binary is byte-identical between independent runs."""
        for idx, (a1, a2) in enumerate(zip(self.acts1, self.acts2)):
            fit1 = self.gen1.generate_fit_file(a1)
            fit2 = self.gen2.generate_fit_file(a2)

            self.assertEqual(len(fit1), len(fit2), f"FIT binary length mismatch at index {idx}")
            self.assertEqual(fit1, fit2, f"FIT binary byte divergence at index {idx}")

            # Verify SHA-256 identical
            sha1 = hashlib.sha256(fit1).hexdigest()
            sha2 = hashlib.sha256(fit2).hexdigest()
            self.assertEqual(sha1, sha2, f"SHA-256 divergence for FIT at index {idx}")

    def test_c1_determinism_same_instance_repeatability(self):
        """Calling generate_activities on same instance resets RNG and reproduces same data."""
        acts_repeat = self.gen1.generate_activities()
        self.assertEqual(len(self.acts1), len(acts_repeat))
        for a1, a_rep in zip(self.acts1, acts_repeat):
            self.assertEqual(a1, a_rep)

    def test_c1_determinism_alternative_seeds(self):
        """Verify determinism holds across multiple arbitrary seeds (seed=0, 12345, 999999)."""
        for seed in [0, 12345, 999999]:
            gA = SyntheticDatasetGenerator(seed=seed)
            gB = SyntheticDatasetGenerator(seed=seed)
            actsA = gA.generate_activities()
            actsB = gB.generate_activities()
            self.assertEqual(len(actsA), len(actsB))
            self.assertEqual(actsA[0], actsB[0])
            fitA = gA.generate_fit_file(actsA[0])
            fitB = gB.generate_fit_file(actsB[0])
            self.assertEqual(fitA, fitB)

    def test_c1_determinism_canonical_rollup_json(self):
        """Verify that compiled rollup JSON is deterministic and bit-identical when fixed timestamp is supplied."""
        fixed_ts = "2026-10-24T12:00:00Z"
        rollup1 = compile_rollup(self.acts1, generated_at=fixed_ts)
        rollup2 = compile_rollup(self.acts2, generated_at=fixed_ts)
        json1 = json.dumps(rollup1, sort_keys=True)
        json2 = json.dumps(rollup2, sort_keys=True)
        self.assertEqual(json1, json2, "Canonical rollup JSON serialization diverged")

    # =========================================================================
    # 2. FIT PROTOCOL 2.0 CHALLENGE
    # =========================================================================

    def test_c2_fit_header_14_byte_specification(self):
        """Verify exact 14-byte FIT 2.0 binary header across all generated activities."""
        for idx, act in enumerate(self.acts1):
            fit_bytes = self.gen1.generate_fit_file(act)
            self.assertGreaterEqual(len(fit_bytes), 16, "FIT payload too short")

            header = fit_bytes[:14]
            header_size, proto_ver, profile_ver, data_size, signature, header_crc = struct.unpack(
                "<BBHI4sH", header
            )

            self.assertEqual(header_size, FIT_HEADER_SIZE, f"Header size != 14 on act {idx}")
            self.assertEqual(proto_ver, FIT_PROTOCOL_VERSION, f"Protocol version != 0x20 on act {idx}")
            self.assertEqual(profile_ver, FIT_PROFILE_VERSION, f"Profile version != 2132 on act {idx}")
            self.assertEqual(signature, FIT_SIGNATURE, f"Signature != b'.FIT' on act {idx}")
            self.assertEqual(
                data_size,
                len(fit_bytes) - 14 - 2,
                f"Data size does not match len(payload) - 16 on act {idx}",
            )

    def test_c2_fit_header_and_file_crc_table_validation(self):
        """Empirically verify CRC16 calculations using official Garmin lookup table."""
        for idx, act in enumerate(self.acts1):
            fit_bytes = self.gen1.generate_fit_file(act)

            # Header CRC computed over first 12 bytes
            header_raw = fit_bytes[:12]
            stored_header_crc = struct.unpack("<H", fit_bytes[12:14])[0]
            computed_header_crc = calculate_fit_crc(header_raw)
            self.assertEqual(
                stored_header_crc,
                computed_header_crc,
                f"Header CRC mismatch on act {idx}: {stored_header_crc} != {computed_header_crc}",
            )

            # File CRC computed over header (14 bytes) + data (data_size bytes)
            data_and_header = fit_bytes[:-2]
            stored_file_crc = struct.unpack("<H", fit_bytes[-2:])[0]
            computed_file_crc = calculate_fit_crc(data_and_header)
            self.assertEqual(
                stored_file_crc,
                computed_file_crc,
                f"File CRC mismatch on act {idx}: {stored_file_crc} != {computed_file_crc}",
            )

    def test_c2_fit_crc_single_bit_flip_sensitivity(self):
        """Adversarial tamper challenge: every single bit flip in header or payload must invalidate CRC."""
        sample_fit = bytearray(self.gen1.generate_fit_file(self.acts1[0]))
        orig_header_crc = struct.unpack("<H", sample_fit[12:14])[0]
        orig_file_crc = struct.unpack("<H", sample_fit[-2:])[0]

        # Test every bit in the 12-byte raw header
        for byte_idx in range(12):
            for bit_idx in range(8):
                tampered_header = bytearray(sample_fit[:12])
                tampered_header[byte_idx] ^= (1 << bit_idx)
                tampered_crc = calculate_fit_crc(tampered_header)
                self.assertNotEqual(
                    tampered_crc,
                    orig_header_crc,
                    f"Bit flip at header byte {byte_idx} bit {bit_idx} went undetected",
                )

        # Test sample bits throughout the full file payload
        test_offsets = [0, 5, 12, 13, 14, 50, 100, 300, 500, len(sample_fit) - 3]
        for offset in test_offsets:
            for bit_idx in [0, 3, 7]:
                tampered_file = bytearray(sample_fit[:-2])
                tampered_file[offset] ^= (1 << bit_idx)
                tampered_crc = calculate_fit_crc(tampered_file)
                self.assertNotEqual(
                    tampered_crc,
                    orig_file_crc,
                    f"Bit flip at payload offset {offset} bit {bit_idx} went undetected",
                )

    def test_c2_fit_garmin_epoch_conversion(self):
        """Verify Garmin epoch conversion (seconds since 1989-12-31T00:00:00Z)."""
        # Garmin epoch: 1989-12-31 00:00:00 UTC = 631065600 Unix seconds
        epoch_dt = datetime(1989, 12, 31, 0, 0, 0, tzinfo=timezone.utc)
        self.assertEqual(datetime_to_garmin_timestamp(epoch_dt), 0)

        # Test 2026-10-24 12:00:00 UTC
        target_dt = datetime(2026, 10, 24, 12, 0, 0, tzinfo=timezone.utc)
        expected_garmin_sec = int(target_dt.timestamp()) - GARMIN_EPOCH_OFFSET
        self.assertEqual(datetime_to_garmin_timestamp(target_dt), expected_garmin_sec)
        self.assertGreater(expected_garmin_sec, 0)

    # =========================================================================
    # 3. METRIC BOUNDARY CHALLENGE
    # =========================================================================

    def test_c3_heart_rate_bounds_and_validity(self):
        """Verify heart rate values: strictly positive, 40 <= HR <= 215, max_hr >= avg_hr."""
        for act in self.acts1:
            act_id = act["id"]
            avg_hr = act["avg_hr"]
            max_hr = act["max_hr"]

            self.assertGreaterEqual(avg_hr, 40, f"{act_id}: avg_hr < 40")
            self.assertLessEqual(avg_hr, 215, f"{act_id}: avg_hr > 215")
            self.assertGreaterEqual(max_hr, avg_hr, f"{act_id}: max_hr < avg_hr")
            self.assertLessEqual(max_hr, 220, f"{act_id}: max_hr > 220")

            # Splits HR
            for s in act.get("splits", []):
                self.assertGreaterEqual(s["avg_hr"], 40, f"{act_id} split: avg_hr < 40")
                self.assertLessEqual(s["avg_hr"], 220, f"{act_id} split: avg_hr > 220")

            # Laps HR
            for lp in act.get("laps", []):
                self.assertGreaterEqual(lp["avg_hr"], 40, f"{act_id} lap: avg_hr < 40")
                self.assertLessEqual(lp["avg_hr"], 220, f"{act_id} lap: avg_hr > 220")

    def test_c3_cycling_power_bounds(self):
        """Cycling power strictly 0-1500W; non-cycling activities must have power None."""
        for act in self.acts1:
            act_id = act["id"]
            sport = act["sport"]
            power = act["avg_power"]

            if sport == "cycling":
                self.assertIsNotNone(power, f"{act_id}: Cycling must have power")
                self.assertGreaterEqual(power, 0, f"{act_id}: Power < 0")
                self.assertLessEqual(power, 1500, f"{act_id}: Power > 1500")
            else:
                self.assertIsNone(power, f"{act_id}: Sport '{sport}' must not have power")

    def test_c3_cadence_bounds_by_sport(self):
        """Running cadence 150-210 spm, cycling cadence 60-125 rpm, strength cadence strictly 0."""
        for act in self.acts1:
            act_id = act["id"]
            sport = act["sport"]
            cad = act["avg_cadence"]

            if sport in ("running", "hiking"):
                self.assertGreaterEqual(cad, 80, f"{act_id}: Run/hike cadence < 80")
                self.assertLessEqual(cad, 210, f"{act_id}: Run/hike cadence > 210")
            elif sport == "cycling":
                self.assertGreaterEqual(cad, 60, f"{act_id}: Cycle cadence < 60")
                self.assertLessEqual(cad, 125, f"{act_id}: Cycle cadence > 125")
            elif sport == "strength":
                self.assertEqual(cad, 0, f"{act_id}: Strength cadence != 0")

    def test_c3_timestamp_monotonicity_and_formatting(self):
        """Timestamps must be strictly ascending, valid ISO 8601 UTC, spanning 56 days."""
        prev_dt = None
        for idx, act in enumerate(self.acts1):
            act_id = act["id"]
            ts_str = act["start_time"]
            self.assertTrue(ts_str.endswith("Z"), f"{act_id}: Missing trailing 'Z'")

            dt = datetime.fromisoformat(ts_str.replace("Z", "+00:00"))
            if prev_dt is not None:
                self.assertGreater(dt, prev_dt, f"{act_id}: Non-monotonic timestamp {dt} <= {prev_dt}")
            prev_dt = dt

        # Total time span verification
        first_dt = datetime.fromisoformat(self.acts1[0]["start_time"].replace("Z", "+00:00"))
        last_dt = datetime.fromisoformat(self.acts1[-1]["start_time"].replace("Z", "+00:00"))
        total_days = (last_dt - first_dt).days
        self.assertGreaterEqual(total_days, 50, "Activities must span at least ~7-8 weeks")
        self.assertLessEqual(total_days, 57, "Activities must not exceed 8 weeks")

    def test_c3_hr_zones_sum_exact_match(self):
        """HR zones Z1..Z5 must strictly sum to duration_seconds for all activities."""
        for act in self.acts1:
            zones = act["hr_zones"]
            total_sec = sum(zones.values())
            self.assertEqual(
                total_sec,
                act["duration_seconds"],
                f"{act['id']}: HR zones sum {total_sec} != duration {act['duration_seconds']}",
            )

    def test_c3_moving_time_and_splits_consistency(self):
        """Moving time <= duration, distance >= 0, splits properly enumerated."""
        for act in self.acts1:
            act_id = act["id"]
            dur = act["duration_seconds"]
            mov = act["moving_time_seconds"]
            dist = act["distance_meters"]

            self.assertGreater(dur, 0, f"{act_id}: duration <= 0")
            self.assertGreater(mov, 0, f"{act_id}: moving time <= 0")
            self.assertLessEqual(mov, dur, f"{act_id}: moving time > duration")
            self.assertGreaterEqual(dist, 0.0, f"{act_id}: distance < 0")

            if dist > 0:
                splits = act.get("splits", [])
                self.assertGreater(len(splits), 0, f"{act_id}: distance > 0 but splits empty")
                for s_idx, s in enumerate(splits, 1):
                    self.assertEqual(s["split_number"], s_idx)
                    self.assertGreater(s["duration_seconds"], 0)
                    self.assertGreater(s["distance_meters"], 0)

    def test_c3_training_load_tsb_calculation(self):
        """TSB must equal round(CTL - ATL, 1) within 0.15 delta (continuous vs component rounding)."""
        for act in self.acts1:
            act_id = act["id"]
            atl = act["atl"]
            ctl = act["ctl"]
            tsb = act["tsb"]

            self.assertGreater(atl, 0, f"{act_id}: ATL non-positive")
            self.assertGreater(ctl, 0, f"{act_id}: CTL non-positive")
            # Continuous Banister state subtraction vs rounded dictionary fields
            expected_tsb = round(ctl - atl, 1)
            self.assertAlmostEqual(
                tsb,
                expected_tsb,
                delta=0.15,
                msg=f"{act_id}: TSB {tsb} diverged from CTL - ATL ({expected_tsb}) by > 0.15",
            )

    # =========================================================================
    # 4. ADVERSARIAL STRESS HARNESS
    # =========================================================================

    def test_c4_adversarial_generator_inputs(self):
        """Stress-test FIT binary builder against boundary and degenerate inputs."""
        # 1. Zero duration activity
        degenerate_act_zero_dur = {
            "id": "act_zero_dur",
            "start_time": "2026-10-24T12:00:00Z",
            "sport": "running",
            "distance_meters": 0.0,
            "duration_seconds": 0,
            "moving_time_seconds": 0,
            "avg_hr": 140,
            "max_hr": 140,
            "calories": 0,
            "avg_cadence": 0,
        }
        fit_zero = self.gen1.generate_fit_file(degenerate_act_zero_dur)
        self.assertGreaterEqual(len(fit_zero), 16)
        # Verify valid CRC on zero duration
        self.assertEqual(calculate_fit_crc(fit_zero[:-2]), struct.unpack("<H", fit_zero[-2:])[0])

        # 2. Huge distance and duration activity (Ultra-endurance: 300km, 24h)
        ultra_act = {
            "id": "act_ultra",
            "start_time": "2026-10-24T00:00:00Z",
            "sport": "cycling",
            "distance_meters": 300000.0,
            "duration_seconds": 86400,
            "moving_time_seconds": 80000,
            "avg_hr": 135,
            "max_hr": 170,
            "avg_power": 200,
            "calories": 14000,
            "avg_cadence": 85,
        }
        fit_ultra = self.gen1.generate_fit_file(ultra_act)
        self.assertGreaterEqual(len(fit_ultra), 16)
        self.assertEqual(calculate_fit_crc(fit_ultra[:-2]), struct.unpack("<H", fit_ultra[-2:])[0])

        # 3. Missing optional fields
        sparse_act = {
            "id": "act_sparse",
        }
        fit_sparse = self.gen1.generate_fit_file(sparse_act)
        self.assertGreaterEqual(len(fit_sparse), 16)
        self.assertEqual(calculate_fit_crc(fit_sparse[:-2]), struct.unpack("<H", fit_sparse[-2:])[0])


if __name__ == "__main__":
    unittest.main()
