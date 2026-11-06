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
Download RuTube videos and playlists to MP4, audio to M4A, step through video frame by frame, save stills as PNG, grab subtitles and covers.
```

## Description

```
RuTube Tools adds to RuTube what it lacks: frame-by-frame stepping and saving video to MP4.

Frame by frame
— Comma steps back, period steps forward: the video pauses and the position snaps to exact frames, with the frame number and timecode shown in the panel.
— A/B markers with previews and requestVideoFrameCallback; VFR shows an honest time step instead of a fabricated absolute frame number. Playback speed is remembered per videoId.
— Angle brackets change speed from 0.25x to 2x.
— S saves the current frame as a PNG, with the timecode in the file name.
— Question mark shows the keyboard cheat sheet right on the page.
— Optionally, the full YouTube-style key set can be enabled in settings: Space/K, J/L, arrows, M, 0–9.

MP4 download
— The MP4 button in the lower right corner: 1080p, 720p, 480p and below.
— Fragment: from 12:30 to 12:45 — no need to download an hour for two minutes.
— Playlist by checkboxes: tick the episodes you need on /plst/ pages — titles and durations in the list, a live counter, All and None buttons, and a queue with pause.
— One-click subtitles: the .srt lands next to the video under the same name, so players pick it up by themselves.
— Audio only (M4A): the lightest stream is fetched and its AAC is saved without re-encoding; cover, artist, album and track number go into the tags, so a playlist arrives sorted in any player.
— Saved files: the extension popup keeps the last 30 downloads with a Show file button that opens the folder.
— File name template: {author} — {title} [{quality}], a subfolder per playlist, date in the name.
— Cover (.jpg), mini player, video details (codec, fps, bitrate).
— Segments are fetched in parallel and muxed into a regular MP4 inside the browser — no ffmpeg, no external programs.
— Progress, speed and a cancel button; the percentage is shown on the toolbar icon.
— Long videos are saved in parts of about 220 MB so the browser does not run out of memory.
— A copy .m3u8 link button for those who prefer a desktop player.

Honest limitations
— Live streams and DRM-protected videos are not supported.
— HEVC/AV1 tracks are first copied into fMP4 without re-encoding; if a particular container cannot be read (for example AV1 in MPEG-TS), the original .ts is saved for VLC.
— OPFS is opt-in: segment-level resume, cleanup and memory fallback on quota errors; the proven legacy path remains the default.
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
