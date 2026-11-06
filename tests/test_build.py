"""Проверки воспроизводимой упаковки, без изменения рабочей сборки."""
from __future__ import annotations

import importlib.util
import json
import os
import tempfile
import unittest
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("rutube_build", ROOT / "build.py")
assert SPEC and SPEC.loader
BUILD = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BUILD)


class MakeZipTests(unittest.TestCase):
    def test_source_mtime_does_not_change_zip_bytes(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "source"
            source.mkdir()
            payload = source / "manifest.json"
            payload.write_text('{"manifest_version":3}\n', encoding="utf-8")
            first = root / "first.zip"
            second = root / "second.zip"

            os.utime(payload, (1_700_000_000, 1_700_000_000))
            BUILD.make_zip(source, first)
            os.utime(payload, (1_800_000_000, 1_800_000_000))
            BUILD.make_zip(source, second)

            self.assertEqual(first.read_bytes(), second.read_bytes())
            with zipfile.ZipFile(first) as archive:
                info = archive.getinfo("manifest.json")
                self.assertEqual(info.date_time, (1980, 1, 1, 0, 0, 0))
                self.assertEqual(info.external_attr >> 16, 0o100644)
                self.assertEqual(archive.read("manifest.json"), payload.read_bytes())


class ManifestTests(unittest.TestCase):
    def test_extension_pages_csp_is_explicit_and_restrictive(self) -> None:
        expected = "script-src 'self'; object-src 'self';"
        for name in ("manifest.firefox.json", "manifest.chromium.json"):
            with self.subTest(manifest=name):
                manifest = json.loads((ROOT / "src" / name).read_text(encoding="utf-8"))
                csp = manifest["content_security_policy"]["extension_pages"]
                self.assertEqual(csp, expected)
                self.assertNotIn("unsafe", csp)
                self.assertNotIn("http:", csp)
                self.assertNotIn("https:", csp)


if __name__ == "__main__":
    unittest.main()
