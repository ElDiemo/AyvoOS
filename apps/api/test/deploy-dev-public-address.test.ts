import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * verify_tailnet_only's public addresses (scripts/deploy-dev.sh): the real function and the real
 * call lines under `set -Eeuo pipefail`, against a fake `ip` on PATH. An awk that exited at the
 * first match let `ip` die of SIGPIPE (141) on a long interface list, and the deployment stopped
 * after a successful start (DEV 2026-11-20, c34408c). The contract stays: the first matching
 * address, IPv4 required, IPv6 optional, a failing `ip` stops the script. Addresses are from the
 * documentation ranges (RFC 5737, RFC 3849).
 */
const script = readFileSync(
  resolve(import.meta.dirname, '../../../scripts/deploy-dev.sh'),
  'utf8',
).split('\n');
const fn = (name: string) => {
  const from = script.findIndex((l) => l.startsWith(`${name}() {`));
  expect(from, name).toBeGreaterThan(-1);
  return script.slice(from, script.indexOf('}', from) + 1).join('\n');
};
/** The real lines of verify_tailnet_only that read both addresses and require the IPv4 one. */
const callLines = (() => {
  const lines = script.filter(
    (l) =>
      /^\s+pub[46]="\$\(first_public_address [46]\)"$/.test(l) ||
      l.includes('die "cannot determine the public IPv4 address"'),
  );
  expect(lines).toHaveLength(3);
  return lines.join('\n');
})();

const tmp = mkdtempSync(join(tmpdir(), 'ayvo-public-address-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** A fake `ip`: prints `-4`/`-6` lines from files, or fails like a broken `ip`. */
function fakeIp(v4: string[], v6: string[], fail = false): string {
  const dir = mkdtempSync(join(tmp, 'bin-'));
  writeFileSync(join(dir, 'v4.txt'), v4.join('\n') + (v4.length ? '\n' : ''));
  writeFileSync(join(dir, 'v6.txt'), v6.join('\n') + (v6.length ? '\n' : ''));
  // Line by line, like a real `ip` writing a long list: a closed pipe kills it with SIGPIPE.
  writeFileSync(
    join(dir, 'ip'),
    [
      '#!/usr/bin/env bash',
      fail ? 'echo "Cannot open netlink socket" >&2; exit 2' : '',
      `f="${dir}/v4.txt"; [[ $1 == -6 ]] && f="${dir}/v6.txt"`,
      'while IFS= read -r line; do echo "$line"; done <"$f"',
    ].join('\n'),
  );
  chmodSync(join(dir, 'ip'), 0o755);
  return dir;
}

function run(bin: string) {
  const body = [
    'set -Eeuo pipefail',
    'die() { echo "DIE $*"; exit 1; }',
    fn('first_public_address'),
    callLines,
    'echo "PUB4=$pub4"',
    'echo "PUB6=$pub6"',
  ].join('\n');
  const file = join(tmp, `run-${Math.random().toString(36).slice(2)}.sh`);
  writeFileSync(file, body);
  return spawnSync('bash', [file], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });
}

const v4 = (dev: string, addr: string) => `2: ${dev}    inet ${addr}/24 brd x scope global ${dev}`;
const v6 = (dev: string, addr: string) => `2: ${dev}    inet6 ${addr}/64 scope global`;
/** Far more than a pipe buffer (64 KiB) after the first match. */
const noise = (make: (dev: string, addr: string) => string, n = 20_000) =>
  Array.from({ length: n }, (_, i) =>
    make(`veth${i}`, i % 2 ? '198.51.100.7' : '2001:db8:ffff::7'),
  );

describe('first_public_address under pipefail (deploy-dev.sh verify_tailnet_only)', () => {
  it('a long interface list after the first match: the first address, five times in a row', () => {
    const bin = fakeIp(
      [v4('eth0', '203.0.113.10'), ...noise(v4)],
      [v6('eth0', '2001:db8::10'), ...noise(v6)],
    );
    for (let i = 0; i < 5; i++) {
      const r = run(bin);
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toBe('PUB4=203.0.113.10\nPUB6=2001:db8::10\n');
    }
  });

  it('skips tailscale0 and the Docker interfaces; keeps the FIRST matching address', () => {
    const bin = fakeIp(
      [
        v4('docker0', '172.17.0.1'),
        v4('tailscale0', '100.64.0.5'),
        v4('br-1a2b', '172.18.0.1'),
        v4('eth0', '203.0.113.10'),
        v4('eth1', '203.0.113.99'),
      ],
      [v6('tailscale0', 'fd7a::5'), v6('eth0', '2001:db8::10'), v6('eth1', '2001:db8::99')],
    );
    const r = run(bin);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toBe('PUB4=203.0.113.10\nPUB6=2001:db8::10\n');
  });

  it('no public IPv4: the deployment stops with its message', () => {
    const bin = fakeIp([v4('tailscale0', '100.64.0.5'), v4('docker0', '172.17.0.1')], []);
    const r = run(bin);
    expect(r.status).toBe(1);
    expect(r.stdout).toBe('DIE cannot determine the public IPv4 address\n');
  });

  it('no public IPv6: empty, and the deployment goes on (the IPv6 check is skipped)', () => {
    const bin = fakeIp([v4('eth0', '203.0.113.10')], [v6('tailscale0', 'fd7a::5')]);
    const r = run(bin);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toBe('PUB4=203.0.113.10\nPUB6=\n');
  });

  it('a failing `ip` still stops the script (never an empty address taken as fine)', () => {
    const r = run(fakeIp([], [], true));
    expect(r.status).not.toBe(0);
    expect(r.stdout).not.toContain('PUB4=');
    expect(r.stderr).toContain('Cannot open netlink socket');
  });
});
