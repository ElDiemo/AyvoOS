"""Run manifest of one owner-approved night-shift run (issue #13, doc 024 §4).

The manifest is the only source of authority for a run: what may be built (scope), on which base,
in how many chained pull requests, with which checks, and whether the controller may merge and
deploy to DEV. It is approved by the owner's SSH signature over its canonical bytes (approval.py);
any change to it — even whitespace-insensitive content — changes the hash and voids the approval.
Comments, labels or text in issues and pull requests never modify it.
"""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from functools import lru_cache
from datetime import datetime, timedelta, timezone
from typing import Any

SCHEMA = "ayvo-night-shift-run/1"
REPOSITORY = "ElDiemo/AyvoOS"
# The only deployment target this automation knows. Production and WorkOS are never targets.
DEV_TARGET = {"environment": "dev-preview", "url": "https://dev.ayvo.co"}
MAX_PARTS = 3
MAX_WINDOW = timedelta(hours=24)

RUN_ID_RE = re.compile(r"^[0-9]{8}-[a-z0-9][a-z0-9-]{2,60}$")
SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]{2,50}$")
SHA_RE = re.compile(r"^[0-9a-f]{40}$")
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
CHECK_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,40}$")

# Never in scope, whatever the manifest says: CI, deployment, the runner itself, secrets.
ALWAYS_FORBIDDEN = (
    ".github/**",
    "deploy/**",
    "scripts/deploy-*.sh",
    "ops/**",
    "**/.env",
    "**/.env.*",
    "**/*.pem",
    "**/*.key",
    "CLAUDE.md",
)
ALLOWED_ENV_EXAMPLE = ".env.example"


class ManifestError(ValueError):
    """The manifest is malformed or violates a rule; the run must not start."""


def canonical_bytes(manifest: dict[str, Any]) -> bytes:
    """The exact bytes the owner signs: JSON, sorted keys, no insignificant whitespace, UTF-8."""
    return json.dumps(manifest, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode(
        "utf-8"
    )


def manifest_sha256(manifest: dict[str, Any]) -> str:
    return hashlib.sha256(canonical_bytes(manifest)).hexdigest()


def _parse_time(value: Any, field: str) -> datetime:
    if not isinstance(value, str):
        raise ManifestError(f"{field} must be an ISO 8601 timestamp")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ManifestError(f"{field} is not an ISO 8601 timestamp") from exc
    if parsed.tzinfo is None:
        raise ManifestError(f"{field} needs a time zone")
    return parsed.astimezone(timezone.utc)


def _require(obj: Any, field: str, kind: type | tuple[type, ...]) -> Any:
    if not isinstance(obj, dict) or field not in obj:
        raise ManifestError(f"missing {field}")
    value = obj[field]
    if not isinstance(value, kind) or (kind is int and isinstance(value, bool)):
        raise ManifestError(f"{field} has the wrong type")
    return value


def _exact_keys(obj: dict[str, Any], keys: set[str], where: str) -> None:
    extra = set(obj) - keys
    missing = keys - set(obj)
    if extra or missing:
        raise ManifestError(
            f"{where}: unexpected {sorted(extra)}" if extra else f"{where}: missing {sorted(missing)}"
        )


@dataclass(frozen=True)
class Part:
    slug: str
    title: str
    task_sha256: str
    risk: str


@dataclass(frozen=True)
class Manifest:
    raw: dict[str, Any]
    sha256: str
    run_id: str
    issue: int
    base_commit: str
    parts: tuple[Part, ...]
    allowed_paths: tuple[str, ...]
    forbidden_paths: tuple[str, ...]
    migrations_allowed: bool
    max_new_migrations: int
    allow_merge: bool
    allow_deploy_dev: bool
    required_checks: frozenset[str]
    acceptance: tuple[str, ...]
    max_minutes: int
    max_repair_rounds: int
    max_attempts_per_step: int
    valid_from: datetime
    valid_until: datetime

    def is_valid_at(self, moment: datetime) -> bool:
        return self.valid_from <= moment < self.valid_until

    def path_allowed(self, path: str) -> bool:
        """True when a changed repository path is inside the approved scope."""
        normalized = normalize_path(path)
        if normalized is None:
            return False
        if normalized == ALLOWED_ENV_EXAMPLE or normalized.endswith("/" + ALLOWED_ENV_EXAMPLE):
            forbidden_hit = False
        else:
            forbidden_hit = any(_match(normalized, p) for p in self.forbidden_paths)
        if forbidden_hit:
            return False
        if normalized.startswith("apps/api/prisma/migrations/") and not self.migrations_allowed:
            return False
        return any(_match(normalized, p) for p in self.allowed_paths)


def normalize_path(path: str) -> str | None:
    """A repository-relative path as git reports it, or None for anything suspicious.

    Only a literal leading "./" is removed — never characters (".github" stays ".github"). Absolute
    paths, empty segments and "."/".." segments are refused.
    """
    if path.startswith("./"):
        path = path[2:]
    segments = path.split("/")
    if not path or path.startswith("/") or any(s in {"", ".", ".."} for s in segments):
        return None
    return path


@lru_cache(maxsize=512)
def _glob_regex(pattern: str) -> re.Pattern[str]:
    """Path-aware globs: `*` and `?` stay within one segment; `**` spans segments; a leading
    `**/` also matches the top level and a trailing `/**` everything below."""
    out = []
    i = 0
    while i < len(pattern):
        if pattern.startswith("**/", i):
            out.append("(?:.*/)?")
            i += 3
        elif pattern.startswith("**", i):
            out.append(".*")
            i += 2
        elif pattern[i] == "*":
            out.append("[^/]*")
            i += 1
        elif pattern[i] == "?":
            out.append("[^/]")
            i += 1
        else:
            out.append(re.escape(pattern[i]))
            i += 1
    return re.compile("".join(out) + r"\Z", re.DOTALL)


def _match(path: str, pattern: str) -> bool:
    return _glob_regex(pattern).match(path) is not None


def parse(raw: dict[str, Any]) -> Manifest:
    """Validates a manifest strictly (unknown keys are errors) and returns the typed view."""
    if not isinstance(raw, dict):
        raise ManifestError("the manifest is a JSON object")
    _exact_keys(
        raw,
        {
            "schema",
            "run_id",
            "repository",
            "feature",
            "base_commit",
            "parts",
            "scope",
            "migrations",
            "permissions",
            "ci",
            "acceptance",
            "budget",
            "target",
            "valid_from",
            "valid_until",
        },
        "manifest",
    )
    if raw["schema"] != SCHEMA:
        raise ManifestError(f"unsupported schema {raw['schema']!r}")
    if raw["repository"] != REPOSITORY:
        raise ManifestError("wrong repository")
    run_id = _require(raw, "run_id", str)
    if not RUN_ID_RE.fullmatch(run_id):
        raise ManifestError("invalid run_id")

    feature = _require(raw, "feature", dict)
    _exact_keys(feature, {"issue", "title", "brief_sha256"}, "feature")
    issue = _require(feature, "issue", int)
    if issue < 1:
        raise ManifestError("feature.issue must be a GitHub issue number")
    if not SHA256_RE.fullmatch(_require(feature, "brief_sha256", str)):
        raise ManifestError("feature.brief_sha256 must be a SHA-256")

    base = _require(raw, "base_commit", str)
    if not SHA_RE.fullmatch(base):
        raise ManifestError("base_commit must be a full commit SHA")

    raw_parts = _require(raw, "parts", list)
    if not 1 <= len(raw_parts) <= MAX_PARTS:
        raise ManifestError(f"parts: 1 to {MAX_PARTS} chained pull requests")
    parts: list[Part] = []
    for index, item in enumerate(raw_parts):
        _exact_keys(item, {"slug", "title", "task_sha256", "risk"}, f"parts[{index}]")
        slug = _require(item, "slug", str)
        if not SLUG_RE.fullmatch(slug):
            raise ManifestError(f"parts[{index}].slug is invalid")
        if not SHA256_RE.fullmatch(_require(item, "task_sha256", str)):
            raise ManifestError(f"parts[{index}].task_sha256 must be a SHA-256")
        if item["risk"] not in {"normal", "critical"}:
            raise ManifestError(f"parts[{index}].risk must be normal or critical")
        parts.append(Part(slug, _require(item, "title", str), item["task_sha256"], item["risk"]))
    if len({p.slug for p in parts}) != len(parts):
        raise ManifestError("part slugs must be unique")

    scope = _require(raw, "scope", dict)
    _exact_keys(scope, {"allowed_paths", "forbidden_paths"}, "scope")
    allowed = _require(scope, "allowed_paths", list)
    forbidden = _require(scope, "forbidden_paths", list)
    if not allowed or not all(isinstance(p, str) and p and not p.startswith("/") for p in allowed):
        raise ManifestError("scope.allowed_paths: non-empty relative glob patterns")
    if not all(isinstance(p, str) and p for p in forbidden):
        raise ManifestError("scope.forbidden_paths: glob patterns")
    if any(p in {"**", "*", "**/*"} for p in allowed):
        raise ManifestError("scope.allowed_paths must not allow the whole repository")

    migrations = _require(raw, "migrations", dict)
    _exact_keys(migrations, {"allowed", "max_new", "destructive"}, "migrations")
    migrations_allowed = _require(migrations, "allowed", bool)
    max_new = _require(migrations, "max_new", int)
    if migrations["destructive"] is not False:
        raise ManifestError("destructive migrations are never part of an automated run")
    if not migrations_allowed and max_new != 0:
        raise ManifestError("migrations.max_new must be 0 when migrations are not allowed")
    if not 0 <= max_new <= 5:
        raise ManifestError("migrations.max_new: 0 to 5")

    permissions = _require(raw, "permissions", dict)
    _exact_keys(permissions, {"allow_merge", "allow_deploy_dev"}, "permissions")
    allow_merge = _require(permissions, "allow_merge", bool)
    allow_deploy = _require(permissions, "allow_deploy_dev", bool)
    if allow_deploy and not allow_merge:
        raise ManifestError("allow_deploy_dev needs allow_merge (only merged commits are deployed)")

    ci = _require(raw, "ci", dict)
    _exact_keys(ci, {"required_checks"}, "ci")
    checks = _require(ci, "required_checks", list)
    if not checks or not all(isinstance(c, str) and CHECK_RE.fullmatch(c) for c in checks):
        raise ManifestError("ci.required_checks: non-empty list of check names")
    if not {"quality", "test", "e2e"} <= set(checks):
        raise ManifestError("ci.required_checks must include quality, test and e2e")

    acceptance = _require(raw, "acceptance", list)
    if not acceptance or not all(isinstance(a, str) and a.strip() for a in acceptance):
        raise ManifestError("acceptance: at least one scenario")

    budget = _require(raw, "budget", dict)
    _exact_keys(budget, {"max_minutes", "max_repair_rounds", "max_attempts_per_step"}, "budget")
    max_minutes = _require(budget, "max_minutes", int)
    repair = _require(budget, "max_repair_rounds", int)
    attempts = _require(budget, "max_attempts_per_step", int)
    if not 30 <= max_minutes <= 600 or not 0 <= repair <= 3 or not 1 <= attempts <= 3:
        raise ManifestError("budget out of bounds (30–600 min, 0–3 repairs, 1–3 attempts)")

    if raw["target"] != DEV_TARGET:
        raise ManifestError("target must be exactly the DEV preview")

    valid_from = _parse_time(raw["valid_from"], "valid_from")
    valid_until = _parse_time(raw["valid_until"], "valid_until")
    if not valid_from < valid_until <= valid_from + MAX_WINDOW:
        raise ManifestError("validity window: positive and at most 24 hours")

    return Manifest(
        raw=raw,
        sha256=manifest_sha256(raw),
        run_id=run_id,
        issue=issue,
        base_commit=base,
        parts=tuple(parts),
        allowed_paths=tuple(allowed),
        forbidden_paths=tuple(ALWAYS_FORBIDDEN) + tuple(forbidden),
        migrations_allowed=migrations_allowed,
        max_new_migrations=max_new,
        allow_merge=allow_merge,
        allow_deploy_dev=allow_deploy,
        required_checks=frozenset(checks),
        acceptance=tuple(a.strip() for a in acceptance),
        max_minutes=max_minutes,
        max_repair_rounds=repair,
        max_attempts_per_step=attempts,
        valid_from=valid_from,
        valid_until=valid_until,
    )


def task_sha256(task_text: str) -> str:
    """Hash of a part's task file, as recorded in the manifest (exact bytes, UTF-8)."""
    return hashlib.sha256(task_text.encode("utf-8")).hexdigest()
