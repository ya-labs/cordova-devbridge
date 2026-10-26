'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadConfig } = require('../src/config');
const { DevServer } = require('../src/server');
const { Api } = require('../src/api');
const { buildTools } = require('../src/mcp');
const { createSnapshot, restoreSnapshot, listSnapshots } = require('../src/snapshot');
const { snapshotResult } = require('../src/format');
const { makeApp } = require('./helpers');

// Aparelho em memória: a pasta databases/ do app e o registro das operações, na ordem.
function fakeDevice(files) {
  const ops = [];
  const name = (rel) => rel.replace(/^databases\//, '');
  return {
    files,
    ops,
    deps: {
      listDatabases: async () => Object.keys(files),
      readAppFile: async (pkg, rel) => { ops.push(`read ${name(rel)}`); return Buffer.from(files[name(rel)]); },
      writeAppFile: async (pkg, rel, buf) => { ops.push(`write ${name(rel)}`); files[name(rel)] = buf.toString(); },
      removeAppFile: async (pkg, rel) => { ops.push(`rm ${name(rel)}`); delete files[name(rel)]; },
      forceStop: async () => { ops.push('stop'); },
      reopen: async () => { ops.push('open'); return true; },
    },
  };
}

test('snapshot e restore: app parado durante a cópia, WAL de depois apagado, dado volta ao anterior', async () => {
  const root = makeApp();
  const config = loadConfig({ cwd: root });
  const dev = fakeDevice({ 'User_ana.db': 'pedidos=1', 'User_ana.db-journal': 'j1', 'Param.db': 'p1' });
  try {
    const snap = await createSnapshot(config, { name: 'antes-do-pedido' }, dev.deps);
    assert.deepEqual(snap.files.map((f) => f.name), ['User_ana.db', 'User_ana.db-journal', 'Param.db']);
    assert.deepEqual(dev.ops, ['stop', 'read User_ana.db', 'read User_ana.db-journal', 'read Param.db', 'open']);
    assert.equal(fs.readFileSync(path.join(config.stateDir, 'snapshots/antes-do-pedido/User_ana.db'), 'utf8'), 'pedidos=1');

    // depois do snapshot: o app grava e deixa um WAL
    dev.files['User_ana.db'] = 'pedidos=2';
    dev.files['User_ana.db-wal'] = 'wal-novo';
    dev.ops.length = 0;

    const r = await restoreSnapshot(config, { name: 'antes-do-pedido' }, dev.deps);
    assert.deepEqual(r.removed, ['User_ana.db-wal']);
    assert.equal(dev.ops[0], 'stop');
    assert.equal(dev.ops[dev.ops.length - 1], 'open');
    assert.ok(dev.ops.indexOf('rm User_ana.db-wal') < dev.ops.indexOf('write User_ana.db'), 'WAL sai antes de gravar o banco');
    assert.deepEqual(dev.files, { 'User_ana.db': 'pedidos=1', 'User_ana.db-journal': 'j1', 'Param.db': 'p1' });

    const hist = fs.readFileSync(path.join(config.stateDir, 'snapshot-history.log'), 'utf8').trim().split('\n');
    assert.match(hist[0], /\tsnapshot\tantes-do-pedido\tok User_ana\.db,User_ana\.db-journal,Param\.db$/);
    assert.match(hist[1], /\trestore\tantes-do-pedido\tok .* removidos=User_ana\.db-wal$/);
    assert.match(snapshotResult(r), /^Restaurado "antes-do-pedido"/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('snapshot de um banco só (alias com *), nome inválido, outro pacote e lista', async () => {
  const root = makeApp();
  const config = loadConfig({ cwd: root });
  const dev = fakeDevice({ 'User_ana.db': 'u', 'User_ana.db-wal': 'w', 'Param.db': 'p' });
  try {
    const only = await createSnapshot(config, { name: 'so-user', db: 'user' }, dev.deps);
    assert.deepEqual(only.files.map((f) => f.name), ['User_ana.db', 'User_ana.db-wal']);
    const again = await createSnapshot(config, { name: 'so-user', db: 'user' }, dev.deps);
    assert.equal(again.replaced, true);

    await assert.rejects(createSnapshot(config, { name: '../fora' }, dev.deps), /Nome de snapshot inválido/);
    await assert.rejects(createSnapshot(config, { name: 'x', db: 'nao-existe' }, dev.deps), /não existe na config/);
    await assert.rejects(restoreSnapshot(config, { name: 'nunca' }, dev.deps), /não existe/);

    const other = { ...config, package: 'com.outro.app' };
    await assert.rejects(restoreSnapshot(other, { name: 'so-user' }, dev.deps), /é do pacote com\.teste\.app/);

    const list = listSnapshots(config);
    assert.deepEqual(list.map((s) => [s.name, s.files, s.db]), [['so-user', 2, 'user']]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('snapshot pela API e ferramentas do MCP', async () => {
  const root = makeApp();
  const dev = fakeDevice({ 'Param.db': 'p1' });
  const server = new DevServer(loadConfig({ cwd: root }), { logger: { log() {} }, snapshotDeps: dev.deps });
  await server.listen();
  const api = new Api(server.port);
  try {
    await api.snapshot({ name: 'zero' });
    dev.files['Param.db'] = 'p2';
    const r = await api.restore('zero');
    assert.equal(r.reopened, true);
    assert.equal(dev.files['Param.db'], 'p1');
    assert.deepEqual((await api.snapshots()).map((s) => s.name), ['zero']);
    await assert.rejects(api.restore('nunca'), /não existe/);
    const names = buildTools({ databases: {}, defaultDb: null }).map((t) => t.name);
    for (const t of ['db_snapshot', 'db_restore', 'db_snapshots']) assert.ok(names.includes(t), t);
  } finally {
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
