'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../src/lib/settings.js');

test('settings 1.x → 2: сохраняет старые ключи, применяет aliases и не трогает очередь', () => {
  const raw = {
    quality: '720', frameFormat: 'jpg', partSizeMB: 400, rememberSpeed: false,
    rtPending: [{ id: 'keep-me' }], rtHistory: [{ id: 4 }]
  };
  const migrated = S.migrateStorage(raw);
  assert.equal(migrated.fromVersion, 1);
  assert.equal(migrated.changed, true);
  assert.equal(migrated.settings.quality, '720');
  assert.equal(migrated.settings.frameFormat, 'jpeg');
  assert.equal(migrated.settings.maxPartMB, 400);
  assert.equal(migrated.settings.rememberRate, false);
  assert.equal(migrated.settings.rememberPos, S.DEFAULTS.rememberPos);
  assert.equal(raw.rtPending[0].id, 'keep-me');
  assert.equal('rtPending' in migrated.settings, false);
  assert.equal('settingsSchemaVersion' in migrated.settings, false);
});

test('settings storage load: пишет версию и defaults один раз, сохраняя посторонние записи', async () => {
  const store = { quality: '1080', rtPending: [{ id: 'job' }] };
  const api = { storage: { local: {
    get: async () => JSON.parse(JSON.stringify(store)),
    set: async (patch) => Object.assign(store, JSON.parse(JSON.stringify(patch)))
  } } };
  const first = await S.load(api);
  assert.equal(first.quality, '1080');
  assert.equal(store.settingsSchemaVersion, 2);
  assert.equal(store.rtPending[0].id, 'job');
  assert.equal(S.migrateStorage(store).changed, false);
  const second = await S.load(api);
  assert.deepEqual(second, first);
});

test('settings storage: неизвестная будущая версия отклоняется, не перезаписывая данные', () => {
  assert.throws(() => S.migrateStorage({ settingsSchemaVersion: 99, quality: '720' }), { message: 'bad-schema' });
});
