'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../src/lib/settings.js');

test('settings backup: defaults roundtrip и только разрешённые ключи', () => {
  const backup = S.makeBackup(Object.assign({}, S.DEFAULTS, {
    rtPending: [{ id: 'x' }], rtHistory: [{ id: 1 }], rtDebug: true, unknown: 'x'
  }));
  assert.equal(backup.app, 'rutube-tools');
  assert.equal(backup.schemaVersion, 1);
  assert.deepEqual(Object.keys(backup.settings).sort(), Object.keys(S.DEFAULTS).sort());
  assert.equal('rtPending' in backup.settings, false);
  assert.equal('rtHistory' in backup.settings, false);
  assert.equal('rtDebug' in backup.settings, false);
  assert.deepEqual(S.parseBackup(JSON.stringify(backup)), S.DEFAULTS);
});

test('settings backup: пользовательские значения сохраняются, отсутствующие получают defaults', () => {
  const clean = S.parseBackup(JSON.stringify({
    app: 'rutube-tools', schemaVersion: 1,
    settings: { quality: '1080', maxPartMB: 400, frameQuality: 85, saveSubs: true, futureKey: 1 }
  }));
  assert.equal(clean.quality, '1080');
  assert.equal(clean.maxPartMB, 400);
  assert.equal(clean.frameQuality, 85);
  assert.equal(clean.saveSubs, true);
  assert.equal(clean.fps, S.DEFAULTS.fps);
  assert.equal('futureKey' in clean, false);
});

test('settings backup: неправильные типы и значения отклоняют весь файл', () => {
  const bad = [
    ['fps', 25], ['quality', 1080], ['quality', '100'], ['maxPartMB', '220'],
    ['frameQuality', 69], ['frameQuality', 92.5], ['lang', 'uk'], ['shotKey', 'x'],
    ['frameFormat', 'gif'], ['showButton', 1], ['nameTemplate', 'a\nb'],
    ['nameTemplate', 'x'.repeat(257)], ['defaultFormat', 'audio/m4a']
  ];
  for (const [key, value] of bad) {
    const settings = Object.assign({}, S.DEFAULTS, { [key]: value });
    assert.throws(() => S.makeBackup(settings), { message: 'bad-setting:' + key }, key);
  }
});

test('settings backup: схема, JSON и размер проверяются до применения', () => {
  assert.throws(() => S.parseBackup('{'), { message: 'bad-json' });
  assert.throws(() => S.parseBackup('null'), { message: 'bad-schema' });
  assert.throws(() => S.parseBackup(JSON.stringify({ app: 'other', schemaVersion: 1, settings: {} })), { message: 'bad-schema' });
  assert.throws(() => S.parseBackup(JSON.stringify({ app: 'rutube-tools', schemaVersion: 2, settings: {} })), { message: 'bad-schema' });
  assert.throws(() => S.parseBackup(JSON.stringify({ app: 'rutube-tools', schemaVersion: 1, settings: [] })), { message: 'bad-settings' });
  assert.throws(() => S.parseBackup('x'.repeat(65537)), { message: 'backup-too-large' });
});

test('settings backup: __proto__ не проходит, имя остаётся данными, а не HTML', () => {
  const text = '{"app":"rutube-tools","schemaVersion":1,"settings":{"__proto__":{"polluted":true},"nameTemplate":"<img src=x>"}}';
  const clean = S.parseBackup(text);
  assert.equal({}.polluted, undefined);
  assert.equal(Object.prototype.hasOwnProperty.call(clean, '__proto__'), false);
  assert.equal(clean.nameTemplate, '<img src=x>');
});
