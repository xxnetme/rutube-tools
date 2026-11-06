# OPFS: замеры и production-проверка

Дата: 06.11.2026. Статус: **Worker + OPFS интегрирован как явный opt-in** (`useOpfs: false`).
Старый memory/Blob-путь остаётся основным; включение OPFS не обещает снятие браузерных
ограничений размера или квоты.

## 1. Воспроизводимый изолированный замер

Стенд `tests/opfs/` создаёт детерминированные блоки, пишет их через
`FileSystemSyncAccessHandle` в Dedicated Worker, потоково читает и сверяет размер и CRC32
с независимым расчётом Python. RSS — сумма `VmRSS` дерева WebDriver и браузерных процессов,
а не точный размер данных. Каждый режим запускается в свежем браузере; это не статистически
надёжный усреднённый бенчмарк.

### 64 МиБ — первоначальный прототип

Источник: [`tests/opfs/results/2026-11-06-64mib.json`](../tests/opfs/results/2026-11-06-64mib.json).
Blob и OPFS прошли в Chromium 158 и Firefox 159; CRC32 — `ec1b524b`.

| Браузер | Путь | Полный цикл | Чтение + CRC32 | Пик ΔRSS |
|---|---|---:|---:|---:|
| Chromium | Blob | 381,9 мс | 274,0 мс | 117,2 МиБ |
| Chromium | OPFS | 343,8 мс | 235,2 мс | 97,2 МиБ |
| Firefox | Blob | 781,0 мс | 667,0 мс | 150,4 МиБ |
| Firefox | OPFS | 1028,0 мс | 901,0 мс | 110,0 МиБ |

На этом малом файле OPFS был быстрее в Chromium, но медленнее в Firefox. Поэтому один
выигрыш по памяти нельзя превращать в обещание универсального выигрыша по скорости.

### 2048 МиБ — большой прогон

Источники: [`Chromium OPFS`](../tests/opfs/results/2026-11-06-2048mib-chromium-opfs.json),
[`Firefox OPFS`](../tests/opfs/results/2026-11-06-2048mib-firefox-opfs.json),
[`Chromium Blob`](../tests/opfs/results/2026-11-06-2048mib-chromium-blob.json),
[`Firefox Blob`](../tests/opfs/results/2026-11-06-2048mib-firefox-blob.json).
Размер — 2 147 483 648 байт, блоки по 1 МиБ, CRC32 — `0719ec1a`.

| Браузер | Путь | Итог | Полный цикл | Пик ΔRSS | Очистка |
|---|---|---|---:|---:|---|
| Chromium 158.0.8127.18 | OPFS | **passed** | 13 881 мс | 93,2 МиБ | файл отсутствует, usage 0 |
| Firefox 159.0 | OPFS | **passed** | 41 317 мс | 124,6 МиБ | файл отсутствует, usage вернулся к baseline 491 520 |
| Chromium 158.0.8127.18 | Blob | **failed: tab crashed** | — | 544,3 МиБ до падения | не применимо |
| Firefox 159.0 | Blob | **failed: WebDriver read timeout** | — | 727,5 МиБ до таймаута | не применимо |

Blob-падения относятся к намеренно памятьнагружающему стенду, а не к утверждению, что каждый
Blob в браузере пользователя упадёт. OPFS-проходы подтверждают размер, CRC32 и очистку, но это
**ещё не полный 2-ГиБ HLS export** и не доказательство поведения на любом профиле.

Квота в этих свежих профилях: Chromium — 10 737 418 240 байт, Firefox — 2 618 198 835 байт.
В Firefox инициализация OPFS сама занимает 491 520 байт; после удаления usage возвращается
к этому baseline.

Воспроизведение:

```bash
npm ci
npx playwright install chromium firefox
python3 -m pip install -r tests/e2e/requirements.txt
python3 tests/opfs/opfs_bench.py --browser chromium --mode opfs --size-mib 2048 --timeout 600
python3 tests/opfs/opfs_bench.py --browser firefox --mode opfs --size-mib 2048 --timeout 600
# Для сравнения можно отдельно запустить --mode blob: на 2 ГиБ он может завершиться crash/timeout.
```

## 2. Production OPFS E2E

`tests/e2e/opfs_e2e.py` загружает **настоящие собранные расширения** и вызывает тот же
`RTLib.downloadPart`, который использует background/offscreen. Это не изолированный toy Worker:
сетевые segment URL проходят обычный allowlist и CONNECT-прокси.

В Chromium 158 и Firefox 159 пройдено:

- после abort на первом сегменте повторный запуск восстановил `nextSegment=1`; первый сегмент
  не был скачан повторно;
- malformed JSON index сброшен вместе с входным файлом, а не использован как валидный;
- детерминированный отказ preflight квоты перевёл загрузку в memory fallback; отдельный unit
  regression покрывает и `opfs-quota` во время записи output;
- OPFS `File` передан в `downloads.download()` без чтения всего файла в ArrayBuffer;
  полученные MP4 имеют 27 516 байт и проходят `ffprobe` (H.264 + AAC);
- bundled Media в browser realm собрал HEVC/AAC с `hvcC` и AV1/AAC с `av1C`.

Запуск: `npm run test:e2e:opfs`. Отчёты и сетевые журналы — `tmp/opfs-production/`.

## 3. Решение для 2.0.0

Большой замер подтвердил **применимость OPFS как opt-in и ценность для больших файлов**, но не
подтвердил безопасный universal default: малый файл в Firefox был медленнее, квота зависит от
профиля, а повторные полные 2-ГиБ HLS exports ещё не образуют достаточную серию измерений.

Поэтому критерий «OPFS по умолчанию» **явно пересмотрен**: в 2.0.0 основным остаётся проверенный
старый путь, OPFS можно включить в настройках. При недоступности API/квоты и при OPFS-ошибке
движок возвращается в memory fallback; `.ts` остаётся только фактическим fallback для потока,
который нельзя упаковать без перекодирования. Никакого обещания «потолка размера больше нет».
Следующее изменение default требует отдельной серии production-замеров и записанного решения.
