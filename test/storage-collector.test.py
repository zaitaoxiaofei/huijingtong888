import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("collector", Path(__file__).parents[1] / "deploy/linux/collect-storage-usage.py")
collector = importlib.util.module_from_spec(spec)
spec.loader.exec_module(collector)


class StorageCollectorTests(unittest.TestCase):
    def test_fixed_paths_and_successfully_measured_zero(self):
        calls = []

        def run(command, **options):
            calls.append((command, options))
            return subprocess.CompletedProcess(command, 0, stdout="0\t/fixed-path\n")

        with patch.object(collector.subprocess, "run", side_effect=run), patch.object(collector, "binlog_bytes", return_value=27):
            result = collector.collect()
        self.assertEqual(result["errors"], {})
        self.assertEqual(result["metrics"]["mysql"], 0)
        self.assertEqual(result["metrics"]["binlog"], 27)
        self.assertEqual([call[0][-1] for call in calls], list(collector.PATHS.values()))
        for command, options in calls:
            self.assertEqual(command[:3], ["/usr/bin/du", "-sk", "--"])
            self.assertEqual(options["env"], {"PATH": "/usr/bin:/bin", "LC_ALL": "C"})
            self.assertTrue(options["check"])
            self.assertNotIn("shell", options)

    def test_permission_and_missing_paths_stay_unknown(self):
        with patch.object(collector, "directory_bytes", side_effect=PermissionError(13, "private filename must not leak")), \
                patch.object(collector, "binlog_bytes", side_effect=FileNotFoundError(2, "missing")):
            result = collector.collect()
        self.assertTrue(all(value is None for value in result["metrics"].values()))
        self.assertEqual(result["errors"]["mysql"], {"code": "EACCES"})
        self.assertEqual(result["errors"]["binlog"], {"code": "ENOENT"})
        self.assertNotIn("private filename", str(result))

    def test_partial_du_and_invalid_output_are_not_counted(self):
        with patch.object(collector.subprocess, "run", side_effect=subprocess.CalledProcessError(1, "du", output="123\t/private")):
            with self.assertRaises(subprocess.CalledProcessError):
                collector.directory_bytes("/var/lib/mysql")
        with patch.object(collector.subprocess, "run", return_value=subprocess.CompletedProcess("du", 0, stdout="bad")):
            with self.assertRaises(ValueError):
                collector.directory_bytes("/var/lib/mysql")

    def test_unsafe_output_directory_is_rejected_before_writing(self):
        from types import SimpleNamespace
        for mode, owner in [(0o040777, 0), (0o040755, 1000), (0o120777, 0)]:
            with patch.object(collector.os, "lstat", return_value=SimpleNamespace(st_mode=mode, st_uid=owner)):
                with self.assertRaises(PermissionError):
                    collector.publish({})

    def test_publish_replaces_the_snapshot_with_complete_json(self):
        from types import SimpleNamespace
        with tempfile.TemporaryDirectory() as temporary:
            target = Path(temporary) / "storage-usage.json"
            target.write_text("old snapshot", encoding="utf-8")
            value = {"version": 1, "metrics": {"mysql": 123}, "errors": {}}
            with patch.object(collector, "OUTPUT_DIRECTORY", temporary), \
                    patch.object(collector, "OUTPUT_PATH", str(target)), \
                    patch.object(collector.os, "lstat", return_value=SimpleNamespace(st_mode=0o040755, st_uid=0)), \
                    patch.object(collector.os, "fchmod", create=True) as chmod:
                collector.publish(value)
            self.assertEqual(json.loads(target.read_text(encoding="utf-8")), value)
            self.assertEqual(list(Path(temporary).iterdir()), [target])
            self.assertEqual(chmod.call_args.args[1], 0o644)


if __name__ == "__main__":
    unittest.main()
