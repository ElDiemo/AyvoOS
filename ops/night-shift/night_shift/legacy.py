#!/usr/bin/env python3
"""AYVO unattended night-shift controller.

The controller deliberately separates privileged preparation/publishing from the
unprivileged model worker.  The model never receives GitHub or deployment secrets.
"""

from __future__ import annotations

import argparse
import fcntl
import json
import os
import re
import shutil
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


ROOT = Path("/opt/ayvo/night-shift")
REPO = Path("/opt/ayvo/repos/AyvoOS")
WORKTREES = Path("/opt/ayvo/worktrees/night-shift")
READY = ROOT / "queue" / "ready"
RUNNING = ROOT / "queue" / "running"
DONE = ROOT / "queue" / "done"
REPORTS = ROOT / "reports"
LOGS = ROOT / "logs"
STATE = ROOT / "state.json"
LOCK = ROOT / "night-shift.lock"
CLAUDE = Path("/home/ayvo/.nvm/versions/node/v24.21.0/bin/claude")
GH = Path("/opt/ayvo/bin/ayvo-gh")
NODE_BIN = Path("/home/ayvo/.nvm/versions/node/v24.21.0/bin")
RUNNER_IMAGE = "ayvo-night-shift-runner:2.1.296-node24"
EXPECTED_CHECKS = {"quality", "test", "e2e"}
BRANCH_RE = re.compile(r"^night/[a-z0-9][a-z0-9-]{2,70}$")
JOB_RE = re.compile(r"^[0-9]{8}-[a-z0-9][a-z0-9-]{2,70}$")
FORBIDDEN_PATHS = (
    ".github/workflows/",
    "deploy/prod/",
    "deploy/production/",
    "scripts/deploy-dev.sh",
    "scripts/deploy-prod.sh",
)


class NightShiftError(RuntimeError):
    pass


def now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def atomic_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    tmp = path.with_suffix(path.suffix + ".tmp")
    with tmp.open("w", encoding="utf-8") as handle:
        json.dump(value, handle, ensure_ascii=False, indent=2, sort_keys=True)
        handle.write("\n")
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)


def load_json(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as handle:
        value = json.load(handle)
    if not isinstance(value, dict):
        raise NightShiftError(f"Expected a JSON object in {path}")
    return value


def base_env() -> dict[str, str]:
    env = os.environ.copy()
    env.update(
        {
            "PATH": f"{NODE_BIN}:/opt/ayvo/bin:/usr/local/bin:/usr/bin:/bin",
            "CI": "1",
            "COREPACK_HOME": str(ROOT / "cache" / "corepack"),
            "XDG_CACHE_HOME": str(ROOT / "cache" / "xdg"),
            "PNPM_HOME": str(ROOT / "cache" / "pnpm-home"),
            "PNPM_STORE_DIR": str(ROOT / "cache" / "pnpm-store"),
        }
    )
    return env


def command(
    argv: list[str],
    *,
    cwd: Path = REPO,
    timeout: int = 900,
    input_text: str | None = None,
    log: Path | None = None,
    check: bool = True,
    env_extra: dict[str, str] | None = None,
) -> subprocess.CompletedProcess[str]:
    env = base_env()
    if env_extra:
        env.update(env_extra)
    proc = subprocess.run(
        argv,
        cwd=cwd,
        env=env,
        input=input_text,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        timeout=timeout,
        check=False,
    )
    if log:
        log.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        with log.open("a", encoding="utf-8") as handle:
            handle.write(proc.stdout)
            if proc.stdout and not proc.stdout.endswith("\n"):
                handle.write("\n")
        os.chmod(log, 0o600)
    if check and proc.returncode != 0:
        raise NightShiftError(f"Command failed ({proc.returncode}): {' '.join(argv[:3])}")
    return proc


def git(*args: str, cwd: Path = REPO, timeout: int = 900, check: bool = True) -> str:
    return command(["git", *args], cwd=cwd, timeout=timeout, check=check).stdout.strip()


# Git in a worktree the model could modify (issue #13 review, P0): never let git discover the
# repository through the worktree's own `.git` file (the model can replace it with a directory
# whose config runs commands: core.fsmonitor, hooks, …). The controller passes the trusted
# per-worktree git dir from the main repository (mounted read-only into the runner) and disables
# every configuration that executes programs.
SAFE_GIT_OPTIONS = (
    "-c", "core.fsmonitor=false",
    "-c", "core.hooksPath=/dev/null",
    "-c", "core.untrackedCache=false",
    "-c", "core.pager=cat",
    "-c", "diff.external=",
    "-c", "protocol.ext.allow=never",
)


def trusted_gitdir(worktree: Path) -> Path:
    """The main repository's git dir of exactly this worktree (found from the trusted side)."""
    resolved = worktree.resolve(strict=True)
    if resolved.parent != WORKTREES.resolve() and resolved != WORKTREES.resolve().parent / "night-shift-deploy":
        raise NightShiftError(f"Refusing git outside the worktree root: {worktree}")
    expected = str(resolved / ".git")
    for candidate in sorted((REPO / ".git" / "worktrees").glob("*")):
        back = candidate / "gitdir"
        if back.is_file() and not back.is_symlink() and back.read_text(encoding="utf-8").strip() == expected:
            return candidate
    raise NightShiftError(f"No trusted git dir for worktree {worktree}")


def worktree_git_argv(worktree: Path, *args: str) -> list[str]:
    gitdir = trusted_gitdir(worktree)
    return ["git", "--git-dir", str(gitdir), "--work-tree", str(worktree.resolve()), *SAFE_GIT_OPTIONS, *args]


def wgit(worktree: Path, *args: str, timeout: int = 900, check: bool = True) -> str:
    return command(worktree_git_argv(worktree, *args), cwd=worktree, timeout=timeout, check=check).stdout.strip()


def load_state() -> dict[str, Any] | None:
    return load_json(STATE) if STATE.exists() else None


def save_state(state: dict[str, Any], phase: str, **updates: Any) -> None:
    state.update(updates)
    state["phase"] = phase
    state["updated_at"] = now()
    atomic_json(STATE, state)


def validate_job(job: dict[str, Any], path: Path) -> None:
    required = {
        "id",
        "title",
        "slug",
        "base_commit",
        "risk",
        "task_file",
        "commit_message",
        "pr_title",
    }
    missing = sorted(required - job.keys())
    if missing:
        raise NightShiftError(f"Job {path.name} misses: {', '.join(missing)}")
    if not JOB_RE.fullmatch(str(job["id"])):
        raise NightShiftError("Invalid job id")
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]{2,70}", str(job["slug"])):
        raise NightShiftError("Invalid job slug")
    if not re.fullmatch(r"[0-9a-f]{40}", str(job["base_commit"])):
        raise NightShiftError("base_commit must be a full SHA-1")
    if job["risk"] not in {"normal", "critical"}:
        raise NightShiftError("risk must be normal or critical")
    task = ROOT / str(job["task_file"])
    if ROOT not in task.resolve().parents or not task.is_file():
        raise NightShiftError("task_file must be an existing file below the night-shift root")


def select_ready_job() -> Path | None:
    jobs = sorted(READY.glob("*.json"))
    return jobs[0] if jobs else None


def ensure_clean_main() -> None:
    if git("status", "--porcelain", cwd=REPO):
        raise NightShiftError("Main checkout is not clean")
    branch = git("branch", "--show-current", cwd=REPO)
    if branch != "main":
        raise NightShiftError(f"Main checkout is on {branch}, expected main")


def prepare() -> None:
    state = load_state()
    if state and state.get("phase") not in {"done", "blocked", "idle"}:
        print(f"Night shift already has active job {state.get('job_id')} ({state.get('phase')})")
        return
    ready_path = select_ready_job()
    if ready_path is None:
        atomic_json(STATE, {"phase": "idle", "updated_at": now()})
        print("Night shift queue is empty")
        return

    job = load_json(ready_path)
    validate_job(job, ready_path)
    ensure_clean_main()
    command(["git", "fetch", "--prune", "origin", "main"], cwd=REPO, timeout=900)
    remote_main = git("rev-parse", "origin/main")
    if remote_main != job["base_commit"]:
        raise NightShiftError(
            f"origin/main changed: expected {job['base_commit']}, got {remote_main}; re-plan the job"
        )

    branch = f"night/{job['slug']}"
    if not BRANCH_RE.fullmatch(branch):
        raise NightShiftError("Generated branch name is invalid")
    worktree = WORKTREES / job["id"]
    if worktree.exists():
        raise NightShiftError(f"Worktree already exists: {worktree}")
    branch_check = command(
        ["git", "show-ref", "--verify", f"refs/heads/{branch}"], cwd=REPO, check=False
    )
    if branch_check.returncode == 0:
        raise NightShiftError(f"Local branch already exists: {branch}")

    worktree.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    command(
        ["git", "worktree", "add", "-b", branch, str(worktree), job["base_commit"]],
        cwd=REPO,
        timeout=900,
    )
    running_path = RUNNING / ready_path.name
    RUNNING.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.replace(ready_path, running_path)
    state = {
        "job_id": job["id"],
        "job_file": str(running_path),
        "branch": branch,
        "worktree": str(worktree),
        "base_commit": job["base_commit"],
        "started_at": now(),
    }
    save_state(state, "prepared")
    print(f"Prepared {job['id']} in isolated worktree")


def implement_prompt(job: dict[str, Any], task_text: str) -> str:
    return f"""You are the implementation engineer for AYVO OS night shift job {job['id']}.

Read CLAUDE.md and the relevant domain documents before editing. Work only in the current isolated
git worktree. Implement the task below completely, including migrations, tests and documentation
when required. Preserve existing data and compatibility. Do not commit, push, create or merge a
pull request, deploy anything, access DEV/production services, use Docker, or read files outside
the repository. Do not relax tests or security controls. Run useful local checks that do not need
Docker; the controller will run the mandatory gates afterwards.

When blocked by a genuine product decision, stop without guessing and explain the exact decision.
Otherwise continue until the implementation is reviewable.

TASK
----
{task_text}
"""


def invoke_model(
    *, model: str, effort: str, prompt: str, cwd: Path, log: Path, timeout: int, schema: dict[str, Any] | None = None
) -> dict[str, Any]:
    claude_argv = [
        "claude",
        "--restricted",
        "--model",
        model,
        "--effort",
        effort,
        "--permission-mode",
        "auto",
        "--permission-prompts",
        "none",
        "--output-format",
        "json",
        "--allowedTools",
        "Read,Edit,Write,Glob,Grep,Task,Bash(git status *),Bash(git diff *),Bash(git log *),Bash(git show *),Bash(git ls-files *),Bash(corepack pnpm *),Bash(node *),Bash(find *),Bash(ls *),Bash(sed *),Bash(pwd),Bash(test *)",
    ]
    if schema is not None:
        claude_argv.extend(["--json-schema", json.dumps(schema, separators=(",", ":"))])
    claude_argv.append("-p")
    argv = runner_argv(cwd, include_claude_auth=True) + claude_argv
    proc = command(argv, cwd=cwd, timeout=timeout, input_text=prompt, log=log)
    try:
        data = json.loads(proc.stdout)
    except json.JSONDecodeError as exc:
        raise NightShiftError("Model returned invalid JSON envelope") from exc
    if not isinstance(data, dict):
        raise NightShiftError("Model returned a non-object envelope")
    return data


def run_gates(worktree: Path, log_dir: Path) -> None:
    gates = [
        (["corepack", "pnpm", "install", "--frozen-lockfile"], 1800, {}),
        (["corepack", "pnpm", "format:check"], 900, {}),
        (["corepack", "pnpm", "lint"], 1200, {}),
        (["corepack", "pnpm", "typecheck"], 1200, {}),
        (["corepack", "pnpm", "build"], 1800, {}),
        (["corepack", "pnpm", "test"], 1800, {"AYVO_SKIP_DB_TESTS": "1"}),
    ]
    for index, (argv, timeout, extra) in enumerate(gates, start=1):
        command(
            runner_argv(worktree, env_extra=extra) + argv,
            cwd=worktree,
            timeout=timeout,
            log=log_dir / f"gate-{index}-{argv[-1].replace(':', '-')}.log",
        )


def runner_cpus() -> int:
    """Docker refuses more CPUs than the host has (the 2026-10-12 shift failed with exit 125:
    "range of CPUs is from 0.01 to 2.00"); leave one CPU to the DEV preview when possible."""
    available = os.cpu_count() or 1
    return max(1, min(4, available - 1 if available > 2 else available))


def runner_memory() -> str:
    """At most 10 GiB and at most 60 % of the host's memory (the DEV preview shares it)."""
    try:
        with open("/proc/meminfo", encoding="utf-8") as handle:
            total_kib = int(next(line for line in handle if line.startswith("MemTotal:")).split()[1])
    except (OSError, StopIteration, ValueError):
        return "2g"
    return f"{max(1024, min(10 * 1024, total_kib * 6 // 10 // 1024))}m"


def runner_argv(
    worktree: Path, *, include_claude_auth: bool = False, env_extra: dict[str, str] | None = None
) -> list[str]:
    """Build a rootless, narrow-mount Docker invocation for untrusted model/build code."""
    worktree = worktree.resolve()
    if worktree.parent != WORKTREES.resolve():
        raise NightShiftError(f"Refusing runner mount outside worktree root: {worktree}")
    uid = os.getuid()
    gid = os.getgid()
    argv = [
        "docker",
        "run",
        "--rm",
        "-i",
        "--user",
        f"{uid}:{gid}",
        "--read-only",
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges",
        "--pids-limit=768",
        f"--memory={runner_memory()}",
        f"--cpus={runner_cpus()}",
        "--tmpfs",
        "/tmp:rw,nosuid,nodev,size=2g",
        "--workdir",
        "/workspace",
        "--env",
        "HOME=/home/ayvo",
        "--env",
        "CI=1",
        "--env",
        "COREPACK_HOME=/cache/corepack",
        "--env",
        "XDG_CACHE_HOME=/cache/xdg",
        "--env",
        "PNPM_HOME=/cache/pnpm-home",
        "--env",
        "PNPM_STORE_DIR=/cache/pnpm-store",
        "--volume",
        f"{worktree}:/workspace:rw",
        "--volume",
        f"{REPO / '.git'}:{REPO / '.git'}:ro",
        "--volume",
        f"{ROOT / 'cache'}:/cache:rw",
    ]
    if include_claude_auth:
        argv.extend(
            [
                "--volume",
                "/home/ayvo/.claude:/home/ayvo/.claude:rw",
                "--volume",
                "/home/ayvo/.claude.json:/home/ayvo/.claude.json:rw",
            ]
        )
    for key, value in sorted((env_extra or {}).items()):
        if not re.fullmatch(r"[A-Z][A-Z0-9_]*", key):
            raise NightShiftError(f"Invalid runner environment key: {key}")
        argv.extend(["--env", f"{key}={value}"])
    argv.append(RUNNER_IMAGE)
    return argv


REVIEW_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "verdict": {"type": "string", "enum": ["pass", "fix"]},
        "summary": {"type": "string"},
        "findings": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "severity": {"type": "string", "enum": ["P0", "P1", "P2", "P3"]},
                    "title": {"type": "string"},
                    "file": {"type": "string"},
                    "line": {"type": "integer", "minimum": 0},
                    "detail": {"type": "string"},
                },
                "required": ["severity", "title", "file", "line", "detail"],
                "additionalProperties": False,
            },
        },
    },
    "required": ["verdict", "summary", "findings"],
    "additionalProperties": False,
}

IMPLEMENT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "status": {"type": "string", "enum": ["completed", "blocked"]},
        "summary": {"type": "string"},
        "decisions_needed": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["status", "summary", "decisions_needed"],
    "additionalProperties": False,
}


def structured_output(envelope: dict[str, Any]) -> dict[str, Any]:
    direct = envelope.get("structured_output")
    if isinstance(direct, dict):
        return direct
    result = envelope.get("result")
    if isinstance(result, str):
        try:
            parsed = json.loads(result)
        except json.JSONDecodeError:
            parsed = None
        if isinstance(parsed, dict):
            return parsed
    raise NightShiftError("Structured reviewer output is missing")


def review_prompt(job: dict[str, Any], task_text: str) -> str:
    return f"""Act as an independent senior reviewer for AYVO OS job {job['id']}.
Review only; do not edit files. Read CLAUDE.md, the task file, git status, every changed and new file,
and compare the implementation with origin/main. Focus on correctness, schema/data invariants,
authorization and site isolation, concurrency/idempotency, migration safety, regressions and test
coverage. P0-P2 findings block publishing; P3 is a follow-up. Do not complain about style unless it
causes a concrete defect. Return only the requested structured result.

ORIGINAL TASK
-------------
{task_text}
"""


def important_findings(review: dict[str, Any]) -> list[dict[str, Any]]:
    findings = review.get("findings", [])
    return [item for item in findings if item.get("severity") in {"P0", "P1", "P2"}]


def changed_paths(worktree: Path) -> list[str]:
    output = wgit(worktree, "status", "--porcelain=v1")
    paths: list[str] = []
    for line in output.splitlines():
        if not line:
            continue
        path = line[3:]
        if " -> " in path:
            path = path.split(" -> ", 1)[1]
        paths.append(path)
    return paths


def validate_changes(worktree: Path) -> list[str]:
    dot_git = worktree / ".git"
    if dot_git.is_symlink() or not dot_git.is_file():
        raise NightShiftError("The worktree's .git was replaced; refusing to continue")
    paths = changed_paths(worktree)
    if not paths:
        raise NightShiftError("Implementation produced no changes")
    for path in paths:
        normalized = path[2:] if path.startswith("./") else path  # never strip characters
        name = Path(normalized).name
        forbidden_env = name.startswith(".env") and name != ".env.example"
        if forbidden_env or any(normalized.startswith(prefix) for prefix in FORBIDDEN_PATHS):
            raise NightShiftError(f"Forbidden path changed: {normalized}")
        if "secret" in normalized.lower() and normalized.endswith((".env", ".pem", ".key")):
            raise NightShiftError(f"Possible secret file changed: {normalized}")
    command(worktree_git_argv(worktree, "diff", "--check"), cwd=worktree, timeout=300)
    return paths


def work() -> None:
    state = load_state()
    if not state or state.get("phase") not in {"prepared", "working"}:
        print("No prepared night-shift job")
        return
    job = load_json(Path(state["job_file"]))
    validate_job(job, Path(state["job_file"]))
    worktree = Path(state["worktree"])
    log_dir = LOGS / job["id"]
    log_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    task_text = (ROOT / job["task_file"]).read_text(encoding="utf-8")
    save_state(state, "working")

    implementation_envelope = invoke_model(
        model="sonnet",
        effort="high",
        prompt=implement_prompt(job, task_text),
        cwd=worktree,
        log=log_dir / "implementer.json",
        timeout=5 * 60 * 60,
        schema=IMPLEMENT_SCHEMA,
    )
    implementation_result = structured_output(implementation_envelope)
    if implementation_result.get("status") != "completed":
        decisions = implementation_result.get("decisions_needed", [])
        raise NightShiftError(f"Implementation needs an owner decision: {decisions}")
    validate_changes(worktree)
    run_gates(worktree, log_dir)

    review_model = "fable" if job["risk"] == "critical" else "sonnet"
    final_review: dict[str, Any] | None = None
    for round_number in (1, 2):
        review_envelope = invoke_model(
            model=review_model,
            effort="high",
            prompt=review_prompt(job, task_text),
            cwd=worktree,
            log=log_dir / f"review-{round_number}.json",
            timeout=90 * 60,
            schema=REVIEW_SCHEMA,
        )
        final_review = structured_output(review_envelope)
        atomic_json(log_dir / f"review-{round_number}-result.json", final_review)
        blockers = important_findings(final_review)
        if not blockers:
            break
        if round_number == 2:
            raise NightShiftError("Review still has P0-P2 findings after two rounds")
        repair = f"""Fix every P0-P2 finding below for AYVO job {job['id']}.
Read the files and verify each finding before changing code. Do not commit, push, create a PR,
deploy, use Docker, or access anything outside this worktree. Add regression tests. Then run useful
local checks. Findings:\n{json.dumps(blockers, ensure_ascii=False, indent=2)}"""
        repair_envelope = invoke_model(
            model="sonnet",
            effort="high",
            prompt=repair,
            cwd=worktree,
            log=log_dir / f"repair-{round_number}.json",
            timeout=3 * 60 * 60,
            schema=IMPLEMENT_SCHEMA,
        )
        repair_result = structured_output(repair_envelope)
        if repair_result.get("status") != "completed":
            raise NightShiftError(
                f"Repair needs an owner decision: {repair_result.get('decisions_needed', [])}"
            )
        validate_changes(worktree)
        run_gates(worktree, log_dir)

    paths = validate_changes(worktree)
    command(worktree_git_argv(worktree, "add", "--all"), cwd=worktree, timeout=300)
    command(worktree_git_argv(worktree, "commit", "--no-verify", "-m", job["commit_message"]), cwd=worktree, timeout=600)
    head = wgit(worktree, "rev-parse", "HEAD")
    save_state(
        state,
        "ready_to_publish",
        head_commit=head,
        changed_paths=paths,
        review=final_review,
        local_gates="passed",
    )
    print(f"Implementation and review complete: {head}")


def parse_pr_number(text: str) -> tuple[int, str]:
    urls = re.findall(r"https://github\.com/ElDiemo/AyvoOS/pull/([0-9]+)", text)
    if not urls:
        raise NightShiftError("Could not parse PR number from GitHub output")
    number = int(urls[-1])
    return number, f"https://github.com/ElDiemo/AyvoOS/pull/{number}"


def write_report(state: dict[str, Any], job: dict[str, Any], status: str, details: str) -> Path:
    report = REPORTS / f"{job['id']}.md"
    report.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    body = f"""# AYVO Night Shift — {job['title']}

- Job: `{job['id']}`
- Status: **{status}**
- Base: `{state.get('base_commit', '-')}`
- Branch: `{state.get('branch', '-')}`
- Head: `{state.get('head_commit', '-')}`
- Pull request: {state.get('pr_url', 'not created')}
- Local gates: {state.get('local_gates', '-')}
- CI: {state.get('ci', '-')}
- Started: {state.get('started_at', '-')}
- Updated: {now()}

{details}

No merge or deployment was performed.
"""
    report.write_text(body, encoding="utf-8")
    os.chmod(report, 0o600)
    return report


def publish() -> None:
    state = load_state()
    if not state or state.get("phase") not in {"ready_to_publish", "ci_wait"}:
        print("No reviewed night-shift job ready to publish")
        return
    job_path = Path(state["job_file"])
    job = load_json(job_path)
    validate_job(job, job_path)
    worktree = Path(state["worktree"])
    branch = str(state["branch"])
    if not BRANCH_RE.fullmatch(branch):
        raise NightShiftError("Refusing invalid publish branch")
    if worktree.parent != WORKTREES or not worktree.is_dir():
        raise NightShiftError("Refusing unexpected worktree")
    if wgit(worktree, "status", "--porcelain"):
        raise NightShiftError("Refusing to publish a dirty worktree")
    head = wgit(worktree, "rev-parse", "HEAD")
    if head != state.get("head_commit"):
        raise NightShiftError("Worktree HEAD differs from reviewed commit")
    ancestor = command(
        worktree_git_argv(worktree, "merge-base", "--is-ancestor", job["base_commit"], head),
        cwd=worktree,
        check=False,
    )
    if ancestor.returncode != 0:
        raise NightShiftError("Reviewed commit is not descended from the approved base")

    if not state.get("pr_number"):
        command(worktree_git_argv(worktree, "push", "--set-upstream", "origin", branch), cwd=worktree, timeout=1200)
        body_path = LOGS / job["id"] / "pr-body.md"
        body_path.write_text(
            "\n".join(
                [
                    f"Automated night-shift implementation for `{job['id']}`.",
                    "",
                    "- isolated worktree and dedicated branch",
                    f"- independent {'Fable' if job['risk'] == 'critical' else 'Sonnet'} review; no P0-P2 findings",
                    "- local format, lint, typecheck, build and non-database tests passed",
                    "- full quality, test and e2e checks run in GitHub CI",
                    "",
                    "This automation never merges or deploys. Owner review and explicit merge authorization are required.",
                ]
            )
            + "\n",
            encoding="utf-8",
        )
        os.chmod(body_path, 0o600)
        created = command(
            [
                str(GH),
                "pr",
                "create",
                "--base",
                "main",
                "--head",
                branch,
                "--title",
                job["pr_title"],
                "--body-file",
                str(body_path),
            ],
            cwd=worktree,
            timeout=600,
            log=LOGS / job["id"] / "publish.log",
        )
        pr_number, pr_url = parse_pr_number(created.stdout)
        save_state(state, "ci_wait", pr_number=pr_number, pr_url=pr_url, ci="pending")
    else:
        pr_number = int(state["pr_number"])

    checks = command(
        [str(GH), "pr", "checks", str(pr_number), "--watch", "--interval", "30"],
        cwd=worktree,
        timeout=3 * 60 * 60,
        log=LOGS / job["id"] / "ci.log",
        check=False,
    )
    if checks.returncode != 0:
        save_state(state, "blocked", ci="failed_or_timed_out", error="GitHub CI did not pass")
        write_report(state, job, "BLOCKED", "GitHub CI failed or did not finish within three hours. Review the CI log; no merge was attempted.")
        raise NightShiftError("GitHub CI failed or timed out")

    view = command(
        [str(GH), "pr", "view", str(pr_number), "--json", "state,mergeable,mergeStateStatus,headRefOid,url"],
        cwd=worktree,
        timeout=300,
        log=LOGS / job["id"] / "publish.log",
    )
    pr = json.loads(view.stdout)
    if pr.get("state") != "OPEN" or pr.get("headRefOid") != state["head_commit"]:
        raise NightShiftError("PR state or head changed unexpectedly after CI")
    save_state(state, "done", ci="passed", pr_state=pr)
    DONE.mkdir(parents=True, exist_ok=True, mode=0o700)
    done_path = DONE / job_path.name
    os.replace(job_path, done_path)
    state["job_file"] = str(done_path)
    atomic_json(STATE, state)
    report = write_report(state, job, "READY FOR OWNER REVIEW", "All required CI checks passed. The PR remains open and unmerged.")
    print(f"Night shift complete: {state['pr_url']} report={report}")


def check_installation() -> None:
    errors: list[str] = []
    for path in (ROOT, REPO, GH):
        if not path.exists():
            errors.append(f"missing {path}")
    if not (REPO / ".git").exists():
        errors.append("repository is not a git checkout")
    if GH.exists() and not os.access(GH, os.X_OK):
        errors.append("GitHub wrapper is not executable")
    if errors:
        raise NightShiftError("; ".join(errors))
    image = command(["docker", "image", "inspect", RUNNER_IMAGE], check=False)
    if image.returncode != 0:
        raise NightShiftError(f"runner image missing: {RUNNER_IMAGE}")
    ensure_clean_main()
    print("ok repository and main checkout")
    print(f"ok isolated Claude runner {RUNNER_IMAGE}")
    print("ok GitHub wrapper")
    print(f"queue ready={len(list(READY.glob('*.json')))}")


def status() -> None:
    state = load_state() or {"phase": "not-initialized"}
    print(json.dumps(state, ensure_ascii=False, indent=2, sort_keys=True))
    print(f"ready_jobs={len(list(READY.glob('*.json')))}")
    print(f"reports={len(list(REPORTS.glob('*.md')))}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=["prepare", "work", "publish", "check", "status"])
    args = parser.parse_args()
    ROOT.mkdir(parents=True, exist_ok=True, mode=0o700)
    LOCK.touch(mode=0o600, exist_ok=True)
    with LOCK.open("r+") as lock_handle:
        fcntl.flock(lock_handle.fileno(), fcntl.LOCK_EX)
        try:
            {"prepare": prepare, "work": work, "publish": publish, "check": check_installation, "status": status}[args.action]()
            return 0
        except (NightShiftError, subprocess.TimeoutExpired, OSError, ValueError) as exc:
            state = load_state() or {"phase": "blocked", "started_at": now()}
            save_state(state, "blocked", error=str(exc))
            job = None
            job_path = state.get("job_file")
            if job_path and Path(job_path).exists():
                try:
                    job = load_json(Path(job_path))
                except Exception:
                    job = None
            if job:
                write_report(state, job, "BLOCKED", f"{exc}\n\nThe system stopped safely and did not merge or deploy.")
            print(f"night-shift: {exc}", file=sys.stderr)
            return 1


if __name__ == "__main__":
    raise SystemExit(main())
