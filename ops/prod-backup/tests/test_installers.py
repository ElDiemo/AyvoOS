"""The PROD installers refuse the wrong host before any change (doc 035 §6).

Every command they could change something with is a fake that only records its call; the host
is simulated (hostname, containers, Tailscale address). No real change can happen here.
"""

import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MUTATING = ('install', 'systemctl', 'rm', 'cp', 'mkdir', 'chmod', 'chown', 'ln', 'sysctl', 'mv')
DEV_MARKERS = ('/opt/ayvo/secrets/dev-preview.env', '/usr/local/sbin/ayvo-dev-docker-guard',
               '/etc/systemd/system/ayvo-dev-docker-guard.service',
               '/etc/sysctl.d/60-ayvo-dev-tailnet.conf')


class InstallerHostTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.bin = self.tmp / 'bin'
        self.bin.mkdir()
        self.log = self.tmp / 'calls.log'
        self.log.touch()

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def fake(self, name, body):
        path = self.bin / name
        path.write_text(f'#!/bin/sh\n{body}\n')
        path.chmod(0o755)

    def host(self, hostname, containers, tailnet, docker_ok=True):
        self.fake('id', 'case "$1" in -u) echo 0;; *) exit 0;; esac')
        self.fake('hostname', f'echo {hostname}')
        self.fake('getent', 'exit 0')
        self.fake('tailscale', f'echo {tailnet}')
        names = '\\n'.join(containers)
        self.fake('docker', f'[ "$1" = ps ] && {{ {"printf " + repr(names + chr(10)) if docker_ok else "exit 1"}; exit 0; }}; exit 0')
        for name in MUTATING:
            self.fake(name, f'echo "{name} $*" >> "{self.log}"')

    def run_script(self, script):
        env = dict(os.environ, PATH=f'{self.bin}:/usr/bin:/bin')
        return subprocess.run(['bash', str(ROOT / script)], env=env, capture_output=True,
                              text=True, timeout=60)

    def mutations(self):
        return [line for line in self.log.read_text().splitlines() if line.strip()]

    def test_the_dev_server_is_refused_with_zero_changes(self):
        self.host('AyvoOS', ['ayvo-dev-preview-api-1', 'ayvo-dev-preview-caddy-1'], '100.64.12.34')
        for script in ('install.sh', 'uninstall.sh'):
            res = self.run_script(script)
            self.assertEqual(res.returncode, 1, (script, res.stdout, res.stderr))
            self.assertIn('refusing', res.stderr)
            self.assertEqual(self.mutations(), [], script)

    def test_dev_traces_or_another_address_are_refused_even_under_the_right_name(self):
        cases = [
            (['ayvo-dev-preview-api-1'], '100.88.139.2', True, 'DEV preview containers'),
            ([], '100.64.12.34', True, "Tailscale IPv4 is '100.64.12.34'"),
            ([], '100.88.139.2', False, 'cannot list the containers'),
        ]
        for containers, tailnet, docker_ok, message in cases:
            self.host('AyvoOS-PROD', containers, tailnet, docker_ok)
            for script in ('install.sh', 'uninstall.sh'):
                res = self.run_script(script)
                if any(Path(m).exists() for m in DEV_MARKERS):
                    message_here = 'DEV preview found'  # running on the DEV server itself
                else:
                    message_here = message
                self.assertEqual(res.returncode, 1, (script, message, res.stderr))
                self.assertIn(message_here, res.stderr)
                self.assertEqual(self.mutations(), [], (script, message))

    @unittest.skipIf(any(Path(m).exists() for m in DEV_MARKERS), 'this machine has DEV traces')
    def test_the_production_host_passes_the_check(self):
        self.host('AyvoOS-PROD', ['ayvo-prod-api-1'], '100.88.139.2')
        res = self.run_script('install.sh')
        self.assertEqual(res.returncode, 0, res.stderr)
        self.assertTrue(any(m.startswith('systemctl daemon-reload') for m in self.mutations()))


if __name__ == '__main__':
    unittest.main()
