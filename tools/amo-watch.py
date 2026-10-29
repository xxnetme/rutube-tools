#!/usr/bin/env python3
"""Ждёт, пока спадёт суточный лимит AMO, и дозаполняет карточку.

Запускается в фоне: раз в 2 минуты пробует записать политику конфиденциальности,
затем догружает скриншоты. Пишет прогресс в docs/../.amo-watch.log.

    AMO_JWT_ISSUER=... AMO_JWT_SECRET=... python3 tools/amo-watch.py
"""
import importlib.util
import os
import re
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LOG = ROOT / ".amo-watch.log"

spec = importlib.util.spec_from_file_location("amo", ROOT / "tools/amo-publish.py")
amo = importlib.util.module_from_spec(spec)
spec.loader.exec_module(amo)

ISS = os.environ["AMO_JWT_ISSUER"].strip()
SEC = os.environ["AMO_JWT_SECRET"].strip()
tk = lambda: amo.jwt(ISS, SEC)  # noqa: E731

TEXT = {
    "ru": (
        "RuTube Tools не собирает, не хранит и не передаёт персональные данные.\n\n"
        "Вся работа происходит в вашем браузере. Сохраняются только настройки расширения "
        "(качество, частота кадров, набор клавиш) и позиция просмотра — локально, в хранилище "
        "браузера. Наружу не уходит ничего, кроме запросов к самому RuTube и его CDN, откуда вы "
        "и так смотрите видео; cookie при этих запросах не передаются.\n\n"
        "Нет аналитики, телеметрии, рекламы и трекеров. Нет собственных серверов. Нет доступа к "
        "другим сайтам: скрипт работает только на rutube.ru.\n\n"
        "Полный текст: https://xxnetme.github.io/rutube-tools/privacy.html"
    ),
    "en-US": (
        "RuTube Tools does not collect, store or transmit personal data.\n\n"
        "Everything runs in your browser. Only extension settings and playback position are "
        "stored locally in the browser. Nothing leaves your device except requests to RuTube and "
        "its CDN — the same servers that deliver the video you are watching; those requests are "
        "made without cookies.\n\n"
        "No analytics, telemetry, ads or trackers. No own servers. The content script runs on "
        "rutube.ru only.\n\n"
        "Full text: https://xxnetme.github.io/rutube-tools/privacy.html"
    ),
}


def log(msg: str) -> None:
    line = f"{time.strftime('%H:%M:%S')} {msg}"
    print(line, flush=True)
    with LOG.open("a", encoding="utf-8") as f:
        f.write(line + "\n")


def wait_seconds(exc: str) -> int:
    m = re.search(r"Expected available in (\d+) seconds", exc)
    return int(m.group(1)) if m else 0


def main() -> int:
    log("старт: жду сброса лимита AMO")
    for attempt in range(40):
        try:
            amo.call("PATCH", f"/addons/addon/{amo.SLUG}/eula_policy/", tk(),
                     payload={"privacy_policy": TEXT})
            log("политика конфиденциальности записана")
            break
        except SystemExit as e:
            left = wait_seconds(str(e))
            if not left:
                log(f"неожиданная ошибка: {str(e)[:200]}")
                return 1
            pause = min(max(left + 15, 30), 900)
            log(f"ещё занято ({left} с) — жду {pause} с")
            time.sleep(pause)
    else:
        log("сдался: лимит не спал за 40 попыток")
        return 1

    detail = amo.call("GET", f"/addons/addon/{amo.SLUG}/?lang=ru", tk())
    log(f"политика на карточке: {detail.get('has_privacy_policy')}")

    try:
        amo.previews(ISS, SEC)
    except SystemExit as e:
        log(f"скриншоты: {str(e)[:200]}")
        return 1

    detail = amo.call("GET", f"/addons/addon/{amo.SLUG}/?lang=ru", tk())
    log(f"готово: скриншотов {len(detail.get('previews', []))}, "
        f"приватность {detail.get('has_privacy_policy')}, статус {detail.get('status')}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
