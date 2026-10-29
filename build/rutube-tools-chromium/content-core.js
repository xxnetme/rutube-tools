/* RuTube Tools — ядро интерфейса: кнопка, вкладки, тосты, клавиши, кадры.
 * Панель вкладок рисует content-panel.js через window.RTPanel.render().
 */
'use strict';
(function () {
  if (window.__rtToolsLoaded) return;
  window.__rtToolsLoaded = true;

  var api = globalThis.browser || globalThis.chrome;
  var L = globalThis.RTLib;
  var I = globalThis.RTI18n;
  if (!api || !L || !I) return;

  var t = I.t;

  var DEFAULTS = {
    fps: 'auto',
    youtubeKeys: false,
    showButton: true,
    quality: 'best',
    maxPartMB: 220,
    lang: 'auto',
    frameKeys: 'comma',     // comma | brackets | angle
    shotKey: 's',           // s | k | f
    preservePitch: true,
    rememberPos: true
  };

  var settings = Object.assign({}, DEFAULTS);

  var state = {
    videoId: null,
    info: null,
    infoFor: null,
    infoLoading: false,
    metaLoaded: false,
    playlist: null,
    playlistLoading: false,
    playlistId: null,
    choice: null,
    job: null,
    progress: null,
    lastRequest: null,
    lastResult: null,
    tab: 'download',
    mode: 'full',           // full | part
    from: '',
    to: '',
    fpsCache: Object.create(null),
    fpsRequested: null,
    panelOpen: false,
    ab: { a: null, b: null, loop: false },
    boardBusy: false,
    storyboard: { every: 5, count: 12 }
  };

  /* ------------------------------------------------------------- утилиты */

  function isEditable(el) {
    if (!el || !el.tagName) return false;
    var tag = el.tagName.toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
    if (el.isContentEditable) return true;
    return false;
  }

  function findVideo(root) {
    root = root || document;
    var list = Array.prototype.slice.call(root.querySelectorAll('video'));
    var best = null, bestArea = 0;
    list.forEach(function (v) {
      var r = v.getBoundingClientRect();
      var area = Math.max(0, r.width) * Math.max(0, r.height);
      if (r.width >= 200 && r.height >= 112 && area > bestArea) { best = v; bestArea = area; }
    });
    return best || list[0] || null;
  }

  function findVideoDeep(depth, root) {
    depth = depth === undefined ? 3 : depth;
    root = root || document;
    var v = findVideo(root);
    if (v) {
      var r = v.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) return v;
    }
    if (depth <= 0) return v;
    var frames = root.querySelectorAll('iframe');
    for (var i = 0; i < frames.length; i++) {
      try {
        var d = frames[i].contentDocument;
        if (!d) continue;
        var inner = findVideoDeep(depth - 1, d);
        if (inner) return inner;
      } catch (e) {}
    }
    return v;
  }

  function getPlayerVideo() { return findVideoDeep(); }

  function timecode(sec) {
    sec = Math.max(0, sec || 0);
    var h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = Math.floor(sec % 60);
    var cs = Math.floor((sec % 1) * 100);
    var base = (h ? h + ':' + String(m).padStart(2, '0') : String(m)) + ':' + String(s).padStart(2, '0');
    return base + '.' + String(cs).padStart(2, '0');
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function sendMessage(msg) {
    return new Promise(function (resolve) {
      try {
        var p = api.runtime.sendMessage(msg);
        if (p && p.then) p.then(resolve, function (e) { resolve({ ok: false, error: String((e && e.message) || e) }); });
        else resolve({ ok: false, error: 'no response' });
      } catch (e) { resolve({ ok: false, error: String((e && e.message) || e) }); }
    });
  }

  function copyText(text, okMessage) {
    function done() { if (okMessage) toast(okMessage); }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { legacyCopy(text); done(); });
    } else { legacyCopy(text); done(); }
  }

  function legacyCopy(text) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;left:-9999px;top:0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    } catch (e) {}
  }

  /* -------------------------------------------------------------- настройки */

  function loadSettings() {
    try {
      var p = api.storage.local.get(DEFAULTS);
      if (p && p.then) p.then(function (v) {
        settings = Object.assign({}, DEFAULTS, v || {});
        I.setLang(settings.lang);
        onSettingsChanged();
      });
    } catch (e) {}
  }

  try {
    api.storage.onChanged.addListener(function (changes, area) {
      if (area !== 'local') return;
      var touched = false;
      Object.keys(changes).forEach(function (k) {
        if (k in DEFAULTS) { settings[k] = changes[k].newValue; touched = true; }
      });
      if (touched) { I.setLang(settings.lang); onSettingsChanged(); }
    });
  } catch (e) {}

  function onSettingsChanged() {
    if (ui) {
      buildTabs();
      if (window.RTPanel && state.panelOpen) window.RTPanel.render();
    }
    ensureUI();
  }

  /* ------------------------------------------------------------------ CSS */

  var CSS = [
    ':host{all:initial}',
    '*{box-sizing:border-box;margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif}',
    '.wrap{position:fixed;right:14px;bottom:78px;z-index:2147483000;display:flex;flex-direction:column;align-items:flex-end;gap:8px;font-size:13px;line-height:1.35}',
    '.pill{display:flex;align-items:center;gap:7px;background:rgba(18,18,20,.86);color:#fff;border:1px solid rgba(255,255,255,.16);border-radius:999px;padding:8px 13px 8px 11px;cursor:pointer;font-size:13px;font-weight:600;letter-spacing:.2px;backdrop-filter:blur(10px);box-shadow:0 4px 18px rgba(0,0,0,.35);transition:background .15s,transform .15s}',
    '.pill:hover{background:rgba(35,35,38,.95);transform:translateY(-1px)}',
    '.pill svg{width:15px;height:15px;display:block}',
    '.card{width:332px;max-height:min(78vh,720px);display:flex;flex-direction:column;background:rgba(20,20,23,.97);color:#f2f2f4;border:1px solid rgba(255,255,255,.12);border-radius:14px;box-shadow:0 18px 50px rgba(0,0,0,.55);overflow:hidden;backdrop-filter:blur(16px)}',
    '.hd{display:flex;align-items:center;gap:8px;padding:11px 12px 9px;border-bottom:1px solid rgba(255,255,255,.09);flex:0 0 auto}',
    '.hd .t{font-weight:700;font-size:13px;letter-spacing:.3px;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.hd .badge{font-size:10px;font-weight:700;letter-spacing:.6px;text-transform:uppercase;color:#ff6b6b;border:1px solid rgba(255,107,107,.45);padding:2px 6px;border-radius:6px}',
    '.x{background:none;border:0;color:#9a9aa2;font-size:18px;line-height:1;cursor:pointer;padding:2px 4px;border-radius:6px}',
    '.x:hover{color:#fff;background:rgba(255,255,255,.08)}',
    '.tabs{display:flex;gap:2px;padding:0 8px;border-bottom:1px solid rgba(255,255,255,.09);flex:0 0 auto}',
    '.tabs button{flex:1;background:none;border:0;border-bottom:2px solid transparent;color:#8f8f99;font-size:12px;font-weight:600;padding:8px 4px 7px;cursor:pointer;transition:color .12s,border-color .12s}',
    '.tabs button:hover{color:#d8d8de}',
    '.tabs button.on{color:#fff;border-bottom-color:#ff3b3b}',
    '.bd{padding:12px;overflow-y:auto;overflow-x:hidden;flex:1 1 auto;scrollbar-width:thin}',
    '.bd::-webkit-scrollbar{width:8px}',
    '.bd::-webkit-scrollbar-thumb{background:rgba(255,255,255,.16);border-radius:8px}',
    '.muted{color:#9a9aa2;font-size:12px}',
    '.title{font-size:12px;color:#c9c9d1;margin-bottom:10px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}',
    '.sect{margin:0 0 12px}',
    '.sect:last-child{margin-bottom:2px}',
    '.sect h5{font-size:11px;text-transform:uppercase;letter-spacing:.7px;color:#7f7f8a;margin-bottom:7px;font-weight:700}',
    '.q{display:flex;flex-direction:column;gap:3px}',
    '.q label{display:flex;align-items:center;gap:9px;padding:6px 8px;border-radius:8px;cursor:pointer;border:1px solid transparent}',
    '.q label:hover{background:rgba(255,255,255,.06)}',
    '.q input{display:none}',
    '.q .radio{width:14px;height:14px;border-radius:50%;border:2px solid #55555f;flex:0 0 auto;position:relative}',
    '.q input:checked + .radio{border-color:#ff4d4d}',
    '.q input:checked + .radio:after{content:"";position:absolute;inset:2px;border-radius:50%;background:#ff4d4d}',
    '.q .lbl{font-weight:600;font-size:13px}',
    '.q .est{margin-left:auto;color:#8f8f99;font-size:11px;font-variant-numeric:tabular-nums}',
    '.q label.dis{opacity:.45;cursor:not-allowed}',
    '.seg{display:flex;background:rgba(255,255,255,.07);border-radius:9px;padding:2px;margin-bottom:10px}',
    '.seg button{flex:1;background:none;border:0;color:#a6a6b0;font-size:12px;font-weight:600;padding:6px 4px;border-radius:7px;cursor:pointer}',
    '.seg button.on{background:#ff3b3b;color:#fff}',
    '.row{display:flex;gap:8px;align-items:center}',
    '.row + .row{margin-top:8px}',
    '.btn{flex:1;background:#ff3b3b;color:#fff;border:0;border-radius:9px;padding:10px 12px;font-size:13px;font-weight:700;cursor:pointer;transition:background .15s}',
    '.btn:hover{background:#ff5252}',
    '.btn:disabled{background:#4a4a52;cursor:default}',
    '.btn.ghost{flex:0 0 auto;background:rgba(255,255,255,.08);color:#d6d6dd;font-weight:600;padding:10px}',
    '.btn.ghost.wide{flex:1}',
    '.btn.ghost:hover{background:rgba(255,255,255,.15)}',
    '.btn.small{padding:7px 10px;font-size:12px}',
    'input[type=text],input[type=number],select{background:#232327;color:#f1f1f4;border:1px solid #34343a;border-radius:8px;padding:7px 8px;font-size:12px;font-family:inherit;width:100%;min-width:0}',
    'input[type=text]:focus,input[type=number]:focus,select:focus{outline:1px solid #ff4d4d}',
    '.field{display:flex;align-items:center;gap:8px;margin-bottom:8px}',
    '.field .lb{color:#b9b9c2;font-size:12px;flex:0 0 auto;min-width:52px}',
    '.field .in{flex:1;min-width:0}',
    '.hint{color:#7d7d88;font-size:11px;margin-top:8px;line-height:1.45}',
    '.hint kbd{background:rgba(255,255,255,.12);border:1px solid rgba(255,255,255,.18);border-bottom-width:2px;border-radius:5px;padding:0 4px;font-size:11px;font-family:inherit}',
    '.bar{height:7px;background:rgba(255,255,255,.1);border-radius:99px;overflow:hidden;margin:10px 0 8px}',
    '.bar i{display:block;height:100%;width:0;background:linear-gradient(90deg,#ff3b3b,#ff8a3b);border-radius:99px;transition:width .2s}',
    '.prog{font-variant-numeric:tabular-nums;font-size:12px;color:#c9c9d1;display:flex;justify-content:space-between;gap:8px}',
    '.spin{width:15px;height:15px;border-radius:50%;border:2px solid rgba(255,255,255,.2);border-top-color:#ff4d4d;animation:rtspin .8s linear infinite;display:inline-block;vertical-align:-3px;margin-right:8px}',
    '@keyframes rtspin{to{transform:rotate(360deg)}}',
    '.ok{color:#5ee27a}.err{color:#ff7b7b;word-break:break-word}',
    '.list{display:flex;flex-direction:column;gap:6px}',
    '.item{display:flex;align-items:center;gap:8px;padding:7px 9px;border-radius:8px;background:rgba(255,255,255,.05);font-size:12px}',
    '.item .nm{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.item .go{flex:0 0 auto;background:rgba(255,255,255,.1);border:0;color:#e6e6ec;border-radius:6px;padding:4px 8px;font-size:11px;cursor:pointer}',
    '.item .go:hover{background:rgba(255,255,255,.2)}',
    '.kv{display:grid;grid-template-columns:auto 1fr;gap:4px 10px;font-size:12px}',
    '.kv dt{color:#8f8f99}.kv dd{color:#e3e3ea;word-break:break-word}',
    '.sw{display:flex;align-items:center;justify-content:space-between;gap:10px;font-size:12px;color:#c9c9d1;padding:4px 0}',
    '.sw input{appearance:none;width:34px;height:19px;border-radius:99px;background:#34343a;position:relative;cursor:pointer;transition:background .15s;flex:0 0 auto;border:0}',
    '.sw input:checked{background:#ff3b3b}',
    '.sw input::after{content:"";position:absolute;top:2px;left:2px;width:15px;height:15px;border-radius:50%;background:#fff;transition:transform .15s}',
    '.sw input:checked::after{transform:translateX(15px)}',
    '.toast{position:fixed;left:50%;bottom:96px;transform:translateX(-50%);background:rgba(12,12,14,.94);color:#fff;padding:9px 15px;border-radius:10px;font-size:13px;font-weight:600;letter-spacing:.2px;pointer-events:none;opacity:0;transition:opacity .18s;z-index:2147483001;white-space:nowrap;font-variant-numeric:tabular-nums;border:1px solid rgba(255,255,255,.12);max-width:80vw;overflow:hidden;text-overflow:ellipsis}',
    '.toast.on{opacity:1}',
    '.toast.act{pointer-events:auto;cursor:pointer}',
    '.toast.act:hover{background:rgba(35,35,40,.98);border-color:rgba(255,107,107,.5)}',
    '.help{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);background:rgba(16,16,19,.97);border:1px solid rgba(255,255,255,.14);border-radius:14px;padding:16px 18px;color:#eee;width:340px;z-index:2147483002;box-shadow:0 20px 60px rgba(0,0,0,.6)}',
    '.help h4{font-size:13px;margin-bottom:10px;letter-spacing:.3px}',
    '.help table{width:100%;border-collapse:collapse;font-size:12px}',
    '.help td{padding:3px 0;color:#c3c3cc}',
    '.help td:first-child{width:104px;color:#fff}',
    '.help kbd{background:rgba(255,255,255,.12);border:1px solid rgba(255,255,255,.18);border-bottom-width:2px;border-radius:5px;padding:1px 5px;font-size:11px;font-family:inherit}',
    '@media (prefers-reduced-motion: reduce){.spin{animation:none}.pill{transition:none}.bar i{transition:none}.toast{transition:none}}',
    ':focus-visible{outline:2px solid #ff6b6b;outline-offset:2px}'
  ].join('\n');

  /* ------------------------------------------------------------------ UI */

  var ui = null;

  function createUI() {
    var host = document.createElement('div');
    host.id = 'rt-tools-host';
    host.style.cssText = 'all:initial;position:fixed;left:0;top:0;width:0;height:0;z-index:2147483000;';
    var root = host.attachShadow({ mode: 'open' });

    var st = document.createElement('style');
    st.textContent = CSS;
    root.appendChild(st);

    var wrap = document.createElement('div');
    wrap.className = 'wrap';
    wrap.innerHTML =
      '<div class="card" hidden role="dialog" aria-label="RuTube Tools">' +
        '<div class="hd"><span class="badge">MP4</span><span class="t">RuTube Tools</span>' +
          '<button class="x" title="' + escapeHtml(t('panel.close')) + '" aria-label="' + escapeHtml(t('panel.close')) + '">×</button></div>' +
        '<div class="tabs" role="tablist"></div>' +
        '<div class="bd"></div>' +
      '</div>' +
      '<button class="pill" aria-label="RuTube Tools"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12"/><path d="m6.5 10.5 5.5 5.5 5.5-5.5"/><path d="M4 20h16"/></svg><span>MP4</span></button>';
    root.appendChild(wrap);

    var toastEl = document.createElement('div');
    toastEl.className = 'toast';
    root.appendChild(toastEl);

    var help = document.createElement('div');
    help.className = 'help';
    help.hidden = true;
    root.appendChild(help);

    ui = {
      host: host, root: root, wrap: wrap,
      pill: wrap.querySelector('.pill'),
      pillLabel: wrap.querySelector('.pill span'),
      card: wrap.querySelector('.card'),
      tabs: wrap.querySelector('.tabs'),
      body: wrap.querySelector('.bd'),
      close: wrap.querySelector('.x'),
      toast: toastEl,
      help: help,
      toastTimer: 0,
      toastAction: null
    };

    ui.pill.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); togglePanel(); });
    ui.close.addEventListener('click', function (e) {
      e.preventDefault(); e.stopPropagation(); closePanel();
    });
    ['click', 'mousedown', 'pointerdown', 'dblclick', 'keydown'].forEach(function (ev) {
      ui.card.addEventListener(ev, function (e) { e.stopPropagation(); });
    });
    ui.toast.addEventListener('click', function () {
      var fn = ui.toastAction;
      ui.toastAction = null;
      ui.toast.classList.remove('act', 'on');
      if (fn) fn();
    });
    host.addEventListener('click', function (e) { e.stopPropagation(); });

    document.body.appendChild(host);
    buildTabs();
    return ui;
  }

  function tabList() {
    if (state.playlistId && !state.info) return ['playlist', 'more', 'info'];
    return ['download', 'frames', 'more', 'info'];
  }

  function buildTabs() {
    if (!ui) return;
    var tabs = tabList();
    if (tabs.indexOf(state.tab) === -1) state.tab = tabs[0];
    ui.tabs.innerHTML = tabs.map(function (id) {
      return '<button data-tab="' + id + '" role="tab" class="' + (state.tab === id ? 'on' : '') + '">' +
        escapeHtml(t('tab.' + id)) + '</button>';
    }).join('');
    Array.prototype.forEach.call(ui.tabs.querySelectorAll('button'), function (b) {
      b.addEventListener('click', function (e) {
        e.preventDefault(); e.stopPropagation();
        state.tab = b.getAttribute('data-tab');
        buildTabs();
        render();
      });
    });
  }

  function setTab(id) {
    state.tab = id;
    buildTabs();
    render();
  }

  function render() {
    if (!ui) return;
    if (window.RTPanel && typeof window.RTPanel.render === 'function') window.RTPanel.render();
  }

  function ensureUI() {
    var v = findVideo(document);
    var id = getVideoId();
    var plId = getPlaylistId();
    if (v && id) prefetchFps(id);
    if (!ui) {
      if (!id && !plId) return null;
      if (!v && !plId) return null;
      if (!settings.showButton) return null;
      createUI();
    }
    var visible = !!((v && id) || plId);
    ui.wrap.style.display = visible && settings.showButton ? '' : 'none';
    ui.pillLabel.textContent = (plId && !id) ? 'PL' : 'MP4';
    reattachHost();
    return ui;
  }

  function reattachHost() {
    if (!ui) return;
    var target = document.fullscreenElement || document.body;
    if (ui.host.parentNode !== target) {
      try { target.appendChild(ui.host); } catch (e) {}
    }
  }

  function toast(text, opts) {
    if (!ui) return;
    opts = opts || {};
    ui.toast.textContent = text;
    ui.toast.classList.add('on');
    ui.toastAction = opts.action || null;
    ui.toast.classList.toggle('act', !!opts.action);
    clearTimeout(ui.toastTimer);
    ui.toastTimer = setTimeout(function () {
      ui.toast.classList.remove('on', 'act');
      ui.toastAction = null;
    }, opts.duration || 1600);
  }

  function togglePanel() {
    if (!state.panelOpen) openPanel(); else closePanel();
  }

  function openPanel() {
    if (!ui) return;
    state.panelOpen = true;
    ui.card.hidden = false;
    buildTabs();
    render();
    if (!state.info && !state.playlist && !state.infoLoading && !state.playlistLoading && !state.job) {
      if (window.RTPanel) window.RTPanel.load();
    }
  }

  function closePanel() {
    state.panelOpen = false;
    if (ui) ui.card.hidden = true;
  }

  function getVideoId() { return L.extractVideoId(location.href); }
  function getPlaylistId() { return L.extractPlaylistId(location.href); }

  /* ------------------------------------------------------------ справка */

  function buildHelp() {
    if (!ui) return;
    var rows = [
      ['<kbd>,</kbd> <kbd>.</kbd>', t('help.frame')],
      ['<kbd>&lt;</kbd> <kbd>&gt;</kbd>', t('help.speed')],
      ['<kbd>' + escapeHtml(settings.shotKey) + '</kbd>', t('help.shot')],
      ['<kbd>p</kbd>', t('help.pip')]
    ];
    if (settings.youtubeKeys) {
      rows = rows.concat([
        ['<kbd>Space</kbd> <kbd>K</kbd>', t('help.pause')],
        ['<kbd>J</kbd> <kbd>L</kbd>', t('help.seek10')],
        ['<kbd>←</kbd> <kbd>→</kbd>', t('help.seek5')],
        ['<kbd>↑</kbd> <kbd>↓</kbd>', t('help.volume')],
        ['<kbd>M</kbd>', t('help.mute')],
        ['<kbd>0</kbd>–<kbd>9</kbd>', t('help.percent')]
      ]);
    }
    rows.push(['<kbd>?</kbd>', t('help.help')]);
    ui.help.innerHTML =
      '<h4>' + escapeHtml(t('help.title')) + '</h4>' +
      '<table>' + rows.map(function (r) {
        return '<tr><td>' + r[0] + '</td><td>' + escapeHtml(r[1]) + '</td></tr>';
      }).join('') + '</table>' +
      '<p class="hint">' + escapeHtml(t('help.note')) + '</p>';
  }

  function toggleHelp() {
    if (!ui) return;
    if (ui.help.hidden) buildHelp();
    ui.help.hidden = !ui.help.hidden;
  }

  /* --------------------------------------------------------- покадрово */

  function seekTo(v, time) {
    return new Promise(function (resolve) {
      var done = false;
      function finish() {
        if (done) return;
        done = true;
        v.removeEventListener('seeked', finish);
        clearTimeout(timer);
        resolve();
      }
      var timer = setTimeout(finish, 900);
      v.addEventListener('seeked', finish);
      try { v.currentTime = time; } catch (e) { finish(); }
    });
  }

  function prefetchFps(id) {
    if (!id || state.fpsCache[id] || state.fpsRequested === id) return;
    state.fpsRequested = id;
    sendMessage({ type: 'rt:info', videoId: id }).then(function (r) {
      if (r && r.ok && r.info && r.info.fps) state.fpsCache[id] = r.info.fps;
      else state.fpsRequested = null;
    });
  }

  function resolveFps() {
    var pref = settings.fps;
    if (pref && pref !== 'auto') {
      var n = Number(pref);
      if (n > 0) return Promise.resolve(n);
    }
    var id = getVideoId();
    if (id && state.fpsCache[id]) return Promise.resolve(state.fpsCache[id]);
    if (id) {
      return Promise.race([
        sendMessage({ type: 'rt:info', videoId: id }).then(function (r) {
          if (r && r.ok && r.info && r.info.fps) {
            state.fpsCache[id] = r.info.fps;
            return r.info.fps;
          }
          return 25;
        }),
        new Promise(function (res) { setTimeout(function () { res(25); }, 700); })
      ]);
    }
    return Promise.resolve(25);
  }

  var stepChain = Promise.resolve();

  function stepFrame(dir, v) {
    stepChain = stepChain.then(function () { return doStep(dir, v); }).catch(function () {});
    return stepChain;
  }

  function doStep(dir, v) {
    v = v || getPlayerVideo();
    if (!v) return Promise.resolve();
    if (!v.paused) { try { v.pause(); } catch (e) {} }
    return resolveFps().then(function (fps) {
      if (!fps || !isFinite(fps) || fps <= 0) fps = 25;
      var cur = v.currentTime || 0;
      var frame = Math.round(cur * fps);
      frame = dir > 0 ? frame + 1 : Math.max(0, frame - 1);
      var dur = isFinite(v.duration) ? v.duration : 0;
      var target = (frame + 0.25) / fps;
      if (dur && target > dur - 0.02) target = Math.max(0, dur - 0.04);
      return seekTo(v, target).then(function () {
        toast(t('fr.readout', { n: frame, tc: timecode(v.currentTime), fps: fps }));
      });
    });
  }

  function gotoFrame(n) {
    var v = getPlayerVideo();
    if (!v) { toast(t('fr.noVideo')); return; }
    resolveFps().then(function (fps) {
      if (!fps || !isFinite(fps)) fps = 25;
      var target = Math.max(0, (Number(n) || 1) - 1) / fps;
      var dur = isFinite(v.duration) ? v.duration : 0;
      if (dur && target > dur - 0.05) target = Math.max(0, dur - 0.05);
      v.pause();
      seekTo(v, target).then(function () {
        toast(t('fr.frameN', { n: Math.round(target * fps) + 1, tc: timecode(v.currentTime) }));
      });
    });
  }

  function changeSpeed(v, dir) {
    v = v || getPlayerVideo();
    if (!v) return;
    var speeds = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
    var cur = v.playbackRate || 1;
    var idx = 0, bestDiff = Infinity;
    speeds.forEach(function (s, i) { if (Math.abs(s - cur) < bestDiff) { bestDiff = Math.abs(s - cur); idx = i; } });
    idx = Math.min(speeds.length - 1, Math.max(0, idx + (dir > 0 ? 1 : -1)));
    v.playbackRate = speeds[idx];
    applyPitch(v);
    toast(t('toast.speed', { rate: speeds[idx] }));
  }

  function applyPitch(v) {
    if (!v) return;
    try {
      v.preservesPitch = !!settings.preservePitch;
      v.mozPreservesPitch = !!settings.preservePitch;
      v.webkitPreservesPitch = !!settings.preservePitch;
    } catch (e) {}
  }

  function seekBy(v, d) {
    var dur = isFinite(v.duration) ? v.duration : 0;
    var time = Math.max(0, Math.min((v.currentTime || 0) + d, dur ? dur - 0.05 : 1e9));
    v.currentTime = time;
    toast(t('toast.seek', { sign: d > 0 ? '+' : '−', n: Math.abs(d), tc: timecode(time) }));
  }

  function changeVolume(v, d) {
    v.volume = Math.max(0, Math.min(1, (v.volume || 0) + d));
    if (v.volume > 0) v.muted = false;
    toast(t('toast.volume', { n: Math.round(v.volume * 100) }));
  }

  /* --------------------------------------------------------- кадр в PNG */

  function frameFilename(time) {
    var base = (state.info && state.info.title) || document.title || 'rutube';
    return L.sanitizeFilename(base) + ' — ' + L.formatTime(time).replace(/:/g, '-') + '.png';
  }

  function grabFrameDataUrl(v) {
    var c = document.createElement('canvas');
    c.width = v.videoWidth;
    c.height = v.videoHeight;
    c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
    return c.toDataURL('image/png');
  }

  function saveFrame(v) {
    v = v || getPlayerVideo();
    if (!v || !v.videoWidth) { toast(t('fr.notReady')); return Promise.resolve(null); }
    var dataUrl;
    try {
      dataUrl = grabFrameDataUrl(v);
    } catch (e) {
      toast(t('fr.saveBlocked'));
      return Promise.resolve(null);
    }
    return sendMessage({ type: 'rt:save-data-url', dataUrl: dataUrl, filename: frameFilename(v.currentTime) })
      .then(function (r) {
        if (r && r.ok) { toast(t('fr.saved', { name: r.name })); return r; }
        var msg = (r && r.error) || '';
        toast(/security|cross-origin|tainted/i.test(msg) ? t('fr.saveBlocked')
          : t('fr.saveFail') + (msg ? ': ' + msg.slice(0, 60) : ''));
        return null;
      });
  }

  /** Серия кадров через равные интервалы: каждый кадр — отдельный PNG. */
  function makeStoryboard() {
    var v = getPlayerVideo();
    if (!v || !v.videoWidth) { toast(t('fr.notReady')); return; }
    if (state.boardBusy) return;
    var every = Math.max(0.2, Number(state.storyboard.every) || 5);
    var count = Math.max(1, Math.min(120, Number(state.storyboard.count) || 12));
    var dur = isFinite(v.duration) ? v.duration : 0;
    if (!dur) { toast(t('fr.notReady')); return; }

    state.boardBusy = true;
    var wasPaused = v.paused;
    var originalTime = v.currentTime;
    v.pause();
    var made = 0;

    function step(i) {
      if (i >= count) {
        v.currentTime = originalTime;
        if (!wasPaused) v.play().catch(function () {});
        state.boardBusy = false;
        toast(t('fr.boardDone', { n: made }));
        if (window.RTPanel) window.RTPanel.render();
        return;
      }
      var time = Math.min(dur - 0.1, i * every);
      if (time < 0) time = 0;
      shotAt(time).then(function () {
        made++;
        toast(t('fr.boardProgress', { i: i + 1, n: count }), { duration: 900 });
        setTimeout(function () { step(i + 1); }, 60);
      });
    }

    function shotAt(time) {
      return seekTo(v, time).then(function () {
        var dataUrl;
        try { dataUrl = grabFrameDataUrl(v); } catch (e) { return null; }
        return sendMessage({ type: 'rt:save-data-url', dataUrl: dataUrl, filename: frameFilename(v.currentTime) });
      });
    }

    step(0);
  }

  /* ------------------------------------------------------------- A/B петля */

  function applyAB(v) {
    if (!v) return;
    var ab = state.ab;
    if (!ab.loop || ab.a === null || ab.b === null) {
      v.removeEventListener('timeupdate', abHandler);
      return;
    }
    v.removeEventListener('timeupdate', abHandler);
    v.addEventListener('timeupdate', abHandler);
  }

  function abHandler() {
    var v = getPlayerVideo();
    var ab = state.ab;
    if (!v || ab.a === null || ab.b === null || !ab.loop) return;
    if (v.currentTime >= ab.b || v.currentTime < ab.a - 0.5) {
      try { v.currentTime = ab.a; } catch (e) {}
    }
  }

  /* ----------------------------------------------------- позиция просмотра */

  var posTimer = 0;
  function posKey(videoId) { return 'pos:' + videoId; }

  function savePosition(v) {
    var id = getVideoId();
    if (!id || !settings.rememberPos || !v || !isFinite(v.duration)) return;
    try {
      var payload = {};
      payload[posKey(id)] = Math.round(v.currentTime || 0);
      api.storage.local.set(payload);
    } catch (e) {}
  }

  function maybeOfferResume(v) {
    var id = getVideoId();
    if (!id || !settings.rememberPos || !v || !isFinite(v.duration)) return;
    var key = posKey(id);
    var p = api.storage.local.get(key);
    if (!p || !p.then) return;
    p.then(function (obj) {
      var pos = obj && obj[key];
      if (!pos || pos < 30 || pos > v.duration - 30) return;
      if (Math.abs((v.currentTime || 0) - pos) < 15) return;
      toast(t('toast.continue', { tc: L.formatTime(pos) }), {
        duration: 6000,
        action: function () {
          v.currentTime = pos;
          v.play().catch(function () {});
        }
      });
    });
  }

  /* --------------------------------------------------------------- PiP */

  function togglePip() {
    var v = getPlayerVideo();
    if (!v) { toast(t('fr.noVideo')); return; }
    try {
      if (document.pictureInPictureElement) {
        document.exitPictureInPicture();
      } else if (v.requestPictureInPicture) {
        v.requestPictureInPicture().then(function () { toast(t('toast.pip')); }, function () {
          toast(t('more.none'));
        });
      } else {
        toast(t('more.none'));
      }
    } catch (e) { toast(t('more.none')); }
  }

  /* ---------------------------------------------------------- клавиатура */

  function stopEvent(e) {
    e.preventDefault();
    e.stopPropagation();
    if (e.stopImmediatePropagation) e.stopImmediatePropagation();
  }

  var FRAME_KEYS = {
    comma: { back: ',', fwd: '.' },
    brackets: { back: '[', fwd: ']' },
    angle: { back: '<', fwd: '>' }
  };

  function keySet() {
    return FRAME_KEYS[settings.frameKeys] || FRAME_KEYS.comma;
  }

  function onKeyDown(e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (isEditable(e.target)) return;

    var key = e.key;
    var ks = keySet();
    var isBack = key === ks.back || (settings.frameKeys === 'angle' && key === '<' && e.shiftKey);
    var isFwd = key === ks.fwd || (settings.frameKeys === 'angle' && key === '>' && e.shiftKey);
    var isSpeed = key === '<' || key === '>';
    var isHelp = key === '?' || (key === '/' && e.shiftKey);
    var isShot = key === settings.shotKey || (settings.shotKey === 's' && (key === 'ы' || key === 'Ы'));
    var isPip = key === 'p' || key === 'P' || key === 'з' || key === 'З';

    if (key === 'Escape') {
      if (ui && !ui.help.hidden) { ui.help.hidden = true; e.preventDefault(); }
      return;
    }

    var special = isBack || isFwd || isHelp || isShot || isPip;
    if (!special && !isSpeed && !settings.youtubeKeys) return;

    var v = getPlayerVideo();
    if (special || isSpeed) {
      if (!v) return;
    }

    if (isBack) { stopEvent(e); stepFrame(-1, v); return; }
    if (isFwd) { stopEvent(e); stepFrame(1, v); return; }
    if (isSpeed) { if (e.shiftKey && (key === '<' || key === '>')) { stopEvent(e); stepFrame(key === '>' ? 1 : -1, v); return; } stopEvent(e); changeSpeed(v, key === '>' ? 1 : -1); return; }
    if (isShot) { stopEvent(e); saveFrame(v); return; }
    if (isPip) { stopEvent(e); togglePip(); return; }
    if (isHelp) { stopEvent(e); toggleHelp(); return; }

    switch (key) {
      case ' ':
      case 'k': case 'K':
        if (e.target && e.target.tagName === 'BUTTON' && key === ' ') return;
        stopEvent(e);
        if (v.paused) v.play().catch(function () {}); else v.pause();
        break;
      case 'j': case 'J': stopEvent(e); seekBy(v, -10); break;
      case 'l': case 'L': stopEvent(e); seekBy(v, 10); break;
      case 'ArrowLeft': stopEvent(e); seekBy(v, -5); break;
      case 'ArrowRight': stopEvent(e); seekBy(v, 5); break;
      case 'ArrowUp': stopEvent(e); changeVolume(v, 0.05); break;
      case 'ArrowDown': stopEvent(e); changeVolume(v, -0.05); break;
      case 'm': case 'M': case 'ь': case 'Ь':
        stopEvent(e);
        v.muted = !v.muted;
        toast(v.muted ? t('toast.muted') : t('toast.unmuted'));
        break;
      case 'Home': stopEvent(e); v.currentTime = 0; toast(t('toast.start')); break;
      case 'End':
        stopEvent(e);
        v.currentTime = Math.max(0, (isFinite(v.duration) ? v.duration : 0) - 0.1);
        toast(t('toast.end'));
        break;
      default:
        if (/^[0-9]$/.test(key) && isFinite(v.duration) && v.duration) {
          stopEvent(e);
          v.currentTime = v.duration * (Number(key) / 10);
          toast(key === '0' ? t('toast.start') : t('toast.percent', { n: key + '0' }));
        }
    }
  }

  /* ------------------------------------------------------------ события */

  var lastHref = location.href;
  function checkNav() {
    if (location.href === lastHref) return false;
    lastHref = location.href;
    if (state.job) {
      sendMessage({ type: 'rt:cancel', jobId: state.job.id });
      stopKeepalive();
    }
    state.info = null;
    state.infoFor = null;
    state.fpsRequested = null;
    state.choice = null;
    state.job = null;
    state.progress = null;
    state.playlist = null;
    state.playlistLoading = false;
    state.mode = 'full';
    state.from = '';
    state.to = '';
    state.lastRequest = null;
    state.lastResult = null;
    state.videoId = getVideoId();
    state.playlistId = getPlaylistId();
    if (state.playlistId && !state.videoId) state.tab = 'playlist';
    else state.tab = 'download';
    closePanel();
    return true;
  }

  function watch() {
    if (checkNav() && ui) buildTabs();
    ensureUI();
    var v = findVideo(document);
    if (ui && !v && !getPlaylistId()) ui.wrap.style.display = 'none';
  }

  var mo = null;
  function startObserver() {
    try {
      mo = new MutationObserver(function () { ensureUI(); });
      mo.observe(document.documentElement, { childList: true, subtree: true });
    } catch (e) {}
  }

  function onProgressMessage(msg) {
    if (!msg || msg.type !== 'rt:progress') return;
    if (window.RTPanel && window.RTPanel.onProgress) window.RTPanel.onProgress(msg);
  }

  function init() {
    state.videoId = getVideoId();
    state.playlistId = getPlaylistId();
    if (state.playlistId && !state.videoId) state.tab = 'playlist';
    loadSettings();
    ensureUI();
    startObserver();
    setInterval(watch, 1500);

    window.addEventListener('keydown', onKeyDown, true);

    document.addEventListener('fullscreenchange', function () { reattachHost(); });
    document.addEventListener('click', function (e) {
      if (ui && ui.host.contains(e.target)) return;
      setTimeout(function () {
        ensureUI();
        var v = findVideo(document);
        if (v) { applyPitch(v); maybeOfferResume(v); }
      }, 400);
    }, true);

    // позиция просмотра
    setInterval(function () {
      var v = findVideo(document);
      if (v && !v.paused) savePosition(v);
    }, 5000);
    window.addEventListener('beforeunload', function () {
      var v = findVideo(document);
      if (v) savePosition(v);
    });

    try {
      api.runtime.onMessage.addListener(function (msg) {
        if (msg && msg.type === 'rt:progress') onProgressMessage(msg);
      });
    } catch (e) {}

    console.log('[RuTube Tools] content готов', location.href);
  }

  /* ------------------------------------------------------ общий неймспейс */

  window.__RT = {
    api: api, L: L, I: I, t: t,
    state: state,
    get settings() { return settings; },
    ui: function () { return ui; },
    ensureUI: ensureUI,
    openPanel: openPanel,
    closePanel: closePanel,
    setTab: setTab,
    buildTabs: buildTabs,
    render: render,
    toast: toast,
    escapeHtml: escapeHtml,
    timecode: timecode,
    sendMessage: sendMessage,
    copyText: copyText,
    getVideoId: getVideoId,
    getPlaylistId: getPlaylistId,
    getPlayerVideo: getPlayerVideo,
    stepFrame: stepFrame,
    gotoFrame: gotoFrame,
    seekTo: seekTo,
    resolveFps: resolveFps,
    saveFrame: saveFrame,
    makeStoryboard: makeStoryboard,
    changeSpeed: changeSpeed,
    seekBy: seekBy,
    togglePip: togglePip,
    applyAB: applyAB,
    applyPitch: applyPitch,
    savePosition: savePosition
  };

  /* keepalive: не даём фону уснуть во время загрузки */
  var keepaliveTimer = 0;
  function startKeepalive() {
    stopKeepalive();
    keepaliveTimer = setInterval(function () {
      if (!state.job) { stopKeepalive(); return; }
      sendMessage({ type: 'rt:keepalive' });
    }, 15000);
  }
  function stopKeepalive() {
    if (keepaliveTimer) { clearInterval(keepaliveTimer); keepaliveTimer = 0; }
  }
  window.__RT.startKeepalive = startKeepalive;
  window.__RT.stopKeepalive = stopKeepalive;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
