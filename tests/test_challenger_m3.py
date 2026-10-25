"""
tests/test_challenger_m3.py

Milestone 3 Adversarial Challenger Empirical Test Suite:
Frontend Authentication Flow, Session Lifecycle & Cryptographic Tamper Resistance.

Invokes Node.js Web Crypto & Headless DOM simulation suite:
- Initial lock blocks chart rendering and displays modal.
- Invalid passphrase rejection & authentication error states.
- Bit-flipped tamper rejection across all 4 wire slices (Salt, IV, Ciphertext, Tag).
- Valid unlock, Web Crypto 600k PBKDF2 iterations, AES-GCM decryption, 3 visualization sections.
- Tab reload bypass via sessionStorage (full session and raw AES key alone).
- Lock Vault button session key purge and modal re-lock.
- Adversarial edge cases: corrupted sessionStorage keys, tampered payloads on reload, race prevention.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import unittest
from pathlib import Path


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
CHALLENGER_M3_JS = str(Path(__file__).parent / "test_challenger_m3.js")


class TestChallengerM3FrontendAuthLifecycle(unittest.TestCase):
    """Empirical Challenger Test Suite for Milestone 3."""

    def test_frontend_auth_and_session_lifecycle(self):
        """Executes full 33-test empirical challenger suite against frontend and dist/ assets."""
        self.assertTrue(os.path.exists(CHALLENGER_M3_JS), f"Challenger JS suite missing: {CHALLENGER_M3_JS}")

        proc = subprocess.run(
            [NODE_BINARY, CHALLENGER_M3_JS],
            capture_output=True,
            text=True,
            timeout=120,
            cwd=str(Path(__file__).parent.parent)
        )

        # Print test stdout/stderr for full audit visibility
        if proc.stdout:
            print(proc.stdout)
        if proc.stderr:
            print(proc.stderr)

        self.assertEqual(
            proc.returncode,
            0,
            f"Challenger empirical test suite failed with code {proc.returncode}:\n{proc.stderr}"
        )
        self.assertIn("33 PASSED, 0 FAILED", proc.stdout)
        self.assertIn("Verdict: CONFIRMED", proc.stdout)


if __name__ == "__main__":
    unittest.main()
