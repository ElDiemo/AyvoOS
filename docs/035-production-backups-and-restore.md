# 035 — Production backups and restore

Status: **implemented, not installed** (owner request 2026-10-22). Nothing here runs until the
owner installs it on AyvoOS-PROD and enables the timers (§6). DEV is unaffected.

The production database (PostgreSQL 18 in the production Compose project, doc 036) is backed up
to the private, versioned backup bucket. The tool is `ops/prod-backup` (Python standard library,
tests by `pnpm test`), run by systemd.

## 1. What is kept where

| What                                                        | Where                                                                | Kept                                                              |
| ----------------------------------------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Hourly dump + manifest                                      | `s3://ayvo-prod-backups-888725257303-eu-north-1-an/database/hourly/` | 2 days (+1 day for non-current versions) — owner's lifecycle rule |
| Daily dump + manifest (a separate object, taken separately) | `…/database/daily/`                                                  | 30 days (+1 day) — owner's lifecycle rule                         |
| Last success / failure / skip, last restore check           | `/var/lib/ayvo-backup/*.json` on PROD                                | until overwritten                                                 |
| Application files (label artwork, PDFs, supplier documents) | `ayvo-prod-files-888725257303-eu-north-1-an` (#47, ADR 0032)         | versioned bucket, no lifecycle (§7)                               |

Bucket: `eu-north-1`, owner account `888725257303` (pinned on every request with
`--expected-bucket-owner`), private, versioned, SSE-S3, ACLs off, **no Object Lock**.

Keys: `database/<hourly|daily>/ayvo-prod-<UTC yyyymmddThhmmssZ>-<8 random hex>.dump` and the same
key + `.manifest.json`. Unique per run, and written with `If-None-Match: *` — an existing object is
never overwritten. Nothing else is written under these prefixes, and nothing outside them.

**Retention is the bucket's lifecycle, not this tool.** Expiry is asynchronous and continues while
new backups fail: after 2 days without a successful hourly backup there is no hourly backup, after
30 days without a daily one there is no daily one. The tool does **not** keep "the last good
backup" — a stale backup must be noticed (§5) and fixed. Copying a known-good backup elsewhere
before it expires is a manual owner decision.

## 2. One backup (`python3 -m ayvo_backup run --kind hourly|daily`)

1. **Lock** (`/var/lib/ayvo-backup/backup.lock`). An hourly run while another runs is skipped with
   exit 75 and recorded (`last-skipped-<kind>.json`); a daily run waits for it (up to 45 min) so the
   day's backup is not lost to a long hourly run. Runs never overlap.
2. **Clean** leftovers of a killed run — only our own `run-<id>` directories and, inside the
   database container, only `/tmp/ayvo-backup-<id>.*`.
3. **Credentials** from `/opt/ayvo/secrets/prod-s3-backup.env` (must be mode 600, owned by `ayvo`
   or root; `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, optional `AWS_SESSION_TOKEN`). They go
   into a mode-600 env file of the run directory for the AWS CLI container — never into a process
   argument, a log or the state files.
4. **Space** before anything is written. The dump is held to a byte cap that both disks can
   really take: the smallest of the configured cap (`--max-dump-gb`, default 10 GiB), the
   database container's free `/tmp` — the live database's disk — minus a 2 GiB reserve, and a
   third of the host's free `/var/lib/ayvo-backup` minus the reserve (the host copy, the read-back,
   and the container's copy if it is the same disk). If that budget is below the expected dump
   (the database's size, at most the configured cap), the run fails at `space` and writes nothing.
   `--max-dump-gb` must be a finite, positive size of at least one byte (0, negative, NaN or
   infinite values are refused before anything runs); the reserve is never negative.
5. **Dump** inside the running database container: one `REPEATABLE READ READ ONLY` transaction
   exports its snapshot; `pg_dump --format=custom --compress=6 --snapshot=…` dumps exactly that
   snapshot, and the same snapshot's statistics are written alongside — rows of every table,
   foreign keys (and any not validated), user triggers, finished Prisma migrations, server
   version. That is the **manifest**: what a restore must reproduce. Timeout 30 min. The dump is
   written through `head -c <cap + 1>` with the cap of step 4: it can never grow past what the
   disks can take; a dump that reaches it fails (`the dump exceeds the limit`) and is removed.
6. **Local check**: `pg_restore --list` reads the whole archive; size > 0; SHA-256.
7. **Upload** with the pinned AWS CLI image (`amazon/aws-cli` 2.38.1 by digest, read-only, no
   capabilities): `put-object` with `--checksum-sha256` (S3 refuses a body that does not match),
   SSE-S3, `If-None-Match: *`. Then **verify**: `head-object` size, SHA-256 and metadata, and a
   **read-back** (`get-object`) hashed again. Up to 3 attempts (10 s, 30 s apart), 15 min each. A
   retry after a lost answer finds its own object (`412`) and accepts it only if it verifies.
8. **Manifest** uploaded and verified the same way. A backup is complete only when both exist.
9. **State**: `last-success-<kind>.json` (key, size, SHA-256, tables, rows, times) or
   `last-failure-<kind>.json` (step and a message without secrets). Exit 0 / 1.

On SIGTERM/SIGINT (systemd stop, timeout) the running command is killed, the run directory and
the container's temporary files are removed and the failure is recorded. The AWS CLI container is
named and removed (`docker rm -f`) in every case, so an abandoned upload cannot finish later. A PUT
is atomic: an interrupted one stores nothing; one that completed just before the interruption may
leave a dump **without manifest** — never counted as a backup (`--latest` needs both) and expired
by the lifecycle. After SIGKILL the next run removes the local leftovers (step 2).

The backup identity needs `s3:PutObject`, `s3:GetObject` and `s3:ListBucket` (restore check
`--latest`) on the backup bucket. It has **no `s3:DeleteObject` and no lifecycle permission** —
the tool never deletes or changes retention, and does not need it. Do not widen it.

## 3. Restore check (`python3 -m ayvo_backup restore-check …`)

`--latest daily|hourly` (newest complete backup), `--key <key>`, or `--file <dump> --manifest
<json>` (a downloaded copy). Steps:

1. The dump's SHA-256 and size must equal the manifest's (a damaged object is refused).
2. A **new** PostgreSQL container (`docker run --rm --network none`, a random password, the image
   of the running database container or `--pg-image`) — never the running database, never DEV's.
3. `pg_restore --exit-on-error --single-transaction --no-owner --no-privileges` into a new
   database: every primary key, unique index, check, foreign key and trigger is created and
   validated, or the whole restore fails.
4. The same statistics query as at dump time: **every table's row count**, the number of foreign
   keys and triggers, no unvalidated constraint, the same finished migrations — compared with the
   manifest; any difference fails the check.
5. The container is removed (`docker rm -f`), also on failure. Result in
   `last-restore-check.json`.

The weekly timer checks the newest daily backup. Run it by hand after the first backup and after
any change to the database schema tooling.

## 4. Real restore (owner, deliberate)

A restore replaces data and is **never automatic**; a newer database is never overwritten by an
older backup without the owner deciding so.

1. Stop the application writers: `docker compose -p ayvo-prod stop api web` (doc 036).
2. Take a fresh backup of the current state first (`run --kind daily --reason before-restore`),
   even if the database is suspected broken — it may be needed.
3. Download the chosen backup and manifest; `restore-check --file … --manifest …` must pass.
4. Restore into a **new** database (`createdb ayvo_restored`; `pg_restore … -d ayvo_restored`),
   compare with the manifest, then switch the API's `POSTGRES_DB` to it (or rename databases) in a
   maintenance window. Never `pg_restore --clean` over the live database.
5. Start the API, verify sign-in and Obchod, record what was restored and why.

## 5. Noticing a failure (no paid service, no messages without consent)

- The units fail visibly: `systemctl --failed`, `journalctl -u 'ayvo-prod-backup@*'`.
- `ayvo-prod-backup-check.timer` (every 30 min) runs `status`: exit 1 — a failed unit logged at
  priority `err` — when the last hourly success is older than 2.5 h, the last daily older than
  26 h, the last run of either failed, or the last restore check failed, is older than 8 days or
  **never ran** (backups never restored are not known to be usable — so `status` stays red after
  installation until the first restore check, §6 step 4).
- Any failure of a run is recorded (`last-failure-<kind>.json`), also an unexpected one.
- Every SSH login shows the same status (`/etc/update-motd.d/90-ayvo-backup`).
- The deployment script (doc 036) shows the status before every release.
- Optional later, only with the owner's consent: a notification channel (e.g. an e-mail from
  the server, or a free push service) triggered by `OnFailure=` of these units. Not configured.

## 6. Installation (owner, on AyvoOS-PROD; no timers until step 5)

1. Docker and the production stack are installed (doc 036); `/opt/ayvo/secrets/prod-s3-backup.env`
   exists (`ayvo:ayvo`, mode 600) with the backup identity's `AWS_ACCESS_KEY_ID` and
   `AWS_SECRET_ACCESS_KEY` (rename the keys if the file uses other names; values are never
   copied anywhere else).
2. `sudo bash ops/prod-backup/install.sh` — code, units, login message; enables nothing. Like
   `uninstall.sh`, it first checks that this is AyvoOS-PROD (`ops/prod-backup/prod-host.sh`:
   hostname `AyvoOS-PROD`, Tailscale IPv4 `100.88.139.2`, no trace of the DEV preview) and refuses
   to change anything otherwise.
3. First backup by hand: `sudo systemctl start ayvo-prod-backup@daily.service`, then
   `journalctl -u ayvo-prod-backup@daily -n 50` and `python3 -m ayvo_backup status`
   (`PYTHONPATH=/usr/local/lib/ayvo-backup`).
4. `sudo systemctl start ayvo-prod-restore-check.service` must report OK.
5. Then, and only then: `sudo systemctl enable --now ayvo-prod-backup-hourly.timer
ayvo-prod-backup-daily.timer ayvo-prod-restore-check.timer ayvo-prod-backup-check.timer`.

Undo: `sudo bash ops/prod-backup/uninstall.sh` (keeps `/var/lib/ayvo-backup`, deletes nothing in S3).

Disk: a run needs room for one dump in the database container's `/tmp` and one copy (plus a
read-back) in `/var/lib/ayvo-backup/tmp`; all three are removed at the end of the run.

## 7. Recovering the application files and keys (a dump is not a complete restore)

A database dump alone does not restore AYVO OS. Also needed:

- **Application files** (`FileStorage`, #47 / ADR 0032): the files bucket is versioned. An
  overwritten or deleted object is recovered from its previous version (`list-object-versions`,
  then `get-object --version-id` or a copy) by an identity with that permission — not the
  runtime identities. The database holds the keys of the files it references; restoring an older
  dump may reference files that still exist (nothing is deleted by the application). There is no
  separate copy of the files bucket and no lifecycle on it; a second copy (replication or a
  periodic copy to the backup account) is an open owner decision.
- **Secrets** — not in any backup, by design (never in the backup bucket, which the backup
  identity can read): `/opt/ayvo/secrets/prod-*.env` on PROD. The owner keeps an offline copy in
  their password manager. Without it:
  - WorkOS (`prod-workos*.env`): re-issued in the WorkOS dashboard (API key); client ID and
    issuer are not secret (doc 036).
  - S3 identities (`prod-s3*.env`): new access keys in IAM.
  - Database password: set again in the env file and with `ALTER ROLE` in the restored database.
  - `CARRIER_CREDENTIALS_KEY` (ADR 0027, only if carriers are ever configured in production):
    **cannot be re-created** — encrypted carrier credentials in a restored dump are unreadable
    without it and must be entered again. Keep it with the other secrets the moment it is set.
- **TLS certificates** (Caddy volume) are re-issued automatically; not backed up.

## 8. Availability risk

The AWS project has a monthly spend limit of 20 USD that can **suspend the project**. While
suspended, uploads fail (the units fail and §5 shows it), the application's file storage fails,
and the lifecycle may still expire old backups. The limit and billing are the owner's; this tool
neither reads nor changes them. Hourly dumps of a small database cost little, but the read-back
doubles transfer — keep an eye on the bill after the first weeks.

## 9. Verified by tests (`ops/prod-backup/tests`, real PostgreSQL 18 in Docker)

Hourly and daily objects with unique keys under exactly the two prefixes; the manifest's counts,
foreign keys, triggers and migrations; a restore into a new container reproduces them; a damaged
dump is refused; a restore with other data than the manifest is refused; a failing upload is
retried and then recorded as a failure with nothing left behind; a lost answer after an upload is
verified, not written twice; SIGTERM during the upload leaves no object and no temporary file;
after SIGKILL the next run cleans up; a second run while one runs is skipped; credentials must be
private and never appear in a command line; the command never overwrites and never deletes. The
AWS CLI itself is not exercised by the tests (the bucket is a directory); the first manual backup
on PROD (§6) is the end-to-end check.
