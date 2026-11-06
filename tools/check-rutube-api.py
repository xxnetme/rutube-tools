#!/usr/bin/env python3
"""Read-only проверка контракта публичного RuTube play/options.

Коды выхода:
  0 — структура ответа совместима с src/lib/engine.js;
  2 — ответ получен, но ожидаемая структура изменилась;
  3 — API недоступен или ответ не удалось прочитать как JSON.

Секреты и cookies не нужны. Сырой ответ в отчёт не попадает.
"""
from __future__ import annotations

import json
import math
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

DEFAULT_VIDEO_ID = "39d4c8e6e2ddf0828195dc3222418697"
API_TEMPLATE = "https://rutube.ru/api/play/options/{video_id}/"
QUERY = "no_404=true&referer=https%3A%2F%2Frutube.ru&pver=v2"
USER_AGENT = "RuTubeTools-API-Monitor/1.0 (+https://github.com/xxnetme/rutube-tools)"
# Контрольный ролик длиннее минуты. Если вместо миллисекунд придут секунды,
# значение окажется ниже этого порога, а проверка не пропустит смену единиц.
MIN_REFERENCE_DURATION_MS = 60_000


def is_https_url(value: object, suffix: str | None = None) -> bool:
    if not isinstance(value, str) or not value:
        return False
    try:
        parsed = urllib.parse.urlparse(value)
    except ValueError:
        return False
    if parsed.scheme != "https" or not parsed.netloc:
        return False
    return suffix is None or parsed.path.lower().endswith(suffix)


def validate_options(data: object) -> list[str]:
    """Возвращает только несоответствия, без содержимого самого ответа."""
    if not isinstance(data, dict):
        return [f"корень ответа: ожидался object, получен {type(data).__name__}"]

    problems: list[str] = []

    if not isinstance(data.get("title"), str) or not data.get("title", "").strip():
        problems.append("title: ожидалась непустая строка")

    author = data.get("author")
    if not isinstance(author, dict):
        problems.append("author: ожидался object")
    elif not isinstance(author.get("name"), str) or not author.get("name", "").strip():
        problems.append("author.name: ожидалась непустая строка")

    duration = data.get("duration")
    if isinstance(duration, bool) or not isinstance(duration, (int, float)):
        problems.append("duration: ожидалось число в миллисекундах")
    elif not math.isfinite(duration) or duration < MIN_REFERENCE_DURATION_MS:
        problems.append(
            "duration: значение не похоже на миллисекунды для контрольного ролика "
            f"(ожидалось >= {MIN_REFERENCE_DURATION_MS})"
        )

    balancer = data.get("video_balancer")
    if not isinstance(balancer, dict):
        problems.append("video_balancer: ожидался object")
    elif not is_https_url(balancer.get("default"), ".m3u8"):
        problems.append("video_balancer.default: ожидалась HTTPS-ссылка на .m3u8")

    if not is_https_url(data.get("thumbnail_url")):
        problems.append("thumbnail_url: ожидалась HTTPS-ссылка")

    # Эти поля необязательны для конкретного ролика, но если они присутствуют,
    # их типы должны оставаться совместимыми с normalizeCaptions/normalizeCuepoints.
    captions = data.get("captions")
    if captions is not None:
        if not isinstance(captions, list):
            problems.append("captions: ожидался array")
        else:
            for index, caption in enumerate(captions):
                if not isinstance(caption, dict):
                    problems.append(f"captions[{index}]: ожидался object")
                    continue
                if not is_https_url(caption.get("file")):
                    problems.append(f"captions[{index}].file: ожидалась HTTPS-ссылка")
                if "format" in caption and not isinstance(caption.get("format"), str):
                    problems.append(f"captions[{index}].format: ожидалась строка")

    cuepoints = data.get("cuepoints")
    if cuepoints is not None and not isinstance(cuepoints, list):
        problems.append("cuepoints: ожидался array")

    live_streams = data.get("live_streams")
    # У обычного ролика API сейчас отдаёт {}, хотя engine также умеет читать array.
    if live_streams is not None and not isinstance(live_streams, (list, dict)):
        problems.append("live_streams: ожидался object или array")

    return problems


def fetch_options(video_id: str, timeout: float = 30) -> object:
    if not re.fullmatch(r"[0-9a-fA-F]{32}", video_id):
        raise ValueError("RUTUBE_MONITOR_VIDEO_ID должен содержать 32 hex-символа")
    url = API_TEMPLATE.format(video_id=video_id.lower()) + "?" + QUERY
    request = urllib.request.Request(
        url,
        headers={
            "Accept": "application/json",
            "Referer": f"https://rutube.ru/video/{video_id.lower()}/",
            "User-Agent": USER_AGENT,
        },
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        raw = response.read(4 * 1024 * 1024 + 1)
    if len(raw) > 4 * 1024 * 1024:
        raise ValueError("ответ play/options больше 4 МиБ")
    return json.loads(raw)


def fetch_with_retry(video_id: str, attempts: int = 2) -> object:
    last_error: Exception | None = None
    for attempt in range(1, attempts + 1):
        try:
            return fetch_options(video_id)
        except (urllib.error.URLError, TimeoutError, ValueError) as error:
            last_error = error
            if attempt < attempts:
                print(f"Попытка {attempt}: {error}; повторяю…", file=sys.stderr)
    assert last_error is not None
    raise last_error


def write_report(path: str, status: str, video_id: str, checked_at: str, details: list[str]) -> None:
    if not path:
        return
    titles = {
        "ok": "совместимость подтверждена",
        "contract": "изменилась структура ответа",
        "unavailable": "API недоступно или вернуло не-JSON",
    }
    lines = [
        "### Автопроверка RuTube API",
        "",
        f"- Результат: **{titles[status]}**",
        f"- Контрольное видео: https://rutube.ru/video/{video_id}/",
        f"- Проверено (UTC): `{checked_at}`",
        "",
    ]
    if details:
        lines += ["Детали:", ""]
        lines += [f"- {item}" for item in details]
        lines.append("")
    lines += [
        "Проверяются только публичные поля, которые использует расширение; "
        "сырой ответ и cookies не сохраняются.",
        "",
    ]
    Path(path).write_text("\n".join(lines), encoding="utf-8")


def main() -> int:
    video_id = os.environ.get("RUTUBE_MONITOR_VIDEO_ID", DEFAULT_VIDEO_ID).strip().lower()
    report = os.environ.get("RUTUBE_API_REPORT", "")
    checked_at = datetime.now(timezone.utc).replace(microsecond=0).isoformat()

    try:
        data = fetch_with_retry(video_id)
    except (urllib.error.URLError, TimeoutError, ValueError) as error:
        detail = str(error)[:800]
        write_report(report, "unavailable", video_id, checked_at, [detail])
        print(f"API недоступно: {detail}", file=sys.stderr)
        return 3

    problems = validate_options(data)
    if problems:
        write_report(report, "contract", video_id, checked_at, problems)
        for problem in problems:
            print(f"CONTRACT: {problem}", file=sys.stderr)
        return 2

    write_report(report, "ok", video_id, checked_at, [])
    print(f"RuTube play/options: структура совместима, видео {video_id}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
