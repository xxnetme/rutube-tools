# OPFS / Blob prototype

Изолированный стенд для проверки 1.12. Он **не входит в сборку расширения** и сам по себе
не переключает реальные загрузки на OPFS. Production-путь с opt-in проверяется отдельным
`tests/e2e/opfs_e2e.py`; результаты и решение о default — в `docs/OPFS-PROTOTYPE.md`.

Worker создаёт детерминированные блоки и либо удерживает их для итогового `Blob`,
либо последовательно пишет через `FileSystemSyncAccessHandle`. Затем файл/ Blob читается
потоково; размер и CRC32 должны совпасть с независимо рассчитанным Python-значением.
OPFS-файл удаляется, его отсутствие проверяется отдельно.

## Запуск

```bash
npm ci
npx playwright install --with-deps chromium firefox
python3 -m pip install -r tests/e2e/requirements.txt
npm run bench:opfs
```

По умолчанию: 64 МиБ, блоки по 1 МиБ, четыре запуска — Blob и OPFS в свежих
Chromium и Firefox. Другой размер или один браузер:

```bash
python3 tests/opfs/opfs_bench.py --browser chromium --size-mib 256
```

`CHROMIUM_BINARY` и `FIREFOX_BINARY` позволяют задать свои исполняемые файлы.
Отчёт и диагностика: `tmp/opfs/` (игнорируется Git).

## Что означают метрики

- `generate`, `writeOrRetain`, `finalize`, `readAndVerify` — отдельные фазы внутри Worker;
- `peakDeltaKiB` — максимум суммарного Linux `VmRSS` дерева WebDriver и браузерных
  процессов относительно страницы до запуска, сэмплы каждые 100 мс;
- `storageBefore/AfterWrite/AfterCleanup` — `navigator.storage.estimate()`;
- `opfsCleanupAfter500ms` — отсутствие файла и usage ещё через 500 мс.

RSS **не является** точным размером Blob или OPFS и зависит от JIT, процессов и момента
сэмплирования. Абсолютный RSS разных браузеров не сравнивается. Один прогон на 64 МиБ
не доказывает поведение на 2 ГиБ. Стенд также не проверяет передачу OPFS в `downloads.download()`:
это отдельный архитектурный вопрос для 1.12.

Предварительные измерения и выводы: [docs/OPFS-PROTOTYPE.md](../../docs/OPFS-PROTOTYPE.md).
Для production resume/quota/corrupt-index/HEVC/AV1/export используйте `npm run test:e2e:opfs`.
