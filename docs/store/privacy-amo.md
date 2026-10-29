# Поле «Privacy Policy» в карточке AMO — готовый текст

Вставляется в кабинет: <https://addons.mozilla.org/ru/developers/addon/rutube-tools/> →
**Edit** → раздел **Privacy Policy** → выбрать язык (ru / en-US) → вставить текст → **Save**.

Это **не URL**: AMO хранит здесь текст и показывает его отдельной вкладкой на карточке.
Ссылка на оформленную страницу включена в сам текст — её можно скопировать.

---

## Русский (ru)

```
RuTube Tools не собирает, не хранит и не передаёт персональные данные.

Вся работа происходит в вашем браузере. Сохраняются только настройки расширения (качество, частота кадров, набор клавиш) и позиция просмотра — локально, в хранилище браузера. Наружу не уходит ничего, кроме запросов к самому RuTube и его CDN, откуда вы и так смотрите видео; cookie при этих запросах не передаются.

Нет аналитики, телеметрии, рекламы и трекеров. Нет собственных серверов. Нет доступа к другим сайтам: скрипт работает только на rutube.ru.

Полный текст: https://xxnetme.github.io/rutube-tools/privacy.html
```

## Английский (en-US)

```
RuTube Tools does not collect, store or transmit personal data.

Everything runs in your browser. Only extension settings (quality, frame rate, key set) and playback position are stored locally in browser storage. Nothing leaves your device except requests to RuTube and its CDN — the same servers that deliver the video you are watching; those requests are made without cookies.

No analytics, telemetry, ads or trackers. No own servers. No access to other sites: the content script runs on rutube.ru only.

Full text: https://xxnetme.github.io/rutube-tools/privacy.html
```

---

## Что важно знать про лимиты

| Действие | Лимит AMO | Симптом |
|---|---|---|
| Любая запись в карточку через API (PATCH) | суточный, общий на аккаунт | `429 … Expected available in 72000+ seconds` |
| Загрузка скриншотов через API | тот же суточный счётчик | `429` |
| Правки в веб-кабинете | **лимита нет** | — |

Вывод: через API укладывайте всё в один-два запроса за сутки. Если нужно больше правок —
делайте их руками в кабинете, там ограничений нет.

**Правило на будущее:** не отправлять в боевые поля пробные строки. Проверка «пройдёт / не пройдёт»
делается чтением (`GET`), а не записью (`PATCH`).
