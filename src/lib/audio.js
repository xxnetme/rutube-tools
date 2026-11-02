/*!
 * RuTube Tools — режим «только звук».
 * Достаёт AAC-дорожку из сегментов MPEG-TS и собирает обычный M4A (ISO BMFF, AAC-LC),
 * без перекодирования. mux.js для этого не годится: он всегда собирает обе дорожки.
 *
 * Использование (браузер: globalThis.RTAudio, Node: module.exports):
 *   var ex = RTAudio.createExtractor({ title: 'Название' });
 *   ex.push(uint8ArrayСегмента);   // по порядку, для каждого сегмента
 *   var out = ex.finish();          // { chunks: [Uint8Array…], bytes, durationSec, sampleRate, channels }
 */
(function (global) {
  'use strict';

  var TS_PACKET = 188;
  var SAMPLE_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050,
                      16000, 12000, 11025, 8000, 7350];
  var STREAM_AAC_ADTS = 0x0f;
  var STREAM_MPEG_AUDIO = [0x03, 0x04];
  var STREAM_AAC_LATM = 0x11;
  var SAMPLES_PER_FRAME = 1024;

  /* ------------------------------------------------------------ MPEG-TS */

  /** Находит смещение первого пакета: у склеенных потоков бывает мусор перед 0x47. */
  function findSync(buf) {
    var limit = Math.min(buf.length - TS_PACKET * 2, TS_PACKET);
    for (var i = 0; i <= limit; i++) {
      if (buf[i] === 0x47 && buf[i + TS_PACKET] === 0x47) return i;
    }
    return buf.length >= TS_PACKET && buf[0] === 0x47 ? 0 : -1;
  }

  function payloadStart(buf, p) {
    var afc = (buf[p + 3] >> 4) & 3;
    if (afc === 1) return p + 4;
    if (afc === 3) return p + 5 + buf[p + 4];
    return -1;                                     // без полезной нагрузки
  }

  /** Разбирает PAT/PMT. Возвращает {pid, type} дорожки звука либо null. */
  function parsePsi(buf, p, end, state) {
    var start = payloadStart(buf, p);
    if (start < 0 || start >= end) return;
    var pid = ((buf[p + 1] & 0x1f) << 8) | buf[p + 2];
    var pusi = (buf[p + 1] & 0x40) !== 0;
    if (!pusi) return;                             // секции длиннее пакета не поддерживаем
    var s = start + 1 + buf[start];                // pointer_field
    var tableId = buf[s];
    var secLen = ((buf[s + 1] & 0x0f) << 8) | buf[s + 2];
    var secEnd = Math.min(s + 3 + secLen - 4, end); // без CRC32

    if (pid === 0 && tableId === 0x00) {
      for (var i = s + 8; i + 4 <= secEnd; i += 4) {
        var prog = (buf[i] << 8) | buf[i + 1];
        var ppid = ((buf[i + 2] & 0x1f) << 8) | buf[i + 3];
        if (prog !== 0) { state.pmtPid = ppid; return; }
      }
    } else if (state.pmtPid === pid && tableId === 0x02) {
      var infoLen = ((buf[s + 10] & 0x0f) << 8) | buf[s + 11];
      var j = s + 12 + infoLen;
      while (j + 5 <= secEnd) {
        var type = buf[j];
        var epid = ((buf[j + 1] & 0x1f) << 8) | buf[j + 2];
        var esLen = ((buf[j + 3] & 0x0f) << 8) | buf[j + 4];
        if (type === STREAM_AAC_ADTS && !state.audio) state.audio = { pid: epid, type: type };
        else if (!state.audio && !state.unsupported &&
                 (STREAM_MPEG_AUDIO.indexOf(type) !== -1 || type === STREAM_AAC_LATM)) {
          state.unsupported = type;
        }
        j += 5 + esLen;
      }
    }
  }

  /** Возвращает непрерывный elementary stream звука из одного сегмента TS. */
  function extractEs(buf, state) {
    var off = findSync(buf);
    if (off < 0) throw new Error('Сегмент не похож на MPEG-TS');
    var parts = [], total = 0;

    for (var p = off; p + TS_PACKET <= buf.length; p += TS_PACKET) {
      if (buf[p] !== 0x47) continue;
      var pid = ((buf[p + 1] & 0x1f) << 8) | buf[p + 2];
      var end = p + TS_PACKET;

      if (pid === 0 || pid === state.pmtPid) { parsePsi(buf, p, end, state); continue; }
      if (!state.audio || pid !== state.audio.pid) continue;

      var start = payloadStart(buf, p);
      if (start < 0 || start >= end) continue;
      if (buf[p + 1] & 0x40) {                     // начало PES-пакета: пропускаем заголовок
        if (buf[start] !== 0 || buf[start + 1] !== 0 || buf[start + 2] !== 1) continue;
        start += 9 + buf[start + 8];
        if (start >= end) continue;
      }
      parts.push(buf.subarray(start, end));
      total += end - start;
    }

    var es = new Uint8Array(total), pos = 0;
    for (var k = 0; k < parts.length; k++) { es.set(parts[k], pos); pos += parts[k].length; }
    return es;
  }

  /* ---------------------------------------------------------------- ADTS */

  /**
   * Режет ES на AAC-кадры. Возвращает {frames:[{off,len}], used, config}.
   * Хвост неполного кадра не потребляется — его подклеит следующий сегмент.
   */
  function parseAdts(es, config) {
    var frames = [], i = 0;
    while (i + 7 <= es.length) {
      if (es[i] !== 0xff || (es[i + 1] & 0xf0) !== 0xf0) { i++; continue; }   // ресинхронизация
      var hdr = (es[i + 1] & 1) ? 7 : 9;
      var len = ((es[i + 3] & 3) << 11) | (es[i + 4] << 3) | (es[i + 5] >> 5);
      if (len < hdr) { i++; continue; }
      if (i + len > es.length) break;              // кадр не дочитан
      var sfi = (es[i + 2] >> 2) & 15;
      var ch = ((es[i + 2] & 1) << 2) | (es[i + 3] >> 6);
      if (sfi > 12) { i++; continue; }
      if (!config.sampleRate) {
        config.sfi = sfi;
        config.sampleRate = SAMPLE_RATES[sfi];
        config.channels = ch || 2;
        config.objectType = (es[i + 2] >> 6) + 1;
      }
      frames.push({ off: i + hdr, len: len - hdr });
      i += len;
    }
    return { frames: frames, used: i };
  }

  /* ------------------------------------------------------------------ MP4 */

  function u32(n) { return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]; }
  function u16(n) { return [(n >> 8) & 255, n & 255]; }
  function ascii(s) { var o = []; for (var i = 0; i < s.length; i++) o.push(s.charCodeAt(i) & 255); return o; }

  function utf8(s) {
    if (typeof TextEncoder !== 'undefined') return Array.from(new TextEncoder().encode(s));
    return Array.from(Buffer.from(s, 'utf8'));
  }

  function box(type, payload) {
    var body = [];
    for (var i = 1; i < arguments.length; i++) body = body.concat(arguments[i]);
    return [].concat(u32(8 + body.length), ascii(type), body);
  }

  function fullBox(type, version, flags, payload) {
    var body = [];
    for (var i = 3; i < arguments.length; i++) body = body.concat(arguments[i]);
    return box(type, [version, (flags >> 16) & 255, (flags >> 8) & 255, flags & 255], body);
  }

  function esds(cfg, avgBitrate, maxFrame) {
    var asc = [(cfg.objectType << 3) | (cfg.sfi >> 1), ((cfg.sfi & 1) << 7) | (cfg.channels << 3)];
    var dec = [0x40, 0x15, 0, 0, 0].concat(
      u32(Math.max(avgBitrate, maxFrame * 8)), u32(avgBitrate),
      [0x05, asc.length], asc);
    var es = [0x00, 0x00, 0x00].concat([0x04, dec.length], dec, [0x06, 0x01, 0x02]);
    return fullBox('esds', 0, 0, [0x03, es.length], es);
  }

  function dataAtom(type, payload) {
    return fullBox('data', 0, type, u32(0), payload);   // null-локаль и тип значения
  }

  function textAtom(name, value) {
    return value ? box(name, dataAtom(1, utf8(String(value)))) : [];   // тип 1 — UTF-8
  }

  /** base64 → байты: обложка приходит из фона строкой, чтобы пережить sendMessage. */
  function base64Bytes(str) {
    var dec = global.atob;
    if (typeof dec === 'function') {
      var bin = dec(str), out = new Array(bin.length);
      for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    }
    return Array.prototype.slice.call(Buffer.from(str, 'base64'));
  }

  /** Обложка: 13 — JPEG, 14 — PNG. Больше двух мегабайт в тег не кладём. */
  function coverAtom(bytes) {
    if (!bytes) return [];
    if (typeof bytes === 'string') bytes = base64Bytes(bytes);
    if (!bytes.length) return [];
    var png = bytes[0] === 0x89 && bytes[1] === 0x50;
    var arr = Array.prototype.slice.call(bytes);
    return box('covr', dataAtom(png ? 14 : 13, arr));
  }

  /**
   * Теги itunes-совместимого вида: название, автор, альбом, дата, номер серии
   * из {track}/{total} и обложка. Именно так их читают VLC, mpv, foobar2000
   * и подкаст-клиенты.
   */
  function metadata(tags) {
    if (typeof tags === 'string') tags = { title: tags };   // старый вызов с одним названием
    tags = tags || {};
    var track = Number(tags.track) || 0;
    var total = Number(tags.total) || 0;
    var items = [].concat(
      textAtom('\xa9nam', tags.title),                    // ©nam
      textAtom('\xa9ART', tags.artist),                   // ©ART — исполнитель
      textAtom('aART', tags.artist),                      // aART — исполнитель альбома
      textAtom('\xa9alb', tags.album),                    // ©alb
      textAtom('\xa9day', tags.date),                     // ©day
      track ? box('trkn', dataAtom(0, [0, 0, (track >> 8) & 255, track & 255,
                                        (total >> 8) & 255, total & 255])) : [],
      coverAtom(tags.cover)
    );
    if (!items.length) return [];
    var hdlr = fullBox('hdlr', 0, 0, u32(0), ascii('mdir'), ascii('appl'), u32(0), u32(0), [0]);
    return box('udta', fullBox('meta', 0, 0, hdlr, box('ilst', items)));
  }

  function buildHead(cfg, sizes, tags, totalBytes) {
    var n = sizes.length;
    var duration = n * SAMPLES_PER_FRAME;
    var seconds = duration / cfg.sampleRate;
    var maxFrame = 0;
    for (var i = 0; i < n; i++) if (sizes[i] > maxFrame) maxFrame = sizes[i];
    var avg = seconds > 0 ? Math.round(totalBytes * 8 / seconds) : 0;
    var ts = cfg.sampleRate;

    var stsz = [].concat([0, 0, 0, 0], u32(0), u32(n));
    for (var k = 0; k < n; k++) stsz = stsz.concat(u32(sizes[k]));
    stsz = box('stsz', stsz);

    var mp4a = box('mp4a',
      [0, 0, 0, 0, 0, 0], u16(1),                  // reserved, data_reference_index
      [0, 0, 0, 0, 0, 0, 0, 0],                    // version, revision, vendor
      u16(cfg.channels), u16(16), u16(0), u16(0),  // channels, bits, pre_defined, reserved
      u32(Math.min(ts, 65535) * 65536),            // sample rate 16.16
      esds(cfg, avg, maxFrame));

    var stbl = box('stbl',
      fullBox('stsd', 0, 0, u32(1), mp4a),
      fullBox('stts', 0, 0, u32(1), u32(n), u32(SAMPLES_PER_FRAME)),
      fullBox('stsc', 0, 0, u32(1), u32(1), u32(n), u32(1)),
      stsz,
      fullBox('stco', 0, 0, u32(1), u32(0)));      // смещение подставим после расчёта

    var matrix = [].concat(u32(0x10000), u32(0), u32(0), u32(0), u32(0x10000), u32(0), u32(0), u32(0), u32(0x40000000));
    var tkhd = fullBox('tkhd', 0, 3, u32(0), u32(0), u32(1), u32(0), u32(duration),
      u32(0), u32(0), u16(0), u16(0), u16(0x0100), u16(0), matrix, u32(0), u32(0));
    var mdhd = fullBox('mdhd', 0, 0, u32(0), u32(0), u32(ts), u32(duration), u16(0x55c4), u16(0));
    var hdlr = fullBox('hdlr', 0, 0, u32(0), ascii('soun'), u32(0), u32(0), u32(0), ascii('SoundHandler'), [0]);
    var dinf = box('dinf', fullBox('dref', 0, 0, u32(1), fullBox('url ', 0, 1)));
    var minf = box('minf', fullBox('smhd', 0, 0, u16(0), u16(0)), dinf, stbl);
    var trak = box('trak', tkhd, box('mdia', mdhd, hdlr, minf));
    var mvhd = fullBox('mvhd', 0, 0, u32(0), u32(0), u32(ts), u32(duration),
      u32(0x10000), u16(0x0100), u16(0), u32(0), u32(0), matrix,
      u32(0), u32(0), u32(0), u32(0), u32(0), u32(0), u32(2));
    var ftyp = box('ftyp', ascii('M4A '), u32(0), ascii('M4A '), ascii('mp42'), ascii('isom'));

    var moov = box('moov', mvhd, trak, metadata(tags));
    var mdatOffset = ftyp.length + moov.length + 8;

    // подставляем смещение первого чанка в stco: это последние 4 байта внутри stbl
    var idx = findLastStco(moov);
    var o = u32(mdatOffset);
    for (var b = 0; b < 4; b++) moov[idx + b] = o[b];

    return { head: ftyp.concat(moov), mdatHeaderSize: 8, seconds: seconds };
  }

  function findLastStco(arr) {
    // 'stco' + version/flags(4) + entry_count(4) + offset(4): ищем последнее вхождение типа
    for (var i = arr.length - 4; i >= 4; i--) {
      if (arr[i] === 0x73 && arr[i + 1] === 0x74 && arr[i + 2] === 0x63 && arr[i + 3] === 0x6f) return i + 4 + 4 + 4;
    }
    throw new Error('stco not found');
  }

  /* ------------------------------------------------------------ extractor */

  function createExtractor(opts) {
    opts = opts || {};
    var state = { pmtPid: -1, audio: null, unsupported: 0 };
    var config = {};
    var leftover = new Uint8Array(0);
    var sizes = [];
    var chunks = [];                               // сжатые кадры по сегментам
    var bytes = 0;

    return {
      push: function (segment) {
        var es = extractEs(segment, state);
        if (!state.audio && state.unsupported) {
          throw new Error('Звук в формате, который нельзя сохранить как M4A (тип потока 0x' +
                          state.unsupported.toString(16) + ')');
        }
        if (leftover.length) {
          var merged = new Uint8Array(leftover.length + es.length);
          merged.set(leftover, 0); merged.set(es, leftover.length);
          es = merged;
        }
        var r = parseAdts(es, config);
        leftover = es.slice(r.used);

        var size = 0, i;
        for (i = 0; i < r.frames.length; i++) size += r.frames[i].len;
        if (!size) return;
        var out = new Uint8Array(size), pos = 0;
        for (i = 0; i < r.frames.length; i++) {
          var f = r.frames[i];
          out.set(es.subarray(f.off, f.off + f.len), pos);
          pos += f.len;
          sizes.push(f.len);
        }
        chunks.push(out);
        bytes += size;
      },

      finish: function () {
        if (!sizes.length) {
          throw new Error(state.audio
            ? 'В потоке не нашлось AAC-кадров'
            : 'В потоке нет звуковой дорожки AAC');
        }
        var built = buildHead(config, sizes, opts.tags || { title: opts.title }, bytes);
        var head = new Uint8Array(built.head.length + 8);
        head.set(built.head, 0);
        head.set(u32(bytes + 8), built.head.length);
        head.set(ascii('mdat'), built.head.length + 4);
        var all = [head].concat(chunks);
        return {
          chunks: all,
          bytes: head.length + bytes,
          durationSec: built.seconds,
          sampleRate: config.sampleRate,
          channels: config.channels
        };
      }
    };
  }

  var API = { createExtractor: createExtractor, _parseAdts: parseAdts, _extractEs: extractEs };
  global.RTAudio = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof globalThis !== 'undefined' ? globalThis : this);
