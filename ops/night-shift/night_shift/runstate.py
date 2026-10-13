"""Durable state of one approved run (issue #13, doc 024 §6).

Every transition is checkpointed: the current state is written atomically (rename) and an event is
appended to an append-only JSON-lines log, both fsynced. A crashed controller resumes from the
checkpoint; side effects (PR, merge, deploy) are recorded *before* they are attempted ("intent")
and reconciled against GitHub/the deploy log on resume, so they are never duplicated.
"""

from __future__ import annotations

import fcntl
import json
import os
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

PHASES = (
    "queued",
    "implementing",
    "reviewing",
    "ci",
    "merging",
    "merged",
    "deploying",
    "verifying",
    # terminal
    "verified",
    "deployed_unverified",
    "awaiting_owner",
    "blocked",
    "failed",
    "cancelled",
)
TERMINAL = frozenset({"verified", "deployed_unverified", "awaiting_owner", "blocked", "failed", "cancelled"})
STOP = frozenset({"blocked", "failed", "cancelled"})

# Forward transitions; every non-terminal phase may also stop (blocked/failed/cancelled).
TRANSITIONS: dict[str, frozenset[str]] = {
    "queued": frozenset({"implementing"}),
    "implementing": frozenset({"reviewing"}),
    "reviewing": frozenset({"implementing", "ci"}),
    "ci": frozenset({"merging", "awaiting_owner"}),
    "merging": frozenset({"merged"}),
    "merged": frozenset({"implementing", "deploying", "awaiting_owner"}),
    "deploying": frozenset({"verifying"}),
    "verifying": frozenset({"verified", "deployed_unverified"}),
}


class TransitionError(RuntimeError):
    pass


class LockedError(RuntimeError):
    """Another controller holds the run lock (no concurrent shift, merge or deploy)."""


def utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(microsecond=0)


def _fsync_write(path: Path, data: str) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        handle.write(data)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(tmp, path)
    dir_fd = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(dir_fd)
    finally:
        os.close(dir_fd)


class RunState:
    """State file + event log of one run in ``directory`` (mode 700)."""

    def __init__(self, directory: Path, data: dict[str, Any]):
        self.directory = directory
        self.data = data

    # --- persistence -------------------------------------------------------------------------

    @classmethod
    def create(cls, directory: Path, *, run_id: str, manifest_sha256: str, parts: list[str], now: datetime) -> "RunState":
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        if (directory / "state.json").exists():
            raise TransitionError(f"run {run_id} already exists; resume it instead")
        state = cls(
            directory,
            {
                "run_id": run_id,
                "manifest_sha256": manifest_sha256,
                "phase": "queued",
                "part_index": 0,
                "parts": [{"slug": slug} for slug in parts],
                "deploy": {},
                "attempts": {},
                "started_at": now.isoformat(),
                "updated_at": now.isoformat(),
            },
        )
        state._save()
        state._event("created", {"manifest_sha256": manifest_sha256}, now)
        return state

    @classmethod
    def load(cls, directory: Path) -> "RunState":
        with (directory / "state.json").open(encoding="utf-8") as handle:
            data = json.load(handle)
        if not isinstance(data, dict) or data.get("phase") not in PHASES:
            raise TransitionError("corrupt run state")
        return cls(directory, data)

    def _save(self) -> None:
        _fsync_write(self.directory / "state.json", json.dumps(self.data, indent=2, sort_keys=True) + "\n")

    def _event(self, kind: str, details: dict[str, Any], now: datetime) -> None:
        line = json.dumps({"at": now.isoformat(), "event": kind, **details}, sort_keys=True)
        path = self.directory / "events.jsonl"
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
        with os.fdopen(fd, "a", encoding="utf-8") as handle:
            handle.write(line + "\n")
            handle.flush()
            os.fsync(handle.fileno())

    def events(self) -> list[dict[str, Any]]:
        path = self.directory / "events.jsonl"
        if not path.exists():
            return []
        return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line]

    # --- accessors ---------------------------------------------------------------------------

    @property
    def phase(self) -> str:
        return str(self.data["phase"])

    @property
    def part_index(self) -> int:
        return int(self.data["part_index"])

    @property
    def part(self) -> dict[str, Any]:
        return self.data["parts"][self.part_index]

    # --- changes -----------------------------------------------------------------------------

    def record(self, now: datetime, **changes: Any) -> None:
        """Checkpoints facts of the current part (head, review, PR, merge…) without moving."""
        self.part.update(changes)
        self.data["updated_at"] = now.isoformat()
        self._save()
        self._event("recorded", {"part": self.part["slug"], **changes}, now)

    def record_run(self, now: datetime, section: str, **changes: Any) -> None:
        self.data.setdefault(section, {}).update(changes)
        self.data["updated_at"] = now.isoformat()
        self._save()
        self._event("recorded", {"section": section, **changes}, now)

    def count_attempt(self, step: str, now: datetime) -> int:
        attempts = self.data.setdefault("attempts", {})
        attempts[step] = int(attempts.get(step, 0)) + 1
        self.data["updated_at"] = now.isoformat()
        self._save()
        return attempts[step]

    def move(self, phase: str, now: datetime, reason: str | None = None, **details: Any) -> None:
        current = self.phase
        if phase not in PHASES:
            raise TransitionError(f"unknown phase {phase}")
        if current in TERMINAL:
            raise TransitionError(f"run is finished ({current})")
        allowed = TRANSITIONS.get(current, frozenset()) | STOP
        if phase not in allowed:
            raise TransitionError(f"{current} → {phase} is not allowed")
        self.data["phase"] = phase
        self.data["updated_at"] = now.isoformat()
        if reason:
            self.data["reason"] = reason
        self._save()
        self._event("moved", {"from": current, "to": phase, "reason": reason, **details}, now)

    def next_part(self, now: datetime) -> None:
        if self.part_index + 1 >= len(self.data["parts"]):
            raise TransitionError("no further part")
        self.data["part_index"] = self.part_index + 1
        self._save()
        self._event("next_part", {"part": self.part["slug"]}, now)


@contextmanager
def run_lock(path: Path) -> Iterator[None]:
    """One controller at a time for all runs (merge and deploy are global side effects)."""
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd = os.open(path, os.O_RDWR | os.O_CREAT, 0o600)
    try:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise LockedError("another night-shift controller is running") from exc
        yield
    finally:
        os.close(fd)
