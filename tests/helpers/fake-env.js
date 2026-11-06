'use strict';
/* Фальшивые браузер и RuTube для сквозных тестов background.js. */
const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');
const { adtsFrame, buildTs } = require('./ts-builder.js');

const BG = path.resolve(__dirname, '../../src/background.js');
const muxSandbox = { window: {} };
vm.createContext(muxSandbox);
vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../../src/lib/mux-mp4.min.js'), 'utf8'), muxSandbox);
const REAL_PROBE = muxSandbox.muxjs.probe;
const VALID_MP4 = (() => {
  const g = muxSandbox.muxjs.generator;
  const video = {
    id: 1, type: 'video', width: 64, height: 64, profileIdc: 66, profileCompatibility: 192, levelIdc: 10,
    sps: [new Uint8Array([0x67, 0x42, 0xc0, 0x0a, 0xda, 0x1e, 0xd9])],
    pps: [new Uint8Array([0x68, 0xce, 0x06, 0xe2])], baseMediaDecodeTime: 0,
    samples: [{ duration: 9000, size: 1, compositionTimeOffset: 0, flags: {
      isLeading: 0, dependsOn: 1, isDependedOn: 0, hasRedundancy: 0, paddingValue: 0,
      isNonSyncSample: 0, degradationPriority: 0
    } }]
  };
  const audio = {
    id: 2, type: 'audio', samplerate: 44100, channelcount: 2, samplesize: 16,
    audioobjecttype: 2, samplingfrequencyindex: 4, baseMediaDecodeTime: 0,
    samples: [{ duration: 8192, size: 1 }]
  };
  const join = (...parts) => {
    const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
    let at = 0;
    parts.forEach((part) => { out.set(part, at); at += part.length; });
    return out;
  };
  return {
    init: g.initSegment([video, audio]),
    media: join(g.moof(1, [video, audio]), g.mdat(new Uint8Array([1, 2])))
  };
})();

/** Один «запуск браузера». store можно передать от предыдущего — так имитируется перезапуск. */
function createBrowser(store, options) {
  store = store || {};
  options = options || {};
  const listeners = [];
  const downloads = [];
  const tabMsgs = [];
  const tabRemoved = [];
  const downloadListeners = [];
  const api = {
    runtime: {
      getManifest: () => ({ version: 'test' }),
      onMessage: { addListener: (f) => listeners.push(f) },
      sendMessage: async () => ({ ok: false }),
      getPlatformInfo: async () => ({})
    },
    storage: {
      local: {
        get: async (d) => Object.assign({}, d, JSON.parse(JSON.stringify(store))),
        set: async (o) => { Object.assign(store, JSON.parse(JSON.stringify(o))); }
      }
    },
    downloads: {
      download: async (o) => { downloads.push(o); return downloads.length; },
      onChanged: { addListener: (f) => downloadListeners.push(f) },
      show() {}
    },
    tabs: {
      sendMessage: async (id, msg) => { tabMsgs.push(msg); },
      onRemoved: { addListener: (f) => tabRemoved.push(f) }
    },
    action: { setBadgeText() {}, setBadgeBackgroundColor() {} }
  };

  globalThis.browser = api;
  globalThis.RTNetwork = require('../../src/lib/network.js');
  globalThis.RTLib = require('../../src/lib/engine.js');
  globalThis.RTAudio = require('../../src/lib/audio.js');
  // Минимальный double реального mux.js 7: Transmuxer экспортируется наверху.
  globalThis.muxjs = { probe: REAL_PROBE, Transmuxer: class {
    constructor() { this.handlers = {}; this.first = true; }
    on(name, fn) { this.handlers[name] = fn; }
    push() {
      this.handlers.data({
        initSegment: this.first ? VALID_MP4.init : null,
        data: options.corruptMp4 ? VALID_MP4.media.slice(0, 20) : VALID_MP4.media
      });
      this.first = false;
    }
    flush() {}
  } };
  delete require.cache[BG];
  require(BG);

  return {
    store, downloads, tabMsgs,
    call(msg, sender) {
      return new Promise((resolve) => listeners[0](msg, sender || { tab: { id: 7 } }, resolve));
    },
    closeTab(id) { tabRemoved.forEach((f) => f(id)); },
    completeDownload(id) { downloadListeners.forEach((f) => f({ id, state: { current: 'complete' } })); },
    completeDownloadWith(id) { this.completeDownload(id); },
    pending() { return (store.rtPending || []).slice(); },
    async waitFor(pred, ms) {
      const until = Date.now() + (ms || 8000);
      while (Date.now() < until) {
        const hit = tabMsgs.find(pred);
        if (hit) return hit;
        await new Promise((r) => setTimeout(r, 15));
      }
      throw new Error('не дождались события; получено: ' + JSON.stringify(tabMsgs.slice(-4)));
    },
    async idle(pred, ms) {            // ждём, пока предикат станет истинным
      const until = Date.now() + (ms || 8000);
      while (Date.now() < until) {
        if (await pred()) return true;
        await new Promise((r) => setTimeout(r, 15));
      }
      throw new Error('условие не выполнилось');
    }
  };
}

/**
 * Сервер RuTube. videos: { id: { title, durationSec, variants:[{height, bandwidth, codecs, mirrors:[host…], segments, aac}] } }
 * failures: Set строк-подстрок URL, на которые отдаётся 500.
 */
function createServer(videos, opts) {
  opts = opts || {};
  const log = [];
  const failures = new Set();
  const playlists = opts.playlists || {};
  const json = (o) => ({ ok: true, status: 200, text: async () => JSON.stringify(o), arrayBuffer: async () => Buffer.from(JSON.stringify(o)) });
  const text = (t) => ({ ok: true, status: 200, text: async () => t });
  const body = (b) => ({ ok: true, status: 200, arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) });

  function segmentBuffer(v, i) {
    if (v.aac) {
      const frames = Array.from({ length: 8 }, (_, k) => adtsFrame(100 + k, i * 8 + k + 1));
      return buildTs([Buffer.concat(frames.map((f) => f.adts))]);
    }
    return Buffer.from('seg-' + v.height + '-' + i);
  }

  globalThis.fetch = async (url) => {
    url = String(url);
    log.push(url);
    for (const f of failures) if (url.includes(f)) return { ok: false, status: 500 };

    let m = url.match(/rutube\.ru\/api\/play\/options\/([0-9a-f]{32})\//);
    if (m) {
      const v = videos[m[1]];
      if (!v) return { ok: false, status: 404 };
      return json({
        title: v.title,
        author: v.author ? { name: v.author } : undefined,
        thumbnail_url: v.thumbnail ? (typeof v.thumbnail === 'string' ? v.thumbnail : 'https://cdn.rutube.ru/' + m[1] + '/cover.jpg') : undefined,
        duration: v.durationSec * 1000,
        video_balancer: { default: 'https://cdn.rutube.ru/' + m[1] + '/master.m3u8' }
      });
    }
    m = url.match(/cdn\.rutube\.ru\/([0-9a-f]{32})\/master\.m3u8/);
    if (m) {
      const v = videos[m[1]];
      return text('#EXTM3U\n' + v.variants.map((x) => x.mirrors.map((h) =>
        '#EXT-X-STREAM-INF:BANDWIDTH=' + x.bandwidth + ',RESOLUTION=' + Math.round(x.height * 16 / 9) + 'x' + x.height +
        ',CODECS="' + x.codecs + '"\nhttps://' + h + '/' + m[1] + '/' + x.height + '/index.m3u8\n').join('')).join(''));
    }
    m = url.match(/https:\/\/([\w.-]+)\/([0-9a-f]{32})\/(\d+)\/index\.m3u8/);
    if (m) {
      const x = videos[m[2]].variants.find((q) => String(q.height) === m[3]);
      const segmentDuration = x.aac ? (8 * 1024 / 44100) : 4.0;
      return text('#EXTM3U\n' + Array.from({ length: x.segments }, (_, i) =>
        '#EXTINF:' + segmentDuration + ',\nhttps://' + m[1] + '/' + m[2] + '/' + m[3] + '/seg' + i + '.ts\n').join('') + '#EXT-X-ENDLIST\n');
    }
    m = url.match(/https:\/\/([\w.-]+)\/([0-9a-f]{32})\/(\d+)\/seg(\d+)\.ts/);
    if (m) {
      const x = videos[m[2]].variants.find((q) => String(q.height) === m[3]);
      return body(segmentBuffer(x, Number(m[4])));
    }
    if (/^https:\/\/cdn\.rutube\.ru\/sub\//.test(url)) {
      return { ok: true, status: 200, blob: async () => new Blob(['1\n00:00:00,000 --> 00:00:01,000\nТест\n']) };
    }
    m = url.match(/^https:\/\/cdn\.rutube\.ru\/([0-9a-f]{32})\/cover\.jpg$/);
    if (m && videos[m[1]].thumbnail) {
      return { ok: true, status: 200, arrayBuffer: async () => {
        const b = Buffer.from('\xff\xd8\xff\xe0test-jpeg\xff\xd9', 'latin1');
        return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
      } };
    }
    m = url.match(/playlist\/custom\/(\w+)\/videos\/\?limit=(\d+)&offset=(\d+)/);
    if (m) {
      const p = playlists[m[1]];
      return json({ results: p.videos.slice(Number(m[3]), Number(m[3]) + Number(m[2])).map((id) => ({ id, title: videos[id].title, duration: videos[id].durationSec })) });
    }
    m = url.match(/playlist\/custom\/(\w+)\/\?format=json/);
    if (m) return json({ title: playlists[m[1]].title, videos_count: playlists[m[1]].videos.length });
    return { ok: false, status: 404 };
  };

  return { log, failures, segmentFetches: (id, h) => log.filter((u) => u.includes(id + '/' + h + '/seg')) };
}

const vid = (n) => String(n).repeat(32).slice(0, 32);

module.exports = { createBrowser, createServer, vid, VALID_MP4, MUXJS: muxSandbox.muxjs };
