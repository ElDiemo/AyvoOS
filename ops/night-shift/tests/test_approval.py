"""Owner approval by SSH signature (issue #13, doc 024 §5) — with real ssh-keygen keys."""

from __future__ import annotations

import os
import subprocess
import tempfile
import unittest
from datetime import timedelta
from pathlib import Path

from night_shift.approval import NAMESPACE, OWNER_IDENTITY, ApprovalError, check_trust_anchor, verify
from night_shift.manifest import canonical_bytes, parse

from helpers import T0, raw_manifest


def keygen(directory: Path, name: str) -> Path:
    key = directory / name
    subprocess.run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", name, "-f", str(key)], check=True)
    return key


def sign(key: Path, data: bytes, directory: Path, namespace: str = NAMESPACE) -> bytes:
    message = directory / "manifest.json"
    message.write_bytes(data)
    (directory / "manifest.json.sig").unlink(missing_ok=True)
    subprocess.run(["ssh-keygen", "-q", "-Y", "sign", "-f", str(key), "-n", namespace, str(message)], check=True)
    return (directory / "manifest.json.sig").read_bytes()


class ApprovalTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        anchor_dir = self.dir / "etc"
        anchor_dir.mkdir(mode=0o755)
        self.owner = keygen(self.dir, "owner")
        self.intruder = keygen(self.dir, "intruder")
        self.signers = anchor_dir / "allowed_signers"
        public = (self.dir / "owner.pub").read_text().strip()
        self.signers.write_text(f'{OWNER_IDENTITY} namespaces="{NAMESPACE}" {public}\n')
        os.chmod(self.signers, 0o644)
        self.manifest = parse(raw_manifest())
        self.now = T0

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def check(self, signature: bytes, manifest=None, **kwargs):
        return verify(
            manifest or self.manifest,
            signature,
            now=kwargs.pop("now", self.now),
            allowed_signers=self.signers,
            require_root_anchor=False,
            **kwargs,
        )

    def test_the_owners_signature_over_the_exact_manifest_approves(self) -> None:
        signature = sign(self.owner, canonical_bytes(self.manifest.raw), self.dir)
        approval = self.check(signature)
        self.assertEqual(approval.manifest_sha256, self.manifest.sha256)

    def test_a_changed_manifest_voids_the_signature(self) -> None:
        signature = sign(self.owner, canonical_bytes(self.manifest.raw), self.dir)
        widened = parse(raw_manifest(scope={"allowed_paths": ["apps/**"], "forbidden_paths": []}))
        with self.assertRaises(ApprovalError):
            self.check(signature, widened)

    def test_another_key_or_namespace_is_refused(self) -> None:
        with self.assertRaises(ApprovalError):
            self.check(sign(self.intruder, canonical_bytes(self.manifest.raw), self.dir))
        with self.assertRaises(ApprovalError):
            self.check(sign(self.owner, canonical_bytes(self.manifest.raw), self.dir, namespace="git"))
        with self.assertRaises(ApprovalError):
            self.check(b"I approve this run -- owner")

    def test_validity_window_and_revocation(self) -> None:
        signature = sign(self.owner, canonical_bytes(self.manifest.raw), self.dir)
        with self.assertRaises(ApprovalError):
            self.check(signature, now=self.manifest.valid_until)
        with self.assertRaises(ApprovalError):
            self.check(signature, now=self.manifest.valid_from - timedelta(seconds=1))
        revoked = self.dir / "revoked"
        revoked.mkdir()
        (revoked / self.manifest.sha256).touch()
        with self.assertRaises(ApprovalError):
            self.check(signature, revoked_dir=revoked)

    def test_the_trust_anchor_must_be_root_owned_and_not_writable_by_others(self) -> None:
        if os.getuid() != 0:
            with self.assertRaises(ApprovalError):
                check_trust_anchor(self.signers, require_root=True)
        os.chmod(self.signers, 0o666)
        with self.assertRaises(ApprovalError):
            check_trust_anchor(self.signers, require_root=False)
        with self.assertRaises(ApprovalError):
            check_trust_anchor(self.dir / "missing", require_root=False)


if __name__ == "__main__":
    unittest.main()
