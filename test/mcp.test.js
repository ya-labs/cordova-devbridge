'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const readline = require('node:readline');

const { loadConfig } = require('../src/config');
const { DevServer } = require('../src/server');
const { makeApp, fakeSqlitePlugin, runClient, until } = require('./helpers');

test('MCP por stdio: handshake, lista de ferramentas e consulta ao banco', async () => {
  const root = makeApp({ allowWrites: false });
  const server = new DevServer(loadConfig({ cwd: root }), { logger: { log() {} } });
  await server.listen();
  // O processo MCP lê a porta da config: grava a porta real escolhida pelo SO.
  const cfgFile = path.join(root, 'devbridge.config.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(cfgFile, 'utf8')), port: server.port }));

  const plugin = fakeSqlitePlugin({ 'User_x.db': { CLIENTES: [{ CODIGO: 1, NOME: 'A' }] } });
  const app = runClient(`http://127.0.0.1:${server.port}`, { sqlitePlugin: plugin, globals: { db: plugin.makeDb('User_x.db') } });
  await until(() => server.clients.size === 1);

  const child = spawn(process.execPath, [path.join(__dirname, '../bin/devbridge.js'), 'mcp'], { cwd: root, stdio: ['pipe', 'pipe', 'inherit'] });
  const replies = new Map();
  readline.createInterface({ input: child.stdout }).on('line', (l) => {
    const msg = JSON.parse(l);
    replies.set(msg.id, msg);
  });
  let id = 0;
  const rpc = async (method, params) => {
    const my = ++id;
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: my, method, params }) + '\n');
    return until(() => replies.get(my), 5000);
  };

  try {
    const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } });
    assert.equal(init.result.serverInfo.name, 'cordova-devbridge');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

    const list = await rpc('tools/list', {});
    const names = list.result.tools.map((t) => t.name);
    assert.ok(names.includes('db_query'));
    assert.ok(!names.includes('db_exec'), 'db_exec só aparece com allowWrites');

    const q = await rpc('tools/call', { name: 'db_query', arguments: { sql: 'select * from CLIENTES', db: 'user' } });
    assert.match(q.result.content[0].text, /CODIGO │ NOME/);
    assert.ok(!q.result.isError);

    const bad = await rpc('tools/call', { name: 'db_query', arguments: { sql: 'delete from CLIENTES', db: 'user' } });
    assert.equal(bad.result.isError, true);
    assert.match(bad.result.content[0].text, /recusada/);

    const unknown = await rpc('tools/call', { name: 'db_exec', arguments: { sql: 'delete from CLIENTES' } });
    assert.equal(unknown.error.code, -32602);

    const reload = await rpc('tools/call', { name: 'app_reload', arguments: {} });
    assert.match(reload.result.content[0].text, /1 app/);
  } finally {
    child.kill();
    app.close();
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
