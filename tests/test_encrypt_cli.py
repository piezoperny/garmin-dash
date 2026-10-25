"""
tests/test_encrypt_cli.py
Unit and integration test suite for src.encryption.encrypt CLI and orchestrator.
"""

import json
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from src.encryption import (
    HEADER_SIZE,
    IV_SIZE,
    KEY_SIZE,
    MIN_WIRE_SIZE,
    PBKDF2_ITERATIONS,
    SALT_SIZE,
    TAG_SIZE,
    AuthenticationError,
    MalformedWireError,
    build_and_encrypt_rollup,
    decrypt_payload,
    derive_key,
    encrypt_payload,
)
from src.encryption.encrypt import main, parse_args


class TestEncryptCLI(unittest.TestCase):
    def setUp(self):
        self.test_dir = tempfile.mkdtemp()
        self.output_enc = Path(self.test_dir) / "data.enc"
        self.sample_passphrase = "test-encrypt-cli-passphrase-2026!"
        self.sample_rollup = {
            "version": "1.0.0",
            "athlete": {"name": "Test Athlete", "vo2max": 55},
            "activities": [
                {"id": "act_1", "sport": "running", "distance_meters": 5000}
            ]
        }

    def tearDown(self):
        if os.path.exists(self.test_dir):
            shutil.rmtree(self.test_dir, ignore_errors=True)

    def test_cli_mock_mode_with_verify(self):
        """Verify mock mode generates valid data.enc and passes roundtrip verification."""
        target = build_and_encrypt_rollup(
            passphrase=self.sample_passphrase,
            output_file=self.output_enc,
            mock=True,
            verify=True,
            iterations=1000,  # accelerated for fast testing
        )
        self.assertTrue(target.exists())
        self.assertGreater(target.stat().st_size, 44)

        # Verify decrypting with master passphrase
        with open(target, "rb") as f:
            wire_bytes = f.read()
        decrypted_raw = decrypt_payload(wire_bytes, self.sample_passphrase, iterations=1000)
        decrypted_dict = json.loads(decrypted_raw.decode("utf-8"))
        self.assertIn("activities", decrypted_dict)
        self.assertGreater(len(decrypted_dict["activities"]), 0)

    def test_cli_from_input_file_and_purge(self):
        """Verify reading from input file and purging input file after encryption."""
        input_file = Path(self.test_dir) / "staging_rollup.json"
        with open(input_file, "w", encoding="utf-8") as f:
            json.dump(self.sample_rollup, f)

        self.assertTrue(input_file.exists())

        target = build_and_encrypt_rollup(
            passphrase=self.sample_passphrase,
            input_file=input_file,
            output_file=self.output_enc,
            verify=True,
            purge_input=True,
            iterations=1000,
        )

        self.assertTrue(target.exists())
        # Input file should be securely purged
        self.assertFalse(input_file.exists())

    def test_cli_no_purge_preserves_input(self):
        """Verify purge_input=False retains the input file."""
        input_file = Path(self.test_dir) / "keep_rollup.json"
        with open(input_file, "w", encoding="utf-8") as f:
            json.dump(self.sample_rollup, f)

        build_and_encrypt_rollup(
            passphrase=self.sample_passphrase,
            input_file=input_file,
            output_file=self.output_enc,
            verify=True,
            purge_input=False,
            iterations=1000,
        )

        self.assertTrue(input_file.exists())

    def test_cli_missing_input_raises_filenotfound(self):
        """Verify non-existent input file raises FileNotFoundError."""
        non_existent = Path(self.test_dir) / "does_not_exist.json"
        with self.assertRaises(FileNotFoundError):
            build_and_encrypt_rollup(
                passphrase=self.sample_passphrase,
                input_file=non_existent,
                output_file=self.output_enc,
                mock=False,
            )

    def test_cli_missing_passphrase_raises_valueerror(self):
        """Verify missing passphrase raises ValueError when mock=False and env var unset."""
        input_file = Path(self.test_dir) / "valid.json"
        with open(input_file, "w", encoding="utf-8") as f:
            json.dump(self.sample_rollup, f)

        with patch.dict(os.environ, {}, clear=True):
            with self.assertRaises(ValueError):
                build_and_encrypt_rollup(
                    passphrase=None,
                    input_file=input_file,
                    output_file=self.output_enc,
                    mock=False,
                )

    def test_cli_reads_passphrase_from_environment(self):
        """Verify DASHBOARD_PASSPHRASE env var is respected."""
        env_pass = "env-secret-passphrase-999!"
        with patch.dict(os.environ, {"DASHBOARD_PASSPHRASE": env_pass}):
            target = build_and_encrypt_rollup(
                passphrase=None,
                output_file=self.output_enc,
                mock=True,
                verify=True,
                iterations=1000,
            )
            self.assertTrue(target.exists())
            with open(target, "rb") as f:
                decrypted = decrypt_payload(f.read(), env_pass, iterations=1000)
            self.assertIn("activities", json.loads(decrypted.decode("utf-8")))

    def test_parse_args_options(self):
        """Verify command-line argument parser handles flags accurately."""
        args = parse_args([
            "--passphrase", "secret123",
            "--input-file", "in.json",
            "--output-file", "out.enc",
            "--mock",
            "--seed", "123",
            "--verify",
            "--no-purge",
            "--iterations", "50000",
        ])
        self.assertEqual(args.passphrase, "secret123")
        self.assertEqual(args.input_file, "in.json")
        self.assertEqual(args.output_file, "out.enc")
        self.assertTrue(args.mock)
        self.assertEqual(args.seed, 123)
        self.assertTrue(args.verify)
        self.assertTrue(args.no_purge)
        self.assertEqual(args.iterations, 50000)

    def test_main_cli_execution_success(self):
        """Verify main() entry point returns 0 on successful run."""
        test_args = [
            "encrypt.py",
            "--mock",
            "--passphrase", "cli-test-pass",
            "--output-file", str(self.output_enc),
            "--verify",
            "--iterations", "1000",
        ]
        with patch.object(sys, "argv", test_args):
            exit_code = main()
            self.assertEqual(exit_code, 0)
            self.assertTrue(self.output_enc.exists())

    def test_package_exports_contract(self):
        """Verify src.encryption exports all specified cryptographic contracts."""
        self.assertEqual(SALT_SIZE, 16)
        self.assertEqual(IV_SIZE, 12)
        self.assertEqual(KEY_SIZE, 32)
        self.assertEqual(TAG_SIZE, 16)
        self.assertEqual(HEADER_SIZE, 28)
        self.assertEqual(MIN_WIRE_SIZE, 44)
        self.assertEqual(PBKDF2_ITERATIONS, 600_000)
        self.assertTrue(issubclass(AuthenticationError, Exception))
        self.assertTrue(issubclass(MalformedWireError, ValueError))


if __name__ == "__main__":
    unittest.main()
