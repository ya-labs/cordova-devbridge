'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadConfig } = require('../src/config');
const { DevServer } = require('../src/server');
const { Api } = require('../src/api');
const { CLIENT_TAG } = require('../src/static');
const { makeApp, fakeSqlitePlugin, runClient, until, wait } = require('./helpers');

const silent = { log() {} };

async function setup({ allowWrites = false, globals, listDatabases, extraConfig } = {}) {
  const root = makeApp({ allowWrites, ...extraConfig });
  const config = loadConfig({ cwd: root });
  const server = new DevServer(config, { logger: silent, listDatabases: listDatabases || (async () => []) });
  await server.listen();
  const base = `http://127.0.0.1:${server.port}`;
  const data = {
    'Param.db': { parametros: [{ CHAVE: 'URLE', VALOR: 'http://erp' }] },
    'User_joao1.db': { CLIENTES: [{ CODIGO: 10, NOME: 'Mercado A' }, { CODIGO: 20, NOME: 'Mercado B' }] },
  };
  const plugin = fakeSqlitePlugin(data);
  const appGlobals = typeof globals === 'function' ? globals(plugin) : globals;
  const app = runClient(base, { sqlitePlugin: plugin, globals: appGlobals });
  await until(() => server.clients.size === 1);
  return { root, config, server, base, api: new Api(server.port), app, plugin, data };
}

async function teardown(s) {
  s.app.close();
  await s.server.close();
  fs.rmSync(s.root, { recursive: true, force: true });
}

test('serve index com client injetado; templates e platform_www intactos', async () => {
  const s = await setup();
  try {
    const index = await (await fetch(s.base + '/')).text();
    assert.ok(index.includes(CLIENT_TAG));
    const tpl = await (await fetch(s.base + '/templates/home.html')).text();
    assert.equal(tpl, '<div>home</div>');
    const cordova = await fetch(s.base + '/cordova.js');
    assert.equal(cordova.headers.get('content-type'), 'text/javascript; charset=utf-8');
    assert.equal(await cordova.text(), '// cordova');
    assert.equal((await fetch(s.base + '/__devbridge/client.js')).status, 200);
    assert.equal((await fetch(s.base + '/nada.js')).status, 404);

    const desktop = { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) Chrome/140' };
    const redir = await fetch(s.base + '/', { headers: desktop, redirect: 'manual' });
    assert.equal(redir.status, 302);
    assert.equal(redir.headers.get('location'), '/__devbridge/');
    assert.equal((await fetch(s.base + '/index.html', { headers: desktop, redirect: 'manual' })).status, 302);
    assert.ok((await (await fetch(s.base + '/?app', { headers: desktop })).text()).includes(CLIENT_TAG));
    const webview = { 'User-Agent': 'Mozilla/5.0 (Linux; Android 15; wv) Chrome/156' };
    assert.ok((await (await fetch(s.base + '/index.html', { headers: webview })).text()).includes(CLIENT_TAG));
  } finally {
    await teardown(s);
  }
});

test('API exige X-Devbridge (barra CSRF de outra página)', async () => {
  const s = await setup();
  try {
    const res = await fetch(s.base + '/__devbridge/api/sql', { method: 'POST', body: '{"sql":"select 1"}' });
    assert.equal(res.status, 403);
  } finally {
    await teardown(s);
  }
});

test('SQL de leitura usa a conexão global aberta pelo app', async () => {
  const s = await setup({ globals: (plugin) => ({ db: plugin.makeDb('User_joao1.db') }) });
  try {
    const r = await s.api.sql({ sql: 'select * from CLIENTES', db: 'user' });
    assert.deepEqual(r.columns, ['CODIGO', 'NOME']);
    assert.equal(r.rowCount, 2);
    assert.equal(r.database, 'db');
    assert.deepEqual(s.plugin.opened, []);
  } finally {
    await teardown(s);
  }
});

test('sem global aberta: abre pelo nome, ou resolve o padrão via adb', async () => {
  const s = await setup({ listDatabases: async () => ['Param.db', 'User_joao1.db', 'User_joao1.db-journal'] });
  try {
    s.app.fireDeviceReady();
    const par = await s.api.sql({ sql: 'select * from parametros', db: 'par' });
    assert.equal(par.rows[0].VALOR, 'http://erp');
    const user = await s.api.sql({ sql: 'select * from CLIENTES', db: 'user' });
    assert.equal(user.database, 'User_joao1.db');
    assert.deepEqual(s.plugin.opened, ['Param.db', 'User_joao1.db']);
  } finally {
    await teardown(s);
  }
});

test('padrão ambíguo pede --db explícito', async () => {
  const s = await setup({ listDatabases: async () => ['User_a.db', 'User_b.db'] });
  try {
    await assert.rejects(s.api.sql({ sql: 'select * from CLIENTES', db: 'user' }), /vários bancos/);
  } finally {
    await teardown(s);
  }
});

test('escrita: recusada sem flag, sem allowWrites, e liberada com os dois (com histórico)', async () => {
  const off = await setup({ globals: (p) => ({ db: p.makeDb('User_joao1.db') }) });
  try {
    await assert.rejects(off.api.sql({ sql: 'delete from CLIENTES', db: 'user' }), /recusada/);
    await assert.rejects(off.api.sql({ sql: 'delete from CLIENTES', db: 'user', write: true }), /allowWrites/);
  } finally {
    await teardown(off);
  }

  const on = await setup({ allowWrites: true, globals: (p) => ({ db: p.makeDb('User_joao1.db') }) });
  try {
    const r = await on.api.sql({ sql: 'update CLIENTES set NOME = ? where rowid = ?', params: ['Novo', 2], db: 'user', write: true });
    assert.equal(r.rowsAffected, 1);
    assert.equal(on.data['User_joao1.db'].CLIENTES[1].NOME, 'Novo');
    const hist = fs.readFileSync(path.join(on.config.stateDir, 'sql-history.log'), 'utf8');
    assert.match(hist, /\tuser\tupdate CLIENTES set NOME = \? where rowid = \?\t\["Novo",2\]\tok rowsAffected=1\n$/);
  } finally {
    await teardown(on);
  }
});

test('readTransaction barra escrita mesmo se o filtro do servidor falhasse', async () => {
  const s = await setup({ globals: (p) => ({ db: p.makeDb('User_joao1.db') }) });
  try {
    // Fala direto com o app, pulando a checagem do servidor.
    await assert.rejects(
      s.server.request('sql', { sql: 'delete from CLIENTES', params: [], write: false, db: { global: 'db', name: null } }),
      /read-only/,
    );
    assert.equal(s.data['User_joao1.db'].CLIENTES.length, 2);
  } finally {
    await teardown(s);
  }
});

test('tables e schema', async () => {
  const s = await setup({ globals: (p) => ({ db: p.makeDb('User_joao1.db') }) });
  try {
    const t = await s.api.tables('user');
    assert.deepEqual(t.rows.map((r) => r.name), ['CLIENTES']);
    const sc = await s.api.schema('user', 'CLIENTES');
    assert.deepEqual(sc.columns.map((c) => c.name), ['CODIGO', 'NOME']);
    await assert.rejects(s.api.schema('user', 'x; drop'), /inválido/);
  } finally {
    await teardown(s);
  }
});

test('logs do app chegam ao servidor (console e erro não tratado)', async () => {
  const s = await setup();
  try {
    s.app.ctx.console.log('carregou', { tela: 'home' });
    s.app.fireError({ message: 'x is not defined', filename: s.base + '/js/app.js', lineno: 3, colno: 7 });
    const r = await until(async () => {
      const l = await s.api.logs({ since: 0 });
      return l.entries.length >= 2 && l;
    });
    assert.equal(r.entries[0].msg, 'carregou {"tela":"home"}');
    assert.match(r.entries[1].msg, /x is not defined em \(\/js\/app.js:3:7\)/);
    assert.equal(s.app.calls.logs[0][0], 'log');
    const errs = await s.api.logs({ since: 0, level: 'error' });
    assert.equal(errs.entries.length, 1);
  } finally {
    await teardown(s);
  }
});

test('salvar JS recarrega; salvar CSS só troca o <link>', async () => {
  const s = await setup();
  try {
    fs.writeFileSync(path.join(s.config.wwwDir, 'css/app.css'), 'body{color:red}');
    await until(() => s.app.links[0].href.includes('devbridge='));
    assert.equal(s.app.calls.reload, 0);

    fs.writeFileSync(path.join(s.config.wwwDir, 'templates/home.html'), '<div>novo</div>');
    await until(() => s.app.calls.reload === 1);

    await s.api.reload();
    await until(() => s.app.calls.reload === 2);
    assert.deepEqual(s.app.calls.hrefsOnReload, [s.base + '/index.html#/home', s.base + '/index.html#/home']);
  } finally {
    await teardown(s);
  }
});

test('reloadKeepRoute false: reload volta à rota inicial (sem hash)', async () => {
  const s = await setup({ extraConfig: { reloadKeepRoute: false } });
  try {
    assert.equal((await s.api.status()).server.reloadKeepRoute, false);
    fs.writeFileSync(path.join(s.config.wwwDir, 'templates/home.html'), '<div>novo</div>');
    await until(() => s.app.calls.reload === 1);
    assert.deepEqual(s.app.calls.hrefsOnReload, [s.base + '/index.html']);
    assert.equal(s.app.ctx.location.hash, '');
  } finally {
    await teardown(s);
  }
});

test('status consulta o app; sem app conectado a API explica o motivo', async () => {
  const s = await setup({ globals: (p) => ({ db: p.makeDb('User_joao1.db') }) });
  try {
    const st = await s.api.status();
    assert.equal(st.app.globals.db, true);
    assert.equal(st.app.globals.dbconfig, false);
    s.app.close();
    await until(() => s.server.clients.size === 0);
    await assert.rejects(s.api.sql({ sql: 'select 1', db: 'user' }), /Nenhum app conectado/);
    await wait(10);
  } finally {
    await teardown(s);
  }
});

test('aba do PC conectada depois não rouba o app que já disparou deviceready', async () => {
  const s = await setup({ globals: (p) => ({ db: p.makeDb('User_joao1.db') }) });
  const browser = runClient(s.base, { sqlitePlugin: undefined });
  try {
    s.app.fireDeviceReady();
    await until(() => s.server.readyClients.size === 1);
    await until(() => s.server.clients.size === 2);
    const st = await s.api.status();
    assert.equal(st.server.clients, 2);
    assert.equal(st.app.globals.db, true);
    const r = await s.api.sql({ sql: 'select * from CLIENTES', db: 'user' });
    assert.equal(r.rows.length, 2);
  } finally {
    browser.close();
    await teardown(s);
  }
});

test('console: INSERT e DELETE por rowid que a grade envia passam só com escrita', async () => {
  const s = await setup({ allowWrites: true, globals: (p) => ({ db: p.makeDb('User_joao1.db') }) });
  try {
    const ins = 'INSERT INTO "CLIENTES" ("CODIGO", "NOME") VALUES (?, ?)';
    await assert.rejects(s.api.sql({ sql: ins, params: ['30', 'Mercado C'], db: 'user' }), /recusada/);
    await s.api.sql({ sql: ins, params: ['30', 'Mercado C'], db: 'user', write: true });
    await s.api.sql({ sql: 'INSERT INTO "CLIENTES" DEFAULT VALUES', db: 'user', write: true });
    let rows = s.data['User_joao1.db'].CLIENTES;
    assert.equal(rows.length, 4);
    assert.deepEqual(rows[2], { CODIGO: '30', NOME: 'Mercado C' });

    const del = 'DELETE FROM "CLIENTES" WHERE rowid = ?';
    await assert.rejects(s.api.sql({ sql: del, params: [1], db: 'user' }), /recusada/);
    const r = await s.api.sql({ sql: del, params: [1], db: 'user', write: true });
    assert.equal(r.rowsAffected, 1);
    rows = s.data['User_joao1.db'].CLIENTES;
    assert.equal(rows.length, 3);
    assert.equal(rows[0].NOME, 'Mercado B');

    const hist = fs.readFileSync(path.join(s.config.stateDir, 'sql-history.log'), 'utf8');
    assert.match(hist, /INSERT INTO "CLIENTES" DEFAULT VALUES/);
    assert.match(hist, /DELETE FROM "CLIENTES" WHERE rowid = \?\t\[1\]/);
  } finally {
    await teardown(s);
  }
});
