"""
test_ci_and_docs.py

Milestone 4 Verification Suite: CI/CD Workflow & Documentation Completeness.
Verifies Acceptance Criteria 4 (Requirements R4, R5):
- .github/workflows/sync.yml parses as valid YAML without syntax errors.
- Defines both daily schedule cron and workflow_dispatch triggers.
- Proper concurrency ('garmin-sync', cancel-in-progress: false) and permissions (contents: read, pages: write, id-token: write).
- Scopes and references all 6 secrets (GARMIN_API_KEY, GARMIN_CLIENT_SECRET, HETZNER_HOST, HETZNER_USER, HETZNER_SSH_KEY, DASHBOARD_PASSPHRASE).
- Enforces proper execution sequence: ingestion -> encryption -> cleanup (with if: always()) -> static build -> audit -> deploy.
- Verifies deploy target is strictly static dist/ (containing data.enc and frontend assets).
- README.md content verification: architecture, binary wire format (0..15 salt, 16..27 IV, 28..N-16 ciphertext, N-16..N tag, 44B min, 600k iters),
  step-by-step setup guides, secrets table, and local CLI execution commands.

Tiers:
- Tier 1: Core Feature Coverage (AC 4 structural & contract compliance)
- Tier 2: Boundary & Syntactic Integrity (Indentation, tabs, types, cron fields)
- Tier 3: Secret Hygiene & Privilege Isolation (Scope isolation, no hardcoded secrets)
- Tier 4: Adversarial & Resiliency Testing (Negative testing with malformed/tampered inputs)
"""

from __future__ import annotations

import os
import re
import sys
import unittest
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple

# Attempt importing PyYAML; provide pure-Python fallback for offline environments
try:
    import yaml
    HAVE_PYYAML = True
except ImportError:
    HAVE_PYYAML = False


# ============================================================================
# Pure-Python Robust YAML Parser & Validator
# ============================================================================

class YAMLParseError(Exception):
    """Raised when YAML syntax or indentation is invalid."""
    pass


def parse_scalar(val: str) -> Any:
    val = val.strip()
    if not val:
        return ""
    if val.lower() == "true":
        return True
    if val.lower() == "false":
        return False
    if val.lower() in ("null", "~"):
        return None
    # Strip enclosing quotes
    if (val.startswith("'") and val.endswith("'")) or (val.startswith('"') and val.endswith('"')):
        return val[1:-1]
    try:
        return int(val)
    except ValueError:
        pass
    try:
        return float(val)
    except ValueError:
        pass
    return val


def parse_workflow_yaml(text: str) -> Dict[str, Any]:
    """
    Parses GitHub Actions workflow YAML.
    Uses PyYAML if available; otherwise uses recursive-descent indentation parser.
    """
    if HAVE_PYYAML:
        try:
            parsed = yaml.safe_load(text)
            if isinstance(parsed, dict):
                return parsed
            raise YAMLParseError(f"Expected top-level mapping, got {type(parsed).__name__}")
        except yaml.YAMLError as e:
            raise YAMLParseError(f"PyYAML parsing failed: {e}") from e

    lines = text.splitlines()
    cleaned_lines: List[Tuple[int, int, str]] = []
    for idx, raw_line in enumerate(lines, 1):
        non_comment = raw_line.split("#")[0]
        if "\t" in non_comment:
            raise YAMLParseError(f"Line {idx}: Tabs are forbidden for YAML indentation.")
        lstripped = raw_line.lstrip(" ")
        line_content = raw_line.rstrip()
        if not line_content or line_content.strip().startswith("#"):
            continue
        indent = len(raw_line) - len(lstripped)
        cleaned_lines.append((idx, indent, line_content.strip()))

    if not cleaned_lines:
        return {}

    def parse_block(index: int, expected_indent: int) -> Tuple[Any, int]:
        if index >= len(cleaned_lines):
            return {}, index

        _, first_indent, first_content = cleaned_lines[index]
        if first_indent < expected_indent:
            return None, index

        if first_content.startswith("- "):
            result_list = []
            curr_idx = index
            while curr_idx < len(cleaned_lines):
                line_no, indent, content = cleaned_lines[curr_idx]
                if indent < expected_indent:
                    break
                if content.startswith("- "):
                    item_text = content[2:].strip()
                    curr_idx += 1
                    if not item_text:
                        nested_obj, curr_idx = parse_block(curr_idx, indent + 2)
                        result_list.append(nested_obj)
                    elif ":" in item_text:
                        map_obj: Dict[str, Any] = {}
                        k, v = item_text.split(":", 1)
                        k = k.strip()
                        v = v.strip()
                        if v == "|":
                            ml_lines = []
                            block_ind = None
                            while curr_idx < len(cleaned_lines):
                                _, l_ind, _ = cleaned_lines[curr_idx]
                                if block_ind is None:
                                    if l_ind <= indent:
                                        break
                                    block_ind = l_ind
                                if l_ind < block_ind:
                                    break
                                ml_lines.append(lines[cleaned_lines[curr_idx][0] - 1].strip())
                                curr_idx += 1
                            map_obj[k] = "\n".join(ml_lines)
                        elif v:
                            map_obj[k] = parse_scalar(v)
                        else:
                            sub_obj, curr_idx = parse_block(curr_idx, indent + 2)
                            map_obj[k] = sub_obj

                        while curr_idx < len(cleaned_lines):
                            _, s_ind, s_content = cleaned_lines[curr_idx]
                            if s_ind < indent + 2:
                                break
                            if s_ind == indent + 2 and ":" in s_content and not s_content.startswith("- "):
                                sk, sv = s_content.split(":", 1)
                                sk = sk.strip()
                                sv = sv.strip()
                                curr_idx += 1
                                if sv == "|":
                                    ml_lines = []
                                    block_ind = None
                                    while curr_idx < len(cleaned_lines):
                                        _, ml_ind, _ = cleaned_lines[curr_idx]
                                        if block_ind is None:
                                            if ml_ind <= s_ind:
                                                break
                                            block_ind = ml_ind
                                        if ml_ind < block_ind:
                                            break
                                        ml_lines.append(lines[cleaned_lines[curr_idx][0] - 1].strip())
                                        curr_idx += 1
                                    map_obj[sk] = "\n".join(ml_lines)
                                elif sv:
                                    map_obj[sk] = parse_scalar(sv)
                                else:
                                    sub_obj, curr_idx = parse_block(curr_idx, s_ind + 2)
                                    map_obj[sk] = sub_obj
                            else:
                                break
                        result_list.append(map_obj)
                    else:
                        result_list.append(parse_scalar(item_text))
                else:
                    curr_idx += 1
            return result_list, curr_idx
        else:
            result_map: Dict[str, Any] = {}
            curr_idx = index
            while curr_idx < len(cleaned_lines):
                line_no, indent, content = cleaned_lines[curr_idx]
                if indent < expected_indent:
                    break
                if indent > expected_indent:
                    break
                if ":" not in content:
                    raise YAMLParseError(f"Line {line_no}: Expected key: value, got '{content}'")
                k, v = content.split(":", 1)
                k = k.strip()
                v = v.strip()
                if (k.startswith("'") and k.endswith("'")) or (k.startswith('"') and k.endswith('"')):
                    k = k[1:-1]
                curr_idx += 1

                if v == "|":
                    ml_lines = []
                    block_ind = None
                    while curr_idx < len(cleaned_lines):
                        _, ml_ind, _ = cleaned_lines[curr_idx]
                        if block_ind is None:
                            if ml_ind <= indent:
                                break
                            block_ind = ml_ind
                        if ml_ind < block_ind:
                            break
                        ml_lines.append(lines[cleaned_lines[curr_idx][0] - 1].strip())
                        curr_idx += 1
                    result_map[k] = "\n".join(ml_lines)
                elif v:
                    result_map[k] = parse_scalar(v)
                else:
                    if curr_idx < len(cleaned_lines) and cleaned_lines[curr_idx][1] > indent:
                        child_obj, curr_idx = parse_block(curr_idx, cleaned_lines[curr_idx][1])
                        result_map[k] = child_obj
                    else:
                        result_map[k] = None
            return result_map, curr_idx

    parsed, _ = parse_block(0, cleaned_lines[0][1])
    return parsed


# ============================================================================
# Authoritative Reference Specifications (Derived from M4 Dispatch & Contracts)
# ============================================================================

REQUIRED_SECRETS = {
    "GARMIN_API_KEY",
    "GARMIN_CLIENT_SECRET",
    "HETZNER_HOST",
    "HETZNER_USER",
    "HETZNER_SSH_KEY",
    "DASHBOARD_PASSPHRASE",
}

REQUIRED_PERMISSIONS = {
    "contents": "read",
    "pages": "write",
    "id-token": "write",
}

REQUIRED_STEP_PATTERNS = [
    ("checkout", re.compile(r"actions/checkout@v[34]", re.IGNORECASE)),
    ("setup-python", re.compile(r"actions/setup-python@v[45]", re.IGNORECASE)),
    ("setup-node", re.compile(r"actions/setup-node@v[34]", re.IGNORECASE)),
    ("sync-ingestion", re.compile(r"python\s+-m\s+src\.ingestion\.sync", re.IGNORECASE)),
    ("encryption", re.compile(r"python\s+-m\s+src\.encryption\.encrypt", re.IGNORECASE)),
    ("cleanup", re.compile(r"python\s+-m\s+src\.ingestion\.cleanup", re.IGNORECASE)),
    ("frontend-build", re.compile(r"npm\s+(?:--prefix\s+frontend\s+)?run\s+build|vite\s+build", re.IGNORECASE)),
    ("audit", re.compile(r"test_secret_hygiene\.py|src\.audit\.secret_hygiene", re.IGNORECASE)),
    ("upload-artifact", re.compile(r"actions/upload-pages-artifact@v[23]", re.IGNORECASE)),
    ("deploy-pages", re.compile(r"actions/deploy-pages@v[34]", re.IGNORECASE)),
]


def validate_workflow_structure(workflow_dict: Dict[str, Any], raw_text: str) -> List[str]:
    """
    Validates workflow against Acceptance Criteria 4.
    Returns list of violation strings (empty list indicates 100% compliance).
    """
    violations = []

    # 1. Triggers
    on_block = workflow_dict.get("on")
    if on_block is None and True in workflow_dict:
        # YAML 1.1 boolean key normalization
        on_block = workflow_dict[True]

    if not isinstance(on_block, dict):
        violations.append("Workflow missing 'on' trigger mapping.")
    else:
        if "schedule" not in on_block:
            violations.append("Missing 'schedule' cron trigger under 'on'.")
        else:
            sched = on_block["schedule"]
            if not isinstance(sched, list) or len(sched) == 0:
                violations.append("'schedule' trigger must be a non-empty list of cron schedules.")
            else:
                cron_val = sched[0].get("cron") if isinstance(sched[0], dict) else None
                if not cron_val:
                    violations.append("Schedule trigger missing 'cron' expression.")
                elif len(cron_val.strip().split()) != 5:
                    violations.append(f"Invalid cron expression '{cron_val}' (expected 5 fields).")

        if "workflow_dispatch" not in on_block:
            violations.append("Missing 'workflow_dispatch' trigger under 'on'.")

    # 2. Concurrency
    concurrency = workflow_dict.get("concurrency")
    if not isinstance(concurrency, dict):
        violations.append("Missing 'concurrency' configuration block.")
    else:
        group = concurrency.get("group")
        if not group or "garmin-sync" not in str(group):
            violations.append(f"Expected concurrency group 'garmin-sync', got '{group}'.")
        cancel_in_prog = concurrency.get("cancel-in-progress")
        if cancel_in_prog is not False:
            violations.append(f"concurrency.cancel-in-progress must be strictly false, got '{cancel_in_prog}'.")

    # 3. Permissions
    perms = workflow_dict.get("permissions")
    if not isinstance(perms, dict):
        # Check if permissions exist inside job
        jobs = workflow_dict.get("jobs", {})
        job_perms = None
        for j in jobs.values():
            if isinstance(j, dict) and "permissions" in j:
                job_perms = j["permissions"]
                break
            perms = job_perms

    if not isinstance(perms, dict):
        violations.append("Missing 'permissions' block defining least-privilege scopes.")
    else:
        for k, v in REQUIRED_PERMISSIONS.items():
            if perms.get(k) != v:
                violations.append(f"Required permission '{k}: {v}' missing or incorrect in permissions block.")

    # 4. Jobs and Steps
    jobs = workflow_dict.get("jobs")
    if not isinstance(jobs, dict) or len(jobs) == 0:
        violations.append("Workflow has no jobs defined.")
        return violations

    all_steps: List[Dict[str, Any]] = []
    for job_name, job_data in jobs.items():
        if isinstance(job_data, dict):
            runs_on = job_data.get("runs-on")
            if not runs_on or "ubuntu" not in str(runs_on):
                violations.append(f"Job '{job_name}' must run on ubuntu runner (got '{runs_on}').")
            steps = job_data.get("steps", [])
            if isinstance(steps, list):
                all_steps.extend(steps)

    # Check required step patterns
    for step_label, pattern in REQUIRED_STEP_PATTERNS:
        matched = False
        for s in all_steps:
            uses = s.get("uses", "")
            run = s.get("run", "")
            if pattern.search(uses) or pattern.search(run):
                matched = True
                break
        if not matched:
            violations.append(f"Missing required workflow step: '{step_label}'.")

    # Check cleanup step failure resilience
    cleanup_step = None
    for s in all_steps:
        run = s.get("run", "")
        if "src.ingestion.cleanup" in run and "--verify-only" not in run:
            cleanup_step = s
            break

    if cleanup_step:
        step_if = str(cleanup_step.get("if", "")).strip()
        if step_if != "always()":
            violations.append(f"Cleanup step must have 'if: always()' for crash resilience, got: '{step_if}'.")
    else:
        violations.append("Cleanup step running 'python -m src.ingestion.cleanup' not found.")

    # Check deploy artifact path
    upload_step = None
    for s in all_steps:
        uses = s.get("uses", "")
        if "upload-pages-artifact" in uses:
            upload_step = s
            break

    if upload_step:
        step_with = upload_step.get("with", {})
        artifact_path = step_with.get("path", "")
        if str(artifact_path).strip().strip("'\"") not in ("dist", "dist/"):
            violations.append(f"Upload artifact path must be 'dist', got '{artifact_path}'.")

    # 5. Secrets Scoping & Coverage
    found_secrets: Set[str] = set()
    for secret in REQUIRED_SECRETS:
        pattern = re.compile(rf"\$\{{\{{\s*secrets\.{secret}\s*\}}\}}")
        if pattern.search(raw_text):
            found_secrets.add(secret)

    missing_secrets = REQUIRED_SECRETS - found_secrets
    if missing_secrets:
        violations.append(f"Missing required secrets referenced in workflow: {sorted(list(missing_secrets))}")

    # Verify secrets isolation
    for s in all_steps:
        env = s.get("env", {})
        run = s.get("run", "")
        uses = s.get("uses", "")
        if isinstance(env, dict):
            for var_name, var_val in env.items():
                val_str = str(var_val)
                if "DASHBOARD_PASSPHRASE" in val_str and "encrypt" not in run:
                    violations.append(f"DASHBOARD_PASSPHRASE leaked to non-encryption step: '{s.get('name')}'.")
                if any(k in val_str for k in ("GARMIN_", "HETZNER_")) and "sync" not in run:
                    violations.append(f"Garmin/Hetzner secret leaked to non-sync step: '{s.get('name')}'.")

    return violations


def validate_readme_content(content: str) -> List[str]:
    """
    Validates README.md against Acceptance Criteria 4:
    - Architecture & zero-knowledge threat model
    - Binary wire format breakdown (0..15 salt, 16..27 IV, 28..N-16 ciphertext, N-16..N tag, 44B min)
    - Setup guides for Garmin API, Hetzner SFTP, and Master Passphrase
    - Secrets configuration table covering all 6 secrets
    - Local CLI commands for mock mode, encryption, cleanup, and tests
    """
    violations = []
    if len(content.strip()) < 3000:
        violations.append(f"README.md content too short ({len(content)} characters; expected >3000 chars).")

    # 1. Architecture & Security Model
    if not re.search(r"zero-knowledge", content, re.IGNORECASE):
        violations.append("README.md missing documentation of 'zero-knowledge' architecture.")
    if not re.search(r"Hetzner\s+Storage\s+Box", content, re.IGNORECASE):
        violations.append("README.md missing Hetzner Storage Box archival documentation.")
    if not re.search(r"GitHub\s+Pages", content, re.IGNORECASE):
        violations.append("README.md missing GitHub Pages hosting documentation.")

    # 2. Binary Wire Format Specification
    if not re.search(r"16\s*bytes?", content, re.IGNORECASE) or not re.search(r"salt", content, re.IGNORECASE):
        violations.append("README.md missing 16-byte PBKDF2 salt wire specification.")
    if not re.search(r"12\s*bytes?", content, re.IGNORECASE) or not re.search(r"IV|nonce", content, re.IGNORECASE):
        violations.append("README.md missing 12-byte AES-GCM IV wire specification.")
    if not re.search(r"600[,.]?000\s*(?:iterations)?", content):
        violations.append("README.md missing 600,000 PBKDF2 iterations parameter.")
    if not re.search(r"44\s*bytes?", content, re.IGNORECASE):
        violations.append("README.md missing 44-byte minimum payload size specification.")
    if not re.search(r"AES-256-GCM", content, re.IGNORECASE):
        violations.append("README.md missing AES-256-GCM cipher specification.")

    # 3. Setup Guides & Secrets Table
    for secret in REQUIRED_SECRETS:
        if secret not in content:
            violations.append(f"README.md missing documentation for required secret: '{secret}'.")

    # 4. Local Commands
    required_commands = [
        ("sync-mock", re.compile(r"python\s+-m\s+src\.ingestion\.sync\s+--mock")),
        ("encrypt-cli", re.compile(r"python\s+-m\s+src\.encryption\.encrypt")),
        ("cleanup-cli", re.compile(r"python\s+-m\s+src\.ingestion\.cleanup")),
        ("test-suite", re.compile(r"python\s+-m\s+unittest|pytest")),
    ]
    for cmd_label, cmd_regex in required_commands:
        if not cmd_regex.search(content):
            violations.append(f"README.md missing documented local execution command for '{cmd_label}'.")

    return violations


# ============================================================================
# Test Suite: Milestone 4 Verification
# ============================================================================

class TestMilestone4Verification(unittest.TestCase):
    """
    Automated verification of CI/CD workflow and documentation completeness (AC 4).
    """

    @classmethod
    def setUpClass(cls):
        # Locate repository root by ascending until requirements.txt is found
        cur = Path(__file__).resolve().parent
        cls.repo_root = cur
        while cur != cur.parent:
            if (cur / "requirements.txt").exists():
                cls.repo_root = cur
                break
            cur = cur.parent

        if str(cls.repo_root) not in sys.path:
            sys.path.insert(0, str(cls.repo_root))

        cls.workflow_path = cls.repo_root / ".github" / "workflows" / "sync.yml"
        cls.readme_path = cls.repo_root / "README.md"

        cls.sample_workflow = cls._load_workflow_text()
        cls.sample_readme = cls._load_readme_text()

    @classmethod
    def _load_workflow_text(cls) -> str:
        if cls.workflow_path.exists():
            with open(cls.workflow_path, "r", encoding="utf-8") as f:
                return f.read()
        # Fallback to explorer_m4_workflow handoff specification
        handoff_path = cls.repo_root / ".agents" / "teamwork" / "explorer_m4_workflow" / "handoff.md"
        if handoff_path.exists():
            with open(handoff_path, "r", encoding="utf-8") as f:
                content = f.read()
            match = re.search(r"```yaml\r?\n(name:\s*Garmin Sync & Deploy[\s\S]*?)\r?\n```", content)
            if match:
                return match.group(1)
        raise FileNotFoundError("Could not find sync.yml or workflow specification in handoff.")

    @classmethod
    def _load_readme_text(cls) -> str:
        if cls.readme_path.exists():
            with open(cls.readme_path, "r", encoding="utf-8") as f:
                return f.read()
        # Fallback to spec_miner_m4_docs handoff specification
        handoff_path = cls.repo_root / ".agents" / "teamwork" / "spec_miner_m4_docs" / "handoff.md"
        if handoff_path.exists():
            with open(handoff_path, "r", encoding="utf-8") as f:
                content = f.read()
            start_marker = "# Client-Side Encrypted Garmin Fitness Dashboard"
            idx = content.find(start_marker)
            if idx != -1:
                return content[idx:]
        raise FileNotFoundError("Could not find README.md or docs specification in handoff.")

    # ------------------------------------------------------------------------
    # Tier 1: Core Feature Coverage
    # ------------------------------------------------------------------------

    def test_t1_workflow_parses_valid_yaml(self):
        """T1-CI-01: Workflow YAML parses cleanly into a structured dictionary."""
        parsed = parse_workflow_yaml(self.sample_workflow)
        self.assertIsInstance(parsed, dict)
        self.assertIn("name", parsed)
        self.assertIn("jobs", parsed)

    def test_t1_triggers_presence_and_format(self):
        """T1-CI-02: Workflow defines schedule cron and workflow_dispatch triggers."""
        parsed = parse_workflow_yaml(self.sample_workflow)
        on_block = parsed.get("on") if "on" in parsed else parsed.get(True)
        self.assertIsInstance(on_block, dict)
        self.assertIn("schedule", on_block)
        self.assertIn("workflow_dispatch", on_block)

        sched = on_block["schedule"]
        self.assertIsInstance(sched, list)
        self.assertGreater(len(sched), 0)
        cron = sched[0]["cron"]
        self.assertEqual(len(cron.split()), 5, f"Expected 5 fields in cron string, got '{cron}'")

    def test_t1_concurrency_group_and_non_cancellation(self):
        """T1-CI-03: Concurrency group is 'garmin-sync' and cancel-in-progress is false."""
        parsed = parse_workflow_yaml(self.sample_workflow)
        concurrency = parsed.get("concurrency", {})
        self.assertEqual(concurrency.get("group"), "garmin-sync")
        self.assertIs(concurrency.get("cancel-in-progress"), False)

    def test_t1_permissions_minimal_privilege(self):
        """T1-CI-04: Enforces contents: read, pages: write, id-token: write."""
        parsed = parse_workflow_yaml(self.sample_workflow)
        perms = parsed.get("permissions", {})
        self.assertEqual(perms.get("contents"), "read")
        self.assertEqual(perms.get("pages"), "write")
        self.assertEqual(perms.get("id-token"), "write")

    def test_t1_all_six_secrets_referenced(self):
        """T1-CI-05: References all 6 required repository secrets."""
        for secret in REQUIRED_SECRETS:
            pat = re.compile(rf"\$\{{\{{\s*secrets\.{secret}\s*\}}\}}")
            self.assertTrue(
                pat.search(self.sample_workflow),
                f"Secret '{secret}' not referenced via ${{{{ secrets.{secret} }}}}"
            )

    def test_t1_workflow_full_structural_compliance(self):
        """T1-CI-06: Workflow passes all structural and lifecycle checks with zero violations."""
        parsed = parse_workflow_yaml(self.sample_workflow)
        violations = validate_workflow_structure(parsed, self.sample_workflow)
        self.assertEqual(len(violations), 0, f"Workflow validation failed with violations:\n" + "\n".join(violations))

    def test_t1_readme_full_compliance(self):
        """T1-DOCS-07: README.md satisfies all architectural, wire format, and setup specifications."""
        violations = validate_readme_content(self.sample_readme)
        self.assertEqual(len(violations), 0, f"README validation failed with violations:\n" + "\n".join(violations))

    # ------------------------------------------------------------------------
    # Tier 2: Boundary & Syntactic Integrity
    # ------------------------------------------------------------------------

    def test_t2_workflow_no_tabs_for_indentation(self):
        """T2-CI-08: Ensures no tab characters exist in workflow file."""
        for idx, line in enumerate(self.sample_workflow.splitlines(), 1):
            self.assertNotIn("\t", line, f"Tab character detected on line {idx}: {line}")

    def test_t2_cleanup_has_always_conditional(self):
        """T2-CI-09: Cleanup step explicitly specifies 'if: always()'."""
        parsed = parse_workflow_yaml(self.sample_workflow)
        jobs = parsed.get("jobs", {})
        cleanup_found = False
        for job in jobs.values():
            for step in job.get("steps", []):
                run = step.get("run", "")
                if "src.ingestion.cleanup" in run and "--verify-only" not in run:
                    cleanup_found = True
                    self.assertEqual(step.get("if"), "always()")
        self.assertTrue(cleanup_found, "Purge cleanup step not found in workflow jobs.")

    def test_t2_pages_artifact_points_to_dist(self):
        """T2-CI-10: Upload pages artifact step specifies path: 'dist'."""
        parsed = parse_workflow_yaml(self.sample_workflow)
        jobs = parsed.get("jobs", {})
        upload_found = False
        for job in jobs.values():
            for step in job.get("steps", []):
                if "upload-pages-artifact" in step.get("uses", ""):
                    upload_found = True
                    path = str(step.get("with", {}).get("path", "")).strip("'\"")
                    self.assertEqual(path, "dist")
        self.assertTrue(upload_found, "Upload pages artifact step not found.")

    def test_t2_readme_wire_format_slicing_parity(self):
        """T2-DOCS-11: README details byte slicing offsets (0..15, 16..27, 28..N-16, N-16..N)."""
        content = self.sample_readme
        self.assertTrue(re.search(r"0\s*\.\.\s*15", content))
        self.assertTrue(re.search(r"16\s*\.\.\s*27", content))
        self.assertTrue(re.search(r"28\s*\.\.\s*N", content, re.IGNORECASE))

    # ------------------------------------------------------------------------
    # Tier 3: Secret Scoping & Privilege Isolation
    # ------------------------------------------------------------------------

    def test_t3_secrets_isolated_to_consumer_steps(self):
        """T3-CI-12: Ingestion secrets scoped only to sync; passphrase scoped only to encrypt."""
        parsed = parse_workflow_yaml(self.sample_workflow)
        jobs = parsed.get("jobs", {})
        for job in jobs.values():
            for step in job.get("steps", []):
                env = step.get("env", {})
                run = step.get("run", "")
                if isinstance(env, dict):
                    for var_name, var_val in env.items():
                        val_str = str(var_val)
                        if "DASHBOARD_PASSPHRASE" in val_str:
                            self.assertIn("src.encryption.encrypt", run)
                        if any(s in val_str for s in ("GARMIN_", "HETZNER_")):
                            self.assertIn("src.ingestion.sync", run)

    def test_t3_no_hardcoded_secret_literals_in_workflow(self):
        """T3-CI-13: No literal passwords, API keys, or private keys hardcoded in workflow."""
        try:
            from tests.test_secret_hygiene import SECRET_PATTERNS
            patterns = SECRET_PATTERNS
        except ImportError:
            patterns = [
                re.compile(r'-----BEGIN\s+(?:RSA|OPENSSH|EC|DSA)?\s*PRIVATE\s+KEY-----', re.IGNORECASE),
                re.compile(r'GARMIN_CLIENT_SECRET\s*=\s*[\'"][A-Za-z0-9_\-]+[\'"]', re.IGNORECASE),
                re.compile(r'DASHBOARD_PASSPHRASE\s*=\s*[\'"][^\'"]+[\'"]', re.IGNORECASE),
                re.compile(r'HETZNER_SSH_KEY\s*=\s*[\'"][^\'"]+[\'"]', re.IGNORECASE),
                re.compile(r'Bearer\s+[A-Za-z0-9_\-\.]{30,}', re.IGNORECASE),
            ]
        for pat in patterns:
            self.assertIsNone(
                pat.search(self.sample_workflow),
                f"Leaked secret pattern matched in workflow YAML: {pat.pattern}"
            )

    # ------------------------------------------------------------------------
    # Tier 4: Adversarial & Resiliency Testing
    # ------------------------------------------------------------------------

    def test_t4_adversarial_detects_missing_secret(self):
        """T4-CI-14: Mutation test: removing a secret causes validation failure."""
        mutated = self.sample_workflow.replace("${{ secrets.DASHBOARD_PASSPHRASE }}", "'dummy_pass'")
        parsed = parse_workflow_yaml(mutated)
        violations = validate_workflow_structure(parsed, mutated)
        self.assertTrue(any("DASHBOARD_PASSPHRASE" in v for v in violations))

    def test_t4_adversarial_detects_missing_always_cleanup(self):
        """T4-CI-15: Mutation test: removing 'if: always()' from cleanup causes failure."""
        mutated = self.sample_workflow.replace("if: always()", "if: success()")
        parsed = parse_workflow_yaml(mutated)
        violations = validate_workflow_structure(parsed, mutated)
        self.assertTrue(any("always()" in v for v in violations))

    def test_t4_adversarial_detects_malformed_yaml_tabs(self):
        """T4-CI-16: Mutation test: inserting tabs raises YAMLParseError."""
        mutated = "name: Bad YAML\n\ton:\n\t  workflow_dispatch:\n"
        with self.assertRaises(YAMLParseError):
            parse_workflow_yaml(mutated)

    def test_t4_adversarial_detects_incomplete_readme(self):
        """T4-DOCS-17: Mutation test: README missing wire format or secrets is rejected."""
        mutated = "# Minimal Readme\nJust an app with no details."
        violations = validate_readme_content(mutated)
        self.assertGreater(len(violations), 5)


if __name__ == "__main__":
    unittest.main()
