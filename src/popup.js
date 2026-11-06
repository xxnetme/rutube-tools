'use strict';
(function () {
  var api = globalThis.browser || globalThis.chrome;
  var I = globalThis.RTI18n;
  var D = globalThis.RTDom;
  var S = globalThis.RTSettings;
  if (!I || !D || !S) return;

  var DEFAULTS = S.DEFAULTS;

  var SELECTS = ['quality', 'fps', 'maxPartMB', 'frameKeys', 'shotKey', 'frameFormat', 'frameQuality', 'lang', 'defaultFormat'];
  var TEXTS = ['nameTemplate'];
  var CHECKS = ['showButton', 'youtubeKeys', 'preservePitch', 'rememberPos', 'rememberRate', 'useOpfs'];

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
    var speedToken = '\u0001', shotToken = '\u0002';
    var hint = I.t('pop.keysHint', { speed: speedToken, shot: shotToken });
    var nodes = [];
    function keys(values) {
      values.forEach(function (value, index) {
        if (index) nodes.push(' ');
        nodes.push(D.h('kbd', { text: value }));
      });
    }
    keys([',', '.']);
    nodes.push(' ');
    hint.split(/(\u0001|\u0002)/).forEach(function (part) {
      if (part === speedToken) keys(['<', '>']);
      else if (part === shotToken) keys([I.t('opt.shot' + DEFAULTS.shotKey.toUpperCase())]);
      else if (part) nodes.push(part);
    });
    D.set(el('keysHint'), nodes);
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
    TEXTS.forEach(function (id) {
      var node = el(id);
      if (node) node.value = String(s[id] == null ? '' : s[id]);
    });
  }

  function read() {
    var out = {};
    SELECTS.forEach(function (id) {
      var node = el(id);
      out[id] = (id === 'maxPartMB' || id === 'frameQuality') ? Number(node.value) : node.value;
    });
    CHECKS.forEach(function (id) {
      out[id] = el(id).checked;
    });
    TEXTS.forEach(function (id) {
      out[id] = el(id).value;
    });
    return out;
  }

  function save() {
    var data = read();
    data[S.STORAGE_VERSION_KEY] = S.SCHEMA_VERSION;
    try { api.storage.local.set(data); } catch (e) {}
    I.setLang(data.lang);
    applyI18n();
  }

  var p = S.load(api);
  if (p && p.then) {
    p.then(function (s) {
      var merged = Object.assign({}, DEFAULTS, s || {});
      I.setLang(merged.lang);
      applyI18n();
      apply(merged);
    }).catch(function () {
      applyI18n();
      apply(DEFAULTS);
    });
  } else {
    applyI18n();
    apply(DEFAULTS);
  }

  SELECTS.concat(CHECKS).forEach(function (id) {
    var node = el(id);
    if (node) node.addEventListener('change', save);
  });

  /* текстовое поле пишется на каждый ввод, но без спешки — чтобы не дёргать storage */
  var textTimer = null;
  TEXTS.forEach(function (id) {
    var node = el(id);
    if (!node) return;
    node.addEventListener('input', function () {
      clearTimeout(textTimer);
      textTimer = setTimeout(save, 250);
    });
    node.addEventListener('change', save);
  });

  el('reset').addEventListener('click', function () {
    var reset = Object.assign({}, DEFAULTS);
    reset[S.STORAGE_VERSION_KEY] = S.SCHEMA_VERSION;
    try { api.storage.local.set(reset); } catch (e) {}
    I.setLang(DEFAULTS.lang);
    applyI18n();
    apply(DEFAULTS);
  });

  /* ------------------------------------------ экспорт / импорт настроек */

  function backupStatus(key) {
    el('backupStatus').textContent = key ? I.t(key) : '';
  }

  el('exportSettings').addEventListener('click', async function () {
    var button = el('exportSettings');
    button.disabled = true;
    backupStatus('');
    var blobUrl = null;
    try {
      var current = await api.storage.local.get(DEFAULTS);
      var backup = S.makeBackup(current);
      var blob = new Blob([JSON.stringify(backup, null, 2) + '\n'], { type: 'application/json' });
      blobUrl = URL.createObjectURL(blob);
      await api.downloads.download({
        url: blobUrl, filename: 'rutube-tools-settings-v2.json', saveAs: true
      });
      backupStatus('pop.exportDone');
    } catch (e) {
      backupStatus('pop.exportFail');
    } finally {
      button.disabled = false;
      if (blobUrl) setTimeout(function () { URL.revokeObjectURL(blobUrl); }, 30000);
    }
  });

  el('importSettings').addEventListener('click', function () {
    backupStatus('');
    el('importFile').click();
  });

  el('importFile').addEventListener('change', async function () {
    var input = el('importFile');
    var file = input.files && input.files[0];
    if (!file) return;
    try {
      if (file.size > 65536) throw new Error('backup-too-large');
      var next = S.parseBackup(await file.text());
      var previous = await api.storage.local.get(DEFAULTS);
      var nextWithVersion = Object.assign({}, next);
      nextWithVersion[S.STORAGE_VERSION_KEY] = S.SCHEMA_VERSION;
      try {
        await api.storage.local.set(nextWithVersion);
      } catch (writeError) {
        // Даже частично записанный импорт не должен оставить смесь старых и новых значений.
        try { await api.storage.local.set(previous); } catch (e) {}
        throw writeError;
      }
      I.setLang(next.lang);
      applyI18n();
      apply(next);
      backupStatus('pop.importDone');
    } catch (e) {
      backupStatus('pop.importFail');
    } finally {
      input.value = '';
    }
  });

  /* ---------------------------------------------- незавершённые загрузки */

  function send(msg) {
    try {
      var r = api.runtime.sendMessage(globalThis.RTProtocol ? globalThis.RTProtocol.stamp(msg) : msg);
      return r && r.then ? r.catch(function () { return null; }) : Promise.resolve(null);
    } catch (e) { return Promise.resolve(null); }
  }

  function pendingStatus(r) {
    var kind = r.audio ? ' · ' + I.t('pop.pendingAudio') : '';
    if (r.running) {
      if (r.paused) return I.t('pop.pausedShort') + kind;
      var progress = r.progress || {};
      var pr = typeof progress.percent === 'number' ? progress.percent : 0;
      var text = I.t('pop.pendingRunning', { p: pr }) + kind;
      if (progress.bytes > 0 && progress.ms > 500) {
        var speed = progress.bytes / (1024 * 1024) / (progress.ms / 1000);
        text += ' · ' + I.t('pop.speed', { v: speed.toFixed(1) });
      }
      return text;
    }
    var pos = r.kind === 'playlist'
      ? I.t('pop.pendingPlaylist', { n: Math.max(0, (r.nextIndex || 0) - (r.fromIndex || 0)) + 1, total: r.total || '?' })
      : I.t('pop.pendingVideo', { n: (r.nextPart || 0) + 1, total: r.partsTotal || '?' });
    if (r.status === 'paused') return pos + kind + ' · ' + I.t('pop.pendingPaused');
    if (r.status === 'error' && r.error) {
      return pos + kind + ' · ' + I.t('pop.pendingError') + ': ' + String(r.error).slice(0, 80);
    }
    return pos + kind + ' · ' + I.t('pop.pendingBroken');
  }

  function renderPending(items) {
    var wrap = el('pendingWrap'), list = el('pendingList');
    wrap.hidden = !items.length;
    while (list.firstChild) list.removeChild(list.firstChild);
    items.forEach(function (r) {
      var row = document.createElement('div');
      row.className = 'pend';

      var txt = document.createElement('div');
      txt.className = 'txt';
      var ttl = document.createElement('div');
      ttl.className = 'ttl';
      ttl.textContent = r.title || r.videoId || r.playlistId || '—';
      var st = document.createElement('div');
      st.className = 'st';
      st.textContent = pendingStatus(r);
      txt.appendChild(ttl);
      txt.appendChild(st);
      row.appendChild(txt);

      if (r.running) {
        var pause = document.createElement('button');
        pause.textContent = I.t(r.paused ? 'pop.resume' : 'dl.pause');
        pause.disabled = r.kind !== 'playlist' && r.paused;
        pause.addEventListener('click', function () {
          pause.disabled = true;
          send({ type: r.paused ? 'rt:resume' : 'rt:pause', jobId: r.jobId }).then(refreshPending);
        });
        row.appendChild(pause);
      } else {
        var go = document.createElement('button');
        go.className = 'go';
        go.textContent = I.t('pop.resume');
        go.addEventListener('click', function () {
          go.disabled = true;
          send({ type: 'rt:pending-resume', id: r.id }).then(refreshPending);
        });
        row.appendChild(go);
      }
      var rm = document.createElement('button');
      rm.textContent = I.t('pop.discard');
      rm.addEventListener('click', function () {
        send({ type: 'rt:pending-discard', id: r.id }).then(refreshPending);
      });
      row.appendChild(rm);
      list.appendChild(row);
    });
  }

  function refreshPending() {
    return send({ type: 'rt:pending-list' }).then(function (r) {
      if (r && r.ok) renderPending(r.items || []);
    });
  }
  refreshPending();
  setInterval(refreshPending, 1500);

  /* --------------------------------------------------------- история файлов */

  function renderHistory(items) {
    var wrap = el('historyWrap'), list = el('historyList');
    wrap.hidden = !items.length;
    while (list.firstChild) list.removeChild(list.firstChild);
    items.forEach(function (r) {
      var row = document.createElement('div');
      row.className = 'pend';

      var txt = document.createElement('div');
      txt.className = 'txt';
      var ttl = document.createElement('div');
      ttl.className = 'ttl';
      ttl.textContent = r.name || '—';
      var st = document.createElement('div');
      st.className = 'st';
      st.textContent = I.t('pop.historyWhen', { t: when(r.at) });
      txt.appendChild(ttl);
      txt.appendChild(st);
      row.appendChild(txt);

      var go = document.createElement('button');
      go.className = 'go';
      go.textContent = I.t('pop.showFile');
      go.addEventListener('click', function () {
        go.disabled = true;
        send({ type: 'rt:show-download', id: r.id }).then(function (res) {
          go.disabled = false;
          if (!res || !res.ok) st.textContent = I.t('pop.showFail');
        });
      });
      row.appendChild(go);
      list.appendChild(row);
    });
  }

  /** «5 мин назад», «вчера», «02.11» — короче, чем полная дата. */
  function when(ts) {
    var diff = Math.max(0, Date.now() - (ts || 0));
    if (diff < 60000) return I.t('pop.now');
    if (diff < 3600000) return I.t('pop.minAgo', { n: Math.round(diff / 60000) });
    if (diff < 86400000) return I.t('pop.hourAgo', { n: Math.round(diff / 3600000) });
    var d = new Date(ts);
    return ('0' + d.getDate()).slice(-2) + '.' + ('0' + (d.getMonth() + 1)).slice(-2);
  }

  function refreshHistory() {
    return send({ type: 'rt:history-list' }).then(function (r) {
      if (r && r.ok) renderHistory(r.items || []);
    });
  }
  refreshHistory();

  el('historyClear').addEventListener('click', function () {
    send({ type: 'rt:history-clear' }).then(refreshHistory);
  });

  try {
    el('ver').textContent = 'v' + api.runtime.getManifest().version;
  } catch (e) {}
})();
