/*!
 * RuTube Tools — движок: разбор HLS-плейлистов, склейка TS → MP4, плейлисты RuTube.
 * Работает и в браузере (globalThis.RTLib), и в Node (module.exports).
 * Зависимости: mux.js (режим MP4, globalThis.muxjs) и lib/audio.js (режим M4A, globalThis.RTAudio).
 */
(function (global) {
  'use strict';

  var API_BASE = 'https://rutube.ru/api/play/options/';
  var VIDEO_API = 'https://rutube.ru/api/video/';
  var PLAYLIST_API = 'https://rutube.ru/api/playlist/custom/';
  var REQ_TIMEOUT = 45000;

  /**
   * Вариант качества из master-плейлиста. mirrors содержит все CDN после группировки.
   * @typedef {Object} RtVariant
   * @property {string} url
   * @property {string[]} mirrors
   * @property {number} height
   * @property {number} width
   * @property {number} bandwidth
   * @property {string} codecs
   * @property {number} frameRate
   * @property {string} [label]
   * @property {number} [estimatedBytes]
   * @property {boolean} [compatible]
   */

  /** @typedef {{time: number, title: string}} RtCuepoint */
  /** @typedef {{code: string, langTitle: string, isAuto: boolean, format: string, url: string}} RtCaption */

  /**
   * Нормализованный ответ RuTube, который используют панель и фон.
   * @typedef {Object} RtVideoInfo
   * @property {string} videoId
   * @property {string} title
   * @property {string} author
   * @property {number} durationMs
   * @property {number} durationSec
   * @property {boolean} isLive
   * @property {boolean} drmProtected
   * @property {string} masterUrl
   * @property {RtCaption[]} captions
   * @property {string} thumbnail
   * @property {RtCuepoint[]} cuepoints
   * @property {RtVariant[]} variants
   * @property {number} fps
   */

  /**
   * @typedef {Object} RtMediaPlaylist
   * @property {string[]} segments
   * @property {number[]} durations
   * @property {number} duration
   * @property {boolean} encrypted
   * @property {boolean} live
   * @property {number[]} discontinuities
   * @property {number} [mirrorIndex]
   * @property {string} [mirrorUrl]
   * @property {null} [segments_]
   */

  /** @typedef {{start: number, end: number, bytes: number}} RtPart */
  /** @typedef {{done: number, total: number, bytes: number, percent: number}} RtDownloadProgress */

  /**
   * @typedef {Object} RtDownloadPartConfig
   * @property {string[]} segments
   * @property {number} [concurrency]
   * @property {'mp4'|'m4a'|'ts'} [mode]
   * @property {AbortSignal} [signal]
   * @property {(progress: RtDownloadProgress) => void} [onProgress]
   * @property {any} [muxjs]
   * @property {any} [audio]
   * @property {string} [title]
   * @property {Object} [tags]
   * @property {boolean} [validate]
   * @property {number} [expectedDurationSec]
   * @property {any} [media]
   * @property {string} [resumeKey]
   * @property {boolean} [opfs]
   * @property {string} [fingerprint]
   * @property {number} [expectedBytes]
   * @property {(info: Object) => any} [onSegmentSaved]
   * @property {(info: Object) => any} [onStorage]
   */

  /**
   * @typedef {Object} RtDownloadResult
   * @property {Uint8Array[]} chunks
   * @property {string} mime
   * @property {string} ext
   * @property {number} bytes
   * @property {number} [durationSec]
   * @property {File} [file]
   * @property {string} [opfsKey]
   */

  /** @typedef {{every?: number, everyFrame?: boolean, count?: number, duration?: number, useAB?: boolean, a?: number|null, b?: number|null}} RtBoardOptions */
  /** @typedef {{maxSide?: number, gap?: number, captionH?: number, cols?: number, cellW?: number}} RtSheetOptions */
  /** @typedef {{cols: number, rows: number, cellW: number, cellH: number, gap: number, captionH: number, width: number, height: number}} RtSheetLayout */

  /* ---------------------------------------------------------------- utils */

  function extractVideoId(input) {
    if (!input) return null;
    var s = String(input);
    var direct = s.match(/^[0-9a-f]{32}$/i);
    if (direct) return direct[0].toLowerCase();
    var m = s.match(/(?:video|embed|shorts)\/([0-9a-f]{32})/i);
    if (m) return m[1].toLowerCase();
    var any = s.match(/\b([0-9a-f]{32})\b/i);
    return any ? any[1].toLowerCase() : null;
  }

  function extractPlaylistId(input) {
    if (!input) return null;
    var m = String(input).match(/\/plst\/([0-9a-z_-]+)/i);
    return m ? m[1] : null;
  }

  function absUrl(base, rel) {
    try { return new URL(rel, base).href; } catch (e) { return rel; }
  }

  function parseAttrs(str) {
    var out = {};
    var re = /([A-Z0-9\-]+)=("[^"]*"|[^,]*)/g, m;
    while ((m = re.exec(str))) {
      var v = m[2];
      if (v.charAt(0) === '"') v = v.slice(1, -1);
      out[m[1]] = v;
    }
    return out;
  }

  /**
   * Выполняет work(signal) с общим тайм-аутом и внешней отменой. Таймер и подписка снимаются
   * по завершении — иначе на каждый сегмент оставался бы висеть таймер на 45 секунд.
   */
  async function withAbort(external, work) {
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(new Error('timeout')); }, REQ_TIMEOUT);
    function onAbort() { ctrl.abort((external && external.reason) || new Error('aborted')); }
    if (external) {
      if (external.aborted) onAbort();
      else external.addEventListener('abort', onAbort, { once: true });
    }
    try {
      return await work(ctrl.signal);
    } finally {
      clearTimeout(timer);
      if (external) external.removeEventListener('abort', onAbort);
    }
  }

  function networkFetch(url, opts) {
    if (!global.RTNetwork || typeof global.RTNetwork.fetch !== 'function') {
      throw new Error('Сетевой модуль не загружен');
    }
    return global.RTNetwork.fetch(url, opts);
  }

  async function fetchText(url, opts) {
    opts = opts || {};
    return withAbort(opts.signal, async function (signal) {
      var r = await networkFetch(url, {
        signal: signal,
        credentials: 'omit',
        cache: 'no-store',
        headers: opts.headers || {}
      });
      if (!r.ok) throw new Error('HTTP ' + r.status + ' — ' + String(url).slice(0, 120));
      return r.text();
    });
  }

  async function fetchJson(url, opts) {
    var t = await fetchText(url, opts);
    try { return JSON.parse(t); } catch (e) { throw new Error('Некорректный JSON от API'); }
  }

  /* ------------------------------------------------------------- playlist */

  function parseMaster(text, masterUrl) {
    var lines = text.split(/\r?\n/);
    var variants = [];
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (line.indexOf('#EXT-X-STREAM-INF:') !== 0) continue;
      var attrs = parseAttrs(line.slice(18));
      var url = '';
      for (var j = i + 1; j < lines.length; j++) {
        var l = lines[j].trim();
        if (!l || l.charAt(0) === '#') continue;
        url = l; break;
      }
      if (!url) continue;
      var w = 0, h = 0;
      if (attrs.RESOLUTION) {
        var parts = attrs.RESOLUTION.toLowerCase().split('x');
        w = parseInt(parts[0], 10) || 0;
        h = parseInt(parts[1], 10) || 0;
      }
      variants.push({
        url: absUrl(masterUrl, url),
        bandwidth: parseInt(attrs.BANDWIDTH, 10) || 0,
        codecs: attrs.CODECS || '',
        width: w,
        height: h,
        frameRate: parseFloat(attrs['FRAME-RATE']) || 0
      });
    }
    return variants;
  }

  /**
   * Группирует одинаковые качества с разных CDN в один вариант со списком зеркал.
   * RuTube отдаёт каждый уровень дважды (river-1.rutube.ru и river-3-*.rtbcdn.ru) —
   * это бесплатный failover, если один CDN начинает сбоить.
   */
  function groupVariants(variants) {
    var groups = {};
    var order = [];
    variants.forEach(function (v) {
      var key = (v.height || 0) + 'x' + (v.width || 0) + '@' + (v.bandwidth || 0) + '#' + (v.codecs || '');
      if (!groups[key]) {
        groups[key] = {
          url: v.url,
          mirrors: [v.url],
          bandwidth: v.bandwidth,
          codecs: v.codecs,
          width: v.width,
          height: v.height,
          frameRate: v.frameRate
        };
        order.push(key);
      } else if (groups[key].mirrors.indexOf(v.url) === -1) {
        groups[key].mirrors.push(v.url);
      }
    });
    return order.map(function (k) { return groups[k]; })
      .sort(function (a, b) { return (b.height - a.height) || (b.bandwidth - a.bandwidth); });
  }

  function dedupeVariants(variants) {
    return groupVariants(variants).map(function (v) {
      return { url: v.mirrors[0], bandwidth: v.bandwidth, codecs: v.codecs, width: v.width, height: v.height, frameRate: v.frameRate };
    });
  }

  /**
   * Разбирает media playlist в абсолютные URL и длительности сегментов.
   * @param {string} text
   * @param {string} playlistUrl
   * @returns {RtMediaPlaylist}
   */
  function parseMediaPlaylist(text, playlistUrl) {
    var lines = text.split(/\r?\n/);
    var segments = [], durations = [], dur = 0;
    var encrypted = false, live = true, pendingDur = 0, discontinuities = [];
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (!line) continue;
      if (line.indexOf('#EXT-X-KEY') === 0) {
        if (!/METHOD=NONE/i.test(line)) encrypted = true;
      } else if (line.indexOf('#EXT-X-DISCONTINUITY') === 0) {
        discontinuities.push(segments.length);
      } else if (line.indexOf('#EXT-X-ENDLIST') === 0) {
        live = false;
      } else if (line.indexOf('#EXTINF:') === 0) {
        pendingDur = parseFloat(line.slice(8)) || 0;
      } else if (line.charAt(0) !== '#') {
        segments.push(absUrl(playlistUrl, line));
        durations.push(pendingDur);
        dur += pendingDur;
        pendingDur = 0;
      }
    }
    return {
      segments: segments, durations: durations, duration: dur,
      encrypted: encrypted, live: live, discontinuities: discontinuities
    };
  }

  /** Кумулятивные границы сегментов — для перевода «12:30» в номер фрагмента. */
  function segmentOffsets(durations) {
    var acc = 0, out = [];
    for (var i = 0; i < durations.length; i++) {
      out.push({ index: i, start: acc, end: acc + (durations[i] || 0) });
      acc += durations[i] || 0;
    }
    return out;
  }

  /**
   * Диапазон сегментов под фрагмент «с … по …».
   * Возвращает номера сегментов и фактические границы (точность — сегмент, 2–4 с).
   */
  function segmentRange(durations, fromSec, toSec) {
    var offs = segmentOffsets(durations);
    var total = offs.length ? offs[offs.length - 1].end : 0;
    var from = Math.max(0, Math.min(Number(fromSec) || 0, total));
    var to = Math.max(0, Math.min(Number(toSec) || total, total));
    if (to <= from) return null;

    var start = 0, end = offs.length;
    for (var i = 0; i < offs.length; i++) {
      if (offs[i].end > from) { start = i; break; }
    }
    for (var j = offs.length - 1; j >= 0; j--) {
      if (offs[j].start < to) { end = j + 1; break; }
    }
    if (end <= start) return null;
    return {
      start: start,
      end: end,
      realFrom: offs[start].start,
      realTo: offs[end - 1].end,
      seconds: offs[end - 1].end - offs[start].start
    };
  }

  /* ------------------------------------------------------------------ API */

  function normalizeCaptions(options) {
    var raw = options && options.captions;
    if (!raw || !raw.length) return [];
    return raw.map(function (c) {
      return {
        code: c.code || '',
        langTitle: c.langTitle || c.code || 'Субтитры',
        isAuto: !!c.is_autogenerated,
        format: c.format || 'srt',
        url: c.file || ''
      };
    }).filter(function (c) { return !!c.url; });
  }

  function normalizeCuepoints(options) {
    var raw = options && options.cuepoints;
    if (!raw || !raw.length) return [];
    return raw.map(function (c) {
      if (typeof c === 'number') return { time: c, title: '' };
      return {
        time: Number(c.time !== undefined ? c.time : (c.start !== undefined ? c.start : c.ts)) || 0,
        title: c.title || c.name || c.text || ''
      };
    }).filter(function (c) { return isFinite(c.time); });
  }

  async function getVideoMeta(videoId, opts) {
    try {
      var d = await fetchJson(VIDEO_API + videoId + '/?format=json', opts);
      return {
        views: d.hits || 0,
        created: d.created_ts || '',
        isLive: !!d.is_livestream,
        onAir: !!d.is_on_air,
        isAudio: !!d.is_audio,
        description: d.description || ''
      };
    } catch (e) {
      return null; // метаданные необязательны
    }
  }

  /**
   * Загружает и нормализует метаданные и варианты качества.
   * @param {string} videoId
   * @param {{signal?: AbortSignal}} [opts]
   * @returns {Promise<RtVideoInfo>}
   */
  async function getVideoInfo(videoId, opts) {
    opts = opts || {};
    var options = await fetchJson(
      API_BASE + videoId + '/?no_404=true&referer=https%3A%2F%2Frutube.ru&pver=v2',
      opts
    );
    if (!options || !options.video_balancer || !options.video_balancer.default) {
      throw new Error('RuTube не отдал плейлист (видео приватное, удалено или это прямой эфир)');
    }
    var isLive = !!(options.live_streams && options.live_streams.length);
    var drm = !!options.drm_token;

    var masterUrl = options.video_balancer.default;
    var masterText = await fetchText(masterUrl, opts);
    var groups = groupVariants(parseMaster(masterText, masterUrl));
    if (!groups.length) throw new Error('Не удалось разобрать список качеств');

    var fps = groups[0].frameRate || 0;
    var durationMs = options.duration || 0;

    return {
      videoId: videoId,
      title: options.title || 'rutube-video',
      author: (options.author && options.author.name) || '',
      durationMs: durationMs,
      durationSec: durationMs ? durationMs / 1000 : 0,
      isLive: isLive,
      drmProtected: drm,
      masterUrl: masterUrl,
      captions: normalizeCaptions(options),
      thumbnail: options.thumbnail_url || '',
      cuepoints: normalizeCuepoints(options),
      variants: groups.map(function (v) {
        return {
          url: v.mirrors[0],
          mirrors: v.mirrors.slice(),
          height: v.height,
          width: v.width,
          bandwidth: v.bandwidth,
          codecs: v.codecs,
          frameRate: fps || v.frameRate,
          label: v.height ? v.height + 'p' : Math.round(v.bandwidth / 1000) + ' kbps',
          estimatedBytes: durationMs ? Math.round(v.bandwidth * (durationMs / 1000) / 8) : 0,
          // compatible описывает старый mux.js-путь; Media отдельно поддерживает HEVC/AV1.
          compatible: !v.codecs || /^avc[13](?:\.|,|$)/i.test(v.codecs || '')
        };
      }),
      fps: fps || 25
    };
  }

  async function getSegments(playlistUrl, opts) {
    var text = await fetchText(playlistUrl, opts);
    var media = parseMediaPlaylist(text, playlistUrl);
    if (!media.segments.length) throw new Error('Плейлист не содержит сегментов');
    return media;
  }

  /** Пробует зеркала по очереди: вернёт первый рабочий плейлист. */
  async function getSegmentsWithMirrors(mirrors, opts) {
    var lastErr = null;
    for (var i = 0; i < mirrors.length; i++) {
      try {
        var media = await getSegments(mirrors[i], opts);
        media.mirrorIndex = i;
        media.mirrorUrl = mirrors[i];
        media.segments_ = null;
        return media;
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr || new Error('Не удалось получить плейлист ни с одного CDN');
  }

  /**
   * Выбирает best/worst или ближайшую доступную высоту.
   * @param {RtVariant[]} variants
   * @param {number|string} [preferHeight]
   * @returns {RtVariant|undefined}
   */
  function pickVariant(variants, preferHeight) {
    if (!preferHeight || preferHeight === 'best') return variants[0];
    if (preferHeight === 'worst') return variants[variants.length - 1];
    var target = parseInt(String(preferHeight), 10);
    var best = null;
    variants.forEach(function (v) {
      if (!best || Math.abs(v.height - target) < Math.abs(best.height - target)) best = v;
    });
    return best || variants[0];
  }

  /* -------------------------------------------------------- плейлисты */

  async function getPlaylistVideos(playlistId, offset, limit, opts) {
    var page = await fetchJson(
      PLAYLIST_API + playlistId + '/videos/?limit=' + limit + '&offset=' + offset + '&format=json',
      opts
    );
    return (page.results || []).map(function (v) {
      return {
        id: v.id,
        title: v.title || v.id,
        durationSec: Number(v.duration) || 0
      };
    });
  }

  /**
   * Метаданные + первая страница видео. Плейлисты бывают на сотни записей,
   * поэтому остальное догружается страницами по мере необходимости.
   */
  async function getPlaylistInfo(playlistId, opts) {
    opts = opts || {};
    var meta = await fetchJson(PLAYLIST_API + playlistId + '/?format=json', opts);
    var limit = Math.min(Math.max(Number(opts.limit) || 50, 1), 100);
    var videos = await getPlaylistVideos(playlistId, 0, limit, opts);
    return {
      id: playlistId,
      title: meta.title || ('Плейлист ' + playlistId),
      videosCount: meta.videos_count || videos.length,
      pageSize: limit,
      videos: videos
    };
  }

  /**
   * Страницы, которые нужно прочитать, чтобы показать место для серий
   * [fromIndex, toIndex) — индексы с нуля, как их понимает фон.
   * Возвращает [start, totalLength] для каждой страницы. Ограничено 500
   * сериями, как и предохранитель в фоновой очереди.
   */
  function playlistPages(fromIndex, toIndex, pageSize) {
    var size = Math.max(1, Number(pageSize) || 50);
    var start = Math.max(0, Number(fromIndex) || 0);
    var end = Number(toIndex);
    if (!isFinite(end) || end <= start) end = start + 1;
    if (end - start > 500) end = start + 500;
    var pages = [];
    for (var offset = Math.floor(start / size) * size; offset < end; offset += size) {
      pages.push([offset, Math.min(size, end - offset)]);
    }
    return pages;
  }

  /* --------------------------------------------------------------- parts */

  /**
   * Разбивает сегменты на части по оценке объёма, не меняя их порядок.
   * @param {number[]} durations
   * @param {number} bandwidth
   * @param {number} maxPartBytes
   * @returns {RtPart[]}
   */
  function planParts(durations, bandwidth, maxPartBytes) {
    if (!durations.length) return [];
    var bytes = Math.max(1, (bandwidth || 800000) / 8);
    var parts = [], cur = { start: 0, end: 0, bytes: 0 };
    for (var i = 0; i < durations.length; i++) {
      var segBytes = bytes * (durations[i] || 2);
      if (cur.end > cur.start && cur.bytes + segBytes > maxPartBytes) {
        parts.push(cur);
        cur = { start: i, end: i, bytes: 0 };
      }
      cur.bytes += segBytes;
      cur.end = i + 1;
    }
    if (cur.end > cur.start) parts.push(cur);
    return parts;
  }

  /* ------------------------------------------------------------ downloading */

  /* -------------------------------------------------------- проверка MP4/M4A */

  function invalidOutput(message) {
    /** @type {Error & {code?: string}} */
    var err = new Error('Проверка результата: ' + message);
    err.code = 'invalid-output';
    return err;
  }

  function readU32(bytes, offset) {
    if (offset < 0 || offset + 4 > bytes.byteLength) throw invalidOutput('повреждены MP4-боксы');
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset);
  }

  function readU64(bytes, offset) {
    return readU32(bytes, offset) * 4294967296 + readU32(bytes, offset + 4);
  }

  function findBoxes(probe, bytes, path) {
    try {
      return probe.findBox(bytes, path) || [];
    } catch (e) {
      throw invalidOutput('не удалось разобрать MP4-боксы');
    }
  }

  function headerDuration(probe, head) {
    var result = 0;
    findBoxes(probe, head, ['moov', 'trak', 'mdia', 'mdhd']).forEach(function (box) {
      var version = box[0];
      var timeOffset = version === 1 ? 20 : 12;
      var durationOffset = version === 1 ? 24 : 16;
      var scale = readU32(box, timeOffset);
      var duration = version === 1 ? readU64(box, durationOffset) : readU32(box, durationOffset);
      // В fMP4 mux.js записывает unknown duration как 0xffffffff.
      if (scale > 0 && duration > 0 && duration < 0xffffffff) result = Math.max(result, duration / scale);
    });
    return result;
  }

  function fragmentDefaults(probe, head) {
    var defaults = {};
    findBoxes(probe, head, ['moov', 'mvex', 'trex']).forEach(function (box) {
      defaults[readU32(box, 4)] = readU32(box, 12);
    });
    return defaults;
  }

  function fragmentDuration(probe, bytes, defaults, scales, totals) {
    findBoxes(probe, bytes, ['moof', 'traf']).forEach(function (traf) {
      var tfhd = findBoxes(probe, traf, ['tfhd'])[0];
      if (!tfhd) throw invalidOutput('во фрагменте нет tfhd');
      var flags = (tfhd[1] << 16) | (tfhd[2] << 8) | tfhd[3];
      var trackId = readU32(tfhd, 4);
      var cursor = 8;
      var defaultDuration = defaults[trackId] || 0;
      if (flags & 0x1) cursor += 8;
      if (flags & 0x2) cursor += 4;
      if (flags & 0x8) { defaultDuration = readU32(tfhd, cursor); cursor += 4; }
      if (flags & 0x10) cursor += 4;
      if (flags & 0x20) cursor += 4;
      var sum = 0;
      findBoxes(probe, traf, ['trun']).forEach(function (trun) {
        var trunFlags = (trun[1] << 16) | (trun[2] << 8) | trun[3];
        var count = readU32(trun, 4);
        var pos = 8;
        if (trunFlags & 0x1) pos += 4;
        if (trunFlags & 0x4) pos += 4;
        for (var i = 0; i < count; i++) {
          var duration = defaultDuration;
          if (trunFlags & 0x100) { duration = readU32(trun, pos); pos += 4; }
          if (trunFlags & 0x200) pos += 4;
          if (trunFlags & 0x400) pos += 4;
          if (trunFlags & 0x800) pos += 4;
          if (!(duration > 0)) throw invalidOutput('у фрагмента нет длительности samples');
          sum += duration;
        }
      });
      if (sum > 0) {
        if (!(scales[trackId] > 0)) throw invalidOutput('у дорожки нет timescale');
        totals[trackId] = (totals[trackId] || 0) + sum / scales[trackId];
      }
    });
  }

  /**
   * Проверяет собранный контейнер до создания браузерного download.
   * chunks не объединяются: init и media fragments разбираются по месту.
   * @param {{chunks: Uint8Array[], mode: string, muxjs: any, expectedDurationSec?: number}} cfg
   * @return {{bytes: number, durationSec: number, tracks: Object[]}}
   */
  function validatePart(cfg) {
    var chunks = cfg.chunks || [];
    var mode = cfg.mode || 'mp4';
    var muxjs = cfg.muxjs;
    var bytes = chunks.reduce(function (sum, chunk) { return sum + (chunk ? chunk.byteLength : 0); }, 0);
    if (!bytes) throw invalidOutput('пустой файл');
    if (!muxjs || !muxjs.probe || typeof muxjs.probe.tracks !== 'function' ||
        typeof muxjs.probe.findBox !== 'function' || typeof muxjs.probe.timescale !== 'function') {
      throw invalidOutput('bundled mux.js probe не загружен');
    }
    var probe = muxjs.probe;
    var head = chunks[0];
    if (!head || head.byteLength < 8) throw invalidOutput('нет init-сегмента');
    var tracks;
    try {
      tracks = probe.tracks(head);
    } catch (e) {
      throw invalidOutput('не удалось разобрать дорожки');
    }
    if (!Array.isArray(tracks) || !tracks.length) throw invalidOutput('не найдены дорожки');
    var video = tracks.filter(function (track) { return track.type === 'video'; });
    var audio = tracks.filter(function (track) { return track.type === 'audio'; });
    if (mode === 'mp4' && !video.length) throw invalidOutput('в MP4 нет видеодорожки');
    if (mode === 'm4a' && !audio.length) throw invalidOutput('в M4A нет аудиодорожки');
    tracks.forEach(function (track) {
      if (track.type === 'video' && !/^(?:avc[13]|hvc1|hev1|av01)/i.test(track.codec || '')) {
        throw invalidOutput('неподдерживаемый видеокодек ' + (track.codec || 'unknown'));
      }
      if (track.type === 'audio' && !/^mp4a/i.test(track.codec || '')) {
        throw invalidOutput('неподдерживаемый аудиокодек ' + (track.codec || 'unknown'));
      }
    });

    var durationSec = 0;
    if (mode === 'm4a') {
      durationSec = headerDuration(probe, head);
    } else if (mode === 'mp4') {
      var scales;
      try {
        scales = probe.timescale(head);
      } catch (e) {
        throw invalidOutput('не удалось разобрать timescale');
      }
      var defaults = fragmentDefaults(probe, head);
      var totals = {};
      var mediaChunks = chunks.length > 1 ? chunks.slice(1) : chunks;
      var hasData = false;
      mediaChunks.forEach(function (chunk) {
        if (findBoxes(probe, chunk, ['mdat']).some(function (box) { return box.byteLength > 0; })) hasData = true;
        fragmentDuration(probe, chunk, defaults, scales, totals);
      });
      if (!hasData) throw invalidOutput('в MP4 нет media data');
      Object.keys(totals).forEach(function (id) { durationSec = Math.max(durationSec, totals[id]); });
      // Некоторые совместимые упаковщики пишут обычный MP4 без moof.
      if (!durationSec) durationSec = headerDuration(probe, head);
    } else {
      return { bytes: bytes, durationSec: 0, tracks: tracks };
    }
    if (!(durationSec > 0) || !isFinite(durationSec)) throw invalidOutput('длительность не определена');
    var expected = Number(cfg.expectedDurationSec);
    if (expected > 0 && isFinite(expected)) {
      var tolerance = Math.max(0.75, expected * 0.05);
      if (Math.abs(durationSec - expected) > tolerance) {
        throw invalidOutput('длительность ' + durationSec.toFixed(2) + ' с вместо ожидаемых ' + expected.toFixed(2) + ' с');
      }
    }
    return { bytes: bytes, durationSec: durationSec, tracks: tracks };
  }

  /**
   * Скачивает сегменты параллельно, но подаёт в muxer строго по порядку.
   * @param {RtDownloadPartConfig} cfg
   * @returns {Promise<RtDownloadResult>}
   */
  async function downloadPart(cfg) {
    var segments = cfg.segments;
    var concurrency = Math.max(1, Math.min(8, cfg.concurrency || 4));
    var mode = cfg.mode || 'mp4';
    var signal = cfg.signal;
    var onProgress = cfg.onProgress || function () {};
    var muxjs = cfg.muxjs || global.muxjs;
    var audioLib = cfg.audio || global.RTAudio;
    var mediaLib = cfg.media || global.RTMedia;
    var useMedia = mode === 'mp4' && mediaLib && typeof mediaLib.transmuxChunks === 'function';

    // mux.js остаётся резервным путём для автономных/старых сборок и тестовых окружений.
    var Transmuxer = muxjs && typeof muxjs.Transmuxer === 'function' ? muxjs.Transmuxer
      : muxjs && muxjs.mp4 && muxjs.mp4.Transmuxer;
    if (mode === 'mp4' && !useMedia && typeof Transmuxer !== 'function') {
      throw new Error('Модуль сборки MP4 не загружен');
    }
    if (mode === 'm4a' && (!audioLib || !audioLib.createExtractor)) {
      throw new Error('Модуль извлечения звука не загружен');
    }

    var chunks = [];
    var mediaChunks = [];
    var initSegment = null;
    var transmuxer = null;
    var extractor = null;
    var session = null;
    var receivedBytes = 0;
    var doneCount = 0;
    var total = segments.length;
    var resumeStart = 0;

    if (useMedia && cfg.resumeKey && cfg.opfs !== false && typeof mediaLib.createOpfsSession === 'function') {
      try {
        session = await mediaLib.createOpfsSession({
          key: cfg.resumeKey,
          total: total,
          fingerprint: cfg.fingerprint || segments.join('\n'),
          expectedBytes: cfg.expectedBytes || 0,
          onIndex: cfg.onSegmentSaved
        });
        resumeStart = Math.max(0, Math.min(total, session.nextSegment || 0));
        receivedBytes = session.bytes || 0;
        doneCount = resumeStart;
        if (typeof cfg.onStorage === 'function') {
          await cfg.onStorage({ state: 'opfs', resumed: resumeStart > 0, nextSegment: resumeStart });
        }
      } catch (error) {
        session = null;
        resumeStart = 0;
        receivedBytes = 0;
        doneCount = 0;
        if (signal && signal.aborted) throw error;
        if (typeof cfg.onStorage === 'function') {
          await cfg.onStorage({ state: 'memory', reason: (error && error.code) || 'opfs-unavailable' });
        }
      }
    }

    if (mode === 'mp4' && !useMedia) {
      transmuxer = new Transmuxer({ remux: true });
      transmuxer.on('data', function (s) {
        if (!initSegment && s.initSegment && s.initSegment.byteLength) initSegment = s.initSegment;
        if (s.data && s.data.byteLength) chunks.push(s.data);
      });
    }

    if (mode === 'm4a') extractor = audioLib.createExtractor({ title: cfg.title, tags: cfg.tags });

    function checked(result) {
      // Media-модуль уже проверил File и fMP4; TS fallback нельзя отправлять в MP4 validator.
      if (cfg.validate && mode !== 'ts' && result.ext !== 'ts' && result.chunks && !result.file) {
        validatePart({ chunks: result.chunks, mode: mode, muxjs: muxjs, expectedDurationSec: cfg.expectedDurationSec });
      }
      return result;
    }

    function emit() {
      onProgress({
        done: doneCount,
        total: total,
        bytes: receivedBytes,
        percent: total ? Math.round(doneCount / total * 100) : 0
      });
    }

    async function fetchSegment(idx, attempt) {
      attempt = attempt || 1;
      if (signal && signal.aborted) throw new Error('Отменено пользователем');
      try {
        return await withAbort(signal, async function (sig) {
          var r = await networkFetch(segments[idx], { signal: sig, credentials: 'omit', cache: 'no-store' });
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return new Uint8Array(await r.arrayBuffer());
        });
      } catch (e) {
        if (signal && signal.aborted) throw e;
        if (e && /^(url|redirect|method)-not-allowed$|^too-many-redirects$/.test(e.code)) throw e;
        if (attempt < 3) {
          await new Promise(function (res) { setTimeout(res, 400 * attempt); });
          return fetchSegment(idx, attempt + 1);
        }
        /** @type {Error & {segmentIndex?: number}} */
        var err = new Error('Сегмент ' + (idx + 1) + ' из ' + total + ': ' + ((e && e.message) || e));
        err.segmentIndex = idx;
        throw err;
      }
    }

    var window_ = new Map();
    var nextToStart = resumeStart;
    var nextToFeed = resumeStart;

    function startOne() {
      if (nextToStart >= total) return;
      var idx = nextToStart++;
      var p = fetchSegment(idx).then(
        function (buf) { return { ok: true, buf: buf }; },
        function (err) { return { ok: false, err: err }; }
      );
      window_.set(idx, p);
    }

    emit();
    for (var i = 0; i < concurrency; i++) startOne();

    try {
      while (nextToFeed < total) {
        if (signal && signal.aborted) throw new Error('Отменено пользователем');
        var res = await window_.get(nextToFeed);
        window_.delete(nextToFeed);
        if (signal && signal.aborted) throw new Error('Отменено пользователем');
        if (!res.ok) throw res.err;
        receivedBytes += res.buf.byteLength;
        if (session) {
          await session.write(res.buf, nextToFeed);
        } else if (useMedia) {
          mediaChunks.push(res.buf);
        } else if (mode === 'mp4') {
          transmuxer.push(res.buf, { remux: true });
        } else if (mode === 'm4a') {
          extractor.push(res.buf);
        } else {
          chunks.push(res.buf);
        }
        res.buf = null;
        nextToFeed++;
        doneCount = nextToFeed;
        emit();
        startOne();
      }
    } catch (error) {
      if (session) {
        var failedSession = session;
        session = null;
        await failedSession.close({ discardOutput: true }).catch(function () {});
        var opfsFailure = error && /^opfs-/.test(error.code || '');
        if (opfsFailure && !(signal && signal.aborted)) {
          if (typeof cfg.onSegmentSaved === 'function') {
            await Promise.resolve().then(function () {
              return cfg.onSegmentSaved({ key: cfg.resumeKey, reset: true });
            }).catch(function () {});
          }
          if (typeof mediaLib.cleanupOpfs === 'function') {
            await mediaLib.cleanupOpfs(cfg.resumeKey).catch(function () {});
          }
          if (typeof cfg.onStorage === 'function') {
            await cfg.onStorage({ state: 'memory', reason: error.code });
          }
          // Дисковый путь не должен становиться новой причиной потери загрузки.
          return downloadPart(Object.assign({}, cfg, { opfs: false, resumeKey: null }));
        }
      }
      throw error;
    }

    if (mode === 'm4a') {
      var audio = extractor.finish();
      return checked({ chunks: audio.chunks, mime: 'audio/mp4', ext: 'm4a', bytes: audio.bytes,
               durationSec: audio.durationSec });
    }
    if (useMedia) {
      var mediaResult;
      if (session) {
        var activeSession = session;
        session = null;
        mediaResult = await mediaLib.transmuxOpfs(activeSession, {
          signal: signal,
          expectedDurationSec: cfg.expectedDurationSec
        });
      } else {
        mediaResult = await mediaLib.transmuxChunks(mediaChunks, {
          signal: signal,
          expectedDurationSec: cfg.expectedDurationSec
        });
        mediaChunks = [];
      }
      return checked(mediaResult);
    }
    if (mode === 'mp4') {
      transmuxer.flush();
      if (!initSegment) throw new Error('mux.js не смог собрать MP4 (возможно, неподдерживаемый кодек)');
      chunks.unshift(initSegment);
      return checked({ chunks: chunks, mime: 'video/mp4', ext: 'mp4',
               bytes: chunks.reduce(function (s, c) { return s + c.byteLength; }, 0) });
    }
    return { chunks: chunks, mime: 'video/mp2t', ext: 'ts',
             bytes: chunks.reduce(function (s, c) { return s + c.byteLength; }, 0) };
  }

  /* ------------------------------------------------------------------ главы */

  /** Главы в виде «0:00 Название» — формат описаний YouTube, понимают многие плееры. */
  function chaptersToText(cuepoints) {
    return (cuepoints || []).map(function (c) {
      return formatTime(c.time) + ' ' + (c.title || '');
    }).join('\n') + '\n';
  }

  /**
   * Преобразует SubRip в WebVTT без сетевых библиотек и HTML-парсера.
   * Индексы SRT не нужны WebVTT; необязательные cue settings после второго
   * времени сохраняются. Невалидный файл отклоняется, а не сохраняется молча.
   * @param {string} input
   * @returns {string}
   */
  function srtToVtt(input) {
    if (typeof input !== 'string') throw new Error('invalid-srt');
    var source = input.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim();
    if (!source) throw new Error('invalid-srt');
    var timePattern = '(\\d{2,}:[0-5]\\d:[0-5]\\d[,.]\\d{1,3})';
    var timingRe = new RegExp('^' + timePattern + '\\s+-->\\s+' + timePattern + '(?:\\s+(.*))?$');
    function timestamp(value) {
      var m = String(value).match(/^(\d{2,}):([0-5]\d):([0-5]\d)[,.](\d{1,3})$/);
      if (!m) throw new Error('invalid-srt-time');
      var ms = Number(m[4].padEnd(3, '0'));
      return {
        text: m[1].padStart(2, '0') + ':' + m[2] + ':' + m[3] + '.' + String(ms).padStart(3, '0'),
        value: Number(m[1]) * 3600000 + Number(m[2]) * 60000 + Number(m[3]) * 1000 + ms
      };
    }
    var cues = source.split(/\n[ \t]*\n/).map(function (block, index) {
      var lines = block.split('\n');
      var timingIndex = lines.findIndex(function (line) { return line.indexOf('-->') !== -1; });
      if (timingIndex < 0 || timingIndex > 1) throw new Error('invalid-srt-cue-' + (index + 1));
      var match = timingRe.exec(lines[timingIndex].trim());
      if (!match) throw new Error('invalid-srt-time-' + (index + 1));
      var start = timestamp(match[1]), end = timestamp(match[2]);
      if (end.value < start.value) throw new Error('invalid-srt-order-' + (index + 1));
      var text = lines.slice(timingIndex + 1);
      if (!text.length || text.every(function (line) { return !line.trim(); })) {
        throw new Error('empty-srt-cue-' + (index + 1));
      }
      var identifier = timingIndex === 1 && !/^\d+$/.test(lines[0].trim()) ? lines[0].trim() + '\n' : '';
      return identifier + start.text + ' --> ' + end.text +
        (match[3] ? ' ' + match[3].trim() : '') + '\n' + text.join('\n');
    });
    return 'WEBVTT\n\n' + cues.join('\n\n') + '\n';
  }

  function ffEscape(s) {
    return String(s == null ? '' : s).replace(/[=;#\\\n]/g, function (ch) {
      return ch === '\n' ? '\\\n' : '\\' + ch;
    });
  }

  /**
   * Главы в формате FFMETADATA1. Вшиваются без перекодирования:
   *   ffmpeg -i видео.mp4 -i главы.ffmeta -map_metadata 1 -map_chapters 1 -c copy готово.mp4
   */
  function chaptersToFfmetadata(cuepoints, durationSec, title) {
    var list = (cuepoints || []).filter(function (c) { return isFinite(c.time) && c.time >= 0; })
      .slice().sort(function (a, b) { return a.time - b.time; });
    var out = [';FFMETADATA1'];
    if (title) out.push('title=' + ffEscape(title));
    for (var i = 0; i < list.length; i++) {
      var startMs = Math.round(list[i].time * 1000);
      var endMs = i + 1 < list.length
        ? Math.round(list[i + 1].time * 1000)
        : Math.max(startMs + 1000, Math.round((durationSec || 0) * 1000));
      out.push('[CHAPTER]', 'TIMEBASE=1/1000', 'START=' + startMs, 'END=' + endMs,
               'title=' + ffEscape(list[i].title || ('Глава ' + (i + 1))));
    }
    return out.join('\n') + '\n';
  }

  /**
   * Для режима «только звук» берём самый лёгкий поток: звук у всех качеств одинаковый,
   * а трафик — в десятки раз меньше, чем у 1080p.
   */
  function pickAudioVariant(variants) {
    var best = null;
    (variants || []).forEach(function (v) {
      if (!best || (v.bandwidth || Infinity) < (best.bandwidth || Infinity)) best = v;
    });
    return best;
  }

  function sanitizeFilename(name) {
    return String(name || 'video')
      .replace(/[\\/:*?"<>|\r\n\t]+/g, ' ')
      .replace(/\s+/g, ' ')
      .replace(/^[.\s]+|[.\s]+$/g, '')
      .slice(0, 110) || 'video';
  }

  /** То же, но без «видео» вместо пустой строки: нужно для сегментов пути. */
  function cleanSegment(name) {
    return String(name == null ? '' : name)
      .replace(/[\\:*?"<>|\r\n\t]+/g, ' ')
      .replace(/\s+/g, ' ')
      .replace(/^[.\s]+|[.\s]+$/g, '')
      .slice(0, 110);
  }

  /**
   * Подставляет переменные в шаблон имени: {title} {author} {quality} {date} {playlist}.
   * Пустая переменная не оставляет после себя «вдовий» разделитель:
   * «{author} — {title}» без автора даёт «Название», а не « — Название».
   */
  function applyNameTemplate(tpl, vars) {
    var src = String(tpl == null ? '' : tpl).trim() || '{title}';
    var out = src.replace(/\{(\w+)\}/g, function (m, key) {
      var v = vars ? vars[key] : null;
      return v == null ? '' : String(v).trim();
    }).replace(/\{[^{}]*\}/g, '');   // незнакомые переменные не должны попасть в имя
    return out
      .replace(/\(\s*\)|\[\s*\]|\{\s*\}/g, '')          // пустые скобки от пустой переменной
      .replace(/[ \t]+/g, ' ')
      .replace(/(\s*[—–|·,]\s*){2,}/g, function (m) {   // два разделителя подряд
        if (m.indexOf('—') !== -1 || m.indexOf('–') !== -1) return ' — ';
        if (m.indexOf('|') !== -1) return ' | ';
        if (m.indexOf('·') !== -1) return ' · ';
        return ', ';
      })
      .replace(/^[\s—–|·,.\-]+|[\s—–|·,.\-]+$/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * Готовое имя файла по шаблону. Косая черта в шаблоне создаёт подпапку
   * (`{playlist}/{title}`), каждый сегмент чистится отдельно, поэтому путь
   * не ломает загрузки. Пустой шаблон и шаблон из одних переменных без данных
   * дают название видео.
   */
  function filenameFromTemplate(tpl, vars) {
    var filled = applyNameTemplate(tpl, vars);
    var segs = filled.split('/').map(cleanSegment).filter(function (s) { return !!s; });
    if (!segs.length) return sanitizeFilename(vars && vars.title);
    return segs.join('/');
  }

  /* ------------------------------------------------------------------ кадры */

  var FRAME_FORMATS = { png: ['image/png', 'png'], jpeg: ['image/jpeg', 'jpg'], webp: ['image/webp', 'webp'] };

  /** Формат кадра из настроек → {mime, ext}. Незнакомое значение — PNG. */
  function frameFormat(fmt) {
    var f = FRAME_FORMATS[String(fmt || '').toLowerCase()] || FRAME_FORMATS.png;
    return { mime: f[0], ext: f[1] };
  }

  /** Качество для canvas.toDataURL: 0.5…1 (в настройках — проценты 50…100). */
  function frameQuality(pct) {
    var n = Number(pct);
    if (!isFinite(n)) n = 92;
    return Math.max(50, Math.min(100, Math.round(n))) / 100;
  }

  /**
   * Моменты для серии кадров. Без A/B — от начала через every секунд, count штук.
   * С A и B (useAB) — внутри отрезка [A, B], от A через every секунд, не дальше B.
   * Последний кадр не ближе 0.1 с к концу, чтобы seek не упёрся в конец потока.
   * @param {RtBoardOptions} [opts]
   * @returns {number[]}
   */
  function boardTimes(opts) {
    opts = opts || {};
    var every = Math.max(opts.everyFrame ? 0.001 : 0.2, Number(opts.every) || 5);
    var count = Math.max(1, Math.min(120, Math.floor(Number(opts.count) || 12)));
    var dur = Number(opts.duration) || 0;
    if (!(dur > 0)) return [];
    var start = 0;
    var end = dur - 0.1;
    if (opts.useAB && opts.a != null && opts.b != null && isFinite(opts.a) && isFinite(opts.b)) {
      start = Math.max(0, Math.min(opts.a, opts.b));
      end = Math.min(end, Math.max(opts.a, opts.b));
    }
    var out = [];
    for (var i = 0; i < count; i++) {
      var tm = start + i * every;
      if (tm > end + 1e-9) break;
      out.push(Math.round(tm * 1000) / 1000);
    }
    return out;
  }

  /**
   * Раскладка контактного листа: сколько колонок и какого размера ячейки.
   * Лист не превышает maxSide по любой стороне (по умолчанию 8192 px) —
   * иначе canvas в браузере откажется рисовать.
   * @param {number} count
   * @param {number} vw
   * @param {number} vh
   * @param {RtSheetOptions} [opts]
   * @returns {RtSheetLayout}
   */
  function sheetLayout(count, vw, vh, opts) {
    opts = opts || {};
    var n = Math.max(1, Math.floor(count) || 1);
    var aspect = (vw > 0 && vh > 0) ? vw / vh : 16 / 9;
    var maxSide = opts.maxSide || 8192;
    var gap = opts.gap == null ? 8 : opts.gap;
    var cap = opts.captionH == null ? 22 : opts.captionH;
    var cols = opts.cols || Math.min(n, Math.max(1, Math.round(Math.sqrt(n * 1.6))));
    var rows = Math.ceil(n / cols);
    var cellW = opts.cellW || 320;
    var cellH = Math.round(cellW / aspect);
    for (var guard = 0; guard < 40; guard++) {
      var w = gap + cols * (cellW + gap);
      var h = gap + rows * (cellH + cap + gap);
      if (w <= maxSide && h <= maxSide) break;
      cellW = Math.max(40, Math.floor(cellW * 0.9));
      cellH = Math.round(cellW / aspect);
    }
    return {
      cols: cols, rows: rows, cellW: cellW, cellH: cellH, gap: gap, captionH: cap,
      width: gap + cols * (cellW + gap),
      height: gap + rows * (cellH + cap + gap)
    };
  }

  var TRANSLIT = {
    'а':'a','б':'b','в':'v','г':'g','д':'d','е':'e','ё':'e','ж':'zh','з':'z','и':'i','й':'y',
    'к':'k','л':'l','м':'m','н':'n','о':'o','п':'p','р':'r','с':'s','т':'t','у':'u','ф':'f',
    'х':'h','ц':'ts','ч':'ch','ш':'sh','щ':'sch','ъ':'','ы':'y','ь':'','э':'e','ю':'yu','я':'ya',
    'і':'i','ї':'yi','є':'ye','ґ':'g',
    'А':'A','Б':'B','В':'V','Г':'G','Д':'D','Е':'E','Ё':'E','Ж':'Zh','З':'Z','И':'I','Й':'Y',
    'К':'K','Л':'L','М':'M','Н':'N','О':'O','П':'P','Р':'R','С':'S','Т':'T','У':'U','Ф':'F',
    'Х':'H','Ц':'Ts','Ч':'Ch','Ш':'Sh','Щ':'Sch','Ъ':'','Ы':'Y','Ь':'','Э':'E','Ю':'Yu','Я':'Ya',
    'І':'I','Ї':'Yi','Є':'Ye','Ґ':'G'
  };

  function toAsciiFilename(name) {
    var out = String(name || 'video').replace(/[\s\S]/g, function (ch) {
      return TRANSLIT[ch] !== undefined ? TRANSLIT[ch] : ch;
    });
    out = out.replace(/[^\x20-\x7E]+/g, ' ')
             .replace(/[\\/:*?"<>|]+/g, ' ')
             .replace(/\s+/g, ' ')
             .replace(/^[.\s]+|[.\s]+$/g, '')
             .slice(0, 110);
    return out || 'video';
  }

  function units() {
    var en = false;
    try { en = global.RTI18n && global.RTI18n.getLang && global.RTI18n.getLang() === 'en'; } catch (e) {}
    return en ? { mb: 'MB', gb: 'GB' } : { mb: 'МБ', gb: 'ГБ' };
  }

  function formatBytes(b) {
    var u = units();
    if (!b) return '0 ' + u.mb;
    var mb = b / (1024 * 1024);
    if (mb >= 1024) return (mb / 1024).toFixed(2) + ' ' + u.gb;
    if (mb >= 10) return Math.round(mb) + ' ' + u.mb;
    return mb.toFixed(1) + ' ' + u.mb;
  }

  function formatTime(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    var h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60;
    return (h ? h + ':' + String(m).padStart(2, '0') : String(m)) + ':' + String(s).padStart(2, '0');
  }

  /** «12:34» / «1:02:03» / «754» → секунды */
  function parseTimecode(value) {
    var s = String(value == null ? '' : value).trim().replace(',', '.');
    if (!s) return NaN;
    if (/^\d+(\.\d+)?$/.test(s)) return parseFloat(s);
    var parts = s.split(':').map(function (x) { return parseFloat(x) || 0; });
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    return NaN;
  }

  var API = {
    extractVideoId: extractVideoId,
    extractPlaylistId: extractPlaylistId,
    getVideoInfo: getVideoInfo,
    getVideoMeta: getVideoMeta,
    getPlaylistInfo: getPlaylistInfo,
    getPlaylistVideos: getPlaylistVideos,
    playlistPages: playlistPages,
    getSegments: getSegments,
    getSegmentsWithMirrors: getSegmentsWithMirrors,
    pickVariant: pickVariant,
    pickAudioVariant: pickAudioVariant,
    chaptersToText: chaptersToText,
    chaptersToFfmetadata: chaptersToFfmetadata,
    srtToVtt: srtToVtt,
    planParts: planParts,
    segmentRange: segmentRange,
    segmentOffsets: segmentOffsets,
    downloadPart: downloadPart,
    validatePart: validatePart,
    parseMaster: parseMaster,
    parseMediaPlaylist: parseMediaPlaylist,
    groupVariants: groupVariants,
    dedupeVariants: dedupeVariants,
    sanitizeFilename: sanitizeFilename,
    applyNameTemplate: applyNameTemplate,
    filenameFromTemplate: filenameFromTemplate,
    toAsciiFilename: toAsciiFilename,
    formatBytes: formatBytes,
    formatTime: formatTime,
    parseTimecode: parseTimecode,
    frameFormat: frameFormat,
    frameQuality: frameQuality,
    boardTimes: boardTimes,
    sheetLayout: sheetLayout
  };

  global.RTLib = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof globalThis !== 'undefined' ? globalThis : this);
