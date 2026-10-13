"""Run manifest validation and scope (issue #13, doc 024 §4)."""

from __future__ import annotations

import unittest

from night_shift.manifest import ManifestError, manifest_sha256, parse

from helpers import raw_manifest


class ManifestTest(unittest.TestCase):
    def test_a_valid_manifest_parses(self) -> None:
        m = parse(raw_manifest())
        self.assertEqual(m.run_id, "20261014-catalog-ui")
        self.assertTrue(m.allow_merge and m.allow_deploy_dev)
        self.assertEqual(m.required_checks, frozenset({"quality", "test", "e2e"}))

    def test_any_change_changes_the_hash(self) -> None:
        a = raw_manifest()
        b = raw_manifest(acceptance=["Katalog komponent je vidět v menu Výroba "])
        self.assertNotEqual(manifest_sha256(a), manifest_sha256(b))
        # Key order and whitespace do not matter: the canonical form is signed.
        self.assertEqual(manifest_sha256(a), manifest_sha256(dict(reversed(list(a.items())))))

    def test_strict_shape(self) -> None:
        bad = [
            raw_manifest(schema="ayvo-night-shift-run/2"),
            raw_manifest(repository="someone/else"),
            raw_manifest(run_id="Catalog UI"),
            raw_manifest(base_commit="abc"),
            raw_manifest(parts=[]),
            raw_manifest(parts=[{"slug": f"p-{i}x", "title": "t", "task_sha256": "c" * 64, "risk": "normal"} for i in range(4)]),
            raw_manifest(scope={"allowed_paths": ["**"], "forbidden_paths": []}),
            raw_manifest(scope={"allowed_paths": ["/etc/**"], "forbidden_paths": []}),
            raw_manifest(migrations={"allowed": True, "max_new": 1, "destructive": True}),
            raw_manifest(migrations={"allowed": False, "max_new": 1, "destructive": False}),
            raw_manifest(permissions={"allow_merge": False, "allow_deploy_dev": True}),
            raw_manifest(ci={"required_checks": ["quality", "test"]}),
            raw_manifest(acceptance=[]),
            raw_manifest(budget={"max_minutes": 5000, "max_repair_rounds": 1, "max_attempts_per_step": 2}),
            raw_manifest(target={"environment": "production", "url": "https://app.ayvo.co"}),
            raw_manifest(valid_until="2026-10-20T08:00:00+00:00"),
            raw_manifest(valid_from="2026-10-14T18:00:00"),
            {**raw_manifest(), "allow_everything": True},
        ]
        for raw in bad:
            with self.assertRaises(ManifestError, msg=str(raw)[:120]):
                parse(raw)

    def test_scope_never_includes_ci_deploy_runner_or_secrets(self) -> None:
        m = parse(raw_manifest(scope={"allowed_paths": ["apps/**", ".github/**", "scripts/**", "deploy/**", "ops/**", "CLAUDE.md"], "forbidden_paths": ["apps/api/**"]}))
        self.assertTrue(m.path_allowed("apps/web/src/app/page.tsx"))
        self.assertTrue(m.path_allowed("apps/web/.env.example"))
        for path in [
            ".github/workflows/ci.yml",
            "scripts/deploy-dev.sh",
            "deploy/dev/compose.yml",
            "ops/night-shift/night_shift/gates.py",
            ".env",
            "apps/web/.env.local",
            "CLAUDE.md",
            "apps/api/src/main.ts",
            "apps/web/certs/server.key",
        ]:
            self.assertFalse(m.path_allowed(path), path)

    def test_dotfiles_stay_forbidden_under_broad_globs(self) -> None:
        # Review P1: never strip characters from paths (".github" must not become "github").
        m = parse(raw_manifest(scope={"allowed_paths": ["**/*.yml", "**/*.json", "**/.env*", "apps/**"], "forbidden_paths": []}))
        for path in [".github/workflows/ci.yml", "./.github/workflows/ci.yml", ".env", ".env.production", "apps/web/.env.local"]:
            self.assertFalse(m.path_allowed(path), path)
        for path in ["/etc/passwd.yml", "apps/../.github/x.yml", "apps//x.json", "apps/./x.json"]:
            self.assertFalse(m.path_allowed(path), path)
        self.assertTrue(m.path_allowed("apps/web/messages.json"))
        self.assertTrue(m.path_allowed("./apps/web/messages.json"))

    def test_globs_are_path_aware(self) -> None:
        # Review P2: "*" stays within one directory level; "**" spans levels.
        m = parse(raw_manifest(scope={"allowed_paths": ["*.md", "apps/web/src/*.ts", "docs/**"], "forbidden_paths": []}))
        self.assertTrue(m.path_allowed("README.md"))
        self.assertFalse(m.path_allowed("apps/api/README.md"))
        self.assertTrue(m.path_allowed("apps/web/src/a.ts"))
        self.assertFalse(m.path_allowed("apps/web/src/lib/a.ts"))
        self.assertTrue(m.path_allowed("docs/a/b/c.md"))

    def test_migrations_only_when_approved(self) -> None:
        path = "apps/api/prisma/migrations/20261014000000_x/migration.sql"
        self.assertFalse(parse(raw_manifest(scope={"allowed_paths": ["apps/**"], "forbidden_paths": []})).path_allowed(path))
        approved = parse(
            raw_manifest(
                scope={"allowed_paths": ["apps/**"], "forbidden_paths": []},
                migrations={"allowed": True, "max_new": 1, "destructive": False},
            )
        )
        self.assertTrue(approved.path_allowed(path))


if __name__ == "__main__":
    unittest.main()
