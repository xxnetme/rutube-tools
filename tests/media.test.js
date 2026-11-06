'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { MUXJS } = require('./helpers/fake-env.js');
const L = require('../src/lib/engine.js');

const fixtures = path.resolve(__dirname, 'fixtures');
let media;
test.before(async () => { media = await import('../modules/media.mjs'); });

function fixture(name) {
  const buffer = fs.readFileSync(path.join(fixtures, name));
  return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}

function joined(chunks) {
  const size = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) { out.set(chunk, at); at += chunk.byteLength; }
  return out;
}

function assertBox(bytes, name) {
  const wanted = Buffer.from(name, 'ascii');
  for (let i = 4; i + 4 <= bytes.length; i++) {
    if (!Buffer.from(bytes.buffer, bytes.byteOffset + i, 4).equals(wanted)) continue;
    const size = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(i - 4);
    assert.ok(size >= 8 && i - 4 + size <= bytes.length, `${name}: повреждённый размер бокса`);
    return;
  }
  assert.fail(`В MP4 нет бокса ${name}`);
}

function assertValid(out, expectedDurationSec) {
  const result = L.validatePart({
    chunks: out.chunks, mode: 'mp4', muxjs: MUXJS, expectedDurationSec
  });
  assert.ok(result.durationSec > 0);
}

test('Media: HEVC/AAC MPEG-TS → fMP4 с hvc1/hvcC, без перекодирования', async () => {
  const source = fixture('hevc-aac.ts');
  const out = await media.transmuxChunks([source], { expectedDurationSec: 1.024 });
  assert.equal(out.ext, 'mp4');
  assert.deepEqual(out.tracks.map((track) => track.codec).sort(), ['aac', 'hevc']);
  const bytes = joined(out.chunks);
  assertBox(bytes, 'hvc1');
  assertBox(bytes, 'hvcC');
  assertBox(bytes, 'moof');
  assertBox(bytes, 'mdat');
  assertValid(out, 1.024);
});

test('Media: AV1/AAC MP4 → fMP4 с av01/av1C', async () => {
  const source = fixture('av1-aac.mp4');
  const out = await media.transmuxChunks([source], { expectedDurationSec: 1 });
  assert.equal(out.ext, 'mp4');
  assert.deepEqual(out.tracks.map((track) => track.codec).sort(), ['aac', 'av1']);
  const bytes = joined(out.chunks);
  assertBox(bytes, 'av01');
  assertBox(bytes, 'av1C');
  assertBox(bytes, 'moof');
  assertValid(out, 1);
});

test('Media: AV1 MPEG-TS не превращается молча в audio-only MP4', async () => {
  const source = fixture('av1-aac.ts');
  const out = await media.transmuxChunks([source], { expectedDurationSec: 1 });
  assert.equal(out.ext, 'ts');
  assert.equal(out.mime, 'video/mp2t');
  assert.equal(out.bytes, source.byteLength);
  assert.deepEqual(joined(out.chunks), source);
});
