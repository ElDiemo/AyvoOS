"""State machine and durable checkpoints (issue #13, doc 024 §6)."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from night_shift.runstate import RunState, TransitionError

from helpers import T0


class RunStateTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name) / "run"
        self.state = RunState.create(self.dir, run_id="20261014-x", manifest_sha256="0" * 64, parts=["one"], now=T0)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_only_allowed_transitions(self) -> None:
        with self.assertRaises(TransitionError):
            self.state.move("merging", T0)  # skipping implementation, review and CI
        with self.assertRaises(TransitionError):
            self.state.move("deploying", T0)
        self.state.move("implementing", T0)
        self.state.move("blocked", T0, reason="stop")
        with self.assertRaises(TransitionError):
            self.state.move("implementing", T0)  # terminal

    def test_checkpoints_survive_a_restart_and_the_log_is_append_only(self) -> None:
        self.state.move("implementing", T0)
        self.state.record(T0, head="a" * 40)
        loaded = RunState.load(self.dir)
        self.assertEqual(loaded.phase, "implementing")
        self.assertEqual(loaded.part["head"], "a" * 40)
        self.assertEqual([e["event"] for e in loaded.events()], ["created", "moved", "recorded"])
        self.assertEqual(oct(self.dir.stat().st_mode & 0o777), "0o700")
        self.assertEqual(oct((self.dir / "state.json").stat().st_mode & 0o777), "0o600")

    def test_a_run_is_created_once(self) -> None:
        with self.assertRaises(TransitionError):
            RunState.create(self.dir, run_id="20261014-x", manifest_sha256="0" * 64, parts=["one"], now=T0)


if __name__ == "__main__":
    unittest.main()
