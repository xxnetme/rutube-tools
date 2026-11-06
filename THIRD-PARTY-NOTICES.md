# Сторонние компоненты

| Компонент | Файл | Лицензия |
|---|---|---|
| [mux.js](https://github.com/videojs/mux.js) 7.1.0 | `src/lib/mux-mp4.min.js` | Apache License 2.0 |
| [Mediabunny](https://mediabunny.dev/) 1.65.2 | `src/lib/media.min.js` | Mozilla Public License 2.0 |
| DejaVu Sans (только для генерации изображений) | — | Bitstream Vera / DejaVu |

Полные тексты лицензий: [`src/lib/mux.js.LICENSE`](src/lib/mux.js.LICENSE) и
[`src/lib/mediabunny.LICENSE`](src/lib/mediabunny.LICENSE). Mediabunny собирается локально через
esbuild в автономный bundle; runtime не загружает код из CDN.

Остальной runtime-код — движок HLS, OPFS Worker, интерфейс и локализация — находится в этом
репозитории. esbuild и тестовые зависимости используются только при разработке и не являются
отдельными runtime-библиотеками расширения.
