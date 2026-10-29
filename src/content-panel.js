/* RuTube Tools — панель: вкладки «Скачать / Кадры / Ещё / Инфо» и плейлист. */
'use strict';
(function () {
  var RT = window.__RT;
  if (!RT) return;

  var L = RT.L, t = RT.t;
  var state = RT.state;

  state.result = null;

  function $(sel) { return RT.ui().body.querySelector(sel); }
  function $$(sel) { return Array.prototype.slice.call(RT.ui().body.querySelectorAll(sel)); }
  function body() { return RT.ui().body; }
  function esc(s) { return RT.escapeHtml(s); }

  function setHTML(html) {
    body().innerHTML = html;
  }

  function variants() {
    return (state.info && state.info.variants) || [];
  }

  function selectedHeight() {
    var list = variants();
    if (!list.length) return null;
    var sel = state.choice || RT.settings.quality || 'best';
    if (sel === 'best') return list[0].height;
    if (sel === 'worst') return list[list.length - 1].height;
    var target = parseInt(sel, 10);
    var best = list[0];
    list.forEach(function (v) {
      if (Math.abs(v.height - target) < Math.abs(best.height - target)) best = v;
    });
    return best.height;
  }

  function currentVariant() {
    var list = variants();
    var h = selectedHeight();
    if (!list.length) return null;
    if (h == null) return list[0];
    var best = list[0];
    list.forEach(function (v) {
      if (Math.abs(v.height - h) < Math.abs(best.height - h)) best = v;
    });
    return best;
  }

  /* --------------------------------------------------------------- загрузка */

  function load() {
    if (state.playlistId && !state.videoId) { loadPlaylist(); return; }
    loadInfo();
  }

  function loadInfo(withMeta) {
    var id = RT.getVideoId();
    if (!id) return;
    if (state.info && state.infoFor === id && !withMeta) { render(); return; }
    if (withMeta && state.metaAttempted && state.infoFor === id) { render(); return; }
    state.infoLoading = true;
    if (withMeta) { state.metaLoading = true; state.metaAttempted = true; }
    render();
    RT.sendMessage({ type: 'rt:info', videoId: id, withMeta: !!withMeta }).then(function (r) {
      state.infoLoading = false;
      state.metaLoading = false;
      if (!r || !r.ok) {
        state.infoError = (r && r.error) || t('err.info');
        render();
        return;
      }
      state.info = r.info;
      state.infoFor = id;
      state.infoError = null;
      if (r.info.fps) state.fpsCache[id] = r.info.fps;
      state.metaLoaded = !!(r.info.meta);
      render();
    });
  }

  function loadPlaylist() {
    var plId = RT.getPlaylistId();
    if (!plId) return;
    if (state.playlist && state.playlist.id === plId) { render(); return; }
    state.playlistLoading = true;
    render();
    RT.sendMessage({ type: 'rt:playlist-info', playlistId: plId }).then(function (r) {
      state.playlistLoading = false;
      if (!r || !r.ok) {
        state.playlistError = (r && r.error) || t('err.playlist');
        render();
        return;
      }
      state.playlist = r.playlist;
      state.playlistError = null;
      render();
    });
  }

  /* ------------------------------------------------------------------ render */

  function render() {
    var ui = RT.ui();
    if (!ui) return;
    if (!state.panelOpen) return;

    if (state.job) { renderRunning(); return; }
    // экран результата не должен перекрывать другие вкладки
    if (state.result && (state.tab === 'download' || state.tab === 'playlist')) { renderResult(); return; }

    if (state.tab === 'playlist') { renderPlaylistTab(); return; }
    if (state.tab === 'download') { renderDownloadTab(); return; }
    if (state.tab === 'frames') { renderFramesTab(); return; }
    if (state.tab === 'more') { renderMoreTab(); return; }
    if (state.tab === 'info') { renderInfoTab(); return; }
  }

  function spinner(text) {
    return '<div class="muted"><span class="spin"></span>' + esc(text) + '</div>';
  }

  /* ---------------------------------------------------------- вкладка «Скачать» */

  function renderDownloadTab() {
    if (!state.info) {
      if (state.infoLoading) return setHTML(spinner(t('panel.loading')));
      if (state.infoError) return renderErrorBox(state.infoError);
      loadInfo();
      return setHTML(spinner(t('panel.loading')));
    }
    var info = state.info;
    if (info.isLive) return renderBlocked(t('err.live'));
    if (info.drmProtected) return renderBlocked(t('err.drm'));

    var list = variants();
    var sel = selectedHeight();
    var rows = list.map(function (v) {
      var checked = sel != null && Math.abs(v.height - sel) < 1;
      return '<label class="' + (v.compatible ? '' : 'dis') + '">' +
        '<input type="radio" name="rq" value="' + v.height + '"' + (checked ? ' checked' : '') + '>' +
        '<span class="radio"></span>' +
        '<span class="lbl">' + esc(v.label) + '</span>' +
        '<span class="est">' + (v.estimatedBytes ? L.formatBytes(v.estimatedBytes) : '') + '</span>' +
        '</label>';
    }).join('');

    var big = list.some(function (v) { return v.estimatedBytes > 900 * 1024 * 1024; });
    var isPart = state.mode === 'part';
    var variant = currentVariant();

    setHTML(
      '<div class="title">' + esc(info.title) + '</div>' +
      '<div class="q">' + rows + '</div>' +
      '<div class="seg">' +
        '<button data-mode="full" class="' + (!isPart ? 'on' : '') + '">' + esc(t('dl.modeFull')) + '</button>' +
        '<button data-mode="part" class="' + (isPart ? 'on' : '') + '">' + esc(t('dl.modePart')) + '</button>' +
      '</div>' +
      (isPart
        ? '<div class="field"><span class="lb">' + esc(t('dl.from')) + '</span>' +
            '<span class="in"><input type="text" data-in="from" placeholder="0:00" value="' + esc(state.from) + '"></span>' +
            '<button class="btn ghost small" data-take="from" title="' + esc(t('dl.fromPlayer')) + '">⏱</button></div>' +
          '<div class="field"><span class="lb">' + esc(t('dl.to')) + '</span>' +
            '<span class="in"><input type="text" data-in="to" placeholder="' + esc(L.formatTime(info.durationSec)) + '" value="' + esc(state.to) + '"></span>' +
            '<button class="btn ghost small" data-take="to" title="' + esc(t('dl.fromPlayer')) + '">⏱</button></div>'
        : '') +
      '<div class="row" style="margin-top:10px">' +
        '<button class="btn" data-act="go">' + esc(isPart ? t('dl.startPart') : t('dl.start')) + '</button>' +
        '<button class="btn ghost" data-act="link" title="' + esc(t('dl.copyLink')) + '">' +
          '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/></svg>' +
        '</button>' +
      '</div>' +
      '<div class="hint">' +
        (info.durationSec ? esc(t('dl.duration')) + ' ' + L.formatTime(info.durationSec) + ' · ' : '') +
        esc(t('dl.mergeHint')) +
        (big ? '. ' + esc(t('dl.partsHint', { n: RT.settings.maxPartMB })) : '') +
      '</div>' +
      '<div class="hint">' + esc(t('dl.frameHint', { key: RT.settings.shotKey })) + '</div>'
    );

    $$('input[name="rq"]').forEach(function (inp) {
      inp.addEventListener('change', function () {
        state.choice = inp.value;
        try { RT.api.storage.local.set({ quality: inp.value }); } catch (e) {}
        var v = currentVariant();
        if (v) state.lastRequest = null;
        render();
      });
    });

    $$('.seg button').forEach(function (b) {
      b.addEventListener('click', function (e) {
        e.preventDefault();
        state.mode = b.getAttribute('data-mode');
        render();
      });
    });

    $$('[data-in]').forEach(function (inp) {
      inp.addEventListener('input', function () {
        if (inp.getAttribute('data-in') === 'from') state.from = inp.value;
        else state.to = inp.value;
      });
    });

    $$('[data-take]').forEach(function (b) {
      b.addEventListener('click', function (e) {
        e.preventDefault();
        var v = RT.getPlayerVideo();
        if (!v) return;
        var which = b.getAttribute('data-take');
        var val = L.formatTime(v.currentTime);
        if (which === 'from') state.from = val; else state.to = val;
        render();
      });
    });

    var go = $('[data-act="go"]');
    if (go) go.addEventListener('click', function () { startVideo(); });

    var link = $('[data-act="link"]');
    if (link) link.addEventListener('click', function () {
      var v = currentVariant();
      if (v) RT.copyText(v.url, t('toast.copied'));
    });
  }

  function renderBlocked(text) {
    setHTML('<div class="err" style="margin-bottom:10px">' + esc(text) + '</div>');
  }

  function renderErrorBox(text) {
    setHTML(
      '<div class="err" style="margin-bottom:10px">' + esc(text) + '</div>' +
      '<div class="row"><button class="btn ghost wide" data-act="retry-info">' + esc(t('panel.retry')) + '</button></div>'
    );
    var b = $('[data-act="retry-info"]');
    if (b) b.addEventListener('click', function () {
      state.infoError = null;
      state.info = null;
      state.infoFor = null;
      loadInfo();
    });
  }

  /* --------------------------------------------------------- вкладка «Плейлист» */

  function renderPlaylistTab() {
    if (state.playlistLoading) return setHTML(spinner(t('pl.loading')));
    if (state.playlistError) return renderErrorBox(state.playlistError);
    if (!state.playlist) { loadPlaylist(); return setHTML(spinner(t('pl.loading'))); }

    var pl = state.playlist;
    // грубая оценка объёма: типичный битрейт RuTube для выбранного качества
    var BITRATE = { '144': 140000, '240': 220000, '360': 380000, '480': 500000, '720': 720000, '1080': 1500000 };
    var chosenQ = state.plChoice || RT.settings.quality;
    var kbps = BITRATE[chosenQ] || BITRATE['720'];
    var fromIdx = state.pFrom ? Math.max(1, Number(state.pFrom)) : 1;
    var toIdx = state.pTo ? Math.min(Number(state.pTo), pl.videosCount) : Math.min(pl.videosCount, fromIdx + (pl.videos.length || 50) - 1);
    var estimate = 0;
    if (toIdx >= fromIdx) {
      var known = pl.videos.slice(fromIdx - 1, toIdx);
      var secs = known.reduce(function (sum, v) { return sum + (v.durationSec || 0); }, 0);
      var avg = known.length ? secs / known.length : 900;
      estimate = (avg * (toIdx - fromIdx + 1)) * kbps / 8;
    }
    var qualityOptions = ['best', '1080', '720', '480', '360', 'worst'].map(function (q) {
      var label = q === 'best' ? t('opt.best') : (q === 'worst' ? t('opt.worst') : q + 'p');
      return '<option value="' + q + '"' + ((state.plChoice || RT.settings.quality) === q ? ' selected' : '') + '>' + label + '</option>';
    }).join('');

    setHTML(
      '<div class="title">' + esc(pl.title) + '</div>' +
      '<div class="muted" style="margin-bottom:10px">' + esc(t('pl.count', { n: pl.videosCount })) + '</div>' +
      '<div class="field"><span class="lb">' + esc(t('info.qualities')) + '</span>' +
        '<span class="in"><select data-sel="q">' + qualityOptions + '</select></span></div>' +
      '<div class="field"><span class="lb">' + esc(t('pl.range')) + '</span>' +
        '<span class="in"><input type="number" min="1" max="' + pl.videosCount + '" data-in="pfrom" placeholder="1" value="' + esc(state.pFrom || '') + '"></span>' +
        '<span class="in"><input type="number" min="1" max="' + pl.videosCount + '" data-in="pto" placeholder="' + pl.videosCount + '" value="' + esc(state.pTo || '') + '"></span></div>' +
      '<div class="row" style="margin-top:10px">' +
        '<button class="btn" data-act="go-pl">' + esc(t('pl.start')) + '</button>' +
      '</div>' +
      '<div class="hint">' + esc(t('pl.delay', { s: 1 })) +
        (estimate ? ' · ' + esc(t('info.size')) + ': ~' + esc(L.formatBytes(estimate)) : '') + '</div>'
    );

    var sel = $('[data-sel="q"]');
    if (sel) sel.addEventListener('change', function () { state.plChoice = sel.value; });

    $$('[data-in]').forEach(function (inp) {
      inp.addEventListener('input', function () {
        if (inp.getAttribute('data-in') === 'pfrom') state.pFrom = inp.value;
        else state.pTo = inp.value;
      });
    });

    var go = $('[data-act="go-pl"]');
    if (go) go.addEventListener('click', startPlaylist);
  }

  /* ------------------------------------------------------------ вкладка «Кадры» */

  function renderFramesTab() {
    var ab = state.ab;
    var v = RT.getPlayerVideo();
    var cur = v ? v.currentTime : 0;
    var fps = (RT.getVideoId() && state.fpsCache[RT.getVideoId()]) || 25;

    setHTML(
      '<div class="sect">' +
        '<button class="btn" data-act="shot" style="width:100%">' + esc(t('fr.save')) +
          ' <kbd style="opacity:.8">' + esc(RT.settings.shotKey) + '</kbd></button>' +
      '</div>' +
      '<div class="sect"><h5>' + esc(t('fr.goto')) + '</h5>' +
        '<div class="row">' +
          '<input type="number" min="1" data-in="frame" placeholder="' + Math.round(cur * fps) + '" style="flex:1">' +
          '<button class="btn ghost" data-act="goto">' + esc(t('fr.go')) + '</button>' +
        '</div>' +
        '<div class="hint">' + fps + ' fps · ' + esc(RT.timecode(cur)) + '</div>' +
      '</div>' +
      '<div class="sect"><h5>' + esc(t('fr.ab')) + '</h5>' +
        '<div class="row">' +
          '<button class="btn ghost wide small" data-act="setA">A: ' + (ab.a == null ? '—' : esc(RT.timecode(ab.a))) + '</button>' +
          '<button class="btn ghost wide small" data-act="setB">B: ' + (ab.b == null ? '—' : esc(RT.timecode(ab.b))) + '</button>' +
        '</div>' +
        '<div class="sw" style="margin-top:8px"><span>' + esc(ab.loop ? t('fr.loopOn') : t('fr.loopOff')) + '</span>' +
          '<input type="checkbox" data-act="loop"' + (ab.loop ? ' checked' : '') + '></div>' +
        '<div class="row" style="margin-top:6px"><button class="btn ghost wide small" data-act="abclear">' + esc(t('fr.clear')) + '</button></div>' +
      '</div>' +
      '<div class="sect"><h5>' + esc(t('fr.storyboard')) + '</h5>' +
        '<div class="field"><span class="lb">' + esc(t('fr.every')) + '</span>' +
          '<span class="in"><input type="number" min="0.2" step="0.5" data-in="every" value="' + state.storyboard.every + '"></span></div>' +
        '<div class="field"><span class="lb">' + esc(t('fr.frames')) + '</span>' +
          '<span class="in"><input type="number" min="1" max="120" data-in="count" value="' + state.storyboard.count + '"></span></div>' +
        '<div class="row"><button class="btn ghost wide small" data-act="board">' + esc(t('fr.make')) + '</button></div>' +
      '</div>' +
      '<div class="sw"><span>' + esc(t('fr.pitch')) + '</span>' +
        '<input type="checkbox" data-act="pitch"' + (RT.settings.preservePitch ? ' checked' : '') + '></div>'
    );

    var shot = $('[data-act="shot"]');
    if (shot) shot.addEventListener('click', function () { RT.saveFrame(); });

    var goto = $('[data-act="goto"]');
    if (goto) goto.addEventListener('click', function () {
      var inp = $('[data-in="frame"]');
      if (inp && inp.value) RT.gotoFrame(inp.value);
    });

    var setA = $('[data-act="setA"]');
    if (setA) setA.addEventListener('click', function () {
      var vv = RT.getPlayerVideo();
      state.ab.a = vv ? vv.currentTime : null;
      if (state.ab.b != null && state.ab.a >= state.ab.b) state.ab.b = null;
      RT.applyAB(vv);
      render();
    });

    var setB = $('[data-act="setB"]');
    if (setB) setB.addEventListener('click', function () {
      var vv = RT.getPlayerVideo();
      state.ab.b = vv ? vv.currentTime : null;
      if (state.ab.a != null && state.ab.b <= state.ab.a) state.ab.a = null;
      RT.applyAB(vv);
      render();
    });

    var loop = $('[data-act="loop"]');
    if (loop) loop.addEventListener('change', function () {
      state.ab.loop = loop.checked;
      if (loop.checked && (state.ab.a == null || state.ab.b == null)) {
        var vv = RT.getPlayerVideo();
        if (vv) {
          if (state.ab.a == null) state.ab.a = Math.max(0, vv.currentTime - 2);
          if (state.ab.b == null) state.ab.b = Math.min(vv.duration || vv.currentTime + 2, vv.currentTime + 2);
        }
      }
      RT.applyAB(RT.getPlayerVideo());
      render();
    });

    var clear = $('[data-act="abclear"]');
    if (clear) clear.addEventListener('click', function () {
      state.ab = { a: null, b: null, loop: false };
      RT.applyAB(RT.getPlayerVideo());
      render();
    });

    $$('[data-in]').forEach(function (inp) {
      var key = inp.getAttribute('data-in');
      if (key === 'every' || key === 'count') {
        inp.addEventListener('input', function () { state.storyboard[key] = inp.value; });
      }
    });

    var board = $('[data-act="board"]');
    if (board) board.addEventListener('click', function () { RT.makeStoryboard(); });

    var pitch = $('[data-act="pitch"]');
    if (pitch) pitch.addEventListener('change', function () {
      try { RT.api.storage.local.set({ preservePitch: pitch.checked }); } catch (e) {}
      RT.applyPitch(RT.getPlayerVideo());
    });
  }

  /* ------------------------------------------------------------- вкладка «Ещё» */

  function renderMoreTab() {
    if (!state.info) {
      if (state.infoLoading) return setHTML(spinner(t('panel.loading')));
      loadInfo();
      return setHTML(spinner(t('panel.loading')));
    }
    var info = state.info;
    var subs = (info.captions || []).map(function (c, i) {
      return '<div class="item"><span class="nm">' + esc(c.langTitle) +
        (c.isAuto ? ' · ' + esc(t('more.subAuto')) : '') + ' · ' + esc((c.format || 'srt').toUpperCase()) + '</span>' +
        '<button class="go" data-sub="' + i + '">' + esc(t('tab.download')) + '</button></div>';
    }).join('');

    var chapters = (info.cuepoints || []).map(function (c) {
      return '<div class="item"><span class="nm">' + esc(L.formatTime(c.time)) + ' · ' + esc(c.title || '—') + '</span>' +
        '<button class="go" data-ch="' + c.time + '">▶</button></div>';
    }).join('');

    setHTML(
      '<div class="sect"><h5>' + esc(t('more.subtitles')) + '</h5>' +
        (subs ? '<div class="list">' + subs + '</div>' : '<div class="muted">' + esc(t('more.none')) + '</div>') +
      '</div>' +
      '<div class="sect"><h5>' + esc(t('more.thumb')) + '</h5>' +
        (info.thumbnail
          ? '<div class="row"><button class="btn ghost wide small" data-act="thumb">' + esc(t('tab.download')) + '</button></div>'
          : '<div class="muted">' + esc(t('more.none')) + '</div>') +
      '</div>' +
      '<div class="sect"><h5>' + esc(t('more.chapters')) + '</h5>' +
        (chapters
          ? '<div class="list">' + chapters + '</div>' +
            '<div class="row" style="margin-top:6px"><button class="btn ghost wide small" data-act="chcopy">' + esc(t('more.copyChapters')) + '</button></div>'
          : '<div class="muted">' + esc(t('more.none')) + '</div>') +
      '</div>' +
      '<div class="sect"><h5>' + esc(t('more.copyLink')) + '</h5>' +
        '<div class="row"><button class="btn ghost wide small" data-act="link">' + esc(t('dl.copyLink')) + '</button></div>' +
      '</div>' +
      '<div class="sect"><h5>' + esc(t('more.pip')) + '</h5>' +
        '<div class="row"><button class="btn ghost wide small" data-act="pip">' + esc(t('more.pip')) + '</button></div>' +
      '</div>'
    );

    $$('[data-sub]').forEach(function (b) {
      b.addEventListener('click', function () {
        var c = info.captions[Number(b.getAttribute('data-sub'))];
        if (!c) return;
        var name = L.sanitizeFilename(info.title + ' (' + c.langTitle + ')') + '.' + (c.format || 'srt');
        RT.sendMessage({ type: 'rt:save-url', url: c.url, filename: name }).then(function (r) {
          RT.toast(r && r.ok ? t('more.saved', { name: r.name }) : t('more.saveFail'));
        });
      });
    });

    $$('[data-ch]').forEach(function (b) {
      b.addEventListener('click', function () {
        var v = RT.getPlayerVideo();
        if (v) v.currentTime = Number(b.getAttribute('data-ch'));
      });
    });

    var thumb = $('[data-act="thumb"]');
    if (thumb) thumb.addEventListener('click', function () {
      var name = L.sanitizeFilename(info.title) + '.jpg';
      RT.sendMessage({ type: 'rt:save-url', url: info.thumbnail, filename: name }).then(function (r) {
        RT.toast(r && r.ok ? t('more.saved', { name: r.name }) : t('more.saveFail'));
      });
    });

    var chcopy = $('[data-act="chcopy"]');
    if (chcopy) chcopy.addEventListener('click', function () {
      var text = (info.cuepoints || []).map(function (c) {
        return L.formatTime(c.time) + ' — ' + (c.title || '');
      }).join('\n');
      RT.copyText(text, t('toast.copied'));
    });

    var link = $('[data-act="link"]');
    if (link) link.addEventListener('click', function () {
      var v = currentVariant();
      if (v) RT.copyText(v.url, t('toast.copied'));
    });

    var pip = $('[data-act="pip"]');
    if (pip) pip.addEventListener('click', function () { RT.togglePip(); });
  }

  /* --------------------------------------------------------- вкладка «Инфо» */

  function renderInfoTab() {
    if (!state.info) {
      if (state.infoLoading) return setHTML(spinner(t('panel.loading')));
      loadInfo(true);
      return setHTML(spinner(t('panel.loading')));
    }
    var info = state.info;
    if (!state.metaLoaded && !state.metaLoading) {
      loadInfo(true);
    }
    var v0 = variants()[0] || {};
    var meta = info.meta || {};
    var fps = info.fps || v0.frameRate || 0;

    setHTML(
      '<div class="title">' + esc(info.title) + '</div>' +
      '<dl class="kv">' +
        '<dt>' + esc(t('info.author')) + '</dt><dd>' + esc(info.author || '—') + '</dd>' +
        '<dt>' + esc(t('info.codec')) + '</dt><dd>' + esc(v0.codecs || '—') + '</dd>' +
        '<dt>' + esc(t('info.fps')) + '</dt><dd>' + (fps || '—') + '</dd>' +
        '<dt>' + esc(t('info.bitrate')) + '</dt><dd>' + (v0.bandwidth ? Math.round(v0.bandwidth / 1000) + ' kbps' : '—') + '</dd>' +
        '<dt>' + esc(t('info.qualities')) + '</dt><dd>' + esc(variants().map(function (v) { return v.label; }).join(', ')) + '</dd>' +
        '<dt>' + esc(t('info.size')) + '</dt><dd>' + esc(L.formatBytes(v0.estimatedBytes)) + '</dd>' +
        (meta.views ? '<dt>' + esc(t('info.views')) + '</dt><dd>' + meta.views.toLocaleString('ru-RU') + '</dd>' : '') +
        (meta.created ? '<dt>' + esc(t('info.date')) + '</dt><dd>' + esc(String(meta.created).replace('T', ' ')) + '</dd>' : '') +
      '</dl>' +
      '<div class="row" style="margin-top:12px"><button class="btn ghost wide small" data-act="copy">' + esc(t('info.copy')) + '</button></div>'
    );

    var copy = $('[data-act="copy"]');
    if (copy) copy.addEventListener('click', function () {
      var text = [
        info.title,
        t('info.author') + ': ' + (info.author || '—'),
        t('info.codec') + ': ' + (v0.codecs || '—'),
        t('info.fps') + ': ' + fps,
        t('info.bitrate') + ': ' + (v0.bandwidth ? Math.round(v0.bandwidth / 1000) + ' kbps' : '—'),
        t('info.qualities') + ': ' + variants().map(function (v) { return v.label; }).join(', '),
        'URL: ' + location.href
      ].join('\n');
      RT.copyText(text, t('info.copied'));
    });
  }

  /* ------------------------------------------------------------- запуск загрузки */

  function startVideo() {
    var id = RT.getVideoId();
    if (!id) return;
    var variant = currentVariant();
    var from = null, to = null;

    if (state.mode === 'part') {
      from = L.parseTimecode(state.from || '0');
      to = state.to ? L.parseTimecode(state.to) : (state.info.durationSec || null);
      if (isNaN(from)) from = 0;
      if (to != null && (isNaN(to) || to <= from)) {
        RT.toast(t('err.emptyRange'));
        return;
      }
    }

    state.lastRequest = { videoId: id, height: variant ? variant.height : null, from: from, to: to };
    state.result = null;
    state.job = { id: null, kind: 'video', startedAt: Date.now(), quality: variant ? variant.label : '', phase: 'meta' };
    RT.startKeepalive();
    render();

    RT.sendMessage({
      type: 'rt:start',
      videoId: id,
      height: variant ? variant.height : null,
      from: from,
      to: to,
      maxPartMB: RT.settings.maxPartMB
    }).then(function (r) {
      if (!r || !r.ok) {
        state.job = null;
        RT.stopKeepalive();
        state.result = { ok: false, code: 'start', detail: (r && r.error) || '' };
        render();
        return;
      }
      if (state.job) state.job.id = r.jobId;
    });
  }

  function startPlaylist() {
    var plId = RT.getPlaylistId();
    if (!plId || !state.playlist) return;
    var variant = null;
    state.lastRequest = { playlistId: plId, height: state.plChoice || RT.settings.quality };
    state.result = null;
    state.job = { id: null, kind: 'playlist', startedAt: Date.now(), phase: 'queue-load' };
    RT.startKeepalive();
    render();

    RT.sendMessage({
      type: 'rt:start-playlist',
      playlistId: plId,
      height: state.plChoice || RT.settings.quality,
      fromIndex: state.pFrom ? Math.max(0, Number(state.pFrom) - 1) : 0,
      toIndex: state.pTo ? Number(state.pTo) : null,
      maxPartMB: RT.settings.maxPartMB
    }).then(function (r) {
      if (!r || !r.ok) {
        state.job = null;
        RT.stopKeepalive();
        state.result = { ok: false, code: 'start', detail: (r && r.error) || '' };
        render();
        return;
      }
      if (state.job) state.job.id = r.jobId;
    });
  }

  function cancelJob() {
    if (!state.job) return;
    if (state.job.id) RT.sendMessage({ type: 'rt:cancel', jobId: state.job.id });
    state.job = null;
    RT.stopKeepalive();
    state.result = { ok: false, code: 'cancelled' };
    render();
  }

  function togglePause() {
    if (!state.job || !state.job.id || state.job.kind !== 'playlist') return;
    var paused = !state.job.paused;
    state.job.paused = paused;
    RT.sendMessage({ type: paused ? 'rt:pause' : 'rt:resume', jobId: state.job.id });
    render();
  }

  /* ------------------------------------------------------------- прогресс */

  function renderRunning() {
    var j = state.job;
    if (!j) return;
    var p = state.progress || {};
    var percent = p.percent || 0;
    var part = p.part || 1, parts = p.parts || 1;
    var isPlaylist = j.kind === 'playlist';

    var meta = '';
    if (p.bytes) {
      meta = L.formatBytes(p.bytes);
      var elapsed = (Date.now() - (j.partStartedAt || j.startedAt)) / 1000;
      if (elapsed > 1) meta += ' · ' + L.formatBytes(p.bytes / elapsed) + t('unit.perSec');
    }

    var title = t('dl.phase.' + (p.phase || 'meta'));
    if (p.phase === 'download') {
      title = parts > 1 ? t('dl.downloading', { part: part, parts: parts }) : t('dl.downloadingOne');
    }

    var queueLine = '';
    if (isPlaylist && p.queue) {
      queueLine = '<div class="muted" style="margin-bottom:6px">' +
        esc(t('pl.item', { i: p.queue.index, n: p.queue.total })) +
        (j.doneCount ? ' · ' + esc(t('pl.savedCount', { n: j.doneCount })) : '') +
        '<div style="opacity:.8;font-size:11px;margin-top:2px">' + esc((p.queue.title || '').slice(0, 70)) + '</div></div>';
    }

    setHTML(
      queueLine +
      '<div class="muted" style="margin-bottom:2px"><span class="spin"></span>' +
        esc(title) + (j.quality ? ' · ' + esc(j.quality) : '') + '</div>' +
      '<div class="bar"><i style="width:' + percent + '%"></i></div>' +
      '<div class="prog"><span>' + percent + '%' +
        (p.done != null && p.total ? ' · ' + esc(t('dl.segments', { done: p.done, total: p.total })) : '') +
      '</span><span>' + esc(meta) + '</span></div>' +
      '<div class="row" style="margin-top:11px">' +
        (isPlaylist ? '<button class="btn ghost" data-act="pause">' + esc(j.paused ? t('dl.resume') : t('dl.pause')) + '</button>' : '') +
        '<button class="btn ghost" data-act="cancel" style="flex:1">' + esc(t('dl.cancel')) + '</button>' +
      '</div>'
    );

    var cancel = $('[data-act="cancel"]');
    if (cancel) cancel.addEventListener('click', cancelJob);
    var pause = $('[data-act="pause"]');
    if (pause) pause.addEventListener('click', togglePause);
  }

  function renderResult() {
    var r = state.result;
    if (!r) return;

    if (r.ok) {
      var files = (r.files || []).map(function (f) { return esc(f); }).join('<br>');
      setHTML(
        '<div class="ok" style="font-weight:700;margin-bottom:6px">' + esc(t('dl.done')) + '</div>' +
        '<div class="muted" style="margin-bottom:8px">' + esc(t('dl.doneSaved')) +
          (r.mode === 'ts' ? esc(t('dl.doneTs')) : '') + '</div>' +
        '<div class="title" style="color:#e7e7ee">' + files + '</div>' +
        (r.failed && r.failed.length
          ? '<div class="err" style="margin-top:8px">' + esc(t('pl.failed', { n: r.failed.length })) + '</div>'
          : '') +
        '<div class="row" style="margin-top:10px">' +
          (r.downloadIds && r.downloadIds.length
            ? '<button class="btn ghost" data-act="show" style="flex:1">' + esc(t('dl.showFile')) + '</button>' : '') +
          '<button class="btn ghost" data-act="close" style="flex:1">' + esc(t('panel.close')) + '</button>' +
        '</div>' +
        '<div class="row"><button class="btn ghost wide small" data-act="again">' + esc(t('dl.again')) + '</button></div>'
      );
      var show = $('[data-act="show"]');
      if (show) show.addEventListener('click', function () {
        RT.sendMessage({ type: 'rt:show-download', id: r.downloadIds[0] });
      });
      var close = $('[data-act="close"]');
      if (close) close.addEventListener('click', function () {
        state.result = null;
        RT.closePanel();
      });
      var again = $('[data-act="again"]');
      if (again) again.addEventListener('click', function () {
        state.result = null;
        state.tab = state.playlistId && !state.videoId ? 'playlist' : 'download';
        RT.buildTabs();
        render();
      });
      return;
    }

    var code = r.code || 'download';
    var message = code === 'cancelled' ? t('err.cancelled')
      : code === 'live' ? t('err.live')
      : code === 'drm' ? t('err.drm')
      : code === 'empty-range' ? t('err.emptyRange')
      : code === 'playlist' ? t('err.playlist')
      : code === 'start' ? t('err.start')
      : t('err.download');

    setHTML(
      '<div class="err" style="margin-bottom:10px">' + esc(message) +
        (r.detail ? '<div class="muted" style="margin-top:4px">' + esc(String(r.detail).slice(0, 200)) + '</div>' : '') +
      '</div>' +
      '<div class="row">' +
        '<button class="btn ghost wide" data-act="retry">' +
          esc(state.lastRequest ? t('panel.retryDownload') : t('panel.retry')) + '</button>' +
      '</div>' +
      '<div class="row"><button class="btn ghost wide small" data-act="diag">' + esc(t('panel.copyDiag')) + '</button></div>'
    );

    var retry = $('[data-act="retry"]');
    if (retry) retry.addEventListener('click', function () {
      state.result = null;
      if (state.lastRequest && state.lastRequest.playlistId) startPlaylist();
      else if (state.lastRequest) startVideo();
      else { state.info = null; state.infoFor = null; loadInfo(); }
    });

    var diag = $('[data-act="diag"]');
    if (diag) diag.addEventListener('click', function () {
      RT.sendMessage({ type: 'rt:diagnostics' }).then(function (d) {
        var info = state.info || {};
        var text = [
          'RuTube Tools v' + ((d && d.diag && d.diag.version) || '?'),
          'Browser: ' + navigator.userAgent,
          'Page: ' + location.href,
          'Video: ' + (info.videoId || RT.getVideoId() || '—') + ' · ' + (info.title || '—'),
          'Quality: ' + ((state.lastRequest && state.lastRequest.height) || '—'),
          'Error code: ' + code,
          'Detail: ' + (r.detail || '—'),
          'Mirror: ' + JSON.stringify(((d && d.diag && d.diag.lastError) || {}).mirror || '—'),
          'Time: ' + new Date().toISOString()
        ].join('\n');
        RT.copyText(text, t('toast.diagCopied'));
      });
    });
  }

  /* --------------------------------------------------------- сообщения фона */

  function onProgress(msg) {
    if (!state.job) return;
    if (msg.jobId && state.job.id && msg.jobId !== state.job.id) return;
    if (!state.job.id && msg.jobId) state.job.id = msg.jobId;

    if (msg.phase === 'queue-item' && msg.queue) {
      state.job.paused = false;
      state.progress = { phase: 'meta', queue: msg.queue, percent: 0 };
      render();
      return;
    }

    if (msg.phase === 'queue-video-done') {
      state.job.doneCount = (state.job.doneCount || 0) + 1;
      state.job.filesSaved = (state.job.filesSaved || 0) + ((msg.files || []).length);
      state.progress = { phase: 'meta', queue: state.job.queue, percent: 0 };
      RT.toast((state.job.queue ? state.job.queue.title : '') + ' — готово', { duration: 1400 });
      render();
      return;
    }

    if (msg.phase === 'done') {
      state.job = null;
      RT.stopKeepalive();
      state.result = {
        ok: true,
        files: msg.files || [],
        downloadIds: msg.downloadIds || [],
        mode: msg.mode
      };
      state.progress = null;
      if (navigator.vibrate) { try { navigator.vibrate(40); } catch (e) {} }
      render();
      return;
    }

    if (msg.phase === 'queue-done') {
      state.job = null;
      RT.stopKeepalive();
      state.result = {
        ok: true,
        files: msg.files || [],
        failed: msg.failed || [],
        downloadIds: []
      };
      state.progress = null;
      render();
      return;
    }

    if (msg.phase === 'error' || msg.phase === 'cancelled') {
      state.job = null;
      RT.stopKeepalive();
      state.result = {
        ok: false,
        code: msg.error || 'download',
        detail: msg.detail || ''
      };
      state.progress = null;
      render();
      return;
    }

    // обычные фазы
    if (msg.phase === 'download') {
      if (state.job && state.job.part !== msg.part) {
        state.job.part = msg.part;
        state.job.partStartedAt = Date.now();
      }
    }
    state.progress = msg;
    if (msg.queue) state.job.queue = msg.queue;
    render();
  }

  window.RTPanel = {
    render: render,
    load: load,
    onProgress: onProgress,
    startVideo: startVideo,
    startPlaylist: startPlaylist,
    cancelJob: cancelJob
  };
})();
