#!/usr/bin/env python3
"""Применяет все правки карточки AMO одним проходом, когда спадёт суточный лимит.

Порядок:
  1. политика конфиденциальности — настоящий текст вместо служебной строки
  2. один PATCH карточки: название, сводка, описание на ru + en-US, сайт поддержки
  3. скриншоты 4–9 (3 из 9 уже загружены)

Идемпотентно: перед каждой правкой читает текущее состояние и пропускает готовое.
Ждёт лимит по времени, которое сообщает сам AMO.

    AMO_JWT_ISSUER=... AMO_JWT_SECRET=... python3 tools/amo-apply-all.py
"""
import importlib.util
import os
import re
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LOG = ROOT / ".amo-apply-all.log"

spec = importlib.util.spec_from_file_location("amo", ROOT / "tools/amo-publish.py")
amo = importlib.util.module_from_spec(spec)
spec.loader.exec_module(amo)

ISS = os.environ["AMO_JWT_ISSUER"].strip()
SEC = os.environ["AMO_JWT_SECRET"].strip()
tk = lambda: amo.jwt(ISS, SEC)  # noqa: E731

PRIVACY = {
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
        "Everything runs in your browser. Only extension settings (quality, frame rate, key set) "
        "and playback position are stored locally in browser storage. Nothing leaves your device "
        "except requests to RuTube and its CDN — the same servers that deliver the video you are "
        "watching; those requests are made without cookies.\n\n"
        "No analytics, telemetry, ads or trackers. No own servers. No content script access to "
        "other sites: it runs on rutube.ru only.\n\n"
        "Full text: https://xxnetme.github.io/rutube-tools/privacy.html"
    ),
}

SUMMARY = {
    "ru": "Скачивание видео и плейлистов RuTube в MP4, покадровая перемотка, кадры в PNG, "
          "субтитры и обложки.",
    "en-US": "Download RuTube videos and playlists to MP4, step through video frame by frame, "
             "save stills as PNG, grab subtitles and covers.",
}


def log(msg: str) -> None:
    line = f"{time.strftime('%d.%m %H:%M:%S')} {msg}"
    print(line, flush=True)
    with LOG.open("a", encoding="utf-8") as f:
        f.write(line + "\n")


def throttled(exc: str) -> int:
    m = re.search(r"Expected available in (\d+) seconds", exc)
    return int(m.group(1)) if m else 0


ONCE = os.environ.get("AMO_ONCE") == "1"


def call_until_ok(fn, what: str, max_attempts: int = 90):
    """Повторяет запись, пока AMO не перестанет троттлить.

    В режиме AMO_ONCE=1 (запуск по расписанию) делает одну попытку и выходит:
    следующий запуск по cron повторит.
    """
    if ONCE:
        max_attempts = 1
    for i in range(max_attempts):
        try:
            return fn()
        except SystemExit as e:
            left = throttled(str(e))
            if not left:
                log(f"{what}: ошибка без троттлинга — {str(e)[:300]}")
                return None
            pause = min(left + 20, 1500)
            tail = "" if ONCE else f" — сплю {pause} с"
            log(f"{what}: лимит, ещё {left} с ({left / 3600:.1f} ч){tail}")
            if ONCE:
                return None
            time.sleep(pause)
    log(f"{what}: не дождался за {max_attempts} попыток")
    return None


def read_listing() -> str:
    """Текст описания ru из docs/store/listing-ru.md (раздел AMO без HTML)."""
    md = (ROOT / "docs/store/listing-ru.md").read_text(encoding="utf-8")
    marker = "## AMO: описание простым текстом (без HTML)"
    if marker in md:
        return md.split(marker, 1)[1].split("\n## ", 1)[0].strip()
    return ""


def read_listing_en() -> str:
    md = (ROOT / "docs/store/listing-en.md").read_text(encoding="utf-8")
    m = re.search(r"## Description\n\n```\n(.*?)\n```", md, re.S)
    return m.group(1).strip() if m else ""


def step_privacy() -> bool:
    cur = amo.call("GET", f"/addons/addon/{amo.SLUG}/eula_policy/", tk())
    have = (cur.get("privacy_policy") or {}).get("ru", "")
    if have.strip() == PRIVACY["ru"].strip():
        log("1/3 политика уже верная — пропускаю")
        return True
    log(f"1/3 политика сейчас: «{have[:40]}» — заменяю")
    r = call_until_ok(lambda: amo.call("PATCH", f"/addons/addon/{amo.SLUG}/eula_policy/", tk(),
                                       payload={"privacy_policy": PRIVACY}), "политика")
    if not r:
        return False
    log("1/3 политика записана")
    return True


def step_metadata() -> bool:
    d = amo.call("GET", f"/addons/addon/{amo.SLUG}/?lang=ru", tk())
    locales = set((d.get("name") or {}).keys())
    if "en-US" in locales:
        log("2/3 en-US уже есть — пропускаю")
        return True

    desc_ru = read_listing()
    payload = {
        "name": {"ru": "RuTube Tools — кадры и MP4", "en-US": "RuTube Tools — frames & MP4"},
        "summary": SUMMARY,
        "description": {"ru": desc_ru, "en-US": read_listing_en()},
        "support_url": {"ru": "https://xxnetme.github.io/rutube-tools/",
                        "en-US": "https://xxnetme.github.io/rutube-tools/"},
    }
    r = call_until_ok(lambda: amo.call("PATCH", f"/addons/addon/{amo.SLUG}/", tk(), payload=payload),
                      "карточка")
    if r is None:
        # support_url может быть нередактируемым через API — повторяем без него
        log("2/3 повторяю без support_url")
        payload.pop("support_url", None)
        r = call_until_ok(lambda: amo.call("PATCH", f"/addons/addon/{amo.SLUG}/", tk(), payload=payload),
                          "карточка")
    if r is None:
        return False
    log(f"2/3 локали в карточке: {sorted((r.get('name') or {}).keys())}")
    return True


def step_shots() -> bool:
    detail = amo.call("GET", f"/addons/addon/{amo.SLUG}/?lang=ru", tk())
    taken = {p.get("position") for p in detail.get("previews", [])}
    shots = [
        (4, "04-more.png", "Субтитры в SRT, обложка, ссылка .m3u8 и мини-плеер"),
        (5, "05-info.png", "Сведения о видео: кодек, fps, битрейт, размер файла"),
        (6, "06-progress.png", "Загрузка: прогресс, скорость и кнопка «Отменить»"),
        (7, "07-done.png", "Готово: файлы сохранены в папку «Загрузки»"),
        (8, "08-playlist.png", "Плейлист: очередь серий с паузой и диапазоном"),
        (9, "09-settings.png", "Настройки: качество, частота кадров, набор клавиш"),
    ]
    for pos, name, caption in shots:
        if pos in taken:
            continue
        path = ROOT / "docs/screenshots" / name
        r = call_until_ok(lambda p=pos, f=path: amo.call(
            "POST", f"/addons/addon/{amo.SLUG}/previews/", tk(),
            payload={"position": p}, files={"image": (f.name, f.read_bytes())}), f"скриншот {name}")
        if not r:
            return False
        time.sleep(5)
        amo.call("PATCH", f"/addons/addon/{amo.SLUG}/previews/{r['id']}/", tk(),
                 payload={"caption": {"ru": caption}, "position": pos})
        log(f"3/3 {name}: загружен")
        time.sleep(8)
    detail = amo.call("GET", f"/addons/addon/{amo.SLUG}/?lang=ru", tk())
    log(f"3/3 всего скриншотов: {len(detail.get('previews', []))}")
    return True


def all_done() -> bool:
    """Готово ли всё: политика верная, en-US есть, скриншотов 9."""
    try:
        d = amo.call("GET", f"/addons/addon/{amo.SLUG}/?lang=ru", tk())
        pol = amo.call("GET", f"/addons/addon/{amo.SLUG}/eula_policy/", tk())
    except SystemExit as e:
        log(f"проверка состояния: {str(e)[:160]}")
        return False
    locales = set((d.get("name") or {}).keys())
    shots = len(d.get("previews", []))
    policy_ok = (pol.get("privacy_policy") or {}).get("ru", "").strip() == PRIVACY["ru"].strip()
    return "en-US" in locales and shots >= 9 and policy_ok


def main() -> int:
    log("старт")
    if all_done():
        log("всё уже готово — правок не требуется")
        return 0
    ok1 = step_privacy()
    ok2 = step_metadata()
    ok3 = step_shots()
    d = amo.call("GET", f"/addons/addon/{amo.SLUG}/?lang=ru", tk())
    log(f"итог: политика={ok1}, локали={sorted((d.get('name') or {}).keys())}, "
        f"скриншотов={len(d.get('previews', []))}, статус={d.get('status')}, "
        f"поддержка={d.get('support_url')}")
    return 0 if (ok1 and ok2 and ok3) else 1


if __name__ == "__main__":
    sys.exit(main())
