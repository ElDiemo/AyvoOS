# AYVO Night Shift — operations

## Purpose

Runs up to two explicitly queued AYVO OS engineering jobs at 22:30 Europe/Prague on the DEV server.
It creates an isolated Git worktree, lets Claude Sonnet implement, runs local quality gates in an
isolated container, sends critical changes through an independent Fable review/fix loop, commits
the reviewed result, pushes a dedicated branch, opens a pull request and waits for GitHub CI.

It never merges a pull request and never deploys DEV or production.

## Safety boundaries

- The model and all repository-controlled test commands run in
  `ayvo-night-shift-runner:2.1.296-node24`.
- The container sees only its worktree, read-only Git metadata, a package cache and Claude's own
  authentication files. Server secrets, SSH keys and the Docker socket are not mounted.
- Bash tools available to the model are allow-listed. Git commit/push, GitHub publishing and CI
  polling are deterministic controller steps outside the model.
- Publishing accepts only `night/*` branches descended from the job's exact approved base commit.
- Changes to environment files, CI workflows and deployment scripts are rejected before commit.
- One global lock prevents overlapping shifts. At most two jobs are processed sequentially per
  night. If the first job blocks or fails, the second is not started.

## Schedule and queue

The user's crontab invokes `schedule.sh` every ten minutes. The script starts only at 22:30 in the
`Europe/Prague` timezone and records the local date so it cannot start twice after a clock change.
This does not depend on an SSH login, tmux or systemd user lingering.

Job definitions are mode-600 JSON files in `queue/ready`; task bodies are mode-600 Markdown files
in `jobs`. Preparation atomically moves a selected job to `queue/running`. Successful publication
moves it to `queue/done`. A blocked job remains in `queue/running` with the reason in `state.json`
and `reports/<job-id>.md`.

## Operator commands

```text
/opt/ayvo/bin/ayvo-night-shift status
/opt/ayvo/bin/ayvo-night-shift check
/opt/ayvo/bin/ayvo-night-shift run-now
```

`run-now` is for an explicitly approved manual start. It still does not merge or deploy.

Logs are under `logs/<job-id>/`; the concise morning report is under `reports/`. The pull request
body records the gates and review policy. GitHub remains the authoritative CI record.

## Recovery

- `blocked` means the controller stopped safely. Read the report and relevant log before retrying.
- Do not delete a worktree or branch while a job is active.
- If `origin/main` differs from the job's exact `base_commit`, preparation stops and the job must be
  re-planned; it never silently rebases a large unattended change.
- A failed CI run leaves the PR open and unmerged for a human or a new repair job.
- To pause future starts without touching a running job, remove or comment the marked crontab line.
