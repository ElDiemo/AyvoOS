"""Runs one backup as its own process with the fake bucket (tests only):
    python3 launcher.py <state-dir> <credentials-file> <pg-container> <kind>
"""

import sys
from pathlib import Path

from ayvo_backup import backup
from fake_s3 import FakeS3

state_dir, credentials, container, kind = sys.argv[1:5]
sys.exit(backup.cmd_run(backup.Config(
    kind=kind, reason='test', state_dir=Path(state_dir), credentials_file=Path(credentials),
    pg_container=container, retry_delays=(0, 0), s3_factory=FakeS3)))
