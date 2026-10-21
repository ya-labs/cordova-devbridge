'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { isReadOnly, checkSql } = require('../src/sqlguard');
const { resolveFile, injectClient, withSourceMap, ignoreListMap, CLIENT_TAG } = require('../src/static');
const { patchConfigXml } = require('../src/devbuild');
const { loadConfig, resolveDatabase } = require('../src/config');
const { globToRegExp } = require('../src/server');
const { table } = require('../src/format');

test('sqlguard: leitura aceita', () => {
  for (const sql of [
    'select * from CLIENTES',
    '  SELECT 1;',
    "select 'delete from x' as txt",
    '-- comentário\nselect count(*) from VISFEITA',
    'with t as (select 1) select * from t',
    'pragma table_info(CLIENTES)',
    'PRAGMA user_version',
    'explain query plan select * from CLIENTES where CODIGO = 1',
  ]) assert.ok(isReadOnly(sql), sql);
});

test('sqlguard: escrita recusada sem --write', () => {
  for (const sql of [
    'update CLIENTES set NOME = 1',
    'delete from CLIENTES',
    'insert into x values (1)',
    'drop table x',
    'with t as (select 1) delete from x',
    'pragma user_version = 3',
    'pragma journal_mode(WAL)',
    'vacuum',
    'attach database "x" as y',
  ]) {
    assert.equal(isReadOnly(sql), false, sql);
    assert.match(checkSql(sql, { write: false }), /recusada/, sql);
    assert.equal(checkSql(sql, { write: true }), null, sql);
  }
});

test('sqlguard: uma instrução por vez', () => {
  assert.match(checkSql('select 1; delete from x', { write: true }), /uma instrução/);
  assert.equal(checkSql("select 'a;b'", { write: false }), null);
  assert.match(checkSql('  ', { write: false }), /vazio/);
});

test('static: platform_www tem prioridade por arquivo e www completa', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'devbridge-static-'));
  const pw = path.join(tmp, 'pw');
  const www = path.join(tmp, 'www');
  fs.mkdirSync(path.join(pw, 'plugins/cordova-plugin-advanced-http/www'), { recursive: true });
  fs.mkdirSync(path.join(www, 'plugins/cordova-plugin-advanced-http'), { recursive: true });
  fs.writeFileSync(path.join(pw, 'cordova.js'), 'cordova');
  fs.writeFileSync(path.join(pw, 'plugins/cordova-plugin-advanced-http/www/public.js'), 'plugin');
  fs.writeFileSync(path.join(www, 'plugins/cordova-plugin-advanced-http/vendor.js'), 'vendor');
  fs.writeFileSync(path.join(www, 'index.html'), '<html>');
  fs.writeFileSync(path.join(tmp, 'secret.txt'), 'x');

  const roots = [pw, www];
  assert.equal(resolveFile(roots, '/cordova.js'), path.join(pw, 'cordova.js'));
  assert.equal(resolveFile(roots, '/plugins/cordova-plugin-advanced-http/www/public.js'), path.join(pw, 'plugins/cordova-plugin-advanced-http/www/public.js'));
  assert.equal(resolveFile(roots, '/plugins/cordova-plugin-advanced-http/vendor.js'), path.join(www, 'plugins/cordova-plugin-advanced-http/vendor.js'));
  assert.equal(resolveFile(roots, '/'), path.join(www, 'index.html'));
  assert.equal(resolveFile(roots, '/index.html?x=1'), path.join(www, 'index.html'));
  assert.equal(resolveFile(roots, '/../secret.txt'), null);
  assert.equal(resolveFile(roots, '/%2e%2e/secret.txt'), null);
  assert.equal(resolveFile(roots, '/nao-existe.js'), null);
});

test('static: client entra no início do <head>, uma vez só', () => {
  const html = '<!doctype html><html><head lang="pt"><meta charset="utf-8"></head><body></body></html>';
  const out = injectClient(html);
  assert.ok(out.indexOf(CLIENT_TAG) > out.indexOf('<head lang="pt">'));
  assert.ok(out.indexOf(CLIENT_TAG) < out.indexOf('<meta'));
  assert.equal(injectClient(out), out);
});

test('devbuild: patch troca content src e libera navegação só para o servidor', () => {
  const xml = '<?xml version="1.0"?>\n<widget id="x">\n    <content src="index.html" />\n    <access origin="*" />\n</widget>\n';
  const out = patchConfigXml(xml, 'http://localhost:8100');
  assert.match(out, /<content src="http:\/\/localhost:8100\/index.html" \/>/);
  assert.match(out, /<allow-navigation href="http:\/\/localhost:8100\/\*" \/>\n<\/widget>/);
  assert.equal(patchConfigXml(out, 'http://localhost:8100'), out);
  assert.throws(() => patchConfigXml('<widget></widget>', 'http://x'), /content src/);
});

test('config: carrega, normaliza bancos e resolve --db', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'devbridge-cfg-'));
  fs.mkdirSync(path.join(tmp, 'www/js'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'devbridge.config.json'), JSON.stringify({
    package: 'com.x', databases: { par: 'Param.db', user: { global: 'db', name: 'User_*.db' } },
  }));
  const cfg = loadConfig({ cwd: path.join(tmp, 'www/js') });
  assert.equal(cfg.root, tmp);
  assert.equal(cfg.port, 8100);
  assert.equal(cfg.defaultDb, 'par');
  assert.deepEqual(resolveDatabase(cfg, 'par'), { alias: 'par', name: 'Param.db', global: null });
  assert.deepEqual(resolveDatabase(cfg, 'user'), { alias: 'user', name: 'User_*.db', global: 'db' });
  assert.deepEqual(resolveDatabase(cfg, 'Outro.db'), { alias: 'Outro.db', name: 'Outro.db', global: null });
  assert.throws(() => resolveDatabase(cfg, 'xyz'), /não existe/);
  assert.throws(() => loadConfig({ cwd: os.tmpdir() + '/__nada__' }), /não encontrado/);
});

test('glob de banco e tabela do terminal', () => {
  const re = globToRegExp('MeuApp_*.db');
  assert.ok(re.test('MeuApp_joao1.db'));
  assert.ok(!re.test('MeuApp_joao1.db-journal'));
  assert.ok(!re.test('MeuAppConfig.db'));
  const out = table(['a', 'b'], [{ a: 1, b: null }, { a: 'xyz', b: 'ok' }]);
  assert.match(out, /^a   │ b {3}\n/);
  assert.match(out, /NULL/);
});

test('client na ignore list: map de identidade e referência no fim do arquivo', () => {
  const src = 'var a;\n\nconsole.log(a);\n';
  const map = ignoreListMap(src, 'devbridge-client.js');
  assert.equal(map.mappings, 'AAAA;AACA;AACA;AACA');
  assert.deepEqual(map.x_google_ignoreList, [0]);
  assert.deepEqual(map.ignoreList, [0]);
  assert.deepEqual(map.sourcesContent, [src]);
  assert.equal(withSourceMap(src), src + '//# sourceMappingURL=/__devbridge/client.js.map\n');
  assert.equal(withSourceMap('x'), 'x\n//# sourceMappingURL=/__devbridge/client.js.map\n');
});
