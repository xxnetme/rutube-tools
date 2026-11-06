/* RuTube Tools — background.
 * Firefox: фоновая страница (есть URL.createObjectURL).
 * Chromium: service worker (createObjectURL нет) → сборка файла в offscreen-документе.
 *
 * Протокол прогресса (без текстов — их локализует content):
 *   {phase:'meta'|'playlist'|'parts'|'download'|'save'|'done'|'error'|'cancelled',
 *    percent, done, total, bytes, part, parts, quality, mode, files[], downloadIds[],
 *    queue:{index,total,title,videoId,paused}}
 *
 * Незавершённые загрузки хранятся в storage.local['rtPending'] и переживают перезапуск браузера
 * (и убийство service worker в Chromium). Докачка идёт с границы частей/видео: уже сохранённые
 * на диск файлы не скачиваются заново.
 */
'use strict';
(function () {
  if (typeof self !== 'undefined' && typeof self.window === 'undefined') self.window = self;

  if (typeof importScripts === 'function' &&
      (typeof RTNetwork === 'undefined' || typeof RTLib === 'undefined' ||
       typeof muxjs === 'undefined' || typeof RTAudio === 'undefined' || typeof RTMedia === 'undefined' || typeof RTProtocol === 'undefined')) {
    try {
      if (typeof RTProtocol === 'undefined') importScripts('lib/protocol.js');
      if (typeof RTNetwork === 'undefined') importScripts('lib/network.js');
      if (typeof muxjs === 'undefined') importScripts('lib/mux-mp4.min.js');
      if (typeof RTMedia === 'undefined') importScripts('lib/media.js');
      if (typeof RTLib === 'undefined') importScripts('lib/engine.js');
      if (typeof RTAudio === 'undefined') importScripts('lib/audio.js');
    } catch (e) { console.warn('[RT] importScripts:', e); }
  }

  var api = globalThis.browser || globalThis.chrome;
  var jobs = new Map();      // jobId -> {controller, tabId, queue:{paused,resume}}
  var urlById = new Map();   // downloadId -> objectURL
  var opfsById = new Map();  // downloadId -> OPFS key, чистим после ответа браузера

  var CAN_OFFSCREEN = !!api.offscreen;
  var offscreenOk = false;

  // последняя ошибка — для кнопки «Скопировать диагностику»
  var lastError = null;

  /* ------------------------------------------------ незавершённые загрузки */

  var PENDING_KEY = 'rtPending';
  var HISTORY_KEY = 'rtHistory';
  var HISTORY_MAX = 30;

  /* История сохранённых файлов. Пишем только свои загрузки: downloadUrl()
   * помечает id, а onChanged дописывает имя, когда файл дошёл до конца. */
  var historyNames = new Map();      // downloadId -> имя, как его видел пользователь
  var historyChain = Promise.resolve();

  function historyMutate(fn) {
    historyChain = historyChain.then(async function () {
      var got = await api.storage.local.get({ rtHistory: [] });
      var list = Array.isArray(got[HISTORY_KEY]) ? got[HISTORY_KEY] : [];
      var next = (fn(list) || list).slice(0, HISTORY_MAX);
      await api.storage.local.set({ rtHistory: next });
      return next;
    }).catch(function () {});
    return historyChain;
  }

  function historyAdd(rec) {
    return historyMutate(function (list) {
      var rest = list.filter(function (r) { return r.id !== rec.id; });
      return [rec].concat(rest);
    });
  }
  var PENDING_TTL = 14 * 24 * 3600 * 1000;
  var pendingChain = Promise.resolve();

  // Все изменения идут через одну цепочку: два параллельных read-modify-write затёрли бы друг друга.
  function pendingMutate(fn, readOnly) {
    pendingChain = pendingChain.then(async function () {
      var got = await api.storage.local.get({ rtPending: [] });
      var list = Array.isArray(got[PENDING_KEY]) ? got[PENDING_KEY] : [];
      var now = Date.now();
      list = list.filter(function (r) { return r && r.id && now - (r.updatedAt || 0) < PENDING_TTL; });
      var next = fn(list) || list;
      if (!readOnly) await api.storage.local.set({ rtPending: next });
      return next;
    }).catch(function () {});
    return pendingChain;
  }

  function pendingUpsert(rec) {
    rec.updatedAt = Date.now();
    return pendingMutate(function (list) {
      var i = list.findIndex(function (r) { return r.id === rec.id; });
      if (i === -1) list.push(rec); else list[i] = Object.assign(list[i], rec);
      return list;
    });
  }

  function pendingPatch(id, patch) {
    if (!id) return Promise.resolve();
    return pendingMutate(function (list) {
      list.forEach(function (r) { if (r.id === id) Object.assign(r, patch, { updatedAt: Date.now() }); });
      return list;
    });
  }

  function pendingRemove(id) {
    if (!id) return Promise.resolve();
    return pendingMutate(function (list) { return list.filter(function (r) { return r.id !== id; }); });
  }

  function pendingRead() {
    return pendingMutate(function (list) { return list; }, true).then(function (l) { return l || []; });
  }

  // Service worker в Chromium засыпает через ~30 с без обращений к API расширений —
  // пока идёт загрузка, раз в 20 с дёргаем безобидный вызов.
  var swTimer = null;
  function keepAliveWhileBusy() {
    if (swTimer || !jobs.size) return;
    swTimer = setInterval(function () {
      if (!jobs.size) { clearInterval(swTimer); swTimer = null; return; }
      try { var p = api.runtime.getPlatformInfo(); if (p && p.catch) p.catch(function () {}); } catch (e) {}
    }, 20000);
    if (swTimer && swTimer.unref) swTimer.unref();        // в Node (тесты) таймер не держит процесс
  }

  /* ------------------------------------------------------------ утилиты */

  function sendTab(tabId, msg) {
    if (tabId === undefined || tabId === null) return;
    try {
      var p = api.tabs.sendMessage(tabId, globalThis.RTProtocol ? globalThis.RTProtocol.stamp(msg) : msg);
      if (p && p.catch) p.catch(function () {});
    } catch (e) {}
  }

  function sendExt(msg) {
    return new Promise(function (resolve) {
      try {
        var p = api.runtime.sendMessage(globalThis.RTProtocol ? globalThis.RTProtocol.stamp(msg) : msg);
        if (p && p.then) p.then(resolve, function (e) { resolve({ ok: false, error: String((e && e.message) || e) }); });
        else resolve({ ok: false, error: 'no-response' });
      } catch (e) { resolve({ ok: false, error: String((e && e.message) || e) }); }
    });
  }

  var actionApi = api.action || api.browserAction || null;
  function setBadge(text, color) {
    if (!actionApi) return;
    try {
      actionApi.setBadgeText({ text: text || '' });
      if (color) actionApi.setBadgeBackgroundColor({ color: color });
    } catch (e) {}
  }

  async function ensureOffscreen() {
    if (!CAN_OFFSCREEN) return;
    if (offscreenOk) return;
    var exists = false;
    try { if (api.offscreen.hasDocument) exists = await api.offscreen.hasDocument(); } catch (e) {}
    if (!exists) {
      try {
        await api.offscreen.createDocument({
          url: 'offscreen.html',
          reasons: ['BLOBS'],
          justification: 'Сборка MP4 и создание ссылки для сохранения файла'
        });
      } catch (e) {}
    }
    for (var i = 0; i < 16; i++) {
      var r = await sendExt({ type: 'rt:offscreen-ping' });
      if (r && r.ok) { offscreenOk = true; return; }
      await new Promise(function (res) { setTimeout(res, 250); });
    }
    throw new Error('offscreen-not-responding');
  }

  /* Chrome передаёт сообщения через JSON, поэтому Uint8Array теряется по дороге
   * в offscreen. Обложку отправляем строкой base64 — она переживает и это. */
  function toBase64(u8) {
    var s = '';
    for (var i = 0; i < u8.length; i += 0x8000) {
      s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    }
    var enc = globalThis.btoa;
    if (typeof enc === 'function') return enc(s);
    return Buffer.from(u8).toString('base64');
  }

  /** Обложка для тега M4A: тянем превью один раз, ошибку глотаем — теги важнее картинки. */
  async function fetchCover(url) {
    if (!url) return null;
    try {
      var r = await RTNetwork.fetch(url, { credentials: 'omit' });
      if (!r.ok) return null;
      var buf = new Uint8Array(await r.arrayBuffer());
      if (!buf.length || buf.length > 2 * 1024 * 1024) return null;
      return toBase64(buf);
    } catch (e) {
      return null;
    }
  }

  async function downloadUrl(url, filename) {
    var res;
    try {
      res = { id: await api.downloads.download({ url: url, filename: filename, conflictAction: 'uniquify' }), name: filename };
    } catch (e) {
      var ascii = RTLib.toAsciiFilename(filename);
      if (ascii === filename) throw e;
      res = { id: await api.downloads.download({ url: url, filename: ascii, conflictAction: 'uniquify' }), name: ascii };
    }
    if (res.id !== undefined && res.id !== null) historyNames.set(res.id, res.name);
    return res;
  }

  /** Субтитры и превью небольшие: скачиваем через проверенный fetch в blob.
   * Прямой downloads.download(remoteUrl) не используем — его редиректы расширение не контролирует. */
  async function saveRemote(url, name) {
    var resp = await RTNetwork.fetch(url, { credentials: 'omit' });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    var u = URL.createObjectURL(await resp.blob());
    try {
      var dl = await downloadUrl(u, name);
      retainUrl(u, dl.id);
      return dl;
    } catch (e) {
      try { URL.revokeObjectURL(u); } catch (ignore) {}
      throw e;
    }
  }

  /* Текстовые файлы проходят тот же offscreen-путь в Chromium, что и кадры/главы. */
  async function saveTextData(dataUrl, filename) {
    if (!RTNetwork.isAllowedDataUrl(dataUrl)) throw new Error('bad-data-url');
    var fname = RTLib.sanitizeFilename(filename || 'file.txt');
    var blobUrl;
    if (CAN_OFFSCREEN) {
      await ensureOffscreen();
      var off = await sendExt({ type: 'rt:offscreen-data-url', dataUrl: dataUrl });
      if (!off || !off.ok) throw new Error((off && off.error) || 'offscreen');
      blobUrl = off.url;
    } else {
      var response = await fetch(dataUrl);
      blobUrl = URL.createObjectURL(await response.blob());
    }
    try {
      var dl = await downloadUrl(blobUrl, fname);
      retainUrl(blobUrl, dl.id);
      return dl;
    } catch (e) {
      try { URL.revokeObjectURL(blobUrl); } catch (ignore) {}
      throw e;
    }
  }

  async function saveVtt(url, name) {
    if (!RTNetwork.isAllowedUrl(url)) throw new Error('url-not-allowed');
    var resp = await RTNetwork.fetch(url, { credentials: 'omit' });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    var source = await resp.text();
    var vtt = RTLib.srtToVtt(source);
    return saveTextData('data:text/plain;charset=utf-8,' + encodeURIComponent(vtt), name);
  }

  /* Отложенное освобождение blob-ссылки. В Node (тесты) таймер не держит процесс. */
  function revokeLater(url) {
    var t = setTimeout(function () { try { URL.revokeObjectURL(url); } catch (e) {} }, 5 * 60000);
    if (t && t.unref) t.unref();
  }

  function retainUrl(url, downloadId) {
    if (downloadId !== undefined && downloadId !== null) urlById.set(downloadId, url);
    else revokeLater(url);
  }

  try {
    api.downloads.onChanged.addListener(function (d) {
      if (!d.state) return;
      var st = d.state.current;
      if (st === 'complete' && historyNames.has(d.id)) {
        var seen = historyNames.get(d.id);
        historyNames.delete(d.id);
        historyAdd({ id: d.id, name: seen, at: Date.now() });
      }
      if (st === 'complete' || st === 'interrupted') {
        var u = urlById.get(d.id);
        if (u) {
          urlById.delete(d.id);
          revokeLater(u);
        }
        var opfsKey = opfsById.get(d.id);
        if (opfsKey) {
          opfsById.delete(d.id);
          if (CAN_OFFSCREEN) sendExt({ type: 'rt:offscreen-cleanup', key: opfsKey });
          else if (globalThis.RTMedia && typeof globalThis.RTMedia.cleanupOpfs === 'function') {
            globalThis.RTMedia.cleanupOpfs(opfsKey).catch(function () {});
          }
        }
      }
    });
  } catch (e) {}

  /* -------------------------------------------------- сборка и сохранение */

  function mediaFingerprint(segments) {
    var hash = 2166136261;
    var text = segments.join('\n');
    for (var i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36) + ':' + segments.length;
  }

  async function buildPartBlobUrl(job, segments, mode) {
    var resumeKey = String(job.pendingId || job.jobId) + ':part:' + (job.partIndex || 0);
    var fingerprint = mediaFingerprint(segments);
    var expectedBytes = job.partExpectedBytes || 0;
    if (CAN_OFFSCREEN) {
      await ensureOffscreen();
      var runId = job.jobId + ':' + (job.partIndex || 0);
      var res = await sendExt({
        type: 'rt:offscreen-run',
        cfg: {
          runId: runId, segments: segments, mode: mode, concurrency: 5,
          title: job.title, tags: job.tags, validate: true, expectedDurationSec: job.partDurationSec,
          expectedBytes: expectedBytes, resumeKey: resumeKey, fingerprint: fingerprint,
          opfs: job.opfs === true,
          pendingId: job.segmentPendingId || null
        }
      });
      if (!res || !res.ok) {
        var err = new Error((res && res.error) || 'build-failed');
        err.segmentIndex = /Сегмент (\d+)/.exec((res && res.error) || '') ? 1 : null;
        throw err;
      }
      return { url: res.url, ext: res.ext, opfsKey: res.opfsKey || null };
    }
    var out = await RTLib.downloadPart({
      segments: segments,
      mode: mode,
      muxjs: globalThis.muxjs,
      audio: globalThis.RTAudio,
      media: globalThis.RTMedia,
      title: job.title,
      tags: job.tags,
      concurrency: 5,
      validate: true,
      expectedDurationSec: job.partDurationSec,
      expectedBytes: expectedBytes,
      resumeKey: resumeKey,
      fingerprint: fingerprint,
      opfs: job.opfs === true,
      signal: job.controller.signal,
      onSegmentSaved: function (info) {
        if (!job.segmentPendingId) return null;
        return pendingPatch(job.segmentPendingId, info.reset ? {
          segmentKey: resumeKey, nextSegment: 0, segmentBytes: 0
        } : {
          segmentKey: resumeKey, nextSegment: info.nextSegment, segmentBytes: info.bytes
        });
      },
      onStorage: function (info) {
        if (job.segmentPendingId) return pendingPatch(job.segmentPendingId, { storage: info.state });
        return null;
      },
      onProgress: job.onProgress
    });
    var blob = out.file || new Blob(out.chunks, { type: out.mime });
    out.chunks = null;
    return { url: URL.createObjectURL(blob), ext: out.ext, opfsKey: out.opfsKey || null };
  }

  /* ------------------------------------------------------------- одна часть */

  async function runPart(job, variant, segs, mode, filename) {
    var mirrors = (variant.mirrors && variant.mirrors.length ? variant.mirrors : [variant.url]).slice();
    var attempts = Math.min(mirrors.length, 2);
    var lastErr = null;

    for (var a = 0; a < attempts; a++) {
      if (job.controller.signal.aborted) throw new Error('cancelled');
      try {
        // для повторной попытки перечитываем плейлист с другого CDN
        var useSegs = segs;
        if (a > 0) {
          var media = await RTLib.getSegmentsWithMirrors(mirrors.slice(a), { signal: job.controller.signal });
          useSegs = media.segments.slice(job.partStart, job.partEnd);
          job.mirror = media.mirrorIndex + a;
        }
        var built = await buildPartBlobUrl(job, useSegs, mode);
        var actualFilename = filename.replace(/\.[^.]+$/, '.' + (built.ext || 'mp4'));
        var dl = await downloadUrl(built.url, actualFilename);
        retainUrl(built.url, dl.id);
        if (built.opfsKey && dl.id !== undefined && dl.id !== null) opfsById.set(dl.id, built.opfsKey);
        else if (built.opfsKey && globalThis.RTMedia) globalThis.RTMedia.cleanupOpfsLater(built.opfsKey);
        return { name: dl.name, id: dl.id, ext: built.ext };
      } catch (e) {
        if (job.controller.signal.aborted) throw new Error('cancelled');
        lastErr = e;
        job.mirrorFailures = a + 1;
      }
    }
    throw lastErr;
  }

  /* ----------------------------------------------------------------- видео */

  async function runVideo(job, opts, queueInfo) {
    function post(p) {
      p.type = 'rt:progress';
      p.jobId = job.jobId;
      p.pendingId = opts.pendingId || null;
      if (queueInfo) p.queue = queueInfo;
      (job.root || job).progress = {
        phase: p.phase, percent: p.percent, part: p.part, parts: p.parts,
        done: p.done, total: p.total, bytes: p.bytes, ms: p.ms
      };
      sendTab(job.tabId, p);
      if (p.phase === 'download' && typeof p.percent === 'number') setBadge(p.percent + '%', '#ff3b3b');
      else if (p.phase === 'meta' || p.phase === 'playlist' || p.phase === 'parts') setBadge('…', '#ff3b3b');
      else if (p.phase === 'done' || p.phase === 'error' || p.phase === 'cancelled' || p.phase === 'paused') setBadge('');
    }

    try {
      job.segmentPendingId = opts.pendingId || null;
      job.opfs = opts.opfs === true;
      post({ phase: 'meta' });
      var info = await RTLib.getVideoInfo(opts.videoId, { signal: job.controller.signal });
      if (info.isLive) throw new Error('live');
      if (info.drmProtected) throw new Error('drm');

      var audioOnly = !!opts.audio;
      var variant = audioOnly ? RTLib.pickAudioVariant(info.variants) : RTLib.pickVariant(info.variants, opts.height);
      // Media-модуль сначала пытается сохранить дорожки в fMP4; .ts — только фактический fallback.
      // В старом окружении без bundle сохраняем прежний безопасный выбор режима.
      var hasMedia = !!(globalThis.RTMedia && typeof globalThis.RTMedia.transmuxChunks === 'function');
      var mode = audioOnly ? 'm4a' : (hasMedia ? 'mp4' : (variant.compatible ? 'mp4' : 'ts'));
      job.title = info.title;

      post({ phase: 'playlist', quality: variant.label });
      var media = await RTLib.getSegmentsWithMirrors(variant.mirrors, { signal: job.controller.signal });

      if (media.encrypted) throw new Error('drm');

      // обрезка по таймкодам
      var startSeg = 0, endSeg = media.segments.length;
      var realFrom = 0, realTo = media.duration;
      if (opts.from != null || opts.to != null) {
        var range = RTLib.segmentRange(
          media.durations,
          opts.from != null ? opts.from : 0,
          opts.to != null ? opts.to : media.duration
        );
        if (!range) throw new Error('empty-range');
        startSeg = range.start;
        endSeg = range.end;
        realFrom = range.realFrom;
        realTo = range.realTo;
      }

      var durations = media.durations.slice(startSeg, endSeg);
      var segments = media.segments.slice(startSeg, endSeg);
      var maxPartBytes = Math.max(50, opts.maxPartMB || 220) * 1024 * 1024;
      // звук весит мало и в куски не режется
      var parts = audioOnly ? [{ start: 0, end: segments.length }]
                            : RTLib.planParts(durations, variant.bandwidth, maxPartBytes);
      var base = RTLib.filenameFromTemplate(opts.nameTemplate, {
        title: info.title,
        author: info.author,
        quality: variant.label,
        date: new Date().toISOString().slice(0, 10),
        playlist: opts.playlistTitle || ''
      });
      if (opts.from != null || opts.to != null) {
        base += ' (' + RTLib.formatTime(realFrom).replace(/:/g, '-') + '-' + RTLib.formatTime(realTo).replace(/:/g, '-') + ')';
      }

      if (audioOnly) {
        job.tags = {
          title: info.title,
          artist: info.author,
          album: (queueInfo && queueInfo.playlist) || opts.playlistTitle || '',
          track: queueInfo ? queueInfo.index : 0,
          total: queueInfo ? queueInfo.total : 0,
          date: new Date().toISOString().slice(0, 10),
          cover: await fetchCover(info.thumbnail)
        };
      }

      post({
        phase: 'parts',
        parts: parts.length,
        segments: segments.length,
        quality: variant.label,
        mode: mode,
        range: (opts.from != null || opts.to != null) ? { from: realFrom, to: realTo } : null
      });

      var saved = [], savedIds = [], subs = [];
      var mirrorIndex = media.mirrorIndex || 0;

      // докачка: уже сохранённые части пропускаем, если разбиение не изменилось
      var firstPart = opts.startPart || 0;
      if (firstPart >= parts.length || (opts.partsTotal && opts.partsTotal !== parts.length)) firstPart = 0;
      if (firstPart) saved = (opts.savedFiles || []).slice(0, firstPart);
      if (opts.pendingId) pendingPatch(opts.pendingId, { title: info.title, partsTotal: parts.length, status: 'running' });

      for (var i = firstPart; i < parts.length; i++) {
        if (job.controller.signal.aborted) throw new Error('cancelled');
        var p = parts[i];
        var startedAt = Date.now();
        (job.root || job).partStartedAt = startedAt;
        var filename = base +
          (parts.length > 1 ? ' — ' + (i + 1) + '/' + parts.length : '') +
          (mode === 'm4a' ? '.m4a' : mode === 'mp4' ? '.mp4' : '.ts');

        job.partIndex = i;
        job.partStart = startSeg + p.start;
        job.partEnd = startSeg + p.end;
        job.partDurationSec = durations.slice(p.start, p.end).reduce(function (sum, value) {
          return sum + (Number(value) || 0);
        }, 0);
        job.partExpectedBytes = Math.max(0, Math.round(p.bytes || (variant.bandwidth / 8 * job.partDurationSec)));

        var onProg = (function (idx, start) {
          return function (pr) {
            post({
              phase: 'download',
              part: idx + 1,
              parts: parts.length,
              done: pr.done,
              total: pr.total,
              percent: pr.percent,
              bytes: pr.bytes,
              ms: Date.now() - startedAt,
              mirror: mirrorIndex
            });
          };
        })(i, startedAt);
        job.onProgress = onProg;

        post({ phase: 'download', part: i + 1, parts: parts.length, percent: 0,
               done: 0, total: segments.slice(p.start, p.end).length, bytes: 0, ms: 0 });

        var res = await runPart(job, variant, segments.slice(p.start, p.end), mode, filename);
        saved.push(res.name);
        savedIds.push(res.id);
        if (opts.pendingId) pendingPatch(opts.pendingId, { nextPart: i + 1, savedFiles: saved.slice(), nextSegment: 0, segmentBytes: 0, segmentKey: '' });
      }

      /* Субтитры кладём рядом с видео и с тем же базовым именем — иначе VLC
       * их не подхватит. Для нарезки это «… — 1/2.srt», как и у частей.
       * Ошибка субтитров не отменяет уже сохранённое видео. */
      if (opts.subsUrl && mode !== 'm4a' && saved.length) {
        var subExt = String(opts.subsExt || 'srt').replace(/^\./, '');
        for (var si = 0; si < saved.length; si++) {
          var subName = String(saved[si]).replace(/\.[^.\/]+$/, '') + '.' + subExt;
          try {
            var subDl = await saveRemote(opts.subsUrl, subName);
            subs.push(subDl.name);
            savedIds.push(subDl.id);
          } catch (e2) { /* молча: субтитры — дополнение, а не условие */ }
        }
      }

      post({
        phase: queueInfo ? 'queue-video-done' : 'done',
        files: saved,
        subs: subs,
        downloadIds: savedIds,
        quality: variant.label,
        mode: mode,
        mirror: job.mirror || mirrorIndex
      });
      lastError = null;
      if (opts.pendingId) pendingRemove(opts.pendingId);
      return { ok: true, files: saved };
    } catch (e) {
      var msg = (e && e.message) || String(e);
      var cancelled = /cancelled|Отменено/i.test(msg);
      if (cancelled && job.abortReason === 'paused') {
        if (opts.pendingId) pendingPatch(opts.pendingId, { status: 'paused', error: '' });
        post({ phase: 'paused' });
        return { ok: false, paused: true, error: 'paused' };
      }
      var code = msg;
      if (msg === 'live') code = 'live';
      else if (msg === 'drm') code = 'drm';
      else if (msg === 'empty-range') code = 'empty-range';
      lastError = {
        code: code === 'live' || code === 'drm' || code === 'empty-range' ? code : 'download',
        message: msg,
        videoId: opts.videoId,
        height: opts.height,
        mirror: job.mirror || 0,
        part: (job.partIndex || 0) + 1,
        at: new Date().toISOString()
      };
      if (opts.pendingId) {
        var finalCodes = ['live', 'drm', 'empty-range'];
        if (finalCodes.indexOf(code) !== -1) pendingRemove(opts.pendingId);          // повторять бессмысленно
        else if (cancelled && job.abortReason !== 'tab-closed') pendingRemove(opts.pendingId);
        else pendingPatch(opts.pendingId, { status: cancelled ? 'interrupted' : 'error', error: code.slice(0, 200) });
      }
      // в очереди одно упавшее видео не должно закрывать всю панель
      if (!queueInfo || cancelled) {
        post({ phase: cancelled ? 'cancelled' : 'error', error: code, detail: msg });
      }
      return {
        ok: false,
        error: code === 'live' || code === 'drm' || code === 'empty-range' ? code : msg,
        nextPart: typeof saved !== 'undefined' ? saved.length : 0,
        partsTotal: typeof parts !== 'undefined' ? parts.length : 0,
        savedFiles: typeof saved !== 'undefined' ? saved.slice() : []
      };
    }
  }

  /* -------------------------------------------------------------- плейлист */

  function waitIfPaused(job) {
    if (!job.queue || !job.queue.paused) return Promise.resolve();
    return new Promise(function (resolve) {
      job.queue.resume = function () { job.queue.resume = null; resolve(); };
    });
  }

  async function runPlaylist(job, opts) {
    function post(p) {
      p.type = 'rt:progress';
      p.jobId = job.jobId;
      sendTab(job.tabId, p);
    }

    try {
      post({ phase: 'queue-load' });
      var pl = await RTLib.getPlaylistInfo(opts.playlistId, { signal: job.controller.signal, limit: 50 });

      var total = pl.videosCount || pl.videos.length;
      var startIndex = Math.max(0, opts.fromIndex || 0);
      var endIndex = opts.toIndex && opts.toIndex > 0 ? Math.min(opts.toIndex, total) : total;
      if (endIndex - startIndex > 500) endIndex = startIndex + 500; // предохранитель
      if (endIndex <= startIndex) throw new Error('playlist-empty');
      /* Выбор галочками приходит списком номеров: превращаем его в диапазоны
       * внутри этого плейлиста и заводим на каждый отдельную очередь. */
      var ranges = [];
      if (opts.indices != null && !opts.indices.length) {
        // выбор пуст — просто нечего делать, это не ошибка
        post({ phase: 'queue-done', files: [], failed: [], queue: { index: 0, total: 0, title: pl.title, done: true } });
        setBadge('');
        if (opts.pendingId) pendingRemove(opts.pendingId);
        return;
      }
      if (opts.indices && opts.indices.length) {
        var sorted = opts.indices
          .map(function (n) { return Math.floor(Number(n)); })
          .filter(function (n) { return n >= 0 && n < total; })
          .sort(function (a, b) { return a - b; });
        for (var ri = 0; ri < sorted.length; ri++) {
          var last = ranges[ranges.length - 1];
          if (last && sorted[ri] === last[1]) last[1] = sorted[ri] + 1;
          else ranges.push([sorted[ri], sorted[ri] + 1]);
        }
        ranges = ranges
          .map(function (r) { return [Math.max(r[0], startIndex), Math.min(r[1], endIndex)]; })
          .filter(function (r) { return r[1] > r[0]; });
      } else {
        ranges.push([startIndex, endIndex]);
      }
      if (!ranges.length) throw new Error('playlist-empty');
      if (opts.pendingId) pendingPatch(opts.pendingId, { title: pl.title, total: endIndex - (opts.originalFrom != null ? opts.originalFrom : startIndex), status: 'running' });

      var cache = {};                       // offset страницы -> массив видео
      var pageSize = pl.pageSize || 50;
      cache[0] = pl.videos;

      async function videoAt(index) {
        var pageStart = Math.floor(index / pageSize) * pageSize;
        if (!cache[pageStart]) {
          cache[pageStart] = await RTLib.getPlaylistVideos(
            opts.playlistId, pageStart, pageSize, { signal: job.controller.signal }
          );
        }
        return cache[pageStart][index - pageStart];
      }

      var saved = [], failed = [];
      var count = ranges.reduce(function (n, r) { return n + (r[1] - r[0]); }, 0);
      var doneSoFar = 0;

      for (var rg = 0; rg < ranges.length; rg++) {
      for (var i = ranges[rg][0]; i < ranges[rg][1]; i++) {
        doneSoFar++;
        if (job.controller.signal.aborted) throw new Error('cancelled');
        await waitIfPaused(job);
        if (job.controller.signal.aborted) throw new Error('cancelled');

        var v = await videoAt(i);
        if (!v) break;

        var queueInfo = {
          index: doneSoFar,
          total: count,
          title: v.title,
          videoId: v.id,
          playlist: pl.title,
          paused: !!(job.queue && job.queue.paused)
        };
        post({ phase: 'queue-item', queue: queueInfo });

        var sub = Object.create(job);
        sub.jobId = job.jobId;
        sub.tabId = job.tabId;

        var r = await runVideo(sub, {
          videoId: v.id,
          height: opts.height,
          audio: opts.audio,
          maxPartMB: opts.maxPartMB,
          opfs: opts.opfs === true,
          nameTemplate: opts.nameTemplate,
          playlistTitle: pl.title,
          from: null,
          to: null
        }, queueInfo);

        if (r.ok) saved = saved.concat(r.files);
        else if (job.controller.signal.aborted) throw new Error('cancelled');
        else {
          var failure = { title: v.title, videoId: v.id, error: r.error };
          failed.push(failure);
          // Отдельная запись позволяет повторить именно эту серию из popup и не
          // теряет уже сохранённые части, даже когда общая очередь завершилась.
          pendingUpsert({
            id: newId('video'), kind: 'video', videoId: v.id, height: opts.height, audio: !!opts.audio,
            from: null, to: null, maxPartMB: opts.maxPartMB, opfs: opts.opfs === true, nameTemplate: opts.nameTemplate || '',
            subsUrl: '', subsExt: '', title: v.title,
            nextPart: r.nextPart || 0, partsTotal: r.partsTotal || 0, savedFiles: r.savedFiles || [],
            status: 'error', error: String(r.error || 'download').slice(0, 200), createdAt: Date.now(),
            sourcePlaylistId: opts.playlistId, sourceIndex: i
          });
        }
        if (opts.pendingId) pendingPatch(opts.pendingId, { nextIndex: i + 1, doneCount: doneSoFar });

        if (opts.delayMs) await new Promise(function (res) { setTimeout(res, opts.delayMs); });
      }
      }

      post({
        phase: 'queue-done',
        files: saved,
        failed: failed,
        queue: { index: count, total: count, title: pl.title, done: true }
      });
      setBadge('');
      if (opts.pendingId) pendingRemove(opts.pendingId);
    } catch (e) {
      var msg = (e && e.message) || String(e);
      var cancelled = /cancelled|Отменено/i.test(msg);
      if (opts.pendingId) {
        if (cancelled && job.abortReason !== 'tab-closed') pendingRemove(opts.pendingId);
        else pendingPatch(opts.pendingId, { status: cancelled ? 'interrupted' : 'error', error: msg.slice(0, 200) });
      }
      lastError = { code: 'playlist', message: msg, playlistId: opts.playlistId, at: new Date().toISOString() };
      post({ phase: cancelled ? 'cancelled' : 'error', error: cancelled ? 'cancelled' : 'playlist', detail: msg });
      setBadge('');
    }
  }

  /* ------------------------------------------------------ запуск и докачка */

  function newId(prefix) {
    return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  /**
   * Запускает загрузку одного видео. resume — запись из rtPending, если это докачка:
   * тогда id записи сохраняется, а прогресс продолжается с nextPart.
   */
  function launchVideo(p, tabId, resume) {
    var jobId = newId('job');
    var job = { jobId: jobId, controller: new AbortController(), tabId: tabId, onProgress: null,
                pendingId: resume ? resume.id : jobId };
    job.root = job;
    jobs.set(jobId, job);
    keepAliveWhileBusy();

    if (!resume) {
      dropStale(function (r) { return r.kind === 'video' && r.videoId === p.videoId && !!r.audio === !!p.audio; });
    }
    pendingUpsert({
      id: job.pendingId, kind: 'video', videoId: p.videoId, height: p.height, audio: !!p.audio,
      from: p.from, to: p.to, maxPartMB: p.maxPartMB, opfs: p.opfs === true,
      nameTemplate: p.nameTemplate || '', subsUrl: p.subsUrl || '', subsExt: p.subsExt || '',
      title: resume ? resume.title : '', nextPart: resume ? resume.nextPart || 0 : 0,
      partsTotal: resume ? resume.partsTotal || 0 : 0, savedFiles: resume ? resume.savedFiles || [] : [],
      status: 'running', error: '', createdAt: resume ? resume.createdAt : Date.now()
    });

    runVideo(job, {
      videoId: p.videoId, height: p.height, audio: !!p.audio,
      from: p.from, to: p.to, maxPartMB: p.maxPartMB, opfs: p.opfs === true,
      nameTemplate: p.nameTemplate || '', subsUrl: p.subsUrl || '', subsExt: p.subsExt || '',
      pendingId: job.pendingId,
      startPart: resume ? resume.nextPart || 0 : 0,
      partsTotal: resume ? resume.partsTotal || 0 : 0,
      savedFiles: resume ? resume.savedFiles || [] : []
    }, null).finally(function () { jobs.delete(jobId); });
    return jobId;
  }

  function launchPlaylist(p, tabId, resume) {
    var jobId = newId('pl');
    var job = { jobId: jobId, controller: new AbortController(), tabId: tabId, onProgress: null,
                queue: { paused: false, resume: null }, pendingId: resume ? resume.id : jobId };
    job.root = job;
    jobs.set(jobId, job);
    keepAliveWhileBusy();

    var originalFrom = resume && resume.fromIndex != null ? resume.fromIndex : (p.fromIndex || 0);
    var startAt = resume && resume.nextIndex ? Math.max(resume.nextIndex, originalFrom) : (p.fromIndex || 0);
    if (!resume) {
      dropStale(function (r) {
        return (!!r.audio === !!p.audio) && ((r.kind === 'playlist' && r.playlistId === p.playlistId) ||
          (r.kind === 'video' && r.sourcePlaylistId === p.playlistId));
      });
    }
    pendingUpsert({
      id: job.pendingId, kind: 'playlist', playlistId: p.playlistId, height: p.height, audio: !!p.audio,
      fromIndex: originalFrom, toIndex: p.toIndex || null, nextIndex: startAt, maxPartMB: p.maxPartMB, opfs: p.opfs === true,
      nameTemplate: p.nameTemplate || '',
      indices: resume ? (resume.indices || null) : (p.indices || null),
      title: resume ? resume.title : '', status: 'running', createdAt: resume ? resume.createdAt : Date.now()
    });

    runPlaylist(job, {
      nameTemplate: p.nameTemplate || '',
      indices: resume ? (resume.indices || null) : (p.indices || null),
      playlistId: p.playlistId, height: p.height, audio: !!p.audio,
      fromIndex: startAt, originalFrom: originalFrom, toIndex: p.toIndex,
      delayMs: p.delayMs || 800, maxPartMB: p.maxPartMB, opfs: p.opfs === true, pendingId: job.pendingId
    }).finally(function () { jobs.delete(jobId); });
    return jobId;
  }

  // Новый запуск того же видео/плейлиста (например, «Повторить загрузку») заменяет старую
  // незавершённую запись, иначе в списке для докачки копились бы дубли.
  function dropStale(match) {
    var active = {};
    jobs.forEach(function (j) { if (j.pendingId) active[j.pendingId] = true; });
    return pendingMutate(function (list) {
      return list.filter(function (r) { return active[r.id] || !match(r); });
    });
  }

  async function listPending() {
    var list = await pendingRead();
    return list.map(function (r) {
      var running = null;
      jobs.forEach(function (job) { if (job.pendingId === r.id) running = job; });
      return Object.assign({}, r, {
        running: !!running,
        jobId: running ? running.jobId : null,
        paused: running ? !!(running.queue && running.queue.paused) : r.status === 'paused',
        progress: running && running.progress ? running.progress : null
      });
    }).sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); });
  }

  /* -------------------------------------------------------------- роутер */

  async function route(msg, sender) {
    if (!msg || typeof msg.type !== 'string') return;

    switch (msg.type) {
      case 'rt:ping':
        return { ok: true, version: api.runtime.getManifest().version };

      case 'rt:keepalive':
        return { ok: true };

      case 'rt:info': {
        try {
          var info = await RTLib.getVideoInfo(msg.videoId);
          var meta = msg.withMeta ? await RTLib.getVideoMeta(msg.videoId) : null;
          return {
            ok: true,
            info: {
              videoId: info.videoId,
              title: info.title,
              author: info.author,
              durationSec: info.durationSec,
              fps: info.fps,
              isLive: info.isLive,
              drmProtected: info.drmProtected,
              captions: info.captions,
              thumbnail: info.thumbnail,
              cuepoints: info.cuepoints,
              variants: info.variants,
              meta: meta
            }
          };
        } catch (e) {
          return { ok: false, error: (e && e.message) || String(e) };
        }
      }

      case 'rt:playlist-info': {
        try {
          var pl = await RTLib.getPlaylistInfo(msg.playlistId);
          return { ok: true, playlist: pl };
        } catch (e) {
          return { ok: false, error: (e && e.message) || String(e) };
        }
      }

      case 'rt:playlist-videos': {
        /* Названия серий за пределами первой страницы: панель просит их,
         * когда пользователь долистал список до незнакомых номеров. */
        try {
          var vids = await RTLib.getPlaylistVideos(msg.playlistId, msg.offset || 0, msg.limit || 50);
          return { ok: true, offset: msg.offset || 0, videos: vids };
        } catch (e) {
          return { ok: false, error: (e && e.message) || String(e) };
        }
      }

      case 'rt:start': {
        var tabId = sender && sender.tab && sender.tab.id;
        var jobId = launchVideo({
          videoId: msg.videoId,
          height: msg.height,
          audio: !!msg.audio,
          from: msg.from != null ? msg.from : null,
          to: msg.to != null ? msg.to : null,
          maxPartMB: msg.maxPartMB,
          opfs: msg.opfs === true,
          nameTemplate: msg.nameTemplate || '',
          subsUrl: msg.subsUrl || '',
          subsExt: msg.subsExt || ''
        }, tabId, null);
        return { ok: true, jobId: jobId };
      }

      case 'rt:start-playlist': {
        var tabId2 = sender && sender.tab && sender.tab.id;
        var jobId2 = launchPlaylist({
          nameTemplate: msg.nameTemplate || '',
          playlistId: msg.playlistId,
          height: msg.height,
          audio: !!msg.audio,
          fromIndex: msg.fromIndex,
          toIndex: msg.toIndex,
          indices: msg.indices,
          delayMs: msg.delayMs || 800,
          maxPartMB: msg.maxPartMB, opfs: msg.opfs === true
        }, tabId2, null);
        return { ok: true, jobId: jobId2 };
      }

      case 'rt:history-list': {
        var gotH = await api.storage.local.get({ rtHistory: [] });
        var listH = Array.isArray(gotH[HISTORY_KEY]) ? gotH[HISTORY_KEY] : [];
        return { ok: true, items: listH };
      }

      case 'rt:history-clear':
        await historyMutate(function () { return []; });
        return { ok: true };

      case 'rt:pending-list':
        return { ok: true, items: await listPending() };

      case 'rt:pending-resume': {
        var items = await listPending();
        var rec = items.filter(function (r) { return r.id === msg.id; })[0];
        if (!rec) return { ok: false, error: 'not-found' };
        if (rec.running) return { ok: true, already: true };
        var tabIdR = sender && sender.tab && sender.tab.id;
        var newJob = rec.kind === 'playlist' ? launchPlaylist(rec, tabIdR, rec) : launchVideo(rec, tabIdR, rec);
        return { ok: true, jobId: newJob };
      }

      case 'rt:pending-discard': {
        jobs.forEach(function (job) {
          if (job.pendingId === msg.id) {
            job.abortReason = 'user';
            try { job.controller.abort(); } catch (e) {}
            if (job.queue && job.queue.resume) job.queue.resume();
          }
        });
        await pendingRemove(msg.id);
        return { ok: true };
      }

      case 'rt:pause': {
        var jp = jobs.get(msg.jobId);
        if (!jp) return { ok: false };
        if (jp.queue) {
          jp.queue.paused = true;
        } else {
          jp.abortReason = 'paused';
          try { jp.controller.abort(); } catch (e) {}
          if (CAN_OFFSCREEN) {
            sendExt({ type: 'rt:offscreen-cancel', runId: jp.jobId + ':' + (jp.partIndex || 0) });
          }
        }
        setBadge('II', '#8a8a93');
        return { ok: true, paused: true };
      }

      case 'rt:resume': {
        var jr = jobs.get(msg.jobId);
        if (!jr || !jr.queue) return { ok: false };
        jr.queue.paused = false;
        if (jr.queue.resume) jr.queue.resume();
        setBadge('…', '#ff3b3b');
        return { ok: true, paused: false };
      }

      case 'rt:cancel': {
        var job3 = jobs.get(msg.jobId);
        if (job3) {
          job3.abortReason = 'user';
          try { job3.controller.abort(); } catch (e) {}
          if (job3.queue && job3.queue.resume) job3.queue.resume();
          if (CAN_OFFSCREEN) sendExt({ type: 'rt:offscreen-cancel', runId: msg.jobId + ':' + (job3.partIndex || 0) });
          setBadge('');
        }
        return { ok: !!job3 };
      }

      case 'rt:show-download': {
        try { api.downloads.show(msg.id); return { ok: true }; }
        catch (e) { return { ok: false, error: String(e) }; }
      }

      case 'rt:diagnostics':
        return {
          ok: true,
          diag: {
            version: api.runtime.getManifest().version,
            ua: (typeof navigator !== 'undefined' ? navigator.userAgent : ''),
            lastError: lastError,
            now: new Date().toISOString()
          }
        };

      case 'rt:save-url': {
        try {
          if (!RTNetwork.isAllowedUrl(msg.url)) return { ok: false, error: 'url-not-allowed' };
          var name = RTLib.sanitizeFilename(msg.filename || 'file');
          var dl = await saveRemote(msg.url, name);
          return { ok: true, name: dl.name, id: dl.id };
        } catch (e) {
          return { ok: false, error: (e && e.message) || String(e) };
        }
      }

      case 'rt:save-vtt': {
        try {
          var dlVtt = await saveVtt(msg.url, msg.filename || 'subtitles.vtt');
          return { ok: true, name: dlVtt.name, id: dlVtt.id };
        } catch (e) {
          return { ok: false, error: (e && e.message) || String(e) };
        }
      }

      case 'rt:save-data-url': {
        try {
          var dl2 = await saveTextData(msg.dataUrl, msg.filename || 'кадр.png');
          return { ok: true, name: dl2.name, id: dl2.id };
        } catch (e) {
          return { ok: false, error: (e && e.message) || String(e) };
        }
      }

      default:
        return;
    }
  }

  // закрыли вкладку — не тратим трафик
  try {
    api.tabs.onRemoved.addListener(function (tabId) {
      jobs.forEach(function (job) {
        if (job.tabId === tabId) {
          job.abortReason = 'tab-closed';          // запись о загрузке остаётся — можно докачать из popup
          try { job.controller.abort(); } catch (e) {}
          if (job.queue && job.queue.resume) job.queue.resume();
          if (CAN_OFFSCREEN) sendExt({ type: 'rt:offscreen-cancel', runId: job.jobId + ':' + (job.partIndex || 0) });
          setBadge('');
        }
      });
    });
  } catch (e) {}

  api.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || typeof msg.type !== 'string') return false;
    if (globalThis.RTProtocol && !globalThis.RTProtocol.accepts(msg)) {
      sendResponse({ ok: false, error: 'protocol-version' });
      return false;
    }

    if (msg.type === 'rt:offscreen-segment') {
      if (msg.pendingId) {
        pendingPatch(msg.pendingId, msg.reset ? {
          segmentKey: msg.key || '', nextSegment: 0, segmentBytes: 0
        } : {
          segmentKey: msg.key || '', nextSegment: msg.nextSegment || 0, segmentBytes: msg.bytes || 0
        });
      }
      return false;
    }

    if (msg.type === 'rt:offscreen-storage') {
      if (msg.pendingId) pendingPatch(msg.pendingId, { storage: msg.storage && msg.storage.state });
      return false;
    }

    // прогресс из offscreen-документа → в вкладку
    if (msg.type === 'rt:offscreen-progress') {
      jobs.forEach(function (job, jobId) {
        if (msg.runId && msg.runId.indexOf(jobId + ':') === 0) {
          var part = parseInt(msg.runId.split(':')[1], 10) + 1;
          var root = job.root || job;
          var progress = {
            type: 'rt:progress',
            jobId: jobId,
            pendingId: job.pendingId || null,
            phase: 'download',
            part: part,
            parts: (root.progress && root.progress.parts) || part,
            done: msg.done,
            total: msg.total,
            percent: msg.percent,
            bytes: msg.bytes,
            ms: root.partStartedAt ? Date.now() - root.partStartedAt : 0
          };
          root.progress = progress;
          setBadge((msg.percent || 0) + '%', '#ff3b3b');
          sendTab(job.tabId, progress);
        }
      });
      return false;
    }

    var handled = ['rt:ping', 'rt:keepalive', 'rt:info', 'rt:playlist-info', 'rt:playlist-videos', 'rt:start',
      'rt:start-playlist', 'rt:pause', 'rt:resume', 'rt:cancel', 'rt:show-download',
      'rt:diagnostics', 'rt:save-url', 'rt:save-vtt', 'rt:save-data-url',
      'rt:pending-list', 'rt:pending-resume', 'rt:pending-discard', 'rt:history-list', 'rt:history-clear'];
    if (handled.indexOf(msg.type) === -1) return false;

    route(msg, sender).then(sendResponse, function (e) {
      sendResponse({ ok: false, error: (e && e.message) || String(e) });
    });
    return true;
  });

  /* Отладка фона: chrome.storage.local.set({ rtDebug: true }) — по умолчанию молчим. */
  try {
    api.storage.local.get({ rtDebug: false }, function (v) {
      if (v && v.rtDebug) console.log('[RuTube Tools] background готов');
    });
  } catch (e) {}
})();
