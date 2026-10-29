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

  async function run(cfg) {
    var ctrl = new AbortController();
    jobs.set(cfg.runId, ctrl);
    try {
      var out = await L.downloadPart({
        segments: cfg.segments,
        mode: cfg.mode,
        concurrency: cfg.concurrency || 5,
        muxjs: globalThis.muxjs,
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
      sendResponse({ ok: !!(L && globalThis.muxjs) });
      return true;
    }

    if (msg.type === 'rt:offscreen-data-url') {
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
      if (!L || !globalThis.muxjs) {
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
