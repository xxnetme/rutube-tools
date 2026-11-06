# Протокол `rt:*`, версия 2

Схема заморожена для линейки 2.0. Изменения полей допускаются только обратно
совместимым добавлением необязательного поля; удаление или изменение смысла поля —
новая мажорная версия протокола. Список типов дублируется в `src/lib/protocol.js` и
проверяется `tests/protocol.test.js`.

## Конверт и совместимость

Каждое новое сообщение имеет `{ type: "rt:…", v: 2 }`. Сообщения 1.x без `v`
принимаются в режиме совместимости. Сообщение с другой версией или неизвестным
`type` не исполняется и получает `{ ok: false, error: "protocol-version" }` там,
где протокол предусматривает ответ. Поле `v` не сохраняется в очереди и не
передаётся в сетевые запросы.

`jobId` связывает активную задачу; `pendingId` — запись восстановления. Ошибки
содержат стабильный `error`/код и необязательный человекочитаемый `detail`.
Текст ошибок не является частью машинной схемы.

## Сообщения

| Тип | Направление | Обязательные данные | Необязательные данные / результат |
|---|---|---|---|
| `rt:info` | content → background | `videoId` | `withMeta`; ответ `ok, info` |
| `rt:playlist-info` | content → background | `playlistId` | ответ `ok, playlist` |
| `rt:playlist-videos` | content → background | `playlistId` | `offset, limit`; ответ `ok, videos` |
| `rt:start` | content → background | `videoId` | `height, audio, from, to, maxPartMB, opfs, nameTemplate, subsUrl, subsExt`; ответ `ok, jobId` |
| `rt:start-playlist` | content → background | `playlistId` | `height, audio, fromIndex, toIndex, indices, maxPartMB, opfs, delayMs, nameTemplate`; ответ `ok, jobId` |
| `rt:progress` | background → content | `phase, jobId` | `percent, done, total, bytes, part, parts, mode, files, downloadIds, queue, pendingId, error, detail` |
| `rt:cancel` | content/popup → background | `jobId` | ответ `ok` |
| `rt:pause` | content/popup → background | `jobId` | ответ `ok, paused` |
| `rt:resume` | popup → background | `jobId` | ответ `ok` |
| `rt:keepalive` | content → background | — | ответ `ok` |
| `rt:pending-list` | popup → background | — | ответ `ok, items` |
| `rt:pending-resume` | popup → background | `id` | ответ `ok, jobId` |
| `rt:pending-discard` | popup → background | `id` | ответ `ok` |
| `rt:history-list` | popup → background | — | ответ `ok, items` |
| `rt:history-clear` | popup → background | — | ответ `ok` |
| `rt:show-download` | popup → background | `id` | ответ `ok` |
| `rt:save-url` | content → background | `url, filename` | ответ `ok, name, id` |
| `rt:save-vtt` | content → background | `url, filename` | ответ `ok, name, id` |
| `rt:save-data-url` | content → background | `dataUrl, filename` | ответ `ok, name, id` |
| `rt:diagnostics` | content → background | — | ответ `ok, diag` |
| `rt:ping` | diagnostic → background | — | ответ `ok` |
| `rt:offscreen-run` | background → offscreen | `cfg.runId, cfg.segments, cfg.mode` | `cfg` также содержит `expectedDurationSec, expectedBytes, resumeKey, fingerprint, opfs, pendingId`; ответ `ok, url, ext` |
| `rt:offscreen-progress` | offscreen → background | `runId` | `done, total, percent, bytes` |
| `rt:offscreen-segment` | offscreen → background | `pendingId` | `key, nextSegment, bytes, reset` |
| `rt:offscreen-storage` | offscreen → background | `pendingId` | `storage.state, storage.reason` |
| `rt:offscreen-cancel` | background → offscreen | `runId` | ответ `ok` |
| `rt:offscreen-cleanup` | background → offscreen | `key` | ответ `ok` |
| `rt:offscreen-data-url` | background → offscreen | `dataUrl` | ответ `ok, url` |
| `rt:offscreen-ping` | background → offscreen | — | ответ `ok` |

## Состояние и файлы

- `settingsSchemaVersion = 2`; настройки — только allowlist из `RTSettings`.
- `rtPending` — записи докачки, включая `nextPart`, `nextSegment`, `segmentBytes`,
  `segmentKey`, `storage` и `opfs`; очередь и история не входят в backup настроек.
- `rtPlaybackRates` — не более 50 записей `{ rate, at }` по `videoId`.
- `pos:<videoId>` — позиция просмотра в секундах.
- OPFS-индекс имеет собственную `version = 1`, `key`, `fingerprint`, `total`,
  `nextSegment`, `bytes`; повреждённый или несовпадающий индекс удаляется вместе с
  незавершённым входом, а не используется как источник истины.

Схема не разрешает произвольные URL, HTML или выполнение кода. Все медиа-URL
проходят сетевой allowlist независимо от версии протокола.
