# Localization: English (en-US) для карточки AMO

Сейчас у дополнения заполнена только русская локаль, поэтому англоязычные пользователи видят
русский текст. Эти блоки добавляют `en-US` — карточка начнёт показываться по-английски тем,
у кого браузер английский.

Где вставлять: <https://addons.mozilla.org/ru/developers/addon/rutube-tools/> →
**Опишите дополнение** → **Правка** → вверху переключатель локали **«Локализовать на: English (US) · en-us»**.

---

## Name (до 50 символов)

```
RuTube Tools — frames & MP4
```

## Summary (до 250 символов)

```
Download RuTube videos and playlists to MP4, step through video frame by frame, save stills as PNG, grab subtitles and covers.
```

## Description

```
RuTube Tools adds to RuTube what it lacks: frame-by-frame stepping and saving video to MP4.

Frame by frame
— Comma steps back, period steps forward: the video pauses and the position snaps to exact frames, with the frame number and timecode shown in the panel.
— Angle brackets change speed from 0.25x to 2x.
— S saves the current frame as a PNG, with the timecode in the file name.
— Question mark shows the keyboard cheat sheet right on the page.
— Optionally, the full YouTube-style key set can be enabled in settings: Space/K, J/L, arrows, M, 0–9.

MP4 download
— The MP4 button in the lower right corner: 1080p, 720p, 480p and below.
— Fragment: from 12:30 to 12:45 — no need to download an hour for two minutes.
— Whole playlist: a queue on /plst/ pages with pause and episode range.
— Subtitles (.srt, including auto-generated), cover (.jpg), mini player, video details (codec, fps, bitrate).
— Segments are fetched in parallel and muxed into a regular MP4 inside the browser — no ffmpeg, no external programs.
— Progress, speed and a cancel button; the percentage is shown on the toolbar icon.
— Long videos are saved in parts of about 220 MB so the browser does not run out of memory.
— A copy .m3u8 link button for those who prefer a desktop player.

Honest limitations
— Live streams and DRM-protected videos are not supported.
— HEVC/AV1 tracks (rare) are saved as .ts and open in VLC.
— Download speed is limited by what RuTube serves.
— Videos blocked in your region cannot be downloaded: the extension does not bypass restrictions.

Privacy
No analytics, no ads, no trackers. The script runs on rutube.ru only and sends nothing anywhere except RuTube servers. Privacy policy: https://xxnetme.github.io/rutube-tools/privacy.html

Only download videos you have the right to download. The extension does not bypass DRM.
```

---

## Почему это стоит сделать

| Что даёт en-US | Эффект |
|---|---|
| Название и сводка | в поиске AMO по английским запросам (`video downloader`, `frame step`) карточка читаема |
| Описание | англоязычные пользователи не видят русский текст вместо описания |
| Тот же URL | отдельных карточек не создаётся, всё живёт на одной странице |

API позволяет задать локализацию сразу: `name`, `summary`, `description` принимают объект
вида `{"ru": "...", "en-US": "..."}`. Поскольку запись в карточку сейчас в суточном лимите,
быстрее вписать руками — блоки выше готовы к копированию.
