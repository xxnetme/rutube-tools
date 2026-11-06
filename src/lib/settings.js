/* Настройки и версионированный JSON backup. Не содержит истории и незавершённых загрузок. */
(function (global) {
  'use strict';

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
    lang: oneOf(['auto', 'ru', 'en']),
    frameKeys: oneOf(['comma', 'brackets', 'angle']),
    shotKey: oneOf(['s', 'k', 'f']),
    frameFormat: oneOf(['png', 'jpeg', 'webp']),
    frameQuality: function (v) { return Number.isInteger(v) && v >= 70 && v <= 100; },
    preservePitch: function (v) { return typeof v === 'boolean'; },
    rememberPos: function (v) { return typeof v === 'boolean'; },
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

  function makeBackup(input) {
    return { app: 'rutube-tools', schemaVersion: 1, settings: cleanSettings(input) };
  }

  function parseBackup(text) {
    if (typeof text !== 'string' || text.length > 65536) throw new Error('backup-too-large');
    var data;
    try { data = JSON.parse(text); } catch (e) { throw new Error('bad-json'); }
    if (!data || data.app !== 'rutube-tools' || data.schemaVersion !== 1) throw new Error('bad-schema');
    return cleanSettings(data.settings);
  }

  var exported = { DEFAULTS: DEFAULTS, cleanSettings: cleanSettings, makeBackup: makeBackup, parseBackup: parseBackup };
  if (typeof module !== 'undefined' && module.exports) module.exports = exported;
  else global.RTSettings = exported;
})(typeof globalThis !== 'undefined' ? globalThis : this);
