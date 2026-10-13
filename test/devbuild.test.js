'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');

const { launchIfServerUp, serverUp } = require('../src/devbuild');
const { loadConfig } = require('../src/config');
const { DevServer } = require('../src/server');
const { makeApp } = require('./helpers');

const config = { port: 8100, url: 'http://localhost:8100', package: 'com.teste.app' };

test('build sem servidor no ar: não abre o app e orienta start + launch', async () => {
  const logs = [];
  const opened = [];
  const r = await launchIfServerUp(config, {
    log: (m) => logs.push(m),
    isUp: async () => false,
    restart: async (pkg) => opened.push(pkg),
  });
  assert.equal(r, false);
  assert.deepEqual(opened, []);
  assert.match(logs.join('\n'), /não está rodando em http:\/\/localhost:8100/);
  assert.match(logs.join('\n'), /devbridge start.*devbridge launch/);
});

test('build com servidor no ar: reabre o app do pacote configurado', async () => {
  const opened = [];
  const r = await launchIfServerUp(config, { log() {}, isUp: async () => true, restart: async (pkg) => opened.push(pkg) });
  assert.equal(r, true);
  assert.deepEqual(opened, ['com.teste.app']);
});

test('falha do adb ao reabrir vira aviso, não erro', async () => {
  const logs = [];
  const r = await launchIfServerUp(config, {
    log: (m) => logs.push(m),
    isUp: async () => true,
    restart: async () => { throw new Error('device offline'); },
  });
  assert.equal(r, true);
  assert.match(logs.join('\n'), /não consegui abrir o app: device offline/);
});

test('serverUp: responde com o devbridge no ar e falha com a porta fechada', async () => {
  const root = makeApp();
  const server = new DevServer(loadConfig({ cwd: root }), { logger: { log() {} }, watch: false });
  await server.listen();
  try {
    assert.equal(await serverUp(server.port), true);
  } finally {
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
  // Porta livre garantida: reserva e solta antes de testar.
  const free = await new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
  assert.equal(await serverUp(free, 500), false);
});
