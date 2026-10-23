"""Backups and their restore check against a real PostgreSQL 18 container (doc 035).

The database is a throwaway container without network (never DEV's or production's); the
bucket is a directory (fake_s3.py). These tests create containers, so they run in CI (env CI)
— where Docker is required and a missing Docker fails the run — or locally only when asked
(AYVO_DOCKER_TESTS=1): containers on the DEV server are not under the build memory limits.
"""

import json
import os
import secrets
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

from ayvo_backup import backup
from fake_s3 import FakeS3

HERE = Path(__file__).resolve().parent
PG_IMAGE = 'postgres:18-alpine'


def docker_ok() -> bool:
    try:
        return subprocess.run(['docker', 'info'], capture_output=True, timeout=30).returncode == 0
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return False


WANT_DOCKER = bool(os.environ.get('CI') or os.environ.get('AYVO_DOCKER_TESTS'))
HAS_DOCKER = WANT_DOCKER and docker_ok()
if WANT_DOCKER and not HAS_DOCKER:
    raise RuntimeError('Docker is required for the backup tests (CI or AYVO_DOCKER_TESTS=1)')

SCHEMA = """
CREATE TABLE hotels (id int PRIMARY KEY, name text NOT NULL);
CREATE TABLE orders (id int PRIMARY KEY, hotel_id int NOT NULL REFERENCES hotels(id), note text);
CREATE TABLE order_events (id bigserial PRIMARY KEY, order_id int NOT NULL REFERENCES orders(id));
CREATE FUNCTION no_update() RETURNS trigger LANGUAGE plpgsql AS
  $$ BEGIN RAISE EXCEPTION 'append-only'; END $$;
CREATE TRIGGER order_events_append_only BEFORE UPDATE OR DELETE ON order_events
  FOR EACH ROW EXECUTE FUNCTION no_update();
CREATE TABLE _prisma_migrations (id text PRIMARY KEY, migration_name text NOT NULL,
  finished_at timestamptz, rolled_back_at timestamptz);
INSERT INTO _prisma_migrations VALUES ('1', '20260101000000_init', now(), NULL),
  ('2', '20260102000000_orders', now(), NULL), ('3', '20260103000000_failed', NULL, NULL);
INSERT INTO hotels SELECT g, 'Hotel ' || g || ' Žluťoučký' FROM generate_series(1, 40) g;
INSERT INTO orders SELECT g, 1 + g % 40, repeat('poznámka ', 20) FROM generate_series(1, 500) g;
INSERT INTO order_events (order_id) SELECT 1 + g % 500 FROM generate_series(1, 3000) g;
"""


def sh(*argv, **kw):
    return subprocess.run(list(argv), capture_output=True, text=True, timeout=300, **kw)


@unittest.skipUnless(HAS_DOCKER, 'container tests run in CI or with AYVO_DOCKER_TESTS=1')
class BackupTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.container = f'ayvo-backup-test-{secrets.token_hex(4)}'
        env = Path(tempfile.mkdtemp()) / 'pg.env'
        env.write_text(f'POSTGRES_PASSWORD={secrets.token_hex(12)}\nPOSTGRES_USER=ayvo\n'
                       'POSTGRES_DB=ayvo_test\n')
        r = sh('docker', 'run', '-d', '--rm', '--network', 'none', '--name', cls.container,
               '--env-file', str(env), PG_IMAGE)
        shutil.rmtree(env.parent)
        assert r.returncode == 0, r.stderr
        for _ in range(120):
            if sh('docker', 'exec', cls.container, 'pg_isready', '-h', '127.0.0.1',
                  '-U', 'ayvo').returncode == 0:
                break
            time.sleep(1)
        r = sh('docker', 'exec', '-i', cls.container, 'psql', '-v', 'ON_ERROR_STOP=1', '-q',
               '-U', 'ayvo', '-d', 'ayvo_test', input=SCHEMA)
        assert r.returncode == 0, r.stderr

    @classmethod
    def tearDownClass(cls):
        sh('docker', 'rm', '-f', cls.container)

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix='ayvo-backup-test-'))
        self.state = self.tmp / 'state'
        self.bucket = self.tmp / 'bucket'
        self.creds = self.tmp / 'backup.env'
        self.creds.write_text('# the backup identity\nAWS_ACCESS_KEY_ID=AKIAFAKEFAKEFAKE1234\n'
                              'AWS_SECRET_ACCESS_KEY="fake/secret+value"\n')
        self.creds.chmod(0o600)
        self.env = {k: v for k, v in os.environ.items() if not k.startswith('FAKE_S3_')}
        self.env['FAKE_S3_DIR'] = str(self.bucket)
        os.environ['FAKE_S3_DIR'] = str(self.bucket)

    def tearDown(self):
        for k in [k for k in os.environ if k.startswith('FAKE_S3_')]:
            del os.environ[k]
        shutil.rmtree(self.tmp, ignore_errors=True)

    # --- helpers --------------------------------------------------------------------------

    def start(self, kind='hourly', **fake):
        env = dict(self.env, PYTHONPATH=f'{HERE.parent}:{HERE}',
                   **{f'FAKE_S3_{k.upper()}': str(v) for k, v in fake.items()})
        return subprocess.Popen(
            [sys.executable, str(HERE / 'launcher.py'), str(self.state), str(self.creds),
             self.container, kind], env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True)

    def run_backup(self, kind='hourly', **fake):
        p = self.start(kind, **fake)
        out, err = p.communicate(timeout=300)
        return p.returncode, err

    def state_of(self, name):
        path = self.state / name
        return json.loads(path.read_text()) if path.exists() else None

    def objects(self):
        return sorted(str(p.relative_to(self.bucket)) for p in self.bucket.rglob('*')
                      if p.is_file() and not p.name.startswith('.') and not p.name.endswith('.meta'))

    def leftovers(self):
        tmp = self.state / 'tmp'
        local = sorted(p.name for p in tmp.iterdir()) if tmp.exists() else []
        inside = sh('docker', 'exec', self.container, 'sh', '-c',
                    'ls /tmp | grep ayvo-backup || true').stdout.split()
        return local, inside

    def restore_check(self, *args):
        return backup.main(['restore-check', *args, '--state-dir', str(self.state),
                            '--credentials-file', str(self.creds),
                            '--pg-container', self.container], s3_factory=FakeS3)

    def wait_for(self, predicate, what, timeout=60):
        deadline = time.time() + timeout
        while time.time() < deadline:
            if predicate():
                return
            time.sleep(0.1)
        self.fail(f'timed out waiting for {what}')

    # --- tests ----------------------------------------------------------------------------

    def test_hourly_and_daily_are_unique_verified_objects_and_restore_with_the_same_data(self):
        code, err = self.run_backup('hourly')
        self.assertEqual(code, 0, err)
        code, err = self.run_backup('daily')
        self.assertEqual(code, 0, err)
        objs = self.objects()
        hourly = [o for o in objs if o.startswith('database/hourly/')]
        daily = [o for o in objs if o.startswith('database/daily/')]
        self.assertEqual(len(hourly), 2)  # the dump and its manifest
        self.assertEqual(len(daily), 2)
        self.assertRegex(hourly[0], r'^database/hourly/ayvo-prod-\d{8}T\d{6}Z-[0-9a-f]{8}\.dump$')
        self.assertEqual(hourly[1], hourly[0] + '.manifest.json')
        manifest = json.loads((self.bucket / hourly[1]).read_text())
        stats = manifest['stats']
        self.assertEqual(stats['counts'], {
            'public._prisma_migrations': 3, 'public.hotels': 40, 'public.order_events': 3000,
            'public.orders': 500})
        self.assertEqual(stats['foreignKeys'], 2)
        self.assertEqual(stats['triggers'], 1)
        self.assertEqual(stats['migrations'], ['20260101000000_init', '20260102000000_orders'])
        ok = self.state_of('last-success-hourly.json')
        self.assertEqual(ok['key'], hourly[0])
        self.assertEqual(ok['rows'], 3543)
        self.assertEqual(self.leftovers(), ([], []))
        # The newest daily backup restores into a new container with the same rows and links.
        self.assertEqual(self.restore_check('--latest', 'daily', '--pg-image', PG_IMAGE), 0)
        check = self.state_of('last-restore-check.json')
        self.assertEqual(check['result'], 'OK')
        self.assertEqual((check['rows'], check['foreignKeys'], check['triggers']), (3543, 2, 1))
        # status reports both as fresh.
        code, lines = backup.status(self.state, backup.MAX_AGE_HOURS)
        self.assertEqual(code, 0, lines)

    def test_a_damaged_backup_or_a_differing_restore_is_refused(self):
        self.assertEqual(self.run_backup('hourly')[0], 0)
        dump = next(p for p in self.bucket.rglob('*.dump'))
        data = bytearray(dump.read_bytes())
        data[len(data) // 2] ^= 0xFF
        dump.write_bytes(bytes(data))
        self.assertEqual(self.restore_check('--latest', 'hourly', '--pg-image', PG_IMAGE), 1)
        self.assertIn('damaged', self.state_of('last-restore-check.json')['message'])
        # A dump that is intact but restores other data than its manifest says: refused too.
        self.assertEqual(self.run_backup('daily')[0], 0)
        mfile = next(p for p in self.bucket.rglob('database/daily/*.manifest.json'))
        m = json.loads(mfile.read_text())
        m['stats']['counts']['public.orders'] = 499
        local_manifest = self.tmp / 'm.json'
        local_manifest.write_text(json.dumps(m))
        local_dump = self.tmp / 'd.dump'
        shutil.copyfile(mfile.with_name(mfile.name.removesuffix('.manifest.json')), local_dump)
        self.assertEqual(self.restore_check('--file', str(local_dump), '--manifest',
                                            str(local_manifest), '--pg-image', PG_IMAGE), 1)
        self.assertIn('public.orders: 500 rows, expected 499',
                      self.state_of('last-restore-check.json')['message'])
        # No check container is left behind.
        left = sh('docker', 'ps', '-a', '-q', '--filter', 'label=com.ayvo.restore-check=1').stdout
        self.assertEqual(left.strip(), '')

    def test_a_failing_upload_is_retried_then_recorded_as_a_failure(self):
        # Two failures, then success: one object, no duplicate.
        code, err = self.run_backup('hourly', fail_puts=2)
        self.assertEqual(code, 0, err)
        self.assertEqual(len(self.objects()), 2)
        self.assertIn('attempt 1/3', err)
        # Every attempt fails: an exit code, a recorded failure, nothing left behind.
        code, err = self.run_backup('daily', fail_puts=99)
        self.assertEqual(code, 1)
        failure = self.state_of('last-failure-daily.json')
        self.assertEqual(failure['step'], 'upload')
        self.assertIn('not stored after 3 attempts', failure['message'])
        self.assertIsNone(self.state_of('last-success-daily.json'))
        self.assertEqual([o for o in self.objects() if 'daily' in o], [])
        self.assertEqual(self.leftovers(), ([], []))
        code, lines = backup.status(self.state, backup.MAX_AGE_HOURS)
        self.assertEqual(code, 1)
        self.assertTrue(any('daily: NO successful backup' in line for line in lines), lines)

    def test_a_lost_answer_after_the_upload_is_verified_not_written_twice(self):
        code, err = self.run_backup('hourly', lose_answer=1)
        self.assertEqual(code, 0, err)
        self.assertIn('already exists', err)
        self.assertEqual(len(self.objects()), 2)

    def test_an_interrupted_run_leaves_no_partial_object_and_releases_the_lock(self):
        p = self.start('hourly', put_sleep=30)
        self.wait_for(lambda: (self.bucket / '.put-started').exists(), 'the upload')
        p.send_signal(signal.SIGTERM)
        out, err = p.communicate(timeout=60)
        self.assertEqual(p.returncode, 1, err)
        failure = self.state_of('last-failure-hourly.json')
        self.assertEqual(failure['step'], 'upload')
        self.assertIn('SIGTERM', failure['message'])
        self.assertEqual(self.objects(), [])
        self.assertEqual(self.leftovers(), ([], []))
        # Killed outright: the next run removes what was left (here and in the container).
        (self.bucket / '.put-started').unlink()
        p = self.start('hourly', put_sleep=30)
        self.wait_for(lambda: (self.bucket / '.put-started').exists(), 'the upload')
        p.kill()
        p.communicate(timeout=60)
        local, inside = self.leftovers()
        self.assertTrue(local and inside, (local, inside))
        code, err = self.run_backup('hourly')
        self.assertEqual(code, 0, err)
        self.assertIn('leftover', err)
        self.assertEqual(self.leftovers(), ([], []))

    def test_a_second_hourly_run_is_skipped_a_daily_one_waits(self):
        p = self.start('hourly', put_sleep=5)
        self.wait_for(lambda: (self.bucket / '.put-started').exists(), 'the upload')
        code, err = self.run_backup('hourly')
        self.assertEqual(code, backup.EXIT_BUSY, err)
        self.assertIn('another backup is running', err)
        self.assertEqual(self.state_of('last-skipped-hourly.json')['reason'], 'busy')
        # The daily backup is not dropped because an hourly one is still running: it waits.
        code, err = self.run_backup('daily')
        self.assertEqual(code, 0, err)
        out, err = p.communicate(timeout=120)
        self.assertEqual(p.returncode, 0, err)
        self.assertEqual(len([o for o in self.objects() if 'hourly' in o]), 2)
        self.assertEqual(len([o for o in self.objects() if 'daily' in o]), 2)


class CredentialAndCommandTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_credentials_must_be_private_and_complete(self):
        f = self.tmp / 'c.env'
        f.write_text('AWS_ACCESS_KEY_ID=AKIAFAKEFAKEFAKE1234\nAWS_SECRET_ACCESS_KEY=x\n')
        f.chmod(0o644)
        with self.assertRaisesRegex(backup.BackupError, 'group or others'):
            backup.read_credentials(f)
        f.chmod(0o600)
        self.assertEqual(backup.read_credentials(f)['AWS_SECRET_ACCESS_KEY'], 'x')
        f.write_text('AWS_ACCESS_KEY_ID=AKIAFAKEFAKEFAKE1234\n')
        with self.assertRaisesRegex(backup.BackupError, 'lacks AWS_SECRET_ACCESS_KEY'):
            backup.read_credentials(f)

    def test_the_aws_command_carries_no_secret_and_never_overwrites(self):
        s3 = backup.S3(backup.Runner(), bucket=backup.BUCKET, owner=backup.BUCKET_OWNER,
                       region=backup.REGION, image=backup.AWS_IMAGE, workdir=self.tmp,
                       credentials={'AWS_ACCESS_KEY_ID': 'AKIAFAKEFAKEFAKE1234',
                                    'AWS_SECRET_ACCESS_KEY': 'top/secret'})
        self.assertEqual(stat.S_IMODE(s3.env_file.stat().st_mode), 0o600)
        calls = []
        s3._call = lambda args, step, timeout=0: (calls.append(s3.command(args)) or (0, b'{}', ''))
        s3.put(self.tmp / 'backup.dump', 'database/hourly/x.dump', '00' * 32, {'sha256': '00'})
        argv = ' '.join(calls[0])
        self.assertNotIn('top/secret', argv)
        self.assertNotIn('AKIAFAKE', argv)
        for flag in ('--if-none-match *', '--expected-bucket-owner 888725257303',
                     '--checksum-sha256', '--server-side-encryption AES256',
                     '--bucket ayvo-prod-backups-888725257303-eu-north-1-an'):
            self.assertIn(flag, argv)
        self.assertIn(backup.AWS_IMAGE, calls[0])
        self.assertNotIn('delete', argv.lower())

    def test_status_reports_a_failed_or_old_restore_check(self):
        state = self.tmp / 'state'
        now = backup.utcnow().isoformat(timespec='seconds')
        for kind in ('hourly', 'daily'):
            backup.record(state, f'last-success-{kind}.json', {'finishedAt': now, 'key': 'k'})
        backup.record(state, 'last-restore-check.json', {'finishedAt': now, 'result': 'OK'})
        self.assertEqual(backup.status(state, backup.MAX_AGE_HOURS)[0], 0)
        backup.record(state, 'last-restore-check.json',
                      {'finishedAt': now, 'result': 'FAILED', 'message': 'public.orders: 1 rows'})
        code, lines = backup.status(state, backup.MAX_AGE_HOURS)
        self.assertEqual(code, 1)
        self.assertIn('public.orders', lines[-1])
        backup.record(state, 'last-restore-check.json',
                      {'finishedAt': '2026-01-01T00:00:00+00:00', 'result': 'OK'})
        code, lines = backup.status(state, backup.MAX_AGE_HOURS)
        self.assertEqual(code, 1)
        self.assertIn('STALE', lines[-1])

    def test_an_unexpected_setup_failure_is_reported_not_a_traceback(self):
        blocker = self.tmp / 'not-a-directory'
        blocker.write_text('x')
        code = backup.cmd_run(backup.Config(kind='hourly', reason='test', state_dir=blocker))
        self.assertEqual(code, backup.EXIT_FAILED)

    def test_the_prefixes_are_exactly_the_lifecycle_rules(self):
        self.assertEqual(backup.PREFIXES, {'hourly': 'database/hourly/',
                                           'daily': 'database/daily/'})
        source = (HERE.parent / 'ayvo_backup' / 'backup.py').read_text()
        for forbidden in ('delete-object', 'DeleteObject', 'put-bucket-lifecycle', 'lifecycle-configuration'):
            self.assertNotIn(forbidden, source)


if __name__ == '__main__':
    unittest.main()
