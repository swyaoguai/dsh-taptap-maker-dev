"""Run the real embedded diagnostic-write block with a memory-only filesystem.
No browser, network, screenshots, user files, deletion or generation.
"""
from pathlib import Path
import os
from types import SimpleNamespace
import textwrap
import unittest

ROOT = Path(__file__).resolve().parent.parent
source = (ROOT / "src/taptap-gpt.mjs").read_text(encoding="utf-8")
start = source.index("    # Keep a screenshot so the failure can be diagnosed without guessing.")
end = source.index('    result["steps"] = steps', start)
BLOCK = compile(textwrap.dedent(source[start:end]), "embedded-diagnostic-write", "exec")
STAMP = 1700000000
DIRECTORY = "MEMORY-ONLY"
TARGET = os.path.join(DIRECTORY, f"failed-{STAMP}.png")


class DiagnosticTests(unittest.TestCase):
    def execute(self, existing=None, fail_capture=False):
        files = dict(existing or {})
        modes = []
        steps = {}

        class Writer:
            def __init__(self, name):
                self.name = name

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def write(self, data):
                files[self.name] += data
                return len(data)

        def memory_open(name, mode="r"):
            modes.append(mode)
            if mode != "xb":
                raise AssertionError("diagnostics must use exclusive creation")
            if name in files:
                raise FileExistsError(name)
            files[name] = b""
            return Writer(name)

        def screenshot(path=None):
            if fail_capture:
                raise RuntimeError("offline screenshot failure")
            if path is not None:
                # Emulate Playwright's old overwrite behavior in memory only.
                files[path] = b"OFFLINE-DIAGNOSTIC"
            return b"OFFLINE-DIAGNOSTIC"

        exec(BLOCK, {"os": os, "time": SimpleNamespace(time=lambda: STAMP),
                     "DL": DIRECTORY, "pg": SimpleNamespace(screenshot=screenshot),
                     "steps": steps, "open": memory_open})
        return files, modes, steps

    def test_existing_reference_or_diagnostic_is_never_overwritten(self):
        files, _modes, steps = self.execute({TARGET: b"ORIGINAL-REFERENCE"})
        self.assertEqual(files[TARGET], b"ORIGINAL-REFERENCE")
        self.assertNotIn("screenshot", steps)

    def test_new_diagnostic_uses_exclusive_create_and_reports_saved_path(self):
        files, modes, steps = self.execute()
        self.assertEqual(files[TARGET], b"OFFLINE-DIAGNOSTIC")
        self.assertEqual(modes, ["xb"])
        self.assertEqual(steps["screenshot"], TARGET)

    def test_failed_capture_creates_no_output_and_keeps_existing_files(self):
        existing = {"another-reference.png": b"ORIGINAL"}
        files, modes, steps = self.execute(existing, fail_capture=True)
        self.assertEqual(files, existing)
        self.assertEqual(modes, [])
        self.assertNotIn("screenshot", steps)


if __name__ == "__main__":
    unittest.main(verbosity=2)
