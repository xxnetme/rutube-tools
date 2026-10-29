/* RuTube Tools — background.
 * Firefox: фоновая страница (есть URL.createObjectURL).
 * Chromium: service worker (createObjectURL нет) → сборка файла в offscreen-документе.
 *
 * Протокол прогресса (без текстов — их локализует content):
 *   {phase:'meta'|'playlist'|'parts'|'download'|'save'|'done'|'error'|'cancelled',
 *    percent, done, total, bytes, part, parts, quality, mode, files[], downloadIds[],
 *    queue:{index,total,title,videoId,paused}}
 */
'use strict';
(function () {
  if (typeof self !== 'undefined' && typeof self.window === 'undefined') self.window = self;

  if (typeof importScripts === 'function' &&
      (typeof RTLib === 'undefined' || typeof muxjs === 'undefined')) {
    try {
      if (typeof muxjs === 'undefined') importScripts('lib/mux-mp4.min.js');
      if (typeof RTLib === 'undefined') importScripts('lib/engine.js');
    } catch (e) { console.warn('[RT] importScripts:', e); }
  }

  var api = globalThis.browser || globalThis.chrome;
  var jobs = new Map();      // jobId -> {controller, tabId, queue:{paused,resume}}
  var urlById = new Map();   // downloadId -> objectURL

  var CAN_OFFSCREEN = !!api.offscreen;
  var offscreenOk = false;

  // последняя ошибка — для кнопки «Скопировать диагностику»
  var lastError = null;

  /* ------------------------------------------------------------ утилиты */

  function sendTab(tabId, msg) {
    if (tabId === undefined || tabId === null) return;
    try {
      var p = api.tabs.sendMessage(tabId, msg);
      if (p && p.catch) p.catch(function () {});
    } catch (e) {}
  }

  function sendExt(msg) {
    return new Promise(function (resolve) {
      try {
        var p = api.runtime.sendMessage(msg);
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

  async function downloadUrl(url, filename) {
    try {
      return { id: await api.downloads.download({ url: url, filename: filename, conflictAction: 'uniquify' }), name: filename };
    } catch (e) {
      var ascii = RTLib.toAsciiFilename(filename);
      if (ascii === filename) throw e;
      return { id: await api.downloads.download({ url: url, filename: ascii, conflictAction: 'uniquify' }), name: ascii };
    }
  }

  function retainUrl(url, downloadId) {
    if (downloadId !== undefined && downloadId !== null) urlById.set(downloadId, url);
    else setTimeout(function () { try { URL.revokeObjectURL(url); } catch (e) {} }, 5 * 60000);
  }

  try {
    api.downloads.onChanged.addListener(function (d) {
      if (!d.state) return;
      var st = d.state.current;
      if (st === 'complete' || st === 'interrupted') {
        var u = urlById.get(d.id);
        if (u) {
          urlById.delete(d.id);
          setTimeout(function () { try { URL.revokeObjectURL(u); } catch (e) {} }, 5 * 60000);
        }
      }
    });
  } catch (e) {}

  /* -------------------------------------------------- сборка и сохранение */

  async function buildPartBlobUrl(job, segments, mode) {
    if (CAN_OFFSCREEN) {
      await ensureOffscreen();
      var runId = job.jobId + ':' + (job.partIndex || 0);
      var res = await sendExt({
        type: 'rt:offscreen-run',
        cfg: { runId: runId, segments: segments, mode: mode, concurrency: 5 }
      });
      if (!res || !res.ok) {
        var err = new Error((res && res.error) || 'build-failed');
        err.segmentIndex = /Сегмент (\d+)/.exec((res && res.error) || '') ? 1 : null;
        throw err;
      }
      return { url: res.url, ext: res.ext };
    }
    var out = await RTLib.downloadPart({
      segments: segments,
      mode: mode,
      muxjs: globalThis.muxjs,
      concurrency: 5,
      signal: job.controller.signal,
      onProgress: job.onProgress
    });
    var blob = new Blob(out.chunks, { type: out.mime });
    out.chunks = null;
    return { url: URL.createObjectURL(blob), ext: out.ext };
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
        var dl = await downloadUrl(built.url, filename);
        retainUrl(built.url, dl.id);
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
      if (queueInfo) p.queue = queueInfo;
      sendTab(job.tabId, p);
      if (p.phase === 'download' && typeof p.percent === 'number') setBadge(p.percent + '%', '#ff3b3b');
      else if (p.phase === 'meta' || p.phase === 'playlist' || p.phase === 'parts') setBadge('…', '#ff3b3b');
      else if (p.phase === 'done' || p.phase === 'error' || p.phase === 'cancelled') setBadge('');
    }

    try {
      post({ phase: 'meta' });
      var info = await RTLib.getVideoInfo(opts.videoId, { signal: job.controller.signal });
      if (info.isLive) throw new Error('live');
      if (info.drmProtected) throw new Error('drm');

      var variant = RTLib.pickVariant(info.variants, opts.height);
      var mode = variant.compatible ? 'mp4' : 'ts';

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
      var parts = RTLib.planParts(durations, variant.bandwidth, maxPartBytes);
      var base = RTLib.sanitizeFilename(info.title);
      if (opts.from != null || opts.to != null) {
        base += ' (' + RTLib.formatTime(realFrom).replace(/:/g, '-') + '-' + RTLib.formatTime(realTo).replace(/:/g, '-') + ')';
      }

      post({
        phase: 'parts',
        parts: parts.length,
        segments: segments.length,
        quality: variant.label,
        mode: mode,
        range: (opts.from != null || opts.to != null) ? { from: realFrom, to: realTo } : null
      });

      var saved = [], savedIds = [];
      var mirrorIndex = media.mirrorIndex || 0;

      for (var i = 0; i < parts.length; i++) {
        if (job.controller.signal.aborted) throw new Error('cancelled');
        var p = parts[i];
        var startedAt = Date.now();
        var filename = base +
          (parts.length > 1 ? ' — ' + (i + 1) + '/' + parts.length : '') +
          (mode === 'mp4' ? '.mp4' : '.ts');

        job.partIndex = i;
        job.partStart = startSeg + p.start;
        job.partEnd = startSeg + p.end;

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
      }

      post({
        phase: queueInfo ? 'queue-video-done' : 'done',
        files: saved,
        downloadIds: savedIds,
        quality: variant.label,
        mode: mode,
        mirror: job.mirror || mirrorIndex
      });
      lastError = null;
      return { ok: true, files: saved };
    } catch (e) {
      var msg = (e && e.message) || String(e);
      var cancelled = /cancelled|Отменено/i.test(msg);
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
      // в очереди одно упавшее видео не должно закрывать всю панель
      if (!queueInfo || cancelled) {
        post({ phase: cancelled ? 'cancelled' : 'error', error: code, detail: msg });
      }
      return { ok: false, error: code === 'live' || code === 'drm' || code === 'empty-range' ? code : msg };
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
      var count = endIndex - startIndex;

      for (var i = startIndex; i < endIndex; i++) {
        if (job.controller.signal.aborted) throw new Error('cancelled');
        await waitIfPaused(job);
        if (job.controller.signal.aborted) throw new Error('cancelled');

        var v = await videoAt(i);
        if (!v) break;

        var queueInfo = {
          index: i - startIndex + 1,
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
          maxPartMB: opts.maxPartMB,
          from: null,
          to: null
        }, queueInfo);

        if (r.ok) saved = saved.concat(r.files);
        else if (job.controller.signal.aborted) throw new Error('cancelled');
        else failed.push({ title: v.title, error: r.error });

        if (opts.delayMs) await new Promise(function (res) { setTimeout(res, opts.delayMs); });
      }

      post({
        phase: 'queue-done',
        files: saved,
        failed: failed,
        queue: { index: count, total: count, title: pl.title, done: true }
      });
      setBadge('');
    } catch (e) {
      var msg = (e && e.message) || String(e);
      var cancelled = /cancelled|Отменено/i.test(msg);
      lastError = { code: 'playlist', message: msg, playlistId: opts.playlistId, at: new Date().toISOString() };
      post({ phase: cancelled ? 'cancelled' : 'error', error: cancelled ? 'cancelled' : 'playlist', detail: msg });
      setBadge('');
    }
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

      case 'rt:start': {
        var tabId = sender && sender.tab && sender.tab.id;
        var jobId = 'job_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
        var controller = new AbortController();
        var job = { jobId: jobId, controller: controller, tabId: tabId, onProgress: null };
        jobs.set(jobId, job);
        runVideo(job, {
          videoId: msg.videoId,
          height: msg.height,
          from: msg.from != null ? msg.from : null,
          to: msg.to != null ? msg.to : null,
          maxPartMB: msg.maxPartMB
        }, null).finally(function () { jobs.delete(jobId); });
        return { ok: true, jobId: jobId };
      }

      case 'rt:start-playlist': {
        var tabId2 = sender && sender.tab && sender.tab.id;
        var jobId2 = 'pl_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
        var ctrl2 = new AbortController();
        var job2 = {
          jobId: jobId2, controller: ctrl2, tabId: tabId2,
          queue: { paused: false, resume: null }, onProgress: null
        };
        jobs.set(jobId2, job2);
        runPlaylist(job2, {
          playlistId: msg.playlistId,
          height: msg.height,
          fromIndex: msg.fromIndex,
          toIndex: msg.toIndex,
          delayMs: msg.delayMs || 800,
          maxPartMB: msg.maxPartMB
        }).finally(function () { jobs.delete(jobId2); });
        return { ok: true, jobId: jobId2 };
      }

      case 'rt:pause': {
        var jp = jobs.get(msg.jobId);
        if (!jp || !jp.queue) return { ok: false };
        jp.queue.paused = true;
        setBadge('❚❚', '#8a8a93');
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
          try { job3.controller.abort(); } catch (e) {}
          if (job3.queue && job3.queue.resume) job3.queue.resume();
          if (CAN_OFFSCREEN) sendExt({ type: 'rt:offscreen-cancel', runId: msg.jobId + ':0' });
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
          var name = RTLib.sanitizeFilename(msg.filename || 'file');
          var dl;
          try {
            dl = await downloadUrl(msg.url, name);
          } catch (e) {
            // прямое скачивание не прошло — тянем в blob
            var resp = await fetch(msg.url, { credentials: 'omit' });
            if (!resp.ok) throw new Error('HTTP ' + resp.status);
            var b = await resp.blob();
            var u = URL.createObjectURL(b);
            dl = await downloadUrl(u, name);
            retainUrl(u, dl.id);
          }
          return { ok: true, name: dl.name, id: dl.id };
        } catch (e) {
          return { ok: false, error: (e && e.message) || String(e) };
        }
      }

      case 'rt:save-data-url': {
        try {
          var fname = RTLib.sanitizeFilename(msg.filename || 'кадр.png');
          var blobUrl;
          if (CAN_OFFSCREEN) {
            await ensureOffscreen();
            var off = await sendExt({ type: 'rt:offscreen-data-url', dataUrl: msg.dataUrl });
            if (!off || !off.ok) throw new Error((off && off.error) || 'offscreen');
            blobUrl = off.url;
          } else {
            var r2 = await fetch(msg.dataUrl);
            blobUrl = URL.createObjectURL(await r2.blob());
          }
          var dl2 = await downloadUrl(blobUrl, fname);
          retainUrl(blobUrl, dl2.id);
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
          try { job.controller.abort(); } catch (e) {}
          if (job.queue && job.queue.resume) job.queue.resume();
          if (CAN_OFFSCREEN) sendExt({ type: 'rt:offscreen-cancel', runId: job.jobId + ':0' });
          setBadge('');
        }
      });
    });
  } catch (e) {}

  api.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || typeof msg.type !== 'string') return false;

    // прогресс из offscreen-документа → в вкладку
    if (msg.type === 'rt:offscreen-progress') {
      jobs.forEach(function (job, jobId) {
        if (msg.runId && msg.runId.indexOf(jobId + ':') === 0) {
          var part = parseInt(msg.runId.split(':')[1], 10) + 1;
          setBadge((msg.percent || 0) + '%', '#ff3b3b');
          sendTab(job.tabId, {
            type: 'rt:progress',
            jobId: jobId,
            phase: 'download',
            part: part,
            parts: part,
            done: msg.done,
            total: msg.total,
            percent: msg.percent,
            bytes: msg.bytes
          });
        }
      });
      return false;
    }

    var handled = ['rt:ping', 'rt:keepalive', 'rt:info', 'rt:playlist-info', 'rt:start',
      'rt:start-playlist', 'rt:pause', 'rt:resume', 'rt:cancel', 'rt:show-download',
      'rt:diagnostics', 'rt:save-url', 'rt:save-data-url'];
    if (handled.indexOf(msg.type) === -1) return false;

    route(msg, sender).then(sendResponse, function (e) {
      sendResponse({ ok: false, error: (e && e.message) || String(e) });
    });
    return true;
  });

  console.log('[RuTube Tools] background готов');
})();
