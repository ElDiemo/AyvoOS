"""Deterministic merge, deploy and rollback gates (issue #13, doc 024 §7–§8).

Pure functions over facts read from GitHub, git and the deploy log. They never trust a model's
statement: every fact is bound to an exact commit. A gate returns all reasons that block it.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from .manifest import Manifest

MIGRATIONS_DIR = "apps/api/prisma/migrations/"
# Deployment tooling the controller executes; a run may never change it (doc 024 §8).
DEPLOY_TOOLING = ("deploy/", "scripts/deploy-dev.sh")


@dataclass
class Decision:
    allowed: bool
    reasons: list[str] = field(default_factory=list)

    @classmethod
    def of(cls, reasons: list[str]) -> "Decision":
        return cls(allowed=not reasons, reasons=reasons)


@dataclass(frozen=True)
class PullRequest:
    number: int
    state: str  # OPEN | MERGED | CLOSED
    head_ref: str
    head_sha: str
    base_ref: str
    merge_commit: str | None = None


@dataclass(frozen=True)
class Review:
    head_sha: str
    blockers: int  # P0–P2 findings
    reviewer_independent: bool


def checks_green(checks: dict[str, dict[str, Any]], required: frozenset[str], head_sha: str) -> list[str]:
    """Reasons why the required checks are not all successful on exactly ``head_sha``."""
    reasons: list[str] = []
    for name in sorted(required):
        check = checks.get(name)
        if check is None:
            reasons.append(f"check {name} missing")
        elif check.get("head_sha") != head_sha:
            reasons.append(f"check {name} ran on another commit")
        elif check.get("conclusion") != "success":
            reasons.append(f"check {name} is {check.get('conclusion') or check.get('status')}")
    return reasons


def scope_reasons(manifest: Manifest, changed_paths: list[str], new_migrations: list[str]) -> list[str]:
    reasons = [f"path outside the approved scope: {p}" for p in changed_paths if not manifest.path_allowed(p)]
    if new_migrations and not manifest.migrations_allowed:
        reasons.append("the run adds migrations but the manifest allows none")
    if len(new_migrations) > manifest.max_new_migrations:
        reasons.append(f"{len(new_migrations)} new migrations, at most {manifest.max_new_migrations} approved")
    return reasons


def merge_decision(
    *,
    manifest: Manifest,
    approved: bool,
    run_branch: str,
    run_pr_number: int | None,
    expected_main: str,
    main_sha: str,
    pr: PullRequest,
    review: Review | None,
    checks: dict[str, dict[str, Any]],
    ruleset_active: bool,
    changed_paths: list[str],
    new_migrations: list[str],
) -> Decision:
    reasons: list[str] = []
    if not manifest.allow_merge:
        reasons.append("the manifest does not allow merging")
    if not approved:
        reasons.append("no valid owner approval")
    if run_pr_number is None or pr.number != run_pr_number:
        reasons.append("the pull request was not created by this run")
    if pr.state != "OPEN":
        reasons.append(f"the pull request is {pr.state}")
    if pr.head_ref != run_branch or pr.base_ref != "main":
        reasons.append("unexpected branch or base of the pull request")
    if main_sha != expected_main:
        reasons.append("main moved since the run planned this merge; re-plan, never overwrite")
    if review is None:
        reasons.append("no independent review")
    else:
        if not review.reviewer_independent:
            reasons.append("the review was not independent of the implementation")
        if review.head_sha != pr.head_sha:
            reasons.append("the head changed after the review")
        if review.blockers:
            reasons.append(f"{review.blockers} unresolved P0–P2 findings")
    reasons += checks_green(checks, manifest.required_checks, pr.head_sha)
    if not ruleset_active:
        reasons.append("branch protection of main is not active")
    reasons += scope_reasons(manifest, changed_paths, new_migrations)
    return Decision.of(reasons)


def merge_commit_reasons(*, merge_commit: str | None, parents: list[str], expected_main: str, head_sha: str, main_sha: str) -> list[str]:
    """After merging: a normal merge commit of exactly (expected main, reviewed head), now on main."""
    if not merge_commit:
        return ["no merge commit recorded"]
    reasons = []
    if parents != [expected_main, head_sha]:
        reasons.append("the merge commit does not join the expected main and the reviewed head")
    if main_sha != merge_commit:
        reasons.append("main is not at the merge commit")
    return reasons


def deploy_decision(
    *,
    manifest: Manifest,
    approved: bool,
    all_parts_merged: bool,
    merge_commit: str,
    merge_checks: dict[str, dict[str, Any]],
    main_sha: str,
    tooling_changed: list[str],
    migrations_since_deployed: list[str],
    credentials_present: bool,
    deploy_lock_free: bool,
    environment_healthy: bool,
) -> Decision:
    reasons: list[str] = []
    if not manifest.allow_deploy_dev:
        reasons.append("the manifest does not allow a DEV deploy")
    if not approved:
        reasons.append("no valid owner approval")
    if not all_parts_merged:
        reasons.append("not every approved part is merged; DEV gets only a complete result")
    if main_sha != merge_commit:
        reasons.append("main moved after the merge; deploy only the verified merge commit")
    reasons += checks_green(merge_checks, manifest.required_checks, merge_commit)
    if tooling_changed:
        reasons.append(f"deployment tooling changed: {', '.join(tooling_changed)}")
    if migrations_since_deployed and not manifest.migrations_allowed:
        reasons.append("migrations would be applied that the manifest does not approve")
    if len(migrations_since_deployed) > manifest.max_new_migrations:
        reasons.append("more migrations pending than approved")
    if not credentials_present:
        reasons.append("deployment verification credentials are missing; never deploy blind")
    if not deploy_lock_free:
        reasons.append("another deployment holds the lock")
    if not environment_healthy:
        reasons.append("DEV is not healthy before the deploy")
    return Decision.of(reasons)


def rollback_decision(*, migrations_applied: bool, previous_tag: str | None, data_risk: bool) -> Decision:
    """Image rollback only when the database schema is unchanged; never restore a backup."""
    reasons: list[str] = []
    if migrations_applied:
        reasons.append("migrations were applied: the previous image may not match the schema")
    if not previous_tag:
        reasons.append("no previous healthy image")
    if data_risk:
        reasons.append("data risk detected")
    return Decision.of(reasons)


def tooling_changes(changed_paths: list[str]) -> list[str]:
    return [p for p in changed_paths if any(p == t or p.startswith(t) for t in DEPLOY_TOOLING)]


def new_migrations(changed_paths: list[str]) -> list[str]:
    names = {
        p[len(MIGRATIONS_DIR):].split("/", 1)[0]
        for p in changed_paths
        if p.startswith(MIGRATIONS_DIR) and p.endswith("/migration.sql")
    }
    return sorted(names)
