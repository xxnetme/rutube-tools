'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const P = require('../src/lib/protocol.js');

const root = path.resolve(__dirname, '..');
const doc = fs.readFileSync(path.join(root, 'docs/PROTOCOL.md'), 'utf8');

 test('protocol: версия 2 и полный замороженный список типов задокументирован', () => {
  assert.equal(P.VERSION, 2);
  assert.ok(P.TYPES.length >= 25);
  for (const type of P.TYPES) assert.ok(doc.includes('`' + type + '`'), type);
  assert.equal(new Set(P.TYPES).size, P.TYPES.length);
});

test('protocol: stamp добавляет v только новым сообщениям и не мутирует тип', () => {
  const msg = { type: 'rt:info', videoId: 'abc' };
  assert.equal(P.stamp(msg), msg);
  assert.deepEqual(msg, { type: 'rt:info', videoId: 'abc', v: 2 });
  const old = { type: 'rt:info', v: 1 };
  P.stamp(old);
  assert.equal(old.v, 1);
});

test('protocol: 1.x принимается, будущая версия и неизвестный тип отклоняются', () => {
  assert.equal(P.accepts({ type: 'rt:info' }), true);
  assert.equal(P.accepts({ type: 'rt:info', v: 2 }), true);
  assert.equal(P.accepts({ type: 'rt:info', v: 3 }), false);
  assert.equal(P.accepts({ type: 'rt:not-in-schema', v: 2 }), false);
  assert.equal(P.accepts(null), false);
});

test('protocol: все производственные rt:-литералы входят в схему', () => {
  const files = ['src/background.js', 'src/content-core.js', 'src/content-panel.js', 'src/offscreen.js', 'src/popup.js'];
  const literals = new Set();
  for (const file of files) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    for (const match of source.matchAll(/['"](rt:[a-z][a-z0-9-]*)['"]/g)) literals.add(match[1]);
  }
  for (const type of literals) assert.ok(P.isKnown(type), `${type} не описан`);
});
