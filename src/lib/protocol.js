/* RuTube Tools — frozen rt:* protocol, version 2.
 * v отсутствует только у сообщений 1.x; неизвестная будущая версия отклоняется.
 * Список типов и полей синхронизируется с docs/PROTOCOL.md и tests/protocol.test.js. */
(function (global) {
  'use strict';
  var VERSION = 2;
  var TYPES = [
    'rt:cancel', 'rt:diagnostics', 'rt:history-clear', 'rt:history-list', 'rt:info',
    'rt:keepalive', 'rt:offscreen-cancel', 'rt:offscreen-cleanup', 'rt:offscreen-data-url',
    'rt:offscreen-ping', 'rt:offscreen-progress', 'rt:offscreen-run', 'rt:offscreen-segment',
    'rt:offscreen-storage', 'rt:pause', 'rt:pending-discard', 'rt:pending-list',
    'rt:pending-resume', 'rt:ping', 'rt:playlist-info', 'rt:playlist-videos', 'rt:progress',
    'rt:resume', 'rt:save-data-url', 'rt:save-url', 'rt:save-vtt', 'rt:show-download',
    'rt:start', 'rt:start-playlist'
  ];
  var known = Object.create(null);
  TYPES.forEach(function (type) { known[type] = true; });

  function stamp(message) {
    if (message && typeof message.type === 'string' && message.v == null) message.v = VERSION;
    return message;
  }

  function accepts(message) {
    return !!(message && typeof message.type === 'string' &&
      (message.v == null || message.v === VERSION) && known[message.type]);
  }

  var api = {
    VERSION: VERSION,
    TYPES: Object.freeze(TYPES.slice()),
    stamp: stamp,
    accepts: accepts,
    isKnown: function (type) { return known[type] === true; }
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.RTProtocol = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
