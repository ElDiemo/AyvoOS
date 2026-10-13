"""The delivery CLI's input checks (issue #13)."""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from night_shift import cli
from night_shift.manifest import ManifestError, parse, task_sha256

from helpers import raw_manifest

EXAMPLE = Path(__file__).resolve().parents[1] / "examples" / "run-manifest.example.json"


class CliTest(unittest.TestCase):
    def test_the_documented_example_is_a_valid_manifest(self) -> None:
        parse(json.loads(EXAMPLE.read_text(encoding="utf-8")))

    def test_a_swapped_task_file_is_refused(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            task = "Build the catalogue list."
            raw = raw_manifest(parts=[{"slug": "catalog-ui-list", "title": "List", "task_sha256": task_sha256(task), "risk": "normal"}])
            (directory / "catalog-ui-list.md").write_text(task, encoding="utf-8")
            self.assertEqual(cli._tasks(parse(raw), directory), {"catalog-ui-list": task})
            (directory / "catalog-ui-list.md").write_text(task + " And deploy production.", encoding="utf-8")
            with self.assertRaises(ManifestError):
                cli._tasks(parse(raw), directory)


if __name__ == "__main__":
    unittest.main()
