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
const { testsStatus, testStep, testsList, testRuns } = require('../src/format');
const { makeApp, runClient, until, wait } = require('./helpers');

const SECRET = 'SEGREDO-ERRADO';

// Teste do app no formato de .devbridge/tests: roda dentro do client (vm).
const FLUXO = `(function () {
  window.__devbridgeRunner.registrar({
    nome: 'fluxo',
    descricao: 'login e sincronização de mentira',
    antes: function (ctx) { ctx.dados.antes = true; },
    depois: function (ctx) { ctx.publico.depois = true; },
    analisarResposta: function (r) { return r.status >= 400 ? 'login recusado pelo servidor: ' + r.url : null; },
    etapas: [
      { nome: 'Login', tempoLimiteMs: 3000, executar: function (ctx) {
        localStorage.setItem('sessao', ctx.caso.usuario);
        criarBanco('User_' + ctx.caso.usuario + '.db');
        ctx.progresso('logando');
        console.log('login de ' + ctx.caso.usuario);
        if (ctx.caso.senha === 'certa') {
          ctx.publico.usuario = ctx.caso.usuario;
          return 'logado';
        }
        console.error('senha recusada');
        return new Promise(function (resolve, reject) {
          var x = new XMLHttpRequest();
          x.open('POST', '/api/login');
          x.onloadend = function () { reject(new Error('Senha inválida')); };
          x.send('{"usuario":"' + ctx.caso.usuario + '"}');
        });
      } },
      { nome: 'Sincronizar', tempoLimiteMs: 3000, executar: function (ctx) {
        return new Promise(function (resolve) {
          NativeStorage.setItem('ultimaSinc', { quando: 1 }, function () { resolve('sincronizado'); });
        });
      } },
      { nome: 'Esperar', tempoLimiteMs: 200, executar: function (ctx) {
        if (ctx.caso.lento) return ctx.dormir(2000);
        if (ctx.caso.esperarParaSempre) return ctx.esperar(function () { return false; }, 10000, 'nada');
        return 'rápido';
      } },
    ],
  });
})();`;

function fakeNativeStorage(items) {
  const later = (fn) => setTimeout(fn, 1);
  return {
    items,
    keys: (ok) => later(() => ok(Object.keys(items))),
    getItem: (k, ok, err) => later(() => (k in items ? ok(items[k]) : err({ code: 2 }))),
    setItem: (k, v, ok) => later(() => { items[k] = v; ok(v); }),
    remove: (k, ok) => later(() => { delete items[k]; ok(); }),
  };
}

// Aparelho em memória: bancos, localStorage e NativeStorage sobrevivem ao app,
// que é fechado e reaberto (novo client no vm) pelo snapshot e pelo restore.
async function setup(cases) {
  const root = makeApp();
  const dir = path.join(root, '.devbridge/tests');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'fluxo.test.js'), FLUXO);
  if (cases) fs.writeFileSync(path.join(dir, 'casos.local.json'), JSON.stringify({ casos: cases }));
  const config = loadConfig({ cwd: root });
  const device = { files: { 'Param.db': 'p0' }, local: { tema: 'escuro' }, native: { inicial: { a: 1 } }, app: null, boots: 0 };
  const lines = [];
  const server = new DevServer(config, {
    logger: { log: (l) => lines.push(l) },
    tests: { pollMs: 20, readyTimeoutMs: 3000, appLostMs: 500, caseMarginMs: 3000 },
    snapshotDeps: {
      listDatabases: async () => Object.keys(device.files),
      readAppFile: async (pkg, rel) => Buffer.from(device.files[rel.replace(/^databases\//, '')]),
      writeAppFile: async (pkg, rel, buf) => { device.files[rel.replace(/^databases\//, '')] = buf.toString(); },
      removeAppFile: async (pkg, rel) => { delete device.files[rel.replace(/^databases\//, '')]; },
      forceStop: async () => { if (device.app) device.app.close(); device.app = null; },
      reopen: async () => { await boot(); return true; },
    },
  });
  await server.listen();
  const base = `http://127.0.0.1:${server.port}`;
  async function boot() {
    device.boots++;
    device.app = runClient(base, {
      local: device.local,
      globals: { NativeStorage: fakeNativeStorage(device.native), criarBanco: (n) => { device.files[n] = 'novo'; } },
    });
    await wait(20);
    device.app.fireDeviceReady();
  }
  await boot();
  await until(() => server.readySince(0));
  return { root, config, server, device, lines, api: new Api(server.port) };
}

async function teardown(s) {
  if (s.device.app) s.device.app.close();
  await s.server.close();
  fs.rmSync(s.root, { recursive: true, force: true });
}

const CASES = [
  { nome: 'Ana', usuario: 'ana', senha: 'certa' },
  { nome: 'Bia', usuario: 'bia', senha: SECRET },
  { nome: 'Lenta', usuario: 'cid', senha: 'certa', lento: true },
];

test('rodada: casos em sequência, falha, tempo limite, pulada, relatório e aparelho restaurado', async () => {
  const s = await setup(CASES);
  try {
    const list = await s.api.tests();
    assert.equal(list.testes.length, 1);
    assert.deepEqual(list.testes[0].casos, ['Ana', 'Bia', 'Lenta']);
    assert.deepEqual(list.testes[0].etapas.map((e) => e.nome), ['Login', 'Sincronizar', 'Esperar']);
    assert.equal(list.testes[0].analisaRespostas, true);
    assert.match(testsList(list), /casos \(\.devbridge\/tests\/casos\.local\.json\): Ana, Bia, Lenta/);

    const started = await s.api.testRun({ test: 'fluxo' });
    assert.ok(started.id);
    assert.equal(JSON.stringify(started).includes(SECRET), false, 'o caso não sai do app');
    await assert.rejects(s.api.testRun({ test: 'fluxo' }), /Já existe uma rodada em andamento/);

    const run = await s.api.testStatus({ waitMs: 20000 });
    assert.ok(run.fim, 'rodada terminou');
    const [ana, bia, lenta] = run.casos;

    assert.equal(ana.situacao, 'ok');
    assert.deepEqual(ana.testes[0].etapas.map((e) => e.situacao), ['ok', 'ok', 'ok']);
    assert.equal(ana.testes[0].etapas[0].detalhe, 'logado');
    assert.deepEqual(ana.dados, { usuario: 'ana', depois: true });

    assert.equal(bia.situacao, 'falha');
    assert.deepEqual(bia.testes[0].etapas.map((e) => e.situacao), ['falha', 'pulada', 'pulada']);
    assert.equal(bia.testes[0].etapas[0].erro, 'Senha inválida');
    assert.deepEqual(bia.errosNoLog.map((e) => [e.msg, e.etapa]), [['senha recusada', 1]]);
    assert.equal(bia.requisicoesComFalha.length, 1);
    assert.match(bia.requisicoesComFalha[0].url, /\/api\/login$/);
    assert.equal(bia.requisicoesComFalha[0].status, 405);
    assert.equal(bia.respostasComErro.length, 1);
    assert.match(bia.respostasComErro[0].achado, /login recusado pelo servidor/);

    assert.equal(lenta.situacao, 'falha');
    assert.deepEqual(lenta.testes[0].etapas.map((e) => e.situacao), ['ok', 'ok', 'falha']);
    assert.equal(lenta.testes[0].etapas[2].erro, 'Etapa "Esperar" passou do tempo limite de 200 ms.');

    assert.equal(run.situacao, 'falha');
    assert.equal(run.restauracao.ok, true, JSON.stringify(run.restauracao));
    assert.deepEqual(run.restauracao.bancosRemovidos.sort(), ['User_ana.db', 'User_bia.db', 'User_cid.db']);

    // aparelho igual ao de antes
    assert.deepEqual(s.device.files, { 'Param.db': 'p0' });
    assert.deepEqual(s.device.local, { tema: 'escuro' });
    assert.equal(JSON.stringify(s.device.native), JSON.stringify({ inicial: { a: 1 } }), 'objeto do vm: compara por JSON');
    assert.ok(!fs.existsSync(path.join(s.config.stateDir, 'snapshots', `teste-${run.id}`)), 'snapshot temporário apagado');
    assert.ok(!fs.existsSync(path.join(s.config.stateDir, 'test-runs', `${run.id}.storage.json`)), 'storage salvo apagado');

    // logs e requisições de uma etapa
    const step = await s.api.testStatus({ case: 'Bia', step: '1' });
    assert.equal(step.etapa, 'Login');
    assert.deepEqual(step.logs.map((l) => l.msg), ['login de bia', 'senha recusada']);
    assert.equal(step.requisicoes.length, 1);
    assert.match(testStep(step), /#\d+ POST 405 .*\/api\/login/);
    assert.match(testsStatus(run), /2\. Bia — FALHA[\s\S]*Login\s+falha[\s\S]*Erro: Senha inválida/);
    await assert.rejects(s.api.testStatus({ case: 'Zé', step: '1' }), /Caso "Zé" não existe/);

    // relatório em horário local, sem credenciais
    const report = fs.readFileSync(path.join(s.root, run.relatorio), 'utf8');
    assert.match(JSON.parse(report).inicio, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d$/);
    for (const text of [report, fs.readFileSync(path.join(s.config.stateDir, 'test-history.log'), 'utf8'), s.lines.join('\n')]) {
      assert.equal(text.includes(SECRET), false);
    }
    assert.ok(!fs.existsSync(path.join(s.config.stateDir, 'eval-history.log')), 'nada passa pelo eval');
    // rodada anterior (fora da memória): lida do relatório
    const old = s.server.tests.readReport(run.id);
    assert.equal(old.doRelatorio, true);
    assert.match(testsStatus(old), /2\. Bia — FALHA/);
    assert.equal(old.casos[1].testes[0].etapas[0].erro, 'Senha inválida');

    // rodada encerrada com id: vem do relatório, que guarda os logs de cada etapa
    const fin = await s.api.testStatus({ id: run.id });
    assert.equal(fin.doRelatorio, true);
    assert.deepEqual(fin.casos[1].testes[0].etapas[0].logs.map((l) => l.msg), ['login de bia', 'senha recusada']);
    assert.equal(fin.casos[1].testes[0].etapas[0].requisicoes.length, 1);
    const liveUrl = `http://127.0.0.1:${s.server.port}/__devbridge/api/tests/live`;
    const live = await (await fetch(liveUrl, { headers: { 'X-Devbridge': '1' } })).json();
    assert.equal(live.rodada.id, run.id);
    assert.ok(live.rodada.fim);
    const t0 = Date.now();
    const waited = await (await fetch(`${liveUrl}?after=${live.rev - 1}`, { headers: { 'X-Devbridge': '1' } })).json();
    assert.ok(Date.now() - t0 < 1000, 'after antigo responde na hora');
    assert.equal(waited.rev, live.rev);

    // histórico: a etapa sai do relatório mesmo sem a rodada na memória do servidor
    s.server.tests.current = null;
    s.server.tests.frozen.clear();
    const fromReport = await s.api.testStatus({ id: run.id, case: '2', step: '1' });
    assert.deepEqual(fromReport.logs.map((l) => l.msg), ['login de bia', 'senha recusada']);
    assert.match(fromReport.logs[0].ts, /^\d{4}-.*[+-]\d\d:\d\d$/, 'horário local no relatório');
    assert.equal(fromReport.requisicoes.length, 1);
    assert.match(testStep(fromReport), /#\d+ POST 405 .*\/api\/login/);
    assert.deepEqual((await s.api.testStatus({ id: run.id, case: 'Ana', step: 'depois' })).logs, []);
    assert.match(testsStatus(await s.api.testStatus({ id: run.id })), new RegExp(`tests_status com id ${run.id}, case e step`));
    const runs = await s.api.testRuns();
    assert.deepEqual(runs.testes, ['fluxo']);
    assert.equal(runs.rodadas.length, 1);
    const h = runs.rodadas[0];
    assert.equal(h.id, run.id);
    assert.equal(h.arquivo, `.devbridge/test-runs/${run.id}-fluxo.json`);
    assert.deepEqual(h.casos.map((c) => c.situacao), ['ok', 'falha', 'falha']);
    assert.deepEqual([h.falhas.requisicoes, h.falhas.respostas, h.restaurado], [1, 1, true]);
    assert.ok(h.falhas.logs >= 1);
    assert.match(testRuns(runs), /fluxo\s+FALHA\s+1\/3 ok/);
    assert.equal((await s.api.testRuns({ test: 'outro' })).rodadas.length, 0);
    assert.match(testsList(await s.api.tests()), new RegExp(`Últimas rodadas[\\s\\S]*${run.id}`));
    // relatório antigo, sem logs por etapa
    const file = path.join(s.root, run.relatorio);
    const legacy = JSON.parse(fs.readFileSync(file, 'utf8'));
    delete legacy.casos[1].testes[0].etapas[0].logs;
    fs.writeFileSync(file, JSON.stringify(legacy));
    assert.match((await s.api.testStatus({ id: run.id, case: '2', step: '1' })).aviso, /não guardou os logs/);
    // relatório ilegível entra no histórico sem derrubar a lista
    fs.writeFileSync(path.join(s.config.stateDir, 'test-runs', '2099-01-01T00-00-00-quebrado.json'), '{');
    assert.equal((await s.api.testRuns()).rodadas[0].situacao, 'ilegível');

    // tela de testes
    const page = await fetch(`http://127.0.0.1:${s.server.port}/__devbridge/tests`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<title>Testes · Devbridge<\/title>/);
  } finally {
    await teardown(s);
  }
});

test('cancelamento: caso atual para, seguintes pulados, aparelho restaurado', async () => {
  const s = await setup([
    { nome: 'Preso', usuario: 'ana', senha: 'certa', esperarParaSempre: true },
    { nome: 'Depois', usuario: 'bia', senha: 'certa' },
  ]);
  // Etapa "Esperar" com 10 s de espera: tempo limite maior para o cancelamento chegar antes.
  fs.writeFileSync(path.join(s.root, '.devbridge/tests/fluxo.test.js'), FLUXO.replace("tempoLimiteMs: 200", 'tempoLimiteMs: 20000'));
  try {
    await s.api.testRun({ test: 'fluxo' });
    await until(async () => {
      const r = await s.api.testStatus();
      return r.casos[0].etapaAtual === 3;
    }, 5000);
    const c = await s.api.testCancel();
    assert.equal(c.cancelando, true);
    const run = await s.api.testStatus({ waitMs: 10000 });
    assert.equal(run.situacao, 'cancelada');
    assert.deepEqual(run.casos[0].testes[0].etapas.map((e) => e.situacao), ['ok', 'ok', 'cancelada']);
    assert.equal(run.casos[1].situacao, 'pulado');
    assert.equal(run.restauracao.ok, true, JSON.stringify(run.restauracao));
    assert.deepEqual(s.device.files, { 'Param.db': 'p0' });
    assert.deepEqual(s.device.local, { tema: 'escuro' });
    await assert.rejects(s.api.testCancel(), /Nenhuma rodada em andamento/);
  } finally {
    await teardown(s);
  }
});

test('sem arquivo de casos roda um caso vazio; erros de nome e de caso', async () => {
  const s = await setup(null);
  try {
    const list = await s.api.tests();
    assert.deepEqual(list.testes[0].casos, ['padrão']);
    await assert.rejects(s.api.testRun({ test: 'nao-existe' }), /não existe em \.devbridge\/tests\/\. Disponíveis: fluxo/);
    await assert.rejects(s.api.testRun({ test: '../fora' }), /Nome de teste inválido/);
    await assert.rejects(s.api.testRun({ test: 'fluxo', cases: ['X'] }), /Caso\(s\) inexistente\(s\): X/);
    fs.writeFileSync(path.join(s.root, '.devbridge/tests/quebrado.test.js'), '(function () { /* não registra */ })();');
    const again = await s.api.tests();
    assert.match(again.testes.find((t) => t.id === 'quebrado').erro, /não chamou __devbridgeRunner\.registrar/);
  } finally {
    await teardown(s);
  }
});

test('app que recarrega no meio do caso vira erro do caso, e o aparelho é restaurado', async () => {
  const s = await setup([{ nome: 'Ana', usuario: 'ana', senha: 'certa', esperarParaSempre: true }]);
  fs.writeFileSync(path.join(s.root, '.devbridge/tests/fluxo.test.js'), FLUXO.replace("tempoLimiteMs: 200", 'tempoLimiteMs: 20000'));
  try {
    await s.api.testRun({ test: 'fluxo' });
    await until(async () => (await s.api.testStatus()).casos[0].etapaAtual === 3, 5000);
    // reload do app: client novo, sem o estado do teste
    s.device.app.close();
    s.device.app = null;
    s.device.app = runClient(`http://127.0.0.1:${s.server.port}`, { local: s.device.local, globals: { NativeStorage: fakeNativeStorage(s.device.native), criarBanco() {} } });
    s.device.app.fireDeviceReady();
    const run = await s.api.testStatus({ waitMs: 10000 });
    assert.equal(run.casos[0].situacao, 'erro');
    assert.match(run.casos[0].erro, /recarregou durante o caso/);
    assert.equal(run.casos[0].testes[0].etapas[2].situacao, 'falha');
    assert.equal(run.restauracao.ok, true, JSON.stringify(run.restauracao));
    assert.deepEqual(s.device.files, { 'Param.db': 'p0' });
  } finally {
    await teardown(s);
  }
});

test('MCP por stdio: tests_list, tests_run, tests_status (tabela e etapa) e tests_cancel', async () => {
  const s = await setup([{ nome: 'Bia', usuario: 'bia', senha: SECRET }]);
  const cfgFile = path.join(s.root, 'devbridge.config.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(cfgFile, 'utf8')), port: s.server.port }));
  const child = spawn(process.execPath, [path.join(__dirname, '../bin/devbridge.js'), 'mcp'], { cwd: s.root, stdio: ['pipe', 'pipe', 'inherit'] });
  const replies = new Map();
  readline.createInterface({ input: child.stdout }).on('line', (l) => {
    const msg = JSON.parse(l);
    replies.set(msg.id, msg);
  });
  let id = 0;
  const call = async (name, args = {}) => {
    const my = ++id;
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: my, method: 'tools/call', params: { name, arguments: args } }) + '\n');
    const r = await until(() => replies.get(my), 20000);
    return r.result;
  };
  try {
    const list = await call('tests_list');
    assert.match(list.content[0].text, /^fluxo — login e sincronização de mentira\n {2}etapas: 1\. Login \(3 s\) · 2\. Sincronizar \(3 s\) · 3\. Esperar \(200 ms\)/);
    const run = await call('tests_run', { test: 'fluxo' });
    assert.match(run.content[0].text, /^Rodada \S+ iniciada \(1 caso\(s\)\)/);
    const done = await call('tests_status', { waitMs: 15000 });
    assert.match(done.content[0].text, /1\. Bia — FALHA/);
    assert.match(done.content[0].text, /requisição com falha: #\d+ POST 405 \S+\/api\/login \[etapa 1\]/);
    assert.match(done.content[0].text, /resposta com erro: .*login recusado pelo servidor/);
    assert.match(done.content[0].text, /Aparelho restaurado/);
    const step = await call('tests_status', { case: '1', step: '1' });
    assert.match(step.content[0].text, /^Caso 1 \(Bia\) · etapa 1 \(Login\): falha/);
    assert.match(step.content[0].text, /ERROR senha recusada/);
    assert.equal(done.content[0].text.includes(SECRET) || step.content[0].text.includes(SECRET), false);
    const cancel = await call('tests_cancel');
    assert.equal(cancel.isError, true);
  } finally {
    child.kill();
    await teardown(s);
  }
});

// Segundo teste, encadeado depois do fluxo: começa logado e usa o código comum.
const CHECKOUT = `(function () {
  var comum = __devbridgeRunner.comum;
  __devbridgeRunner.registrar({
    nome: 'checkout',
    descricao: 'pedido com o usuário já logado',
    requer: ['fluxo'],
    etapas: [
      { nome: 'Carrinho', tempoLimiteMs: 2000, executar: function (ctx) {
        if (!ctx.dados.antes) throw new Error('sem os dados do teste anterior');
        console.log('checkout de ' + localStorage.getItem('sessao'));
        ctx.publico.pedido = comum.pedido(ctx.publico.usuario);
        return 'sessão ' + localStorage.getItem('sessao');
      } },
      { nome: 'Fechar', tempoLimiteMs: 2000, executar: function (ctx) { return ctx.comum.pedido('fim'); } },
    ],
  });
})();`;
const COMUM = `__devbridgeRunner.compartilhar({ pedido: function (u) { return 'pedido-' + u; } });`;

test('testes encadeados: cada caso roda fluxo e checkout sem restaurar no meio; falha pula o seguinte', async () => {
  const s = await setup([
    { nome: 'Ana', usuario: 'ana', senha: 'certa' },
    { nome: 'Bia', usuario: 'bia', senha: SECRET },
    { nome: 'Cida', usuario: 'cida', senha: 'certa' },
  ]);
  const dir = path.join(s.root, '.devbridge/tests');
  fs.writeFileSync(path.join(dir, 'checkout.test.js'), CHECKOUT);
  fs.writeFileSync(path.join(dir, 'pedido.comum.js'), COMUM);
  try {
    const list = await s.api.tests();
    assert.deepEqual(list.comum, ['.devbridge/tests/pedido.comum.js']);
    assert.deepEqual(list.testes.map((t) => [t.id, t.requer]), [['checkout', ['fluxo']], ['fluxo', []]]);
    assert.match(testsList(list), /checkout — pedido com o usuário já logado[\s\S]*requer antes, na mesma rodada: fluxo/);
    assert.match(testsList(list), /Código comum \(carregado antes dos testes\): \.devbridge\/tests\/pedido\.comum\.js/);
    await assert.rejects(s.api.testRun({ tests: ['fluxo', 'fluxo'] }), /Teste repetido/);

    const boots = s.device.boots;
    const started = await s.api.testRun({ tests: ['fluxo', 'checkout'] });
    assert.deepEqual(started.testes, ['fluxo', 'checkout']);
    const run = await s.api.testStatus({ waitMs: 20000 });
    assert.ok(run.fim);
    assert.equal(s.device.boots - boots, 2, 'só o snapshot e o restore do fim reabrem o app');
    const [ana, bia, cida] = run.casos;
    assert.deepEqual(ana.testes.map((t) => [t.teste, t.situacao]), [['fluxo', 'ok'], ['checkout', 'ok']]);
    assert.equal(ana.situacao, 'ok');
    assert.equal(ana.testes[1].etapas[0].detalhe, 'sessão ana', 'o checkout vê o login do fluxo');
    assert.equal(ana.testes[1].etapas[1].detalhe, 'pedido-fim', 'ctx.comum');
    assert.deepEqual(ana.dados, { usuario: 'ana', depois: true, pedido: 'pedido-ana' }, 'ctx.publico do caso inteiro');
    assert.deepEqual(bia.testes.map((t) => t.situacao), ['falha', 'pulado']);
    assert.deepEqual(bia.testes[1].etapas.map((e) => e.situacao), ['pulada', 'pulada']);
    assert.equal(bia.situacao, 'falha');
    assert.equal(bia.erro, null, 'erro de etapa fica na etapa');
    assert.deepEqual(bia.requisicoesComFalha.map((q) => [q.teste, q.etapa]), [['fluxo', 1]]);
    assert.deepEqual(bia.respostasComErro.map((q) => [q.teste, q.etapa]), [['fluxo', 1]]);
    assert.deepEqual(cida.testes.map((t) => t.situacao), ['ok', 'ok'], 'o caso seguinte roda a cadeia toda');
    assert.equal(run.situacao, 'falha');
    assert.equal(run.restauracao.ok, true);
    assert.deepEqual(s.device.files, { 'Param.db': 'p0' });
    assert.deepEqual(s.device.local, { tema: 'escuro' });

    // etapa de um teste da cadeia
    await assert.rejects(s.api.testStatus({ case: 'Ana', step: '1' }), /Informe o teste.*1\. fluxo, 2\. checkout/);
    const step = await s.api.testStatus({ case: 'Ana', test: 'checkout', step: '1' });
    assert.deepEqual(step.logs.map((l) => l.msg), ['checkout de ana']);
    assert.match(testStep(step), /^Caso 1 \(Ana\) · teste 2 \(checkout\) · etapa 1 \(Carrinho\): ok/);
    assert.deepEqual((await s.api.testStatus({ case: 'Ana', test: '1', step: '1' })).logs.map((l) => l.msg), ['login de ana']);
    const text = testsStatus(run);
    assert.match(text, /Rodada \S+ · fluxo → checkout · FALHA/);
    assert.match(text, /2\. Bia — FALHA[\s\S]*1\) fluxo — falha[\s\S]*2\) checkout — pulado/);
    assert.match(text, /requisição com falha: .* \[fluxo, etapa 1\]/);

    // relatório e histórico
    assert.match(run.relatorio, /-fluxo\+checkout\.json$/);
    const report = JSON.parse(fs.readFileSync(path.join(s.root, run.relatorio), 'utf8'));
    assert.deepEqual(report.testes, ['fluxo', 'checkout']);
    assert.deepEqual(report.casos[0].testes[1].etapas[0].logs.map((l) => l.msg), ['checkout de ana']);
    assert.equal(fs.readFileSync(path.join(s.root, run.relatorio), 'utf8').includes(SECRET), false);
    s.server.tests.current = null;
    s.server.tests.frozen.clear();
    const fromReport = await s.api.testStatus({ id: run.id, case: '1', test: 'checkout', step: '2' });
    assert.equal(fromReport.detalhe, 'pedido-fim');
    assert.deepEqual((await s.api.testRuns({ test: 'checkout' })).rodadas.map((r) => r.testes), [['fluxo', 'checkout']]);
  } finally {
    await teardown(s);
  }
});

test('requer fora de ordem é recusado antes de mexer no aparelho; relatório antigo vira o formato novo', async () => {
  const s = await setup([{ nome: 'Ana', usuario: 'ana', senha: 'certa' }]);
  const dir = path.join(s.root, '.devbridge/tests');
  fs.writeFileSync(path.join(dir, 'checkout.test.js'), CHECKOUT);
  fs.writeFileSync(path.join(dir, 'pedido.comum.js'), COMUM);
  try {
    const boots = s.device.boots;
    await s.api.testRun({ test: 'checkout' });
    const run = await s.api.testStatus({ waitMs: 5000 });
    assert.equal(run.situacao, 'erro');
    assert.match(run.erro, /checkout requer fluxo antes dele\. Rode tests_run com tests \["fluxo","checkout"\] \(CLI: devbridge test run fluxo checkout\)/);
    assert.equal(s.device.boots, boots, 'sem snapshot nem restore');
    assert.ok(!fs.existsSync(path.join(s.config.stateDir, 'snapshots')));

    // relatório da #28: etapas direto no caso
    const legacy = {
      id: '2026-11-01T10-00-00', teste: 'fluxo', nome: 'fluxo', situacao: 'falha', inicio: '2026-11-01T10:00:00-03:00',
      casos: [{
        nome: 'Ana', situacao: 'falha', erro: 'x', duracaoMs: 5,
        etapas: [{ nome: 'Login', situacao: 'falha', erro: 'x', logs: [{ seq: 1, nivel: 'log', msg: 'antigo', ts: '2026-11-01T10:00:00-03:00' }], requisicoes: [] }],
        antes: { logs: [], requisicoes: [] }, depois: { logs: [], requisicoes: [] },
        errosNoLog: [{ msg: 'e', etapa: 1 }], requisicoesComFalha: [], respostasComErro: [],
      }],
    };
    fs.writeFileSync(path.join(s.config.stateDir, 'test-runs', `${legacy.id}-fluxo.json`), JSON.stringify(legacy));
    const old = await s.api.testStatus({ id: legacy.id });
    assert.deepEqual(old.testes, ['fluxo']);
    assert.equal(old.casos[0].testes[0].etapas[0].nome, 'Login');
    assert.equal(old.casos[0].etapas, undefined);
    assert.equal(old.casos[0].errosNoLog[0].teste, 'fluxo');
    assert.deepEqual((await s.api.testStatus({ id: legacy.id, case: '1', step: '1' })).logs.map((l) => l.msg), ['antigo']);
    assert.match(testsStatus(old), /1\. Ana — FALHA \(5 ms\)\n\s+1\. Login\s+falha/);
  } finally {
    await teardown(s);
  }
});

test('cancelamento no meio da cadeia: o resto do caso e os casos seguintes ficam pulados', async () => {
  const s = await setup([
    { nome: 'Preso', usuario: 'ana', senha: 'certa', esperarParaSempre: true },
    { nome: 'Depois', usuario: 'bia', senha: 'certa' },
  ]);
  const dir = path.join(s.root, '.devbridge/tests');
  fs.writeFileSync(path.join(dir, 'fluxo.test.js'), FLUXO.replace('tempoLimiteMs: 200', 'tempoLimiteMs: 20000'));
  fs.writeFileSync(path.join(dir, 'checkout.test.js'), CHECKOUT);
  fs.writeFileSync(path.join(dir, 'pedido.comum.js'), COMUM);
  try {
    await s.api.testRun({ tests: ['fluxo', 'checkout'] });
    await until(async () => {
      const c = (await s.api.testStatus()).casos[0];
      return c.testeAtual === 1 && c.etapaAtual === 3;
    }, 5000);
    await s.api.testCancel();
    const run = await s.api.testStatus({ waitMs: 10000 });
    assert.equal(run.situacao, 'cancelada');
    const [preso, depois] = run.casos;
    assert.deepEqual(preso.testes.map((t) => t.situacao), ['cancelada', 'pulado']);
    assert.equal(preso.situacao, 'cancelada');
    assert.deepEqual(depois.testes.map((t) => t.situacao), ['pulado', 'pulado']);
    assert.equal(depois.situacao, 'pulado');
    assert.equal(run.restauracao.ok, true);
    assert.deepEqual(s.device.files, { 'Param.db': 'p0' });
  } finally {
    await teardown(s);
  }
});
