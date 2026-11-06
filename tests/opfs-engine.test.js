'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../src/lib/engine.js');

const URLS = ['https://cdn.rutube.ru/0.ts', 'https://cdn.rutube.ru/1.ts'];

function response(value) {
  return { ok: true, arrayBuffer: async () => Uint8Array.from(value).buffer };
}

function fakeMedia(store, hooks = {}) {
  return {
    async createOpfsSession(cfg) {
      if (hooks.open) return hooks.open(cfg);
      return {
        nextSegment: store.nextSegment,
        bytes: store.bytes,
        async write(data, index) {
          assert.equal(index, store.nextSegment);
          store.chunks.push(Uint8Array.from(data));
          store.nextSegment++;
          store.bytes += data.byteLength;
          if (cfg.onIndex) await cfg.onIndex({ nextSegment: store.nextSegment, bytes: store.bytes });
        },
        async close() { store.closed = (store.closed || 0) + 1; }
      };
    },
    async transmuxOpfs() {
      return { file: new Blob(['opfs']), mime: 'video/mp4', ext: 'mp4', bytes: 4, opfsKey: 'test' };
    },
    async transmuxChunks(chunks) {
      return { chunks, mime: 'video/mp4', ext: 'mp4', bytes: chunks.reduce((n, x) => n + x.byteLength, 0) };
    },
    async cleanupOpfs() { store.cleaned = (store.cleaned || 0) + 1; }
  };
}

test.afterEach(() => { delete globalThis.RTNetwork; });

test('OPFS engine: после сбоя продолжает со следующего сегмента, не скачивая сохранённый', async () => {
  const store = { nextSegment: 0, bytes: 0, chunks: [] };
  const media = fakeMedia(store);
  let fail = true;
  const requests = [];
  globalThis.RTNetwork = { fetch: async (url) => {
    requests.push(url);
    if (fail && url === URLS[1]) {
      const error = new Error('stop'); error.code = 'url-not-allowed'; throw error;
    }
    return response([url === URLS[0] ? 10 : 20]);
  } };
  const first = L.downloadPart({
    segments: URLS, mode: 'mp4', media, resumeKey: 'job', opfs: true,
    fingerprint: 'same', validate: false, concurrency: 1
  });
  await assert.rejects(first, /stop/);
  assert.equal(store.nextSegment, 1);
  assert.deepEqual(store.chunks, [Uint8Array.from([10])]);

  fail = false;
  requests.length = 0;
  const progress = [];
  const out = await L.downloadPart({
    segments: URLS, mode: 'mp4', media, resumeKey: 'job', opfs: true,
    fingerprint: 'same', validate: false, concurrency: 1,
    onProgress: (p) => progress.push(p)
  });
  assert.equal(out.ext, 'mp4');
  assert.deepEqual(requests, [URLS[1]]);
  assert.deepEqual(store.chunks, [Uint8Array.from([10]), Uint8Array.from([20])]);
  assert.equal(progress[0].done, 1);
  assert.equal(progress.at(-1).done, 2);
});

test('OPFS engine: квота на output тоже очищает файл и повторяет часть в памяти', async () => {
  const store = { nextSegment: 0, bytes: 0, chunks: [] };
  const media = fakeMedia(store);
  media.transmuxOpfs = async () => {
    const error = new Error('output quota'); error.code = 'opfs-quota'; throw error;
  };
  let usedMemory = false;
  const originalTransmux = media.transmuxChunks;
  media.transmuxChunks = async (chunks) => { usedMemory = true; return originalTransmux(chunks); };
  let requests = 0;
  globalThis.RTNetwork = { fetch: async () => { requests++; return response([9]); } };
  const saved = [];
  const storage = [];
  const out = await L.downloadPart({
    segments: [URLS[0]], mode: 'mp4', media, resumeKey: 'job', opfs: true,
    validate: false, onSegmentSaved: (x) => saved.push(x), onStorage: (x) => storage.push(x)
  });
  assert.equal(out.ext, 'mp4');
  assert.equal(usedMemory, true);
  assert.equal(requests, 2);
  assert.equal(store.cleaned, 1);
  assert.equal(saved.at(-1).reset, true);
  assert.equal(storage.at(-1).state, 'memory');
});

test('OPFS engine: opfs-quota очищает незавершённый индекс и повторяет часть в памяти', async () => {
  const store = { nextSegment: 0, bytes: 0, chunks: [] };
  let usedMemory = false;
  const media = fakeMedia(store, {
    open: async () => ({
      nextSegment: 0, bytes: 0,
      async write() { const error = new Error('quota'); error.code = 'opfs-quota'; throw error; },
      async close() {}
    })
  });
  const originalTransmux = media.transmuxChunks;
  media.transmuxChunks = async (chunks) => { usedMemory = true; return originalTransmux(chunks); };
  let requests = 0;
  globalThis.RTNetwork = { fetch: async () => { requests++; return response([7]); } };
  const saved = [];
  const storage = [];
  const out = await L.downloadPart({
    segments: [URLS[0]], mode: 'mp4', media, resumeKey: 'job', opfs: true,
    validate: false, onSegmentSaved: (x) => saved.push(x), onStorage: (x) => storage.push(x)
  });
  assert.equal(out.ext, 'mp4');
  assert.equal(usedMemory, true);
  assert.equal(requests, 2);
  assert.equal(store.cleaned, 1);
  assert.equal(saved[0].reset, true);
  assert.equal(storage.at(-1).state, 'memory');
});
