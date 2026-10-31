'use strict';
/* Сборка синтетических MPEG-TS для тестов: PAT, PMT, видео-«шум» и звук AAC в PES.
 * Нужна, чтобы проверять извлечение звука без ffmpeg и на заранее известных данных. */

const PID_PMT = 0x100, PID_VIDEO = 0x101, PID_AUDIO = 0x102;

function adtsFrame(payloadLen, seed, opts) {
  opts = opts || {};
  const sfi = opts.sfi === undefined ? 4 : opts.sfi;          // 4 = 44100 Гц
  const ch = opts.channels || 2;
  const len = 7 + payloadLen;
  const head = [
    0xff, 0xf1,                                              // sync, MPEG-4, layer 0, без CRC
    (1 << 6) | (sfi << 2) | ((ch >> 2) & 1),                 // профиль LC, частота, канал (старший бит)
    ((ch & 3) << 6) | ((len >> 11) & 3),
    (len >> 3) & 0xff,
    ((len & 7) << 5) | 0x1f,
    0xfc
  ];
  const body = Buffer.alloc(payloadLen);
  for (let i = 0; i < payloadLen; i++) body[i] = (seed * 31 + i * 7) & 0xff;
  return { raw: body, adts: Buffer.concat([Buffer.from(head), body]) };
}

function tsPacket(pid, pusi, cc, data) {
  const pkt = Buffer.alloc(188, 0xff);
  pkt[0] = 0x47;
  pkt[1] = (pusi ? 0x40 : 0) | (pid >> 8);
  pkt[2] = pid & 0xff;
  const stuff = 184 - data.length;
  if (stuff === 0) {
    pkt[3] = 0x10 | (cc & 15);
    data.copy(pkt, 4);
  } else {
    pkt[3] = 0x30 | (cc & 15);
    const afLen = stuff - 1;
    pkt[4] = afLen;
    if (afLen > 0) { pkt[5] = 0; pkt.fill(0xff, 6, 5 + afLen); }
    data.copy(pkt, 4 + stuff);
  }
  return pkt;
}

function psi(pid, section) {
  const data = Buffer.concat([Buffer.from([0]), section]);   // pointer_field
  return tsPacket(pid, true, 0, Buffer.concat([data, Buffer.alloc(184 - data.length, 0xff)]));
}

function pat() {
  return psi(0, Buffer.from([0x00, 0xb0, 13, 0, 1, 0xc1, 0, 0, 0, 1, 0xe0 | (PID_PMT >> 8), PID_PMT & 0xff, 0, 0, 0, 0]));
}

function pmt(audioType) {
  const streams = [];
  streams.push(0x1b, 0xe0 | (PID_VIDEO >> 8), PID_VIDEO & 0xff, 0xf0, 0);
  if (audioType !== null) streams.push(audioType, 0xe0 | (PID_AUDIO >> 8), PID_AUDIO & 0xff, 0xf0, 0);
  const len = 9 + streams.length + 4;
  return psi(PID_PMT, Buffer.from([0x02, 0xb0, len, 0, 1, 0xc1, 0, 0,
    0xe0 | (PID_VIDEO >> 8), PID_VIDEO & 0xff, 0xf0, 0, ...streams, 0, 0, 0, 0]));
}

function pes(streamId, es) {
  const head = Buffer.from([0, 0, 1, streamId, 0, 0, 0x80, 0x80, 5, 0x21, 0, 1, 0, 1]);  // PTS-заголовок, 5 байт
  return Buffer.concat([head, es]);
}

function packetize(pid, payload, ccRef) {
  const out = [];
  for (let off = 0, first = true; off < payload.length; off += 184, first = false) {
    out.push(tsPacket(pid, first, ccRef.cc++, payload.subarray(off, off + 184)));
  }
  return out;
}

/**
 * esChunks — куски elementary stream звука (по одному PES на каждый). Резать можно по любым
 * байтам, не по границам кадров: так проверяется склейка кадров между PES и сегментами.
 */
function buildTs(esChunks, opts) {
  opts = opts || {};
  const audioType = opts.audioType === undefined ? 0x0f : opts.audioType;
  const pkts = [pat(), pmt(audioType)];
  const vcc = { cc: 0 }, acc = { cc: 0 };
  esChunks.forEach((es, i) => {
    const noise = Buffer.alloc(500 + (i % 3) * 300, i + 1);
    pkts.push(...packetize(PID_VIDEO, pes(0xe0, noise), vcc));
    if (audioType !== null) pkts.push(...packetize(PID_AUDIO, pes(0xc0, es), acc));
  });
  return Buffer.concat(pkts);
}

/** Режет поток байт на куски заданных размеров (последний — остаток). */
function slice(buf, sizes) {
  const out = []; let pos = 0;
  for (const n of sizes) { out.push(buf.subarray(pos, pos + n)); pos += n; }
  if (pos < buf.length) out.push(buf.subarray(pos));
  return out;
}

/* ---- минимальный разбор M4A для проверок ---- */

function readBoxes(buf, start, end) {
  const boxes = [];
  for (let p = start; p + 8 <= end;) {
    const size = buf.readUInt32BE(p);
    const type = buf.toString('latin1', p + 4, p + 8);
    if (size < 8) break;
    boxes.push({ type, start: p, dataStart: p + 8, end: p + size });
    p += size;
  }
  return boxes;
}

function find(buf, box, path) {
  let cur = box;
  for (const t of path) {
    const kids = readBoxes(buf, cur.dataStart + (cur.type === 'meta' ? 4 : 0), cur.end);
    cur = kids.find((b) => b.type === t);
    if (!cur) return null;
  }
  return cur;
}

function parseM4a(buf) {
  const top = readBoxes(buf, 0, buf.length);
  const moov = top.find((b) => b.type === 'moov');
  const mdat = top.find((b) => b.type === 'mdat');
  const stbl = find(buf, moov, ['trak', 'mdia', 'minf', 'stbl']);
  const stsz = find(buf, stbl, ['stsz']);
  const count = buf.readUInt32BE(stsz.dataStart + 8);
  const sizes = [];
  for (let i = 0; i < count; i++) sizes.push(buf.readUInt32BE(stsz.dataStart + 12 + i * 4));
  const stco = find(buf, stbl, ['stco']);
  const offset = buf.readUInt32BE(stco.dataStart + 8);
  const frames = []; let pos = offset;
  for (const n of sizes) { frames.push(buf.subarray(pos, pos + n)); pos += n; }
  return { top: top.map((b) => b.type), sizes, offset, mdat, frames, moov, stbl };
}

module.exports = { adtsFrame, buildTs, slice, parseM4a, PID_AUDIO };
