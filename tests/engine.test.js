'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const L = require('../src/lib/engine.js');
const A = require('../src/lib/audio.js');
const { adtsFrame, buildTs } = require('./helpers/ts-builder.js');

const ID = 'a'.repeat(31) + 'b';

test('extractVideoId: все виды ссылок', () => {
  assert.equal(L.extractVideoId(ID), ID);
  assert.equal(L.extractVideoId('https://rutube.ru/video/' + ID + '/?r=wd'), ID);
  assert.equal(L.extractVideoId('https://rutube.ru/play/embed/' + ID), ID);
  assert.equal(L.extractVideoId('https://rutube.ru/shorts/' + ID.toUpperCase()), ID);
  assert.equal(L.extractVideoId('нет id'), null);
  assert.equal(L.extractVideoId(''), null);
  assert.equal(L.extractVideoId(null), null);
});

test('extractPlaylistId', () => {
  assert.equal(L.extractPlaylistId('https://rutube.ru/plst/123456/'), '123456');
  assert.equal(L.extractPlaylistId('https://rutube.ru/video/' + ID), null);
});

test('parseTimecode / formatTime взаимно обратны', () => {
  assert.equal(L.parseTimecode('12:30'), 750);
  assert.equal(L.parseTimecode('1:02:03'), 3723);
  assert.equal(L.parseTimecode('754'), 754);
  assert.equal(L.parseTimecode('1,5'), 1.5);
  assert.ok(Number.isNaN(L.parseTimecode('')));
  assert.equal(L.formatTime(3723), '1:02:03');
  assert.equal(L.formatTime(75), '1:15');
  assert.equal(L.formatTime(-5), '0:00');
});

test('sanitizeFilename и toAsciiFilename', () => {
  assert.equal(L.sanitizeFilename('a/b:c*d?"e<f>g|h'), 'a b c d e f g h');
  assert.equal(L.sanitizeFilename('  ...  '), 'video');
  assert.equal(L.sanitizeFilename('x'.repeat(300)).length, 110);
  assert.equal(L.toAsciiFilename('Привет, Мир'), 'Privet, Mir');
  assert.equal(L.toAsciiFilename('日本語'), 'video');
});

const MASTER = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=1500000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2",FRAME-RATE=25
https://cdn-a.example/1080/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=1500000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2",FRAME-RATE=25
https://cdn-b.example/1080/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=140000,RESOLUTION=256x144,CODECS="avc1.42c00c,mp4a.40.2"
rel/144/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=700000,RESOLUTION=1280x720,CODECS="avc1.4d401f,mp4a.40.2"
https://cdn-a.example/720/index.m3u8
`;

test('parseMaster + groupVariants: зеркала одного качества объединяются, порядок — по убыванию', () => {
  const v = L.parseMaster(MASTER, 'https://cdn-a.example/master.m3u8');
  assert.equal(v.length, 4);
  assert.equal(v[2].url, 'https://cdn-a.example/rel/144/index.m3u8', 'относительный URL разворачивается');
  const g = L.groupVariants(v);
  assert.deepEqual(g.map((x) => x.height), [1080, 720, 144]);
  assert.deepEqual(g[0].mirrors, ['https://cdn-a.example/1080/index.m3u8', 'https://cdn-b.example/1080/index.m3u8']);
});

test('pickVariant и pickAudioVariant', () => {
  const g = L.groupVariants(L.parseMaster(MASTER, 'https://x/m.m3u8'));
  assert.equal(L.pickVariant(g, 'best').height, 1080);
  assert.equal(L.pickVariant(g, 'worst').height, 144);
  assert.equal(L.pickVariant(g, '600').height, 720, 'ближайшее по высоте');
  assert.equal(L.pickAudioVariant(g).height, 144, 'для звука — самый лёгкий поток');
  assert.equal(L.pickAudioVariant([]), null);
});

test('pickAudioVariant: вариант без bandwidth не считается «самым лёгким»', () => {
  const v = L.pickAudioVariant([{ height: 360, bandwidth: 0 }, { height: 720, bandwidth: 700000 }]);
  assert.equal(v.height, 720);
});

const MEDIA = `#EXTM3U
#EXT-X-TARGETDURATION:4
#EXTINF:4.0,
s0.ts
#EXTINF:4.0,
s1.ts
#EXTINF:2.5,
s2.ts
#EXT-X-ENDLIST
`;

test('parseMediaPlaylist', () => {
  const m = L.parseMediaPlaylist(MEDIA, 'https://cdn.example/a/index.m3u8');
  assert.deepEqual(m.segments, ['https://cdn.example/a/s0.ts', 'https://cdn.example/a/s1.ts', 'https://cdn.example/a/s2.ts']);
  assert.equal(m.duration, 10.5);
  assert.equal(m.live, false);
  assert.equal(m.encrypted, false);
  assert.equal(L.parseMediaPlaylist('#EXT-X-KEY:METHOD=AES-128,URI="k"\n#EXTINF:1,\na.ts', 'https://x/p.m3u8').encrypted, true);
  assert.equal(L.parseMediaPlaylist('#EXT-X-KEY:METHOD=NONE\n#EXTINF:1,\na.ts', 'https://x/p.m3u8').encrypted, false);
  assert.equal(L.parseMediaPlaylist('#EXTINF:1,\na.ts', 'https://x/p.m3u8').live, true, 'без ENDLIST — прямой эфир');
});

test('segmentRange: границы по сегментам', () => {
  const d = [4, 4, 4, 4, 4];
  const r = L.segmentRange(d, 5, 13);
  assert.deepEqual([r.start, r.end, r.realFrom, r.realTo], [1, 4, 4, 16]);
  assert.equal(L.segmentRange(d, 10, 10), null);
  assert.equal(L.segmentRange(d, 30, 40), null);
  assert.equal(L.segmentRange(d, 0, 999).end, 5, 'правая граница обрезается длительностью');
});

test('planParts: делит по размеру, не создаёт пустых частей', () => {
  const durations = Array(10).fill(4);                        // 10 × 4 с при 8 Мбит/с = 4 МБ/сегмент
  const parts = L.planParts(durations, 8e6, 10e6);
  assert.deepEqual(parts.map((p) => [p.start, p.end]), [[0, 2], [2, 4], [4, 6], [6, 8], [8, 10]]);
  assert.deepEqual(L.planParts(durations, 8e6, 1e12).length, 1);
  assert.deepEqual(L.planParts([], 8e6, 1e6), []);
  assert.equal(L.planParts([4], 8e6, 1).length, 1, 'сегмент больше лимита — всё равно одна часть');
});

test('главы: текст', () => {
  assert.equal(L.chaptersToText([{ time: 0, title: 'Начало' }, { time: 3725, title: 'Финал' }]), '0:00 Начало\n1:02:05 Финал\n');
  assert.equal(L.chaptersToText([]), '\n');
});

test('главы: FFMETADATA — экранирование, сортировка, границы', () => {
  const out = L.chaptersToFfmetadata([{ time: 75.5, title: 'B=1; #' }, { time: 0, title: 'A' }], 200, 'Т=1');
  assert.ok(out.startsWith(';FFMETADATA1\ntitle=Т\\=1\n'));
  assert.ok(out.includes('START=0\nEND=75500\ntitle=A'));
  assert.ok(out.includes('START=75500\nEND=200000\ntitle=B\\=1\\; \\#'));
  const noEnd = L.chaptersToFfmetadata([{ time: 10, title: 'x' }], 0);
  assert.ok(noEnd.includes('START=10000\nEND=11000'), 'без длительности глава длится ≥ 1 с');
  assert.ok(L.chaptersToFfmetadata([{ time: 1 }], 5).includes('title=Глава 1'));
});

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync('ffprobe', ['-version']).status === 0;

test('главы: ffmpeg принимает наш .ffmeta и видит главы в файле',
  { skip: !hasFfmpeg && 'ffmpeg не установлен' }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-ch-'));
    const meta = path.join(dir, 'c.ffmeta');
    fs.writeFileSync(meta, L.chaptersToFfmetadata([{ time: 0, title: 'Вступление' }, { time: 2, title: 'Основная часть = 2' }], 4, 'Видео'));
    const r = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=64x64:rate=10', '-i', meta,
      '-t', '4', '-map', '0', '-map_metadata', '1', '-map_chapters', '1', '-c:v', 'libx264', '-preset', 'ultrafast',
      path.join(dir, 'o.mp4')]);
    assert.equal(r.status, 0, String(r.stderr));
    const p = JSON.parse(spawnSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_chapters', path.join(dir, 'o.mp4')]).stdout);
    assert.deepEqual(p.chapters.map((c) => c.tags.title), ['Вступление', 'Основная часть = 2']);
    fs.rmSync(dir, { recursive: true, force: true });
  });

/* ------------------------------------------------------------ downloadPart */

function fakeFetch(handler) {
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init) => handler(String(url), init);
  return () => { globalThis.fetch = orig; };
}
const ok = (buf) => ({ ok: true, status: 200, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) });
const bad = (status) => ({ ok: false, status });

test('downloadPart (ts): сегменты идут строго по порядку, даже если приходят вразнобой', async () => {
  const delays = [60, 5, 30, 1, 20];
  const restore = fakeFetch(async (url) => {
    const i = Number(url.match(/s(\d)\.ts/)[1]);
    await new Promise((r) => setTimeout(r, delays[i]));
    return ok(Buffer.from([i, i, i]));
  });
  try {
    const progress = [];
    const out = await L.downloadPart({
      segments: [0, 1, 2, 3, 4].map((i) => 'https://x/s' + i + '.ts'),
      mode: 'ts', concurrency: 5, onProgress: (p) => progress.push(p.done)
    });
    assert.equal(out.ext, 'ts');
    assert.deepEqual(Buffer.concat(out.chunks.map(Buffer.from)), Buffer.from([0, 0, 0, 1, 1, 1, 2, 2, 2, 3, 3, 3, 4, 4, 4]));
    assert.equal(out.bytes, 15);
    assert.equal(progress[progress.length - 1], 5);
    assert.deepEqual(progress, progress.slice().sort((a, b) => a - b), 'прогресс не откатывается');
  } finally { restore(); }
});

test('downloadPart: временный сбой сегмента повторяется и проходит', async () => {
  let calls = 0;
  const restore = fakeFetch(async () => (++calls < 3 ? bad(503) : ok(Buffer.from([9]))));
  try {
    const out = await L.downloadPart({ segments: ['https://x/a.ts'], mode: 'ts' });
    assert.equal(out.bytes, 1);
    assert.equal(calls, 3);
  } finally { restore(); }
});

test('downloadPart: постоянный сбой — ошибка с номером сегмента', async () => {
  const restore = fakeFetch(async (url) => (url.endsWith('b.ts') ? bad(404) : ok(Buffer.from([1]))));
  try {
    await assert.rejects(L.downloadPart({ segments: ['https://x/a.ts', 'https://x/b.ts'], mode: 'ts' }),
      (e) => /Сегмент 2 из 2/.test(e.message) && e.segmentIndex === 1);
  } finally { restore(); }
});

test('downloadPart: отмена прерывает загрузку', async () => {
  const ctrl = new AbortController();
  const restore = fakeFetch(async () => { ctrl.abort(); return ok(Buffer.from([1])); });
  try {
    await assert.rejects(L.downloadPart({ segments: ['https://x/a.ts', 'https://x/b.ts'], mode: 'ts', signal: ctrl.signal }), /Отменено/);
  } finally { restore(); }
});

test('downloadPart (m4a): из потока TS получается M4A', async () => {
  const frames = Array.from({ length: 20 }, (_, i) => adtsFrame(120, i + 1));
  const es = Buffer.concat(frames.map((f) => f.adts));
  const segs = [buildTs([es.subarray(0, 1000)]), buildTs([es.subarray(1000)])];
  const restore = fakeFetch(async (url) => ok(segs[Number(url.match(/s(\d)/)[1])]));
  try {
    const out = await L.downloadPart({ segments: ['https://x/s0.ts', 'https://x/s1.ts'], mode: 'm4a', audio: A, title: 'T' });
    assert.equal(out.ext, 'm4a');
    assert.equal(out.mime, 'audio/mp4');
    assert.equal(Buffer.concat(out.chunks.map(Buffer.from)).length, out.bytes);
  } finally { restore(); }
});

test('downloadPart (m4a): без модуля звука — явная ошибка, а не молчаливая подмена режима', async () => {
  const saved = globalThis.RTAudio;
  globalThis.RTAudio = undefined;
  await assert.rejects(L.downloadPart({ segments: ['https://x/s0.ts'], mode: 'm4a' }), /Модуль извлечения звука/);
  globalThis.RTAudio = saved;
});

test('applyNameTemplate: переменные и пустые значения', () => {
  const v = { title: 'Название', author: 'Автор', quality: '1080p', date: '2026-11-02', playlist: 'Разбор' };
  assert.equal(L.applyNameTemplate('{title}', v), 'Название');
  assert.equal(L.applyNameTemplate('{author} — {title} [{quality}]', v), 'Автор — Название [1080p]');
  assert.equal(L.applyNameTemplate('{author} — {title}', { title: 'Название' }), 'Название');
  assert.equal(L.applyNameTemplate('{title} [{quality}]', { title: 'Название' }), 'Название');
  assert.equal(L.applyNameTemplate('', v), 'Название');
  assert.equal(L.applyNameTemplate('{нет такой}', v), '');
});

test('filenameFromTemplate: подпапка, мусор и запасное имя', () => {
  const v = { title: 'Лекция: введение', author: 'Автор', quality: '720p', playlist: 'Подкаст' };
  assert.equal(L.filenameFromTemplate('{title}', v), 'Лекция введение');
  assert.equal(L.filenameFromTemplate('{playlist}/{author} — {title}', v), 'Подкаст/Автор — Лекция введение');
  assert.equal(L.filenameFromTemplate('../{title}', v), 'Лекция введение');
  assert.equal(L.filenameFromTemplate('{playlist}/', v), 'Подкаст');
  assert.equal(L.filenameFromTemplate('{нет}', v), 'Лекция введение', 'пустой шаблон — имя видео');
  assert.ok(L.filenameFromTemplate('{title}', { title: 'я'.repeat(400) }).length <= 110);
});

test('filenameFromTemplate: «..» и абсолютные пути не дают выйти из папки загрузок', () => {
  const L = require('../src/lib/engine.js');
  const name = L.filenameFromTemplate('../../etc/{title}', { title: 'passwd' });
  assert.ok(!/(^|\/)\.\.(\/|$)/.test(name), name);
  assert.ok(!name.startsWith('/'), name);
  const abs = L.filenameFromTemplate('/{title}', { title: 'v' });
  assert.ok(!abs.startsWith('/'), abs);
});
