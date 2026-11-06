"""Unit-тесты валидатора монитора RuTube API, без сети."""
from __future__ import annotations

import copy
import importlib.util
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "check_rutube_api", ROOT / "tools" / "check-rutube-api.py"
)
assert SPEC and SPEC.loader
MONITOR = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MONITOR)


def valid_response() -> dict:
    return {
        "title": "Контрольный ролик",
        "author": {"name": "Автор"},
        "duration": 1_003_690,
        "video_balancer": {
            "default": "https://bl.rutube.ru/route/example.m3u8?guids=one,two"
        },
        "thumbnail_url": "https://pic.rtbcdn.ru/video/example.jpg",
        "captions": [
            {
                "code": "ru",
                "langTitle": "Русский",
                "format": "srt",
                "file": "https://pic.rtbcdn.ru/subtitles/example.srt",
            }
        ],
        "cuepoints": [],
        "live_streams": [],
    }


class ValidateOptionsTests(unittest.TestCase):
    def test_current_shape_is_accepted(self) -> None:
        self.assertEqual(MONITOR.validate_options(valid_response()), [])

    def test_optional_lists_may_be_absent(self) -> None:
        data = valid_response()
        del data["captions"]
        del data["cuepoints"]
        del data["live_streams"]
        self.assertEqual(MONITOR.validate_options(data), [])

    def test_root_must_be_object(self) -> None:
        self.assertIn("корень ответа", MONITOR.validate_options([])[0])

    def test_seconds_instead_of_milliseconds_are_detected(self) -> None:
        data = valid_response()
        data["duration"] = 1003.69
        problems = MONITOR.validate_options(data)
        self.assertTrue(any("duration" in item for item in problems))

    def test_boolean_is_not_a_duration(self) -> None:
        data = valid_response()
        data["duration"] = True
        self.assertTrue(any("duration" in item for item in MONITOR.validate_options(data)))

    def test_master_playlist_is_required(self) -> None:
        data = valid_response()
        data["video_balancer"]["default"] = "https://example.com/not-a-playlist"
        self.assertTrue(any("video_balancer.default" in item for item in MONITOR.validate_options(data)))

    def test_caption_shape_is_checked_when_present(self) -> None:
        data = valid_response()
        data["captions"][0]["file"] = "http://example.com/caption.srt"
        self.assertTrue(any("captions[0].file" in item for item in MONITOR.validate_options(data)))

    def test_wrong_optional_list_type_is_detected(self) -> None:
        data = valid_response()
        data["cuepoints"] = {}
        self.assertTrue(any("cuepoints" in item for item in MONITOR.validate_options(data)))

    def test_empty_live_streams_object_matches_real_api(self) -> None:
        data = valid_response()
        data["live_streams"] = {}
        self.assertEqual(MONITOR.validate_options(data), [])

    def test_wrong_live_streams_scalar_is_detected(self) -> None:
        data = valid_response()
        data["live_streams"] = "none"
        self.assertTrue(any("live_streams" in item for item in MONITOR.validate_options(data)))

    def test_validator_does_not_mutate_response(self) -> None:
        data = valid_response()
        before = copy.deepcopy(data)
        MONITOR.validate_options(data)
        self.assertEqual(data, before)


if __name__ == "__main__":
    unittest.main()
