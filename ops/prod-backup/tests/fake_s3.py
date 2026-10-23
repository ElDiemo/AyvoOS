"""A directory standing in for the backup bucket, with faults on request (tests only).

FAKE_S3_DIR          the "bucket" directory (required)
FAKE_S3_FAIL_PUTS    the first N puts fail
FAKE_S3_LOSE_ANSWER  the first put stores the object, then reports a failure (a lost answer)
FAKE_S3_PUT_SLEEP    seconds to wait inside every put (after writing FAKE_S3_DIR/.put-started)
"""

import base64
import hashlib
import json
import os
import shutil
import time
from pathlib import Path

from ayvo_backup.backup import BackupError, ObjectExists


class FakeS3:
    def __init__(self, runner, *, bucket, owner, region, image, workdir, credentials):
        assert credentials.get('AWS_ACCESS_KEY_ID') and credentials.get('AWS_SECRET_ACCESS_KEY')
        self.root = Path(os.environ['FAKE_S3_DIR'])
        self.root.mkdir(parents=True, exist_ok=True)
        self.counter = self.root / '.puts'

    def _puts(self) -> int:
        n = int(self.counter.read_text()) if self.counter.exists() else 0
        self.counter.write_text(str(n + 1))
        return n + 1

    def _obj(self, key: str) -> Path:
        return self.root / key

    def put(self, local, key, sha256_hex, metadata):
        n = self._puts()
        (self.root / '.put-started').write_text(key)
        time.sleep(float(os.environ.get('FAKE_S3_PUT_SLEEP', '0')))
        if n <= int(os.environ.get('FAKE_S3_FAIL_PUTS', '0')):
            raise BackupError('upload', 'simulated network failure')
        obj = self._obj(key)
        if obj.exists():
            raise ObjectExists(key)
        if hashlib.sha256(Path(local).read_bytes()).hexdigest() != sha256_hex:
            raise BackupError('upload', 'BadDigest')
        obj.parent.mkdir(parents=True, exist_ok=True)
        tmp = obj.with_name(obj.name + '.uploading')
        shutil.copyfile(local, tmp)
        os.replace(tmp, obj)
        obj.with_name(obj.name + '.meta').write_text(json.dumps(metadata))
        if os.environ.get('FAKE_S3_LOSE_ANSWER') and n == 1:
            raise BackupError('upload', 'connection reset after the upload')

    def head(self, key):
        obj = self._obj(key)
        if not obj.exists():
            raise BackupError('verify', f'head-object {key}: 404')
        data = obj.read_bytes()
        return {
            'ContentLength': len(data),
            'ChecksumSHA256': base64.b64encode(hashlib.sha256(data).digest()).decode(),
            'Metadata': json.loads(obj.with_name(obj.name + '.meta').read_text()),
        }

    def get(self, key, local):
        obj = self._obj(key)
        if not obj.exists():
            raise BackupError('download', f'get-object {key}: 404')
        shutil.copyfile(obj, local)

    def latest(self, prefix):
        keys = {str(p.relative_to(self.root)) for p in self.root.rglob('*') if p.is_file()}
        dumps = sorted(k for k in keys if k.startswith(prefix) and k.endswith('.dump')
                       and f'{k}.manifest.json' in keys)
        return dumps[-1] if dumps else None
