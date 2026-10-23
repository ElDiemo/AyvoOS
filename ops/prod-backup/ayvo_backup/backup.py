"""AYVO OS — production PostgreSQL backups to S3 and their restore check (doc 035).

    python3 -m ayvo_backup run --kind hourly|daily [--reason TEXT]
    python3 -m ayvo_backup restore-check (--latest hourly|daily | --key KEY | --file DUMP --manifest JSON)
    python3 -m ayvo_backup status [--max-age-hours N]

`run` takes a consistent, compressed dump inside the running PostgreSQL container (`pg_dump`
in one exported REPEATABLE READ snapshot, together with the row counts, foreign keys, triggers
and migrations of that same snapshot — the manifest), checks it locally, uploads it under a
unique key of `database/hourly/` or `database/daily/` (never overwriting: `If-None-Match: *`),
lets S3 verify its SHA-256, reads it back and compares, then uploads the manifest. A backup is
complete only when both objects exist and match.

`restore-check` restores a backup into a NEW, throwaway PostgreSQL container without any network
(never into a running database) and compares the restored data with the manifest.

Never: deleting objects, changing bucket lifecycle, credentials in process arguments or logs,
restoring over a live database. Old backups expire by the bucket's lifecycle rules (set by the
owner), also while new backups fail — the last good backup is NOT kept automatically.
"""

from __future__ import annotations

import argparse
import base64
import fcntl
import hashlib
import json
import os
import re
import secrets
import shutil
import signal
import stat
import subprocess
import sys
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

# Production defaults (not secret). Every one can be overridden for a test by a flag.
BUCKET = 'ayvo-prod-backups-888725257303-eu-north-1-an'
BUCKET_OWNER = '888725257303'
REGION = 'eu-north-1'
CREDENTIALS_FILE = '/opt/ayvo/secrets/prod-s3-backup.env'
STATE_DIR = '/var/lib/ayvo-backup'
PG_CONTAINER = 'ayvo-prod-postgres-1'
# amazon/aws-cli 2.38.1 (published 2026-10-14), multi-arch index digest.
AWS_IMAGE = (
    'amazon/aws-cli@sha256:733d5be1015825e4038c6016f3fa9954868ddee1f611b73be795a9cc2e706bfd'
)
# The exact prefixes of the owner's lifecycle rules (hourly: 2 days, daily: 30 days).
PREFIXES = {'hourly': 'database/hourly/', 'daily': 'database/daily/'}
# A backup older than this is "stale" for `status` (exit 1).
MAX_AGE_HOURS = {'hourly': 2.5, 'daily': 26.0}
# The weekly restore check (doc 035 §3): a failed one, or none for longer than this, is a problem.
MAX_RESTORE_CHECK_AGE_DAYS = 8
# A daily backup waits this long for a running hourly one instead of being skipped.
DAILY_LOCK_WAIT = 2700

DUMP_TIMEOUT = 1800
UPLOAD_TIMEOUT = 900
UPLOAD_ATTEMPTS = 3
RETRY_DELAYS = (10, 30)

EXIT_OK = 0
EXIT_FAILED = 1
EXIT_USAGE = 2
EXIT_BUSY = 75  # EX_TEMPFAIL: another backup holds the lock

# The statistics of one snapshot: rows per table, foreign keys (and any not validated), triggers
# and finished migrations. Run in the dump's own snapshot and again on the restored copy.
STATS_SQL = r"""
SELECT json_build_object(
  'counts', (
    SELECT coalesce(json_object_agg(t.schemaname || '.' || t.tablename,
      (xpath('/row/c/text()', query_to_xml(
        format('SELECT count(*) AS c FROM %I.%I', t.schemaname, t.tablename),
        false, true, '')))[1]::text::bigint
      ORDER BY t.schemaname, t.tablename), '{}'::json)
    FROM pg_tables t WHERE t.schemaname NOT IN ('pg_catalog', 'information_schema')),
  'foreignKeys', (
    SELECT count(*) FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
    WHERE c.contype = 'f' AND n.nspname NOT IN ('pg_catalog', 'information_schema')),
  'notValidated', (
    SELECT count(*) FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
    WHERE NOT c.convalidated AND n.nspname NOT IN ('pg_catalog', 'information_schema')),
  'triggers', (
    SELECT count(*) FROM pg_trigger tg JOIN pg_class cl ON cl.oid = tg.tgrelid
    JOIN pg_namespace n ON n.oid = cl.relnamespace
    WHERE NOT tg.tgisinternal AND n.nspname NOT IN ('pg_catalog', 'information_schema')),
  'migrations', CASE WHEN to_regclass('public._prisma_migrations') IS NULL THEN '[]'::json
    ELSE coalesce((xpath('/row/m/text()', query_to_xml(
      'SELECT json_agg(migration_name ORDER BY migration_name) AS m FROM public._prisma_migrations'
      || ' WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL',
      false, true, '')))[1]::text::json, '[]'::json) END,
  'serverVersion', current_setting('server_version_num')::int
);
"""


class BackupError(Exception):
    """A failed step; the message never contains a secret."""

    def __init__(self, step: str, message: str):
        super().__init__(f'{step}: {message}')
        self.step = step


class Interrupted(Exception):
    pass


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def log(message: str) -> None:
    print(f'ayvo-backup: {message}', file=sys.stderr, flush=True)


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open('rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


def b64_of_hex(hex_digest: str) -> str:
    return base64.b64encode(bytes.fromhex(hex_digest)).decode()


def write_json_atomic(path: Path, data: object) -> None:
    tmp = path.with_name(f'.{path.name}.{os.getpid()}.tmp')
    tmp.write_text(json.dumps(data, indent=2, sort_keys=True) + '\n')
    os.chmod(tmp, 0o640)
    os.replace(tmp, path)


# --- processes --------------------------------------------------------------------------------


class Runner:
    """Runs commands with a timeout; on SIGTERM/SIGINT kills the running one and raises."""

    def __init__(self) -> None:
        self.current: subprocess.Popen | None = None

    def run(self, argv: list[str], *, timeout: int, step: str, stdin=None, stdout=None,
            input_bytes: bytes | None = None) -> subprocess.CompletedProcess:
        try:
            self.current = subprocess.Popen(
                argv,
                stdin=subprocess.PIPE if input_bytes is not None else stdin,
                stdout=stdout if stdout is not None else subprocess.PIPE,
                stderr=subprocess.PIPE,
                start_new_session=True,
            )
            out, err = self.current.communicate(input=input_bytes, timeout=timeout)
        except subprocess.TimeoutExpired:
            self.kill()
            raise BackupError(step, f'timed out after {timeout} s')
        except FileNotFoundError:
            raise BackupError(step, f'{argv[0]} is not installed')
        finally:
            proc, self.current = self.current, None
        return subprocess.CompletedProcess(argv, proc.returncode if proc else -1, out, err)

    def kill(self) -> None:
        proc = self.current
        if proc and proc.poll() is None:
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            proc.wait()


def tail(err: bytes | None, limit: int = 400) -> str:
    text = (err or b'').decode('utf-8', 'replace').strip()
    return text[-limit:]


# --- credentials ------------------------------------------------------------------------------

CREDENTIAL_KEYS = ('AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY')
OPTIONAL_CREDENTIAL_KEYS = ('AWS_SESSION_TOKEN',)


def read_credentials(path: Path) -> dict[str, str]:
    """The backup identity from a KEY=VALUE file (mode 600, owned by us or root). Never logged."""
    try:
        st = path.stat()
    except FileNotFoundError:
        raise BackupError('credentials', f'{path} does not exist')
    if stat.S_IMODE(st.st_mode) & 0o077:
        raise BackupError('credentials', f'{path} must not be readable by group or others')
    if st.st_uid not in (os.getuid(), 0):
        raise BackupError('credentials', f'{path} must belong to the backup user or root')
    values: dict[str, str] = {}
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith('#') or '=' not in line:
            continue
        key, value = line.split('=', 1)
        key = key.strip().removeprefix('export ').strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in '"\'':
            value = value[1:-1]
        values[key] = value
    missing = [k for k in CREDENTIAL_KEYS if not values.get(k)]
    if missing:
        raise BackupError('credentials', f'{path} lacks {", ".join(missing)}')
    return {k: values[k] for k in CREDENTIAL_KEYS + OPTIONAL_CREDENTIAL_KEYS if values.get(k)}


# --- S3 through the AWS CLI container ---------------------------------------------------------


class S3:
    """put / head / get of one bucket through the pinned AWS CLI image. Credentials go into a
    mode-600 env file of the run directory — never into a process argument."""

    def __init__(self, runner: Runner, *, bucket: str, owner: str, region: str, image: str,
                 workdir: Path, credentials: dict[str, str]):
        self.runner, self.bucket, self.owner, self.region = runner, bucket, owner, region
        self.image, self.workdir = image, workdir
        self.env_file = workdir / 'aws.env'
        fd = os.open(self.env_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'w') as f:
            for k, v in credentials.items():
                f.write(f'{k}={v}\n')
            f.write(f'AWS_REGION={region}\nAWS_DEFAULT_REGION={region}\n')
            f.write('AWS_EC2_METADATA_DISABLED=true\nAWS_PAGER=\n')

    def data_path(self, local: Path) -> str:
        """Where the container sees a file of the run directory."""
        return f'/data/{local.relative_to(self.workdir)}'

    def command(self, args: list[str], name: str = 'ayvo-backup-aws') -> list[str]:
        return [
            'docker', 'run', '--rm', '--name', name, '--label', 'com.ayvo.backup=1',
            '--read-only', '--tmpfs', '/tmp',
            '--security-opt', 'no-new-privileges:true', '--cap-drop', 'ALL',
            '--user', f'{os.getuid()}:{os.getgid()}', '-e', 'HOME=/tmp',
            '--env-file', str(self.env_file),
            '-v', f'{self.workdir}:/data',
            self.image, *args, '--output', 'json',
        ]

    def _call(self, args: list[str], step: str, timeout: int = UPLOAD_TIMEOUT):
        # Killing the docker client (timeout, SIGTERM) does not stop the container: it is named
        # and removed here in every case, so an abandoned upload cannot finish later.
        name = f'ayvo-backup-aws-{secrets.token_hex(6)}'
        try:
            res = self.runner.run(self.command(args, name), timeout=timeout, step=step)
        finally:
            subprocess.run(['docker', 'rm', '-f', name], capture_output=True, timeout=60)
        return res.returncode, res.stdout or b'', tail(res.stderr)

    def put(self, local: Path, key: str, sha256_hex: str, metadata: dict[str, str]) -> None:
        meta = ','.join(f'{k}={v}' for k, v in sorted(metadata.items()))
        rc, _, err = self._call([
            's3api', 'put-object', '--bucket', self.bucket, '--key', key,
            '--body', self.data_path(local), '--expected-bucket-owner', self.owner,
            '--checksum-sha256', b64_of_hex(sha256_hex),
            '--server-side-encryption', 'AES256', '--if-none-match', '*',
            '--content-type', 'application/octet-stream', '--metadata', meta,
        ], 'upload')
        if rc != 0:
            # A retry after a lost answer finds its own object: accept it only if it matches.
            if 'PreconditionFailed' in err or '(412)' in err:
                raise ObjectExists(key)
            raise BackupError('upload', f'put-object {key} failed: {err}')

    def head(self, key: str) -> dict:
        rc, out, err = self._call([
            's3api', 'head-object', '--bucket', self.bucket, '--key', key,
            '--expected-bucket-owner', self.owner, '--checksum-mode', 'ENABLED',
        ], 'verify')
        if rc != 0:
            raise BackupError('verify', f'head-object {key} failed: {err}')
        return json.loads(out or b'{}')

    def get(self, key: str, local: Path) -> None:
        rc, _, err = self._call([
            's3api', 'get-object', '--bucket', self.bucket, '--key', key,
            '--expected-bucket-owner', self.owner, '--checksum-mode', 'ENABLED',
            self.data_path(local),
        ], 'download')
        if rc != 0:
            raise BackupError('download', f'get-object {key} failed: {err}')

    def latest(self, prefix: str) -> str | None:
        """The newest complete backup key of a prefix (by its name), or None."""
        rc, out, err = self._call([
            's3api', 'list-objects-v2', '--bucket', self.bucket, '--prefix', prefix,
            '--expected-bucket-owner', self.owner,
        ], 'list')
        if rc != 0:
            raise BackupError('list', f'list-objects-v2 {prefix} failed: {err}')
        keys = {o['Key'] for o in json.loads(out or b'{}').get('Contents', [])}
        dumps = sorted(k for k in keys if k.endswith('.dump') and f'{k}.manifest.json' in keys)
        return dumps[-1] if dumps else None


class ObjectExists(Exception):
    def __init__(self, key: str):
        super().__init__(key)
        self.key = key


# --- the backup -------------------------------------------------------------------------------

SAFE_ID = re.compile(r'^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}$')


@dataclass
class Config:
    kind: str
    reason: str
    bucket: str = BUCKET
    owner: str = BUCKET_OWNER
    region: str = REGION
    credentials_file: Path = Path(CREDENTIALS_FILE)
    state_dir: Path = Path(STATE_DIR)
    pg_container: str = PG_CONTAINER
    aws_image: str = AWS_IMAGE
    dump_timeout: int = DUMP_TIMEOUT
    upload_timeout: int = UPLOAD_TIMEOUT
    retry_delays: tuple[int, ...] = RETRY_DELAYS
    daily_lock_wait: int = DAILY_LOCK_WAIT
    s3_factory: object = field(default=None, repr=False)


def dump_script(backup_id: str) -> bytes:
    """psql input: export a snapshot, run pg_dump in it, write the same snapshot's statistics."""
    base = f'/tmp/ayvo-backup-{backup_id}'
    return f"""\\set ON_ERROR_STOP on
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SELECT pg_export_snapshot() AS snap \\gset
\\setenv AYVO_SNAPSHOT :snap
\\! pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom --compress=6 --snapshot="$AYVO_SNAPSHOT" --file={base}.dump; echo $? > {base}.rc
\\o {base}.stats.json
{STATS_SQL}
\\o
COMMIT;
""".encode()


class Backup:
    def __init__(self, cfg: Config, runner: Runner):
        self.cfg, self.runner = cfg, runner
        self.backup_id = f'{utcnow():%Y%m%dT%H%M%SZ}-{secrets.token_hex(4)}'
        assert SAFE_ID.match(self.backup_id)
        self.tmp_root = cfg.state_dir / 'tmp'
        self.workdir = self.tmp_root / f'run-{self.backup_id}'
        self.container_files = f'/tmp/ayvo-backup-{self.backup_id}'
        self.step = 'start'

    def docker_exec(self, args: list[str], *, timeout: int, step: str, **kw):
        return self.runner.run(['docker', 'exec', *args], timeout=timeout, step=step, **kw)

    def sweep(self) -> None:
        """Leftovers of runs that were killed (we hold the lock: none of them is running)."""
        self.tmp_root.mkdir(mode=0o700, parents=True, exist_ok=True)
        for p in self.tmp_root.iterdir():
            if p.is_dir() and p.name.startswith('run-') and SAFE_ID.match(p.name[4:]):
                shutil.rmtree(p, ignore_errors=True)
                log(f'removed the leftover {p.name} of an interrupted run')
        # The database container's temporary files of a killed run (only our own name pattern).
        self.docker_exec(
            [self.cfg.pg_container, 'sh', '-c', 'rm -f /tmp/ayvo-backup-[0-9]*Z-*'],
            timeout=60, step='cleanup')

    def dump(self) -> tuple[Path, dict]:
        self.step = 'dump'
        c = self.cfg.pg_container
        res = self.docker_exec(
            ['-i', c, 'sh', '-c',
             'exec psql -X -q -At -U "$POSTGRES_USER" -d "$POSTGRES_DB"'],
            timeout=self.cfg.dump_timeout, step='dump', input_bytes=dump_script(self.backup_id))
        if res.returncode != 0:
            raise BackupError('dump', f'psql failed: {tail(res.stderr)}')
        rc = self.docker_exec([c, 'cat', f'{self.container_files}.rc'], timeout=30, step='dump')
        if rc.returncode != 0 or rc.stdout.strip() != b'0':
            raise BackupError('dump', f'pg_dump failed (exit {rc.stdout.strip().decode() or "?"})')
        stats = self.docker_exec([c, 'cat', f'{self.container_files}.stats.json'], timeout=30,
                                 step='dump')
        if stats.returncode != 0:
            raise BackupError('dump', 'the snapshot statistics are missing')
        dump = self.workdir / 'backup.dump'
        with dump.open('wb') as f:
            out = self.docker_exec([c, 'cat', f'{self.container_files}.dump'],
                                   timeout=self.cfg.dump_timeout, step='dump', stdout=f)
        if out.returncode != 0:
            raise BackupError('dump', f'copying the dump failed: {tail(out.stderr)}')
        if dump.stat().st_size == 0:
            raise BackupError('dump', 'the dump is empty')
        return dump, json.loads(stats.stdout)

    def remove_container_files(self) -> None:
        # Stop a pg_dump still writing (after an interruption), then remove the files. Two
        # separate calls: in one shell, `pkill -f` would match that shell's own command line
        # (which names the files) and kill it before `rm` ran. pkill never matches itself.
        try:
            self.docker_exec([self.cfg.pg_container, 'pkill', '-f', self.container_files],
                             timeout=60, step='cleanup')  # exit 1 = nothing was running
            res = self.docker_exec(
                [self.cfg.pg_container, 'sh', '-c', f'rm -f {self.container_files}.*'],
                timeout=60, step='cleanup')
            if res.returncode != 0:
                log(f'could not remove the temporary files in the database container: {tail(res.stderr)}')
        except BackupError as e:
            log(f'could not remove the temporary files in the database container: {e}')

    def check_archive(self, dump: Path) -> None:
        """pg_restore reads the archive's table of contents (a broken or foreign file fails here;
        the data itself is proven only by the restore check, §3 of doc 035)."""
        self.step = 'check'
        with dump.open('rb') as f:
            res = self.docker_exec(['-i', self.cfg.pg_container, 'pg_restore', '--list'],
                                   timeout=300, step='check', stdin=f)
        if res.returncode != 0 or b'TABLE DATA' not in (res.stdout or b''):
            raise BackupError('check', f'the archive is not readable: {tail(res.stderr)}')

    def upload(self, s3: S3, local: Path, key: str, sha: str, size: int, meta: dict) -> None:
        """Up to 3 attempts. Accepted only when S3 reports the same size and SHA-256 and a
        read-back of the stored object hashes the same."""
        self.step = 'upload'
        last: BackupError | None = None
        for attempt in range(1, UPLOAD_ATTEMPTS + 1):
            try:
                try:
                    s3.put(local, key, sha, meta)
                except ObjectExists:
                    log(f'{key} already exists (an earlier attempt); verifying it')
                self.verify(s3, key, sha, size)
                return
            except BackupError as e:
                last = e
                log(f'attempt {attempt}/{UPLOAD_ATTEMPTS} for {key} failed: {e}')
                if attempt < UPLOAD_ATTEMPTS:
                    time.sleep(self.cfg.retry_delays[min(attempt, len(self.cfg.retry_delays)) - 1])
        raise BackupError('upload', f'{key} not stored after {UPLOAD_ATTEMPTS} attempts ({last})')

    def verify(self, s3: S3, key: str, sha: str, size: int) -> None:
        self.step = 'verify'
        head = s3.head(key)
        if int(head.get('ContentLength', -1)) != size:
            raise BackupError('verify', f'{key}: stored size {head.get("ContentLength")} != {size}')
        if head.get('ChecksumSHA256', '').split('-')[0] != b64_of_hex(sha):
            raise BackupError('verify', f'{key}: stored SHA-256 does not match')
        if head.get('Metadata', {}).get('sha256') != sha:
            raise BackupError('verify', f'{key}: stored metadata does not match')
        readback = self.workdir / 'readback'
        readback.unlink(missing_ok=True)
        s3.get(key, readback)
        if sha256_file(readback) != sha:
            raise BackupError('verify', f'{key}: the downloaded copy does not match')
        readback.unlink()

    def run(self) -> dict:
        self.sweep()
        self.workdir.mkdir(mode=0o700)
        try:
            self.step = 'credentials'
            creds = read_credentials(self.cfg.credentials_file)
            factory = self.cfg.s3_factory or S3
            s3 = factory(self.runner, bucket=self.cfg.bucket, owner=self.cfg.owner,
                         region=self.cfg.region, image=self.cfg.aws_image,
                         workdir=self.workdir, credentials=creds)
            dump, stats = self.dump()
            self.check_archive(dump)
            sha, size = sha256_file(dump), dump.stat().st_size
            key = f'{PREFIXES[self.cfg.kind]}ayvo-prod-{self.backup_id}.dump'
            manifest = {
                'format': 1,
                'kind': self.cfg.kind,
                'reason': self.cfg.reason,
                'id': self.backup_id,
                'createdAt': utcnow().isoformat(timespec='seconds'),
                'key': key,
                'sha256': sha,
                'size': size,
                'stats': stats,
            }
            meta = {'sha256': sha, 'kind': self.cfg.kind, 'backup-id': self.backup_id}
            self.upload(s3, dump, key, sha, size, meta)
            mpath = self.workdir / 'manifest.json'
            mpath.write_text(json.dumps(manifest, indent=2, sort_keys=True) + '\n')
            msha = sha256_file(mpath)
            self.upload(s3, mpath, f'{key}.manifest.json', msha, mpath.stat().st_size,
                        {'sha256': msha, 'kind': self.cfg.kind, 'backup-id': self.backup_id})
            return {k: manifest[k] for k in ('kind', 'reason', 'id', 'createdAt', 'key', 'sha256',
                                             'size')} | {
                'tables': len(stats.get('counts', {})),
                'rows': sum(stats.get('counts', {}).values()),
            }
        finally:
            self.remove_container_files()
            shutil.rmtree(self.workdir, ignore_errors=True)


# --- restore check ----------------------------------------------------------------------------


def compare_stats(expected: dict, actual: dict) -> list[str]:
    problems = []
    exp_counts, act_counts = expected.get('counts', {}), actual.get('counts', {})
    for table in sorted(set(exp_counts) | set(act_counts)):
        if exp_counts.get(table) != act_counts.get(table):
            problems.append(f'{table}: {act_counts.get(table)} rows, expected {exp_counts.get(table)}')
    for k in ('foreignKeys', 'triggers', 'migrations'):
        if expected.get(k) != actual.get(k):
            problems.append(f'{k}: {actual.get(k)!r}, expected {expected.get(k)!r}')
    if actual.get('notValidated'):
        problems.append(f'{actual["notValidated"]} constraint(s) are not validated')
    return problems


class RestoreCheck:
    """Restores a dump into a new PostgreSQL container without network and compares it."""

    def __init__(self, runner: Runner, image: str, workdir: Path):
        self.runner, self.image, self.workdir = runner, image, workdir
        self.name = f'ayvo-restore-check-{secrets.token_hex(6)}'

    def run(self, dump: Path, manifest: dict) -> dict:
        sha = sha256_file(dump)
        if sha != manifest.get('sha256') or dump.stat().st_size != manifest.get('size'):
            raise BackupError('restore-check', 'the dump does not match its manifest (damaged?)')
        env_file = self.workdir / 'pg.env'
        fd = os.open(env_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'w') as f:
            f.write(f'POSTGRES_PASSWORD={secrets.token_urlsafe(24)}\n')
        r = self.runner.run(
            ['docker', 'run', '-d', '--rm', '--network', 'none', '--name', self.name,
             '--memory', '1g', '--memory-swap', '2g',
             '--label', 'com.ayvo.restore-check=1', '--env-file', str(env_file), self.image],
            timeout=120, step='restore-check')
        if r.returncode != 0:
            raise BackupError('restore-check', f'cannot start the check container: {tail(r.stderr)}')
        try:
            self.wait_ready()
            self.exec(['createdb', '-U', 'postgres', 'restore_check'])
            with dump.open('rb') as f:
                res = self.runner.run(
                    ['docker', 'exec', '-i', self.name, 'pg_restore', '-U', 'postgres',
                     '-d', 'restore_check', '--exit-on-error', '--single-transaction',
                     '--no-owner', '--no-privileges'],
                    timeout=DUMP_TIMEOUT, step='restore-check', stdin=f)
            if res.returncode != 0:
                raise BackupError('restore-check', f'pg_restore failed: {tail(res.stderr)}')
            out = self.exec(['psql', '-X', '-q', '-At', '-U', 'postgres', '-d', 'restore_check',
                             '-v', 'ON_ERROR_STOP=1', '-c', STATS_SQL])
            actual = json.loads(out)
            problems = compare_stats(manifest['stats'], actual)
            if problems:
                raise BackupError('restore-check', '; '.join(problems[:20]))
            return {
                'id': manifest.get('id'),
                'key': manifest.get('key'),
                'tables': len(actual['counts']),
                'rows': sum(actual['counts'].values()),
                'foreignKeys': actual['foreignKeys'],
                'triggers': actual['triggers'],
                'migrations': len(actual['migrations']),
            }
        finally:
            self.runner.run(['docker', 'rm', '-f', self.name], timeout=120, step='cleanup')

    def exec(self, args: list[str]) -> bytes:
        res = self.runner.run(['docker', 'exec', self.name, *args], timeout=600,
                              step='restore-check')
        if res.returncode != 0:
            raise BackupError('restore-check', f'{args[0]} failed: {tail(res.stderr)}')
        return res.stdout

    def wait_ready(self) -> None:
        # The image's init phase listens on the socket only; ready = TCP on 127.0.0.1.
        for _ in range(120):
            res = self.runner.run(
                ['docker', 'exec', self.name, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres'],
                timeout=30, step='restore-check')
            if res.returncode == 0:
                return
            time.sleep(1)
        raise BackupError('restore-check', 'the check container did not become ready')


# --- state and status -------------------------------------------------------------------------


def record(state_dir: Path, name: str, data: dict) -> None:
    state_dir.mkdir(mode=0o750, parents=True, exist_ok=True)
    write_json_atomic(state_dir / name, data)


def read_state(state_dir: Path, name: str) -> dict | None:
    try:
        return json.loads((state_dir / name).read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return None


def status(state_dir: Path, max_age: dict[str, float]) -> tuple[int, list[str]]:
    lines, bad = [], False
    now = utcnow()
    for kind in ('hourly', 'daily'):
        ok = read_state(state_dir, f'last-success-{kind}.json')
        failed = read_state(state_dir, f'last-failure-{kind}.json')
        if not ok:
            lines.append(f'{kind}: NO successful backup recorded')
            bad = True
        else:
            age = (now - datetime.fromisoformat(ok['finishedAt'])).total_seconds() / 3600
            stale = age > max_age[kind]
            bad |= stale
            lines.append(f'{kind}: last success {ok["finishedAt"]} ({age:.1f} h ago){" — STALE" if stale else ""}: {ok["key"]}')
        if failed and (not ok or failed['finishedAt'] > ok['finishedAt']):
            lines.append(f'{kind}: LAST RUN FAILED {failed["finishedAt"]} at {failed["step"]}: {failed["message"]}')
            bad = True
    check = read_state(state_dir, 'last-restore-check.json')
    if not check:
        lines.append('restore check: never run')
    else:
        age = (now - datetime.fromisoformat(check['finishedAt'])).total_seconds() / 86400
        failed = check.get('result') != 'OK'
        stale = age > MAX_RESTORE_CHECK_AGE_DAYS
        bad |= failed or stale
        lines.append(f'restore check: {check["finishedAt"]} ({age:.1f} days ago) {check.get("result")}'
                     + (f': {check.get("message", "")}' if failed else '')
                     + (' — STALE' if stale else ''))
    return (EXIT_FAILED if bad else EXIT_OK), lines


# --- command line -----------------------------------------------------------------------------


def install_signal_handlers(runner: Runner) -> None:
    def handler(signum, _frame):
        runner.kill()
        raise Interrupted(signal.Signals(signum).name)

    signal.signal(signal.SIGTERM, handler)
    signal.signal(signal.SIGINT, handler)


def add_common(p: argparse.ArgumentParser) -> None:
    p.add_argument('--state-dir', default=STATE_DIR)
    p.add_argument('--bucket', default=BUCKET)
    p.add_argument('--bucket-owner', default=BUCKET_OWNER)
    p.add_argument('--region', default=REGION)
    p.add_argument('--credentials-file', default=CREDENTIALS_FILE)
    p.add_argument('--pg-container', default=PG_CONTAINER)
    p.add_argument('--aws-image', default=AWS_IMAGE)


def parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog='ayvo-backup', description=__doc__.split('\n\n')[0])
    sub = p.add_subparsers(dest='command', required=True)
    r = sub.add_parser('run', help='take, upload and verify one backup')
    r.add_argument('--kind', choices=sorted(PREFIXES), required=True)
    r.add_argument('--reason', default='scheduled', type=lambda s: re.sub(r'[^\w .:-]', '', s)[:80])
    add_common(r)
    c = sub.add_parser('restore-check', help='restore a backup into a throwaway container')
    g = c.add_mutually_exclusive_group(required=True)
    g.add_argument('--latest', choices=sorted(PREFIXES))
    g.add_argument('--key')
    g.add_argument('--file')
    c.add_argument('--manifest', help='with --file: its manifest JSON')
    c.add_argument('--pg-image', help='default: the image of the running database container')
    add_common(c)
    s = sub.add_parser('status', help='age of the last successful backups (exit 1 if stale)')
    s.add_argument('--state-dir', default=STATE_DIR)
    return p


def config_from(args: argparse.Namespace, **extra) -> Config:
    return Config(
        kind=getattr(args, 'kind', 'hourly'), reason=getattr(args, 'reason', 'restore-check'),
        bucket=args.bucket, owner=args.bucket_owner, region=args.region,
        credentials_file=Path(args.credentials_file), state_dir=Path(args.state_dir),
        pg_container=args.pg_container, aws_image=args.aws_image, **extra)


def take_lock(cfg: Config, lock) -> bool:
    """The backup lock; an hourly run gives up at once, a daily one waits for a running run."""
    deadline = time.monotonic() + (cfg.daily_lock_wait if cfg.kind == 'daily' else 0)
    while True:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return True
        except BlockingIOError:
            if time.monotonic() >= deadline:
                return False
            time.sleep(min(10, max(0.1, deadline - time.monotonic())))


def cmd_run(cfg: Config) -> int:
    runner = Runner()
    install_signal_handlers(runner)
    started = utcnow()
    backup: Backup | None = None
    lock = None
    try:
        cfg.state_dir.mkdir(mode=0o750, parents=True, exist_ok=True)
        lock = (cfg.state_dir / 'backup.lock').open('a')
        if not take_lock(cfg, lock):
            log('another backup is running; this run is skipped')
            record(cfg.state_dir, f'last-skipped-{cfg.kind}.json',
                   {'finishedAt': utcnow().isoformat(timespec='seconds'), 'reason': 'busy'})
            return EXIT_BUSY
        backup = Backup(cfg, runner)
        result = backup.run()
    except Exception as e:  # noqa: BLE001 — every failure must be recorded, never a bare traceback
        step = e.step if isinstance(e, BackupError) else (backup.step if backup else 'start')
        message = str(e) if isinstance(e, BackupError) else f'{type(e).__name__}: {e}'
        try:
            record(cfg.state_dir, f'last-failure-{cfg.kind}.json', {
                'finishedAt': utcnow().isoformat(timespec='seconds'), 'startedAt':
                started.isoformat(timespec='seconds'), 'step': step, 'message': message[:500],
                'id': backup.backup_id if backup else None})
        except OSError as state_error:
            log(f'the failure could not be recorded either: {state_error}')
        log(f'FAILED at {step}: {message}')
        return EXIT_FAILED
    finally:
        if lock:
            lock.close()
    result |= {'startedAt': started.isoformat(timespec='seconds'),
               'finishedAt': utcnow().isoformat(timespec='seconds')}
    record(cfg.state_dir, f'last-success-{cfg.kind}.json', result)
    log(f'stored {result["key"]} ({result["size"]} bytes, {result["tables"]} tables, '
        f'{result["rows"]} rows)')
    return EXIT_OK


def cmd_restore_check(args: argparse.Namespace, s3_factory=None) -> int:
    cfg = config_from(args, s3_factory=s3_factory)
    runner = Runner()
    install_signal_handlers(runner)
    tmp_root = cfg.state_dir / 'tmp'
    tmp_root.mkdir(mode=0o700, parents=True, exist_ok=True)
    workdir = tmp_root / f'check-{secrets.token_hex(6)}'
    workdir.mkdir(mode=0o700)
    started = utcnow()
    try:
        if args.file:
            if not args.manifest:
                raise BackupError('restore-check', '--file needs --manifest')
            dump, manifest = Path(args.file), json.loads(Path(args.manifest).read_text())
        else:
            creds = read_credentials(cfg.credentials_file)
            s3 = (s3_factory or S3)(runner, bucket=cfg.bucket, owner=cfg.owner,
                                     region=cfg.region, image=cfg.aws_image, workdir=workdir,
                                     credentials=creds)
            key = args.key or s3.latest(PREFIXES[args.latest])
            if not key:
                raise BackupError('restore-check', f'no complete backup under {PREFIXES[args.latest]}')
            dump, mfile = workdir / 'backup.dump', workdir / 'manifest.json'
            s3.get(key, dump)
            s3.get(f'{key}.manifest.json', mfile)
            manifest = json.loads(mfile.read_text())
            if manifest.get('key') != key:
                raise BackupError('restore-check', 'the manifest belongs to another backup')
        image = args.pg_image
        if not image:
            r = runner.run(['docker', 'inspect', '--format', '{{.Config.Image}}', cfg.pg_container],
                           timeout=30, step='restore-check')
            if r.returncode != 0:
                raise BackupError('restore-check', 'name --pg-image (no running database container)')
            image = r.stdout.decode().strip()
        result = RestoreCheck(runner, image, workdir).run(dump, manifest)
    except (BackupError, Interrupted, OSError, json.JSONDecodeError, KeyError) as e:
        record(cfg.state_dir, 'last-restore-check.json', {
            'finishedAt': utcnow().isoformat(timespec='seconds'), 'result': 'FAILED',
            'message': str(e)[:500]})
        log(f'restore check FAILED: {e}')
        return EXIT_FAILED
    finally:
        shutil.rmtree(workdir, ignore_errors=True)
    record(cfg.state_dir, 'last-restore-check.json', result | {
        'startedAt': started.isoformat(timespec='seconds'),
        'finishedAt': utcnow().isoformat(timespec='seconds'), 'result': 'OK'})
    log(f'restore check OK: {result["tables"]} tables, {result["rows"]} rows, '
        f'{result["foreignKeys"]} foreign keys, {result["triggers"]} triggers, '
        f'{result["migrations"]} migrations — as in the manifest')
    return EXIT_OK


def main(argv: list[str] | None = None, s3_factory=None) -> int:
    args = parser().parse_args(argv)
    if args.command == 'status':
        code, lines = status(Path(args.state_dir), MAX_AGE_HOURS)
        print('\n'.join(lines))
        return code
    if args.command == 'run':
        return cmd_run(config_from(args, s3_factory=s3_factory))
    return cmd_restore_check(args, s3_factory=s3_factory)
