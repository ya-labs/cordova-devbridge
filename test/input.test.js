'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const { loadConfig } = require('../src/config');
const { DevServer } = require('../src/server');
const { Api } = require('../src/api');
const { buildTools } = require('../src/mcp');
const { tapArgs, swipeArgs, textArgs, keyArgs } = require('../src/input');
const { inputResult } = require('../src/format');
const { makeApp, runClient, until } = require('./helpers');

test('argumentos do adb input: coordenadas, escape do texto e teclas', () => {
  assert.deepEqual(tapArgs(10.4, '20'), ['shell', 'input', 'tap', '10', '20']);
  assert.throws(() => tapArgs(-1, 5), /x inválido/);
  assert.throws(() => tapArgs(undefined, 5), /x inválido/);
  assert.deepEqual(swipeArgs(1, 2, 3, 4), ['shell', 'input', 'swipe', '1', '2', '3', '4', '300']);
  assert.equal(swipeArgs(1, 2, 3, 4, 99999)[7], '5000');
  assert.deepEqual(textArgs("pedido 12 & o'k"), ['shell', 'input', 'text', "pedido%s12%s\\&%so\\'k"]);
  assert.deepEqual(textArgs('a(b);c$d'), ['shell', 'input', 'text', 'a\\(b\\)\\;c\\$d']);
  assert.throws(() => textArgs('café'), /só aceita ASCII/);
  assert.throws(() => textArgs('linha\noutra'), /só aceita ASCII/);
  assert.deepEqual(keyArgs('Back'), ['shell', 'input', 'keyevent', '4']);
  assert.deepEqual(keyArgs('enter'), ['shell', 'input', 'keyevent', '66']);
  assert.deepEqual(keyArgs('24'), ['shell', 'input', 'keyevent', '24']);
  assert.deepEqual(keyArgs('keycode_volume_up'), ['shell', 'input', 'keyevent', 'KEYCODE_VOLUME_UP']);
  assert.throws(() => keyArgs('voar'), /Tecla desconhecida/);
});

// Campo focado no WebView, com os eventos que o ng-model escuta.
function fakeInput(attrs) {
  return {
    tagName: 'INPUT', id: 'obs', type: 'text', value: 'Entregar ', selectionStart: 9, selectionEnd: 9, events: [],
    getAttribute: (n) => (n === 'ng-model' ? 'pedido.obs' : null),
    setSelectionRange(a) { this.selectionStart = a; this.selectionEnd = a; },
    dispatchEvent(e) { this.events.push(e.type); },
    ...attrs,
  };
}

test('toque, arrasto, tecla e texto ASCII vão por adb; acento vai pelo campo focado do app', async () => {
  const root = makeApp();
  const calls = [];
  const server = new DevServer(loadConfig({ cwd: root }), { logger: { log() {} }, adbRun: async (args) => { calls.push(args.join(' ')); return ''; } });
  await server.listen();
  const app = runClient(`http://127.0.0.1:${server.port}`);
  app.ctx.document.createEvent = () => ({ initEvent(t) { this.type = t; } });
  const api = new Api(server.port);
  try {
    await until(() => server.clients.size === 1);
    await api.input({ action: 'tap', x: 540, y: 1200 });
    await api.input({ action: 'swipe', x1: 500, y1: 1800, x2: 500, y2: 600, durationMs: 250 });
    await api.input({ action: 'key', key: 'back' });
    const ascii = await api.input({ action: 'text', text: 'Mercado A' });
    assert.equal(ascii.via, 'adb');
    assert.deepEqual(calls, [
      'shell input tap 540 1200',
      'shell input swipe 500 1800 500 600 250',
      'shell input keyevent 4',
      'shell input text Mercado%sA',
    ]);

    await assert.rejects(api.input({ action: 'text', text: 'café' }), /Nenhum campo de texto com foco/);
    const field = fakeInput();
    app.ctx.document.activeElement = field;
    const dom = await api.input({ action: 'text', text: 'às 14h, café' });
    assert.deepEqual([dom.via, dom.field, dom.value], ['dom', 'input#obs[pedido.obs]', 'Entregar às 14h, café']);
    assert.deepEqual(field.events, ['input', 'change']);
    assert.equal(field.selectionStart, 21);

    app.ctx.document.activeElement = fakeInput({ type: 'password', value: '' });
    const pwd = await api.input({ action: 'text', text: 'segredo', via: 'dom' });
    assert.equal(pwd.value, undefined, 'valor de senha não volta');
    assert.equal(calls.length, 4, 'texto por DOM não chama adb');

    await assert.rejects(api.input({ action: 'voar' }), /Ação inválida/);
    await assert.rejects(api.input({ action: 'tap', x: 'a', y: 1 }), /x inválido/);
  } finally {
    app.close();
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('ferramentas de entrada no MCP e texto do resultado', () => {
  const names = buildTools({ databases: {}, defaultDb: null }).map((t) => t.name);
  for (const t of ['app_tap', 'app_swipe', 'app_type', 'app_key']) assert.ok(names.includes(t), t);
  assert.equal(inputResult({ action: 'tap', x: 1, y: 2 }), 'Toque em (1, 2). Confira com app_screenshot.');
  assert.equal(inputResult({ action: 'text', via: 'dom', field: 'input#obs', length: 4, value: 'café' }), 'Texto inserido no campo input#obs pelo app (4 caractere(s)); valor agora: "café".');
});
