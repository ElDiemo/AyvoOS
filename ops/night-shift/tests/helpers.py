"""Fakes for the end-to-end pipeline tests: GitHub, git, the model worker and the DEV deployer."""

from __future__ import annotations

import hashlib
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any

from night_shift.gates import PullRequest
from night_shift.manifest import SCHEMA, parse
from night_shift.pipeline import DeployResult, ReviewResult, SmokeResult

T0 = datetime(2026, 10, 14, 20, 30, tzinfo=timezone.utc)
BASE = "a" * 40


def sha(label: str) -> str:
    return hashlib.sha1(label.encode()).hexdigest()


def raw_manifest(**overrides: Any) -> dict[str, Any]:
    raw: dict[str, Any] = {
        "schema": SCHEMA,
        "run_id": "20261014-catalog-ui",
        "repository": "ElDiemo/AyvoOS",
        "feature": {"issue": 15, "title": "Catalogue admin UI", "brief_sha256": "b" * 64},
        "base_commit": BASE,
        "parts": [
            {"slug": "catalog-ui-list", "title": "Catalogue list", "task_sha256": "c" * 64, "risk": "normal"}
        ],
        "scope": {"allowed_paths": ["apps/web/**", "docs/**"], "forbidden_paths": []},
        "migrations": {"allowed": False, "max_new": 0, "destructive": False},
        "permissions": {"allow_merge": True, "allow_deploy_dev": True},
        "ci": {"required_checks": ["quality", "test", "e2e"]},
        "acceptance": ["Katalog komponent je vidět v menu Výroba"],
        "budget": {"max_minutes": 480, "max_repair_rounds": 1, "max_attempts_per_step": 2},
        "target": {"environment": "dev-preview", "url": "https://dev.ayvo.co"},
        "valid_from": "2026-10-14T18:00:00+00:00",
        "valid_until": "2026-10-15T08:00:00+00:00",
    }
    raw.update(overrides)
    return raw


def manifest(**overrides: Any):
    return parse(raw_manifest(**overrides))


class Clock:
    def __init__(self, start: datetime = T0):
        self.t = start

    def now(self) -> datetime:
        return self.t

    def sleep(self, seconds: float) -> None:
        self.t += timedelta(seconds=seconds)


GREEN = {"status": "completed", "conclusion": "success"}


@dataclass
class FakeRepo:
    """main, branches, commits with parents and changed paths."""

    main: str = BASE
    parents_of: dict[str, list[str]] = field(default_factory=dict)
    paths: dict[tuple[str, str], list[str]] = field(default_factory=dict)
    default_paths: list[str] = field(default_factory=lambda: ["apps/web/src/app/page.tsx"])

    def remote_main(self) -> str:
        return self.main

    def changed_paths(self, base: str, head: str) -> list[str]:
        return list(self.paths.get((base, head), self.default_paths))

    def parents(self, commit: str) -> list[str]:
        return list(self.parents_of.get(commit, []))


class FakeGitHub:
    def __init__(self, repo: FakeRepo):
        self.repo = repo
        self.prs: dict[int, PullRequest] = {}
        self.checks_by_sha: dict[str, dict[str, dict[str, Any]]] = {}
        self.ruleset = True
        self.merges: list[int] = []
        self.created: list[str] = []
        self.comments: list[tuple[int, str]] = []
        self.red: set[str] = set()
        self.pending_polls = 0

    def _checks(self, sha: str) -> dict[str, dict[str, Any]]:
        conclusion = "failure" if sha in self.red else "success"
        return {
            name: {"head_sha": sha, "status": "completed", "conclusion": conclusion}
            for name in ("quality", "test", "e2e")
        }

    def find_pr(self, branch: str) -> PullRequest | None:
        return next((p for p in self.prs.values() if p.head_ref == branch), None)

    def create_pr(self, *, branch: str, title: str, body: str) -> int:
        number = 100 + len(self.prs)
        head = self.branch_heads[branch]
        self.prs[number] = PullRequest(number, "OPEN", branch, head, "main")
        self.created.append(branch)
        return number

    branch_heads: dict[str, str] = {}

    def pr(self, number: int) -> PullRequest:
        return self.prs[number]

    def checks(self, sha: str) -> dict[str, dict[str, Any]]:
        if self.pending_polls:
            self.pending_polls -= 1
            return {n: {"head_sha": sha, "status": "in_progress", "conclusion": None} for n in ("quality", "test", "e2e")}
        return self._checks(sha)

    def ruleset_active(self) -> bool:
        return self.ruleset

    def merge(self, number: int) -> None:
        pr = self.prs[number]
        merge = sha(f"merge-{pr.head_sha}")
        self.repo.parents_of[merge] = [self.repo.main, pr.head_sha]
        self.repo.main = merge
        self.prs[number] = PullRequest(number, "MERGED", pr.head_ref, pr.head_sha, "main", merge)
        self.merges.append(number)

    def comment(self, number: int, body: str) -> None:
        self.comments.append((number, body))


class FakeWorker:
    def __init__(self, github: FakeGitHub):
        self.github = github
        self.blockers: list[int] = [0]
        self.implemented: list[str] = []
        self.reviewed: list[str] = []
        self.crash_after_implement = False

    def implement(self, *, run_id, part, base, branch) -> str:
        head = sha(f"{branch}-{base}")
        self.github.branch_heads[branch] = head
        self.implemented.append(branch)
        return head

    def repair(self, *, run_id, part, branch, findings) -> str:
        head = sha(f"{branch}-repair-{len(self.reviewed)}")
        self.github.branch_heads[branch] = head
        return head

    def review(self, *, run_id, part, branch, head) -> ReviewResult:
        self.reviewed.append(head)
        blockers = self.blockers.pop(0) if self.blockers else 0
        return ReviewResult(head_sha=head, blockers=blockers, independent=True, findings=[{"severity": "P1"}] * blockers)


class FakeDeployer:
    def __init__(self, repo: FakeRepo):
        self.repo = repo
        self.credentials = True
        self.lock = True
        self.health = True
        self.deployed: str | None = BASE
        self.deploys: list[str] = []
        self.rollbacks: list[str] = []
        self.fail_with_migrations: list[str] | None = None
        self.fail = False
        self.authenticated: bool | None = True
        self.feature_ok: bool | None = True
        self.base_ok = True
        self.attempt: DeployResult | None = None

    def credentials_present(self) -> bool:
        return self.credentials

    def lock_free(self) -> bool:
        return self.lock

    def healthy(self) -> bool:
        return self.health

    def deployed_commit(self) -> str | None:
        return self.deployed

    def last_attempt(self) -> DeployResult | None:
        return self.attempt

    def deploy(self, commit: str) -> DeployResult:
        self.deploys.append(commit)
        if self.fail:
            result = DeployResult(
                ok=False,
                commit=commit,
                previous_tag="old-tag",
                migrations_applied=self.fail_with_migrations or [],
                error="health check failed",
            )
        else:
            self.deployed = commit
            result = DeployResult(ok=True, commit=commit, tag=f"{commit[:12]}-tag", backup="/backups/x.dump", previous_tag="old-tag")
        self.attempt = result
        return result

    def rollback(self, tag: str) -> bool:
        self.rollbacks.append(tag)
        return True

    def smoke(self, commit: str, acceptance) -> SmokeResult:
        return SmokeResult(
            base={"services healthy": self.base_ok, "TLS": True, "Basic Auth": True, "noindex": True, "login page": True},
            authenticated=self.authenticated,
            feature={a: self.feature_ok for a in acceptance},
        )
