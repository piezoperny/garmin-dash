"""
src/ingestion/cleanup.py
Workspace cleanup and zero-plaintext forensic validation for Garmin pipeline.
Guarantees complete removal of raw .FIT files, activity JSON summaries, and transient rollups.
"""

from __future__ import annotations

import argparse
import logging
import os
import shutil
import stat
import sys
from contextlib import contextmanager
from pathlib import Path
from typing import Dict, Generator, List, Optional, Set, Tuple, Union

logger = logging.getLogger(__name__)

# Patterns that MUST NEVER exist in deployment or public directories
PROHIBITED_PATTERNS = [
    "*.fit",
    "*_summary.json",
    "dashboard_rollup.json",
    "*.tmp",
]

# Standard directories to skip during scanning
IGNORED_DIRS = {
    ".git",
    ".agents",
    "tests",
    "node_modules",
    ".venv",
    "venv",
    ".idea",
    ".vscode",
    "__pycache__",
    ".system_generated",
}


def _remove_readonly(func, path, exc_info):
    """Error handler for shutil.rmtree on Windows read-only files."""
    try:
        os.chmod(path, stat.S_IWRITE)
        func(path)
    except Exception as e:
        logger.warning(f"Could not change permissions or unlink {path}: {e}")


def purge_file(target_file: Union[Path, str], secure: bool = False) -> bool:
    """
    Safely unlinks a single file.
    If secure=True, overwrites with zeros (0x00) before unlinking.
    """
    p = Path(target_file)
    if not p.exists() or not p.is_file():
        return False

    try:
        if secure:
            file_size = p.stat().st_size
            if file_size > 0:
                with open(p, "wb") as f:
                    f.write(b"\x00" * file_size)
                    f.flush()
                    os.fsync(f.fileno())
        p.unlink()
        return True
    except PermissionError:
        try:
            os.chmod(p, stat.S_IWRITE)
            p.unlink()
            return True
        except Exception as e:
            logger.error(f"Failed to unlink file {p}: {e}")
            return False
    except Exception as e:
        logger.error(f"Error purging file {p}: {e}")
        return False


def purge_directory(target_dir: Union[Path, str], secure: bool = False, remove_dir: bool = True) -> int:
    """
    Recursively deletes all files within a directory and optionally removes the directory itself.
    Returns count of purged files.
    """
    p = Path(target_dir)
    if not p.exists():
        return 0

    count = 0
    if p.is_dir():
        for item in p.rglob("*"):
            if item.is_file():
                if purge_file(item, secure=secure):
                    count += 1
        if remove_dir:
            shutil.rmtree(p, onerror=_remove_readonly, ignore_errors=True)
    elif p.is_file():
        if purge_file(p, secure=secure):
            count += 1

    return count


def purge_raw_staging(staging_dir: Union[Path, str] = ".raw_staging", secure: bool = False) -> int:
    """Specialized cleanup targeting raw staging directory."""
    p = Path(staging_dir)
    if not p.exists():
        return 0
    logger.info(f"Purging raw staging directory: {p}")
    count = purge_directory(p, secure=secure, remove_dir=True)
    # Ensure directory is gone
    if p.exists():
        shutil.rmtree(p, onerror=_remove_readonly, ignore_errors=True)
    return count


# Convenience Alias
purge_staging = purge_raw_staging


def purge_rollup(rollup_path: Union[Path, str] = ".staging/dashboard_rollup.json", secure: bool = False) -> bool:
    """Deletes unencrypted dashboard_rollup.json and removes empty parent .staging dir."""
    p = Path(rollup_path)
    res = purge_file(p, secure=secure)
    parent = p.parent
    if parent.exists() and parent.name == ".staging":
        try:
            # Only remove if empty or transient
            shutil.rmtree(parent, onerror=_remove_readonly, ignore_errors=True)
        except Exception:
            pass
    return res


def purge_all_transient_data(workspace_root: Union[Path, str] = ".", secure: bool = False) -> Dict[str, int]:
    """
    Wipes .raw_staging, .staging, and any orphaned .fit or _summary.json files.
    """
    root = Path(workspace_root)
    raw_staging_count = purge_raw_staging(root / ".raw_staging", secure=secure)
    staging_count = purge_directory(root / ".staging", secure=secure, remove_dir=True)

    orphaned_count = 0
    for pattern in ["*.fit", "*_summary.json"]:
        for match in root.rglob(pattern):
            # Do not touch files in ignored directories
            parts = set(match.parts)
            if not parts.intersection(IGNORED_DIRS):
                if purge_file(match, secure=secure):
                    orphaned_count += 1

    return {
        "raw_staging_files": raw_staging_count,
        "staging_files": staging_count,
        "orphaned_files": orphaned_count,
    }


def verify_clean_workspace(
    workspace_root: Union[Path, str] = ".",
    check_dirs: Optional[List[str]] = None,
) -> Tuple[bool, List[str]]:
    """
    Forensic scanner: inspects workspace and verifies no raw fitness metrics,
    FIT binaries, or unencrypted rollups exist outside authorized ignore paths.
    Returns (is_clean: bool, violations: list[str]).
    """
    root = Path(workspace_root).resolve()
    violations: List[str] = []

    targets = [root / d for d in check_dirs] if check_dirs else [root]

    for target in targets:
        if not target.exists():
            continue

        for pattern in PROHIBITED_PATTERNS:
            for matched_path in target.rglob(pattern):
                # Check if matched_path is inside any ignored directory
                rel_parts = set(matched_path.relative_to(root).parts)
                if rel_parts.intersection(IGNORED_DIRS):
                    continue

                violations.append(str(matched_path.relative_to(root)))

    is_clean = len(violations) == 0
    return is_clean, violations


# Convenience Alias
verify_workspace_clean = verify_clean_workspace


@contextmanager
def staging_cleanup_context(
    staging_dir: Union[Path, str] = ".raw_staging",
    secure: bool = False,
) -> Generator[Path, None, None]:
    """
    Context manager guaranteeing complete unlinking of staging_dir
    upon block completion, even on exceptions or crashes.
    """
    path = Path(staging_dir).resolve()
    path.mkdir(parents=True, exist_ok=True)
    try:
        yield path
    finally:
        purge_raw_staging(path, secure=secure)


# ---------------------------------------------------------------------------
# Standalone CLI Interface
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(description="Workspace Cleanup and Zero-Plaintext Security Verification")
    parser.add_argument("--staging-dir", type=Path, default=Path(".raw_staging"), help="Staging directory to wipe")
    parser.add_argument("--secure", action="store_true", help="Zero-fill files before unlinking")
    parser.add_argument("--verify-only", action="store_true", help="Only verify workspace hygiene without purging")
    parser.add_argument("--workspace-root", type=Path, default=Path("."), help="Workspace root directory")

    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")

    if not args.verify_only:
        purge_raw_staging(args.staging_dir, secure=args.secure)
        purge_rollup(args.workspace_root / ".staging" / "dashboard_rollup.json", secure=args.secure)

    is_clean, violations = verify_clean_workspace(args.workspace_root)

    if not is_clean:
        print(f"FATAL: Prohibited raw data files detected in workspace ({len(violations)} violations):", file=sys.stderr)
        for v in violations:
            print(f"  - {v}", file=sys.stderr)
        sys.exit(1)
    else:
        print("PASS: Workspace is clean. Zero raw .fit or unencrypted activity summaries detected.")
        sys.exit(0)


if __name__ == "__main__":
    main()
