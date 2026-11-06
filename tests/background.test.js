'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveObjectURL, Blob } = require('node:buffer');
const { createBrowser, createServer, vid } = require('./helpers/fake-env.js');
const { parseM4a } = require('./helpers/ts-builder.js');

const ID1 = vid(1), ID2 = vid(2), ID3 = vid(3);
const AAC = 'avc1.42c00c,mp4a.40.2';
const HEVC = 'hvc1.1.6.L93.B0,mp4a.40.2';   // HEVC → режим .ts без mux.js

const isDone = (m) => m.phase === 'done' || m.phase === 'queue-done';
const isErr = (m) => m.phase === 'error';

function oneVideo(variants, extra) {
  return Object.assign({ [ID1]: Object.assign({ title: 'Тестовое видео', durationSec: 16, variants }, extra) });
}

test('только звук: качается самый лёгкий поток, файл — валидный M4A', async () => {
  const srv = createServer(oneVideo([
    { height: 1080, bandwidth: 1500000, codecs: AAC, mirrors: ['a.rtbcdn.ru'], segments: 4, aac: true },
    { height: 144, bandwidth: 140000, codecs: AAC, mirrors: ['a.rtbcdn.ru'], segments: 4, aac: true }
  ]));
  const b = createBrowser();
  const r = await b.call({ type: 'rt:start', videoId: ID1, audio: true, height: 1080, maxPartMB: 220 });
  assert.equal(r.ok, true);
  const done = await b.waitFor((m) => isDone(m) || isErr(m));
  assert.equal(done.phase, 'done', JSON.stringify(done));
  assert.equal(done.mode, 'm4a');

  assert.equal(srv.segmentFetches(ID1, 1080).length, 0, 'сегменты 1080p не трогали');
  assert.equal(srv.segmentFetches(ID1, 144).length, 4);

  assert.equal(b.downloads.length, 1);
  assert.equal(b.downloads[0].filename, 'Тестовое видео.m4a');
  const blob = resolveObjectURL(b.downloads[0].url);
  assert.ok(blob, 'есть blob по ссылке на скачивание');
  const m4a = parseM4a(Buffer.from(await blob.arrayBuffer()));
  assert.equal(m4a.frames.length, 32, '4 сегмента × 8 кадров');
  assert.deepEqual(b.pending(), [], 'после успеха записи о докачке нет');
});

test('только звук: фрагмент по таймкодам', async () => {
  createServer(oneVideo([{ height: 144, bandwidth: 140000, codecs: AAC, mirrors: ['a.rtbcdn.ru'], segments: 4, aac: true }]));
  const b = createBrowser();
  await b.call({ type: 'rt:start', videoId: ID1, audio: true, from: 4, to: 12 });
  const done = await b.waitFor((m) => isDone(m) || isErr(m));
  assert.equal(done.phase, 'done');
  assert.match(b.downloads[0].filename, /\(0-04-0-12\)\.m4a$/);
  const m4a = parseM4a(Buffer.from(await resolveObjectURL(b.downloads[0].url).arrayBuffer()));
  assert.equal(m4a.frames.length, 16, 'сегменты 2 и 3');
});

test('видео в .ts делится на части; сбой посреди — запись остаётся и докачка идёт с нужной части', async () => {
  const srv = createServer(oneVideo([{ height: 720, bandwidth: 80e6, codecs: HEVC, mirrors: ['a.rtbcdn.ru'], segments: 4 }]));
  const b = createBrowser();
  srv.failures.add('/720/seg2.ts');                         // третья часть недоступна

  await b.call({ type: 'rt:start', videoId: ID1, height: 720, maxPartMB: 50 });
  const err = await b.waitFor(isErr, 15000);
  assert.ok(err.detail);
  assert.deepEqual(b.downloads.map((d) => d.filename), ['Тестовое видео — 1/4.ts', 'Тестовое видео — 2/4.ts']);

  let rec = b.pending()[0];
  assert.equal(b.pending().length, 1);
  assert.equal(rec.status, 'error');
  assert.equal(rec.nextPart, 2);
  assert.equal(rec.partsTotal, 4);
  assert.deepEqual(rec.savedFiles, ['Тестовое видео — 1/4.ts', 'Тестовое видео — 2/4.ts']);

  // «перезапуск браузера»: новый фон, то же хранилище
  const b2 = createBrowser(b.store);
  const listed = (await b2.call({ type: 'rt:pending-list' })).items;
  assert.equal(listed.length, 1);
  assert.equal(listed[0].running, false);

  srv.failures.clear();
  const before = srv.log.length;
  const res = await b2.call({ type: 'rt:pending-resume', id: rec.id }, {});
  assert.equal(res.ok, true);
  await b2.idle(() => b2.pending().length === 0);

  assert.deepEqual(b2.downloads.map((d) => d.filename), ['Тестовое видео — 3/4.ts', 'Тестовое видео — 4/4.ts']);
  const refetched = srv.log.slice(before).filter((u) => /seg[01]\.ts/.test(u));
  assert.deepEqual(refetched, [], 'уже сохранённые части заново не качаются');
});

test('запись об ошибке заменяется при новом запуске того же видео', async () => {
  const srv = createServer(oneVideo([{ height: 720, bandwidth: 80e6, codecs: HEVC, mirrors: ['a.rtbcdn.ru'], segments: 2 }]));
  const b = createBrowser();
  srv.failures.add('/720/seg1.ts');
  await b.call({ type: 'rt:start', videoId: ID1, height: 720, maxPartMB: 50 });
  await b.waitFor(isErr, 15000);
  assert.equal(b.pending().length, 1);

  srv.failures.clear();
  b.tabMsgs.length = 0;
  await b.call({ type: 'rt:start', videoId: ID1, height: 720, maxPartMB: 50 });
  await b.waitFor(isDone);
  assert.deepEqual(b.pending(), [], 'старая запись не копится рядом с новой');
});

test('отмена пользователем удаляет запись, закрытие вкладки — оставляет', async () => {
  const srv = createServer(oneVideo([{ height: 720, bandwidth: 80e6, codecs: HEVC, mirrors: ['a.rtbcdn.ru'], segments: 4 }]));
  const slow = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (/seg\d\.ts/.test(url)) await new Promise((r) => setTimeout(r, 120));
    return slow(url, init);
  };

  // 1. отмена
  let b = createBrowser();
  let r = await b.call({ type: 'rt:start', videoId: ID1, height: 720, maxPartMB: 50 });
  await b.idle(() => b.pending().length === 1);
  await b.call({ type: 'rt:cancel', jobId: r.jobId });
  await b.waitFor((m) => m.phase === 'cancelled');
  await b.idle(() => b.pending().length === 0);

  // 2. вкладку закрыли
  b = createBrowser();
  r = await b.call({ type: 'rt:start', videoId: ID1, height: 720, maxPartMB: 50 });
  await b.idle(() => b.pending().length === 1);
  b.closeTab(7);
  await b.waitFor((m) => m.phase === 'cancelled');
  await b.idle(() => b.pending()[0] && b.pending()[0].status === 'interrupted');
  assert.equal(b.pending().length, 1, 'запись осталась — можно докачать из popup');
  assert.ok(srv.log.length > 0);
});

test('зеркало CDN: при сбое одного сервера загрузка проходит с резервного', async () => {
  const srv = createServer(oneVideo([{ height: 720, bandwidth: 80e6, codecs: HEVC, mirrors: ['a.rtbcdn.ru', 'b.rtbcdn.net'], segments: 2 }]));
  srv.failures.add('a.rtbcdn.ru/' + ID1 + '/720/seg1.ts');
  const b = createBrowser();
  await b.call({ type: 'rt:start', videoId: ID1, height: 720, maxPartMB: 50 });
  const done = await b.waitFor((m) => isDone(m) || isErr(m), 15000);
  assert.equal(done.phase, 'done', JSON.stringify(done));
  assert.ok(srv.log.some((u) => u.startsWith('https://b.rtbcdn.net/')), 'ушли на резервное зеркало');
});

test('DRM и эфиры не оставляют записей о докачке', async () => {
  createServer(oneVideo([{ height: 144, bandwidth: 140000, codecs: AAC, mirrors: ['a.rtbcdn.ru'], segments: 1 }]));
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const r = await orig(url, init);
    if (/play\/options/.test(url)) {
      const data = JSON.parse(await r.text());
      data.drm_token = 'x';
      return { ok: true, status: 200, text: async () => JSON.stringify(data) };
    }
    return r;
  };
  const b = createBrowser();
  await b.call({ type: 'rt:start', videoId: ID1, height: 144 });
  const err = await b.waitFor(isErr);
  assert.equal(err.error, 'drm');
  await b.idle(() => b.pending().length === 0);
});

function playlistSetup() {
  const mk = (id, t) => ({ title: t, durationSec: 8, variants: [{ height: 144, bandwidth: 140000, codecs: AAC, mirrors: ['a.rtbcdn.ru'], segments: 2, aac: true }] });
  const videos = { [ID1]: mk(ID1, 'Серия 1'), [ID2]: mk(ID2, 'Серия 2'), [ID3]: mk(ID3, 'Серия 3') };
  return createServer(videos, { playlists: { 555: { title: 'Подкаст', videos: [ID1, ID2, ID3] } } });
}

test('плейлист со звуком: все серии в M4A, запись удаляется', async () => {
  playlistSetup();
  const b = createBrowser();
  await b.call({ type: 'rt:start-playlist', playlistId: '555', audio: true, delayMs: 1 });
  const done = await b.waitFor((m) => m.phase === 'queue-done', 15000);
  assert.deepEqual(done.failed, []);
  assert.deepEqual(b.downloads.map((d) => d.filename), ['Серия 1.m4a', 'Серия 2.m4a', 'Серия 3.m4a']);
  await b.idle(() => b.pending().length === 0);
});

test('плейлист: после «перезапуска» докачка идёт с нужной серии', async () => {
  const srv = playlistSetup();
  const store = { rtPending: [{
    id: 'pl_old', kind: 'playlist', playlistId: '555', height: 144, audio: true, fromIndex: 0, toIndex: null,
    nextIndex: 2, maxPartMB: 220, title: 'Подкаст', status: 'running', createdAt: Date.now(), updatedAt: Date.now()
  }] };
  const b = createBrowser(store);
  const items = (await b.call({ type: 'rt:pending-list' })).items;
  assert.equal(items.length, 1);
  assert.equal(items[0].running, false, 'после перезапуска запись не считается идущей');

  await b.call({ type: 'rt:pending-resume', id: 'pl_old' }, {});
  await b.idle(() => b.pending().length === 0, 15000);
  assert.deepEqual(b.downloads.map((d) => d.filename), ['Серия 3.m4a'], 'серии 1–2 заново не качаются');
  assert.equal(srv.segmentFetches(ID1, 144).length, 0);
});

test('rt:pending-discard убирает запись', async () => {
  createServer(oneVideo([{ height: 144, bandwidth: 140000, codecs: AAC, mirrors: ['a.rtbcdn.ru'], segments: 1 }]));
  const store = { rtPending: [{ id: 'x1', kind: 'video', videoId: ID1, status: 'error', nextPart: 1, partsTotal: 3, updatedAt: Date.now() }] };
  const b = createBrowser(store);
  assert.equal((await b.call({ type: 'rt:pending-list' })).items.length, 1);
  await b.call({ type: 'rt:pending-discard', id: 'x1' });
  assert.equal(b.pending().length, 0);
});

test('записи старше 14 дней отбрасываются', async () => {
  const old = Date.now() - 15 * 24 * 3600 * 1000;
  const b = createBrowser({ rtPending: [{ id: 'old', kind: 'video', videoId: ID1, status: 'error', updatedAt: old }] });
  assert.deepEqual((await b.call({ type: 'rt:pending-list' })).items, []);
});

test('rt:pending-resume для несуществующей записи — понятный отказ', async () => {
  const b = createBrowser();
  const r = await b.call({ type: 'rt:pending-resume', id: 'нет' }, {});
  assert.equal(r.ok, false);
});

test('имя файла по шаблону: автор и качество подставляются', async () => {
  createServer(oneVideo([{ height: 720, bandwidth: 80e6, codecs: HEVC, mirrors: ['a.rtbcdn.ru'], segments: 2 }],
    { author: 'Автор Видео' }));
  const b = createBrowser();
  await b.call({ type: 'rt:start', videoId: ID1, height: 720, nameTemplate: '{author} — {title} [{quality}]' });
  const done = await b.waitFor((m) => isDone(m) || isErr(m));
  assert.equal(done.phase, 'done');
  assert.equal(b.downloads[0].filename, 'Автор Видео — Тестовое видео [720p].ts');
});

test('шаблон без данных не оставляет висящих разделителей', async () => {
  createServer(oneVideo([{ height: 720, bandwidth: 80e6, codecs: HEVC, mirrors: ['a.rtbcdn.ru'], segments: 2 }]));
  const b = createBrowser();
  // автора у видео нет — остаётся только название
  await b.call({ type: 'rt:start', videoId: ID1, height: 720, nameTemplate: '{author} — {title}' });
  await b.waitFor((m) => isDone(m) || isErr(m));
  assert.equal(b.downloads[0].filename, 'Тестовое видео.ts');
});

test('шаблон с косой чертой создаёт подпапку', async () => {
  createServer(oneVideo([{ height: 720, bandwidth: 80e6, codecs: HEVC, mirrors: ['a.rtbcdn.ru'], segments: 2 }]));
  const b = createBrowser();
  await b.call({ type: 'rt:start', videoId: ID1, height: 720, nameTemplate: 'Ролики/{title}' });
  await b.waitFor((m) => isDone(m) || isErr(m));
  assert.equal(b.downloads[0].filename, 'Ролики/Тестовое видео.ts');
});

test('субтитры: .srt кладётся рядом с видео и называется так же', async () => {
  createServer(oneVideo([{ height: 720, bandwidth: 80e6, codecs: HEVC, mirrors: ['a.rtbcdn.ru'], segments: 2 }]));
  const b = createBrowser();
  await b.call({ type: 'rt:start', videoId: ID1, height: 720,
                 subsUrl: 'https://cdn.rutube.ru/sub/ru.srt', subsExt: 'srt' });
  const done = await b.waitFor((m) => isDone(m) || isErr(m));
  assert.equal(done.phase, 'done');
  assert.deepEqual(done.subs, ['Тестовое видео.srt']);
  assert.deepEqual(b.downloads.map((d) => d.filename), ['Тестовое видео.ts', 'Тестовое видео.srt']);
  assert.equal(done.downloadIds.length, 2, 'субтитры тоже доступны по «Показать файл»');
});

test('субтитры не нужны для звука: M4A сохраняется один', async () => {
  createServer(oneVideo([{ height: 144, bandwidth: 140000, codecs: AAC, mirrors: ['a.rtbcdn.ru'], segments: 2, aac: true }]));
  const b = createBrowser();
  await b.call({ type: 'rt:start', videoId: ID1, audio: true,
                 subsUrl: 'https://cdn.rutube.ru/sub/ru.srt', subsExt: 'srt' });
  await b.waitFor((m) => isDone(m) || isErr(m));
  assert.deepEqual(b.downloads.map((d) => d.filename), ['Тестовое видео.m4a']);
});

test('теги в M4A: серия подкаста получает альбом, номер и автора', async () => {
  const mk = (id, t) => ({ title: t, author: 'Автор', durationSec: 8,
    variants: [{ height: 144, bandwidth: 140000, codecs: AAC, mirrors: ['a.rtbcdn.ru'], segments: 2, aac: true }] });
  const videos = { [ID1]: mk(ID1, 'Серия 1'), [ID2]: mk(ID2, 'Серия 2') };
  createServer(videos, { playlists: { 555: { title: 'Подкаст', videos: [ID1, ID2] } } });
  const b = createBrowser();
  await b.call({ type: 'rt:start-playlist', playlistId: '555', audio: true, delayMs: 1 });
  await b.waitFor((m) => m.phase === 'queue-done', 15000);

  const texts = b.downloads.map(async (d) => Buffer.from(await resolveObjectURL(d.url).arrayBuffer()));
  for (let i = 0; i < texts.length; i++) {
    const buf = await texts[i];
    assert.ok(buf.includes(Buffer.from('Подкаст', 'utf8')), 'альбом = название плейлиста');
    assert.ok(buf.includes(Buffer.from('Автор', 'utf8')), 'исполнитель = автор видео');
    const t = buf.indexOf(Buffer.from('trkn', 'latin1'));
    assert.ok(t > 0, 'номер серии на месте');
    assert.equal(buf[t + 4 + 8 + 8 + 3], i + 1, 'номер серии по порядку');
    assert.equal(buf[t + 4 + 8 + 8 + 5], 2, 'всего серий');
  }
});

test('теги в M4A: обложка тянется с CDN и попадает в covr', async () => {
  createServer(oneVideo([{ height: 144, bandwidth: 140000, codecs: AAC, mirrors: ['a.rtbcdn.ru'], segments: 2, aac: true }],
    { author: 'Автор', thumbnail: true }));
  const b = createBrowser();
  await b.call({ type: 'rt:start', videoId: ID1, audio: true });
  await b.waitFor((m) => isDone(m) || isErr(m), 15000);
  const buf = Buffer.from(await resolveObjectURL(b.downloads[0].url).arrayBuffer());
  const c = buf.indexOf(Buffer.from('covr', 'latin1'));
  assert.ok(c > 0, 'атом covr на месте');
  assert.ok(buf.includes(Buffer.from('\xff\xd8\xff\xe0test-jpeg\xff\xd9', 'latin1')), 'байты обложки внутри');
});

test('обложка не пришла — файл всё равно с тегами', async () => {
  createServer(oneVideo([{ height: 144, bandwidth: 140000, codecs: AAC, mirrors: ['a.rtbcdn.ru'], segments: 2, aac: true }],
    { author: 'Автор' }));
  const b = createBrowser();
  await b.call({ type: 'rt:start', videoId: ID1, audio: true });
  const done = await b.waitFor((m) => isDone(m) || isErr(m), 15000);
  assert.equal(done.phase, 'done');
  const buf = Buffer.from(await resolveObjectURL(b.downloads[0].url).arrayBuffer());
  assert.equal(buf.indexOf(Buffer.from('covr', 'latin1')), -1, 'covr нет');
  assert.ok(buf.includes(Buffer.from('Автор', 'utf8')), 'автор на месте');
});

test('выбор галочками: качаются только выбранные серии, по порядку', async () => {
  const srv = playlistSetup();
  const b = createBrowser();
  await b.call({ type: 'rt:start-playlist', playlistId: '555', audio: true, delayMs: 1, indices: [2, 0] });
  const done = await b.waitFor((m) => m.phase === 'queue-done', 15000);
  assert.deepEqual(done.failed, []);
  assert.deepEqual(b.downloads.map((d) => d.filename), ['Серия 1.m4a', 'Серия 3.m4a'], 'сортировка по порядку, без серии 2');
  assert.equal(srv.segmentFetches(ID2, 144).length, 0, 'вторую серию не трогали');
});

test('выбор галочками: номер серии в тегах идёт по счёту загрузки, а не по индексу', async () => {
  playlistSetup();
  const b = createBrowser();
  await b.call({ type: 'rt:start-playlist', playlistId: '555', audio: true, delayMs: 1, indices: [2] });
  const done = await b.waitFor((m) => m.phase === 'queue-done', 15000);
  assert.equal(done.files.length, 1);
  const buf = Buffer.from(await resolveObjectURL(b.downloads[0].url).arrayBuffer());
  const t = buf.indexOf(Buffer.from('trkn', 'latin1'));
  assert.equal(buf[t + 20 + 3], 1, 'единственная выбранная серия — первая в очереди');
  assert.equal(buf[t + 20 + 5], 1, 'всего серий в этой загрузке — одна');
});

test('пустой выбор: ничего не качается, ошибки нет', async () => {
  playlistSetup();
  const b = createBrowser();
  await b.call({ type: 'rt:start-playlist', playlistId: '555', audio: true, delayMs: 1, indices: [] });
  await b.waitFor((m) => m.phase === 'queue-done', 15000);
  assert.deepEqual(b.downloads, []);
});

test('история: завершённая загрузка попадает в rtHistory с именем файла', async () => {
  createServer(oneVideo([{ height: 720, bandwidth: 80e6, codecs: HEVC, mirrors: ['a.rtbcdn.ru'], segments: 2 }]));
  const b = createBrowser();
  await b.call({ type: 'rt:start', videoId: ID1, height: 720 });
  await b.waitFor((m) => isDone(m) || isErr(m));

  // браузер сообщает о завершении загрузки
  b.completeDownload(1);
  await b.idle(() => (b.store.rtHistory || []).length === 1);

  const items = (await b.call({ type: 'rt:history-list' })).items;
  assert.equal(items.length, 1);
  assert.equal(items[0].name, 'Тестовое видео.ts');
  assert.ok(items[0].at > 0);

  await b.call({ type: 'rt:history-clear' }, {});
  assert.deepEqual((await b.call({ type: 'rt:history-list' })).items, []);
});

test('история: новый файл встаёт сверху, а самая старая запись вытесняется', async () => {
  createServer(oneVideo([{ height: 720, bandwidth: 80e6, codecs: HEVC, mirrors: ['a.rtbcdn.ru'], segments: 2 }]));
  const old = Array.from({ length: 30 }, (_, i) => ({ id: 100 + i, name: 'Старый ' + i + '.ts', at: 1000 + i }));
  const b = createBrowser({ rtHistory: old });

  await b.call({ type: 'rt:start', videoId: ID1, height: 720 });
  await b.waitFor((m) => isDone(m) || isErr(m));
  b.completeDownload(1);
  await b.idle(() => (b.store.rtHistory || [])[0].id === 1);

  const hist = b.store.rtHistory;
  assert.equal(hist.length, 30, 'больше 30 записей не копим');
  assert.equal(hist[0].name, 'Тестовое видео.ts');
  assert.equal(hist.filter((r) => r.id === 129).length, 0, 'самая старая вытеснена');
});

test('чужие URL обложки и субтитров не получают запрос и не отменяют видео', async () => {
  const srv = createServer(oneVideo([
    { height: 144, bandwidth: 140000, codecs: AAC, mirrors: ['a.rtbcdn.ru'], segments: 1, aac: true }
  ], { thumbnail: 'https://evil.example/cover.jpg' }));
  const b = createBrowser();

  await b.call({ type: 'rt:start', videoId: ID1, audio: true, height: 144 });
  let done = await b.waitFor((m) => isDone(m) || isErr(m));
  assert.equal(done.phase, 'done');

  b.tabMsgs.length = 0;
  await b.call({ type: 'rt:start', videoId: ID1, height: 144, subsUrl: 'https://evil.example/sub.srt' });
  done = await b.waitFor((m) => isDone(m) || isErr(m));
  assert.equal(done.phase, 'done');
  assert.equal(done.mode, 'mp4');
  assert.equal(done.subs.length, 0);
  assert.equal(b.downloads.length, 2);
  assert.equal(b.downloads[1].filename, 'Тестовое видео.mp4');
  assert.ok(!srv.log.some((url) => url.includes('evil.example')), 'ни обложка, ни субтитры не запрашивались');
});

test('rt:save-url: чужие хосты и не-http схемы отклоняются, CDN RuTube проходит', async () => {
  globalThis.fetch = async (url) => ({ ok: true, status: 200, blob: async () => new Blob(['cover:' + url]) });
  const b = createBrowser();
  for (const url of [
    'https://evil.example/a.srt',
    'https://rutube.ru.evil.example/a.srt',     // похожий хост
    'https://notrutube.ru/a.srt',               // суффикс без точки
    'file:///etc/passwd',
    'javascript:alert(1)',
    'data:text/html,<script>1</script>',
    'не url'
  ]) {
    const r = await b.call({ type: 'rt:save-url', url, filename: 'x.srt' });
    assert.equal(r.ok, false, url);
    assert.equal(r.error, 'url-not-allowed', url);
  }
  assert.equal(b.downloads.length, 0, 'ни одной загрузки не стартовало');

  const ok = await b.call({ type: 'rt:save-url', url: 'https://pic.rtbcdn.ru/video/cover.jpg', filename: 'cover.jpg' });
  assert.equal(ok.ok, true);
  assert.equal(b.downloads.length, 1);
});

test('rt:save-data-url: принимает кадры и текст, отклоняет всё остальное', async () => {
  // fetch подменён соседними тестами: для data: делаем свой, чтобы тест не зависел от порядка
  globalThis.fetch = async (u) => ({ ok: true, blob: async () => new Blob([String(u)]) });
  const b = createBrowser();
  const bad = [
    'data:text/html;base64,PHNjcmlwdD4=',
    'data:image/svg+xml;base64,PHN2Zz4=',
    'https://rutube.ru/x.png',
    'javascript:alert(1)',
    null,
    42
  ];
  for (const dataUrl of bad) {
    const r = await b.call({ type: 'rt:save-data-url', dataUrl, filename: 'x.png' });
    assert.equal(r.ok, false, String(dataUrl));
    assert.equal(r.error, 'bad-data-url', String(dataUrl));
  }
  assert.equal(b.downloads.length, 0);

  const png = 'data:image/png;base64,iVBORw0KGgo=';
  const txt = 'data:text/plain;charset=utf-8,' + encodeURIComponent('0:00 Начало');
  assert.equal((await b.call({ type: 'rt:save-data-url', dataUrl: png, filename: 'кадр.png' })).ok, true);
  assert.equal((await b.call({ type: 'rt:save-data-url', dataUrl: txt, filename: 'главы.txt' })).ok, true);
  assert.equal(b.downloads.length, 2);
});
