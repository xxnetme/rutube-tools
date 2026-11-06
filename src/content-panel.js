/* RuTube Tools — панель: вкладки «Скачать / Кадры / Ещё / Инфо» и плейлист. */
'use strict';
(function () {
  var RT = window.__RT;
  if (!RT) return;

  var L = RT.L, t = RT.t, D = RT.D;
  var state = RT.state;

  state.result = null;

  function $(sel) { return RT.ui().body.querySelector(sel); }
  function $$(sel) { return Array.prototype.slice.call(RT.ui().body.querySelectorAll(sel)); }
  function body() { return RT.ui().body; }

  function setNodes() {
    var args = [body()].concat(Array.prototype.slice.call(arguments));
    D.set.apply(null, args);
  }

  function btn(label, attrs) {
    return D.h('button', Object.assign({ class: 'btn ghost' }, attrs || {}), label);
  }

  function field(label, control) {
    return D.h('div', { class: 'field' },
      D.h('span', { class: 'lb', text: label }), D.h('span', { class: 'in' }, control));
  }

  function section(title) {
    var children = Array.prototype.slice.call(arguments, 1);
    return D.h.apply(null, ['div', { class: 'sect' }, title ? D.h('h5', { text: title }) : null].concat(children));
  }

  /* Какие серии плейлиста качать. null — все; иначе список номеров с нуля,
   * как их понимает фон. */
  function plSelected() {
    return state.plPick;
  }

  /* null — «все», но первая же снятая галочка материализует список:
   * иначе снять одну серию из «всех» было бы нечем. */
  function plToggle(i, on) {
    var set;
    if (state.plPick) {
      set = state.plPick.slice();
    } else {
      var total = (state.playlist && state.playlist.videosCount) || 0;
      set = [];
      for (var k = 0; k < Math.min(total, 500); k++) set.push(k);
    }
    var at = set.indexOf(i);
    if (on && at === -1) set.push(i);
    if (!on && at !== -1) set.splice(at, 1);
    set.sort(function (a, b) { return a - b; });
    state.plPick = set;
  }

  /* Формат вкладки «Скачать»: пока пользователь не переключил его руками,
   * берём значение из настроек — «видео» или «только звук». */
  function currentFormat() {
    return state.format || (RT.settings.defaultFormat === 'audio' ? 'audio' : 'video');
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
    if (withMeta && state.metaAttempted === id && state.infoFor === id) { render(); return; }
    state.infoLoading = true;
    if (withMeta) { state.metaLoading = true; state.metaAttempted = id; }
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
    return D.h('div', { class: 'muted' }, D.h('span', { class: 'spin' }), text);
  }

  /* ---------------------------------------------------------- вкладка «Скачать» */

  function renderDownloadTab() {
    if (!state.info) {
      if (state.infoLoading) return setNodes(spinner(t('panel.loading')));
      if (state.infoError) return renderErrorBox(state.infoError);
      loadInfo();
      return setNodes(spinner(t('panel.loading')));
    }
    var info = state.info;
    if (info.isLive) return renderBlocked(t('err.live'));
    if (info.drmProtected) return renderBlocked(t('err.drm'));

    var list = variants();
    var sel = selectedHeight();
    var rows = list.map(function (v) {
      var checked = sel != null && Math.abs(v.height - sel) < 1;
      return D.h('label', { class: v.compatible ? '' : 'dis' },
        D.h('input', { type: 'radio', name: 'rq', value: v.height, checked: checked }),
        D.h('span', { class: 'radio' }),
        D.h('span', { class: 'lbl' }, v.label, v.compatible ? null : ' · .ts'),
        D.h('span', { class: 'est', text: v.estimatedBytes ? L.formatBytes(v.estimatedBytes) : '' })
      );
    });

    var caps = (info.captions || []).filter(function (c) { return c && c.url; });
    if (state.subs == null) state.subs = !!RT.settings.saveSubs;
    var big = list.some(function (v) { return v.estimatedBytes > 900 * 1024 * 1024; });
    var isPart = state.mode === 'part';
    var isAudio = currentFormat() === 'audio';
    var light = L.pickAudioVariant(list);
    var chosen = list.filter(function (v) { return sel != null && Math.abs(v.height - sel) < 1; })[0];

    var children = [
      D.h('div', { class: 'title', text: info.title }),
      D.h('div', { class: 'seg', style: 'margin-bottom:8px' },
        D.h('button', { 'data-fmt': 'video', class: !isAudio ? 'on' : '', text: t('dl.fmtVideo') }),
        D.h('button', { 'data-fmt': 'audio', class: isAudio ? 'on' : '', text: t('dl.fmtAudio') })
      )
    ];

    if (isAudio) {
      children.push(D.h('div', { class: 'hint', style: 'margin-bottom:8px', text: t('dl.audioHint', {
        q: light ? light.label : '—',
        size: light && light.estimatedBytes ? L.formatBytes(light.estimatedBytes) : '?'
      }) }));
    } else {
      children.push(D.h('div', { class: 'q' }, rows));
      if (chosen && !chosen.compatible) {
        children.push(D.h('div', { class: 'hint', style: 'margin-bottom:8px' }, '⚠ ', t('dl.tsWarn')));
      }
    }

    children.push(D.h('div', { class: 'seg' },
      D.h('button', { 'data-mode': 'full', class: !isPart ? 'on' : '', text: t('dl.modeFull') }),
      D.h('button', { 'data-mode': 'part', class: isPart ? 'on' : '', text: t('dl.modePart') })
    ));

    if (!isAudio && caps.length) {
      children.push(D.h('div', { class: 'sw' },
        D.h('span', { text: t('dl.subs') }),
        D.h('input', { type: 'checkbox', 'data-act': 'subs', checked: !!state.subs })
      ));
      if (state.subs && caps.length > 1) {
        children.push(field(t('dl.subsLang'), D.h('select', { 'data-in': 'subslang' }, caps.map(function (c, i) {
          return D.h('option', {
            value: i, selected: i === state.subsIndex,
            text: c.langTitle || c.lang || ('#' + (i + 1))
          });
        }))));
      }
    }

    if (isPart) {
      children.push(
        D.h('div', { class: 'field' },
          D.h('span', { class: 'lb', text: t('dl.from') }),
          D.h('span', { class: 'in' }, D.h('input', {
            type: 'text', 'data-in': 'from', placeholder: '0:00', value: state.from
          })),
          btn('⏱', { class: 'btn ghost small', 'data-take': 'from', title: t('dl.fromPlayer') })
        ),
        D.h('div', { class: 'field' },
          D.h('span', { class: 'lb', text: t('dl.to') }),
          D.h('span', { class: 'in' }, D.h('input', {
            type: 'text', 'data-in': 'to', placeholder: L.formatTime(info.durationSec), value: state.to
          })),
          btn('⏱', { class: 'btn ghost small', 'data-take': 'to', title: t('dl.fromPlayer') })
        )
      );
    }

    var linkIcon = D.svg('svg', {
      width: 15, height: 15, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
      'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round'
    },
      D.svg('path', { d: 'M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7' }),
      D.svg('path', { d: 'M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7' })
    );
    children.push(
      D.h('div', { class: 'row', style: 'margin-top:10px' },
        btn(isPart ? t('dl.startPart') : (isAudio ? t('dl.startAudio') : t('dl.start')), {
          class: 'btn', 'data-act': 'go'
        }),
        btn(linkIcon, { class: 'btn ghost', 'data-act': 'link', title: t('dl.copyLink') })
      ),
      D.h('div', { class: 'hint' },
        info.durationSec ? [t('dl.duration') + ' ', L.formatTime(info.durationSec), ' · '] : null,
        isAudio ? null : t('dl.mergeHint'),
        big && !isAudio ? ['. ', t('dl.partsHint', { n: RT.settings.maxPartMB })] : null
      ),
      D.h('div', { class: 'hint', text: t('dl.frameHint', { key: RT.settings.shotKey }) })
    );
    setNodes(children);

    $$('input[name="rq"]').forEach(function (inp) {
      inp.addEventListener('change', function () {
        state.choice = inp.value;
        try { RT.api.storage.local.set({ quality: inp.value }); } catch (e) {}
        var v = currentVariant();
        if (v) state.lastRequest = null;
        render();
      });
    });

    $$('.seg button[data-mode]').forEach(function (b) {
      b.addEventListener('click', function (e) {
        e.preventDefault();
        state.mode = b.getAttribute('data-mode');
        render();
      });
    });

    var subsBox = $('[data-act="subs"]');
    if (subsBox) subsBox.addEventListener('change', function () {
      state.subs = !!subsBox.checked;
      RT.settings.saveSubs = state.subs;
      try { RT.api.storage.local.set({ saveSubs: state.subs }); } catch (e) {}
      render();
    });

    var subsLang = $('[data-in="subslang"]');
    if (subsLang) subsLang.addEventListener('change', function () {
      state.subsIndex = Number(subsLang.value) || 0;
      render();
    });

    $$('.seg button[data-fmt]').forEach(function (b) {
      b.addEventListener('click', function (e) {
        e.preventDefault();
        state.format = b.getAttribute('data-fmt');
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
    setNodes(D.h('div', { class: 'err', style: 'margin-bottom:10px', text: text }));
  }

  function renderErrorBox(text) {
    setNodes(
      D.h('div', { class: 'err', style: 'margin-bottom:10px', text: text }),
      D.h('div', { class: 'row' }, btn(t('panel.retry'), { class: 'btn ghost wide', 'data-act': 'retry-info' }))
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
    if (state.playlistLoading) return setNodes(spinner(t('pl.loading')));
    if (state.playlistError) return renderErrorBox(state.playlistError);
    if (!state.playlist) { loadPlaylist(); return setNodes(spinner(t('pl.loading'))); }

    var pl = state.playlist;
    var audio = currentFormat() === 'audio';
    var pick = plSelected();
    var chosen = pick || null;
    var count = chosen ? chosen.length : pl.videosCount;

    // грубая оценка объёма: типичный битрейт RuTube для выбранного качества
    var BITRATE = { '144': 140000, '240': 220000, '360': 380000, '480': 500000, '720': 720000, '1080': 1500000 };
    var chosenQ = state.plChoice || RT.settings.quality;
    // для звука качается самый лёгкий поток (144p), а не выбранное качество
    var kbps = audio ? BITRATE['144'] : (BITRATE[chosenQ] || BITRATE['720']);
    var known = pl.videos || [];
    var knownSecs = known.reduce(function (sum, v) { return sum + (v.durationSec || 0); }, 0);
    var avg = known.length ? knownSecs / known.length : 900;
    var estimate = count * avg * kbps / 8;

    var qualityOptions = ['best', '1080', '720', '480', '360', 'worst'].map(function (q) {
      var label = q === 'best' ? t('opt.best') : (q === 'worst' ? t('opt.worst') : q + 'p');
      return D.h('option', {
        value: q, selected: (state.plChoice || RT.settings.quality) === q, text: label
      });
    });

    /* Список серий: названия есть только для загруженной страницы, остальные
     * показываем номерами — галочка всё равно работает, фон читает нужную
     * страницу сам. Длинный плейлист прокручивается внутри блока. */
    var rows = [];
    var byIndex = state.plMeta || {};
    for (var i = 0; i < pl.videosCount; i++) {
      var meta = byIndex[i] || known[i];
      var on = pick ? pick.indexOf(i) !== -1 : true;
      var label = meta && meta.title ? meta.title : t('pl.item', { i: i + 1, n: pl.videosCount });
      var dur = meta && meta.durationSec ? L.formatTime(meta.durationSec) : '';
      rows.push(D.h('label', { class: 'pl-row' },
        D.h('input', { type: 'checkbox', 'data-pl': i, checked: on }),
        D.h('span', { class: 'pl-n', text: i + 1 }),
        D.h('span', { class: 'pl-t', text: label }),
        dur ? D.h('span', { class: 'pl-d', text: dur }) : null
      ));
    }

    setNodes(
      D.h('div', { class: 'title', text: pl.title }),
      D.h('div', { class: 'muted', style: 'margin-bottom:10px', text: t('pl.count', { n: pl.videosCount }) }),
      field(t('dl.format'), D.h('select', { 'data-sel': 'fmt' },
        D.h('option', { value: 'video', selected: !audio, text: t('dl.fmtVideo') }),
        D.h('option', { value: 'audio', selected: audio, text: t('dl.fmtAudio') })
      )),
      field(t('info.qualities'), D.h('select', { 'data-sel': 'q', disabled: audio }, qualityOptions)),
      D.h('div', { class: 'pl-head' },
        D.h('span', { text: t('pl.selected', { n: count, total: pl.videosCount }) }),
        btn(t('pl.all'), { class: 'btn ghost small', 'data-act': 'pl-all' }),
        btn(t('pl.none'), { class: 'btn ghost small', 'data-act': 'pl-none' })
      ),
      D.h('div', { class: 'pl-list' }, rows),
      D.h('div', { class: 'row', style: 'margin-top:10px' },
        btn(t('pl.start'), { class: 'btn', 'data-act': 'go-pl', disabled: !count })
      ),
      D.h('div', { class: 'hint' },
        t('pl.delay', { s: 1 }),
        count ? [' · ', t('info.size'), ': ~', L.formatBytes(estimate)] : null
      )
    );

    var sel = $('[data-sel="q"]');
    if (sel) sel.addEventListener('change', function () { state.plChoice = sel.value; });

    var fmt = $('[data-sel="fmt"]');
    if (fmt) fmt.addEventListener('change', function () { state.format = fmt.value; render(); });

    var list = $('.pl-list');
    if (list) list.addEventListener('scroll', function () {
      var bottom = list.scrollTop + list.clientHeight;
      if (bottom < list.scrollHeight - 90) return;
      if (state.plMetaLoading) return;
      loadMissingMeta();
    });

    $$('[data-pl]').forEach(function (box) {
      box.addEventListener('change', function () {
        plToggle(Number(box.getAttribute('data-pl')), box.checked);
        render();
      });
    });

    var all = $('[data-act="pl-all"]');
    if (all) all.addEventListener('click', function () {
      state.plPick = null;
      render();
    });

    var none = $('[data-act="pl-none"]');
    if (none) none.addEventListener('click', function () {
      state.plPick = [];
      render();
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

    setNodes(
      section(null,
        btn([t('fr.save'), ' ', D.h('kbd', { style: 'opacity:.8', text: RT.settings.shotKey })], {
          class: 'btn', 'data-act': 'shot', style: 'width:100%'
        }),
        D.h('div', { class: 'row', style: 'margin-top:6px' },
          btn([t('fr.copy'), ' ', D.h('kbd', { style: 'opacity:.8', text: 'c' })], {
            class: 'btn ghost wide small', 'data-act': 'copyshot'
          })
        )
      ),
      section(t('fr.goto'),
        D.h('div', { class: 'row' },
          D.h('input', {
            type: 'number', min: 1, 'data-in': 'frame', placeholder: Math.round(cur * fps), style: 'flex:1'
          }),
          btn(t('fr.go'), { class: 'btn ghost', 'data-act': 'goto' })
        ),
        D.h('div', { class: 'hint' }, fps, ' fps · ', RT.timecode(cur))
      ),
      section(t('fr.ab'),
        D.h('div', { class: 'row' },
          btn('A: ' + (ab.a == null ? '—' : RT.timecode(ab.a)), {
            class: 'btn ghost wide small', 'data-act': 'setA'
          }),
          btn('B: ' + (ab.b == null ? '—' : RT.timecode(ab.b)), {
            class: 'btn ghost wide small', 'data-act': 'setB'
          })
        ),
        D.h('div', { class: 'sw', style: 'margin-top:8px' },
          D.h('span', { text: ab.loop ? t('fr.loopOn') : t('fr.loopOff') }),
          D.h('input', { type: 'checkbox', 'data-act': 'loop', checked: ab.loop })
        ),
        D.h('div', { class: 'row', style: 'margin-top:6px' },
          btn(t('fr.clear'), { class: 'btn ghost wide small', 'data-act': 'abclear' })
        )
      ),
      section(t('fr.storyboard'),
        field(t('fr.every'), D.h('input', {
          type: 'number', min: 0.2, step: 0.5, 'data-in': 'every', value: state.storyboard.every
        })),
        field(t('fr.frames'), D.h('input', {
          type: 'number', min: 1, max: 120, 'data-in': 'count', value: state.storyboard.count
        })),
        D.h('div', { class: 'sw', style: 'margin-bottom:6px' },
          D.h('span', { text: t('fr.onlyAB') }),
          D.h('input', {
            type: 'checkbox', 'data-act': 'useab', checked: state.storyboard.useAB,
            disabled: ab.a == null || ab.b == null
          })
        ),
        D.h('div', { class: 'row' },
          btn(t('fr.make'), { class: 'btn ghost wide small', 'data-act': 'board' }),
          btn(t('fr.sheet'), { class: 'btn ghost wide small', 'data-act': 'sheet' })
        )
      ),
      D.h('div', { class: 'sw' },
        D.h('span', { text: t('fr.pitch') }),
        D.h('input', { type: 'checkbox', 'data-act': 'pitch', checked: RT.settings.preservePitch })
      )
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
      state.storyboard.useAB = false;
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

    var sheet = $('[data-act="sheet"]');
    if (sheet) sheet.addEventListener('click', function () { RT.makeContactSheet(); });

    var copyshot = $('[data-act="copyshot"]');
    if (copyshot) copyshot.addEventListener('click', function () { RT.copyFrame(); });

    var useab = $('[data-act="useab"]');
    if (useab) useab.addEventListener('change', function () { state.storyboard.useAB = useab.checked; });

    var pitch = $('[data-act="pitch"]');
    if (pitch) pitch.addEventListener('change', function () {
      try { RT.api.storage.local.set({ preservePitch: pitch.checked }); } catch (e) {}
      RT.applyPitch(RT.getPlayerVideo());
    });
  }
  /* ------------------------------------------------------------- вкладка «Ещё» */

  function renderMoreTab() {
    if (!state.info) {
      if (state.infoLoading) return setNodes(spinner(t('panel.loading')));
      loadInfo();
      return setNodes(spinner(t('panel.loading')));
    }
    var info = state.info;
    var subs = (info.captions || []).map(function (c, i) {
      var isSrt = String(c.format || 'srt').toLowerCase() === 'srt';
      return D.h('div', { class: 'item' },
        D.h('span', { class: 'nm' },
          c.langTitle, c.isAuto ? [' · ', t('more.subAuto')] : null, ' · ', (c.format || 'srt').toUpperCase()),
        btn(t('tab.download'), { class: 'go', 'data-sub': i }),
        isSrt ? btn('VTT', { class: 'go', 'data-sub-vtt': i, title: t('more.saveVtt') }) : null
      );
    });

    var chapters = (info.cuepoints || []).map(function (c) {
      return D.h('div', { class: 'item' },
        D.h('span', { class: 'nm' }, L.formatTime(c.time), ' · ', c.title || '—'),
        btn('▶', { class: 'go', 'data-ch': Number(c.time) || 0 })
      );
    });

    setNodes(
      section(t('more.subtitles'),
        subs.length ? D.h('div', { class: 'list' }, subs) : D.h('div', { class: 'muted', text: t('more.none') })
      ),
      section(t('more.thumb'), info.thumbnail
        ? D.h('div', { class: 'row' }, btn(t('tab.download'), { class: 'btn ghost wide small', 'data-act': 'thumb' }))
        : D.h('div', { class: 'muted', text: t('more.none') })
      ),
      section(t('more.chapters'), chapters.length ? [
        D.h('div', { class: 'list' }, chapters),
        D.h('div', { class: 'row', style: 'margin-top:6px' },
          btn(t('more.copyChapters'), { class: 'btn ghost wide small', 'data-act': 'chcopy' })
        ),
        D.h('div', { class: 'row', style: 'margin-top:6px' },
          btn(t('more.saveChapters'), { class: 'btn ghost wide small', 'data-act': 'chtxt' }),
          btn(t('more.saveChaptersFf'), { class: 'btn ghost wide small', 'data-act': 'chff' })
        ),
        D.h('div', { class: 'hint', text: t('more.chaptersHint') })
      ] : D.h('div', { class: 'muted', text: t('more.none') })),
      section(t('more.copyLink'),
        D.h('div', { class: 'row' }, btn(t('dl.copyLink'), { class: 'btn ghost wide small', 'data-act': 'link' }))
      ),
      section(t('more.pip'),
        D.h('div', { class: 'row' }, btn(t('more.pip'), { class: 'btn ghost wide small', 'data-act': 'pip' }))
      )
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

    $$('[data-sub-vtt]').forEach(function (b) {
      b.addEventListener('click', function () {
        var c = info.captions[Number(b.getAttribute('data-sub-vtt'))];
        if (!c) return;
        var name = L.sanitizeFilename(info.title + ' (' + c.langTitle + ')') + '.vtt';
        RT.sendMessage({ type: 'rt:save-vtt', url: c.url, filename: name }).then(function (r) {
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

    function saveText(text, suffix, ext) {
      var name = L.sanitizeFilename(info.title) + ' — ' + suffix + '.' + ext;
      var dataUrl = 'data:text/plain;charset=utf-8,' + encodeURIComponent(text);
      RT.sendMessage({ type: 'rt:save-data-url', dataUrl: dataUrl, filename: name }).then(function (r) {
        RT.toast(r && r.ok ? t('more.saved', { name: r.name }) : t('more.saveFail'));
      });
    }
    var chtxt = $('[data-act="chtxt"]');
    if (chtxt) chtxt.addEventListener('click', function () {
      saveText(L.chaptersToText(info.cuepoints), t('more.chapters').toLowerCase(), 'txt');
    });
    var chff = $('[data-act="chff"]');
    if (chff) chff.addEventListener('click', function () {
      saveText(L.chaptersToFfmetadata(info.cuepoints, info.durationSec, info.title),
               t('more.chapters').toLowerCase(), 'ffmeta');
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
      if (state.infoLoading) return setNodes(spinner(t('panel.loading')));
      loadInfo(true);
      return setNodes(spinner(t('panel.loading')));
    }
    var info = state.info;
    if (!state.metaLoaded && !state.metaLoading && state.metaAttempted !== RT.getVideoId()) {
      loadInfo(true);
    }
    var v0 = variants()[0] || {};
    var meta = info.meta || {};
    var fps = info.fps || v0.frameRate || 0;

    var pairs = [];
    function kv(label, value) {
      pairs.push(D.h('dt', { text: label }), D.h('dd', { text: value }));
    }
    kv(t('info.author'), info.author || '—');
    kv(t('info.codec'), v0.codecs || '—');
    kv(t('info.fps'), fps || '—');
    kv(t('info.bitrate'), v0.bandwidth ? Math.round(v0.bandwidth / 1000) + ' kbps' : '—');
    kv(t('info.qualities'), variants().map(function (v) { return v.label; }).join(', '));
    kv(t('info.size'), L.formatBytes(v0.estimatedBytes));
    if (meta.views) kv(t('info.views'), Number(meta.views).toLocaleString('ru-RU'));
    if (meta.created) kv(t('info.date'), String(meta.created).replace('T', ' '));

    setNodes(
      D.h('div', { class: 'title', text: info.title }),
      D.h('dl', { class: 'kv' }, pairs),
      D.h('div', { class: 'row', style: 'margin-top:12px' },
        btn(t('info.copy'), { class: 'btn ghost wide small', 'data-act': 'copy' })
      )
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

    var audio = currentFormat() === 'audio';
    state.lastRequest = { videoId: id, height: variant ? variant.height : null, from: from, to: to };
    state.result = null;
    state.job = { id: null, kind: 'video', startedAt: Date.now(),
                  quality: audio ? 'M4A' : (variant ? variant.label : ''), phase: 'meta' };
    RT.startKeepalive();
    render();

    var sub = null;
    if (!audio && state.subs) {
      var caps = (state.info.captions || []).filter(function (c) { return c && c.url; });
      sub = caps[Math.min(state.subsIndex || 0, caps.length - 1)] || null;
    }

    RT.sendMessage({
      type: 'rt:start',
      videoId: id,
      audio: audio,
      height: variant ? variant.height : null,
      from: from,
      to: to,
      maxPartMB: RT.settings.maxPartMB,
      nameTemplate: RT.settings.nameTemplate || '',
      subsUrl: sub ? sub.url : '',
      subsExt: sub ? (sub.format || 'srt') : ''
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
    if (state.plPick && !state.plPick.length) return;
    state.lastRequest = { playlistId: plId, height: state.plChoice || RT.settings.quality };
    state.result = null;
    state.job = { id: null, kind: 'playlist', startedAt: Date.now(), phase: 'queue-load' };
    RT.startKeepalive();
    render();

    var pick = state.plPick;
    var full = !pick;                       // null — весь плейлист
    RT.sendMessage({
      type: 'rt:start-playlist',
      playlistId: plId,
      audio: currentFormat() === 'audio',
      height: state.plChoice || RT.settings.quality,
      fromIndex: full ? 0 : pick[0],
      toIndex: full ? null : pick[pick.length - 1] + 1,
      indices: full ? null : pick,
      maxPartMB: RT.settings.maxPartMB,
      nameTemplate: RT.settings.nameTemplate || ''
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

  /* Названия серий за пределами загруженной страницы: грузим по одной
   * странице, когда список долистали, и перерисовываем строки. */
  function loadMissingMeta() {
    var pl = state.playlist;
    if (!pl || !pl.videosCount) return;
    var byIndex = state.plMeta || (state.plMeta = {});
    var missing = [];
    for (var i = 0; i < pl.videosCount; i++) if (!byIndex[i] && !(pl.videos && pl.videos[i])) missing.push(i);
    if (!missing.length) return;

    var offset = Math.floor(missing[0] / (pl.pageSize || 50)) * (pl.pageSize || 50);
    state.plMetaLoading = true;
    RT.sendMessage({ type: 'rt:playlist-videos', playlistId: pl.id, offset: offset, limit: pl.pageSize || 50 })
      .then(function (r) {
        state.plMetaLoading = false;
        if (!r || !r.ok) return;
        // обновляем строки на месте: полная перерисовка сбросила бы прокрутку
        (r.videos || []).forEach(function (v, k) {
          var idx = offset + k;
          byIndex[idx] = v;
          var box = body().querySelector('[data-pl="' + idx + '"]');
          var row = box && box.parentNode;
          if (!row) return;
          var t = row.querySelector('.pl-t');
          if (t && v.title) t.textContent = v.title;
          var d = row.querySelector('.pl-d');
          if (v.durationSec != null) {
            if (!d) {
              d = document.createElement('span');
              d.className = 'pl-d';
              row.appendChild(d);
            }
            d.textContent = L.formatTime(v.durationSec);
          }
        });
      });
  }

  function cancelJob() {
    if (!state.job) return;
    if (state.job.id) {
      if (state.job.paused) {
        RT.sendMessage({ type: 'rt:pending-discard', id: state.job.pendingId || state.job.id });
      } else {
        RT.sendMessage({ type: 'rt:cancel', jobId: state.job.id });
      }
    }
    state.job = null;
    RT.stopKeepalive();
    state.result = { ok: false, code: 'cancelled' };
    render();
  }

  function togglePause() {
    var job = state.job;
    if (!job || !job.id || job.pauseRequested) return;
    if (job.kind === 'playlist') {
      job.paused = !job.paused;
      RT.sendMessage({ type: job.paused ? 'rt:pause' : 'rt:resume', jobId: job.id });
      render();
      return;
    }
    if (job.paused) {
      RT.sendMessage({ type: 'rt:pending-resume', id: job.pendingId || job.id }).then(function (r) {
        if (!r || !r.ok || !state.job) return;
        state.job.id = r.jobId || state.job.id;
        state.job.paused = false;
        state.job.pauseRequested = false;
        state.progress = { phase: 'meta', pendingId: state.job.pendingId };
        RT.startKeepalive();
        render();
      });
      return;
    }
    job.pauseRequested = true;
    RT.sendMessage({ type: 'rt:pause', jobId: job.id }).then(function (r) {
      if ((!r || !r.ok) && state.job) {
        state.job.pauseRequested = false;
        render();
      }
    });
    render();
  }

  /* ------------------------------------------------------------- прогресс */

  function renderRunning() {
    var j = state.job;
    if (!j) return;
    var p = state.progress || {};
    var percent = Math.max(0, Math.min(100, Number(p.percent) || 0));
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

    var children = [];
    if (isPlaylist && p.queue) {
      children.push(D.h('div', { class: 'muted', style: 'margin-bottom:6px' },
        t('pl.item', { i: p.queue.index, n: p.queue.total }),
        j.doneCount ? [' · ', t('pl.savedCount', { n: j.doneCount })] : null,
        D.h('div', {
          style: 'opacity:.8;font-size:11px;margin-top:2px',
          text: (p.queue.title || '').slice(0, 70)
        })
      ));
    }
    children.push(
      D.h('div', { class: 'muted', style: 'margin-bottom:2px' },
        D.h('span', { class: 'spin' }), title, j.quality ? [' · ', j.quality] : null),
      D.h('div', { class: 'bar' }, D.h('i', { style: 'width:' + percent + '%' })),
      D.h('div', { class: 'prog' },
        D.h('span', null, percent, '%',
          p.done != null && p.total ? [' · ', t('dl.segments', { done: p.done, total: p.total })] : null),
        D.h('span', { text: meta })
      ),
      D.h('div', { class: 'row', style: 'margin-top:11px' },
        btn(j.paused ? t('dl.resume') : t('dl.pause'), {
          class: 'btn ghost', 'data-act': 'pause', disabled: !!j.pauseRequested
        }),
        btn(t('dl.cancel'), { class: 'btn ghost', 'data-act': 'cancel', style: 'flex:1' })
      )
    );
    setNodes(children);

    var cancel = $('[data-act="cancel"]');
    if (cancel) cancel.addEventListener('click', cancelJob);
    var pause = $('[data-act="pause"]');
    if (pause) pause.addEventListener('click', togglePause);
  }
  function renderResult() {
    var r = state.result;
    if (!r) return;

    if (r.ok) {
      var files = [];
      (r.files || []).forEach(function (file, index) {
        if (index) files.push(D.h('br'));
        files.push(file);
      });
      setNodes(
        D.h('div', { class: 'ok', style: 'font-weight:700;margin-bottom:6px', text: t('dl.done') }),
        D.h('div', { class: 'muted', style: 'margin-bottom:8px' },
          t('dl.doneSaved'), r.mode === 'ts' ? t('dl.doneTs') : null),
        D.h('div', { class: 'title', style: 'color:#e7e7ee' }, files),
        r.subs && r.subs.length
          ? D.h('div', { class: 'muted', style: 'margin-top:4px' }, t('dl.subsDone'), ' ', r.subs.join(', '))
          : null,
        r.failed && r.failed.length
          ? D.h('div', { class: 'err', style: 'margin-top:8px', text: t('pl.failed', { n: r.failed.length }) })
          : null,
        D.h('div', { class: 'row', style: 'margin-top:10px' },
          r.downloadIds && r.downloadIds.length
            ? btn(t('dl.showFile'), { class: 'btn ghost', 'data-act': 'show', style: 'flex:1' })
            : null,
          btn(t('panel.close'), { class: 'btn ghost', 'data-act': 'close', style: 'flex:1' })
        ),
        D.h('div', { class: 'row' }, btn(t('dl.again'), { class: 'btn ghost wide small', 'data-act': 'again' }))
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

    setNodes(
      D.h('div', { class: 'err', style: 'margin-bottom:10px' },
        message,
        r.detail ? D.h('div', {
          class: 'muted', style: 'margin-top:4px', text: String(r.detail).slice(0, 200)
        }) : null
      ),
      D.h('div', { class: 'row' },
        btn(state.lastRequest ? t('panel.retryDownload') : t('panel.retry'), {
          class: 'btn ghost wide', 'data-act': 'retry'
        })
      ),
      D.h('div', { class: 'row' },
        btn(t('panel.copyDiag'), { class: 'btn ghost wide small', 'data-act': 'diag' })
      )
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
    if (msg.pendingId) state.job.pendingId = msg.pendingId;

    if (msg.phase === 'paused') {
      state.job.paused = true;
      state.job.pauseRequested = false;
      state.progress = Object.assign({}, state.progress || {}, msg);
      RT.stopKeepalive();
      render();
      return;
    }

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
        subs: msg.subs || [],
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
