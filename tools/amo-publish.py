#!/usr/bin/env python3
"""Публикация RuTube Tools в AMO через официальный API — без браузера и куки.

Нужны ключи API (JWT issuer + JWT secret) со страницы
https://addons.mozilla.org/en-US/developers/addon/api/key/

Использование:
    AMO_JWT_ISSUER=user:12345:67 AMO_JWT_SECRET=abcdef... \\
        python3 tools/amo-publish.py release/rutube-tools-firefox.zip

Скрипт: загружает xpi → ждёт валидацию → создаёт карточку с текстами из репозитория
и отправляет версию на проверку. Повторный запуск на уже созданном дополнении
загружает новую версию к существующему (по slug), а не создаёт второе.

Только стандартная библиотека: hmac, hashlib, json, urllib.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import sys
import time
import urllib.error
import urllib.request
import uuid as uuidlib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
API = "https://addons.mozilla.org/api/v5"
SLUG = "rutube-tools"
APP = "firefox"

NAME = {
    "ru": "RuTube Tools — кадры и MP4",
    "en-US": "RuTube Tools — frames & MP4",
}
SUMMARY = {
    "ru": "Скачивание видео и плейлистов RuTube в MP4, покадровая перемотка, кадры в PNG, субтитры и обложки.",
    "en-US": "Download RuTube videos and playlists to MP4, step frame by frame, save stills as PNG, subtitles and covers.",
}
HOMEPAGE = {"ru": "https://xxnetme.github.io/rutube-tools/"}
PRIVACY = "https://xxnetme.github.io/rutube-tools/privacy.html"

APPROVAL_NOTES = (
    "RuTube Tools adds a panel to the rutube.ru video player: save the video to MP4 "
    "(whole, a time-coded fragment, or a whole playlist), step frame by frame with the "
    "comma/period keys, save the current frame as PNG, and download subtitles/cover.\n\n"
    "No remote code. All scripts are bundled; eval and new Function are not used. "
    "mux.js (Apache-2.0) is included locally and listed in THIRD-PARTY-NOTICES.md.\n"
    "No network requests except to rutube.ru and its CDN (rtbcdn.ru, rtbcdn.net), "
    "made without cookies (credentials: omit).\n"
    "Data collection: none. Settings and playback position stay in storage.local.\n"
    "The extension does not bypass DRM or access restrictions; live streams and "
    "DRM-protected videos are explicitly unsupported.\n\n"
    "To test: open any public video on rutube.ru, for example "
    "https://rutube.ru/video/39d4c8e6e2ddf0828195dc3222418697/ — the panel appears in "
    "the lower right corner. Frame stepping: comma and period. The MP4 button opens "
    "the download panel."
)


def jwt(issuer: str, secret: str, ttl: int = 60) -> str:
    """HS256 JWT, как того требует AMO: iss = ключ, jti = секрет."""
    now = int(time.time())
    head = {"alg": "HS256", "typ": "JWT"}
    body = {"iss": issuer, "jti": secret, "iat": now, "exp": now + ttl}

    def seg(obj: dict) -> bytes:
        raw = json.dumps(obj, separators=(",", ":")).encode()
        return base64.urlsafe_b64encode(raw).rstrip(b"=")

    signing_input = seg(head) + b"." + seg(body)
    sig = hmac.new(secret.encode(), signing_input, hashlib.sha256).digest()
    return (signing_input + b"." + base64.urlsafe_b64encode(sig).rstrip(b"=")).decode()


def call(method: str, path: str, token: str, payload=None, files=None) -> dict:
    url = path if path.startswith("http") else API + path
    headers = {"Authorization": "JWT " + token, "Accept": "application/json"}
    data = None

    if files:
        boundary = "----amo" + uuidlib.uuid4().hex
        body = b""
        for name, (filename, content) in files.items():
            body += (
                f"--{boundary}\r\nContent-Disposition: form-data; "
                f'name="{name}"; filename="{filename}"\r\n'
                f"Content-Type: application/octet-stream\r\n\r\n"
            ).encode() + content + b"\r\n"
        for key, value in (payload or {}).items():
            body += (
                f"--{boundary}\r\nContent-Disposition: form-data; "
                f'name="{key}"\r\n\r\n{value}\r\n'
            ).encode()
        body += f"--{boundary}--\r\n".encode()
        data = body
        headers["Content-Type"] = f"multipart/form-data; boundary={boundary}"
    elif payload is not None:
        data = json.dumps(payload).encode()
        headers["Content-Type"] = "application/json"

    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            return json.loads(r.read().decode() or "{}")
    except urllib.error.HTTPError as e:
        detail = e.read().decode(errors="replace")
        raise SystemExit(f"{method} {url} → {e.code}\n{detail[:1500]}")


def find_existing(token: str) -> str | None:
    """Своё дополнение по slug: чтобы повторный запуск не создавал дубликат."""
    try:
        data = call("GET", f"/addons/addon/{SLUG}/?lang=ru", token)
        return data.get("guid") and SLUG
    except SystemExit:
        return None


def main() -> None:
    issuer = os.environ.get("AMO_JWT_ISSUER", "").strip()
    secret = os.environ.get("AMO_JWT_SECRET", "").strip()
    if not issuer or not secret:
        raise SystemExit(
            "нужны AMO_JWT_ISSUER и AMO_JWT_SECRET\n"
            "взять здесь: https://addons.mozilla.org/en-US/developers/addon/api/key/"
        )

    xpi = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "release/rutube-tools-firefox.zip"
    if not xpi.is_file():
        raise SystemExit(f"нет файла {xpi} — сначала python3 build.py")

    token = jwt(issuer, secret)
    print(f"файл: {xpi.name} ({xpi.stat().st_size / 1024:.1f} KB)")

    print("1/4 загрузка…")
    up = call("POST", "/addons/upload/", token,
              payload={"channel": "listed"},
              files={"upload": (xpi.name, xpi.read_bytes())})
    up_uuid = up.get("uuid")
    if not up_uuid:
        raise SystemExit(f"AMO не вернул uuid: {json.dumps(up, ensure_ascii=False)[:600]}")
    print(f"    uuid: {up_uuid}")

    print("2/4 валидация…")
    for attempt in range(60):
        time.sleep(3)
        st = call("GET", f"/addons/upload/{up_uuid}/", token)
        if not st.get("processed"):
            print(f"    … {attempt * 3 + 3} с")
            continue
        if not st.get("valid"):
            raise SystemExit("файл не прошёл проверку:\n" +
                             json.dumps(st.get("validation"), ensure_ascii=False, indent=1)[:2500])
        print("    файл валиден")
        break
    else:
        raise SystemExit("валидация не завершилась за 3 минуты — проверьте вручную")

    license_text = (ROOT / "LICENSE").read_text(encoding="utf-8")
    version_payload = {
        "upload": up_uuid,
        "license": {"name": {"ru": "MIT License", "en-US": "MIT License"},
                    "text": {"en-US": license_text, "ru": license_text},
                    "url": "https://github.com/xxnetme/rutube-tools/blob/main/LICENSE"},
        "release_notes": {"ru": "Подготовка к публикации в магазинах: постоянный gecko.id, "
                                "минимальный Firefox 140, убрано неиспользуемое разрешение.",
                          "en-US": "Store preparation: stable gecko.id, minimum Firefox 140, "
                                   "unused host permission removed."},
        "approval_notes": APPROVAL_NOTES,
    }

    existing = find_existing(token)
    if existing:
        print("3/4 дополнение уже есть — добавляю версию")
        res = call("POST", f"/addons/addon/{SLUG}/versions/", token, payload=version_payload)
        print("    версия:", res.get("version"), "| статус:", res.get("file", {}).get("status"))
    else:
        print("3/4 создаю карточку и отправляю на проверку")
        description = (ROOT / "docs/store/listing-ru.md").read_text(encoding="utf-8")
        # из markdown берём только раздел «AMO: описание простым текстом»
        marker = "## AMO: описание простым текстом (без HTML)"
        body = description.split(marker, 1)[1].split("\n## ", 1)[0].strip() if marker in description else ""
        res = call("POST", "/addons/addon/", token, payload={
            "slug": SLUG,
            "default_locale": "ru",
            "name": NAME,
            "summary": SUMMARY,
            "description": {"ru": body[:15000]} if body else None,
            "homepage": HOMEPAGE,
            "categories": {APP: ["photos-music-videos"]},
            "is_experimental": False,
            "requires_payment": False,
            "version": version_payload,
        })
        print("    статус:", res.get("status"), "| guid:", res.get("guid"))

    print("4/4 готово")
    print("   карточка: https://addons.mozilla.org/ru/firefox/addon/" + SLUG + "/")
    print("   кабинет:  https://addons.mozilla.org/ru/developers/addon/" + SLUG + "/")


if __name__ == "__main__":
    main()
