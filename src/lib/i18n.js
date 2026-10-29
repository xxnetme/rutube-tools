/*!
 * RuTube Tools — мини-локализация RU/EN без внешних зависимостей.
 * Использование: RTI18n.setLang('auto'|'ru'|'en'); RTI18n.t('key', {n: 5})
 */
(function (global) {
  'use strict';

  var RU = {
    /* вкладки и панель */
    'tab.download': 'Скачать',
    'tab.frames': 'Кадры',
    'tab.more': 'Ещё',
    'tab.info': 'Инфо',
    'tab.playlist': 'Плейлист',
    'panel.loading': 'Загружаю список качеств…',
    'panel.close': 'Закрыть',
    'panel.retry': 'Повторить',
    'panel.retryDownload': 'Повторить загрузку',
    'panel.copyDiag': 'Скопировать диагностику',
    'panel.best': 'лучшее',

    /* скачивание */
    'dl.modeFull': 'Весь ролик',
    'dl.modePart': 'Фрагмент',
    'dl.from': 'с',
    'dl.to': 'по',
    'dl.fromPlayer': 'взять из плеера',
    'dl.start': 'Скачать MP4',
    'dl.startPart': 'Скачать фрагмент',
    'dl.copyLink': 'Скопировать ссылку .m3u8',
    'dl.duration': 'Длительность',
    'dl.mergeHint': 'видео склеивается в MP4 прямо в браузере',
    'dl.partsHint': 'Крупный файл будет разбит на части по {n} МБ',
    'dl.boundaries': 'Фактически: {from} – {to} (точность — фрагмент 2–4 с)',
    'dl.cancel': 'Отменить',
    'dl.pause': 'Пауза',
    'dl.resume': 'Продолжить',
    'dl.phase.meta': 'Получаю данные видео…',
    'dl.phase.playlist': 'Читаю плейлист…',
    'dl.phase.parts': 'Начинаю загрузку…',
    'dl.phase.save': 'Сохраняю файл…',
    'dl.downloading': 'Скачиваю часть {part} из {parts}',
    'dl.downloadingOne': 'Скачиваю…',
    'dl.segments': '{done} / {total} фрагм.',
    'dl.done': 'Готово',
    'dl.doneSaved': 'Файл сохранён в «Загрузки»:',
    'dl.doneTs': ' (поток .ts — открывается в VLC)',
    'dl.showFile': 'Показать файл',
    'dl.frameHint': 'Кадр текущего момента — клавиша {key}',
    'dl.again': 'Скачать ещё',

    /* ошибки */
    'err.live': 'Это прямой эфир — скачивание недоступно.',
    'err.drm': 'Видео защищено DRM — скачать его нельзя.',
    'err.emptyRange': 'Фрагмент нулевой длины: проверьте время «с» и «по».',
    'err.download': 'Не удалось скачать видео.',
    'err.playlist': 'Не удалось скачать плейлист.',
    'err.info': 'Не удалось получить данные видео.',
    'err.cancelled': 'Загрузка отменена',
    'err.start': 'Не удалось начать загрузку',

    /* плейлист */
    'pl.loading': 'Читаю плейлист…',
    'pl.count': 'Видео в плейлисте: {n}',
    'pl.range': 'Серии',
    'pl.from': 'с №',
    'pl.to': 'по №',
    'pl.start': 'Скачать плейлист',
    'pl.item': 'Видео {i} из {n}',
    'pl.done': 'Плейлист готов: сохранено файлов — {ok}',
    'pl.failed': 'Не удалось скачать: {n}',
    'pl.empty': 'В плейлисте нет видео',
    'pl.delay': 'Пауза между видео: {s} с',
    'pl.savedCount': 'готово {n}',

    /* кадры */
    'fr.save': 'Сохранить кадр в PNG',
    'fr.goto': 'Перейти на кадр',
    'fr.go': 'Перейти',
    'fr.ab': 'A/B повтор',
    'fr.setA': 'Точка A',
    'fr.setB': 'Точка B',
    'fr.clear': 'Сброс',
    'fr.loopOn': 'Повтор включён',
    'fr.loopOff': 'Повтор выключен',
    'fr.storyboard': 'Раскадровка',
    'fr.every': 'Каждые, сек',
    'fr.frames': 'Сколько кадров',
    'fr.make': 'Создать серию PNG',
    'fr.pitch': 'Сохранять тон голоса при ускорении',
    'fr.frameN': 'Кадр №{n} · {tc}',
    'fr.readout': 'Кадр {n} · {tc} · {fps} fps',
    'fr.notReady': 'Кадр пока не готов, подождите секунду',
    'fr.saved': 'Кадр сохранён: {name}',
    'fr.saveFail': 'Не удалось сохранить кадр',
    'fr.saveBlocked': 'Браузер не разрешил сохранить кадр этого видео',
    'fr.boardProgress': 'Раскадровка: {i} из {n}',
    'fr.boardDone': 'Раскадровка готова: {n} кадров',
    'fr.noVideo': 'Плеер не найден на странице',

    /* ещё */
    'more.subtitles': 'Субтитры',
    'more.subAuto': 'авто',
    'more.thumb': 'Обложка видео',
    'more.chapters': 'Главы',
    'more.copyChapters': 'Скопировать главы текстом',
    'more.pip': 'Мини-плеер (p)',
    'more.copyLink': 'Ссылка .m3u8',
    'more.none': 'RuTube не отдал для этого видео',
    'more.saved': 'Сохранено: {name}',
    'more.saveFail': 'Не удалось сохранить',

    /* инфо */
    'info.codec': 'Кодек',
    'info.fps': 'Кадров в секунду',
    'info.bitrate': 'Битрейт',
    'info.qualities': 'Качества',
    'info.date': 'Опубликовано',
    'info.views': 'Просмотры',
    'info.author': 'Автор',
    'info.size': 'Размер',
    'info.copy': 'Скопировать как текст',
    'info.copied': 'Информация скопирована',

    /* подсказки */
    'toast.copied': 'Ссылка скопирована',
    'toast.diagCopied': 'Диагностика скопирована — вставьте её в письмо или issue',
    'toast.speed': 'Скорость {rate}×',
    'toast.seek': '{sign}{n} с · {tc}',
    'toast.volume': 'Громкость {n}%',
    'toast.muted': 'Звук выключен',
    'toast.unmuted': 'Звук включён',
    'toast.start': 'В начало',
    'toast.end': 'В конец',
    'toast.percent': '{n}%',
    'toast.continue': 'Продолжить с {tc}',
    'toast.pip': 'Мини-плеер включён',

    /* справка */
    'help.title': 'RuTube Tools — клавиши',
    'help.frame': 'кадр назад / вперёд',
    'help.speed': 'медленнее / быстрее',
    'help.shot': 'сохранить кадр в PNG',
    'help.pip': 'мини-плеер',
    'help.pause': 'пауза',
    'help.seek10': '−10 с / +10 с',
    'help.seek5': '−5 с / +5 с',
    'help.volume': 'громкость',
    'help.mute': 'звук вкл/выкл',
    'help.percent': 'переход по %',
    'help.help': 'эта справка',
    'help.note': 'Полный набор клавиш включается в настройках расширения.',
    'pop.sub': 'Покадровая перемотка, кадры в PNG и скачивание MP4',
    'pop.quality': 'Качество по умолчанию',
    'pop.fps': 'Частота кадров',
    'pop.fpsHint': 'Шаг покадровой перемотки. «Авто» берёт реальный fps из видео.',
    'pop.parts': 'Разбивать файл на части, МБ',
    'pop.partsHint': 'Длинные видео сохраняются несколькими файлами — браузер не «съест» память.',
    'pop.showButton': 'Показывать кнопку в плеере',
    'pop.youtubeKeys': 'Полный набор клавиш как на YouTube',
    'pop.youtubeHint': 'Space/K, J/L, стрелки, M, 0–9. Выключено — вмешиваемся минимум.',
    'pop.lang': 'Язык интерфейса',
    'pop.frameKeys': 'Клавиши кадров',
    'pop.shotKey': 'Клавиша кадра PNG',
    'pop.pitch': 'Сохранять тон голоса при ускорении',
    'pop.remember': 'Запоминать позицию просмотра',
    'pop.reset': 'Сбросить',
    'pop.keysHint': '— кадр назад / вперёд · {speed} — скорость · {shot} — кадр PNG · ? — помощь',
    'opt.best': 'Лучшее',
    'opt.worst': 'Наименьшее',
    'opt.auto': 'Авто (из видео)',
    'opt.frameComma': ', и .',
    'opt.frameBrackets': '[ и ]',
    'opt.frameAngle': '< и >',
    'opt.shotS': 's',
    'opt.shotK': 'k',
    'opt.shotF': 'f',
    'opt.langAuto': 'Авто (по браузеру)',
    'unit.perSec': '/с'
  };

  var EN = {
    'tab.download': 'Download',
    'tab.frames': 'Frames',
    'tab.more': 'More',
    'tab.info': 'Info',
    'tab.playlist': 'Playlist',
    'panel.loading': 'Loading quality list…',
    'panel.close': 'Close',
    'panel.retry': 'Retry',
    'panel.retryDownload': 'Retry download',
    'panel.copyDiag': 'Copy diagnostics',
    'panel.best': 'best',

    'dl.modeFull': 'Whole video',
    'dl.modePart': 'Fragment',
    'dl.from': 'from',
    'dl.to': 'to',
    'dl.fromPlayer': 'take from player',
    'dl.start': 'Download MP4',
    'dl.startPart': 'Download fragment',
    'dl.copyLink': 'Copy .m3u8 link',
    'dl.duration': 'Duration',
    'dl.mergeHint': 'video is merged into MP4 right in the browser',
    'dl.partsHint': 'Large file will be split into parts of {n} MB',
    'dl.boundaries': 'Actual: {from} – {to} (segment precision 2–4 s)',
    'dl.cancel': 'Cancel',
    'dl.pause': 'Pause',
    'dl.resume': 'Resume',
    'dl.phase.meta': 'Fetching video info…',
    'dl.phase.playlist': 'Reading playlist…',
    'dl.phase.parts': 'Starting download…',
    'dl.phase.save': 'Saving file…',
    'dl.downloading': 'Downloading part {part} of {parts}',
    'dl.downloadingOne': 'Downloading…',
    'dl.segments': '{done} / {total} segments',
    'dl.done': 'Done',
    'dl.doneSaved': 'Saved to Downloads:',
    'dl.doneTs': ' (.ts stream — opens in VLC)',
    'dl.showFile': 'Show file',
    'dl.frameHint': 'Current frame — press {key}',
    'dl.again': 'Download another',

    'err.live': 'This is a live stream — downloading is not available.',
    'err.drm': 'This video is DRM-protected and cannot be downloaded.',
    'err.emptyRange': 'Empty fragment: check the from/to times.',
    'err.download': 'Download failed.',
    'err.playlist': 'Playlist download failed.',
    'err.info': 'Could not load video info.',
    'err.cancelled': 'Download cancelled',
    'err.start': 'Could not start the download',

    'pl.loading': 'Reading playlist…',
    'pl.count': 'Videos in playlist: {n}',
    'pl.range': 'Items',
    'pl.from': 'from #',
    'pl.to': 'to #',
    'pl.start': 'Download playlist',
    'pl.item': 'Video {i} of {n}',
    'pl.done': 'Playlist done: files saved — {ok}',
    'pl.failed': 'Failed: {n}',
    'pl.empty': 'Playlist has no videos',
    'pl.delay': 'Delay between videos: {s} s',
    'pl.savedCount': '{n} done',

    'fr.save': 'Save frame as PNG',
    'fr.goto': 'Go to frame',
    'fr.go': 'Go',
    'fr.ab': 'A/B loop',
    'fr.setA': 'Point A',
    'fr.setB': 'Point B',
    'fr.clear': 'Reset',
    'fr.loopOn': 'Loop on',
    'fr.loopOff': 'Loop off',
    'fr.storyboard': 'Storyboard',
    'fr.every': 'Every, sec',
    'fr.frames': 'Frame count',
    'fr.make': 'Make PNG series',
    'fr.pitch': 'Preserve pitch when speeding up',
    'fr.frameN': 'Frame #{n} · {tc}',
    'fr.readout': 'Frame {n} · {tc} · {fps} fps',
    'fr.notReady': 'Frame is not ready yet, wait a second',
    'fr.saved': 'Frame saved: {name}',
    'fr.saveFail': 'Could not save the frame',
    'fr.saveBlocked': 'Browser blocked saving this video frame',
    'fr.boardProgress': 'Storyboard: {i} of {n}',
    'fr.boardDone': 'Storyboard done: {n} frames',
    'fr.noVideo': 'Player not found on this page',

    'more.subtitles': 'Subtitles',
    'more.subAuto': 'auto',
    'more.thumb': 'Video thumbnail',
    'more.chapters': 'Chapters',
    'more.copyChapters': 'Copy chapters as text',
    'more.pip': 'Picture-in-Picture (p)',
    'more.copyLink': '.m3u8 link',
    'more.none': 'not provided by RuTube for this video',
    'more.saved': 'Saved: {name}',
    'more.saveFail': 'Could not save',

    'info.codec': 'Codec',
    'info.fps': 'Frames per second',
    'info.bitrate': 'Bitrate',
    'info.qualities': 'Qualities',
    'info.date': 'Published',
    'info.views': 'Views',
    'info.author': 'Author',
    'info.size': 'Size',
    'info.copy': 'Copy as text',
    'info.copied': 'Info copied',

    'toast.copied': 'Link copied',
    'toast.diagCopied': 'Diagnostics copied — paste it into an email or issue',
    'toast.speed': 'Speed {rate}×',
    'toast.seek': '{sign}{n} s · {tc}',
    'toast.volume': 'Volume {n}%',
    'toast.muted': 'Muted',
    'toast.unmuted': 'Sound on',
    'toast.start': 'Back to start',
    'toast.end': 'To the end',
    'toast.percent': '{n}%',
    'toast.continue': 'Resume from {tc}',
    'toast.pip': 'Picture-in-Picture on',

    'help.title': 'RuTube Tools — shortcuts',
    'help.frame': 'previous / next frame',
    'help.speed': 'slower / faster',
    'help.shot': 'save frame as PNG',
    'help.pip': 'picture-in-picture',
    'help.pause': 'pause',
    'help.seek10': '−10 s / +10 s',
    'help.seek5': '−5 s / +5 s',
    'help.volume': 'volume',
    'help.mute': 'mute',
    'help.percent': 'jump by %',
    'help.help': 'this help',
    'help.note': 'The full YouTube-style shortcut set is enabled in the extension settings.',
    'pop.sub': 'Frame stepping, PNG frames and MP4 downloads',
    'pop.quality': 'Default quality',
    'pop.fps': 'Frame rate',
    'pop.fpsHint': 'Frame-step size. “Auto” takes the real fps from the video.',
    'pop.parts': 'Split file into parts, MB',
    'pop.partsHint': 'Long videos are saved as several files so the browser keeps memory.',
    'pop.showButton': 'Show the button in the player',
    'pop.youtubeKeys': 'Full YouTube-style shortcut set',
    'pop.youtubeHint': 'Space/K, J/L, arrows, M, 0–9. Off — minimal interference.',
    'pop.lang': 'Interface language',
    'pop.frameKeys': 'Frame step keys',
    'pop.shotKey': 'PNG frame key',
    'pop.pitch': 'Preserve pitch when speeding up',
    'pop.remember': 'Remember playback position',
    'pop.reset': 'Reset',
    'pop.keysHint': '— prev / next frame · {speed} — speed · {shot} — PNG frame · ? — help',
    'opt.best': 'Best',
    'opt.worst': 'Lowest',
    'opt.auto': 'Auto (from video)',
    'opt.frameComma': ', and .',
    'opt.frameBrackets': '[ and ]',
    'opt.frameAngle': '< and >',
    'opt.shotS': 's',
    'opt.shotK': 'k',
    'opt.shotF': 'f',
    'opt.langAuto': 'Auto (browser)',
    'unit.perSec': '/s'
  };

  var DICTS = { ru: RU, en: EN };
  var current = 'ru';

  function detect(pref) {
    if (pref === 'ru' || pref === 'en') return pref;
    var langs = [];
    try {
      if (navigator.languages && navigator.languages.length) langs = Array.prototype.slice.call(navigator.languages);
      else if (navigator.language) langs = [navigator.language];
    } catch (e) {}
    for (var i = 0; i < langs.length; i++) {
      var l = String(langs[i]).toLowerCase();
      if (l.indexOf('ru') === 0 || l.indexOf('uk') === 0 || l.indexOf('be') === 0 || l.indexOf('kk') === 0) return 'ru';
      if (l.indexOf('en') === 0) return 'en';
    }
    return 'ru';
  }

  function setLang(pref) {
    current = detect(pref);
    return current;
  }

  function t(key, vars) {
    var dict = DICTS[current] || RU;
    var s = dict[key] !== undefined ? dict[key] : (RU[key] !== undefined ? RU[key] : key);
    if (vars) {
      Object.keys(vars).forEach(function (k) {
        s = s.replace(new RegExp('\\{' + k + '\\}', 'g'), vars[k]);
      });
    }
    return s;
  }

  global.RTI18n = {
    t: t,
    setLang: setLang,
    getLang: function () { return current; },
    detect: detect
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
