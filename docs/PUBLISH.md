# Публикация RuTube Tools в Firefox (AMO) — пошагово

Файл для загрузки: **`release/rutube-tools-firefox.zip`**
(не `.xpi` — для первой публикации нужен именно zip исходной сборки).

---

## 0. Что уже готово в проекте

| Требование AMO | Где |
|---|---|
| Manifest V3 | `src/manifest.firefox.json` |
| Уникальный `gecko.id` | `rutube-tools@arena.ai` (можно оставить) |
| `data_collection_permissions` | `{ "required": ["none"] }` — обязательное поле для Firefox 140+ |
| Политика конфиденциальности | `docs/PRIVACY.md` |
| Скриншоты 1280×800 | `docs/screenshots/01…09` |
| Иконки карточки 300×300, 128×128, 64×64, 48×48, 32×32 | `docs/store/icon-*.png` |
| Тексты листинга (RU) | `docs/store/listing-ru.md` |
| Описание изменений | `docs/CHANGELOG.md` |
| Проверка «пустых» мест | расширение не грузит внешний код, `eval` не используется |

---

## 1. Проверьте перед публикацией (5 минут)

1. `python3 build.py` — пересобрать после любых правок.
2. Поставьте свежую сборку временно: `about:debugging` → «Загрузить временное дополнение…» →
   `build/rutube-tools-firefox/manifest.json`.
3. Откройте любое видео и проверьте: кнопка **MP4** видна, <kbd>,</kbd>/<kbd>.</kbd> листают кадры,
   загрузка 144p доходит до «Готово», файл открывается.
4. Замените в `docs/PRIVACY.md` строки «Автор / Issues» на свои контакты.
5. В `src/manifest.firefox.json` при желании поменяйте `gecko.id` (например,
   `rutube-tools@ваш-домен`) — **после первой публикации менять нельзя**.

---

## 2. Регистрация и загрузка

1. <https://addons.mozilla.org/developers/> → войти (можно через Firefox Account).
2. **Submit a New Add-on** → **Continue** (согласие с правилами).
3. **Upload a Manually Created Add-on** → выбрать `release/rutube-tools-firefox.zip`.
4. Дождитесь автоматической проверки (обычно 1–5 минут). Список замечаний будет на экране.

### Если проверка ругается

| Сообщение | Что делать |
|---|---|
| `Unsupported manifest key: data_collection_permissions` | Проверьте, что загружаете zip из папки `build/rutube-tools-firefox` (с `manifest.json` версии 1.3.0) |
| `manifest.json is not valid` | Убедитесь, что в zip нет вложенной папки: `manifest.json` должен лежать в корне |
| `uses eval / remote code` | В проекте нет `eval`; если предупреждение появилось — напишите в ревью, что mux.js собран локально |
| `Missing privacy policy` | Вставьте текст из `docs/PRIVACY.md` в поле Privacy Policy |

---

## 3. Заполнение карточки

Поля ниже — готовый текст из `docs/store/listing-ru.md`:

* **Name:** RuTube Tools — кадры и MP4
* **Summary:** Покадровая перемотка ( , и . ) и скачивание видео RuTube в MP4 прямо из плеера.
* **Category:** Other (или Video)
* **Tags:** rutube, video, download, mp4, player
* **Privacy Policy:** текст из `docs/PRIVACY.md` (в поле карточки вставляется краткая версия + ссылка)
* **Screenshots:** `01-frame-step.png`, `02-download.png`, `03-frames.png`, `04-more.png`, `05-info.png`, `06-progress.png`, `07-done.png`, `08-playlist.png`, `09-settings.png`
* **Icon:** `docs/store/icon-300.png`

---

## 4. Лицензия и права

* В карточке желательно указать лицензию (например, MIT) и приложить файл `LICENSE`.
* Убедитесь, что текст описания не обещает «скачивание любого видео» — DRM и эфиры не поддерживаются.
* Не используйте логотип RuTube в иконке расширения (чужие товарные знаки) — текущая иконка нейтральная.

---

## 5. Ревью и ответы

Модератор может задать вопросы — отвечайте в тот же день, это ускоряет публикацию.
Типичные вопросы и готовые ответы:

* **Зачем `downloads`?** Сохраняем собранный пользователем файл в «Загрузки».
* **Зачем доступ к CDN?** Чтобы скачать видеопоток, на который пользователь нажал «Скачать».
* **Почему `all_frames: true`?** Плеер RuTube может быть в iframe; клавиши должны работать, когда фокус в нём.
* **Собираете ли данные?** Нет — `data_collection_permissions: none`, аналитики нет.

---

## 6. После публикации

1. Скопируйте ссылку на страницу дополнения (например, `https://addons.mozilla.org/firefox/addon/rutube-tools/`).
2. Обновите `README.md` — вставьте её в раздел установки.
3. Для релиза **постоянной** версии себе и другим:
   * страница дополнения → **Manage** → *Upload New Version*;
   * или скачайте подписанный `.xpi` со страницы версии — он ставится в обычный Firefox без настроек.

### Автообновления (необязательно)

Если планируете раздавать `.xpi` со своего сайта, рядом положите `updates.json`:

```json
{
  "addons": {
    "rutube-tools@arena.ai": {
      "updates": [
        {
          "version": "1.1.0",
          "update_link": "https://ваш-сайт/rutube-tools-1.1.0.xpi"
        }
      ]
    }
  }
}
```

`update_link` должен вести на **подписанный** `.xpi`. В манифесте тогда указывают
`browser_specific_settings.gecko.update_url` — файл уже подготовлен: `docs/updates.example.json`.

---

## 7. Chrome Web Store (если понадобится)

1. <https://chrome.google.com/webstore/devconsole> → регистрация разработчика (разовый сбор $5).
2. **New item** → загрузить `release/rutube-tools-chromium.zip`.
3. Заполнить: описание, скриншоты (1280×800), иконка 128×128 (`src/icons/icon-128.png`),
   privacy policy (URL на текст из `docs/PRIVACY.md`).
4. В разделе **Permissions justification** коротко объяснить `storage`, `downloads`, `offscreen`, `host_permissions`.
5. Отправить на проверку (обычно 1–3 дня).
