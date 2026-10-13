"""Live adapters of the pipeline (issue #13, doc 024 §8) — used only after installation.

Privileged, deterministic controller code. Nothing here runs model output: the model works in the
isolated runner container (legacy.runner_argv); git, GitHub and the deployment are driven here
with fixed argument lists. Credentials are passed by file or stdin, never in argv or logs.
"""

from __future__ import annotations

import json
import os
import re
import stat
import subprocess
from pathlib import Path
from typing import Any

from . import legacy
from .gates import PullRequest
from .manifest import Part
from .pipeline import Blocked, DeployResult, ReviewResult, SmokeResult, TransientError

REPO = legacy.REPO
GH = legacy.GH
SLUG = "ElDiemo/AyvoOS"
DEPLOY_WORKTREE = Path("/opt/ayvo/worktrees/night-shift-deploy")
DEPLOY_LOG = Path("/opt/ayvo/logs/deployments-dev-preview.log")
DEPLOY_LOCK = Path("/opt/ayvo/logs/.deploy-dev-preview.lock")
# Owner-provisioned, controller-only (mode 600, owned by the controller's user). Never mounted into
# the runner container. Absent ⇒ the deploy gate refuses (doc 024 §8).
VERIFY_PASSWORD_FILE = Path("/opt/ayvo/secrets/night-shift/dev-verify.pass")


def _run(argv: list[str], *, cwd: Path = REPO, timeout: int = 600, env_extra: dict[str, str] | None = None, input_text: str | None = None) -> str:
    env = legacy.base_env()
    if env_extra:
        env.update(env_extra)
    proc = subprocess.run(argv, cwd=cwd, env=env, input=input_text, text=True, capture_output=True, timeout=timeout, check=False)
    if proc.returncode != 0:
        # Never echo stdout/stderr of privileged commands into state or reports.
        raise TransientError(f"{Path(argv[0]).name} {argv[1] if len(argv) > 1 else ''} failed ({proc.returncode})")
    return proc.stdout


class LiveGit:
    def remote_main(self) -> str:
        _run(["git", "fetch", "--prune", "origin", "main"], timeout=900)
        return _run(["git", "rev-parse", "origin/main"]).strip()

    def changed_paths(self, base: str, head: str) -> list[str]:
        if not self._has(head):
            _run(["git", "fetch", "origin", head], timeout=900)
        out = _run(["git", "diff", "--name-only", "--no-renames", f"{base}..{head}"])
        return [line for line in out.splitlines() if line]

    def parents(self, commit: str) -> list[str]:
        out = _run(["git", "rev-list", "--parents", "-n", "1", commit]).split()
        return out[1:]

    def _has(self, commit: str) -> bool:
        return subprocess.run(["git", "cat-file", "-e", f"{commit}^{{commit}}"], cwd=REPO, capture_output=True, check=False).returncode == 0


class LiveGitHub:
    """Only the operations the ayvo-gh wrapper allows; merge with per-PR authorization."""

    def _gh(self, *args: str, env_extra: dict[str, str] | None = None) -> str:
        return _run([str(GH), *args], timeout=600, env_extra=env_extra)

    def _pr(self, data: dict[str, Any]) -> PullRequest:
        merge = data.get("mergeCommit") or {}
        return PullRequest(
            number=int(data["number"]),
            state=str(data["state"]),
            head_ref=str(data["headRefName"]),
            head_sha=str(data["headRefOid"]),
            base_ref=str(data["baseRefName"]),
            merge_commit=merge.get("oid") if isinstance(merge, dict) else None,
        )

    def find_pr(self, branch: str) -> PullRequest | None:
        out = self._gh("pr", "list", "--state", "all", "--head", branch, "--json", "number,state,headRefName,headRefOid,baseRefName,mergeCommit")
        items = json.loads(out)
        return self._pr(items[0]) if items else None

    def create_pr(self, *, branch: str, title: str, body: str) -> int:
        body_file = legacy.LOGS / "pr-bodies" / f"{re.sub(r'[^a-z0-9-]', '-', branch)}.md"
        body_file.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        body_file.write_text(body + "\n", encoding="utf-8")
        os.chmod(body_file, 0o600)
        out = self._gh("pr", "create", "--base", "main", "--head", branch, "--title", title, "--body-file", str(body_file))
        return legacy.parse_pr_number(out)[0]

    def pr(self, number: int) -> PullRequest:
        out = self._gh("pr", "view", str(number), "--json", "number,state,headRefName,headRefOid,baseRefName,mergeCommit")
        return self._pr(json.loads(out))

    def checks(self, sha: str) -> dict[str, dict[str, Any]]:
        if not re.fullmatch(r"[0-9a-f]{40}", sha):
            raise Blocked("invalid commit for the check lookup")
        out = self._gh("api", f"repos/{SLUG}/commits/{sha}/check-runs?per_page=100")
        result: dict[str, dict[str, Any]] = {}
        for run in json.loads(out).get("check_runs", []):
            # The newest run of each name wins (re-runs).
            name = str(run.get("name"))
            if name not in result or str(run.get("started_at")) > str(result[name].get("started_at")):
                result[name] = {
                    "head_sha": run.get("head_sha"),
                    "status": run.get("status"),
                    "conclusion": run.get("conclusion"),
                    "started_at": run.get("started_at"),
                }
        return result

    def ruleset_active(self) -> bool:
        out = self._gh("api", f"repos/{SLUG}/rulesets")
        return any(r.get("name") == "Protect main" and r.get("enforcement") == "active" for r in json.loads(out))

    def merge(self, number: int) -> None:
        # The wrapper refuses --admin/--auto/--delete-branch and needs this per-PR variable.
        self._gh("pr", "merge", str(number), "--merge", env_extra={"AYVO_GH_ALLOW_MERGE": str(number)})

    def comment(self, number: int, body: str) -> None:
        body_file = legacy.LOGS / "reports" / f"pr-{number}.md"
        body_file.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        body_file.write_text(body, encoding="utf-8")
        os.chmod(body_file, 0o600)
        self._gh("pr", "comment", str(number), "--body-file", str(body_file))


class LiveWorker:
    """The existing isolated runner: implementation and repair by Sonnet, review in a fresh,
    review-only session (Fable for critical parts); the controller commits and pushes."""

    def __init__(self, task_texts: dict[str, str]):
        self.tasks = task_texts

    def _worktree(self, branch: str) -> Path:
        return legacy.WORKTREES / branch.replace("/", "-")

    def implement(self, *, run_id: str, part: Part, base: str, branch: str) -> str:
        worktree = self._worktree(branch)
        if not worktree.exists():
            _run(["git", "worktree", "add", "-b", branch, str(worktree), base], timeout=900)
        job = {"id": f"{run_id}/{part.slug}", "risk": part.risk}
        log_dir = legacy.LOGS / run_id / part.slug
        envelope = legacy.invoke_model(
            model="sonnet", effort="high", prompt=legacy.implement_prompt(job, self.tasks[part.slug]),
            cwd=worktree, log=log_dir / "implementer.json", timeout=5 * 60 * 60, schema=legacy.IMPLEMENT_SCHEMA,
        )
        result = legacy.structured_output(envelope)
        if result.get("status") != "completed":
            raise Blocked(f"the implementation needs an owner decision: {result.get('decisions_needed', [])}")
        return self._commit(worktree, branch, part, log_dir, f"feat: {part.title}")

    def repair(self, *, run_id: str, part: Part, branch: str, findings: list[dict[str, Any]]) -> str:
        worktree = self._worktree(branch)
        log_dir = legacy.LOGS / run_id / part.slug
        prompt = (
            "Fix every P0-P2 finding below. Verify each before changing code. Do not commit, push, "
            "deploy, use Docker or access anything outside this worktree. Add regression tests.\n"
            + json.dumps(findings, ensure_ascii=False, indent=2)
        )
        envelope = legacy.invoke_model(
            model="sonnet", effort="high", prompt=prompt, cwd=worktree,
            log=log_dir / "repair.json", timeout=3 * 60 * 60, schema=legacy.IMPLEMENT_SCHEMA,
        )
        if legacy.structured_output(envelope).get("status") != "completed":
            raise Blocked("the repair needs an owner decision")
        return self._commit(worktree, branch, part, log_dir, f"fix: review findings for {part.slug}")

    def review(self, *, run_id: str, part: Part, branch: str, head: str) -> ReviewResult:
        worktree = self._worktree(branch)
        before = _run(legacy.worktree_git_argv(worktree, "status", "--porcelain=v1"), cwd=worktree)
        job = {"id": run_id, "risk": part.risk}
        envelope = legacy.invoke_model(
            model="fable" if part.risk == "critical" else "sonnet", effort="high",
            prompt=legacy.review_prompt(job, self.tasks[part.slug]), cwd=worktree,
            log=legacy.LOGS / run_id / part.slug / "review.json", timeout=90 * 60, schema=legacy.REVIEW_SCHEMA,
        )
        review = legacy.structured_output(envelope)
        after = _run(legacy.worktree_git_argv(worktree, "status", "--porcelain=v1"), cwd=worktree)
        current = _run(legacy.worktree_git_argv(worktree, "rev-parse", "HEAD"), cwd=worktree).strip()
        if before != after or current != head:
            raise Blocked("the reviewer changed the worktree; a review must not edit")
        blockers = legacy.important_findings(review)
        return ReviewResult(head_sha=current, blockers=len(blockers), independent=True, summary=str(review.get("summary", ""))[:2000], findings=blockers)

    def _commit(self, worktree: Path, branch: str, part: Part, log_dir: Path, message: str) -> str:
        legacy.validate_changes(worktree)
        legacy.run_gates(worktree, log_dir)
        _run(legacy.worktree_git_argv(worktree, "add", "--all"), cwd=worktree)
        _run(legacy.worktree_git_argv(worktree, "commit", "--no-verify", "-m", message), cwd=worktree)
        _run(legacy.worktree_git_argv(worktree, "push", "--set-upstream", "origin", branch), cwd=worktree, timeout=1200)
        return _run(legacy.worktree_git_argv(worktree, "rev-parse", "HEAD"), cwd=worktree).strip()


def credentials_ok(path: Path = VERIFY_PASSWORD_FILE) -> bool:
    try:
        info = path.stat()
    except FileNotFoundError:
        return False
    return stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid() and (info.st_mode & 0o077) == 0 and info.st_size > 0


class LiveDeployer:
    """DEV preview only, through scripts/deploy-dev.sh of the exact merge commit."""

    def credentials_present(self) -> bool:
        return credentials_ok()

    def lock_free(self) -> bool:
        if not DEPLOY_LOCK.exists():
            return True
        proc = subprocess.run(["flock", "-n", str(DEPLOY_LOCK), "true"], capture_output=True, check=False)
        return proc.returncode == 0

    def healthy(self) -> bool:
        proc = subprocess.run(
            ["docker", "compose", "-p", "ayvo-dev-preview", "ps", "--format", "json"],
            capture_output=True, text=True, check=False, timeout=120,
        )
        if proc.returncode != 0:
            return False
        services = [json.loads(line) for line in proc.stdout.splitlines() if line.strip()]
        return len(services) >= 5 and all(s.get("Health") in ("healthy", "") and s.get("State") == "running" for s in services)

    def _log(self) -> list[dict[str, str]]:
        if not DEPLOY_LOG.exists():
            return []
        entries = []
        for line in DEPLOY_LOG.read_text(encoding="utf-8").splitlines():
            parts = line.split()
            if len(parts) < 4:
                continue
            fields = dict(p.split("=", 1) for p in parts[2:] if "=" in p)
            entries.append({"at": parts[0], "outcome": parts[1], **fields})
        return entries

    def deployed_commit(self) -> str | None:
        good = [e for e in self._log() if e["outcome"] in {"SUCCESS", "OK"} and e.get("git")]
        if not good:
            return None
        return _run(["git", "rev-parse", good[-1]["git"]]).strip()

    def last_attempt(self) -> DeployResult | None:
        entries = self._log()
        if not entries:
            return None
        last = entries[-1]
        commit = _run(["git", "rev-parse", last["git"]]).strip() if last.get("git") else ""
        return DeployResult(ok=last["outcome"] in {"SUCCESS", "OK"}, commit=commit, tag=last.get("tag"))

    def deploy(self, commit: str) -> DeployResult:
        previous = next((e.get("tag") for e in reversed(self._log()) if e["outcome"] in {"SUCCESS", "OK"}), None)
        deployed = self.deployed_commit()
        pending = []
        if deployed:
            changed = _run(["git", "diff", "--name-only", f"{deployed}..{commit}", "--", "apps/api/prisma/migrations/"]).splitlines()
            pending = sorted({p.split("/")[4] for p in changed if p.endswith("/migration.sql")})
        if DEPLOY_WORKTREE.exists():
            _run(legacy.worktree_git_argv(DEPLOY_WORKTREE, "checkout", "--detach", "--force", commit), cwd=DEPLOY_WORKTREE)
        else:
            _run(["git", "worktree", "add", "--detach", str(DEPLOY_WORKTREE), commit], timeout=900)
        if _run(legacy.worktree_git_argv(DEPLOY_WORKTREE, "rev-parse", "HEAD"), cwd=DEPLOY_WORKTREE).strip() != commit:
            raise Blocked("the deploy checkout is not at the merge commit")
        if _run(legacy.worktree_git_argv(DEPLOY_WORKTREE, "status", "--porcelain"), cwd=DEPLOY_WORKTREE).strip():
            raise Blocked("the deploy checkout is not clean")
        proc = subprocess.run(
            [str(DEPLOY_WORKTREE / "scripts" / "deploy-dev.sh")],
            cwd=DEPLOY_WORKTREE,
            env={**legacy.base_env(), "AYVO_DEV_VERIFY_PASSWORD_FILE": str(VERIFY_PASSWORD_FILE)},
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            timeout=3 * 60 * 60,
            check=False,
        )
        log_file = legacy.LOGS / "deploys" / f"{commit[:12]}.log"
        log_file.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        log_file.write_text(proc.stdout + proc.stderr, encoding="utf-8")
        os.chmod(log_file, 0o600)
        backup = re.search(r"(/opt/ayvo/backups/dev-preview/\S+\.dump)", proc.stdout)
        last = self.last_attempt()
        ok = proc.returncode == 0 and last is not None and last.ok and last.commit == commit
        return DeployResult(
            ok=ok,
            commit=commit,
            tag=last.tag if ok and last else None,
            backup=backup.group(1) if backup else None,
            # Conservative: after a failed deploy, pending migrations count as possibly applied, so
            # an image rollback is refused (gates.rollback_decision).
            migrations_applied=pending,
            previous_tag=previous,
            error=None if ok else f"deploy-dev.sh exited {proc.returncode} (log {log_file})",
        )

    def rollback(self, tag: str) -> bool:
        if not re.fullmatch(r"[0-9a-f]{12}-[0-9]{8}T[0-9]{6}Z", tag):
            return False
        proc = subprocess.run(
            [str(DEPLOY_WORKTREE / "scripts" / "deploy-dev.sh"), "--rollback", tag],
            cwd=DEPLOY_WORKTREE,
            env={**legacy.base_env(), "AYVO_DEV_VERIFY_PASSWORD_FILE": str(VERIFY_PASSWORD_FILE)},
            stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=3600, check=False,
        )
        return proc.returncode == 0

    def smoke(self, commit: str, acceptance: tuple[str, ...]) -> SmokeResult:
        last = self.last_attempt()
        verified = last is not None and last.ok and last.commit == commit
        return SmokeResult(
            base={
                "deploy-dev.sh verification (services, TLS, Basic Auth, noindex, HTTP→HTTPS, sign-in page, API health)": verified,
                "all DEV services running and healthy": self.healthy(),
            },
            # No smoke identity exists yet (owner decision, doc 024 §11): never claimed as checked.
            authenticated=None,
            feature={scenario: None for scenario in acceptance},
        )
