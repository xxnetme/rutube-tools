#!/usr/bin/env python3
"""Сверяет номер версии во всех местах, где его видит человек.

Источник истины — src/manifest.firefox.json. Если в проверяемом файле встретится
другой номер вида x.y.z, шаг CI падает с указанием файла и строки.

Даты (29.10.2026) не считаются версиями: у них в последней части четыре цифры.
Строка, где старый номер уместен по смыслу (например, «в очереди на проверке
версия 1.3.2»), помечается комментарием `ver:prev` — такие строки пропускаются.

Запуск локально: python3 tools/check-versions.py
"""

import json
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
# без \b слева: номер часто стоит после буквы (v1.3.1), а это не граница слова.
# даты (29.10.2026) отсекаются четвёртой цифрой в последней части.
VERSION_RE = re.compile(r"(?<![\d.])\d{1,3}\.\d{1,3}\.\d{1,3}(?![\d.])")
EXEMPT = "ver:prev"

# Файлы, где номер версии — это текущее состояние, а не история.
def targets() -> list[pathlib.Path]:
    fixed = [
        "README.md",
        "docs/index.html",
        "docs/privacy.html",
        "docs/PRIVACY.md",
        "docs/PUBLISH.md",
        "docs/preview.html",
    ]
    files = [ROOT / f for f in fixed]
    files += sorted((ROOT / "assets").glob("*.svg"))
    files += sorted((ROOT / "docs/store").glob("*.md"))
    return files


def main() -> int:
    fx = json.loads((ROOT / "src/manifest.firefox.json").read_text(encoding="utf-8"))
    cr = json.loads((ROOT / "src/manifest.chromium.json").read_text(encoding="utf-8"))
    version = fx["version"]
    errors: list[str] = []

    if cr["version"] != version:
        errors.append(f"src/manifest.chromium.json: {cr['version']} ≠ Firefox {version}")

    changelog = (ROOT / "docs/CHANGELOG.md").read_text(encoding="utf-8")
    if not re.search(rf"^## {re.escape(version)}\b", changelog, re.M):
        errors.append(f"docs/CHANGELOG.md: нет раздела «## {version}»")

    checked = skipped = 0
    for path in targets():
        rel = path.relative_to(ROOT)
        for n, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            found = [v for v in VERSION_RE.findall(line) if v != version]
            if not found:
                continue
            if EXEMPT in line:
                skipped += len(found)
                continue
            for v in found:
                errors.append(f"{rel}:{n}: версия {v}, ожидается {version}")
            checked += 1

    # Манифесты внутри собранных пакетов, если сборка уже лежит рядом.
    for flavor in ("firefox", "chromium"):
        manifest = ROOT / "build" / f"rutube-tools-{flavor}" / "manifest.json"
        if manifest.exists():
            got = json.loads(manifest.read_text(encoding="utf-8"))["version"]
            if got != version:
                errors.append(f"build/{flavor}: {got} ≠ {version} (пересоберите: python3 build.py)")

    if errors:
        for e in errors:
            print(f"::error::{e}")
        print(f"\nрасхождений: {len(errors)}")
        return 1

    files = len([p for p in targets() if p.exists()])
    print(f"версия {version} согласована: манифесты, CHANGELOG, {files} файлов")
    if skipped:
        print(f"пропущено по метке {EXEMPT}: {skipped}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
