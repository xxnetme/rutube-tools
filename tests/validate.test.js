'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../src/lib/engine.js');
const A = require('../src/lib/audio.js');
const { VALID_MP4, MUXJS } = require('./helpers/fake-env.js');
const { adtsFrame, buildTs } = require('./helpers/ts-builder.js');

const EXPECTED = 8 * 1024 / 44100;

function invalid(promiseOrFn) {
  assert.throws(promiseOrFn, (error) => error && error.code === 'invalid-output');
}

test('validatePart: настоящий fMP4 содержит AVC/AAC и длительность из trun', () => {
  const result = L.validatePart({
    chunks: [VALID_MP4.init, VALID_MP4.media], mode: 'mp4', muxjs: MUXJS, expectedDurationSec: EXPECTED
  });
  assert.equal(result.tracks.length, 2);
  assert.equal(result.tracks.find((track) => track.type === 'video').codec.startsWith('avc1'), true);
  assert.ok(Math.abs(result.durationSec - EXPECTED) < 0.001);
  assert.equal(result.bytes, VALID_MP4.init.length + VALID_MP4.media.length);
});

test('validatePart: повреждённые боксы и пустой output отклоняются', () => {
  invalid(() => L.validatePart({ chunks: [VALID_MP4.init, VALID_MP4.media.slice(0, 20)], mode: 'mp4', muxjs: MUXJS }));
  invalid(() => L.validatePart({ chunks: [], mode: 'mp4', muxjs: MUXJS }));
});

test('validatePart: расхождение длительности не проходит', () => {
  invalid(() => L.validatePart({
    chunks: [VALID_MP4.init, VALID_MP4.media], mode: 'mp4', muxjs: MUXJS, expectedDurationSec: 4
  }));
});

test('validatePart: M4A проверяется по mdhd без объединения audio chunks', () => {
  const extractor = A.createExtractor({ title: 'Проверка' });
  const frames = Array.from({ length: 8 }, (_, i) => adtsFrame(100 + i, i + 1).adts);
  extractor.push(new Uint8Array(buildTs([Buffer.concat(frames)])));
  const out = extractor.finish();
  const result = L.validatePart({ chunks: out.chunks, mode: 'm4a', muxjs: MUXJS, expectedDurationSec: EXPECTED });
  assert.equal(result.tracks[0].type, 'audio');
  assert.ok(Math.abs(result.durationSec - EXPECTED) < 0.001);
});
