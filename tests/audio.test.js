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
