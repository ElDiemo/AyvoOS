"""``ayvo-night-shift delivery …`` — approved runs with merge and DEV deploy (issue #13, doc 024).

  hash MANIFEST            canonical bytes + SHA-256 the owner signs (writes MANIFEST.canonical)
  verify MANIFEST SIG      checks the owner's signature, window and revocation; changes nothing
  start MANIFEST SIG       verifies, copies the run into runs/<run_id>/ and runs it
  resume RUN_ID            continues a run from its checkpoint (after a crash or reboot)
  status [RUN_ID]          phase and reason of one or every run
  scheduled                starts every approved run waiting in approved/ (used by run-night.sh)

The task text of each part lives next to the manifest as ``<slug>.md``; its SHA-256 must equal
the manifest's ``task_sha256`` (the approved brief cannot be swapped afterwards).
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path

from . import approval, legacy
from .manifest import ManifestError, Manifest, canonical_bytes, parse, task_sha256
from .runstate import RunState, run_lock

ROOT = legacy.ROOT
RUNS = ROOT / "runs"
APPROVED = ROOT / "approved"
REVOKED = ROOT / "revoked"
CONTROLLER_LOCK = ROOT / "controller.lock"


def _now() -> datetime:
    return datetime.now(timezone.utc).replace(microsecond=0)


def _load(manifest_path: Path) -> Manifest:
    return parse(json.loads(manifest_path.read_text(encoding="utf-8")))


def _tasks(manifest: Manifest, directory: Path) -> dict[str, str]:
    tasks = {}
    for part in manifest.parts:
        text = (directory / f"{part.slug}.md").read_text(encoding="utf-8")
        if task_sha256(text) != part.task_sha256:
            raise ManifestError(f"task of part {part.slug} differs from the approved one")
        tasks[part.slug] = text
    return tasks


def _verifier(manifest: Manifest, signature_path: Path):
    def approve() -> bool:
        approval.verify(manifest, signature_path.read_bytes(), now=_now(), revoked_dir=REVOKED)
        return True

    return approve


def _pipeline(run_dir: Path, state: RunState | None = None):
    from .adapters import LiveDeployer, LiveGit, LiveGitHub, LiveWorker
    from .pipeline import Adapters, Pipeline

    manifest = _load(run_dir / "manifest.json")
    tasks = _tasks(manifest, run_dir)
    state = state or RunState.load(run_dir)
    adapters = Adapters(
        worker=LiveWorker(tasks),
        git=LiveGit(),
        github=LiveGitHub(),
        deployer=LiveDeployer(),
        approve=_verifier(manifest, run_dir / "manifest.json.sig"),
        now=_now,
    )
    return Pipeline(manifest, state, adapters)


def cmd_hash(path: Path) -> int:
    manifest = _load(path)
    canonical = path.with_suffix(".canonical")
    canonical.write_bytes(canonical_bytes(manifest.raw))
    print(f"run {manifest.run_id}\nsha256 {manifest.sha256}\ncanonical {canonical}")
    print(f"sign on your own computer: ssh-keygen -Y sign -f ~/.ssh/<key> -n {approval.NAMESPACE} {canonical.name}")
    return 0


def cmd_verify(path: Path, sig: Path) -> int:
    manifest = _load(path)
    approval.verify(manifest, sig.read_bytes(), now=_now(), revoked_dir=REVOKED)
    _tasks(manifest, path.parent)
    print(f"approved {manifest.run_id} {manifest.sha256}")
    return 0


def cmd_start(path: Path, sig: Path) -> int:
    manifest = _load(path)
    approval.verify(manifest, sig.read_bytes(), now=_now(), revoked_dir=REVOKED)
    _tasks(manifest, path.parent)
    run_dir = RUNS / manifest.run_id
    with run_lock(CONTROLLER_LOCK):
        if (run_dir / "state.json").exists():
            print(f"run {manifest.run_id} exists; use resume", file=sys.stderr)
            return 1
        run_dir.mkdir(parents=True, mode=0o700)
        shutil.copy2(path, run_dir / "manifest.json")
        shutil.copy2(sig, run_dir / "manifest.json.sig")
        for part in manifest.parts:
            shutil.copy2(path.parent / f"{part.slug}.md", run_dir / f"{part.slug}.md")
        state = RunState.create(run_dir, run_id=manifest.run_id, manifest_sha256=manifest.sha256, parts=[p.slug for p in manifest.parts], now=_now())
        phase = _pipeline(run_dir, state).run()
    print(f"{manifest.run_id}: {phase}")
    return 0 if phase in {"verified", "awaiting_owner"} else 1


def cmd_resume(run_id: str) -> int:
    run_dir = RUNS / run_id
    with run_lock(CONTROLLER_LOCK):
        phase = _pipeline(run_dir).run()
    print(f"{run_id}: {phase}")
    return 0 if phase in {"verified", "awaiting_owner"} else 1


def cmd_status(run_id: str | None) -> int:
    dirs = [RUNS / run_id] if run_id else sorted(p for p in RUNS.glob("*") if p.is_dir())
    for d in dirs:
        state = RunState.load(d)
        print(json.dumps({"run_id": state.data["run_id"], "phase": state.phase, "reason": state.data.get("reason")}, ensure_ascii=False))
    return 0


def cmd_scheduled() -> int:
    """Approved runs (manifest + signature + task files in approved/<run_id>/), oldest first."""
    status = 0
    for directory in sorted(p for p in APPROVED.glob("*") if p.is_dir()):
        if (RUNS / directory.name / "state.json").exists():
            continue
        try:
            status |= cmd_start(directory / "manifest.json", directory / "manifest.json.sig")
        except Exception as exc:  # noqa: BLE001 — one refused run never stops the others
            print(f"{directory.name}: not started: {exc}", file=sys.stderr)
            status = 1
    return status


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="ayvo-night-shift delivery")
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("hash").add_argument("manifest", type=Path)
    for name in ("verify", "start"):
        p = sub.add_parser(name)
        p.add_argument("manifest", type=Path)
        p.add_argument("signature", type=Path)
    sub.add_parser("resume").add_argument("run_id")
    sub.add_parser("status").add_argument("run_id", nargs="?")
    sub.add_parser("scheduled")
    args = parser.parse_args(argv)
    try:
        if args.cmd == "hash":
            return cmd_hash(args.manifest)
        if args.cmd == "verify":
            return cmd_verify(args.manifest, args.signature)
        if args.cmd == "start":
            return cmd_start(args.manifest, args.signature)
        if args.cmd == "resume":
            return cmd_resume(args.run_id)
        if args.cmd == "status":
            return cmd_status(args.run_id)
        return cmd_scheduled()
    except (ManifestError, approval.ApprovalError) as exc:
        print(f"refused: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
