'use strict';
/* global self, navigator, performance, Uint8Array, Uint32Array, Blob */

const FILE_NAME = 'rutube-opfs-benchmark.bin';
const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let value = n;
  for (let bit = 0; bit < 8; bit++) value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
  CRC_TABLE[n] = value >>> 0;
}

function crcUpdate(crc, bytes) {
  let value = crc;
  for (let i = 0; i < bytes.length; i++) value = CRC_TABLE[(value ^ bytes[i]) & 0xff] ^ (value >>> 8);
  return value >>> 0;
}

function makeChunk(index, length) {
  const chunk = new Uint8Array(length);
  for (let i = 0; i < length; i++) chunk[i] = (i + index * 17) & 0xff;
  return chunk;
}

async function storageEstimate() {
  try {
    const estimate = await navigator.storage.estimate();
    return { usage: estimate.usage || 0, quota: estimate.quota || 0 };
  } catch (error) {
    return { error: String(error) };
  }
}

async function verifyStream(source) {
  const reader = source.stream().getReader();
  let crc = 0xffffffff;
  let bytes = 0;
  while (true) {
    const item = await reader.read();
    if (item.done) break;
    crc = crcUpdate(crc, item.value);
    bytes += item.value.byteLength;
  }
  return { bytes, crc32: ((crc ^ 0xffffffff) >>> 0).toString(16).padStart(8, '0') };
}

async function benchmark(options) {
  const started = performance.now();
  const root = options.mode === 'opfs' ? await navigator.storage.getDirectory() : null;
  if (root) {
    try { await root.removeEntry(FILE_NAME); } catch {}
  }
  const storageBefore = await storageEstimate();

  let access = null;
  let handle = null;
  let blob = null;
  const chunks = [];
  if (options.mode === 'opfs') {
    handle = await root.getFileHandle(FILE_NAME, { create: true });
    access = await handle.createSyncAccessHandle();
    await access.truncate(0);
  }

  let generateMs = 0;
  let writeOrRetainMs = 0;
  let written = 0;
  let index = 0;
  while (written < options.bytes) {
    const length = Math.min(options.chunkBytes, options.bytes - written);
    let mark = performance.now();
    const chunk = makeChunk(index, length);
    generateMs += performance.now() - mark;

    mark = performance.now();
    if (access) {
      const count = access.write(chunk);
      if (count !== length) throw new Error(`OPFS write: ${count} != ${length}`);
    } else {
      chunks.push(chunk);
    }
    writeOrRetainMs += performance.now() - mark;
    written += length;
    index++;
  }

  let mark = performance.now();
  let source;
  if (access) {
    access.flush();
    access.close();
    access = null;
    source = await handle.getFile();
  } else {
    blob = new Blob(chunks, { type: 'application/octet-stream' });
    chunks.length = 0;
    source = blob;
  }
  const finalizeMs = performance.now() - mark;
  const storageAfterWrite = await storageEstimate();

  mark = performance.now();
  const verified = await verifyStream(source);
  const readMs = performance.now() - mark;

  if (handle) await root.removeEntry(FILE_NAME);
  const storageAfterCleanup = await storageEstimate();
  return {
    mode: options.mode,
    requestedBytes: options.bytes,
    chunkBytes: options.chunkBytes,
    size: source.size,
    crc32: verified.crc32,
    verifiedBytes: verified.bytes,
    timingMs: {
      generate: generateMs,
      writeOrRetain: writeOrRetainMs,
      finalize: finalizeMs,
      readAndVerify: readMs,
      total: performance.now() - started
    },
    storageBefore,
    storageAfterWrite,
    storageAfterCleanup,
    capabilities: {
      worker: true,
      opfs: options.mode === 'opfs',
      syncAccessHandle: options.mode === 'opfs' ? typeof handle.createSyncAccessHandle === 'function' : null,
      blobStream: typeof source.stream === 'function'
    },
    userAgent: navigator.userAgent
  };
}

self.onmessage = async (event) => {
  let root = null;
  try {
    const options = event.data;
    if (!['opfs', 'blob'].includes(options.mode)) throw new Error('unknown mode');
    if (!Number.isSafeInteger(options.bytes) || options.bytes <= 0) throw new Error('bad byte count');
    if (!Number.isSafeInteger(options.chunkBytes) || options.chunkBytes <= 0) throw new Error('bad chunk size');
    root = options.mode === 'opfs' ? await navigator.storage.getDirectory() : null;
    const result = await benchmark(options);
    self.postMessage({ ok: true, result });
  } catch (error) {
    self.postMessage({ ok: false, error: String(error), stack: error && error.stack ? String(error.stack) : '' });
  } finally {
    if (root) {
      try { await root.removeEntry(FILE_NAME); } catch {}
    }
  }
};
