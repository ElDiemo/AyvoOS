"""Owner approval of a run manifest (issue #13, doc 024 §5).

Trust anchor: an SSH signature (``ssh-keygen -Y sign``, namespace ``ayvo-night-shift-run``) by
the owner's own key over the manifest's canonical bytes, verified against an ``allowed_signers``
file that only root can change. The owner signs on their own computer; the signature may travel
through any channel (file, GitHub comment) because it cannot be forged or moved to another
manifest. GitHub accounts, labels and comments are not trusted: on this repository several actors
post as the owner's account.

Revocation is the safe direction: anyone who can write the revocation directory can only stop a
run (a file named after the manifest hash), never grant one.
"""

from __future__ import annotations

import os
import stat
import subprocess
import tempfile
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

from .manifest import Manifest, canonical_bytes

NAMESPACE = "ayvo-night-shift-run"
OWNER_IDENTITY = "ayvo-owner"
DEFAULT_ALLOWED_SIGNERS = Path("/etc/ayvo/night-shift/allowed_signers")


class ApprovalError(PermissionError):
    """The run is not (or no longer) approved; nothing may happen."""


@dataclass(frozen=True)
class Approval:
    manifest_sha256: str
    signer: str


def check_trust_anchor(path: Path, *, require_root: bool = True) -> None:
    """The signers file and its directory must be root-owned and not writable by anyone else."""
    if path.is_symlink():
        raise ApprovalError("allowed_signers must not be a symlink")
    for item in (path, path.parent):
        try:
            info = item.lstat()
        except FileNotFoundError as exc:
            raise ApprovalError(f"trust anchor missing: {item}") from exc
        if require_root and info.st_uid != 0:
            raise ApprovalError(f"trust anchor not owned by root: {item}")
        if info.st_mode & (stat.S_IWGRP | stat.S_IWOTH):
            raise ApprovalError(f"trust anchor writable by group/others: {item}")
    if not stat.S_ISREG(path.stat().st_mode):
        raise ApprovalError("allowed_signers must be a regular file")


def verify(
    manifest: Manifest,
    signature: bytes,
    *,
    now: datetime,
    allowed_signers: Path = DEFAULT_ALLOWED_SIGNERS,
    revoked_dir: Path | None = None,
    require_root_anchor: bool = True,
    ssh_keygen: str = "/usr/bin/ssh-keygen",
) -> Approval:
    """Verifies the owner's signature, the validity window and that the run was not revoked."""
    check_trust_anchor(allowed_signers, require_root=require_root_anchor)
    if revoked_dir is not None and (revoked_dir / manifest.sha256).exists():
        raise ApprovalError("the run was revoked")
    if not manifest.is_valid_at(now):
        raise ApprovalError("the approval is outside its validity window")
    if not signature.startswith(b"-----BEGIN SSH SIGNATURE-----"):
        raise ApprovalError("not an SSH signature")
    with tempfile.TemporaryDirectory(prefix="ayvo-approval-") as tmp:
        sig_path = Path(tmp) / "manifest.sig"
        sig_path.write_bytes(signature)
        os.chmod(sig_path, 0o600)
        proc = subprocess.run(
            [
                ssh_keygen,
                "-Y",
                "verify",
                "-f",
                str(allowed_signers),
                "-I",
                OWNER_IDENTITY,
                "-n",
                NAMESPACE,
                "-s",
                str(sig_path),
            ],
            input=canonical_bytes(manifest.raw),
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            timeout=60,
            check=False,
        )
    if proc.returncode != 0:
        raise ApprovalError("the owner's signature does not match this manifest")
    return Approval(manifest_sha256=manifest.sha256, signer=OWNER_IDENTITY)
