"""The run pipeline (issue #13, doc 024 §6): implement → review → CI → merge → (next part) →
deploy DEV → verify → report.

Deterministic controller code. Models only implement, repair and review — through the ``Worker``
adapter, inside the isolated runner container. GitHub, git and the deployment are reached only
through narrow adapters, so the same pipeline runs against fakes in the end-to-end tests and
against the live server after installation.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any, Callable, Protocol

from . import gates
from .approval import ApprovalError
from .gates import PullRequest, Review
from .manifest import Manifest, Part
from .report import render_report
from .runstate import TERMINAL, RunState


class TransientError(RuntimeError):
    """A retryable adapter failure (network, GitHub 5xx); bounded by the manifest's attempts."""


class Blocked(RuntimeError):
    """A rule stops the run safely; the reason goes to the report."""


@dataclass
class ReviewResult:
    head_sha: str
    blockers: int
    independent: bool
    summary: str = ""
    findings: list[dict[str, Any]] = field(default_factory=list)


@dataclass
class DeployResult:
    ok: bool
    commit: str
    tag: str | None = None
    backup: str | None = None
    migrations_applied: list[str] = field(default_factory=list)
    previous_tag: str | None = None
    error: str | None = None


@dataclass
class SmokeResult:
    base: dict[str, bool]
    authenticated: bool | None  # None: not available (no smoke identity) — never "verified"
    feature: dict[str, bool | None]


class Worker(Protocol):
    def implement(self, *, run_id: str, part: Part, base: str, branch: str) -> str: ...
    def repair(self, *, run_id: str, part: Part, branch: str, findings: list[dict[str, Any]]) -> str: ...
    def review(self, *, run_id: str, part: Part, branch: str, head: str) -> ReviewResult: ...


class Git(Protocol):
    def remote_main(self) -> str: ...
    def changed_paths(self, base: str, head: str) -> list[str]: ...
    def parents(self, commit: str) -> list[str]: ...


class GitHub(Protocol):
    def find_pr(self, branch: str) -> PullRequest | None: ...
    def create_pr(self, *, branch: str, title: str, body: str) -> int: ...
    def pr(self, number: int) -> PullRequest: ...
    def checks(self, sha: str) -> dict[str, dict[str, Any]]: ...
    def ruleset_active(self) -> bool: ...
    def merge(self, number: int) -> None: ...
    def comment(self, number: int, body: str) -> None: ...


class Deployer(Protocol):
    def credentials_present(self) -> bool: ...
    def lock_free(self) -> bool: ...
    def healthy(self) -> bool: ...
    def deployed_commit(self) -> str | None: ...
    def last_attempt(self) -> DeployResult | None: ...
    def deploy(self, commit: str) -> DeployResult: ...
    def rollback(self, tag: str) -> bool: ...
    def smoke(self, commit: str, acceptance: tuple[str, ...]) -> SmokeResult: ...


@dataclass
class Adapters:
    worker: Worker
    git: Git
    github: GitHub
    deployer: Deployer
    approve: Callable[[], bool]  # re-verifies signature, window and revocation; raises if not
    now: Callable[[], datetime]
    sleep: Callable[[float], None] = time.sleep


def branch_name(run_id: str, part: Part) -> str:
    return f"night/{run_id}-{part.slug}"[:100]


class Pipeline:
    def __init__(self, manifest: Manifest, state: RunState, adapters: Adapters, *, poll_seconds: float = 30.0):
        if state.data["manifest_sha256"] != manifest.sha256:
            raise Blocked("the run state belongs to another manifest")
        self.m = manifest
        self.s = state
        self.a = adapters
        self.poll = poll_seconds

    # --- driver ------------------------------------------------------------------------------

    @property
    def deadline(self) -> datetime:
        return datetime.fromisoformat(self.s.data["started_at"]) + timedelta(minutes=self.m.max_minutes)

    def run(self) -> str:
        """Advances until a terminal phase; returns it. Safe to call again after a crash."""
        while self.s.phase not in TERMINAL:
            try:
                self.step()
            except Blocked as exc:
                self.s.move("blocked", self.a.now(), reason=str(exc))
            except TransientError as exc:
                attempt = self.s.count_attempt(self.s.phase, self.a.now())
                if attempt >= self.m.max_attempts_per_step:
                    self.s.move("blocked", self.a.now(), reason=f"{self.s.phase}: {exc} (attempt {attempt})")
            except Exception as exc:  # noqa: BLE001 — every unexpected error stops safely
                self.s.move("failed", self.a.now(), reason=f"{type(exc).__name__}: {exc}")
        self._report()
        return self.s.phase

    def step(self) -> None:
        phase = self.s.phase
        # Never start new work after the budget; an ongoing deploy/verification finishes.
        if phase not in {"deploying", "verifying"} and self.a.now() >= self.deadline:
            raise Blocked("the time budget of the run is exhausted")
        getattr(self, f"_{phase}")()

    # --- phases ------------------------------------------------------------------------------

    def _queued(self) -> None:
        self._approved()
        if self.a.git.remote_main() != self.m.base_commit:
            raise Blocked("main is not at the approved base commit; re-plan the run")
        self.s.move("implementing", self.a.now())

    def _part(self) -> Part:
        return self.m.parts[self.s.part_index]

    def _base(self) -> str:
        if self.s.part_index == 0:
            return self.m.base_commit
        return str(self.s.data["parts"][self.s.part_index - 1]["merge_commit"])

    def _implementing(self) -> None:
        part, now = self._part(), self.a.now()
        if not self.s.part.get("head"):
            base = self._base()
            branch = branch_name(self.m.run_id, part)
            self.s.record(now, base=base, branch=branch)
            head = self.a.worker.implement(run_id=self.m.run_id, part=part, base=base, branch=branch)
            self.s.record(self.a.now(), head=head, repairs=0)
        self.s.move("reviewing", self.a.now())

    def _reviewing(self) -> None:
        part, p = self._part(), self.s.part
        changed = self.a.git.changed_paths(p["base"], p["head"])
        reasons = gates.scope_reasons(self.m, changed, gates.new_migrations(changed))
        if reasons:
            raise Blocked("; ".join(reasons))
        result = self.a.worker.review(run_id=self.m.run_id, part=part, branch=p["branch"], head=p["head"])
        self.s.record(
            self.a.now(),
            review={
                "head_sha": result.head_sha,
                "blockers": result.blockers,
                "independent": result.independent,
                "summary": result.summary,
            },
        )
        if result.head_sha != p["head"]:
            raise Blocked("the reviewer saw another commit than the implementation produced")
        if result.blockers:
            if int(p.get("repairs", 0)) >= self.m.max_repair_rounds:
                raise Blocked(f"{result.blockers} P0–P2 findings remain after the allowed repairs")
            head = self.a.worker.repair(run_id=self.m.run_id, part=part, branch=p["branch"], findings=result.findings)
            self.s.record(self.a.now(), head=head, repairs=int(p.get("repairs", 0)) + 1)
            return  # review again
        self.s.move("ci", self.a.now())

    def _ci(self) -> None:
        part, p = self._part(), self.s.part
        if not p.get("pr_number"):
            existing = self.a.github.find_pr(p["branch"])  # a crash after creating it
            if existing is None:
                self.s.record(self.a.now(), pr_intent=True)
                number = self.a.github.create_pr(
                    branch=p["branch"],
                    title=part.title,
                    body=(
                        f"Night shift run `{self.m.run_id}` part `{part.slug}` (issue #{self.m.issue}).\n\n"
                        f"Manifest `{self.m.sha256}`; reviewed head `{p['head']}`."
                    ),
                )
            else:
                number = existing.number
            self.s.record(self.a.now(), pr_number=number)
        checks = self._wait_checks(p["head"])
        reasons = gates.checks_green(checks, self.m.required_checks, p["head"])
        self.s.record(self.a.now(), ci="passed" if not reasons else "failed")
        if reasons:
            raise Blocked("CI: " + "; ".join(reasons))
        pr = self.a.github.pr(int(self.s.part["pr_number"]))
        if pr.head_sha != p["head"]:
            raise Blocked("the pull request head changed after the review")
        self.s.move("merging" if self.m.allow_merge else "awaiting_owner", self.a.now())

    def _merging(self) -> None:
        p = self.s.part
        number = int(p["pr_number"])
        pr = self.a.github.pr(number)
        if pr.state != "MERGED":
            approved = self._approved()
            changed = self.a.git.changed_paths(p["base"], p["head"])
            review = p.get("review") or None
            decision = gates.merge_decision(
                manifest=self.m,
                approved=approved,
                run_branch=p["branch"],
                run_pr_number=number,
                expected_main=p["base"],
                main_sha=self.a.git.remote_main(),
                pr=pr,
                review=Review(review["head_sha"], review["blockers"], review["independent"]) if review else None,
                checks=self.a.github.checks(pr.head_sha),
                ruleset_active=self.a.github.ruleset_active(),
                changed_paths=changed,
                new_migrations=gates.new_migrations(changed),
            )
            if not decision.allowed:
                raise Blocked("merge refused: " + "; ".join(decision.reasons))
            self.s.record(self.a.now(), merge_intent=pr.head_sha)
            self.a.github.merge(number)
            pr = self.a.github.pr(number)
            if pr.state != "MERGED":
                raise Blocked("GitHub did not merge the pull request")
        elif not p.get("merge_intent"):
            raise Blocked("the pull request was merged outside this run")
        merge = pr.merge_commit
        reasons = gates.merge_commit_reasons(
            merge_commit=merge,
            parents=self.a.git.parents(merge) if merge else [],
            expected_main=p["base"],
            head_sha=p["head"],
            main_sha=self.a.git.remote_main(),
        )
        if reasons:
            raise Blocked("after merge: " + "; ".join(reasons))
        self.s.record(self.a.now(), merge_commit=merge)
        checks = self._wait_checks(str(merge))
        reasons = gates.checks_green(checks, self.m.required_checks, str(merge))
        self.s.record(self.a.now(), merge_ci="passed" if not reasons else "failed")
        if reasons:
            raise Blocked("CI on the merge commit: " + "; ".join(reasons))
        self.s.move("merged", self.a.now())

    def _merged(self) -> None:
        now = self.a.now()
        if self.s.part_index + 1 < len(self.m.parts):
            self.s.next_part(now)
            self.s.move("implementing", now)
        elif self.m.allow_deploy_dev:
            self.s.move("deploying", now)
        else:
            self.s.move("awaiting_owner", now, reason="merged; the manifest does not allow a DEV deploy")

    def _deploying(self) -> None:
        commit = str(self.s.data["parts"][-1]["merge_commit"])
        deploy = self.s.data.get("deploy", {})
        if deploy.get("intent") == commit:
            # Resumed after a crash: never deploy blindly twice — reconcile with the deploy log.
            last = self.a.deployer.last_attempt()
            if last is None or last.commit != commit:
                raise Blocked("the outcome of the started deploy is unknown; check the deploy log")
            self._after_deploy(last)
            return
        approved = self._approved()
        deployed = self.a.deployer.deployed_commit()
        changed = self.a.git.changed_paths(deployed or self.m.base_commit, commit)
        decision = gates.deploy_decision(
            manifest=self.m,
            approved=approved,
            all_parts_merged=all(p.get("merge_commit") for p in self.s.data["parts"]),
            merge_commit=commit,
            merge_checks=self.a.github.checks(commit),
            main_sha=self.a.git.remote_main(),
            tooling_changed=gates.tooling_changes(changed),
            migrations_since_deployed=gates.new_migrations(changed),
            credentials_present=self.a.deployer.credentials_present(),
            deploy_lock_free=self.a.deployer.lock_free(),
            environment_healthy=self.a.deployer.healthy(),
        )
        if not decision.allowed:
            raise Blocked("deploy refused: " + "; ".join(decision.reasons))
        self.s.record_run(self.a.now(), "deploy", intent=commit)
        self._after_deploy(self.a.deployer.deploy(commit))

    def _after_deploy(self, result: Any) -> None:
        self.s.record_run(
            self.a.now(),
            "deploy",
            ok=result.ok,
            tag=result.tag,
            backup=result.backup,
            migrations_applied=result.migrations_applied,
            previous_tag=result.previous_tag,
            error=result.error,
        )
        if result.ok:
            self.s.move("verifying", self.a.now())
            return
        rollback = gates.rollback_decision(
            migrations_applied=bool(result.migrations_applied),
            previous_tag=result.previous_tag,
            data_risk=False,
        )
        if rollback.allowed and result.previous_tag and self.a.deployer.rollback(result.previous_tag):
            self.s.record_run(self.a.now(), "deploy", rolled_back_to=result.previous_tag)
            raise Blocked(f"deploy failed ({result.error}); DEV rolled back to {result.previous_tag}")
        raise Blocked(
            f"deploy failed ({result.error}); no automatic rollback: " + "; ".join(rollback.reasons or ["rollback failed"])
        )

    def _verifying(self) -> None:
        commit = str(self.s.data["parts"][-1]["merge_commit"])
        smoke = self.a.deployer.smoke(commit, self.m.acceptance)
        self.s.record_run(
            self.a.now(),
            "smoke",
            base=smoke.base,
            authenticated=smoke.authenticated,
            feature=smoke.feature,
        )
        if not smoke.base or not all(smoke.base.values()):
            raise Blocked("DEV smoke checks failed after the deploy; investigate (no automatic restore)")
        complete = smoke.authenticated is True and all(v is True for v in smoke.feature.values()) and set(
            smoke.feature
        ) == set(self.m.acceptance)
        self.s.move("verified" if complete else "deployed_unverified", self.a.now())

    # --- helpers -----------------------------------------------------------------------------

    def _approved(self) -> bool:
        try:
            ok = self.a.approve()  # re-verifies signature, validity window and revocation
        except ApprovalError as exc:
            raise Blocked(f"approval: {exc}") from exc
        if not ok:
            raise Blocked("no valid owner approval")
        return True

    def _wait_checks(self, sha: str) -> dict[str, dict[str, Any]]:
        while True:
            checks = self.a.github.checks(sha)
            done = all(
                checks.get(name, {}).get("status") == "completed" for name in self.m.required_checks
            )
            if done:
                return checks
            if self.a.now() >= self.deadline:
                raise Blocked("CI did not finish within the time budget")
            self.a.sleep(self.poll)

    def _report(self) -> None:
        body = render_report(self.m, self.s)
        (self.s.directory / "report.md").write_text(body, encoding="utf-8")
        numbers = [p["pr_number"] for p in self.s.data["parts"] if p.get("pr_number")]
        if numbers:
            try:
                self.a.github.comment(int(numbers[-1]), body)
            except Exception:  # noqa: BLE001 — the local report remains
                self.s.record_run(self.a.now(), "report", github="failed")
