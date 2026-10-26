'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const readline = require('node:readline');

const { loadConfig } = require('../src/config');
const { DevServer } = require('../src/server');
const { Api } = require('../src/api');
const { buildTools } = require('../src/mcp');
const { evalResult } = require('../src/format');
const { makeApp, runClient, until } = require('./helpers');

async function setup(extraConfig, globals) {
  const root = makeApp(extraConfig);
  const config = loadConfig({ cwd: root });
  const server = new DevServer(config, { logger: { log() {} } });
  await server.listen();
  const app = runClient(`http://127.0.0.1:${server.port}`, { globals });
  await until(() => server.clients.size === 1);
  return { root, config, server, app, api: new Api(server.port) };
}

async function teardown(s) {
  s.app.close();
  await s.server.close();
  fs.rmSync(s.root, { recursive: true, force: true });
}

test('eval: valor, promessa, erro, objeto circular e serviço do app; tudo no histórico', async () => {
  // Serviço no formato do injector do AngularJS.
  const services = { Pedidos: { abertos: () => [{ id: 7, total: 10.5 }] } };
  const s = await setup({}, { angular: { injector: () => ({ get: (n) => services[n] }) } });
  try {
    const hash = await s.api.evaluate({ expression: 'location.hash' });
    assert.deepEqual([hash.value, hash.type, hash.awaited], ['#/home', 'string', false]);

    const svc = await s.api.evaluate({ expression: "angular.injector().get('Pedidos').abertos()" });
    assert.deepEqual(svc.value, [{ id: 7, total: 10.5 }]);
    assert.equal(svc.type, 'array');

    const block = await s.api.evaluate({ expression: 'var x = 20;\nx + 1' });
    assert.equal(block.value, 21);

    const prom = await s.api.evaluate({ expression: 'Promise.resolve({ ok: true })' });
    assert.deepEqual([prom.value, prom.awaited], [{ ok: true }, true]);

    const circ = await s.api.evaluate({ expression: '(function () { var o = { f: function soma() {} }; o.eu = o; return o; })()' });
    assert.deepEqual(circ.value, { f: { __dvb: 'ƒ soma()' }, eu: { __dvb: '[circular]' } });

    const undef = await s.api.evaluate({ expression: 'void 0' });
    assert.deepEqual([undef.value, undef.type], [{ __dvb: 'undefined' }, 'undefined']);

    await assert.rejects(s.api.evaluate({ expression: 'naoExiste.campo' }), (err) => {
      assert.match(err.message, /^ReferenceError: naoExiste is not defined/);
      assert.doesNotMatch(err.message, /^\s*at runEval\b/m, 'frames do client cortados');
      return true;
    });
    await assert.rejects(s.api.evaluate({ expression: 'Promise.reject(new TypeError("falhou"))' }), /TypeError: falhou/);
    await assert.rejects(s.api.evaluate({ expression: 'Promise.reject("texto")' }), /Rejeitada com: texto/);
    await assert.rejects(s.api.evaluate({ expression: 'new Promise(function () {})', timeoutMs: 150 }), /não resolveu em 0\.15 s/);
    await assert.rejects(s.api.evaluate({ expression: '   ' }), /vazia/);

    const hist = fs.readFileSync(path.join(s.config.stateDir, 'eval-history.log'), 'utf8').trim().split('\n');
    assert.equal(hist.length, 10, 'a expressão vazia não chega ao app nem ao histórico');
    assert.match(hist[0], /\tlocation\.hash\tok string$/);
    assert.match(hist[2], /\tvar x = 20; x \+ 1\tok number$/);
    assert.match(hist[6], /\tnaoExiste\.campo\tERRO ReferenceError: naoExiste is not defined$/);
  } finally {
    await teardown(s);
  }
});

test('app_eval e db_exec sempre na lista do MCP, sem opção na config; formato do resultado', () => {
  const names = buildTools({ databases: {}, defaultDb: null }).map((t) => t.name);
  assert.ok(names.includes('app_eval'));
  assert.ok(names.includes('db_exec'));

  assert.equal(evalResult({ value: { a: [1, { __dvb: 'ƒ f()' }] }, type: 'object', ms: 3, awaited: true }),
    '{\n  "a": [\n    1,\n    "ƒ f()"\n  ]\n}\n\n(tipo: object · 3 ms · promessa resolvida)');
  assert.equal(evalResult({ value: { __dvb: 'undefined' }, type: 'undefined', ms: 1 }), 'undefined\n\n(tipo: undefined · 1 ms)');
  assert.equal(evalResult({ value: 'abc', type: 'string', ms: 1 }), '"abc"\n\n(tipo: string · 1 ms)');
  assert.match(evalResult({ value: 'x'.repeat(50), type: 'string', ms: 1 }, { max: 10 }), /^"xxxxxxxxx\n\[mostrando 10 de 52 caracteres\]/);
});

test('MCP por stdio: app_eval devolve o valor e o erro do app', async () => {
  const s = await setup({});
  const cfgFile = path.join(s.root, 'devbridge.config.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(cfgFile, 'utf8')), port: s.server.port }));
  const child = spawn(process.execPath, [path.join(__dirname, '../bin/devbridge.js'), 'mcp'], { cwd: s.root, stdio: ['pipe', 'pipe', 'inherit'] });
  const replies = new Map();
  readline.createInterface({ input: child.stdout }).on('line', (l) => {
    const msg = JSON.parse(l);
    replies.set(msg.id, msg);
  });
  let id = 0;
  const rpc = (method, params) => {
    const my = ++id;
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: my, method, params }) + '\n');
    return until(() => replies.get(my), 5000);
  };
  try {
    await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } });
    const list = await rpc('tools/list', {});
    assert.ok(list.result.tools.some((t) => t.name === 'app_eval'));
    const ok = await rpc('tools/call', { name: 'app_eval', arguments: { expression: '({ rota: location.hash, n: 1 + 1 })' } });
    assert.equal(ok.result.content[0].text, '{\n  "rota": "#/home",\n  "n": 2\n}\n\n' + ok.result.content[0].text.split('\n\n')[1]);
    assert.match(ok.result.content[0].text, /\(tipo: object · \d+ ms\)$/);
    const bad = await rpc('tools/call', { name: 'app_eval', arguments: { expression: 'throw new Error("quebrou")' } });
    assert.equal(bad.result.isError, true);
    assert.match(bad.result.content[0].text, /Error: quebrou/);
  } finally {
    child.kill();
    await teardown(s);
  }
});
