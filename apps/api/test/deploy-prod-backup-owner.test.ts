import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The pre-deploy S3 backup of scripts/deploy-prod.sh runs under sudo (root), but the backup's
 * credentials are ayvo:600 and its state belongs to the timer's user (doc 035, doc 036 §6).
 * PROD 2026-10-24: the root run was refused by the credentials and left a root-owned result that
 * broke `status` for ayvo. This test runs the REAL backup package and the REAL function of the
 * script as root in a throwaway container (no PROD, no S3, no secrets: the docker CLI is a stub
 * that records who calls it). Containers run in CI only, or with AYVO_DOCKER_TESTS=1.
 */
const WANT_DOCKER = !!(process.env.CI || process.env.AYVO_DOCKER_TESTS);
const repo = resolve(import.meta.dirname, '../../..');
const IMAGE = 'python:3.12-slim-bookworm';

/** The script's own functions (owner lookup, state check, owner backup), nothing else. */
function scriptFunctions(): string {
  const lines = readFileSync(resolve(repo, 'scripts/deploy-prod.sh'), 'utf8').split('\n');
  const owner = lines.find((l) => l.startsWith('owner_uid() '))!;
  const from = lines.findIndex((l) => l.startsWith('readonly BACKUP_STATE_DIR='));
  const start = lines.findIndex((l) => l.startsWith('s3_backup_as_owner() {'));
  const end = lines.findIndex((l, i) => i > start && l === '}');
  expect([owner, from, start, end].every((v) => v !== undefined && v !== -1)).toBe(true);
  return [owner, ...lines.slice(from, end + 1)].join('\n');
}

const SETUP = `set -uo pipefail
groupadd -r docker && useradd -m -U -u 1000 ayvo
mkdir -p /usr/local/lib/ayvo-backup && cp -r /src/ayvo_backup /usr/local/lib/ayvo-backup/
install -d -m 755 /opt/ayvo/secrets
printf 'AWS_ACCESS_KEY_ID=AKIAFICTIONAL0000000\\nAWS_SECRET_ACCESS_KEY=fictional\\n' >/opt/ayvo/secrets/prod-s3-backup.env
chown ayvo:ayvo /opt/ayvo/secrets/prod-s3-backup.env && chmod 600 /opt/ayvo/secrets/prod-s3-backup.env
install -d -o ayvo -g ayvo -m 0750 /var/lib/ayvo-backup   # the timer's StateDirectory
install -m 666 /dev/null /var/log/docker-calls
printf '#!/bin/sh\\necho "$(id -un) $(id -gn) $(id -Gn | tr " " ,) $(umask)" >>/var/log/docker-calls\\nexit 0\\n' >/usr/local/bin/docker
chmod 755 /usr/local/bin/docker
export PATH=/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
as_timer() { runuser -u ayvo -g ayvo -G docker -- env -i PATH=$PATH HOME=/home/ayvo PYTHONPATH=/usr/local/lib/ayvo-backup PYTHONDONTWRITEBYTECODE=1 sh -c 'umask 077 && exec python3 -m ayvo_backup "$@"' sh "$@"; }
report() {
  echo "RC=$1"
  echo "STEP=$(python3 -c 'import json;print(json.load(open("/var/lib/ayvo-backup/last-failure-daily.json"))["step"])' 2>/dev/null)"
  echo "FOREIGN=$(find /var/lib/ayvo-backup ! -user ayvo -printf '%P,' )"
  echo "CALLERS=$(sort -u /var/log/docker-calls | tr ' ' '|' | tr '\\n' ';')"
  out=$(as_timer status 2>&1); echo "STATUS_RC=$? STATUS_PERMISSION_ERROR=$(echo "$out" | grep -c PermissionError)"
  out=$(as_timer run --kind hourly --reason timer 2>&1); echo "TIMER_RC=$? TIMER_PERMISSION_ERROR=$(echo "$out" | grep -c PermissionError)"
}
`;

function inContainer(body: string) {
  const res = spawnSync(
    'docker',
    [
      'run',
      '--rm',
      '--network',
      'none',
      '-v',
      `${resolve(repo, 'ops/prod-backup/ayvo_backup')}:/src/ayvo_backup:ro`,
      IMAGE,
      'bash',
      '-c',
      `${SETUP}\n${body}`,
    ],
    { encoding: 'utf8', timeout: 180_000 },
  );
  const out = `${res.stdout}${res.stderr}`;
  expect(out).not.toContain('fictional'); // no credential value is ever printed
  const value = (k: string) => new RegExp(`${k}=(\\S*)`).exec(out)?.[1] ?? '';
  return { out, value };
}

describe.skipIf(!WANT_DOCKER)('pre-deploy S3 backup under sudo keeps the timer working', () => {
  it('the c260309 call as root: refused by ayvo:600 credentials and a root-owned result breaks status for ayvo', () => {
    const { out, value } = inContainer(`
PYTHONPATH=/usr/local/lib/ayvo-backup PYTHONDONTWRITEBYTECODE=1 python3 -m ayvo_backup run --kind daily --reason "pre-deploy test"
report $?`);
    expect(value('RC'), out).toBe('1');
    expect(value('STEP')).toBe('credentials');
    expect(value('FOREIGN')).toContain('last-failure-daily.json');
    expect(value('STATUS_PERMISSION_ERROR')).toBe('1');
  });

  it('s3_backup_as_owner as root: runs as ayvo with docker for this process, umask 077; everything stays ayvo-owned', () => {
    const { out, value } = inContainer(`
die() { echo "DIE: $*" >&2; exit 3; }
DEPLOY_OWNER=ayvo
${scriptFunctions()}
s3_backup_as_owner "pre-deploy test"
report $?`);
    // The stub docker has no database, so the run fails later — but past the credentials.
    expect(value('RC'), out).toBe('1');
    expect(value('STEP')).not.toBe('credentials');
    expect(value('STEP')).not.toBe('');
    expect(value('FOREIGN')).toBe('');
    // Every docker call came from ayvo, primary group ayvo, docker supplementary, umask 0077.
    const callers = value('CALLERS').split(';').filter(Boolean);
    expect(callers.length).toBeGreaterThan(0);
    for (const c of callers) {
      const [user, group, groups, umask] = c.split('|');
      expect([user, group, umask]).toEqual(['ayvo', 'ayvo', '0077']);
      expect(groups!.split(',')).toContain('docker');
    }
    // The scheduled backup afterwards: status and a run as ayvo, no permission problem.
    expect(value('STATUS_PERMISSION_ERROR')).toBe('0');
    expect(value('TIMER_PERMISSION_ERROR')).toBe('0');
    expect(value('TIMER_RC')).not.toBe('75');
    expect(out).not.toMatch(/DIE:/);
  });

  it('a state entry the owner does not own stops before the backup runs (no silent repair)', () => {
    const { out, value } = inContainer(`
die() { echo "DIE: $*" >&2; exit 3; }
DEPLOY_OWNER=ayvo
${scriptFunctions()}
install -m 640 /dev/null /var/lib/ayvo-backup/last-failure-daily.json
( s3_backup_as_owner "pre-deploy test" ); echo "RC=$?"
echo "CALLS=$(wc -l </var/log/docker-calls)"
echo "GROUPS=$(id -Gn ayvo | tr ' ' ,)"`);
    expect(value('RC'), out).toBe('3');
    expect(out).toMatch(
      /DIE: .*last-failure-daily\.json.* not owned by ayvo|DIE: .*not owned by ayvo.*last-failure-daily\.json/,
    );
    expect(value('CALLS')).toBe('0');
    expect(value('GROUPS')).toBe('ayvo');
  });
});
