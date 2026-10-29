'use strict';
(function () {
  var api = globalThis.browser || globalThis.chrome;
  var I = globalThis.RTI18n;

  var DEFAULTS = {
    fps: 'auto',
    youtubeKeys: false,
    showButton: true,
    quality: 'best',
    maxPartMB: 220,
    lang: 'auto',
    frameKeys: 'comma',
    shotKey: 's',
    preservePitch: true,
    rememberPos: true
  };

  var SELECTS = ['quality', 'fps', 'maxPartMB', 'frameKeys', 'shotKey', 'lang'];
  var CHECKS = ['showButton', 'youtubeKeys', 'preservePitch', 'rememberPos'];

  function el(id) { return document.getElementById(id); }

  function applyI18n() {
    Array.prototype.forEach.call(document.querySelectorAll('[data-i18n]'), function (node) {
      var key = node.getAttribute('data-i18n');
      var text = I.t(key);
      if (node.tagName === 'OPTION') node.textContent = text;
      else node.textContent = text;
    });
    var lang = I.getLang();
    document.documentElement.lang = lang;
    el('keysHint').innerHTML =
      '<kbd>,</kbd> <kbd>.</kbd> ' + I.t('pop.keysHint', {
        speed: '<kbd>&lt;</kbd> <kbd>&gt;</kbd>',
        shot: '<kbd>' + I.t('opt.shot' + DEFAULTS.shotKey.toUpperCase()) + '</kbd>'
      }).replace(/&amp;lt;/g, '&lt;').replace(/&amp;gt;/g, '&gt;');
  }

  function apply(s) {
    SELECTS.forEach(function (id) {
      var node = el(id);
      if (node) node.value = String(s[id]);
    });
    CHECKS.forEach(function (id) {
      var node = el(id);
      if (node) node.checked = !!s[id];
    });
  }

  function read() {
    var out = {};
    SELECTS.forEach(function (id) {
      var node = el(id);
      out[id] = id === 'maxPartMB' ? Number(node.value) : node.value;
    });
    CHECKS.forEach(function (id) {
      out[id] = el(id).checked;
    });
    return out;
  }

  function save() {
    var data = read();
    try { api.storage.local.set(data); } catch (e) {}
    I.setLang(data.lang);
    applyI18n();
  }

  var p = api.storage.local.get(DEFAULTS);
  if (p && p.then) {
    p.then(function (s) {
      var merged = Object.assign({}, DEFAULTS, s || {});
      I.setLang(merged.lang);
      applyI18n();
      apply(merged);
    });
  } else {
    applyI18n();
    apply(DEFAULTS);
  }

  SELECTS.concat(CHECKS).forEach(function (id) {
    var node = el(id);
    if (node) node.addEventListener('change', save);
  });

  el('reset').addEventListener('click', function () {
    try { api.storage.local.set(DEFAULTS); } catch (e) {}
    I.setLang(DEFAULTS.lang);
    applyI18n();
    apply(DEFAULTS);
  });

  try {
    el('ver').textContent = 'v' + api.runtime.getManifest().version;
  } catch (e) {}
})();
