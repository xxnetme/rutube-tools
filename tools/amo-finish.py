#!/usr/bin/env python3
"""Дозаполнение карточки AMO после лимитов: политика конфиденциальности и скриншоты.

Запускать, когда 429 прошёл:

    AMO_JWT_ISSUER='user:...' AMO_JWT_SECRET='...' python3 tools/amo-finish.py

Скрипт идемпотентен: уже загруженные скриншоты пропускаются, текст политики
перезаписывается только если поле пустое.
"""
import importlib.util
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("amo", ROOT / "tools/amo-publish.py")
amo = importlib.util.module_from_spec(spec)
spec.loader.exec_module(amo)

ISS = os.environ.get("AMO_JWT_ISSUER", "").strip()
SEC = os.environ.get("AMO_JWT_SECRET", "").strip()
if not ISS or not SEC:
    raise SystemExit("нужны AMO_JWT_ISSUER и AMO_JWT_SECRET")
tk = lambda: amo.jwt(ISS, SEC)  # noqa: E731

POLICY = {
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
        "stored locally. Nothing leaves your device except requests to RuTube and its CDN, made "
        "without cookies.\n\n"
        "No analytics, telemetry, ads or trackers. No own servers. The content script runs on "
        "rutube.ru only.\n\n"
        "Full text: https://xxnetme.github.io/rutube-tools/privacy.html"
    ),
}


def main():
    detail = amo.call("GET", f"/addons/addon/{amo.SLUG}/?lang=ru", tk())
    if not detail.get("has_privacy_policy"):
        amo.call("PATCH", f"/addons/addon/{amo.SLUG}/eula_policy/", tk(),
                 payload={"privacy_policy": POLICY})
        print("политика конфиденциальности записана")
    else:
        print("политика уже есть")

    amo.previews(ISS, SEC)
    detail = amo.call("GET", f"/addons/addon/{amo.SLUG}/?lang=ru", tk())
    print("итог: скриншотов", len(detail.get("previews", [])),
          "| has_privacy_policy:", detail.get("has_privacy_policy"),
          "| статус:", detail.get("status"))


if __name__ == "__main__":
    sys.exit(main())
