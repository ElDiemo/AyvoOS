"""Morning report of a run (issue #13, doc 024 §9) — written to GitHub and locally.

Facts only, all from the checkpointed state: no credentials, no personal data. A run is
"VERIFIED" only when the authenticated and every feature check passed; otherwise the report says
plainly what was not verified.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .manifest import Manifest
    from .runstate import RunState

HEADLINE = {
    "verified": "VERIFIED — merged, deployed to DEV and checked",
    "deployed_unverified": "DEPLOYED, NOT FULLY VERIFIED — merged and deployed to DEV; some checks did not run or failed",
    "awaiting_owner": "WAITING FOR THE OWNER — pull request(s) ready, not deployed",
    "blocked": "BLOCKED — stopped safely",
    "failed": "FAILED — stopped on an unexpected error",
    "cancelled": "CANCELLED",
}


def _mark(value: object) -> str:
    return {True: "✅", False: "❌", None: "— not run"}.get(value, str(value))  # type: ignore[arg-type]


def render_report(manifest: "Manifest", state: "RunState") -> str:
    d = state.data
    lines = [
        f"## Night shift — `{manifest.run_id}` (issue #{manifest.issue})",
        "",
        f"**{HEADLINE.get(state.phase, state.phase)}**",
        "",
    ]
    if d.get("reason"):
        lines += [f"Reason: {d['reason']}", ""]
    lines += [
        f"- Manifest: `{manifest.sha256}` (approved base `{manifest.base_commit}`)",
        f"- Merge allowed: {manifest.allow_merge}; DEV deploy allowed: {manifest.allow_deploy_dev}",
        f"- Started {d.get('started_at')}, last update {d.get('updated_at')}",
        "",
        "### Pull requests",
        "",
        "| Part | PR | Base | Reviewed head | Review | CI | Merge commit | CI on merge |",
        "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ]
    for p in d["parts"]:
        review = p.get("review") or {}
        lines.append(
            "| {slug} | {pr} | `{base}` | `{head}` | {review} | {ci} | `{merge}` | {mci} |".format(
                slug=p["slug"],
                pr=f"#{p['pr_number']}" if p.get("pr_number") else "—",
                base=(p.get("base") or "—")[:12],
                head=(p.get("head") or "—")[:12],
                review=(f"{review.get('blockers')} P0–P2" if review else "—"),
                ci=p.get("ci", "—"),
                merge=(p.get("merge_commit") or "—")[:12],
                mci=p.get("merge_ci", "—"),
            )
        )
    deploy = d.get("deploy") or {}
    lines += ["", "### DEV deploy", ""]
    if not deploy:
        lines.append("No deploy was started.")
    else:
        lines += [
            f"- Commit: `{deploy.get('intent', '—')}`",
            f"- Result: {'success' if deploy.get('ok') else 'not successful'}"
            + (f" ({deploy['error']})" if deploy.get("error") else ""),
            f"- Image tag: `{deploy.get('tag') or '—'}`; previous: `{deploy.get('previous_tag') or '—'}`",
            f"- Migrations applied: {', '.join(deploy.get('migrations_applied') or []) or 'none'}",
            f"- Backup before migration: `{deploy.get('backup') or '—'}`",
        ]
        if deploy.get("rolled_back_to"):
            lines.append(f"- Rolled back to `{deploy['rolled_back_to']}` (no migration had been applied)")
    smoke = d.get("smoke") or {}
    lines += ["", "### Checks on DEV", ""]
    if not smoke:
        lines.append("Not run.")
    else:
        for name, ok in sorted((smoke.get("base") or {}).items()):
            lines.append(f"- {name}: {_mark(ok)}")
        lines.append(f"- signed-in application check: {_mark(smoke.get('authenticated'))}")
    lines += ["", "### Acceptance scenarios", ""]
    feature = (smoke or {}).get("feature") or {}
    for scenario in manifest.acceptance:
        lines.append(f"- {_mark(feature.get(scenario))} {scenario}")
    lines += [
        "",
        f"Try it: {manifest.raw['target']['url']} (sign in yourself; this report contains no credentials).",
        "",
        "Production and WorkOS were not touched.",
    ]
    return "\n".join(lines) + "\n"
