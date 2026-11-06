/* Настройки, явные миграции 1.x и версионированный JSON backup.
 * История, очередь и OPFS-индексы сюда не входят. */
(function (global) {
  'use strict';

  var SCHEMA_VERSION = 2;
  var STORAGE_VERSION_KEY = 'settingsSchemaVersion';
  var DEFAULTS = {
    fps: 'auto',
    youtubeKeys: false,
    showButton: true,
    quality: 'best',
    maxPartMB: 220,
    lang: 'auto',
    frameKeys: 'comma',
    shotKey: 's',
    frameFormat: 'png',
    frameQuality: 92,
    preservePitch: true,
    rememberPos: true,
    rememberRate: true,
    useOpfs: false,
    defaultFormat: 'video',
    nameTemplate: '{title}',
    saveSubs: false
  };

  function oneOf(values) {
    return function (value) { return values.indexOf(value) !== -1; };
  }

  var VALID = {
    fps: oneOf(['auto', '24', '25', '30', '50', '60']),
    youtubeKeys: function (v) { return typeof v === 'boolean'; },
    showButton: function (v) { return typeof v === 'boolean'; },
    quality: function (v) {
      if (v === 'best' || v === 'worst') return true;
      return typeof v === 'string' && /^\d{3,4}$/.test(v) && Number(v) >= 144 && Number(v) <= 4320;
    },
    maxPartMB: oneOf([100, 220, 400, 800]),
    lang: oneOf(['auto', 'ru', 'en', 'uk', 'be']),
    frameKeys: oneOf(['comma', 'brackets', 'angle']),
    shotKey: oneOf(['s', 'k', 'f']),
    frameFormat: oneOf(['png', 'jpeg', 'webp']),
    frameQuality: function (v) { return Number.isInteger(v) && v >= 70 && v <= 100; },
    preservePitch: function (v) { return typeof v === 'boolean'; },
    rememberPos: function (v) { return typeof v === 'boolean'; },
    rememberRate: function (v) { return typeof v === 'boolean'; },
    useOpfs: function (v) { return typeof v === 'boolean'; },
    defaultFormat: oneOf(['video', 'audio']),
    nameTemplate: function (v) {
      return typeof v === 'string' && v.length <= 256 && !/[\x00-\x1f\x7f]/.test(v);
    },
    saveSubs: function (v) { return typeof v === 'boolean'; }
  };

  function cleanSettings(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('bad-settings');
    var out = {};
    Object.keys(DEFAULTS).forEach(function (key) {
      var value = Object.prototype.hasOwnProperty.call(input, key) ? input[key] : DEFAULTS[key];
      if (!VALID[key](value)) throw new Error('bad-setting:' + key);
      out[key] = value;
    });
    return out;
  }

  /* Каждая миграция получает только объект настроек и возвращает объект для следующей.
   * Неизвестные ключи не копируются: storage.local содержит также rtPending и историю. */
  var MIGRATIONS = {
    1: function (input) {
      var out = Object.assign({}, input);
      // Совместимость с ранними локальными сборками 1.x.
      if (out.frameFormat === 'jpg') out.frameFormat = 'jpeg';
      if (out.maxPartMB === undefined && out.partSizeMB !== undefined) out.maxPartMB = out.partSizeMB;
      if (out.rememberRate === undefined && out.rememberSpeed !== undefined) out.rememberRate = out.rememberSpeed;
      return out;
    }
  };

  function migrateSettings(input, fromVersion) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('bad-settings');
    var version = fromVersion == null ? 1 : Number(fromVersion);
    if (!Number.isInteger(version) || version < 1 || version > SCHEMA_VERSION) throw new Error('bad-schema');
    var out = input;
    for (var v = version; v < SCHEMA_VERSION; v++) {
      if (typeof MIGRATIONS[v] !== 'function') throw new Error('bad-schema');
      out = MIGRATIONS[v](out);
    }
    return cleanSettings(out);
  }

  function migrateStorage(raw) {
    raw = raw || {};
    var version = raw[STORAGE_VERSION_KEY] == null ? 1 : Number(raw[STORAGE_VERSION_KEY]);
    var settings = migrateSettings(raw, version);
    var changed = version !== SCHEMA_VERSION;
    Object.keys(DEFAULTS).forEach(function (key) {
      if (!Object.prototype.hasOwnProperty.call(raw, key) || raw[key] !== settings[key]) changed = true;
    });
    return { settings: settings, changed: changed, fromVersion: version };
  }

  async function load(api) {
    var raw = await api.storage.local.get(null);
    var migrated = migrateStorage(raw || {});
    if (migrated.changed) {
      var payload = Object.assign({}, migrated.settings);
      payload[STORAGE_VERSION_KEY] = SCHEMA_VERSION;
      await api.storage.local.set(payload);
    }
    return migrated.settings;
  }

  function makeBackup(input) {
    return { app: 'rutube-tools', schemaVersion: SCHEMA_VERSION, settings: cleanSettings(input) };
  }

  function parseBackup(text) {
    if (typeof text !== 'string' || text.length > 65536) throw new Error('backup-too-large');
    var data;
    try { data = JSON.parse(text); } catch (e) { throw new Error('bad-json'); }
    if (!data || data.app !== 'rutube-tools' ||
        (data.schemaVersion !== 1 && data.schemaVersion !== SCHEMA_VERSION)) throw new Error('bad-schema');
    return migrateSettings(data.settings, data.schemaVersion);
  }

  var exported = {
    DEFAULTS: DEFAULTS,
    SCHEMA_VERSION: SCHEMA_VERSION,
    STORAGE_VERSION_KEY: STORAGE_VERSION_KEY,
    MIGRATIONS: MIGRATIONS,
    cleanSettings: cleanSettings,
    migrateSettings: migrateSettings,
    migrateStorage: migrateStorage,
    load: load,
    makeBackup: makeBackup,
    parseBackup: parseBackup
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = exported;
  else global.RTSettings = exported;
})(typeof globalThis !== 'undefined' ? globalThis : this);
