<div align="center">

<img src="assets/banner.png" alt="RuTube Tools" width="100%">

# RuTube Tools

**Покадровая перемотка · кадры в PNG · скачивание в MP4 — прямо в плеере RuTube**

[![Version](https://img.shields.io/badge/version-1.3.0-ff3b3b?style=flat-square)](docs/CHANGELOG.md)
[![Firefox](https://img.shields.io/badge/Firefox-115%2B-ff7139?style=flat-square&logo=firefoxbrowser&logoColor=white)](#установка)
[![Chromium](https://img.shields.io/badge/Chrome%20%2F%20Edge-MV3-4285f4?style=flat-square&logo=googlechrome&logoColor=white)](#установка)
[![Manifest](https://img.shields.io/badge/Manifest-V3-2ea44f?style=flat-square)](#структура)
[![License](https://img.shields.io/badge/license-MIT-2ea44f?style=flat-square)](LICENSE)
[![Без рекламы и трекеров](https://img.shields.io/badge/без%20рекламы%20и%20трекеров-8957e5?style=flat-square)](#приватность)

**[Сайт расширения ↗](https://xxnetme.github.io/rutube-tools/)** · [Возможности](#возможности) · [Установка](#установка) · [Клавиши](#клавиши) · [Как это работает](#как-это-работает) · [Ограничения](#ограничения) · [Разработка](#разработка)

</div>

<img src="assets/features.png" alt="Возможности" width="100%">

---

## Что это

Расширение, которое добавляет в RuTube то, чего в нём нет: **покадровую перемотку** как в
видеоредакторе, **сохранение кадра в PNG** и **скачивание в MP4** — целиком, фрагментом
или целым плейлистом. Всё работает локально в браузере: без сторонних программ, без ffmpeg,
без рекламы и без сбора данных.

<div align="center">

<img src="assets/preview-ui.png" alt="Интерфейс расширения" width="100%">

|  |  |
|---|---|
| <img src="docs/screenshots/01-frame-step.png" width="440"><br><sub>Покадрово: «Кадр 127 · 0:05.08 · 25 fps»</sub> | <img src="docs/screenshots/02-download.png" width="440"><br><sub>Выбор качества, фрагмент, MP4</sub> |
| <img src="docs/screenshots/03-frames.png" width="440"><br><sub>A/B-петля, переход на кадр, раскадровка</sub> | <img src="docs/screenshots/06-progress.png" width="440"><br><sub>Прогресс со скоростью и зеркалом CDN</sub> |

</div>

---

## Возможности

### 🎬 Вкладка «Скачать»

| | |
|---|---|
| **Весь ролик в MP4** | 1080p…144p, фрагменты потока качаются параллельно и склеиваются в обычный MP4 **прямо в браузере** |
| **Фрагмент** | «с 12:30 по 12:45» — не нужно качать час ради двух минут; кнопка ⏱ берёт время из плеера, фактические границы показываются заранее |
| **Плейлист** | на `/plst/…` — очередь с **паузой**, диапазоном серий и отчётом об ошибках |
| **Зеркала CDN** | RuTube отдаёт каждый уровень качества с двух серверов — при обрыве расширение само перечитывает плейлист с зеркала |
| **Длинные файлы** | авторазбиение по ~220 МБ: `… — 1/3.mp4` |
| **После сбоя** | «Повторить загрузку» + «Скопировать диагностику» для письма в поддержку |
| **Прогресс** | процент, фрагменты, мегабайты, скорость — и процент на иконке расширения |

### 🖼️ Вкладка «Кадры»

- <kbd>,</kbd> / <kbd>.</kbd> — кадр назад / вперёд, с точным таймкодом и номером кадра
- <kbd>s</kbd> — сохранить кадр в **PNG** (имя файла содержит таймкод)
- **Перейти на кадр №** — точный переход по номеру
- **A/B-петля** — отметить начало и конец, повторять фрагмент
- **Раскадровка** — серия PNG через заданный интервал (до 120 кадров)
- сохранение тона голоса при ускорении

### 💬 Вкладка «Ещё»

**Субтитры** (.srt, включая авто-субтитры RuTube) · **Обложка** (.jpg) ·
**Главы** — переход и копирование текстом · **Мини-плеер (PiP)** · ссылка `.m3u8`

### 📊 Вкладка «Инфо»

Кодек, fps, битрейт, доступные качества, оценка размера, просмотры, дата публикации,
автор — и «Скопировать как текст».

---

## Установка

### Firefox

```text
about:debugging#/runtime/this-firefox → «Загрузить временное дополнение…» → rutube-tools-firefox.xpi
```

Готовый файл: **[rutube-tools-firefox.xpi](https://github.com/xxnetme/rutube-tools/releases/latest/download/rutube-tools-firefox.xpi)** · постоянная установка — после
публикации на addons.mozilla.org (инструкция: [`docs/PUBLISH.md`](docs/PUBLISH.md)).

### Chrome / Edge / Яндекс.Браузер

```text
1. распаковать rutube-tools-chromium.zip в папку
2. chrome://extensions → «Режим разработчика» → «Загрузить распакованное» → выбрать эту папку
```

Сборка: **[rutube-tools-chromium.zip](https://github.com/xxnetme/rutube-tools/releases/latest/download/rutube-tools-chromium.zip)** · в Chromium сборка MP4 идёт
в offscreen-документе, потому что служебный скрипт не умеет `URL.createObjectURL`.

### Из исходников

```bash
git clone https://github.com/xxnetme/rutube-tools.git
cd rutube-tools
python3 build.py           # соберёт build/ и release/, заодно проверит манифест и отсутствие eval
```

Нужен только Python 3 — никаких npm-зависимостей.

---

## Клавиши

| Клавиша | Действие |
|---|---|
| <kbd>,</kbd> <kbd>.</kbd> | кадр назад / кадр вперёд |
| <kbd>&lt;</kbd> <kbd>&gt;</kbd> | скорость − / + (0.25× … 2×) |
| <kbd>s</kbd> | сохранить кадр в PNG |
| <kbd>p</kbd> | мини-плеер (PiP) |
| <kbd>?</kbd> | подсказка на странице |

Полный набор «как на YouTube» включается в настройках:
<kbd>Space</kbd>/<kbd>K</kbd> — пауза, <kbd>J</kbd>/<kbd>L</kbd> — ±10 с, <kbd>←</kbd>/<kbd>→</kbd> — ±5 с,
<kbd>↑</kbd>/<kbd>↓</kbd> — громкость, <kbd>M</kbd> — звук, <kbd>0</kbd>–<kbd>9</kbd> — переход по %.
Клавиши кадров и кадра PNG переназначаются.

---

## Как это работает

```text
URL видео
   │
   ├─→ rutube.ru/api/play/options/<id>/     список качеств + длительность + субтитры + обложка
   │        └─→ master.m3u8 (HLS)           каждое качество × 2 зеркала CDN
   │                 └─→ media.m3u8         фрагменты по 2–4 с
   │
   ├─→ параллельная загрузка (5 потоков, повторы, смена зеркала)
   │
   └─→ mux.js: MPEG-TS → fMP4  ──→  Blob  ──→  downloads.download()
                                        │
                                   Firefox: фоновая страница
                                   Chromium: offscreen-документ (в SW нет createObjectURL)
```

* **Без перекодирования** — файл скачивается в выбранном качестве как есть.
* **Без сервера** — всё в браузере, данные не покидают вашу машину.
* **Фрагменты по порядку** — даже при параллельной загрузке в муксер они попадают строго по очереди,
  поэтому MP4 получается валидным (проверено `ffprobe`).

---

## Ограничения

| Что | Поведение |
|---|---|
| 🔴 Прямые эфиры | не скачиваются — кнопка честно сообщит |
| 🔒 DRM-видео | не скачиваются |
| 🎞️ HEVC / AV1 | сохраняются как `.ts` (открывается в VLC) |
| 🌍 Гео-блокировка RuTube | не обходится |
| 🎧 Только звук (M4A) | в планах: mux.js всегда собирает обе дорожки |
| 🐢 Скорость | ограничена отдачей CDN RuTube |
| 🖼️ Кадр в PNG | если браузер запрещает чтение видеопотока, кадр сохранить нельзя — расширение скажет об этом |

---

## Приватность

- **Ноль** аналитики, телеметрии, рекламы и трекеров.
- Работает только на `rutube.ru`, запросы идут только к RuTube и его CDN, **без cookie** (`credentials: 'omit'`).
- Настройки и позиция просмотра — в `storage.local`, на устройстве.
- В манифесте: `data_collection_permissions: none`.
- Подробно: [`docs/PRIVACY.md`](docs/PRIVACY.md)

---

## Структура

```text
rutube-tools/
├── src/
│   ├── manifest.firefox.json    # MV3 · background.scripts + data_collection_permissions
│   ├── manifest.chromium.json   # MV3 · service_worker + offscreen
│   ├── background.js            # загрузки, очередь, обрезка, зеркала, диагностика
│   ├── content-core.js          # кнопка, вкладки, клавиши, кадры, A/B, PiP, позиция
│   ├── content-panel.js         # панель: Скачать / Кадры / Ещё / Инфо
│   ├── lib/engine.js            # HLS-парсер, диапазоны, плейлисты, склейка
│   ├── lib/i18n.js              # RU / EN
│   ├── lib/mux-mp4.min.js       # mux.js (Apache-2.0)
│   ├── popup.html · popup.js    # настройки
│   └── offscreen.html · .js     # сборка MP4/blob для Chromium
├── build.py                     # сборка + проверки (только stdlib)
├── docs/                        # PUBLISH · PRIVACY · CHANGELOG · FEATURES · скриншоты · лендинг
├── assets/                      # баннер, обложка, превью интерфейса
├── build/ · release/            # создаются build.py (в git их нет)
└── .github/workflows/           # checks (синтаксис + сборка) и release (по тегу v*)
```

---

## Разработка

```bash
python3 build.py     # сборка + проверка обязательных файлов, манифеста, отсутствия eval
```

Перед PR: соберите и проверьте на реальном видео — расширение тестируется руками
на живом RuTube (см. раздел «Тесты» в [`docs/CHANGELOG.md`](docs/CHANGELOG.md)).

<table>
<tr><td><b>Проверено на живом RuTube</b></td></tr>
<tr><td>

- Полное видео 16:43 → MP4 20,9 МБ, `ffmpeg` декодирует без ошибок
- Фрагмент 1:40–2:10 → файл ровно 32,15 с, старт со 100-й секунды
- Плейлист из 2 видео → 2 валидных файла (45,4 + 42,2 МБ)
- Субтитры .SRT (41 КБ) и обложка .jpg — сохранены из Firefox
- PNG-кадры и раскадровка, A/B-петля не выходит за границы
- RU/EN переключение на лету, консоль чистая

</td></tr>
</table>

---

## Планы

См. [`docs/FEATURES.md`](docs/FEATURES.md) — там разобраны следующие шаги с оценками:
только звук (M4A), запись эфира, докачка после перезапуска, экспорт глав.

## Лицензия

Код — [MIT](LICENSE). Сторонние компоненты — [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)
(встроенный mux.js — Apache 2.0).

> Расширение не обходит DRM и не скачивает закрытые видео.
> Скачивайте только то, на что у вас есть право.

<div align="center"><sub>Сделано с ❤️ для тех, кому нужен кадр, а не «примерно вот тут»</sub></div>
