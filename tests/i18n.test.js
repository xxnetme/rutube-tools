'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const I = require('../src/lib/i18n.js');

const { ru, en, uk, be } = I.dictionaries;
const dictionaries = { ru, en, uk, be };
const placeholders = (s) => (String(s).match(/\{(\w+)\}/g) || []).sort().join(',');

test('ключи всех четырёх словарей совпадают', () => {
  for (const [name, dict] of Object.entries(dictionaries)) {
    assert.deepEqual(Object.keys(dict).sort(), Object.keys(ru).sort(), name);
  }
});

test('плейсхолдеры {n}, {q}… совпадают во всех языках', () => {
  for (const k of Object.keys(ru)) {
    for (const [name, dict] of Object.entries(dictionaries)) {
      assert.equal(placeholders(dict[k]), placeholders(ru[k]), `${name}:${k}`);
    }
  }
});

test('нет пустых строк и незаполненных значений', () => {
  for (const [name, dict] of Object.entries(dictionaries)) {
    for (const [k, v] of Object.entries(dict)) {
      assert.ok(typeof v === 'string' && v.length > 0, `${name}:${k}`);
      assert.notEqual(v, k, `${name}:${k}`);
    }
  }
});

test('t(): подстановка, UK/BE и запасной вариант', () => {
  I.setLang('en');
  assert.equal(I.t('pop.pendingVideo', { n: 2, total: 5 }), 'Part 2 of 5');
  I.setLang('uk');
  assert.equal(I.getLang(), 'uk');
  assert.equal(I.t('pop.pendingVideo', { n: 2, total: 5 }), 'Частина 2 з 5');
  I.setLang('be');
  assert.equal(I.getLang(), 'be');
  assert.equal(I.t('pop.pendingVideo', { n: 2, total: 5 }), 'Частка 2 з 5');
  I.setLang('ru');
  assert.equal(I.t('pop.pendingVideo', { n: 2, total: 5 }), 'Часть 2 из 5');
  assert.equal(I.t('нет.такого'), 'нет.такого');
});

test('detect: explicit UK/BE и региональные варианты не заменяются русским', () => {
  assert.equal(I.detect('uk'), 'uk');
  assert.equal(I.detect('be'), 'be');
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  try {
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { languages: ['uk-UA', 'ru-RU'] } });
    assert.equal(I.detect('auto'), 'uk');
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { languages: ['be-BY', 'en-US'] } });
    assert.equal(I.detect('auto'), 'be');
  } finally {
    if (original) Object.defineProperty(globalThis, 'navigator', original);
    else delete globalThis.navigator;
  }
  I.setLang('ru');
});
