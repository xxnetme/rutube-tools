#!/usr/bin/env python3
"""Сборка пакетов расширения RuTube Tools (Firefox / Chromium) — только стандартная библиотека."""
import json
import shutil
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SRC = ROOT / "src"
BUILD = ROOT / "build"
RELEASE = ROOT / "release"

FLAVORS = {
    "firefox": "manifest.firefox.json",
    "chromium": "manifest.chromium.json",
}

EXCLUDE_NAMES = {"manifest.firefox.json", "manifest.chromium.json"}

# файлы, нужные только одной сборке: offscreen — механизм Chromium, в Firefox мёртв
EXCLUDE_BY_FLAVOR = {
    "firefox": {"offscreen.html", "offscreen.js"},
    "chromium": set(),
}

REQUIRED = {"manifest.json", "background.js", "content-core.js", "content-panel.js",
            "lib/engine.js", "lib/i18n.js", "lib/mux-mp4.min.js", "popup.html", "popup.js"}
REQUIRED_BY_FLAVOR = {"chromium": {"offscreen.html", "offscreen.js"}}

# AMO/CWS не любят удалённый код и eval — проверяем свои файлы (кроме вендорного mux.js)
FORBIDDEN = ("eval(", "new Function(", "document.write(", "innerHTML = '<script'")


def collect_files(skip=frozenset()):
    for item in sorted(SRC.rglob("*")):
        if item.is_file() and item.name not in EXCLUDE_NAMES and item.name not in skip:
            yield item, item.relative_to(SRC)


def make_zip(target_dir: Path, zip_path: Path):
    """Упаковывает готовую папку (с manifest.json) в zip."""
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as z:
        for item in sorted(target_dir.rglob("*")):
            if item.is_file():
                z.write(item, item.relative_to(target_dir).as_posix())


def build_all():
    for d in (BUILD, RELEASE):
        if d.exists():
            shutil.rmtree(d)
        d.mkdir(parents=True)

    made = []
    for flavor, manifest in FLAVORS.items():
        # распакованная папка (для «Load unpacked» / «Load Temporary Add-on»)
        dest = BUILD / f"rutube-tools-{flavor}"
        dest.mkdir(parents=True)
        for item, rel in collect_files(EXCLUDE_BY_FLAVOR.get(flavor, frozenset())):
            target = dest / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(item, target)
        shutil.copy2(SRC / manifest, dest / "manifest.json")
        json.loads((dest / "manifest.json").read_text(encoding="utf-8"))  # валидация

        present = {f.relative_to(dest).as_posix() for f in dest.rglob("*") if f.is_file()}
        missing = (REQUIRED | REQUIRED_BY_FLAVOR.get(flavor, set())) - present
        if missing:
            raise SystemExit(f"{flavor}: в сборке нет файлов: {sorted(missing)}")

        own_js = [p for p in dest.rglob("*.js") if "mux" not in p.name]
        for f in own_js:
            text = f.read_text(encoding="utf-8")
            for bad in FORBIDDEN:
                if bad in text:
                    raise SystemExit(f"{flavor}: {f.relative_to(dest)} содержит «{bad}» — не пройдёт ревью")

        # архив собираем из готовой папки, чтобы manifest.json точно попал внутрь
        zip_path = RELEASE / f"rutube-tools-{flavor}.zip"
        make_zip(dest, zip_path)
        made.append(zip_path)

    # .xpi — это zip с манифестом; Firefox открывает его напрямую
    xpi = RELEASE / "rutube-tools-firefox.xpi"
    shutil.copy2(RELEASE / "rutube-tools-firefox.zip", xpi)
    made.append(xpi)

    for p in made:
        print(f"{p.relative_to(ROOT)!s:44s} {p.stat().st_size / 1024:7.1f} KB")
    return made


if __name__ == "__main__":
    try:
        build_all()
    except Exception as e:  # noqa: BLE001
        print("build failed:", e, file=sys.stderr)
        raise
