# Карточка дополнения — готовые тексты

## Name (до 50 символов)
RuTube Tools — кадры и MP4

## Summary (до 250 символов)
Расширение для RuTube: скачивание видео и плейлистов в MP4, покадровая перемотка, кадры в PNG, субтитры и обложки.

## Description (RU)

RuTube Tools добавляет в RuTube то, чего в нём не хватает: **покадровую перемотку** и **скачивание видео в MP4**.

**Покадрово**
• Клавиша «,» — кадр назад, «.» — кадр вперёд: видео ставится на паузу, позиция пересчитывается в точные кадры (внизу видно номер кадра и таймкод).
• <kbd>&lt;</kbd> и <kbd>&gt;</kbd> — скорость от 0.25× до 2×.
• <kbd>s</kbd> — сохранить текущий кадр в PNG (в имени файла таймкод).
• <kbd>?</kbd> — подсказка по клавишам прямо на странице.
• По желанию в настройках включается полный набор клавиш как на YouTube: Space/K, J/L, ←/→, M, 0–9.

**Скачивание в MP4**
• Кнопка «MP4» справа внизу страницы: выбираете качество — 1080p, 720p, 480p и ниже.
• **Фрагмент**: «с 12:30 по 12:45» — не нужно качать час ради двух минут.
• **Плейлист целиком**: очередь на странице /plst/… с паузой и диапазоном серий.
• Субтитры (.srt, включая авто), обложка (.jpg), мини-плеер, инфо о видео (кодек, fps, битрейт).
• Фрагменты видео загружаются параллельно и склеиваются в обычный MP4 прямо в браузере — без ffmpeg и сторонних программ.
• Прогресс, скорость, кнопка «Отменить»; процент виден прямо на иконке расширения.
• Длинное видео автоматически сохраняется частями (~220 МБ), чтобы браузер не «съел» память.
• Рядом есть кнопка «скопировать ссылку .m3u8» — для тех, кто качает плеером.

**Настройки**
Качество по умолчанию, частота кадров для покадрового шага (авто — из самого видео), размер частей, показ кнопки в плеере, набор клавиш.

**Честные ограничения**
• Прямые эфиры и видео с DRM не скачиваются.
• HEVC/AV1-дорожки (редко) сохраняются в формате .ts — открываются в VLC.
• Скорость ограничена отдачей RuTube.
• Видео, закрытые для вашего региона, не скачиваются — расширение не обходит ограничения.

**Приватность**
Никакой аналитики, рекламы и трекеров. Расширение работает только на rutube.ru и не отправляет данные никуда, кроме самих серверов RuTube.

> Скачивайте только те видео, на которые у вас есть право. Расширение не обходит DRM.

## AMO: описание простым текстом (без HTML)

RuTube Tools добавляет в RuTube то, чего в нём не хватает: покадровую перемотку и скачивание видео в MP4.

Покадрово
— «,» — кадр назад, «.» — кадр вперёд: видео ставится на паузу, позиция пересчитывается в точные кадры, внизу видно номер кадра и таймкод.
— «<» и «>» — скорость от 0.25× до 2×.
— «s» — сохранить текущий кадр в PNG, таймкод попадает в имя файла.
— «?» — подсказка по клавишам прямо на странице.
— По желанию в настройках включается полный набор клавиш как на YouTube: Space/K, J/L, стрелки, M, 0–9.

Скачивание в MP4
— Кнопка «MP4» справа внизу страницы: 1080p, 720p, 480p и ниже.
— Фрагмент: «с 12:30 по 12:45» — не нужно качать час ради двух минут.
— Плейлист целиком: очередь на странице /plst/… с паузой и диапазоном серий.
— Субтитры (.srt, включая авто), обложка (.jpg), мини-плеер, сведения о видео (кодек, fps, битрейт).
— Фрагменты загружаются параллельно и склеиваются в обычный MP4 прямо в браузере — без ffmpeg и сторонних программ.
— Прогресс, скорость, кнопка «Отменить»; процент виден на иконке расширения.
— Длинное видео сохраняется частями примерно по 220 МБ, чтобы браузер не исчерпал память.
— Кнопка «скопировать ссылку .m3u8» — для тех, кто качает плеером.

Честные ограничения
— Прямые эфиры и видео с DRM не скачиваются.
— Дорожки HEVC/AV1 (редко) сохраняются в .ts — открываются в VLC.
— Скорость ограничена отдачей RuTube.
— Видео, закрытые для вашего региона, не скачиваются: расширение не обходит ограничения.

Приватность
Ни аналитики, ни рекламы, ни трекеров. Скрипт работает только на rutube.ru и не отправляет данные никуда, кроме серверов RuTube. Политика конфиденциальности: https://xxnetme.github.io/rutube-tools/privacy.html

Скачивайте только те видео, на которые у вас есть право. Расширение не обходит DRM.

## Обоснование разрешений (для ревью Chrome Web Store / Edge)

Поле «Permission justification» в карточке заполняется по одному пункту на разрешение.

**storage** — хранит настройки пользователя (качество по умолчанию, частота кадров, набор клавиш) и позицию просмотра локально. Данные не покидают устройство.

**downloads** — единственный способ сохранить готовый MP4/PNG/SRT в папку «Загрузки». Файл собирается в браузере, наружу ничего не отправляется.

**offscreen** (только Chromium) — сборка файла из скачанных фрагментов требует URL.createObjectURL/Blob, которые недоступны в service worker. Скрытый документ используется только для этой операции.

**host_permissions: *://rutube.ru/*, *://*.rutube.ru/*, *://*.rtbcdn.ru/*, *://*.rtbcdn.net/* ** — расширение работает только на RuTube. Скрипт добавляет панель на страницу видео, читает идентификатор видео со страницы и запрашивает у RuTube данные о качествах. Медиафайлы загружаются с тех же CDN (rtbcdn), с которых их получает и сам плеер. Разрешения на другие сайты не запрашиваются.

**Удалённый код:** нет. Все скрипты входят в пакет, eval/new Function не используются; mux.js собран локально и указан в THIRD-PARTY-NOTICES.md.

**Единственное назначение:** скачивание видео и кадров с RuTube и покадровая навигация в плеере.

## Заметка ревьюеру (английский, вставляется в поле «Notes to reviewer»)

RuTube Tools is a Firefox/Chromium extension for rutube.ru, a Russian video hosting site. It adds two things to the player: frame-by-frame stepping and saving video to MP4.

- No remote code. All scripts are bundled; eval and new Function are not used. mux.js (Apache-2.0) is included locally and listed in THIRD-PARTY-NOTICES.md.
- No network requests to any server except rutube.ru and its CDN (rtbcdn.ru, rtbcdn.net). Requests are made without cookies (credentials: 'omit').
- Host permissions are limited to those domains. The extension does not read other sites.
- Data collection: none. Settings and playback position stay in storage.local.
- Saving works like this: the extension requests the HLS playlist the player already uses, downloads its segments, and muxes them into an MP4 inside the browser (offscreen document on Chromium, background page on Firefox). No server-side processing, no third-party service.
- DRM-protected and live streams are explicitly not supported, and the extension does not bypass any access restriction.
- To test: open any public video on rutube.ru, for example https://rutube.ru/video/39d4c8e6e2ddf0828195dc3222418697/ . The panel appears in the lower right corner. Frame stepping: comma and period keys. The MP4 button opens the download panel.

## Заметка ревьюеру для Microsoft Edge / Chrome (короткая)

Single purpose: download RuTube videos to MP4 and step through them frame by frame. No analytics, no remote code, no data collection; host access is limited to rutube.ru and its CDN. See the privacy policy URL for the full description.

## Tags
rutube, rutube downloader, mp4, video downloader, frame step, плеер, скачать видео, покадрово

## Категория
Video (или Other, если Video недоступна)

## «About this extension» / короткое описание для карточки
Кадр за кадром и MP4 в один клик — без сторонних программ, без рекламы, без сбора данных.

## Вариант для Chrome Web Store (до 132 символов)
Покадровая перемотка и скачивание видео RuTube в MP4 прямо из плеера.
