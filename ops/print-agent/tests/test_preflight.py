"""preflight.sh with stubbed system commands (no Raspberry Pi needed). PRINT38-R4: a CUPS queue for
the Zebra while no USB printer device exists must not stop the script before its summary."""

import os
import stat
import subprocess
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent
STUBS = {
    "tailscale": 'case "$1" in status) exit 0 ;; ip) echo 100.64.0.5 ;; esac',
    "getent": "echo '100.96.86.50 dev.ayvo.co'",
    "curl": "echo 200",
    "lsusb": "echo 'Bus 001 Device 004: ID 0a5f:0164 Zebra Technologies ZTC ZD220-203dpi ZPL'",
    "lsmod": "exit 0",
    "lpstat": "echo 'device for Zebra: usb://Zebra%20Technologies/ZTC%20ZD220-203dpi%20ZPL'",
    "timedatectl": "echo yes",
    "systemctl": "exit 1",
}


class PreflightTest(unittest.TestCase):
    def run_preflight(self, usbmisc: Path, health_status: int = 200) -> subprocess.CompletedProcess:
        bin_dir = Path(tempfile.mkdtemp())
        for name, body in STUBS.items():
            if name == "curl":
                body = f"echo {health_status}"
            p = bin_dir / name
            p.write_text(f"#!/bin/sh\n{body}\n")
            p.chmod(p.stat().st_mode | stat.S_IEXEC)
        env = {
            "PATH": f"{bin_dir}:/usr/bin:/bin",
            "HOME": str(bin_dir),
            "AYVO_PREFLIGHT_USBMISC": str(usbmisc),
        }
        return subprocess.run(
            ["bash", str(HERE / "preflight.sh"), "https://dev.ayvo.co/api"],
            env=env,
            capture_output=True,
            text=True,
            timeout=60,
        )

    def test_cups_queue_without_a_usb_device_reaches_the_summary(self):
        empty = Path(tempfile.mkdtemp())  # no lp* entries
        r = self.run_preflight(empty)
        self.assertNotIn("unbound variable", r.stderr)
        self.assertIn("CUPS has a queue for the Zebra", r.stdout)
        self.assertIn("PREFLIGHT: 1 problem(s)", r.stdout)
        self.assertIn("no USB printer device", r.stdout)
        self.assertEqual(r.returncode, 1)

    def test_a_found_printer_shows_its_usb_serial(self):
        sysfs = Path(tempfile.mkdtemp())
        dev = sysfs / "lp0" / "device"
        dev.mkdir(parents=True)
        (sysfs / "lp0" / "serial").write_text("D4J221100123\n")  # …/device/../serial
        (sysfs / "lp0" / "product").write_text("ZTC ZD220-203dpi ZPL\n")
        r = self.run_preflight(sysfs)
        self.assertIn("USB serial 'D4J221100123'", r.stdout)
        self.assertIn("PREFLIGHT OK", r.stdout)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)

    def test_basic_auth_on_health_is_no_longer_expected(self):
        sysfs = Path(tempfile.mkdtemp())
        (sysfs / "lp0" / "device").mkdir(parents=True)
        r = self.run_preflight(sysfs, health_status=401)
        self.assertEqual(r.returncode, 1, r.stdout + r.stderr)
        self.assertIn("unexpected authentication on health", r.stdout)


if __name__ == "__main__":
    unittest.main()
