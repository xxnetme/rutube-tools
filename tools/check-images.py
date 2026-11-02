#!/usr/bin/env python3
"""Сверяет размеры картинок в разметке с реальными файлами.

Зачем: один из кадров галереи однажды был объявлен как 1280x800, а лежал 344x901.
Браузер доверяет атрибутам и оставляет место под заявленный размер, поэтому
лента скриншотов прыгала на полторы тысячи пикселей при прокрутке.

Проверяем три вещи для каждой локальной картинки в docs/*.html:
  * файл существует;
  * width и height заданы (иначе до загрузки картинки место не зарезервировано);
  * объявленные значения совпадают с настоящими.

Запуск: python3 tools/check-images.py
"""

import pathlib
import re
import sys

from PIL import Image

ROOT = pathlib.Path(__file__).resolve().parent.parent
PAGES = ("docs/index.html", "docs/preview.html", "docs/privacy.html")
IMG_RE = re.compile(r"<img\b[^>]*>", re.I)


def attr(tag: str, name: str) -> str | None:
    m = re.search(rf'\b{name}\s*=\s*"([^"]*)"', tag)
    return m.group(1) if m else None


def main() -> int:
    errors: list[str] = []
    checked = 0

    for page in PAGES:
        path = ROOT / page
        if not path.exists():
            continue
        html = path.read_text(encoding="utf-8")
        for tag in IMG_RE.findall(html):
            src = attr(tag, "src") or ""
            if not src or src.startswith(("http://", "https://", "data:")):
                continue
            src_clean = src.split("?")[0]
            target = (ROOT / "docs" / src_clean).resolve()
            if not target.exists():
                errors.append(f"{page}: нет файла {src_clean}")
                continue
            w, h = attr(tag, "width"), attr(tag, "height")
            real = Image.open(target).size
            if not (w and h):
                errors.append(f"{page}: у {src_clean} нет width/height — будет сдвиг при загрузке")
                continue
            if (int(w), int(h)) != real:
                errors.append(
                    f"{page}: {src_clean} объявлен {w}x{h}, а файл {real[0]}x{real[1]}"
                )
            checked += 1

    if errors:
        for e in errors:
            print(f"::error::{e}")
        print(f"\nпроблем: {len(errors)}")
        return 1

    print(f"картинки в порядке: {checked} шт. — размеры в разметке совпадают с файлами")
    return 0


if __name__ == "__main__":
    sys.exit(main())
