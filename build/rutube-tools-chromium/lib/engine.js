/*!
 * RuTube Tools — движок: разбор HLS-плейлистов, склейка TS → MP4, плейлисты RuTube.
 * Работает и в браузере (globalThis.RTLib), и в Node (module.exports).
 * Зависимость для режима MP4: mux.js (globalThis.muxjs).
 */
(function (global) {
  'use strict';

  var API_BASE = 'https://rutube.ru/api/play/options/';
  var VIDEO_API = 'https://rutube.ru/api/video/';
  var PLAYLIST_API = 'https://rutube.ru/api/playlist/custom/';
  var REQ_TIMEOUT = 45000;

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

  function fetchSignal(signal) {
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(new Error('timeout')); }, REQ_TIMEOUT);
    function onAbort() { clearTimeout(timer); ctrl.abort((signal && signal.reason) || new Error('aborted')); }
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    ctrl.signal.addEventListener('abort', function () { clearTimeout(timer); }, { once: true });
    return ctrl.signal;
  }

  async function fetchText(url, opts) {
    opts = opts || {};
    var r = await fetch(url, {
      signal: fetchSignal(opts.signal),
      credentials: 'omit',
      cache: 'no-store',
      headers: opts.headers || {}
    });
    if (!r.ok) throw new Error('HTTP ' + r.status + ' — ' + String(url).slice(0, 120));
    return r.text();
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
          compatible: !/hvc1|hev1|av01|vp0?9/i.test(v.codecs || '')
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

  function pickVariant(variants, preferHeight) {
    if (!preferHeight || preferHeight === 'best') return variants[0];
    if (preferHeight === 'worst') return variants[variants.length - 1];
    var target = parseInt(preferHeight, 10);
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

  /* --------------------------------------------------------------- parts */

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

  async function downloadPart(cfg) {
    var segments = cfg.segments;
    var concurrency = Math.max(1, Math.min(8, cfg.concurrency || 4));
    var mode = cfg.mode || 'mp4';
    var signal = cfg.signal;
    var onProgress = cfg.onProgress || function () {};
    var muxjs = cfg.muxjs || global.muxjs;

    if (mode === 'mp4' && (!muxjs || !muxjs.mp4 || !muxjs.mp4.Transmuxer)) mode = 'ts';

    var chunks = [];
    var initSegment = null;
    var transmuxer = null;
    var receivedBytes = 0;
    var doneCount = 0;
    var total = segments.length;

    if (mode === 'mp4') {
      transmuxer = new muxjs.mp4.Transmuxer({ remux: true });
      transmuxer.on('data', function (s) {
        if (!initSegment && s.initSegment && s.initSegment.byteLength) initSegment = s.initSegment;
        if (s.data && s.data.byteLength) chunks.push(s.data);
      });
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
        var r = await fetch(segments[idx], {
          signal: fetchSignal(signal),
          credentials: 'omit',
          cache: 'no-store'
        });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return new Uint8Array(await r.arrayBuffer());
      } catch (e) {
        if (signal && signal.aborted) throw e;
        if (attempt < 3) {
          await new Promise(function (res) { setTimeout(res, 400 * attempt); });
          return fetchSegment(idx, attempt + 1);
        }
        var err = new Error('Сегмент ' + (idx + 1) + ' из ' + total + ': ' + ((e && e.message) || e));
        err.segmentIndex = idx;
        throw err;
      }
    }

    var window_ = new Map();
    var nextToStart = 0;
    var nextToFeed = 0;

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

    while (nextToFeed < total) {
      if (signal && signal.aborted) throw new Error('Отменено пользователем');
      var res = await window_.get(nextToFeed);
      window_.delete(nextToFeed);
      if (!res.ok) throw res.err;
      receivedBytes += res.buf.byteLength;
      if (mode === 'mp4') {
        transmuxer.push(res.buf, { remux: true });
      } else {
        chunks.push(res.buf);
      }
      res.buf = null;
      nextToFeed++;
      doneCount = nextToFeed;
      emit();
      startOne();
    }

    if (mode === 'mp4') {
      transmuxer.flush();
      if (!initSegment) throw new Error('mux.js не смог собрать MP4 (возможно, неподдерживаемый кодек)');
      chunks.unshift(initSegment);
      return { chunks: chunks, mime: 'video/mp4', ext: 'mp4',
               bytes: chunks.reduce(function (s, c) { return s + c.byteLength; }, 0) };
    }
    return { chunks: chunks, mime: 'video/mp2t', ext: 'ts',
             bytes: chunks.reduce(function (s, c) { return s + c.byteLength; }, 0) };
  }

  function sanitizeFilename(name) {
    return String(name || 'video')
      .replace(/[\\/:*?"<>|\r\n\t]+/g, ' ')
      .replace(/\s+/g, ' ')
      .replace(/^[.\s]+|[.\s]+$/g, '')
      .slice(0, 110) || 'video';
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
    getSegments: getSegments,
    getSegmentsWithMirrors: getSegmentsWithMirrors,
    pickVariant: pickVariant,
    planParts: planParts,
    segmentRange: segmentRange,
    segmentOffsets: segmentOffsets,
    downloadPart: downloadPart,
    parseMaster: parseMaster,
    parseMediaPlaylist: parseMediaPlaylist,
    groupVariants: groupVariants,
    dedupeVariants: dedupeVariants,
    sanitizeFilename: sanitizeFilename,
    toAsciiFilename: toAsciiFilename,
    formatBytes: formatBytes,
    formatTime: formatTime,
    parseTimecode: parseTimecode
  };

  global.RTLib = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof globalThis !== 'undefined' ? globalThis : this);
