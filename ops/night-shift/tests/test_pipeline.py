"""Isolated end-to-end tests of the approved-run pipeline (issue #13, step 3) — no real deploy."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from night_shift.approval import ApprovalError
from night_shift.pipeline import Adapters, Pipeline
from night_shift.runstate import LockedError, RunState, run_lock

from helpers import BASE, Clock, FakeDeployer, FakeGitHub, FakeRepo, FakeWorker, manifest, raw_manifest


class PipelineTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.clock = Clock()
        self.repo = FakeRepo()
        self.github = FakeGitHub(self.repo)
        FakeGitHub.branch_heads = {}
        self.worker = FakeWorker(self.github)
        self.deployer = FakeDeployer(self.repo)
        self.approved = True

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def approve(self) -> bool:
        if self.approved is None:
            raise ApprovalError("the run was revoked")
        return self.approved

    def pipeline(self, m=None, state=None) -> Pipeline:
        m = m or manifest()
        state = state or RunState.create(
            self.dir / m.run_id, run_id=m.run_id, manifest_sha256=m.sha256, parts=[p.slug for p in m.parts], now=self.clock.now()
        )
        adapters = Adapters(
            worker=self.worker,
            git=self.repo,
            github=self.github,
            deployer=self.deployer,
            approve=self.approve,
            now=self.clock.now,
            sleep=self.clock.sleep,
        )
        return Pipeline(m, state, adapters, poll_seconds=60)

    # --- the happy path ----------------------------------------------------------------------

    def test_approved_run_implements_reviews_merges_deploys_and_verifies(self) -> None:
        p = self.pipeline()
        self.assertEqual(p.run(), "verified")
        part = p.s.data["parts"][0]
        self.assertEqual(self.github.merges, [part["pr_number"]])
        self.assertEqual(self.deployer.deploys, [part["merge_commit"]])
        self.assertEqual(self.repo.main, part["merge_commit"])
        # The morning report went to the PR, with SHAs, image and checks — no credentials.
        number, body = self.github.comments[-1]
        self.assertEqual(number, part["pr_number"])
        self.assertIn("VERIFIED", body)
        self.assertIn(part["merge_commit"][:12], body)
        self.assertIn("Production and WorkOS were not touched", body)
        self.assertNotRegex(body.lower(), r"password|token|secret")
        kinds = [e["to"] for e in p.s.events() if e["event"] == "moved"]
        self.assertEqual(
            kinds, ["implementing", "reviewing", "ci", "merging", "merged", "deploying", "verifying", "verified"]
        )

    def test_chained_parts_build_on_the_verified_merge_and_deploy_once(self) -> None:
        raw = raw_manifest(
            parts=[
                {"slug": "part-one", "title": "One", "task_sha256": "c" * 64, "risk": "normal"},
                {"slug": "part-two", "title": "Two", "task_sha256": "d" * 64, "risk": "critical"},
            ]
        )
        p = self.pipeline(manifest(**raw))
        self.assertEqual(p.run(), "verified")
        one, two = p.s.data["parts"]
        self.assertEqual(two["base"], one["merge_commit"])
        self.assertEqual(len(self.github.merges), 2)
        self.assertEqual(self.deployer.deploys, [two["merge_commit"]])

    def test_pr_only_and_merge_only_runs_stop_where_the_manifest_says(self) -> None:
        p = self.pipeline(manifest(permissions={"allow_merge": False, "allow_deploy_dev": False}))
        self.assertEqual(p.run(), "awaiting_owner")
        self.assertEqual(self.github.merges, [])
        self.assertEqual(self.deployer.deploys, [])

    def test_repair_round_then_pass(self) -> None:
        self.worker.blockers = [2, 0]
        p = self.pipeline()
        self.assertEqual(p.run(), "verified")
        self.assertEqual(p.s.data["parts"][0]["repairs"], 1)

    # --- refusals ----------------------------------------------------------------------------

    def test_missing_or_revoked_approval_stops_before_anything(self) -> None:
        self.approved = False
        p = self.pipeline()
        self.assertEqual(p.run(), "blocked")
        self.assertEqual(self.worker.implemented, [])

    def test_revocation_after_ci_stops_before_the_merge(self) -> None:
        p = self.pipeline()
        while p.s.phase != "merging":
            p.step()
        self.approved = None  # revoked
        self.assertEqual(p.run(), "blocked")
        self.assertIn("revoked", p.s.data["reason"])
        self.assertEqual(self.github.merges, [])

    def test_red_ci_blocks_and_never_merges(self) -> None:
        p = self.pipeline()
        while p.s.phase != "ci":
            p.step()
        self.github.red.add(p.s.part["head"])
        self.assertEqual(p.run(), "blocked")
        self.assertIn("CI", p.s.data["reason"])
        self.assertEqual(self.github.merges, [])

    def test_head_changed_after_review_blocks_the_merge(self) -> None:
        p = self.pipeline()
        while p.s.phase != "merging":
            p.step()
        number = p.s.part["pr_number"]
        pr = self.github.prs[number]
        self.github.prs[number] = type(pr)(pr.number, "OPEN", pr.head_ref, "f" * 40, "main")
        self.assertEqual(p.run(), "blocked")
        self.assertIn("head changed after the review", p.s.data["reason"])
        self.assertEqual(self.github.merges, [])

    def test_main_moved_blocks_instead_of_overwriting(self) -> None:
        p = self.pipeline()
        while p.s.phase != "merging":
            p.step()
        self.repo.main = "e" * 40  # someone else merged meanwhile
        self.assertEqual(p.run(), "blocked")
        self.assertIn("main moved", p.s.data["reason"])
        self.assertEqual(self.github.merges, [])

    def test_main_not_at_the_approved_base_blocks_at_start(self) -> None:
        self.repo.main = "e" * 40
        p = self.pipeline()
        self.assertEqual(p.run(), "blocked")
        self.assertIn("approved base", p.s.data["reason"])

    def test_inactive_branch_protection_blocks_the_merge(self) -> None:
        self.github.ruleset = False
        self.assertEqual(self.pipeline().run(), "blocked")
        self.assertEqual(self.github.merges, [])

    def test_out_of_scope_path_or_unapproved_migration_blocks(self) -> None:
        self.repo.default_paths = ["apps/web/x.tsx", ".github/workflows/ci.yml"]
        p = self.pipeline()
        self.assertEqual(p.run(), "blocked")
        self.assertIn(".github/workflows/ci.yml", p.s.data["reason"])
        self.repo.default_paths = ["apps/api/prisma/migrations/20261014000000_x/migration.sql"]
        q = self.pipeline(manifest(run_id="20261014-other", scope={"allowed_paths": ["apps/**"], "forbidden_paths": []}))
        self.assertEqual(q.run(), "blocked")
        self.assertIn("migration", q.s.data["reason"])

    def test_findings_remaining_after_the_allowed_repairs_block(self) -> None:
        self.worker.blockers = [1, 1]
        p = self.pipeline()
        self.assertEqual(p.run(), "blocked")
        self.assertIn("P0–P2", p.s.data["reason"])

    def test_time_budget_stops_new_work(self) -> None:
        p = self.pipeline()
        p.step()  # queued → implementing
        self.clock.t = self.clock.t.replace(hour=23) + (p.deadline - self.clock.t)
        self.assertEqual(p.run(), "blocked")
        self.assertIn("time budget", p.s.data["reason"])

    def test_ci_never_finishing_hits_the_budget(self) -> None:
        self.github.pending_polls = 10_000
        p = self.pipeline()
        self.assertEqual(p.run(), "blocked")
        self.assertIn("CI did not finish", p.s.data["reason"])

    def test_missing_deploy_credentials_block_the_deploy_not_the_merge(self) -> None:
        self.deployer.credentials = False
        p = self.pipeline()
        self.assertEqual(p.run(), "blocked")
        self.assertEqual(len(self.github.merges), 1)
        self.assertEqual(self.deployer.deploys, [])
        self.assertIn("credentials", p.s.data["reason"])

    def test_deploy_tooling_change_is_never_deployed(self) -> None:
        p = self.pipeline()
        while p.s.phase != "deploying":
            p.step()
        commit = p.s.data["parts"][0]["merge_commit"]
        self.repo.paths[(BASE, commit)] = ["scripts/deploy-dev.sh"]
        self.assertEqual(p.run(), "blocked")
        self.assertIn("deployment tooling changed", p.s.data["reason"])
        self.assertEqual(self.deployer.deploys, [])

    def test_failed_deploy_without_migrations_rolls_back_the_image(self) -> None:
        self.deployer.fail = True
        p = self.pipeline()
        self.assertEqual(p.run(), "blocked")
        self.assertEqual(self.deployer.rollbacks, ["old-tag"])
        self.assertIn("rolled back", p.s.data["reason"])

    def test_failed_deploy_after_migrations_never_rolls_back_automatically(self) -> None:
        self.deployer.fail = True
        self.deployer.fail_with_migrations = ["20261014000000_x"]
        self.repo.default_paths = ["apps/api/prisma/migrations/20261014000000_x/migration.sql"]
        m = manifest(
            scope={"allowed_paths": ["apps/**"], "forbidden_paths": []},
            migrations={"allowed": True, "max_new": 1, "destructive": False},
        )
        p = self.pipeline(m)
        self.assertEqual(p.run(), "blocked")
        self.assertEqual(self.deployer.rollbacks, [])
        self.assertIn("no automatic rollback", p.s.data["reason"])

    def test_without_a_signed_in_check_the_run_is_not_reported_verified(self) -> None:
        self.deployer.authenticated = None  # no smoke identity configured
        p = self.pipeline()
        self.assertEqual(p.run(), "deployed_unverified")
        body = self.github.comments[-1][1]
        self.assertIn("NOT FULLY VERIFIED", body)
        self.assertIn("signed-in application check: — not run", body)

    # --- restarts and concurrency ------------------------------------------------------------

    def test_restart_after_a_crash_never_duplicates_pr_merge_or_deploy(self) -> None:
        m = manifest()
        p = self.pipeline(m)
        while p.s.phase != "verifying":
            p.step()
        # Crash, then a new controller resumes from the checkpoint.
        resumed = self.pipeline(m, RunState.load(p.s.directory))
        self.assertEqual(resumed.run(), "verified")
        self.assertEqual(len(self.github.created), 1)
        self.assertEqual(len(self.github.merges), 1)
        self.assertEqual(len(self.deployer.deploys), 1)

    def test_crash_between_merge_and_checkpoint_resumes_from_github(self) -> None:
        m = manifest()
        p = self.pipeline(m)
        while p.s.phase != "merging":
            p.step()
        number = p.s.part["pr_number"]
        p.s.record(self.clock.now(), merge_intent=p.s.part["head"])
        self.github.merge(number)  # merged on GitHub, the controller died before recording it
        resumed = self.pipeline(m, RunState.load(p.s.directory))
        self.assertEqual(resumed.run(), "verified")
        self.assertEqual(self.github.merges, [number])

    def test_a_merge_done_outside_the_run_is_not_adopted(self) -> None:
        p = self.pipeline()
        while p.s.phase != "merging":
            p.step()
        self.github.merge(p.s.part["pr_number"])
        self.assertEqual(p.run(), "blocked")
        self.assertIn("outside this run", p.s.data["reason"])

    def test_crash_during_deploy_reconciles_with_the_deploy_log(self) -> None:
        m = manifest()
        p = self.pipeline(m)
        while p.s.phase != "deploying":
            p.step()
        commit = p.s.data["parts"][0]["merge_commit"]
        p.s.record_run(self.clock.now(), "deploy", intent=commit)
        # Unknown outcome: never deployed twice blindly.
        unknown = self.pipeline(m, RunState.load(p.s.directory))
        self.assertEqual(unknown.run(), "blocked")
        self.assertEqual(self.deployer.deploys, [])

    def test_crash_after_a_successful_deploy_continues_to_verification(self) -> None:
        m = manifest()
        p = self.pipeline(m)
        while p.s.phase != "deploying":
            p.step()
        commit = p.s.data["parts"][0]["merge_commit"]
        p.s.record_run(self.clock.now(), "deploy", intent=commit)
        self.deployer.deploy(commit)  # happened, checkpoint lost
        resumed = self.pipeline(m, RunState.load(p.s.directory))
        self.assertEqual(resumed.run(), "verified")
        self.assertEqual(self.deployer.deploys, [commit])

    def test_only_one_controller_at_a_time(self) -> None:
        lock = self.dir / "controller.lock"
        with run_lock(lock):
            with self.assertRaises(LockedError):
                with run_lock(lock):
                    pass
        with run_lock(lock):  # released
            pass

    def test_a_state_of_another_manifest_is_refused(self) -> None:
        p = self.pipeline()
        other = manifest(acceptance=["Jiný scénář"])
        with self.assertRaises(Exception):
            self.pipeline(other, RunState.load(p.s.directory))


if __name__ == "__main__":
    unittest.main()
