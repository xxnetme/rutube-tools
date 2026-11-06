/*
 * RuTube Tools 2.0 — потоковая упаковка без перекодирования.
 * Mediabunny bundled в autonomous build; сетевых обращений этот модуль не делает.
 */
import {
  Input,
  BlobSource,
  Output,
  Mp4OutputFormat,
  BufferTarget,
  StreamTarget,
  Conversion,
  MPEG_TS,
  MP4,
} from 'mediabunny';

const INPUT_FORMATS = [MPEG_TS, MP4];
const VIDEO_CODECS = new Set(['avc', 'hevc', 'av1']);
const AUDIO_CODECS = new Set(['aac']);
const OPFS_PREFIX = 'rt-v2-';

function mediaError(code, message) {
  return Object.assign(new Error(message || code), { code });
}

function sourceInput(blob, formats = INPUT_FORMATS) {
  return new Input({ source: new BlobSource(blob), formats });
}

async function inputTracks(input, needVideo = true) {
  const tracks = await input.getTracks();
  const video = tracks.filter((track) => track.type === 'video');
  const audio = tracks.filter((track) => track.type === 'audio');
  if (needVideo && !video.length) return null;
  for (const track of tracks) {
    if (track.type === 'video' && !VIDEO_CODECS.has(track.codec)) {
      throw mediaError('unsupported-video-codec', `Неподдерживаемый видеокодек: ${track.codec || 'unknown'}`);
    }
    if (track.type === 'audio' && !AUDIO_CODECS.has(track.codec)) {
      throw mediaError('unsupported-audio-codec', `Неподдерживаемый аудиокодек: ${track.codec || 'unknown'}`);
    }
  }
  return { tracks, video, audio };
}

function checkDuration(durationSec, expectedDurationSec) {
  if (!(durationSec > 0) || !Number.isFinite(durationSec)) {
    throw mediaError('invalid-output', 'Длительность собранного MP4 не определена');
  }
  const expected = Number(expectedDurationSec);
  if (expected > 0 && Number.isFinite(expected)) {
    const tolerance = Math.max(0.75, expected * 0.05);
    if (Math.abs(durationSec - expected) > tolerance) {
      throw mediaError(
        'invalid-output',
        `Длительность ${durationSec.toFixed(2)} с вместо ожидаемых ${expected.toFixed(2)} с`,
      );
    }
  }
}

async function validateMp4(blob, expectedDurationSec) {
  const input = sourceInput(blob, [MP4]);
  try {
    const info = await inputTracks(input, true);
    const durationSec = await input.computeDuration();
    checkDuration(durationSec, expectedDurationSec);
    return {
      bytes: blob.size,
      durationSec,
      tracks: info.tracks.map((track) => ({ type: track.type, codec: track.codec })),
    };
  } finally {
    input.dispose();
  }
}

async function executeConversion(input, target, signal) {
  const output = new Output({
    format: new Mp4OutputFormat({ fastStart: 'fragmented' }),
    target,
  });
  const conversion = await Conversion.init({
    input,
    output,
    copy: { mode: 'forced' },
    video: { forceTranscode: false },
    audio: { forceTranscode: false },
    showWarnings: false,
  });
  if (!conversion.isValid || conversion.discardedTracks.length) {
    throw mediaError('invalid-conversion', 'Дорожки нельзя перенести в MP4 без перекодирования');
  }
  const onAbort = () => { conversion.cancel().catch(() => {}); };
  if (signal) {
    if (signal.aborted) throw mediaError('cancelled', 'Отменено пользователем');
    signal.addEventListener('abort', onAbort, { once: true });
  }
  try {
    await conversion.execute();
  } catch (error) {
    if (signal && signal.aborted) throw mediaError('cancelled', 'Отменено пользователем');
    throw error;
  } finally {
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

/** Упаковывает уже скачанные TS/fMP4 chunks. Исходные chunks не объединяются в ArrayBuffer. */
export async function transmuxChunks(chunks, cfg = {}) {
  const sourceChunks = chunks || [];
  if (!sourceChunks.length) throw mediaError('empty-input', 'Пустой медиапоток');
  const input = sourceInput(new Blob(sourceChunks, { type: 'application/octet-stream' }));
  try {
    const info = await inputTracks(input, true);
    if (!info) {
      // Например AV1 в MPEG-TS: не выдаём аудио-only MP4 за видео.
      return {
        chunks: sourceChunks,
        mime: 'video/mp2t',
        ext: 'ts',
        bytes: sourceChunks.reduce((sum, chunk) => sum + chunk.byteLength, 0),
      };
    }
    const target = new BufferTarget();
    await executeConversion(input, target, cfg.signal);
    if (!target.buffer) throw mediaError('invalid-output', 'Пустой MP4');
    const blob = new Blob([target.buffer], { type: 'video/mp4' });
    const valid = await validateMp4(blob, cfg.expectedDurationSec);
    return Object.assign({ chunks: [new Uint8Array(target.buffer)], mime: 'video/mp4', ext: 'mp4' }, valid);
  } finally {
    input.dispose();
  }
}

class WorkerRpc {
  constructor(worker) {
    this.worker = worker;
    this.serial = 0;
    this.pending = new Map();
    worker.onmessage = (event) => {
      const msg = event.data || {};
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.pending.delete(msg.id);
      if (msg.error) {
        const error = mediaError(msg.error.code || 'opfs-error', msg.error.message);
        pending.reject(error);
      } else pending.resolve(msg.result);
    };
    worker.onerror = (event) => {
      const error = mediaError('opfs-worker', event.message || 'OPFS Worker failed');
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
    };
  }

  call(type, payload = {}, transfer = []) {
    const id = ++this.serial;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try { this.worker.postMessage({ id, type, payload }, transfer); }
      catch (error) { this.pending.delete(id); reject(error); }
    });
  }
}

function workerUrl() {
  const api = globalThis.browser || globalThis.chrome;
  return api && api.runtime && typeof api.runtime.getURL === 'function'
    ? api.runtime.getURL('lib/opfs-worker.js')
    : 'lib/opfs-worker.js';
}

function safeKey(value) {
  return String(value || 'job').replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 140) || 'job';
}

class OpfsSession {
  constructor(rpc, key, opened, onIndex) {
    this.rpc = rpc;
    this.key = key;
    this.nextSegment = opened.nextSegment;
    this.bytes = opened.bytes;
    this.onIndex = onIndex || (() => {});
    this.closed = false;
  }

  async write(data, index) {
    const copy = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    const result = await this.rpc.call('write', { index, data: copy }, [copy]);
    this.nextSegment = result.nextSegment;
    this.bytes = result.bytes;
    await this.onIndex({ key: this.key, nextSegment: this.nextSegment, bytes: this.bytes });
  }

  async getInputFile() {
    return this.rpc.call('input-file');
  }

  createOutputTarget() {
    const rpc = this.rpc;
    const writable = new WritableStream({
      async write(chunk) {
        const data = chunk.data;
        const copy = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
        await rpc.call('output-write', { position: chunk.position, data: copy }, [copy]);
      },
      async close() { await rpc.call('output-close'); },
      async abort() { await rpc.call('output-abort'); },
    });
    return new StreamTarget(writable, { chunked: true, chunkSize: 4 * 1024 * 1024 });
  }

  async getOutputFile() {
    return this.rpc.call('output-file');
  }

  async finishSuccess() {
    await this.rpc.call('cleanup-input');
    await this.close();
  }

  async close(options = {}) {
    if (this.closed) return;
    this.closed = true;
    try { await this.rpc.call('close', options); }
    finally { this.rpc.worker.terminate(); }
  }
}

async function opfsSupported(expectedBytes) {
  if (typeof Worker !== 'function' || !globalThis.navigator || !navigator.storage) return false;
  if (typeof navigator.storage.getDirectory !== 'function') return false;
  if (navigator.storage.estimate && Number(expectedBytes) > 0) {
    const estimate = await navigator.storage.estimate();
    if (Number.isFinite(estimate.quota) && Number.isFinite(estimate.usage)) {
      // Вход и результат сосуществуют только на время упаковки; запас нужен под индекс и фрагменты.
      const required = Number(expectedBytes) * 2 + 16 * 1024 * 1024;
      if (estimate.quota - estimate.usage < required) return false;
    }
  }
  return true;
}

/** Открывает дисковый input и восстанавливает индекс после перезапуска. */
export async function createOpfsSession(cfg = {}) {
  if (!(await opfsSupported(cfg.expectedBytes))) throw mediaError('opfs-unavailable', 'OPFS недоступен или мало места');
  const rpc = new WorkerRpc(new Worker(workerUrl()));
  try {
    await rpc.call('cleanup-stale', { maxAgeMs: 14 * 24 * 3600 * 1000 }).catch(() => {});
    const key = safeKey(cfg.key);
    const opened = await rpc.call('open', {
      key,
      total: cfg.total,
      fingerprint: String(cfg.fingerprint || ''),
    });
    return new OpfsSession(rpc, key, opened, cfg.onIndex);
  } catch (error) {
    rpc.worker.terminate();
    if (error && error.code) throw error;
    throw mediaError('opfs-unavailable', (error && error.message) || String(error));
  }
}

/** Упаковка OPFS input → OPFS fMP4. File отдаётся в downloads без чтения всего файла в RAM. */
export async function transmuxOpfs(session, cfg = {}) {
  let keepInput = false;
  try {
    const inputFile = await session.getInputFile();
    const input = sourceInput(inputFile);
    let outputOpened = false;
    try {
      const info = await inputTracks(input, true);
      if (!info) {
        keepInput = true;
        await session.close();
        return { file: inputFile, mime: 'video/mp2t', ext: 'ts', bytes: inputFile.size, opfsKey: session.key };
      }
      const target = session.createOutputTarget();
      outputOpened = true;
      await executeConversion(input, target, cfg.signal);
      const outputFile = await session.getOutputFile();
      const valid = await validateMp4(outputFile, cfg.expectedDurationSec);
      await session.finishSuccess();
      return Object.assign({ file: outputFile, mime: 'video/mp4', ext: 'mp4', opfsKey: session.key }, valid);
    } finally {
      input.dispose();
      if (outputOpened && !session.closed) await session.close({ discardOutput: true });
    }
  } catch (error) {
    if (!session.closed) await session.close({ discardOutput: !keepInput });
    throw error;
  }
}

/** Удаляет вход, индекс и результат после того, как браузер забрал Blob URL. */
export async function cleanupOpfs(key) {
  if (typeof Worker !== 'function') return;
  const rpc = new WorkerRpc(new Worker(workerUrl()));
  try { await rpc.call('cleanup-all', { key: safeKey(key) }); }
  finally { rpc.worker.terminate(); }
}

export function cleanupOpfsLater(key, delayMs = 5 * 60000) {
  if (!key) return;
  const timer = setTimeout(() => { cleanupOpfs(key).catch(() => {}); }, delayMs);
  const maybeNodeTimer = /** @type {any} */ (timer);
  if (maybeNodeTimer && typeof maybeNodeTimer.unref === 'function') maybeNodeTimer.unref();
}

export const OPFS_FILE_PREFIX = OPFS_PREFIX;
