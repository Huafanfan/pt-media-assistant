#!/usr/bin/env python3
"""Offline behavior tests for deploy/pt-media-assistant-nas-recover.sh.

Run with:
    PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s test/operations -p 'test_*.py' -v

The harness runs a temporary copy of the production script with its constant
assignments redirected into a temporary directory. Fake commands
record all Docker/logger/flock interactions; no Docker daemon, SSH, or NAS is
used. flock is mocked so lock contention is portable to macOS, which does not
ship the util-linux flock command. A no-op sleep keeps bounded() probes fast;
each shell invocation still has a subprocess timeout as a test safety net.
"""

from __future__ import annotations

import os
from pathlib import Path
import re
import shlex
import stat
import subprocess
import sys
import tempfile
import unittest


REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT = REPO_ROOT / "deploy" / "pt-media-assistant-nas-recover.sh"
INSPECT_FORMAT = (
    "{{.State.Status}}|{{.HostConfig.RestartPolicy.Name}}|{{.State.Error}}"
)


class RecoveryHarness:
    """A single isolated script copy and its fake host-side dependencies."""

    def __init__(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix="nas-recovery-test-")
        self.root = Path(self.temp.name)
        self.state_dir = self.root / "fake-state"
        self.bin_dir = self.root / "bin"
        self.nas_dir = self.root / "mnt" / "nas"
        self.sentinel = self.nas_dir / "pt" / ".pt-media-assistant-mounted"
        self.mounts_file = self.root / "proc" / "mounts"
        self.lock_file = self.root / "var" / "lock" / "nas-recover.lock"
        self.disable_file = self.root / "srv" / "app" / "nas-recover.disabled"
        self.health_script = self.root / "etc" / "init.d" / "zspace-nas"
        self.script_copy = self.root / "nas-recover.sh"

        self.state_dir.mkdir(parents=True)
        self.bin_dir.mkdir()
        self.nas_dir.mkdir(parents=True)
        self.lock_file.parent.mkdir(parents=True)
        self.sentinel.parent.mkdir(parents=True, exist_ok=True)
        self.sentinel.write_text("mounted\n", encoding="utf-8")
        self.mounts_file.parent.mkdir(parents=True)
        self.set_mounts(cifs=True)
        (self.state_dir / "inspect-result").write_text(
            self.valid_inspect_result(), encoding="utf-8"
        )
        (self.state_dir / "docker-inspect-exit").write_text("0", encoding="utf-8")
        (self.state_dir / "docker-start-exit").write_text("0", encoding="utf-8")
        (self.state_dir / "flock-exit").write_text("0", encoding="utf-8")
        self._write_executable(
            self.health_script,
            "#!/bin/sh\n"
            "printf '%s\\n' \"$*\" >> \"$FAKE_STATE_DIR/nas-health.log\"\n"
            "if [ \"${FAKE_TOUCH_DISABLE:-0}\" = 1 ]; then touch \"$FAKE_DISABLE_FILE\"; fi\n"
            "if [ -n \"${FAKE_INSPECT_RESULT_AFTER_HEALTH:-}\" ]; then\n"
            "    printf '%s\\n' \"$FAKE_INSPECT_RESULT_AFTER_HEALTH\" > \"$FAKE_STATE_DIR/inspect-result\"\n"
            "fi\n"
            "exit \"${FAKE_NAS_HEALTH_EXIT:-0}\"\n",
        )
        self._write_fake_commands()
        self._make_script_copy()

    def close(self) -> None:
        self.temp.cleanup()

    @property
    def sentinel_path(self) -> str:
        return str(self.sentinel)

    def valid_inspect_result(self, status: str = "exited", policy: str = "unless-stopped") -> str:
        error = (
            f'error mounting "{self.sentinel_path}" on '
            "/var/lib/docker/overlay2/mount: no such file or directory"
        )
        return f"{status}|{policy}|{error}"

    def set_inspect_result(
        self,
        status: str = "exited",
        policy: str = "unless-stopped",
        error: str | None = None,
    ) -> None:
        if error is None:
            result = self.valid_inspect_result(status=status, policy=policy)
        else:
            result = f"{status}|{policy}|{error}"
        (self.state_dir / "inspect-result").write_text(result, encoding="utf-8")

    def set_mounts(self, *, cifs: bool, target: str | None = None) -> None:
        fstype = "cifs" if cifs else "ext4"
        if target is None:
            target = str(self.nas_dir)
        self.mounts_file.write_text(
            f"//nas/share {target} {fstype} rw,relatime 0 0\n", encoding="utf-8"
        )

    def _write_executable(self, path: Path, content: str) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
        path.chmod(path.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)

    def _write_fake_commands(self) -> None:
        self._write_executable(
            self.bin_dir / "docker",
            "#!/bin/sh\n"
            "{\n"
            "    printf '%s\\n' \"$#\"\n"
            "    for arg do printf '%s\\n' \"$arg\"; done\n"
            "    printf '\\n'\n"
            "} >> \"$FAKE_STATE_DIR/docker.log\"\n"
            "case \"$1\" in\n"
            "    inspect)\n"
            "        cat \"$FAKE_STATE_DIR/inspect-result\"\n"
            "        exit \"$(cat \"$FAKE_STATE_DIR/docker-inspect-exit\")\"\n"
            "        ;;\n"
            "    start) exit \"$(cat \"$FAKE_STATE_DIR/docker-start-exit\")\" ;;\n"
            "    *) exit 97 ;;\n"
            "esac\n",
        )
        self._write_executable(
            self.bin_dir / "logger",
            "#!/bin/sh\n"
            "printf '%s\\n' \"$*\" >> \"$FAKE_STATE_DIR/logger.log\"\n",
        )
        self._write_executable(
            self.bin_dir / "flock",
            "#!/bin/sh\n"
            "printf '%s\\n' \"$*\" >> \"$FAKE_STATE_DIR/flock.log\"\n"
            "exit \"$(cat \"$FAKE_STATE_DIR/flock-exit\")\"\n",
        )
        self._write_executable(
            self.bin_dir / "sleep",
            f"#!{sys.executable}\nimport time\ntime.sleep(0.005)\n",
        )

    def _make_script_copy(self) -> None:
        source = SCRIPT.read_text(encoding="utf-8")
        replacements = {
            "CONTAINER": "pt-media-assistant",
            "NAS_MOUNT": str(self.nas_dir),
            "SENTINEL": self.sentinel_path,
            "MOUNTS_FILE": str(self.mounts_file),
            "LOCK_FILE": str(self.lock_file),
            "NAS_HEALTH": str(self.health_script),
            "DISABLE_FILE": str(self.disable_file),
        }
        for name, value in replacements.items():
            assignment = re.compile(rf"^{re.escape(name)}=.*$", re.MULTILINE)
            source, count = assignment.subn(f"{name}={shlex.quote(value)}", source, count=1)
            if count != 1:
                raise AssertionError(f"Expected one top-level {name}= assignment in recovery script")
        self.script_copy.write_text(source, encoding="utf-8")
        self.script_copy.chmod(0o755)

    def run_script(self, **overrides: str) -> subprocess.CompletedProcess[str]:
        if "FAKE_START_EXIT" in overrides:
            (self.state_dir / "docker-start-exit").write_text(
                overrides["FAKE_START_EXIT"], encoding="utf-8"
            )
        env = os.environ.copy()
        env.update(
            {
                "PATH": f"{self.bin_dir}{os.pathsep}{env.get('PATH', '')}",
                "FAKE_STATE_DIR": str(self.state_dir),
                "FAKE_DISABLE_FILE": str(self.disable_file),
                "FAKE_NAS_HEALTH_EXIT": "0",
                "LC_ALL": "C",
            }
        )
        env.update(overrides)
        return subprocess.run(
            ["/bin/sh", str(self.script_copy)],
            cwd=self.root,
            env=env,
            text=True,
            capture_output=True,
            timeout=10,
            check=False,
        )

    def docker_calls(self) -> list[list[str]]:
        log = self.state_dir / "docker.log"
        if not log.exists():
            return []
        records: list[list[str]] = []
        for block in log.read_text(encoding="utf-8").strip().split("\n\n"):
            if not block:
                continue
            lines = block.splitlines()
            count = int(lines[0])
            self.assert_record_size(lines, count)
            records.append(lines[1:])
        return records

    @staticmethod
    def assert_record_size(lines: list[str], count: int) -> None:
        if len(lines) != count + 1:
            raise AssertionError(f"Malformed fake Docker record: {lines!r}")

    def starts(self) -> list[list[str]]:
        return [call for call in self.docker_calls() if call and call[0] == "start"]


class NASRecoveryTests(unittest.TestCase):
    def setUp(self) -> None:
        self.harness = RecoveryHarness()

    def tearDown(self) -> None:
        self.harness.close()

    def assert_no_start(self) -> None:
        self.assertEqual(self.harness.starts(), [])

    def test_exited_and_created_matching_bind_failures_start_once(self) -> None:
        for status in ("exited", "created"):
            with self.subTest(status=status):
                log = self.harness.state_dir / "docker.log"
                log.unlink(missing_ok=True)
                self.harness.set_inspect_result(status=status)

                result = self.harness.run_script()

                self.assertEqual(result.returncode, 0, result.stderr)
                starts = self.harness.starts()
                self.assertEqual(starts, [["start", "pt-media-assistant"]])
                inspect_calls = [call for call in self.harness.docker_calls() if call[0] == "inspect"]
                self.assertEqual(len(inspect_calls), 2)
                self.assertEqual(
                    inspect_calls[0],
                    ["inspect", "--format", INSPECT_FORMAT, "pt-media-assistant"],
                )

    def test_noneligible_docker_states_and_errors_are_skipped(self) -> None:
        skip_cases = (
            ("running", "unless-stopped", None),
            ("healthy", "unless-stopped", None),
            ("restarting", "unless-stopped", None),
            ("paused", "unless-stopped", None),
            ("exited", "unless-stopped", ""),  # manual stop has no error
            ("created", "unless-stopped", ""),  # manual stop must not be retried either
            ("exited", "unless-stopped", "unrelated Docker mount failure"),
            ("exited", "no", None),
        )
        for status, policy, error in skip_cases:
            with self.subTest(status=status, policy=policy, error=error):
                (self.harness.state_dir / "docker.log").unlink(missing_ok=True)
                self.harness.set_inspect_result(status, policy, error)
                result = self.harness.run_script()
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assert_no_start()

        with self.subTest(reason="inspect failure"):
            (self.harness.state_dir / "docker.log").unlink(missing_ok=True)
            (self.harness.state_dir / "docker-inspect-exit").write_text("42", encoding="utf-8")
            self.harness.set_inspect_result()
            result = self.harness.run_script()
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assert_no_start()

    def test_nas_mount_health_and_sentinel_are_all_required(self) -> None:
        cases = ("no mount", "nearby mount path", "non-cifs mount", "health failure", "missing sentinel", "sentinel is directory")
        for reason in cases:
            with self.subTest(reason=reason):
                (self.harness.state_dir / "docker.log").unlink(missing_ok=True)
                self.harness.set_inspect_result()
                self.harness.set_mounts(cifs=True)
                self.harness.sentinel.unlink(missing_ok=True)
                self.harness.sentinel.parent.mkdir(parents=True, exist_ok=True)
                self.harness.sentinel.write_text("mounted\n", encoding="utf-8")
                health_exit = "0"

                if reason == "no mount":
                    self.harness.mounts_file.write_text("", encoding="utf-8")
                elif reason == "nearby mount path":
                    self.harness.set_mounts(cifs=True, target=f"{self.harness.nas_dir}-backup")
                elif reason == "non-cifs mount":
                    self.harness.set_mounts(cifs=False)
                elif reason == "health failure":
                    self.harness.sentinel.write_text("mounted\n", encoding="utf-8")
                    health_exit = "1"
                elif reason == "missing sentinel":
                    self.harness.sentinel.unlink()
                elif reason == "sentinel is directory":
                    self.harness.sentinel.unlink()
                    self.harness.sentinel.mkdir()

                result = self.harness.run_script(FAKE_NAS_HEALTH_EXIT=health_exit)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assert_no_start()

    def test_unreadable_sentinel_is_skipped_when_permissions_are_enforced(self) -> None:
        self.harness.sentinel.chmod(0)
        if os.access(self.harness.sentinel, os.R_OK):
            self.skipTest("current user can read mode-000 files, so readability cannot be simulated")

        result = self.harness.run_script()

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assert_no_start()

    def test_retry_after_nas_prerequisite_becomes_ready(self) -> None:
        self.harness.mounts_file.write_text("", encoding="utf-8")
        first = self.harness.run_script()
        self.assertEqual(first.returncode, 0, first.stderr)
        self.assert_no_start()

        self.harness.set_mounts(cifs=True)
        second = self.harness.run_script()

        self.assertEqual(second.returncode, 0, second.stderr)
        self.assertEqual(self.harness.starts(), [["start", "pt-media-assistant"]])

    def test_maintenance_file_created_during_health_probe_prevents_start(self) -> None:
        self.harness.disable_file.parent.mkdir(parents=True)
        result = self.harness.run_script(FAKE_TOUCH_DISABLE="1")

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(self.harness.disable_file.is_file())
        self.assert_no_start()

    def test_changed_docker_state_or_error_before_final_inspect_is_skipped(self) -> None:
        changed_results = (
            ("state changed", self.harness.valid_inspect_result(status="running")),
            ("error changed", "exited|unless-stopped|operator stop"),
        )
        for reason, changed_result in changed_results:
            with self.subTest(reason=reason):
                (self.harness.state_dir / "docker.log").unlink(missing_ok=True)
                self.harness.set_inspect_result()

                result = self.harness.run_script(
                    FAKE_INSPECT_RESULT_AFTER_HEALTH=changed_result
                )

                self.assertEqual(result.returncode, 0, result.stderr)
                inspect_calls = [call for call in self.harness.docker_calls() if call[0] == "inspect"]
                self.assertEqual(len(inspect_calls), 2)
                self.assert_no_start()

    def test_failed_start_returns_nonzero_and_next_invocation_retries(self) -> None:
        first = self.harness.run_script(FAKE_START_EXIT="1")

        self.assertNotEqual(first.returncode, 0)
        self.assertEqual(self.harness.starts(), [["start", "pt-media-assistant"]])

        second = self.harness.run_script(FAKE_START_EXIT="0")

        self.assertEqual(second.returncode, 0, second.stderr)
        self.assertEqual(
            self.harness.starts(),
            [["start", "pt-media-assistant"], ["start", "pt-media-assistant"]],
        )

    def test_flock_contention_skips_the_invocation(self) -> None:
        (self.harness.state_dir / "flock-exit").write_text("1", encoding="utf-8")

        result = self.harness.run_script()

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.harness.state_dir / "flock.log").read_text().splitlines(), ["-n 9"])
        self.assertEqual(self.harness.docker_calls(), [])

    def test_maintenance_disable_file_skips_recovery(self) -> None:
        self.harness.disable_file.parent.mkdir(parents=True)
        self.harness.disable_file.touch()

        result = self.harness.run_script()

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.harness.docker_calls(), [])


if __name__ == "__main__":
    unittest.main()
