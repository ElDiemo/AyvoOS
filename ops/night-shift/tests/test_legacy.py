"""Fixes to the imported live runner (issue #13 inventory)."""

from __future__ import annotations

import unittest
from pathlib import Path
from unittest import mock

from night_shift import legacy


class RunnerLimitsTest(unittest.TestCase):
    def test_cpus_never_exceed_the_host(self) -> None:
        for host, expected in [(1, 1), (2, 2), (3, 2), (4, 3), (16, 4)]:
            with mock.patch("os.cpu_count", return_value=host):
                self.assertEqual(legacy.runner_cpus(), expected, host)

    def test_runner_mounts_only_the_worktree_and_no_secrets(self) -> None:
        argv = legacy.runner_argv(legacy.WORKTREES / "job", include_claude_auth=False)
        joined = " ".join(argv)
        self.assertIn("--read-only", argv)
        self.assertIn("--cap-drop=ALL", argv)
        self.assertNotIn("/opt/ayvo/secrets", joined)
        self.assertNotIn("docker.sock", joined)
        self.assertRegex(joined, r"--cpus=\d+ ")
        with self.assertRaises(legacy.NightShiftError):
            legacy.runner_argv(Path("/opt/ayvo/secrets"))


if __name__ == "__main__":
    unittest.main()


class WorktreeGitTest(unittest.TestCase):
    """Review P0: the controller's git never trusts a `.git` the model can rewrite."""

    def setUp(self) -> None:
        import subprocess
        import tempfile

        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.repo = root / "repo"
        self.worktrees = root / "worktrees"
        self.worktrees.mkdir()
        run = lambda *a, cwd=self.repo: subprocess.run(a, cwd=cwd, check=True, capture_output=True)
        self.repo.mkdir()
        run("git", "init", "-q", "-b", "main")
        run("git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "base")
        self.worktree = self.worktrees / "job"
        run("git", "worktree", "add", "-q", "-b", "night/job", str(self.worktree))
        self.patches = [
            mock.patch.object(legacy, "REPO", self.repo),
            mock.patch.object(legacy, "WORKTREES", self.worktrees),
        ]
        for p in self.patches:
            p.start()

    def tearDown(self) -> None:
        for p in self.patches:
            p.stop()
        self.tmp.cleanup()

    def test_a_replaced_dot_git_is_ignored_and_its_config_never_runs(self) -> None:
        marker = Path(self.tmp.name) / "executed"
        # What a model could leave behind: its own git dir with a command-running config.
        (self.worktree / ".git").unlink()
        fake = self.worktree / ".git"
        (fake / "refs").mkdir(parents=True)
        (fake / "objects").mkdir()
        (fake / "HEAD").write_text("ref: refs/heads/main\n")
        (fake / "config").write_text(
            f"[core]\n\tfsmonitor = touch {marker}\n\thooksPath = {fake}\n"
        )
        (fake / "pre-commit").write_text(f"#!/bin/sh\ntouch {marker}\n")
        (fake / "pre-commit").chmod(0o755)
        (self.worktree / "file.txt").write_text("change\n")
        # The trusted git dir is found from the main repository, not from the worktree.
        self.assertEqual(legacy.trusted_gitdir(self.worktree).parent, self.repo / ".git" / "worktrees")
        status = legacy.wgit(self.worktree, "status", "--porcelain=v1")
        self.assertIn("file.txt", status)
        legacy.wgit(self.worktree, "add", "file.txt")
        legacy.wgit(self.worktree, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "--no-verify", "-q", "-m", "x")
        self.assertFalse(marker.exists())

    def test_a_replaced_dot_git_stops_the_job(self) -> None:
        (self.worktree / ".git").unlink()
        (self.worktree / ".git").mkdir()
        with self.assertRaises(legacy.NightShiftError):
            legacy.validate_changes(self.worktree)

    def test_git_outside_the_worktree_root_is_refused(self) -> None:
        with self.assertRaises(legacy.NightShiftError):
            legacy.trusted_gitdir(self.repo)
