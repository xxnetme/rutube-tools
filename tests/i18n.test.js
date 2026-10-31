'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const I = require('../src/lib/i18n.js');

const { ru, en } = I.dictionaries;
const placeholders = (s) => (String(s).match(/\{(\w+)\}/g) || []).sort().join(',');

test('ключи RU и EN совпадают', () => {
  assert.deepEqual(Object.keys(ru).sort(), Object.keys(en).sort());
});

test('плейсхолдеры {n}, {q}… совпадают в обоих языках', () => {
  for (const k of Object.keys(ru)) assert.equal(placeholders(en[k]), placeholders(ru[k]), k);
});

test('нет пустых строк', () => {
  for (const d of [ru, en]) for (const [k, v] of Object.entries(d)) assert.ok(String(v).length > 0, k);
});

test('t(): подстановка и запасной вариант', () => {
  I.setLang('en');
  assert.equal(I.t('pop.pendingVideo', { n: 2, total: 5 }), 'Part 2 of 5');
  I.setLang('ru');
  assert.equal(I.t('pop.pendingVideo', { n: 2, total: 5 }), 'Часть 2 из 5');
  assert.equal(I.t('нет.такого'), 'нет.такого');
});
