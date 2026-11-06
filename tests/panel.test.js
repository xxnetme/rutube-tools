'use strict';
/* Смоук-тест панели в jsdom: загружаем настоящие контент-скрипты и кликаем по интерфейсу.
 * Нужен jsdom (npm i --no-save jsdom); без него тест пропускается. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

let JSDOM = null;
let VirtualConsole = null;
try { ({ JSDOM, VirtualConsole } = require('jsdom')); } catch { /* пропуск ниже */ }
const skip = !JSDOM && 'jsdom не установлен';

const SRC = path.resolve(__dirname, '../src');
const read = (f) => fs.readFileSync(path.join(SRC, f), 'utf8');
const ID = 'c'.repeat(32);

const INFO = {
  videoId: ID, title: 'Лекция: введение', author: 'Автор', durationSec: 600, fps: 25, isLive: false, drmProtected: false,
  captions: [
    { langTitle: 'Русский • Авто', format: 'srt', url: 'https://c/sub-ru.srt' },
    { langTitle: 'English • Auto', format: 'vtt', url: 'https://c/sub-en.vtt' }
  ],
  thumbnail: '',
  cuepoints: [{ time: 0, title: 'Начало' }, { time: 125, title: 'Главная мысль' }],
  variants: [
    { url: 'https://c/1080.m3u8', mirrors: ['https://c/1080.m3u8'], height: 1080, bandwidth: 1500000, label: '1080p', estimatedBytes: 112e6, compatible: true },
    { url: 'https://c/144.m3u8', mirrors: ['https://c/144.m3u8'], height: 144, bandwidth: 140000, label: '144p', estimatedBytes: 10e6, compatible: true }
  ]
};

async function openPanel(url, tab, settings, data) {
  const sent = [];
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (error) => errors.push(error));
  const dom = new JSDOM('<!doctype html><body><video></video></body>', {
    url, runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole
  });
  const w = dom.window;
  Object.defineProperty(w.navigator, 'languages', { value: ['ru-RU'] });
  Object.defineProperty(w.navigator, 'language', { value: 'ru-RU' });
  w.browser = {
    runtime: {
      sendMessage: async (msg) => {
        sent.push(msg);
        if (msg.type === 'rt:info') return { ok: true, info: (data && data.info) || INFO };
        if (msg.type === 'rt:playlist-info') return { ok: true, playlist: (data && data.playlist) || { id: '9', title: 'Подкаст', videosCount: 3, pageSize: 50, videos: [{ id: ID, title: 'a', durationSec: 600 }] } };
        if (msg.type === 'rt:start' || msg.type === 'rt:start-playlist') return { ok: true, jobId: 'j1' };
        if (msg.type === 'rt:save-data-url') return { ok: true, name: msg.filename };
        return { ok: true };
      },
      onMessage: { addListener() {} },
      getManifest: () => ({ version: 'test' })
    },
    storage: { local: { get: async () => (settings || {}), set: async () => {} }, onChanged: { addListener() {} } }
  };
  w.eval(read('lib/dom.js'));
  w.eval(read('lib/engine.js'));
  w.eval(read('lib/i18n.js'));
  w.eval(read('content-core.js'));
  w.eval(read('content-panel.js'));
  const RT = w.__RT;
  assert.ok(RT, 'контент-скрипт инициализировался');
  await new Promise((r) => setTimeout(r, 60));            // init → loadSettings → ensureUI
  RT.openPanel();
  if (tab) RT.setTab(tab);
  const body = () => RT.ui().body;
  const until = async (pred, ms) => {
    const end = Date.now() + (ms || 3000);
    while (Date.now() < end) { if (pred()) return; await new Promise((r) => setTimeout(r, 10)); }
    throw new Error('не дождались; в панели:\n' + body().textContent.slice(0, 400));
  };
  return { w, RT, sent, body, until, errors, close: () => w.close() };
}

test('вкладка «Скачать»: переключатель формата, подсказка про звук, запуск с audio:true',
  { skip }, async () => {
    const p = await openPanel('https://rutube.ru/video/' + ID + '/');
    await p.until(() => p.body().querySelector('input[name="rq"]'));
    assert.equal(p.body().querySelectorAll('input[name="rq"]').length, 2, 'видеорежим: список качеств');
    assert.match(p.body().querySelector('[data-act="go"]').textContent, /Скачать MP4/);

    p.body().querySelector('[data-fmt="audio"]').click();
    assert.equal(p.body().querySelectorAll('input[name="rq"]').length, 0, 'в режиме звука качества скрыты');
    assert.match(p.body().textContent, /самого лёгкого потока \(144p\)/);
    assert.match(p.body().textContent, /~9\.5 МБ/, 'показан трафик лёгкого потока');
    assert.match(p.body().querySelector('[data-act="go"]').textContent, /Скачать звук \(M4A\)/);

    p.body().querySelector('[data-act="go"]').click();
    await p.until(() => p.sent.some((m) => m.type === 'rt:start'));
    const start = p.sent.find((m) => m.type === 'rt:start');
    assert.equal(start.audio, true);
    assert.equal(start.videoId, ID);
    p.close();
  });

test('видеорежим по умолчанию отправляет audio:false', { skip }, async () => {
  const p = await openPanel('https://rutube.ru/video/' + ID + '/');
  await p.until(() => p.body().querySelector('[data-act="go"]'));
  p.body().querySelector('[data-act="go"]').click();
  await p.until(() => p.sent.some((m) => m.type === 'rt:start'));
  assert.equal(p.sent.find((m) => m.type === 'rt:start').audio, false);
  p.close();
});

test('формат переключается обратно на видео', { skip }, async () => {
  const p = await openPanel('https://rutube.ru/video/' + ID + '/');
  await p.until(() => p.body().querySelector('[data-fmt]'));
  p.body().querySelector('[data-fmt="audio"]').click();
  p.body().querySelector('[data-fmt="video"]').click();
  assert.equal(p.body().querySelectorAll('input[name="rq"]').length, 2);
  p.close();
});

test('режим «Фрагмент» продолжает работать рядом с форматом', { skip }, async () => {
  const p = await openPanel('https://rutube.ru/video/' + ID + '/');
  await p.until(() => p.body().querySelector('[data-mode="part"]'));
  p.body().querySelector('[data-fmt="audio"]').click();
  p.body().querySelector('[data-mode="part"]').click();
  assert.ok(p.body().querySelector('[data-in="from"]'));
  p.body().querySelector('[data-in="from"]').value = '1:00';
  p.body().querySelector('[data-in="from"]').dispatchEvent(new p.w.Event('input'));
  p.body().querySelector('[data-in="to"]').value = '2:00';
  p.body().querySelector('[data-in="to"]').dispatchEvent(new p.w.Event('input'));
  p.body().querySelector('[data-act="go"]').click();
  await p.until(() => p.sent.some((m) => m.type === 'rt:start'));
  const m = p.sent.find((m2) => m2.type === 'rt:start');
  assert.deepEqual([m.audio, m.from, m.to], [true, 60, 120]);
  p.close();
});

test('вкладка «Ещё»: главы сохраняются в .txt и .ffmeta', { skip }, async () => {
  const p = await openPanel('https://rutube.ru/video/' + ID + '/');
  await p.until(() => p.body().querySelector('[data-act="go"]'));
  p.RT.setTab('more');
  await p.until(() => p.body().querySelector('[data-act="chtxt"]'));

  p.body().querySelector('[data-act="chtxt"]').click();
  await p.until(() => p.sent.some((m) => m.type === 'rt:save-data-url'));
  const txt = p.sent.find((m) => m.type === 'rt:save-data-url');
  assert.equal(txt.filename, 'Лекция введение — главы.txt');
  assert.equal(decodeURIComponent(txt.dataUrl.split(',')[1]), '0:00 Начало\n2:05 Главная мысль\n');

  p.body().querySelector('[data-act="chff"]').click();
  await p.until(() => p.sent.filter((m) => m.type === 'rt:save-data-url').length === 2);
  const ff = p.sent.filter((m) => m.type === 'rt:save-data-url')[1];
  assert.match(ff.filename, /\.ffmeta$/);
  assert.match(decodeURIComponent(ff.dataUrl.split(',')[1]), /^;FFMETADATA1\ntitle=Лекция: введение|^;FFMETADATA1\ntitle=Лекция\\: введение/);
  assert.match(decodeURIComponent(ff.dataUrl.split(',')[1]), /START=125000\nEND=600000/);
  p.close();
});

test('плейлист: галочки серий — «Ни одной» блокирует старт, «Все» шлёт полный диапазон', { skip }, async () => {
  const p = await openPanel('https://rutube.ru/plst/9/');
  await p.until(() => p.body().querySelector('[data-pl]'));

  const boxes = () => p.body().querySelectorAll('[data-pl]');
  assert.equal(boxes().length, 3, 'по галочке на каждую серию');
  assert.ok([...boxes()].every((b) => b.checked), 'по умолчанию выбрано всё');
  assert.match(p.body().querySelector('.pl-head').textContent, /Выбрано 3 из 3/);

  p.body().querySelector('[data-act="pl-none"]').click();
  assert.match(p.body().querySelector('.pl-head').textContent, /Выбрано 0 из 3/);
  assert.equal(p.body().querySelector('[data-act="go-pl"]').disabled, true, 'пустой выбор не запускается');

  p.body().querySelector('[data-act="pl-all"]').click();
  assert.match(p.body().querySelector('.pl-head').textContent, /Выбрано 3 из 3/);
  p.body().querySelector('[data-act="go-pl"]').click();
  await p.until(() => p.sent.some((m) => m.type === 'rt:start-playlist'));
  const m = p.sent.find((x) => x.type === 'rt:start-playlist');
  assert.equal(m.indices, null, 'весь плейлист — без списка');
  assert.deepEqual([m.fromIndex, m.toIndex], [0, null]);
  p.close();
});

test('плейлист: снятая галочка уходит в indices списком номеров', { skip }, async () => {
  const p = await openPanel('https://rutube.ru/plst/9/');
  await p.until(() => p.body().querySelector('[data-pl]'));

  const second = p.body().querySelectorAll('[data-pl]')[1];
  second.checked = false;
  second.dispatchEvent(new p.w.Event('change'));

  const state = [...p.body().querySelectorAll('[data-pl]')].map((b) => b.checked);
  assert.deepEqual(state, [true, false, true], 'панель перерисовалась с новым выбором');
  assert.match(p.body().querySelector('.pl-head').textContent, /Выбрано 2 из 3/);

  p.body().querySelector('[data-act="go-pl"]').click();
  await p.until(() => p.sent.some((m) => m.type === 'rt:start-playlist'));
  const m = p.sent.find((x) => x.type === 'rt:start-playlist');
  assert.deepEqual(Array.from(m.indices), [0, 2]);   // массив из другого realm
  assert.deepEqual([m.fromIndex, m.toIndex], [0, 3], 'диапазон покрывает выбор');
  p.close();
});

test('плейлист: выбор формата отключает качество и уходит в rt:start-playlist', { skip }, async () => {
  const p = await openPanel('https://rutube.ru/plst/9/');
  await p.until(() => p.body().querySelector('[data-sel="fmt"]'));
  const fmt = p.body().querySelector('[data-sel="fmt"]');
  fmt.value = 'audio';
  fmt.dispatchEvent(new p.w.Event('change'));
  assert.equal(p.body().querySelector('[data-sel="q"]').disabled, true);
  p.body().querySelector('[data-act="go-pl"]').click();
  await p.until(() => p.sent.some((m) => m.type === 'rt:start-playlist'));
  assert.equal(p.sent.find((m) => m.type === 'rt:start-playlist').audio, true);
  p.close();
});

test('формат по умолчанию из настроек: панель открывается в режиме звука', { skip }, async () => {
  const p = await openPanel('https://rutube.ru/video/' + ID + '/', null, { defaultFormat: 'audio' });
  await p.until(() => p.body().querySelector('[data-act="go"]'));
  assert.equal(p.body().querySelectorAll('input[name="rq"]').length, 0, 'качества скрыты, как в режиме звука');
  assert.match(p.body().querySelector('[data-act="go"]').textContent, /Скачать звук \(M4A\)/);
  p.body().querySelector('[data-act="go"]').click();
  await p.until(() => p.sent.some((m) => m.type === 'rt:start'));
  assert.equal(p.sent.find((m) => m.type === 'rt:start').audio, true);
  p.close();
});

test('субтитры: галочка уходит в rt:start вместе с языком', { skip }, async () => {
  const p = await openPanel('https://rutube.ru/video/' + ID + '/');
  await p.until(() => p.body().querySelector('[data-act="subs"]'));
  const box = p.body().querySelector('[data-act="subs"]');
  assert.equal(box.checked, false, 'по умолчанию выключено');

  box.checked = true;
  box.dispatchEvent(new p.w.Event('change'));
  const lang = p.body().querySelector('[data-in="subslang"]');
  assert.ok(lang, 'при двух дорожках появляется выбор языка');
  lang.value = '1';
  lang.dispatchEvent(new p.w.Event('change'));

  p.body().querySelector('[data-act="go"]').click();
  await p.until(() => p.sent.some((m) => m.type === 'rt:start'));
  const m = p.sent.find((m2) => m2.type === 'rt:start');
  assert.equal(m.subsUrl, 'https://c/sub-en.vtt', 'взята выбранная дорожка, а не первая');
  assert.equal(m.subsExt, 'vtt');
  p.close();
});

test('имя файла: шаблон из настроек уходит в rt:start', { skip }, async () => {
  const p = await openPanel('https://rutube.ru/video/' + ID + '/', null, { nameTemplate: '{author} — {title}' });
  await p.until(() => p.body().querySelector('[data-act="go"]'));
  p.body().querySelector('[data-act="go"]').click();
  await p.until(() => p.sent.some((m) => m.type === 'rt:start'));
  assert.equal(p.sent.find((m) => m.type === 'rt:start').nameTemplate, '{author} — {title}');
  p.close();
});

test('HEVC/AV1: до старта показано предупреждение про .ts, у обычного качества его нет', { skip }, async () => {
  const hevc = { url: 'https://c/720.m3u8', mirrors: ['https://c/720.m3u8'], height: 720, bandwidth: 80e6, label: '720p', estimatedBytes: 50e6, compatible: false };
  INFO.variants.push(hevc);
  try {
    const p = await openPanel('https://rutube.ru/video/' + ID + '/');
    await p.until(() => p.body().querySelector('input[name="rq"]'));
    assert.ok(!/HEVC\/AV1/.test(p.body().textContent), 'у выбранного по умолчанию совместимого качества предупреждения нет');
    const radio = p.body().querySelector('input[name="rq"][value="720"]');
    assert.ok(radio, 'есть строка 720p');
    assert.match(radio.closest('label').textContent, /\.ts/, 'у строки пометка .ts');
    radio.click();
    radio.dispatchEvent(new p.w.Event('change', { bubbles: true }));
    await p.until(() => /HEVC\/AV1/.test(p.body().textContent));
    assert.match(p.body().textContent, /\.ts/);
    p.close();
  } finally {
    INFO.variants.pop();
  }
});

test('вкладка «Кадры»: копирование, контактный лист и «только между A и B» (выключено без A/B)', { skip }, async () => {
  const p = await openPanel('https://rutube.ru/video/' + ID + '/', 'frames');
  await p.until(() => p.body().querySelector('[data-act="shot"]'));
  assert.ok(p.body().querySelector('[data-act="copyshot"]'), 'кнопка копирования кадра');
  assert.ok(p.body().querySelector('[data-act="sheet"]'), 'кнопка контактного листа');
  const useAB = p.body().querySelector('[data-act="useab"]');
  assert.ok(useAB, 'галочка «только между A и B»');
  assert.equal(useAB.disabled, true, 'без отметок A и B недоступна');
  p.RT.state.ab.a = 10; p.RT.state.ab.b = 40;
  p.RT.render();
  assert.equal(p.body().querySelector('[data-act="useab"]').disabled, false, 'с A и B доступна');
  p.close();
});

test('MutationObserver и watch после закрытия документа не выбрасывают ошибок', { skip }, async () => {
  const p = await openPanel('https://rutube.ru/video/' + ID + '/');
  await p.until(() => p.body().querySelector('[data-act="go"]'));
  p.close();
  await new Promise((resolve) => setTimeout(resolve, 1600));
  assert.deepEqual(p.errors.map(String), [], 'после close не должно быть отложенных jsdomError');
});

test('строки API и результата не превращаются в HTML', { skip }, async () => {
  const payload = '<img data-xss src=x onerror="globalThis.pwned=1">';
  const info = Object.assign({}, INFO, {
    title: payload,
    author: payload,
    captions: [{ langTitle: payload, format: 'srt', url: 'https://c/sub.srt' }],
    cuepoints: [{ time: 0, title: payload }]
  });
  const p = await openPanel('https://rutube.ru/video/' + ID + '/', null, null, { info });
  const assertTextOnly = () => {
    assert.ok(p.body().textContent.includes(payload), 'строка видна пользователю как текст');
    assert.equal(p.body().querySelector('[data-xss]'), null, 'разметка из строки не создана');
    assert.equal(p.w.pwned, undefined);
  };

  await p.until(() => p.body().querySelector('[data-act="go"]'));
  assertTextOnly();

  p.RT.setTab('more');
  await p.until(() => p.body().querySelector('[data-sub]'));
  assertTextOnly();

  p.RT.setTab('info');
  await p.until(() => p.body().querySelector('dl.kv'));
  assertTextOnly();
  await p.until(() => !p.RT.state.metaLoading, 3000);

  p.RT.setTab('download');
  p.RT.state.job = { id: 'xss-test', kind: 'video' };
  p.w.RTPanel.onProgress({ phase: 'done', files: [payload], subs: [payload], downloadIds: [] });
  assertTextOnly();

  p.RT.state.job = { id: 'xss-test', kind: 'video' };
  p.w.RTPanel.onProgress({ phase: 'error', error: 'download', detail: payload });
  assertTextOnly();
  p.close();
});

test('названия плейлиста и серий остаются текстом', { skip }, async () => {
  const payload = '<svg data-xss onload="globalThis.pwned=1"></svg>';
  const playlist = {
    id: '9', title: payload, videosCount: 1, pageSize: 50,
    videos: [{ id: ID, title: payload, durationSec: 60 }]
  };
  const p = await openPanel('https://rutube.ru/plst/9/', null, null, { playlist });
  await p.until(() => p.body().querySelector('[data-pl]'));
  assert.equal(p.body().querySelector('.title').textContent, payload);
  assert.equal(p.body().querySelector('.pl-t').textContent, payload);
  assert.equal(p.body().querySelector('[data-xss]'), null);
  assert.equal(p.w.pwned, undefined);
  p.close();
});
