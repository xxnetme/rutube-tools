# Браузерный E2E

Сценарий поднимает **настоящие сборки расширения** в Firefox и Chromium, а не внедряет
content scripts вручную. На локальной имитации RuTube он открывает панель, запускает
скачивание и проверяет полученный файл через `ffprobe`: контейнер MP4, видео H.264,
звук AAC, ненулевые размер и длительность. В Chromium дополнительно открывается настоящий
popup: валидный и невалидный импорт настроек, отсутствие посторонних ключей и откат после
принудительной ошибки `storage.set`.

В обоих браузерах дополнительно проверяются настоящий `<video>` с HTTP Range: rVFC,
A/B preview с восстановлением исходной позиции, клавиатурные маркеры, focus trap и
переключение полных UK/BE-словарей через `storage.local`.

Отдельный production OPFS-сценарий (`opfs_e2e.py`) использует bundled `RTLib.downloadPart`:
докачка после abort со следующего сегмента без повторного запроса сохранённого, сброс
повреждённого индекса, memory fallback при отказе квоты, HEVC `hvcC` и AV1 `av1C`, а также
экспорт OPFS `File` через `downloads.download()` с последующим `ffprobe`.

## Запуск

Нужны Node.js 22+, Python 3.12+, `ffmpeg`, `ffprobe` и `openssl`.

```bash
npm ci
npx playwright install --with-deps chromium firefox
python3 -m pip install -r tests/e2e/requirements.txt
npm run test:e2e
npm run test:e2e:opfs
```

Только один браузер:

```bash
python3 tests/e2e/browser_e2e.py --browser chromium
python3 tests/e2e/browser_e2e.py --browser firefox
```

Свои сборки браузера можно задать через `CHROMIUM_BINARY` и `FIREFOX_BINARY`.
Для Chromium E2E читает полную версию из `binary --version` и скачивает официальный
Chrome for Testing driver той же версии, кешируя его в `~/.cache/rutube-tools/`.
Это исключает смешивание системного ChromeDriver 156 с Playwright Chromium 158 на
CI-runner: неявный driver из `PATH` не используется. Выбранные версии и путь выводятся
в лог; несовпадение полной версии останавливает тест до запуска сессии.

## Как контролируется сеть

Локальный HTTPS-сервер использует настоящие логические имена `rutube.ru` и CDN.
Браузер направляется через локальный CONNECT-прокси: разрешённые имена туннелируются
на стенд, остальные соединения отклоняются и проваливают сценарий. HTTPS-сервер
записывает каждый запрос API/master/media/segment; прокси записывает каждую попытку
соединения, включая фоновые обращения браузера. Тестовых исключений в `RTNetwork` нет.

Сертификат одноразовый и существует только внутри запуска. Настройки прокси и отключения
телеметрии применяются к отдельному тестовому профилю, не к браузеру пользователя.

## Артефакты

`tmp/e2e/` (игнорируется Git):

- `<browser>-report.json` — версия, результат, размер и вывод `ffprobe`;
- `<browser>-network.json` — все наблюдённые соединения и HTTP-запросы;
- `<browser>/*.mp4` — фактически скачанный файл;
- `<browser>-failure.png` и `<browser>-page.txt` — диагностика при падении;
- `tmp/opfs-production/<browser>-report.json` — resume/quota/index/codecs/export и сетевой журнал OPFS-сценария.

В GitHub Actions эти файлы прикладываются к job `browser-e2e`.
