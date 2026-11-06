/* RuTube Tools 2.0 — Dedicated Worker для OPFS. Без сети и стороннего кода. */
'use strict';

var root = null;
var input = null;
var output = null;
var state = null;
var busy = Promise.resolve();

function names(key) {
  return {
    input: 'rt-v2-' + key + '.input',
    output: 'rt-v2-' + key + '.mp4',
    index: 'rt-v2-' + key + '.json'
  };
}

async function directory() {
  if (!root) root = await navigator.storage.getDirectory();
  return root;
}

async function closeHandles() {
  if (input) { try { input.close(); } catch (e) {} input = null; }
  if (output) { try { output.close(); } catch (e) {} output = null; }
}

async function remove(name) {
  try { await (await directory()).removeEntry(name); } catch (e) {}
}

async function removeAll(key) {
  var n = names(key);
  await closeHandles();
  await remove(n.input);
  await remove(n.output);
  await remove(n.index);
  state = null;
}

async function readIndex(file, key, total, fingerprint) {
  try {
    var data = JSON.parse(await file.text());
    if (!data || data.version !== 1 || data.key !== key || data.total !== total ||
        data.fingerprint !== fingerprint || !Number.isInteger(data.nextSegment) ||
        !Number.isInteger(data.bytes) || data.nextSegment < 0 || data.nextSegment > total ||
        data.bytes < 0) return null;
    return data;
  } catch (e) { return null; }
}

async function writeIndex() {
  var n = names(state.key);
  var handle = await (await directory()).getFileHandle(n.index, { create: true });
  var access = await handle.createSyncAccessHandle();
  try {
    var bytes = new TextEncoder().encode(JSON.stringify({
      version: 1,
      key: state.key,
      total: state.total,
      fingerprint: state.fingerprint,
      nextSegment: state.nextSegment,
      bytes: state.bytes,
      updatedAt: Date.now()
    }));
    access.truncate(0);
    var written = access.write(bytes, { at: 0 });
    if (written !== bytes.byteLength) throw new Error('opfs-index-write');
    access.flush();
  } finally {
    access.close();
  }
}

async function open(payload) {
  var key = payload.key;
  var total = payload.total;
  var fingerprint = payload.fingerprint;
  if (!key || !Number.isInteger(total) || total < 0) throw new Error('opfs-bad-open');
  await closeHandles();
  var n = names(key);
  var dir = await directory();
  var restored = null;
  try {
    var indexFile = await (await dir.getFileHandle(n.index)).getFile();
    var inputFile = await (await dir.getFileHandle(n.input)).getFile();
    var candidate = await readIndex(indexFile, key, total, fingerprint);
    if (candidate && candidate.bytes === inputFile.size) {
      restored = { index: candidate, file: inputFile, handle: await dir.getFileHandle(n.input) };
    }
  } catch (e) { restored = null; }

  if (!restored) {
    await remove(n.input);
    await remove(n.output);
    await remove(n.index);
    restored = { index: null, file: null, handle: await dir.getFileHandle(n.input, { create: true }) };
  }

  state = {
    key: key,
    total: total,
    fingerprint: fingerprint,
    nextSegment: restored.index ? restored.index.nextSegment : 0,
    bytes: restored.index ? restored.index.bytes : 0
  };
  input = await restored.handle.createSyncAccessHandle();
  if (!restored.index) {
    input.truncate(0);
    input.flush();
    await writeIndex();
  }
  return { nextSegment: state.nextSegment, bytes: state.bytes };
}

async function handleMessage(type, payload) {
  if (type === 'cleanup-stale') {
    var dir = await directory();
    var cutoff = Date.now() - payload.maxAgeMs;
    var stale = [];
    if (dir.entries) {
      for await (var entry of dir.entries()) {
        var name = entry[0], handle = entry[1];
        if (name.indexOf('rt-v2-') !== 0 || handle.kind !== 'file') continue;
        try {
          var file = await handle.getFile();
          if (file.lastModified < cutoff) stale.push(name);
        } catch (e) {}
      }
    }
    for (var i = 0; i < stale.length; i++) await remove(stale[i]);
    return { removed: stale.length };
  }
  if (type === 'cleanup-all') {
    await removeAll(payload.key);
    return { ok: true };
  }
  if (type === 'open') return open(payload);
  if (!state) throw new Error('opfs-not-open');

  if (type === 'write') {
    if (payload.index !== state.nextSegment) throw new Error('opfs-index-order');
    var bytes = new Uint8Array(payload.data);
    var written = input.write(bytes, { at: state.bytes });
    if (written !== bytes.byteLength) throw new Error('opfs-short-write');
    input.flush();
    state.bytes += bytes.byteLength;
    state.nextSegment += 1;
    try {
      await writeIndex();
    } catch (error) {
      state.bytes -= bytes.byteLength;
      state.nextSegment -= 1;
      throw error;
    }
    return { nextSegment: state.nextSegment, bytes: state.bytes };
  }
  if (type === 'input-file') {
    if (input) { input.flush(); input.close(); input = null; }
    return (await directory()).getFileHandle(names(state.key).input).then(function (h) { return h.getFile(); });
  }
  if (type === 'output-write') {
    if (!output) {
      var outputHandle = await (await directory()).getFileHandle(names(state.key).output, { create: true });
      output = await outputHandle.createSyncAccessHandle();
      output.truncate(0);
    }
    var data = new Uint8Array(payload.data);
    var count = output.write(data, { at: payload.position });
    if (count !== data.byteLength) throw new Error('opfs-short-write');
    return { ok: true };
  }
  if (type === 'output-close') {
    if (output) { output.flush(); output.close(); output = null; }
    return { ok: true };
  }
  if (type === 'output-abort') {
    if (output) { output.close(); output = null; }
    await remove(names(state.key).output);
    return { ok: true };
  }
  if (type === 'output-file') {
    if (output) { output.flush(); output.close(); output = null; }
    return (await directory()).getFileHandle(names(state.key).output).then(function (h) { return h.getFile(); });
  }
  if (type === 'cleanup-input') {
    if (input) { input.close(); input = null; }
    await remove(names(state.key).input);
    await remove(names(state.key).index);
    return { ok: true };
  }
  if (type === 'close') {
    var key = state.key;
    var outputName = names(key).output;
    await closeHandles();
    if (payload.discardOutput) await remove(outputName);
    if (payload.cleanup) await removeAll(key);
    state = null;
    return { ok: true };
  }
  throw new Error('opfs-unknown-message');
}

self.onmessage = function (event) {
  var msg = event.data || {};
  busy = busy.then(async function () {
    try {
      var result = await handleMessage(msg.type, msg.payload || {});
      self.postMessage({ id: msg.id, result: result });
    } catch (error) {
      self.postMessage({
        id: msg.id,
        error: {
          code: error && /quota/i.test(error.name || '') ? 'opfs-quota' : 'opfs-error',
          message: String((error && error.message) || error)
        }
      });
    }
  });
};
