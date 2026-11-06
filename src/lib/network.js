/* RuTube Tools — единая сетевая политика: только RuTube и его CDN.
 * Каждый переход выполняется вручную, чтобы проверить Location до нового запроса. */
'use strict';
(function (global) {
  var ALLOWED_HOSTS = /(^|\.)(rutube\.ru|rtbcdn\.ru|rtbcdn\.net)$/i;
  var REDIRECTS = { 301: true, 302: true, 303: true, 307: true, 308: true };
  var MAX_REDIRECTS = 5;
  var MAX_DATA_URL = 40 * 1024 * 1024;

  function error(code, message) {
    /** @type {Error & {code?: string}} */
    var err = new Error(message || code);
    err.code = code;
    return err;
  }

  function allowedUrl(raw) {
    try {
      var url = new URL(String(raw));
      if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
      if (url.username || url.password || !ALLOWED_HOSTS.test(url.hostname)) return null;
      return url;
    } catch (e) {
      return null;
    }
  }

  function isAllowedUrl(raw) {
    return !!allowedUrl(raw);
  }

  /* Только кадры PNG/JPEG/WebP и текст глав; SVG, HTML и remote URL запрещены. */
  function isAllowedDataUrl(raw) {
    return typeof raw === 'string' && raw.length <= MAX_DATA_URL &&
      /^data:(image\/(png|jpeg|webp);base64|text\/plain;charset=utf-8),/.test(raw);
  }

  function assertAllowedUrl(raw) {
    var url = allowedUrl(raw);
    if (!url) throw error('url-not-allowed', 'URL вне разрешённых доменов RuTube');
    return url.href;
  }

  /**
   * GET/HEAD с ручными редиректами. redirect:'follow' здесь нельзя использовать:
   * браузер обратился бы к следующему хосту до того, как расширение проверило адрес.
   * Если браузер скрывает Location (opaqueredirect), запрос отклоняется.
   */
  async function fetchChecked(raw, opts) {
    var current = assertAllowedUrl(raw);
    var init = Object.assign({}, opts || {});
    var method = String(init.method || 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') {
      throw error('method-not-allowed', 'Сетевая политика разрешает только GET и HEAD');
    }
    init.method = method;
    init.redirect = 'manual';

    for (var hop = 0; hop <= MAX_REDIRECTS; hop++) {
      var response = await global.fetch(current, init);
      if (!response || response.type === 'opaqueredirect') {
        throw error('redirect-not-allowed', 'Браузер скрыл адрес перенаправления');
      }
      if (!REDIRECTS[response.status]) return response;
      if (hop === MAX_REDIRECTS) break;

      var location = response.headers && typeof response.headers.get === 'function'
        ? response.headers.get('location') : null;
      if (!location) throw error('redirect-not-allowed', 'Перенаправление без доступного Location');
      var next;
      try { next = new URL(location, current).href; } catch (e) {
        throw error('redirect-not-allowed', 'Некорректный адрес перенаправления');
      }
      current = assertAllowedUrl(next);
      if (response.status === 303 && method !== 'HEAD') {
        method = 'GET';
        init.method = 'GET';
        delete init.body;
      }
    }
    throw error('too-many-redirects', 'Слишком много перенаправлений');
  }

  global.RTNetwork = {
    isAllowedUrl: isAllowedUrl,
    isAllowedDataUrl: isAllowedDataUrl,
    assertAllowedUrl: assertAllowedUrl,
    fetch: fetchChecked
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = global.RTNetwork;
})(typeof globalThis !== 'undefined' ? globalThis : this);
