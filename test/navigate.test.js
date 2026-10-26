'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const { loadConfig } = require('../src/config');
const { DevServer } = require('../src/server');
const { Api } = require('../src/api');
const { buildTools } = require('../src/mcp');
const { navigateResult } = require('../src/format');
const { makeApp, runClient, until } = require('./helpers');

async function setup() {
  const root = makeApp();
  const server = new DevServer(loadConfig({ cwd: root }), { logger: { log() {} } });
  await server.listen();
  const app = runClient(`http://127.0.0.1:${server.port}`);
  await until(() => server.clients.size === 1);
  return { root, server, app, api: new Api(server.port) };
}

async function teardown(s) {
  s.app.close();
  await s.server.close();
  fs.rmSync(s.root, { recursive: true, force: true });
}

// Guarda de rota: #/privado sem login vai para #/login, como um $routeChangeStart.
function guardedHash(location) {
  let hash = location.hash;
  Object.defineProperty(location, 'hash', {
    get: () => hash,
    set(v) {
      hash = v;
      if (v === '#/privado') setTimeout(() => { hash = '#/login'; }, 40);
    },
  });
}

test('navegar: rota com e sem #, redirecionamento do app, mesma rota e recusa antes do deviceready', async () => {
  const s = await setup();
  try {
    await assert.rejects(s.api.navigate('/pedidos'), /deviceready/);
    s.app.fireDeviceReady();
    guardedHash(s.app.ctx.location);

    const a = await s.api.navigate('/pedidos/12');
    assert.deepEqual([a.requested, a.hash, a.redirected], ['#/pedidos/12', '#/pedidos/12', false]);

    const b = await s.api.navigate('clientes');
    assert.equal(b.hash, '#/clientes');

    const c = await s.api.navigate('#/privado');
    assert.deepEqual([c.requested, c.hash, c.redirected], ['#/privado', '#/login', true]);

    const same = await s.api.navigate('#/login');
    assert.equal(same.redirected, false);

    await assert.rejects(s.api.navigate('  '), /Informe a rota/);
  } finally {
    await teardown(s);
  }
});

test('navegar: app com hashPrefix "!" mantém o prefixo', async () => {
  const s = await setup();
  try {
    s.app.ctx.location.hash = '#!/inicio';
    s.app.fireDeviceReady();
    const r = await s.api.navigate('/pedidos');
    assert.equal(r.hash, '#!/pedidos');
  } finally {
    await teardown(s);
  }
});

test('app_navigate no MCP e texto do resultado', () => {
  assert.ok(buildTools({ databases: {}, defaultDb: null }).some((t) => t.name === 'app_navigate'));
  assert.equal(navigateResult({ requested: '#/privado', hash: '#/login', href: 'http://x/index.html#/login', redirected: true, ms: 310 }),
    'Rota atual: #/login\nO app redirecionou: o pedido foi #/privado.\n(http://x/index.html#/login · 310 ms)');
  assert.equal(navigateResult({ requested: '#/a', hash: '#/a', href: 'h', redirected: false, ms: 300 }), 'Rota atual: #/a\n(h · 300 ms)');
});
