# Браузерный E2E

Сценарий поднимает **настоящие сборки расширения** в Firefox и Chromium, а не внедряет
content scripts вручную. На локальной имитации RuTube он открывает панель, запускает
скачивание и проверяет полученный файл через `ffprobe`: контейнер MP4, видео H.264,
звук AAC, ненулевые размер и длительность.

## Запуск

Нужны Node.js 22+, Python 3.12+, `ffmpeg`, `ffprobe` и `openssl`.

```bash
npm ci
npx playwright install --with-deps chromium firefox
python3 -m pip install -r tests/e2e/requirements.txt
npm run test:e2e
```

Только один браузер:

```bash
python3 tests/e2e/browser_e2e.py --browser chromium
python3 tests/e2e/browser_e2e.py --browser firefox
```

Свои сборки браузера можно задать через `CHROMIUM_BINARY` и `FIREFOX_BINARY`.

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
- `<browser>-failure.png` и `<browser>-page.txt` — диагностика при падении.

В GitHub Actions эти файлы прикладываются к job `browser-e2e`.
