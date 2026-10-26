'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');

const { loadConfig } = require('../src/config');
const { DevServer } = require('../src/server');
const { Api } = require('../src/api');
const { NetworkLog, maskText, maskHeaders } = require('../src/network');
const { networkLine, networkDetail } = require('../src/format');
const { makeApp, runClient, until } = require('./helpers');

test('máscara: campos de senha/token em JSON, formulário, query e XML; cabeçalhos de credencial', () => {
  assert.equal(maskText('{"usuario":"ana","senha":"123","novaSenha":"x"}'), '{"usuario":"ana","senha":"***","novaSenha":"***"}');
  assert.equal(maskText('{"access_token": "abc.def", "n": 1}'), '{"access_token": "***", "n": 1}');
  // corpo cortado no meio continua mascarado
  assert.equal(maskText('{"password":"segredo","itens":[{"a":'), '{"password":"***","itens":[{"a":');
  assert.equal(maskText('http://erp/login?usuario=ana&senha=123&x=1'), 'http://erp/login?usuario=ana&senha=***&x=1');
  assert.equal(maskText('usuario=ana&pwd=123'), 'usuario=ana&pwd=***');
  assert.equal(maskText('<login><senha>123</senha></login>'), '<login><senha>***</senha></login>');
  assert.equal(maskText('{"nome":"sem segredo"}'), '{"nome":"sem segredo"}');
  assert.deepEqual(maskHeaders({ authorization: 'Bearer x', cookie: 'a=1', 'content-type': 'application/json' }),
    { authorization: '***', cookie: '***', 'content-type': 'application/json' });
});

test('NetworkLog: since traz chamadas que terminaram depois, filtros e limite de entradas', () => {
  const log = new NetworkLog({ max: 3 });
  const start = (id, url, extra) => ({ phase: 'start', id, via: 'xhr', method: 'GET', url, ts: 1000, request: {}, ...extra });
  log.add('c1', [start(1, 'http://erp/a'), start(2, 'http://localhost:8100/templates/x.html', { local: true })]);
  const first = log.list();
  assert.deepEqual(first.entries.map((e) => e.url), ['http://erp/a'], 'local escondido por padrão');
  assert.equal(first.entries[0].state, 'pending');

  log.add('c1', [{ phase: 'end', id: 1, ts: 1250, status: 500, response: { body: 'erro' } }]);
  const next = log.list({ since: first.last });
  assert.equal(next.entries.length, 1);
  assert.equal(next.entries[0].ms, 250);
  assert.equal(next.entries[0].status, 500);
  assert.deepEqual(log.list({ failed: true }).entries.map((e) => e.id), [1]);

  log.add('c1', [{ phase: 'end', id: 2, ts: 1100, status: 404 }]);
  assert.equal(log.list().entries.length, 2, 'local que falhou aparece');
  assert.equal(log.list({ local: true }).entries.length, 2);
  assert.equal(log.list({ url: 'ERP/A' }).entries.length, 1);

  log.add('c1', [start(3, 'http://erp/c'), start(4, 'http://erp/d')]);
  assert.throws(() => log.get(1), /não encontrada/);
  assert.equal(log.get(4).url, 'http://erp/d');
  // end de entrada já descartada é ignorado
  log.add('c1', [{ phase: 'end', id: 1, ts: 2000, status: 200 }]);
  assert.equal(log.entries.size, 3);
});

test('formatação: linha com id e status; detalhe com JSON formatado e corte', () => {
  const log = new NetworkLog();
  log.add('c', [
    { phase: 'start', id: 1, via: 'fetch', method: 'POST', url: 'http://erp/p', ts: Date.now(), href: '#/pedido', request: { headers: { 'content-type': 'application/json' }, body: '{"a":1}', size: 7 } },
    { phase: 'end', id: 1, ts: Date.now() + 40, status: 201, statusText: 'Created', response: { body: 'x'.repeat(50), size: 9000, truncated: true } },
  ]);
  const [e] = log.list().entries;
  assert.match(networkLine(e), /^#1 \d\d:\d\d:\d\d POST 201 40 ms http:\/\/erp\/p \[fetch, req 7 B, res 8\.8 KB\]$/);
  const d = networkDetail(log.get(1), { maxBody: 20 });
  assert.match(d, /rota #\/pedido/);
  assert.match(d, /\{\n {2}"a": 1\n\}/);
  assert.match(d, /app enviou só os primeiros 50 de 9000/);
  assert.match(d, /mostrando 20 de 50/);
});

// Backend falso do app: login JSON, erro 500 e uma rota lenta.
function backend() {
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.url === '/api/login') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': 'sessao=abc' });
        return res.end(JSON.stringify({ ok: true, token: 'tok-123', eco: JSON.parse(body || '{}').usuario }));
      }
      if (req.url === '/api/falha') {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        return res.end('quebrou no backend');
      }
      if (req.url === '/api/imagem') {
        res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': '4' });
        return res.end(Buffer.from([1, 2, 3, 4]));
      }
      res.writeHead(404);
      res.end();
    });
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve(srv)));
}

// advanced-http falso no formato do plugin real: post/get chamam sendRequest do objeto público.
function fakeAdvancedHttp() {
  const pub = {
    sendRequest(url, options, success, failure) {
      setTimeout(() => {
        if (options.method === 'post') success({ status: 200, url, data: '{"gravado":true}', headers: { 'content-type': 'application/json' } });
        else failure({ status: -1, url, error: 'host não encontrado' });
      }, 5);
    },
    post(url, data, headers, success, failure) {
      return pub.sendRequest(url, { method: 'post', data, headers }, success, failure);
    },
    get(url, params, headers, success, failure) {
      return pub.sendRequest(url, { method: 'get', params, headers }, success, failure);
    },
  };
  return pub;
}

test('rede: XHR, fetch e advanced-http aparecem na API com máscara; o app não percebe o wrapper', async () => {
  const back = await backend();
  const erp = `http://127.0.0.1:${back.address().port}`;
  const root = makeApp();
  const server = new DevServer(loadConfig({ cwd: root }), { logger: { log() {} } });
  await server.listen();
  const api = new Api(server.port);
  const app = runClient(`http://127.0.0.1:${server.port}`, { globals: { fetch } });
  try {
    await until(() => server.clients.size === 1);
    const { ctx } = app;

    // XHR: os handlers do app continuam sendo chamados, com a resposta intacta.
    const xhrDone = new Promise((resolve) => {
      const x = new ctx.XMLHttpRequest();
      x.open('POST', erp + '/api/login');
      x.setRequestHeader('Authorization', 'Bearer s3cr3t');
      x.setRequestHeader('Content-Type', 'application/json');
      x.onload = () => resolve({ status: x.status, body: x.responseText, isXhr: x instanceof ctx.XMLHttpRequest });
      x.send(JSON.stringify({ usuario: 'ana', senha: '123' }));
    });
    const xhr = await xhrDone;
    assert.equal(xhr.status, 200);
    assert.equal(JSON.parse(xhr.body).token, 'tok-123');
    assert.ok(xhr.isXhr);

    // fetch: o app ainda lê o corpo (o wrapper lê de um clone); erro de rede chega ao app.
    const res = await ctx.fetch(erp + '/api/falha');
    assert.equal(await res.text(), 'quebrou no backend');
    await ctx.fetch(erp + '/api/imagem').then((r) => r.arrayBuffer());
    await assert.rejects(ctx.fetch('http://127.0.0.1:1/fora'));

    // template local por XHR relativo
    const tpl = new ctx.XMLHttpRequest();
    tpl.open('GET', '/templates/home.html');
    tpl.send();

    // advanced-http aparece depois do deviceready (como no Cordova real).
    ctx.cordova = { plugin: { http: fakeAdvancedHttp() } };
    app.fireDeviceReady();
    const httpCalls = [];
    ctx.cordova.plugin.http.post(erp + '/api/sync', { itens: 2 }, { 'X-Api-Key': 'k' }, (r) => httpCalls.push(['ok', r.status]), (r) => httpCalls.push(['falha', r.status]));
    ctx.cordova.plugin.http.get('http://offline/api', {}, {}, () => httpCalls.push(['ok']), (r) => httpCalls.push(['falha', r.status]));

    const all = await until(async () => {
      const r = await api.network({ local: true });
      return r.entries.length === 7 && r.entries.every((e) => e.state !== 'pending') ? r : null;
    });
    assert.deepEqual(httpCalls, [['ok', 200], ['falha', -1]], 'callbacks do app chamados uma vez');

    const by = (path) => all.entries.find((e) => e.url.endsWith(path));
    assert.equal(all.entries.filter((e) => e.url.includes('/__devbridge/')).length, 0, 'canal do devbridge fica de fora');
    assert.equal(all.entries.filter((e) => e.url.endsWith('/api/sync')).length, 1, 'post → sendRequest registrado uma vez');

    const login = await api.networkEntry(by('/api/login').id);
    assert.equal(login.via, 'xhr');
    assert.equal(login.method, 'POST');
    assert.equal(login.status, 200);
    assert.equal(login.request.headers.authorization, '***');
    assert.match(login.request.body, /"senha":"\*\*\*"/);
    assert.match(login.response.body, /"token":"\*\*\*"/);
    assert.match(login.response.body, /"eco":"ana"/);
    assert.equal(login.response.headers['set-cookie'], '***');
    assert.equal(login.href, '#/home');

    const falha = by('/api/falha');
    assert.equal(falha.via, 'fetch');
    assert.equal(falha.status, 500);
    assert.equal((await api.networkEntry(falha.id)).response.body, 'quebrou no backend');
    assert.match((await api.networkEntry(by('/api/imagem').id)).response.body, /^\[image\/png 4 bytes\]$/);
    const fora = by('/fora');
    assert.equal(fora.state, 'error');
    assert.ok(fora.error);

    const sync = await api.networkEntry(by('/api/sync').id);
    assert.equal(sync.via, 'advanced-http');
    assert.equal(sync.method, 'POST');
    assert.equal(sync.request.body, '{"itens":2}');
    assert.equal(sync.request.headers['x-api-key'], '***');
    const offline = by('offline/api');
    assert.equal(offline.state, 'error');
    assert.equal(offline.error, 'host não encontrado');

    // padrão: sem o template local (que deu certo); failed: só as falhas
    const padrao = await api.network({});
    assert.ok(!padrao.entries.some((e) => e.local));
    const falhas = await api.network({ failed: true });
    assert.deepEqual(falhas.entries.map((e) => e.url.replace(erp, '')).sort(), ['/api/falha', 'http://127.0.0.1:1/fora', 'http://offline/api'].sort());

    // since: só o que é novo
    const x2 = new ctx.XMLHttpRequest();
    x2.open('GET', erp + '/api/falha');
    x2.send();
    const novos = await until(async () => {
      const r = await api.network({ since: all.last });
      return r.entries.length && r.entries[r.entries.length - 1].state !== 'pending' ? r : null;
    });
    assert.deepEqual(novos.entries.map((e) => e.url), [erp + '/api/falha']);
  } finally {
    app.close();
    await server.close();
    back.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rede: networkMask false mostra os valores como vieram', async () => {
  const root = makeApp({ networkMask: false });
  const server = new DevServer(loadConfig({ cwd: root }), { logger: { log() {} } });
  await server.listen();
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}/__devbridge/network`, {
      method: 'POST',
      body: JSON.stringify({ client: 'c', events: [{ phase: 'start', id: 1, via: 'xhr', method: 'POST', url: 'http://erp/l?senha=1', ts: 1, request: { headers: { authorization: 'x' }, body: '{"senha":"1"}' } }] }),
    });
    assert.equal(res.status, 200);
    const e = await new Api(server.port).networkEntry(1);
    assert.equal(e.url, 'http://erp/l?senha=1');
    assert.equal(e.request.headers.authorization, 'x');
    assert.equal(e.request.body, '{"senha":"1"}');
    assert.equal((await new Api(server.port).status()).server.networkMask, false);
  } finally {
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
