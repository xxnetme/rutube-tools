'use strict';
/* Фальшивые браузер и RuTube для сквозных тестов background.js. */
const path = require('node:path');
const { adtsFrame, buildTs } = require('./ts-builder.js');

const BG = path.resolve(__dirname, '../../src/background.js');

/** Один «запуск браузера». store можно передать от предыдущего — так имитируется перезапуск. */
function createBrowser(store) {
  store = store || {};
  const listeners = [];
  const downloads = [];
  const tabMsgs = [];
  const tabRemoved = [];
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
      onChanged: { addListener() {} },
      show() {}
    },
    tabs: {
      sendMessage: async (id, msg) => { tabMsgs.push(msg); },
      onRemoved: { addListener: (f) => tabRemoved.push(f) }
    },
    action: { setBadgeText() {}, setBadgeBackgroundColor() {} }
  };

  globalThis.browser = api;
  globalThis.RTLib = require('../../src/lib/engine.js');
  globalThis.RTAudio = require('../../src/lib/audio.js');
  delete require.cache[BG];
  require(BG);

  return {
    store, downloads, tabMsgs,
    call(msg, sender) {
      return new Promise((resolve) => listeners[0](msg, sender || { tab: { id: 7 } }, resolve));
    },
    closeTab(id) { tabRemoved.forEach((f) => f(id)); },
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
        duration: v.durationSec * 1000,
        video_balancer: { default: 'https://cdn.test/' + m[1] + '/master.m3u8' }
      });
    }
    m = url.match(/cdn\.test\/([0-9a-f]{32})\/master\.m3u8/);
    if (m) {
      const v = videos[m[1]];
      return text('#EXTM3U\n' + v.variants.map((x) => x.mirrors.map((h) =>
        '#EXT-X-STREAM-INF:BANDWIDTH=' + x.bandwidth + ',RESOLUTION=' + Math.round(x.height * 16 / 9) + 'x' + x.height +
        ',CODECS="' + x.codecs + '"\nhttps://' + h + '/' + m[1] + '/' + x.height + '/index.m3u8\n').join('')).join(''));
    }
    m = url.match(/https:\/\/([\w.-]+)\/([0-9a-f]{32})\/(\d+)\/index\.m3u8/);
    if (m) {
      const x = videos[m[2]].variants.find((q) => String(q.height) === m[3]);
      return text('#EXTM3U\n' + Array.from({ length: x.segments }, (_, i) =>
        '#EXTINF:4.0,\nhttps://' + m[1] + '/' + m[2] + '/' + m[3] + '/seg' + i + '.ts\n').join('') + '#EXT-X-ENDLIST\n');
    }
    m = url.match(/https:\/\/([\w.-]+)\/([0-9a-f]{32})\/(\d+)\/seg(\d+)\.ts/);
    if (m) {
      const x = videos[m[2]].variants.find((q) => String(q.height) === m[3]);
      return body(segmentBuffer(x, Number(m[4])));
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

module.exports = { createBrowser, createServer, vid };
