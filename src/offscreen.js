/* Только для Chromium: в service worker нет URL.createObjectURL,
   поэтому сборка файла (fetch + склейка в MP4) идёт здесь, в offscreen-документе. */
'use strict';
(function () {
  var api = globalThis.browser || globalThis.chrome;
  var L = globalThis.RTLib;
  var jobs = new Map();
  var keep = [];

  function post(msg) {
    try {
      var p = api.runtime.sendMessage(msg);
      if (p && p.catch) p.catch(function () {});
    } catch (e) {}
  }

  function librariesReady() {
    var m = globalThis.muxjs;
    var transmuxer = m && (typeof m.Transmuxer === 'function' ||
      (m.mp4 && typeof m.mp4.Transmuxer === 'function'));
    return !!(L && globalThis.RTNetwork && globalThis.RTAudio && transmuxer);
  }

  async function run(cfg) {
    var ctrl = new AbortController();
    jobs.set(cfg.runId, ctrl);
    try {
      var out = await L.downloadPart({
        segments: cfg.segments,
        mode: cfg.mode,
        concurrency: cfg.concurrency || 5,
        muxjs: globalThis.muxjs,
        audio: globalThis.RTAudio,
        title: cfg.title,
        tags: cfg.tags,
        validate: true,
        expectedDurationSec: cfg.expectedDurationSec,
        signal: ctrl.signal,
        onProgress: function (p) {
          post({
            type: 'rt:offscreen-progress',
            runId: cfg.runId,
            done: p.done,
            total: p.total,
            percent: p.percent,
            bytes: p.bytes
          });
        }
      });
      var blob = new Blob(out.chunks, { type: out.mime });
      out.chunks = null;
      var url = URL.createObjectURL(blob);
      keep.push(url);
      if (keep.length > 6) {
        try { URL.revokeObjectURL(keep.shift()); } catch (e) {}
      }
      return { ok: true, url: url, bytes: out.bytes, ext: out.ext };
    } catch (e) {
      return { ok: false, error: (e && e.message) || String(e) };
    } finally {
      jobs.delete(cfg.runId);
    }
  }

  api.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || typeof msg.type !== 'string') return false;

    if (msg.type === 'rt:offscreen-ping') {
      sendResponse({ ok: librariesReady() });
      return true;
    }

    if (msg.type === 'rt:offscreen-data-url') {
      if (!globalThis.RTNetwork || !globalThis.RTNetwork.isAllowedDataUrl(msg.dataUrl)) {
        sendResponse({ ok: false, error: 'bad-data-url' });
        return true;
      }
      fetch(msg.dataUrl)
        .then(function (r) { return r.blob(); })
        .then(function (blob) {
          var url = URL.createObjectURL(blob);
          keep.push(url);
          if (keep.length > 6) { try { URL.revokeObjectURL(keep.shift()); } catch (e) {} }
          sendResponse({ ok: true, url: url });
        })
        .catch(function (e) { sendResponse({ ok: false, error: String(e && e.message || e) }); });
      return true;
    }

    if (msg.type === 'rt:offscreen-run') {
      if (!librariesReady()) {
        sendResponse({ ok: false, error: 'Библиотеки не загружены в offscreen' });
        return true;
      }
      run(msg.cfg).then(sendResponse, function (e) {
        sendResponse({ ok: false, error: (e && e.message) || String(e) });
      });
      return true;
    }

    if (msg.type === 'rt:offscreen-cancel') {
      var ctrl = jobs.get(msg.runId);
      if (ctrl) { try { ctrl.abort(); } catch (e) {} }
      sendResponse({ ok: !!ctrl });
      return true;
    }

    return false;
  });
})();
