'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const N = require('../src/lib/network.js');

function code(expected) {
  return (err) => {
    assert.equal(err && err.code, expected);
    return true;
  };
}

/** Реальный HTTP-стенд. Внешние имена отображаются на loopback только в драйвере
 * fetch; RTNetwork по-прежнему видит и проверяет исходные публичные URL. */
async function localFetch(t, handler) {
  const logical = [];
  const received = [];
  const server = http.createServer((req, res) => {
    received.push({ host: req.headers['x-rt-test-host'], url: req.url });
    handler(req, res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const base = 'http://127.0.0.1:' + address.port;
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = async (raw, init) => {
    const source = new URL(String(raw));
    logical.push(source.href);
    const target = new URL(source.pathname + source.search, base);
    const headers = new Headers(init && init.headers);
    headers.set('x-rt-test-host', source.host);
    return nativeFetch(target, Object.assign({}, init || {}, { headers }));
  };
  t.after(async () => {
    globalThis.fetch = nativeFetch;
    await new Promise((resolve) => server.close(resolve));
  });
  return { logical, received };
}

test('allowlist: точное имя или поддомен RuTube/CDN, только HTTP(S), без credentials', () => {
  const allowed = [
    'https://rutube.ru/api/video/x',
    'http://river-1.rutube.ru/master.m3u8',
    'https://pic.rtbcdn.ru/video/cover.jpg',
    'https://a.b.rtbcdn.net/seg0.ts',
    'HTTPS://PIC.RTBCDN.RU/cover.jpg'
  ];
  const denied = [
    'https://evil.example/a.srt',
    'https://rutube.ru.evil.example/a.srt',
    'https://notrutube.ru/a.srt',
    'https://user:pass@rutube.ru/a.srt',
    'https://rutube.ru@evil.example/a.srt',
    'file:///etc/passwd',
    'javascript:alert(1)',
    'data:text/plain,hello',
    '//rutube.ru/no-scheme',
    'не url',
    ''
  ];
  for (const url of allowed) assert.equal(N.isAllowedUrl(url), true, url);
  for (const url of denied) assert.equal(N.isAllowedUrl(url), false, url);
});

test('редиректы внутри RuTube/CDN выполняются, включая относительный Location', async (t) => {
  const env = await localFetch(t, (req, res) => {
    if (req.url === '/chain/start') {
      res.writeHead(302, { Location: '/chain/hop' });
    } else if (req.url === '/chain/hop') {
      res.writeHead(307, { Location: 'https://pic.rtbcdn.net/final' });
    } else if (req.url === '/final') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
      return;
    } else {
      res.writeHead(404);
    }
    res.end();
  });

  const response = await N.fetch('https://cdn.rutube.ru/chain/start');
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'ok');
  assert.deepEqual(env.logical, [
    'https://cdn.rutube.ru/chain/start',
    'https://cdn.rutube.ru/chain/hop',
    'https://pic.rtbcdn.net/final'
  ]);
});

test('чужой прямой URL и чужой Location не получают запрос', async (t) => {
  const env = await localFetch(t, (req, res) => {
    if (req.url === '/out') res.writeHead(302, { Location: 'https://evil.example/secret' });
    else if (req.url === '/as-file') res.writeHead(302, { Location: 'file:///etc/passwd' });
    else res.writeHead(200);
    res.end();
  });

  await assert.rejects(N.fetch('https://evil.example/direct'), code('url-not-allowed'));
  assert.deepEqual(env.logical, [], 'прямой чужой URL отклонён до fetch');

  await assert.rejects(N.fetch('https://cdn.rutube.ru/out'), code('url-not-allowed'));
  await assert.rejects(N.fetch('https://cdn.rutube.ru/as-file'), code('url-not-allowed'));
  assert.deepEqual(env.logical, ['https://cdn.rutube.ru/out', 'https://cdn.rutube.ru/as-file']);
  assert.ok(!env.received.some((r) => r.url === '/secret' || r.host === 'evil.example'));
});

test('цикл и redirect без Location завершаются ошибкой, а не бесконечной загрузкой', async (t) => {
  const env = await localFetch(t, (req, res) => {
    if (req.url === '/loop') res.writeHead(302, { Location: '/loop' });
    else if (req.url === '/missing') res.writeHead(302);
    else res.writeHead(404);
    res.end();
  });

  await assert.rejects(N.fetch('https://cdn.rutube.ru/loop'), code('too-many-redirects'));
  assert.equal(env.logical.length, 6, 'исходный запрос + не более пяти переходов');
  await assert.rejects(N.fetch('https://cdn.rutube.ru/missing'), code('redirect-not-allowed'));
});

test('opaqueredirect отклоняется: скрытый адрес нельзя считать безопасным', async (t) => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return { type: 'opaqueredirect', status: 0 };
  };
  t.after(() => { globalThis.fetch = original; });

  await assert.rejects(N.fetch('https://cdn.rutube.ru/hidden'), code('redirect-not-allowed'));
  assert.equal(calls, 1);
});
