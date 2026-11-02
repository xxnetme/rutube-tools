'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const A = require('../src/lib/audio.js');
const { adtsFrame, buildTs, slice, parseM4a } = require('./helpers/ts-builder.js');

function makeFrames(n, sizeOf) {
  return Array.from({ length: n }, (_, i) => adtsFrame(sizeOf ? sizeOf(i) : 100 + (i % 7) * 13, i + 1));
}
const concat = (frames) => Buffer.concat(frames.map((f) => f.adts));
const toBuf = (chunks) => Buffer.concat(chunks.map((c) => Buffer.from(c)));

function extract(segments, opts) {
  const ex = A.createExtractor(opts);
  segments.forEach((s) => ex.push(new Uint8Array(s)));
  return ex.finish();
}

test('кадры на выходе совпадают с кадрами на входе (по байтам)', () => {
  const frames = makeFrames(40);
  const ts = buildTs(slice(concat(frames), [500, 700, 333, 1200]));
  const out = extract([ts]);
  const m4a = parseM4a(toBuf(out.chunks));
  assert.equal(m4a.frames.length, 40);
  m4a.frames.forEach((f, i) => assert.ok(Buffer.compare(f, frames[i].raw) === 0, 'кадр ' + i));
});

test('кадр, разрезанный между PES-пакетами, склеивается', () => {
  const frames = makeFrames(10, () => 300);
  const es = concat(frames);
  const ts = buildTs(slice(es, [10, 111, 50]));            // режем посреди кадров
  const m4a = parseM4a(toBuf(extract([ts]).chunks));
  assert.equal(m4a.frames.length, 10);
  m4a.frames.forEach((f, i) => assert.ok(f.equals(frames[i].raw)));
});

test('кадр, разрезанный между сегментами, не теряется', () => {
  const frames = makeFrames(30);
  const es = concat(frames);
  const cut = Math.floor(es.length / 2) + 3;               // граница сегментов внутри кадра
  const seg1 = buildTs(slice(es.subarray(0, cut), [400, 400]));
  const seg2 = buildTs(slice(es.subarray(cut), [350, 350]));
  const m4a = parseM4a(toBuf(extract([seg1, seg2]).chunks));
  assert.equal(m4a.frames.length, 30);
  m4a.frames.forEach((f, i) => assert.ok(f.equals(frames[i].raw), 'кадр ' + i));
});

test('структура файла: ftyp, moov, mdat; смещение stco указывает на данные', () => {
  const frames = makeFrames(12);
  const buf = toBuf(extract([buildTs([concat(frames)])], { title: 'Название' }).chunks);
  const m4a = parseM4a(buf);
  assert.deepEqual(m4a.top, ['ftyp', 'moov', 'mdat']);
  assert.equal(m4a.offset, m4a.mdat.dataStart);
  assert.equal(m4a.mdat.end, buf.length, 'mdat занимает остаток файла');
});

test('частота, каналы и длительность', () => {
  const out = extract([buildTs([concat(makeFrames(43))])]);   // 43 кадра × 1024 / 44100
  assert.equal(out.sampleRate, 44100);
  assert.equal(out.channels, 2);
  assert.ok(Math.abs(out.durationSec - 43 * 1024 / 44100) < 1e-9);
});

test('моно 48 кГц определяется из заголовка ADTS', () => {
  const frames = Array.from({ length: 5 }, (_, i) => adtsFrame(80, i, { sfi: 3, channels: 1 }));
  const out = extract([buildTs([concat(frames)])]);
  assert.equal(out.sampleRate, 48000);
  assert.equal(out.channels, 1);
});

test('кириллица в названии попадает в тег ©nam', () => {
  const buf = toBuf(extract([buildTs([concat(makeFrames(3))])], { title: 'Привет, мир' }).chunks);
  assert.ok(buf.includes(Buffer.from('Привет, мир', 'utf8')));
  assert.ok(buf.includes(Buffer.from([0xa9, 0x6e, 0x61, 0x6d])));
});

test('без названия блок метаданных не создаётся', () => {
  const buf = toBuf(extract([buildTs([concat(makeFrames(3))])]).chunks);
  assert.ok(!buf.includes(Buffer.from('udta')));
});

test('мусор в потоке между кадрами пропускается (ресинхронизация)', () => {
  const frames = makeFrames(6);
  const es = Buffer.concat([frames[0].adts, Buffer.from([1, 2, 3]), ...frames.slice(1).map((f) => f.adts)]);
  const m4a = parseM4a(toBuf(extract([buildTs([es])]).chunks));
  assert.equal(m4a.frames.length, 6);
});

test('нет звуковой дорожки — понятная ошибка', () => {
  const ts = buildTs([Buffer.alloc(100)], { audioType: null });
  assert.throws(() => extract([ts]), /нет звуковой дорожки/);
});

test('MP3 в потоке — ошибка, а не пустой файл', () => {
  const ts = buildTs([concat(makeFrames(3))], { audioType: 0x03 });
  assert.throws(() => extract([ts]), /нельзя сохранить как M4A/);
});

test('не-TS данные отвергаются', () => {
  assert.throws(() => extract([Buffer.alloc(1000, 7)]), /не похож на MPEG-TS/);
});

test('сегменты без звука (пустой push) не ломают сборку', () => {
  const frames = makeFrames(8);
  const ex = A.createExtractor();
  ex.push(new Uint8Array(buildTs([concat(frames.slice(0, 4))])));
  ex.push(new Uint8Array(buildTs([Buffer.alloc(0)])));      // PES без данных
  ex.push(new Uint8Array(buildTs([concat(frames.slice(4))])));
  assert.equal(parseM4a(toBuf(ex.finish().chunks)).frames.length, 8);
});

test('теги: название, автор, альбом, дата, номер серии и обложка попадают в ilst', () => {
  const frames = makeFrames(8);
  const cover = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x11, 0x22, 0x33, 0xFF, 0xD9]);
  const out = extract([buildTs([concat(frames)])], {
    tags: { title: 'Серия 3', artist: 'Автор', album: 'Подкаст', track: 3, total: 12,
            date: '2026-11-02', cover: new Uint8Array(cover) }
  });
  const buf = toBuf(out.chunks);
  const latin = buf.toString('latin1');

  for (const atom of ['\u00a9nam', '\u00a9ART', 'aART', '\u00a9alb', '\u00a9day', 'trkn', 'covr']) {
    assert.ok(latin.includes(atom), 'нет атома ' + atom);
  }
  for (const value of ['Серия 3', 'Автор', 'Подкаст', '2026-11-02']) {
    assert.ok(buf.includes(Buffer.from(value, 'utf8')), 'нет значения ' + value);
  }

  // trkn: 0,0,номер,всего — ровно шесть байт
  const t = buf.indexOf(Buffer.from('trkn', 'latin1'));
  assert.ok(t > 0);
  const payload = buf.subarray(t + 4 + 8 + 8, t + 4 + 8 + 8 + 6);   // header(4)+data header(8+8)
  assert.deepEqual([...payload], [0, 0, 0, 3, 0, 12]);

  // covr: тип 13 — JPEG, байты обложки внутри
  const c = buf.indexOf(Buffer.from('covr', 'latin1'));
  assert.ok(c > 0);
  assert.ok(buf.subarray(c).includes(cover), 'байты обложки в файле');
});

test('без тегов файл собирается как раньше: ни udta, ни мусора', () => {
  const out = extract([buildTs([concat(makeFrames(4))])], {});
  const latin = toBuf(out.chunks).toString('latin1');
  assert.ok(!latin.includes('udta'));
  assert.ok(parseM4a(toBuf(out.chunks)).frames.length === 4);
});

/* ------------------------------------------------ реальный ffmpeg (если есть) */

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync('ffprobe', ['-version']).status === 0;

test('реальный HLS от ffmpeg: ffprobe видит AAC, файл декодируется без ошибок',
  { skip: !hasFfmpeg && 'ffmpeg не установлен' }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-audio-'));
    const gen = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=25',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100', '-t', '12', '-c:v', 'libx264',
      '-preset', 'ultrafast', '-c:a', 'aac', '-b:a', '96k', '-f', 'hls', '-hls_time', '3',
      '-hls_segment_filename', path.join(dir, 's%d.ts'), '-hls_playlist_type', 'vod', path.join(dir, 'o.m3u8')]);
    assert.equal(gen.status, 0, String(gen.stderr));
    const segs = fs.readdirSync(dir).filter((f) => f.endsWith('.ts')).sort().map((f) => fs.readFileSync(path.join(dir, f)));
    assert.ok(segs.length >= 2);

    const out = extract(segs, { title: 'Проверка' });
    const file = path.join(dir, 'out.m4a');
    fs.writeFileSync(file, toBuf(out.chunks));

    const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,sample_rate,channels:format=duration:format_tags=title',
      '-of', 'json', file]);
    const info = JSON.parse(probe.stdout);
    assert.equal(info.streams[0].codec_name, 'aac');
    assert.equal(info.streams[0].sample_rate, '44100');
    assert.equal(info.format.tags.title, 'Проверка');
    assert.ok(Math.abs(parseFloat(info.format.duration) - 12) < 0.2, 'длительность ' + info.format.duration);

    const dec = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'null', '-']);
    assert.equal(dec.status, 0);
    assert.equal(String(dec.stderr).trim(), '', 'ffmpeg ничего не ругает при декодировании');
    fs.rmSync(dir, { recursive: true, force: true });
  });

test('теги видны ffprobe: автор, альбом, номер серии, обложка как картинка',
  { skip: !hasFfmpeg && 'ffmpeg не установлен' }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-tags-'));
    const gen = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3',
      '-c:a', 'aac', '-b:a', '64k', '-f', 'hls', '-hls_time', '1',
      '-hls_segment_filename', path.join(dir, 's%d.ts'), path.join(dir, 'o.m3u8')]);
    assert.equal(gen.status, 0, String(gen.stderr));
    const coverFile = path.join(dir, 'cover.jpg');
    const jpg = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=#f2413a:s=320x320:d=1',
      '-frames:v', '1', coverFile]);
    assert.equal(jpg.status, 0, String(jpg.stderr));

    const segs = fs.readdirSync(dir).filter((f) => /^s\d+\.ts$/.test(f)).sort()
      .map((f) => fs.readFileSync(path.join(dir, f)));
    const out = extract(segs, {
      tags: {
        title: 'Серия 3 — Разбор', artist: 'xxnetme', album: 'Подкаст «Разбор»',
        track: 3, total: 12, date: '2026-11-02',
        cover: new Uint8Array(fs.readFileSync(coverFile))
      }
    });
    const file = path.join(dir, 'tagged.m4a');
    fs.writeFileSync(file, toBuf(out.chunks));

    const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries',
      'stream=codec_name,codec_type,width,height:format_tags=title,artist,album,album_artist,track,date',
      '-of', 'json', file]);
    const info = JSON.parse(probe.stdout);
    const tags = info.format.tags;
    assert.equal(tags.title, 'Серия 3 — Разбор');
    assert.equal(tags.artist, 'xxnetme');
    assert.equal(tags.album_artist, 'xxnetme');
    assert.equal(tags.album, 'Подкаст «Разбор»');
    assert.equal(tags.track, '3/12');
    assert.equal(tags.date, '2026-11-02');

    const pic = info.streams.find((st) => st.codec_type === 'video');
    assert.ok(pic, 'обложка видна как отдельный поток');
    assert.deepEqual([pic.codec_name, pic.width, pic.height], ['mjpeg', 320, 320]);

    const dec = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-map', '0:a', '-f', 'null', '-']);
    assert.equal(dec.status, 0);
    assert.equal(String(dec.stderr).trim(), '', 'звук декодируется без ругани');
    fs.rmSync(dir, { recursive: true, force: true });
  });
