'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadConfig } = require('../src/config');
const { DevServer } = require('../src/server');
const { Api } = require('../src/api');
const { buildTools } = require('../src/mcp');
const { storageResult } = require('../src/format');
const { makeApp, runClient, until } = require('./helpers');

// NativeStorage falso no formato do plugin: assíncrono, guarda o valor já interpretado, code 2 = não achou.
function fakeNativeStorage(items) {
  const later = (fn) => setTimeout(fn, 2);
  return {
    items,
    keys: (ok) => later(() => ok(Object.keys(items))),
    getItem: (k, ok, err) => later(() => (k in items ? ok(items[k]) : err({ code: 2 }))),
    setItem: (k, v, ok) => later(() => { items[k] = v; ok(v); }),
    remove: (k, ok) => later(() => { delete items[k]; ok(); }),
  };
}

async function setup({ local = {}, session = {}, native } = {}) {
  const root = makeApp();
  const config = loadConfig({ cwd: root });
  const server = new DevServer(config, { logger: { log() {} } });
  await server.listen();
  const app = runClient(`http://127.0.0.1:${server.port}`, { local, storage: session, globals: native ? { NativeStorage: native } : {} });
  await until(() => server.clients.size === 1);
  return { root, config, server, app, api: new Api(server.port) };
}

async function teardown(s) {
  s.app.close();
  await s.server.close();
  fs.rmSync(s.root, { recursive: true, force: true });
}

test('storage: lista, lê JSON, grava e apaga em local/session; chave do devbridge protegida; histórico', async () => {
  const local = { usuario: JSON.stringify({ id: 7, nome: 'Ana', perfis: ['vend'] }), tema: 'escuro', grande: 'x'.repeat(300) };
  const session = { aba: '2' };
  const s = await setup({ local, session });
  // Gravada depois do boot: no boot o client lê e apaga essa chave (reloadRestore).
  session['devbridge.reload'] = '{"hash":"#/x"}';
  try {
    const list = await s.api.storage({ area: 'local' });
    assert.deepEqual(list.items.map((i) => i.key), ['grande', 'tema', 'usuario']);
    assert.equal(list.items[0].size, 300);
    assert.equal(list.items[0].preview.length, 121, '120 caracteres + reticências');

    const user = await s.api.storage({ area: 'local', key: 'usuario' });
    assert.deepEqual(user.json, { id: 7, nome: 'Ana', perfis: ['vend'] });
    const tema = await s.api.storage({ area: 'local', key: 'tema' });
    assert.deepEqual([tema.value, tema.json], ['escuro', undefined]);
    await assert.rejects(s.api.storage({ area: 'local', key: 'nada' }), /não encontrada em local: nada/);

    await s.api.storage({ area: 'local', key: 'tema', action: 'set', value: 'claro' });
    assert.equal(local.tema, 'claro');
    const rm = await s.api.storage({ area: 'local', key: 'grande', action: 'remove' });
    assert.equal(rm.removed, true);
    assert.equal('grande' in local, false);

    const sess = await s.api.storage({ area: 'session' });
    assert.deepEqual(sess.items.map((i) => [i.key, i.internal]), [['aba', false], ['devbridge.reload', true]]);
    await assert.rejects(s.api.storage({ area: 'session', key: 'devbridge.reload', action: 'remove' }), /do próprio devbridge/);
    assert.ok('devbridge.reload' in session);

    await assert.rejects(s.api.storage({ area: 'cookies' }), /Área inválida/);
    await assert.rejects(s.api.storage({ area: 'local', action: 'set', key: 'x' }), /Informe o valor/);

    const hist = fs.readFileSync(path.join(s.config.stateDir, 'storage-history.log'), 'utf8').trim().split('\n');
    assert.equal(hist.length, 3, 'só set/remove, inclusive o recusado');
    assert.match(hist[0], /\tlocal\tset\ttema\tclaro\tok$/);
    assert.match(hist[1], /\tlocal\tremove\tgrande\t\tok$/);
    assert.match(hist[2], /\tsession\tremove\tdevbridge\.reload\t\tERRO .*do próprio devbridge/);
  } finally {
    await teardown(s);
  }
});

test('storage native: assíncrono, valor interpretado, JSON gravado como objeto; sem plugin explica', async () => {
  const native = fakeNativeStorage({ config: { url: 'http://erp', porta: 80 }, versao: 3 });
  const s = await setup({ native });
  try {
    const list = await s.api.storage({ area: 'native' });
    assert.deepEqual(list.items.map((i) => [i.key, i.preview]), [['config', '{"url":"http://erp","porta":80}'], ['versao', '3']]);
    const cfg = await s.api.storage({ area: 'native', key: 'config' });
    assert.deepEqual(cfg.json, { url: 'http://erp', porta: 80 });
    await assert.rejects(s.api.storage({ area: 'native', key: 'nada' }), /não encontrada em native/);
    await s.api.storage({ area: 'native', key: 'flags', action: 'set', value: '{"debug":true}' });
    // gravado dentro do vm: compara por JSON (outro realm, outro Object.prototype)
    assert.deepEqual(JSON.parse(JSON.stringify(native.items.flags)), { debug: true });
    await s.api.storage({ area: 'native', key: 'versao', action: 'remove' });
    assert.equal('versao' in native.items, false);
  } finally {
    await teardown(s);
  }

  const none = await setup();
  try {
    await assert.rejects(none.api.storage({ area: 'native' }), /cordova-plugin-nativestorage/);
  } finally {
    await teardown(none);
  }
});

test('app_storage no MCP e texto do resultado', () => {
  assert.ok(buildTools({ databases: {}, defaultDb: null }).some((t) => t.name === 'app_storage'));
  assert.equal(storageResult({ area: 'session', items: [{ key: 'devbridge.reload', size: 14, preview: '{"hash":"#/x"}', internal: true }] }),
    'devbridge.reload [devbridge] (14) {"hash":"#/x"}\n\n(session: 1 chave(s))');
  assert.equal(storageResult({ area: 'local', key: 'u', size: 9, value: '{"id":7}', json: { id: 7 } }), '{\n  "id": 7\n}\n\n(u · local · 9 caracteres)');
  assert.equal(storageResult({ area: 'local', items: [] }), '(local: vazio)');
  assert.equal(storageResult({ area: 'native', key: 'k', action: 'remove', removed: true }), 'Removido de native: k');
});
