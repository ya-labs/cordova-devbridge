'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const { loadConfig } = require('../src/config');
const { DevServer } = require('../src/server');
const { Api } = require('../src/api');
const { splitSql } = require('../src/sqlguard');
const { sqlBatchResult } = require('../src/format');
const { makeApp, fakeSqlitePlugin, runClient, until } = require('./helpers');

async function setup() {
  const root = makeApp();
  const config = loadConfig({ cwd: root });
  const server = new DevServer(config, { logger: { log() {} } });
  await server.listen();
  const data = { 'User_joao1.db': { CLIENTES: [{ CODIGO: 10, NOME: 'Mercado A' }], PEDIDOS: [] } };
  const plugin = fakeSqlitePlugin(data);
  const app = runClient(`http://127.0.0.1:${server.port}`, { sqlitePlugin: plugin, globals: { db: plugin.makeDb('User_joao1.db') } });
  await until(() => server.clients.size === 1);
  return { root, config, server, app, data, api: new Api(server.port) };
}

async function teardown(s) {
  s.app.close();
  await s.server.close();
  fs.rmSync(s.root, { recursive: true, force: true });
}

test('splitSql: ";" em string, identificador e comentário não separa; trigger vai até o END', () => {
  assert.deepEqual(splitSql('select 1; select 2;'), ['select 1', 'select 2']);
  assert.deepEqual(splitSql("insert into t values ('a;b'); select 'it''s; ok'"), ["insert into t values ('a;b')", "select 'it''s; ok'"]);
  assert.deepEqual(splitSql('select "col;x" from t; -- fim; nada\nselect 3 /* a;b */;'), ['select "col;x" from t', 'select 3 /* a;b */']);
  assert.deepEqual(splitSql('create trigger tg after insert on t begin update t set n = 1; delete from u; end; select 4'),
    ['create trigger tg after insert on t begin update t set n = 1; delete from u; end', 'select 4']);
  assert.deepEqual(splitSql('  ;  -- só comentário\n ; '), []);
});

test('lote: escrita em transação única, resultado por instrução e uma linha no histórico', async () => {
  const s = await setup();
  try {
    const r = await s.api.sql({
      db: 'user',
      write: true,
      statements: [
        { sql: 'insert into CLIENTES (CODIGO, NOME) values (?, ?)', params: [20, 'Mercado B'] },
        { sql: 'insert into PEDIDOS (NUM, CLIENTE) values (?, ?)', params: [1, 20] },
        'update CLIENTES set NOME = ? where rowid = ?',
      ].map((x) => (typeof x === 'string' ? { sql: x, params: ['Mercado A2', 1] } : x)),
    });
    assert.equal(r.results.length, 3);
    assert.deepEqual(r.results.map((x) => x.rowsAffected), [1, 1, 1]);
    assert.equal(r.database, 'db');
    assert.deepEqual(s.data['User_joao1.db'].CLIENTES.map((c) => c.NOME), ['Mercado A2', 'Mercado B']);
    assert.equal(s.data['User_joao1.db'].PEDIDOS.length, 1);
    const hist = fs.readFileSync(path.join(s.config.stateDir, 'sql-history.log'), 'utf8').trim().split('\n');
    assert.equal(hist.length, 1);
    assert.match(hist[0], /\tuser\t\[lote 3\] insert into CLIENTES .*; insert into PEDIDOS .*; update CLIENTES .*\t\[\[20,"Mercado B"\],\[1,20\],\["Mercado A2",1\]\]\tok rowsAffected=1,1,1$/);

    const reads = await s.api.sql({ db: 'user', statements: ['select * from CLIENTES', 'select * from PEDIDOS'] });
    assert.deepEqual(reads.results.map((x) => x.rowCount), [2, 1]);
  } finally {
    await teardown(s);
  }
});

test('lote: falha no meio desfaz tudo e aponta a instrução; escrita em lote de leitura é recusada antes', async () => {
  const s = await setup();
  try {
    await assert.rejects(s.api.sql({
      db: 'user',
      write: true,
      statements: [
        { sql: 'insert into CLIENTES (CODIGO, NOME) values (?, ?)', params: [30, 'C'] },
        { sql: 'insert into NAO_EXISTE (X) values (?)', params: [1] },
        { sql: 'insert into CLIENTES (CODIGO, NOME) values (?, ?)', params: [40, 'D'] },
      ],
    }), /^Error: Instrução 2 de 3: .* \(lote desfeito\)$/);
    assert.deepEqual(s.data['User_joao1.db'].CLIENTES.map((c) => c.CODIGO), [10], 'nada do lote ficou gravado');
    assert.match(fs.readFileSync(path.join(s.config.stateDir, 'sql-history.log'), 'utf8'), /\[lote 3\].*\tERRO Instrução 2 de 3/);

    await assert.rejects(s.api.sql({ db: 'user', statements: ['select 1', 'delete from CLIENTES'] }), /Instrução 2 de 2: Instrução de escrita recusada/);
    assert.equal(s.data['User_joao1.db'].CLIENTES.length, 1);
    await assert.rejects(s.api.sql({ db: 'user', statements: [] }), /ao menos uma/);
  } finally {
    await teardown(s);
  }
});

test('lote pela CLI (--file) e formato do resultado', async () => {
  const s = await setup();
  const cfgFile = path.join(s.root, 'devbridge.config.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(cfgFile, 'utf8')), port: s.server.port }));
  const script = path.join(s.root, 'massa.sql');
  fs.writeFileSync(script, "-- massa de teste\ninsert into CLIENTES (CODIGO, NOME) values (50, 'E; F');\ninsert into CLIENTES (CODIGO, NOME) values (60, 'G');\n");
  try {
    const out = await new Promise((resolve, reject) => execFile(process.execPath, [path.join(__dirname, '../bin/devbridge.js'), 'sql', '--file', script, '--db', 'user', '--write'], { cwd: s.root }, (e, o, err) => (e ? reject(new Error(err)) : resolve(o))));
    assert.match(out, /^-- \[1\] insert into CLIENTES \(CODIGO, NOME\) values \(50, 'E; F'\)\n/);
    assert.match(out, /-- \[2\] insert into CLIENTES \(CODIGO, NOME\) values \(60, 'G'\)/);
    assert.match(out, /\(2 instrução\(ões\) numa transação · banco: db · \d+ ms\)\n$/);
    assert.deepEqual(s.data['User_joao1.db'].CLIENTES.map((c) => c.NOME), ['Mercado A', 'E; F', 'G']);
  } finally {
    await teardown(s);
  }
  assert.equal(sqlBatchResult({ results: [{ columns: ['N'], rows: [{ N: 1 }], rowCount: 1 }], database: 'db', ms: 2 }, [{ sql: 'select 1 as N' }]),
    '-- [1] select 1 as N\nN\n─\n1\n(1 linha(s))\n\n(1 instrução(ões) numa transação · banco: db · 2 ms)');
});
